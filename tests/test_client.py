import io
import json
import unittest
import urllib.error
from unittest import mock

from jev_kaikei import jev_client
from jev_kaikei.jev_client import JevClient, JevError, estimate_cost_usd, load_api_key


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ClientTests(unittest.TestCase):
    def test_request_shape_and_headers(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = dict(req.header_items())
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse(json.dumps({"model": "jev-1.13.0", "answers": {"q": {"type": "noul", "noul": 0.9}}, "usage": {"input_tokens": 10}}).encode())

        with mock.patch.object(jev_client.urllib.request, "urlopen", fake_urlopen):
            c = JevClient(api_key="jev_test", model="jev-latest")
            out = c.system_one({"payee": "x"}, {"q": {"type": "noul", "instructions": "..."}})

        self.assertEqual(captured["url"], "https://api.typesafe.ai/v1/systemone")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer jev_test")
        self.assertEqual(captured["body"]["model"], "jev-latest")
        self.assertEqual(captured["body"]["state"], {"payee": "x"})
        self.assertEqual(captured["body"]["questions"]["q"]["type"], "noul")
        self.assertEqual(out["answers"]["q"]["noul"], 0.9)

    def test_retries_on_429_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(req.full_url, 429, "Too Many", {"Retry-After": "0"}, io.BytesIO(b'{"error":"rate"}'))
            return FakeResponse(b'{"model":"jev-1.13.0","answers":{},"usage":{"input_tokens":1}}')

        with mock.patch.object(jev_client.urllib.request, "urlopen", fake_urlopen), mock.patch.object(jev_client.time, "sleep"):
            c = JevClient(api_key="k", max_retries=2)
            out = c.system_one("s", {})
        self.assertEqual(calls["n"], 2)
        self.assertEqual(out["model"], "jev-1.13.0")

    def test_401_raises_clear_error(self):
        def fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b'{"error":"bad key"}'))

        with mock.patch.object(jev_client.urllib.request, "urlopen", fake_urlopen):
            c = JevClient(api_key="k")
            with self.assertRaises(JevError) as cm:
                c.system_one("s", {})
        self.assertEqual(cm.exception.status, 401)
        self.assertIn("401", str(cm.exception))

    def test_load_api_key_from_env(self):
        with mock.patch.dict(jev_client.os.environ, {"TYPESAFE_API_KEY": " jev_abc "}):
            self.assertEqual(load_api_key(), "jev_abc")

    def test_cost(self):
        self.assertAlmostEqual(estimate_cost_usd(1_000_000), 0.042)


if __name__ == "__main__":
    unittest.main()
