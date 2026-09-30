#!/usr/bin/env python3
"""Build a portable, offline TMUA practice paper: build_paper.py INPUT.json OUTPUT.html."""
import argparse
import html
import json
import re
from pathlib import Path


def validate(data):
    if not isinstance(data, dict):
        raise ValueError("Paper must be a JSON object")
    meta = data.get("metadata", {})
    questions = data.get("questions", [])
    if not isinstance(meta, dict) or meta.get("format") != "tmua-paper-v1":
        raise ValueError("metadata.format must be tmua-paper-v1")
    if not isinstance(meta.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", meta["id"]):
        raise ValueError("metadata.id must be 1–80 lowercase letters, numbers, hyphens or underscores, starting with a letter or number")
    if type(meta.get("paper")) is not int or meta["paper"] not in (1, 2) or type(meta.get("version")) is not int or meta["version"] != 1:
        raise ValueError("metadata.paper must be 1 or 2 and version must be 1")
    for key, maximum in (("title", 200), ("source", 300), ("description", 2000)):
        value = meta.get(key)
        if not isinstance(value, str) or len(value) > maximum or (key != "description" and not value.strip()):
            raise ValueError(f"metadata.{key} must be text with at most {maximum} characters" + ("" if key == "description" else " and cannot be blank"))
        if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
            raise ValueError(f"metadata.{key} contains an unsupported control character")
    if type(meta.get("questionCount")) is not int or not 1 <= meta["questionCount"] <= 1000:
        raise ValueError("metadata.questionCount must be a whole number from 1 to 1000")
    if not isinstance(questions, list) or meta["questionCount"] != len(questions):
        raise ValueError("metadata.questionCount must match the nonempty questions list")
    ids = set()
    for group in questions:
        if not isinstance(group, dict) or not isinstance(group.get("id"), str) or not group["id"] or group["id"] in ids:
            raise ValueError("Every question needs a unique id")
        ids.add(group["id"])
        if not isinstance(group.get("similar"), list) or not group["similar"]:
            raise ValueError(f"{group['id']} needs at least one similar exercise")
        for exercise in [group.get("original"), *group["similar"]]:
            if not isinstance(exercise, dict):
                raise ValueError(f"{group['id']}: exercise must be an object")
            for key in ("label", "lead", "solution"):
                if not isinstance(exercise.get(key), str) or not exercise[key].strip():
                    raise ValueError(f"{group['id']}: {key} must be a nonempty string")
            for key in ("tail", "latex", "fallback", "formulaLabel", "source"):
                if key in exercise and not isinstance(exercise[key], str):
                    raise ValueError(f"{group['id']}: {key} must be a string")
            if exercise.get("latex") and not exercise.get("fallback"):
                raise ValueError(f"{group['id']}: maths needs a MathML fallback for offline use")
            options = exercise.get("options", [])
            def valid_option(value):
                return type(value) in (int, float, str) or (
                    isinstance(value, dict) and all(
                        isinstance(value.get(key), str) and value[key].strip()
                        for key in ("html", "text")
                    )
                )
            if not isinstance(options, list) or not 2 <= len(options) <= 10 or not all(valid_option(value) for value in options):
                raise ValueError(f"{group['id']}: use two to ten options, each a number, string or {{html, text}} object")
            if exercise.get("correct") not in list("ABCDEFGHIJ"[:len(options)]):
                raise ValueError(f"{group['id']}: correct must name an available option letter")
            hints = exercise.get("hints", [])
            if not isinstance(hints, list) or not hints:
                raise ValueError(f"{group['id']}: include at least one knowledge step")
            for hint in hints:
                if not isinstance(hint, dict) or any(not isinstance(hint.get(key), str) or not hint[key].strip() for key in ("title", "body", "recap", "pitfall", "pause")):
                    raise ValueError(f"{group['id']}: steps need title, body, recap, pitfall and pause")
    return data


def script_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c").replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build(source, output):
    data = validate(json.loads(source.read_text(encoding="utf-8")))
    template_dir = Path(__file__).resolve().parent.parent / "templates"
    replacements = {
        "TITLE": html.escape(data["metadata"]["title"]),
        "METADATA": script_json(data["metadata"]),
        "DATA": script_json(data),
        "CSS": (template_dir / "paper.css").read_text(encoding="utf-8"),
        "PLAYER": (template_dir / "paper-player.js").read_text(encoding="utf-8"),
    }
    shell = (template_dir / "paper-shell.html").read_text(encoding="utf-8")
    rendered = re.sub(r"\{\{(TITLE|METADATA|DATA|CSS|PLAYER)\}\}", lambda match: replacements[match.group(1)], shell)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(f"Built {output} ({len(data['questions'])} questions, Paper {data['metadata']['paper']})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        build(args.input, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Cannot build paper: {error}\n")
