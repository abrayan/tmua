"""Focused compatibility checks: python3 tools/test_build_paper.py."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest

from build_paper import build, validate

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("paper_library_server", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)
SAMPLE = json.loads((ROOT / "content/jz-mock-d-p1-preview.json").read_text())
for group in SAMPLE["questions"]:
    for exercise in [group["original"], *group["similar"]]:
        for hint in exercise["hints"]:
            hint.pop("recall", None)

FIXTURE_CATALOG = {"version": 1, "booklets": [
    {"paper": 1, "booklet": 1, "bookletTitle": "Test methods", "filename": "test-methods.pdf", "lessons": [
        {"id": "fixture-method-11", "number": 11, "title": "Count repeated choices", "pdfPage": 14, "printedPage": 12, "sourceLabel": "METHOD 11", "knowledge": [], "keywords": []}
    ]},
    {"paper": 1, "booklet": 3, "bookletTitle": "Test lessons", "filename": "test-lessons.pdf", "lessons": [
        {"id": "fixture-lesson-8", "number": 8, "title": "Add the powers", "pdfPage": 9, "printedPage": 8, "sourceLabel": "Lesson 8", "knowledge": [], "keywords": []}
    ]}
]}


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


class RecallReferenceTests(unittest.TestCase):
    def document(self):
        data = copy.deepcopy(SAMPLE)
        data["questions"][0]["original"]["hints"][0]["recall"] = [{"lessonId": "fixture-method-11", "reminder": "Count choices of <math><mi>x</mi></math> from distinct brackets."}]
        return data

    def test_resolves_exact_catalogue_details(self):
        data = self.document()
        data["questions"][0]["original"]["hints"][0]["recall"][0]["title"] = "Untrusted stale title"
        result = validate(data, FIXTURE_CATALOG)
        recall = result["questions"][0]["original"]["hints"][0]["recall"][0]
        self.assertEqual(recall, {"lessonId": "fixture-method-11", "reminder": "Count choices of <math><mi>x</mi></math> from distinct brackets.", "title": "Count repeated choices", "paper": 1, "booklet": 1, "number": 11, "pdfPage": 14, "sourceLabel": "METHOD 11"})

    def test_unknown_id_and_missing_catalogue_fail(self):
        with self.assertRaisesRegex(ValueError, "catalogue"):
            validate(self.document())
        data = self.document()
        data["questions"][0]["original"]["hints"][0]["recall"][0]["lessonId"] = "missing-lesson"
        with self.assertRaisesRegex(ValueError, "unknown recall lessonId missing-lesson"):
            validate(data, FIXTURE_CATALOG)

    def test_malformed_duplicate_and_excessive_references_fail(self):
        ref = {"lessonId": "fixture-method-11", "reminder": "Remember this step."}
        malformed = [None, {}, [], [ref, ref], [ref, ref, ref], [{"lessonId": "fixture-method-11", "reminder": " "}], [{"lessonId": "fixture-method-11", "reminder": 3}], [{"reminder": "Remember this."}]]
        for references in malformed:
            with self.subTest(references=references):
                data = self.document()
                data["questions"][0]["original"]["hints"][0]["recall"] = references
                with self.assertRaises(ValueError):
                    validate(data, FIXTURE_CATALOG)

    def test_two_different_references_are_allowed(self):
        data = self.document()
        data["questions"][0]["original"]["hints"][0]["recall"].append({"lessonId": "fixture-lesson-8", "reminder": "Add the selected powers."})
        result = validate(data, FIXTURE_CATALOG)
        self.assertEqual(len(result["questions"][0]["original"]["hints"][0]["recall"]), 2)

    def test_build_embeds_resolved_details_and_old_papers_need_no_catalogue(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output, catalog = root / "paper.json", root / "paper.html", root / "catalog.json"
            source.write_text(json.dumps(self.document()))
            catalog.write_text(json.dumps(FIXTURE_CATALOG))
            with contextlib.redirect_stdout(io.StringIO()):
                build(source, output, catalog)
            embedded = json.loads(re.search(r'<script id="tmua-paper-data" type="application/json">(.*?)</script>', output.read_text(), re.S).group(1))
            self.assertEqual(embedded["questions"][0]["original"]["hints"][0]["recall"][0]["title"], "Count repeated choices")
            source.write_text(json.dumps(SAMPLE))
            with contextlib.redirect_stdout(io.StringIO()):
                build(source, output, root / "does-not-exist.json")
            self.assertEqual(SERVER.parse_metadata(output.read_text()), SAMPLE["metadata"])


class AdaptivePolicyTests(unittest.TestCase):
    def document(self):
        data = copy.deepcopy(SAMPLE)
        data["metadata"]["practicePolicy"] = "after-miss-up-to-3"
        for index, group in enumerate(data["questions"], 1):
            group["original"]["sourceId"] = f"2020-P2-Q{index:02d}"
            for position, exercise in enumerate(group["similar"], 1):
                exercise["sourceId"] = f"202{position}-P2-Q{index:02d}"
        return data

    def test_policy_permits_zero_to_three_official_followups(self):
        data = self.document()
        data["questions"][0]["similar"] = []
        validate(data)
        data = self.document()
        third = copy.deepcopy(data["questions"][0]["similar"][0])
        third["sourceId"] = "SPEC-P2-Q10"
        data["questions"][0]["similar"].append(third)
        validate(data)
        data["questions"][0]["similar"].append(copy.deepcopy(third))
        with self.assertRaisesRegex(ValueError, "zero to three"):
            validate(data)

    def test_policy_rejects_unknown_missing_and_nonofficial_ids(self):
        data = self.document()
        data["metadata"]["practicePolicy"] = "always-more"
        with self.assertRaisesRegex(ValueError, "practicePolicy"):
            validate(data)
        for source_id in (None, "invented-question", "2021-P2-Q1", "2021-P2-Q21", "2021-P3-Q01"):
            with self.subTest(source_id=source_id):
                data = self.document()
                data["questions"][0]["original"]["sourceId"] = source_id
                with self.assertRaisesRegex(ValueError, "official sourceId"):
                    validate(data)

    def test_original_paper_and_duplicates_cannot_be_followups(self):
        for source_id in ("2020-P2-Q20", "2022-P2-Q01"):
            with self.subTest(source_id=source_id):
                data = self.document()
                data["questions"][0]["similar"][0]["sourceId"] = source_id
                with self.assertRaises(ValueError):
                    validate(data)
        data = self.document()
        data["questions"][1]["original"]["sourceId"] = "2020-P2-Q01"
        with self.assertRaisesRegex(ValueError, "Duplicate original"):
            validate(data)

    def test_overlapping_curated_pools_are_allowed_for_runtime_deduplication(self):
        data = self.document()
        data["questions"][1]["similar"][0]["sourceId"] = data["questions"][0]["similar"][0]["sourceId"]
        validate(data)

    def test_builder_embeds_policy_source_ids_and_view_hooks(self):
        data = self.document()
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "policy.json", Path(directory) / "policy.html"
            source.write_text(json.dumps(data))
            with contextlib.redirect_stdout(io.StringIO()):
                build(source, output)
            rendered = output.read_text()
            embedded = json.loads(re.search(r'<script id="tmua-paper-data" type="application/json">(.*?)</script>', rendered, re.S).group(1))
            self.assertEqual(embedded["metadata"]["practicePolicy"], "after-miss-up-to-3")
            self.assertEqual(embedded["questions"][0]["similar"][0]["sourceId"], "2021-P2-Q01")
            self.assertNotIn("{{VIEWCSS}}", rendered)
            self.assertNotIn("{{VIEWPLAYER}}", rendered)
            self.assertIn("tmua-review-content", rendered)


if __name__ == "__main__":
    unittest.main()
