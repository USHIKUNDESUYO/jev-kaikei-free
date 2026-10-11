import contextlib
import io
import unittest
from unittest.mock import patch
from jev_kaikei import __main__ as cli

class MockCheckBoundary(unittest.TestCase):
    def test_mock_check_does_not_read_keys_or_construct_network_client(self):
        with patch.object(cli, "load_api_key", side_effect=AssertionError("credential access forbidden")), patch.object(cli, "JevClient", side_effect=AssertionError("network client forbidden")), patch.object(cli, "serve", side_effect=AssertionError("server start forbidden")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(["--mock", "--check"]), 0)
        self.assertIn("外部API", output.getvalue())

    def test_mock_server_flag_is_still_forwarded(self):
        with patch.object(cli, "serve") as serve:
            self.assertEqual(cli.main(["--mock", "--no-browser"]), 0)
        self.assertTrue(serve.call_args.kwargs["mock"])
        self.assertFalse(serve.call_args.kwargs["open_browser"])

    def test_live_check_still_lists_models_via_stub(self):
        with patch.object(cli, "load_api_key", return_value="synthetic-test-key"), patch.object(cli, "JevClient") as client, contextlib.redirect_stdout(io.StringIO()):
            client.return_value.list_models.return_value = {"models": []}
            self.assertEqual(cli.main(["--check"]), 0)
        client.return_value.list_models.assert_called_once_with()

if __name__ == "__main__":
    unittest.main()
