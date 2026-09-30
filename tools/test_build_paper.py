"""Focused compatibility checks: python3 tools/test_build_paper.py."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

from build_paper import build, validate

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("paper_library_server", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)
SAMPLE = json.loads((ROOT / "content/jz-mock-d-p1-preview.json").read_text())


class MetadataCompatibilityTests(unittest.TestCase):
    def document(self, key, value):
        data = copy.deepcopy(SAMPLE)
        data["metadata"][key] = value
        return data

    def check_server_agrees(self, data, valid):
        metadata_html = '<script id="tmua-paper-meta" type="application/json">' + json.dumps(data["metadata"]) + '</script>'
        if valid:
            validate(data)
            SERVER.parse_metadata(metadata_html)
        else:
            with self.assertRaises(ValueError):
                validate(data)
            with self.assertRaises(ValueError):
                SERVER.parse_metadata(metadata_html)

    def test_strict_types_and_numbers(self):
        for key, value in (("id", 123), ("version", True), ("version", 1.0), ("paper", True), ("paper", 1.0), ("paper", 3), ("questionCount", True), ("questionCount", 2.0), ("questionCount", 0), ("questionCount", 1001)):
            with self.subTest(key=key, value=value):
                data = self.document(key, value)
                if key == "questionCount" and value is True:
                    data["questions"] = data["questions"][:1]
                self.check_server_agrees(data, False)

    def test_id_boundaries(self):
        for value in ("a", "official_2023-p1", "a" * 80):
            with self.subTest(value=value):
                self.check_server_agrees(self.document("id", value), True)
        for value in ("", "_paper", "Paper1", "paper/1", "a" * 81, "paper\n"):
            with self.subTest(value=value):
                self.check_server_agrees(self.document("id", value), False)

    def test_text_limits_blank_description_and_controls(self):
        for key, maximum in (("title", 200), ("source", 300), ("description", 2000)):
            with self.subTest(key=key):
                self.check_server_agrees(self.document(key, "x" * maximum), True)
                self.check_server_agrees(self.document(key, "x" * (maximum + 1)), False)
                self.check_server_agrees(self.document(key, "A\nB\r\tC"), True)
                self.check_server_agrees(self.document(key, "A\x00B"), False)
                self.check_server_agrees(self.document(key, 12), False)
                self.check_server_agrees(self.document(key, ""), key == "description")

    def test_count_must_match_questions(self):
        data = self.document("questionCount", 1)
        with self.assertRaisesRegex(ValueError, "match"):
            validate(data)
        data["questions"] = data["questions"][:1]
        self.check_server_agrees(data, True)
        data["questions"] = [dict(data["questions"][0], id=f"q{i}") for i in range(1000)]
        data["metadata"]["questionCount"] = 1000
        self.check_server_agrees(data, True)

    def test_built_html_passes_library_parser(self):
        data = self.document("id", "example_paper-1")
        data["metadata"]["description"] = ""
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "paper.json", Path(directory) / "paper.html"
            source.write_text(json.dumps(data))
            with contextlib.redirect_stdout(io.StringIO()):
                build(source, output)
            self.assertEqual(SERVER.parse_metadata(output.read_text()), data["metadata"])


if __name__ == "__main__":
    unittest.main()
