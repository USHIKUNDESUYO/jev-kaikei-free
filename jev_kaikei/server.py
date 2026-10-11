"""ローカル Web サーバー。静的ファイル配信 + Jev への橋渡し。

API キーはサーバー側だけが持ち、ブラウザには渡さない。
  GET  /                 … アプリ
  GET  /api/config       … 動作モード・科目マスタ
  GET  /api/sample       … デモ用レシート
  POST /api/classify     … {items, entity, mode, business} → Jev の判定
"""

from __future__ import annotations

import json
import mimetypes
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import __version__
from .engine import judge_stream, load_master, ui_master
from .jev_client import DEFAULT_MODEL, JevClient, load_api_key
from .mock import MockJevClient

MAX_ITEMS_PER_REQUEST = 200


class AppState:
    def __init__(self, client, master: dict[str, Any], workers: int):
        self.client = client
        self.master = master
        self.workers = workers


def make_client(force_mock: bool, model: str) -> tuple[Any, str | None]:
    """(client, 警告メッセージ) を返す。"""
    if force_mock:
        return MockJevClient(), None
    key = load_api_key()
    if not key:
        return MockJevClient(), (
            "TYPESAFE_API_KEY が見つからないためモックで動きます。"
            "本物の Jev を使うには https://console.typesafe.ai/keys でキーを発行し、"
            "%USERPROFILE%\\.secrets\\jev-kaikei\\.env に TYPESAFE_API_KEY=... を置いてください。"
        )
    return JevClient(api_key=key, model=model), None


def make_handler(app: AppState):
    static_root = resources.files(__package__).joinpath("static")
    samples_path = Path(__file__).resolve().parent.parent / "samples" / "receipts_sample.json"

    class Handler(BaseHTTPRequestHandler):
        server_version = f"jev-kaikei/{__version__}"

        # ---- helpers ------------------------------------------------
        def _json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _file(self, rel: str) -> None:
            rel = rel.lstrip("/") or "index.html"
            if ".." in rel:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            target = static_root.joinpath(rel)
            if not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = target.read_bytes()
            ctype, _ = mimetypes.guess_type(rel)
            if ctype and ctype.startswith("text/") or rel.endswith((".js", ".json")):
                ctype = f"{ctype or 'text/plain'}; charset=utf-8"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _read_json(self) -> Any:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))

        def log_message(self, fmt, *args):  # noqa: D401 - 静的ファイルのログは出さない
            try:
                msg = fmt % args
            except Exception:  # noqa: BLE001
                msg = str(fmt)
            if "/api/" in msg or "code" in msg:
                sys.stderr.write("  " + msg + "\n")

        # ---- routes -------------------------------------------------
        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            if path == "/api/config":
                q = dict(p.split("=", 1) for p in urlparse(self.path).query.split("&") if "=" in p)
                entity = q.get("entity", "kojin")
                mode = q.get("mode", "cash")
                self._json(200, {
                    "version": __version__,
                    "mock": bool(getattr(app.client, "is_mock", False)),
                    "model": getattr(app.client, "model", None),
                    "master": ui_master(app.master, entity, mode),
                })
                return
            if path == "/api/sample":
                if samples_path.is_file():
                    self._json(200, json.loads(samples_path.read_text(encoding="utf-8")))
                else:
                    self._json(404, {"error": "sample not found"})
                return
            if path.startswith("/api/"):
                self._json(404, {"error": "not found"})
                return
            self._file(path)

        def do_POST(self):  # noqa: N802
            path = urlparse(self.path).path
            if path != "/api/classify":
                self._json(404, {"error": "not found"})
                return
            try:
                body = self._read_json()
            except Exception as e:  # noqa: BLE001
                self._json(400, {"error": f"JSON が読めません: {e}"})
                return
            items = body.get("items") or []
            if not isinstance(items, list) or not items:
                self._json(400, {"error": "items が空です"})
                return
            if len(items) > MAX_ITEMS_PER_REQUEST:
                self._json(400, {"error": f"1 回の送信は {MAX_ITEMS_PER_REQUEST} 件までです"})
                return
            entity = body.get("entity") or "kojin"
            mode = body.get("mode") or "cash"
            business = (body.get("business") or "").strip()
            # 判定できたものから 1 行ずつ返す（NDJSON）。HTTP/1.0 なので接続を閉じれば終わり
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                for ev in judge_stream(app.client, items, app.master, entity, mode, business, workers=app.workers):
                    self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return  # ブラウザ側が閉じた

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8765, mock: bool = False, model: str = DEFAULT_MODEL,
          workers: int = 8, open_browser: bool = True) -> None:
    client, warning = make_client(mock, model)
    app = AppState(client=client, master=load_master(), workers=workers)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    url = f"http://{host}:{port}/"
    mode_text = "モック（API キーなし）" if getattr(client, "is_mock", False) else f"Jev 本番 ({model})"
    print(f"Jev会計 v{__version__}  {url}  [{mode_text}]")
    if warning:
        print("  ! " + warning)
    print("  Ctrl+C で停止")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました")
    finally:
        httpd.server_close()
