"""Behavioral checks for discovery, imports and the local-only HTTP boundary."""

import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest


spec = importlib.util.spec_from_file_location("tmua_server", Path(__file__).resolve().parents[1] / "server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def paper_html(identifier="practice-one", category=1, **changes):
    metadata = {
        "format": "tmua-paper-v1", "id": identifier, "title": "Practice paper",
        "paper": category, "source": "Test collection", "description": "A short practice set.",
        "questionCount": 2, "version": 1,
    }
    metadata.update(changes)
    return '<!doctype html><title>Practice</title><script id="tmua-paper-meta" type="application/json">%s</script><h1>Practice</h1>' % json.dumps(metadata)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tmua website ")
        self.root = Path(self.temporary.name)
        (self.root / "index.html").write_text("<h1>TMUA</h1>", encoding="utf-8")
        self.server = module.make_server(self.root, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def request(self, method, path, data=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        supplied = dict(headers or {})
        body = None if data is None else json.dumps(data)
        if data is not None:
            supplied.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=body, headers=supplied)
        response = connection.getresponse()
        content = response.read()
        try:
            result = json.loads(content)
        except (UnicodeError, ValueError):
            result = content.decode("utf-8")
        status = response.status
        connection.close()
        return status, result

    def test_discovers_both_categories_and_refreshes(self):
        for category in (1, 2):
            target = self.root / "papers" / ("paper-%s" % category) / "dropped.html"
            target.write_text(paper_html("practice-%s" % category, category), encoding="utf-8")
        status, result = self.request("GET", "/api/papers")
        self.assertEqual(status, 200)
        self.assertEqual([paper["paper"] for paper in result["papers"]], [1, 2])
        self.assertEqual(result["errors"], [])
        self.assertEqual(self.request("GET", "/" + result["papers"][1]["href"])[0], 200)
        self.assertEqual(self.request("GET", "/papers/catalog.json"), (200, result))

    def test_import_is_saved_and_duplicate_does_not_overwrite(self):
        payload = {"filename": "My paper.html", "html": paper_html()}
        status, result = self.request("POST", "/api/papers", payload)
        self.assertEqual(status, 201)
        self.assertEqual(result["paper"]["href"], "papers/paper-1/practice-one.html")
        saved = self.root / "papers/paper-1/practice-one.html"
        self.assertEqual(saved.read_text(), payload["html"])
        changed = {"filename": "changed.html", "html": paper_html(category=2)}
        self.assertEqual(self.request("POST", "/api/papers", changed)[0], 409)
        self.assertEqual(saved.read_text(), payload["html"])
        self.assertEqual(len(self.request("GET", "/api/papers")[1]["papers"]), 1)

    def test_invalid_metadata_and_wrong_folder_are_reported(self):
        invalid_html = paper_html(questionCount=True)
        status, result = self.request("POST", "/api/papers", {"filename": "invalid.html", "html": invalid_html})
        self.assertEqual(status, 400)
        wrong = self.root / "papers/paper-1/wrong.html"
        wrong.write_text(paper_html(category=2), encoding="utf-8")
        result = self.request("GET", "/api/papers")[1]
        self.assertEqual(result["papers"], [])
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("folder", result["errors"][0]["message"])

    def test_rejects_unsafe_filename_and_id(self):
        for filename in ("../out.html", "folder/file.html", "folder\\file.html"):
            self.assertEqual(self.request("POST", "/api/papers", {"filename": filename, "html": paper_html()})[0], 400)
        for identifier in ("../escaped", "folder/file", "two words"):
            self.assertEqual(self.request("POST", "/api/papers", {"filename": "safe.html", "html": paper_html(identifier)})[0], 400)

    def test_static_path_boundary_and_symlink(self):
        self.assertEqual(self.request("GET", "/")[0], 200)
        for path in ("/../outside.html", "/%2e%2e/outside.html", "/papers%5c..%5coutside.html"):
            self.assertEqual(self.request("GET", path)[0], 403)
        with tempfile.TemporaryDirectory() as elsewhere:
            secret = Path(elsewhere) / "outside.html"
            secret.write_text("private", encoding="utf-8")
            (self.root / "linked.html").symlink_to(secret)
            self.assertEqual(self.request("GET", "/linked.html")[0], 403)

    def test_origin_host_and_content_type_checks(self):
        payload = {"filename": "valid.html", "html": paper_html()}
        self.assertEqual(self.request("POST", "/api/papers", payload, {"Origin": "https://untrusted.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/papers", payload, {"Origin": "null"})[0], 403)
        self.assertEqual(self.request("POST", "/api/papers", payload, {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("GET", "/api/papers", headers={"Host": "untrusted.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/papers", payload, {"Origin": "http://127.0.0.1:%s" % self.port})[0], 201)

    def test_health_and_head(self):
        self.assertEqual(self.request("GET", "/api/health"), (200, {"ok": True}))
        self.assertEqual(self.request("HEAD", "/")[0], 200)


if __name__ == "__main__":
    unittest.main()
