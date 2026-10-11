"""TypeSafe AI "Jev" (System One モデル) を呼ぶ最小クライアント。

依存ライブラリなし（urllib のみ）。公式仕様:
  POST https://api.typesafe.ai/v1/systemone
  Authorization: Bearer <TYPESAFE_API_KEY>
  body: {"model": "jev-latest", "state": <str|obj|list>, "questions": {id: {type, instructions, criteria}}}
  resp: {"model": "...", "answers": {id: {type, choice|score|noul, probabilities, confidence}}, "usage": {...}}
429 / 529 / 5xx は指数バックオフで再試行する。
"""

from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "https://api.typesafe.ai"
DEFAULT_MODEL = "jev-latest"
ENV_KEY = "TYPESAFE_API_KEY"
PRICE_USD_PER_MTOK = 0.042  # 入力トークン単価（出力は無料）。2026-09 時点。


class JevError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


def load_api_key(project_name: str = "jev-kaikei") -> str | None:
    """環境変数 → %USERPROFILE%\\.secrets\\<project>\\.env → カレントの .env の順に探す。"""
    key = os.environ.get(ENV_KEY)
    if key:
        return key.strip()
    candidates = [
        Path.home() / ".secrets" / project_name / ".env",
        Path.cwd() / ".env",
    ]
    for path in candidates:
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == ENV_KEY:
                    v = v.strip().strip('"').strip("'")
                    if v:
                        return v
    return None


class JevClient:
    """同期クライアント。1 リクエスト = 1 state + 複数 questions。"""

    is_mock = False

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 6,  # 529 (混雑) が数十秒続くことがある。1,2,4,8,10,10 秒で待つ
    ):
        if not api_key:
            raise JevError("API キーがありません")
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries

    # ---- public -----------------------------------------------------
    def system_one(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        payload = {"model": self.model, "state": state, "questions": questions}
        return self._post("/v1/systemone", payload)

    def list_models(self) -> Any:
        return self._request("GET", "/v1/models", None)

    # ---- internals --------------------------------------------------
    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", path, payload)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        url = self.base_url + path
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "jev-kaikei/0.1 (python-urllib)",
        }
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
                retryable = e.code in (429, 500, 502, 503, 504, 529)
                if retryable and attempt < self.max_retries:
                    self._sleep(attempt, e.headers.get("Retry-After") if e.headers else None)
                    attempt += 1
                    continue
                raise JevError(self._explain(e.code, body), status=e.code, body=body) from None
            except urllib.error.URLError as e:
                if attempt < self.max_retries:
                    self._sleep(attempt, None)
                    attempt += 1
                    continue
                raise JevError(f"接続できません: {e.reason}") from None

    @staticmethod
    def _explain(status: int, body: str) -> str:
        hints = {
            401: "API キーが無効か未設定です (401)",
            403: "このキーでは許可されていません (403)",
            422: "リクエストの形式が不正です (422)",
            429: "レート制限にかかりました (429)",
            529: "Jev 側が混雑しています (529)",
        }
        msg = hints.get(status, f"Jev API エラー (HTTP {status})")
        snippet = body.strip()[:300]
        return f"{msg}: {snippet}" if snippet else msg

    @staticmethod
    def _sleep(attempt: int, retry_after: str | None) -> None:
        delay = 0.0
        if retry_after:
            try:
                delay = float(retry_after)
            except ValueError:
                delay = 0.0
        if delay <= 0:
            delay = min(10.0, 1.0 * (2**attempt)) + random.uniform(0, 0.5)
        time.sleep(delay)


def estimate_cost_usd(input_tokens: int) -> float:
    return input_tokens / 1_000_000 * PRICE_USD_PER_MTOK
