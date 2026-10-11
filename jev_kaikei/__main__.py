"""python -m jev_kaikei [--port 8765] [--mock] [--model jev-latest] [--no-browser] [--check]"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .jev_client import DEFAULT_MODEL, JevClient, JevError, load_api_key
from .server import serve


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="jev-kaikei", description="Jev会計: Jev でレシートを仕分けして仕訳を作る")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--mock", action="store_true", help="API キーがあってもモックで動かす")
    p.add_argument("--model", default=DEFAULT_MODEL, help="jev-latest / jev-1.13.0 / jev-preview")
    p.add_argument("--workers", type=int, default=8, help="Jev への同時リクエスト数")
    p.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    p.add_argument("--check", action="store_true", help="API キーと接続を確認して終了")
    p.add_argument("--version", action="version", version=f"jev-kaikei {__version__}")
    args = p.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # Windows のコンソールでも日本語を化けさせない
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    if args.check and args.mock:
        print("モックを指定しています。外部APIの接続確認は行いません。")
        return 0

    if args.check:
        key = load_api_key()
        if not key:
            print("TYPESAFE_API_KEY が見つかりません。https://console.typesafe.ai/keys で発行し、%USERPROFILE%\\.secrets\\jev-kaikei\\.env に置いてください。")
            return 1
        try:
            models = JevClient(api_key=key, model=args.model).list_models()
        except JevError as e:
            print(f"接続失敗: {e}")
            return 1
        print("接続 OK。利用できるモデル:")
        print(models)
        return 0

    serve(host=args.host, port=args.port, mock=args.mock, model=args.model,
          workers=args.workers, open_browser=not args.no_browser)
    return 0


if __name__ == "__main__":
    sys.exit(main())
