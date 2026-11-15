"""Tests for the verify service's shared-token check. No Ollama or CAD kernel needed. Run from
the repo root:

    python -m unittest discover -s verify/service/tests -v
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

VERIFY_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(VERIFY_DIR))
sys.path.insert(0, str(VERIFY_DIR / "service"))

import main  # noqa: E402  verify/service/main.py

EXTRACT_BODY = {"prompt": "Model a plate 60 mm wide.", "spec": None}


class ServiceToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), main.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def call(self, method, path, body=None, auth=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if auth is not None:
            headers["Authorization"] = auth
        request = urllib.request.Request(self.base + path, data=data, headers=headers,
                                         method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def with_token(self, value):
        return mock.patch.dict(os.environ, {main.TOKEN_ENV: value})

    def test_no_token_configured_means_no_check(self):
        for value in ("", "   "):
            with self.with_token(value):
                status, body = self.call("POST", "/extract", EXTRACT_BODY)
            self.assertEqual(status, 200, value)
            self.assertIn("requirements", body)

    def test_post_without_or_with_wrong_token_is_401(self):
        with self.with_token("s3cret"):
            for auth in (None, "", "Bearer", "Bearer wrong", "Basic s3cret", "s3cret",
                         "Bearer s3cret-and-more"):
                for path in ("/extract", "/lint", "/verify", "/probe", "/nope"):
                    status, body = self.call("POST", path, EXTRACT_BODY, auth=auth)
                    self.assertEqual(status, 401, (auth, path))
                    self.assertIn("token", body["error"])

    def test_post_with_the_token_is_handled(self):
        with self.with_token(" s3cret "):  # surrounding whitespace in the env is ignored
            for auth in ("Bearer s3cret", "bearer s3cret"):
                status, body = self.call("POST", "/extract", EXTRACT_BODY, auth=auth)
                self.assertEqual(status, 200, auth)
                self.assertIn("requirements", body)
            # Past the check, the endpoint's own validation still answers.
            status, _ = self.call("POST", "/extract", {"prompt": 7}, auth="Bearer s3cret")
            self.assertEqual(status, 400)

    def test_health_stays_open_for_platform_checks(self):
        with self.with_token("s3cret"):
            status, body = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")


if __name__ == "__main__":
    unittest.main()
