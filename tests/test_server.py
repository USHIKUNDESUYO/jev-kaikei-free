import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from jev_kaikei.engine import load_master
from jev_kaikei.mock import MockJevClient
from jev_kaikei.server import AppState, make_handler


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app = AppState(client=MockJevClient(), master=load_master(), workers=2)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path):
        with urllib.request.urlopen(self.url(path), timeout=5) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()

    def post(self, path, payload):
        """classify は NDJSON を返すので、行ごとに読んで {results, errors, usage} に組み立てる。"""
        req = urllib.request.Request(self.url(path), data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                ctype = r.headers.get("Content-Type", "")
                body = r.read().decode("utf-8")
                if "ndjson" not in ctype:
                    return r.status, json.loads(body)
                out = {"results": [], "errors": [], "usage": {}}
                for line in body.splitlines():
                    if not line.strip():
                        continue
                    ev = json.loads(line)
                    if ev["type"] == "result":
                        out["results"].append(ev)
                    elif ev["type"] == "error":
                        out["errors"].append(ev)
                    else:
                        out["usage"] = ev["usage"]
                        out["done"] = ev
                return r.status, out
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_index_and_static(self):
        status, ctype, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn("Jev", body.decode("utf-8"))
        status, ctype, _ = self.get("/app.js")
        self.assertEqual(status, 200)
        self.assertIn("charset=utf-8", ctype)

    def test_config(self):
        status, _, body = self.get("/api/config?entity=hojin&mode=cash")
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertTrue(d["mock"])
        codes = {a["code"] for a in d["master"]["accounts"]["out"]}
        self.assertIn("private_out_hojin", codes)
        self.assertNotIn("private_out_kojin", codes)

    def test_sample(self):
        status, _, body = self.get("/api/sample")
        self.assertEqual(status, 200)
        self.assertGreater(len(json.loads(body)["items"]), 10)

    def test_classify(self):
        items = [
            {"id": "a", "date": "2026-08-10", "payee": "スターバックス 渋谷店", "amount": 1320, "memo": "打合せ", "method": "card", "direction": "out"},
            {"id": "b", "date": "2026-08-31", "payee": "株式会社ノート出版", "amount": 66000, "memo": "原稿料", "method": "bank", "direction": "in"},
        ]
        status, d = self.post("/api/classify", {"items": items, "entity": "kojin", "mode": "cash", "business": "ライター"})
        self.assertEqual(status, 200)
        self.assertEqual(len(d["results"]), 2)
        by_id = {r["id"]: r for r in d["results"]}
        self.assertEqual(by_id["a"]["account"], "会議費")
        self.assertEqual(by_id["a"]["counter_account"], "未払金")
        self.assertEqual(by_id["b"]["account"], "売上高")
        self.assertIn("estimated_cost_usd", d["usage"])
        self.assertEqual(d["done"]["ok"], 2)
        self.assertEqual(d["done"]["failed"], 0)

    def test_classify_rejects_empty(self):
        status, d = self.post("/api/classify", {"items": []})
        self.assertEqual(status, 400)
        self.assertIn("error", d)

    def test_path_traversal_blocked(self):
        req = urllib.request.Request(self.url("/../pyproject.toml"))
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertNotEqual(r.status, 200)
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)


if __name__ == "__main__":
    unittest.main()
