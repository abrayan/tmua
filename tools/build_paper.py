#!/usr/bin/env python3
"""Build a portable, offline TMUA practice paper: build_paper.py INPUT.json OUTPUT.html."""
import argparse
import copy
import html
import json
import re
from pathlib import Path
from urllib.parse import urlparse


def is_reviewed_fallback(exercise):
    """Account-bank questions keep their own attribution and an explicit match rationale."""
    url = urlparse(exercise.get('sourceUrl', ''))
    return (exercise.get('provider') == 'tmua-co-uk'
            and isinstance(exercise.get('sourceId'), str)
            and re.fullmatch(r'TMUACO-[A-Z0-9-]{1,65}', exercise['sourceId']) is not None
            and url.scheme == 'https' and url.hostname == 'tmua.co.uk'
            and isinstance(exercise.get('fallbackReason'), str)
            and bool(exercise['fallbackReason'].strip()))


PRIVATE_PROVIDERS = {"jzmaths-tyler": "TYLER-EXAM", "jzmaths-exam": "JZ-EXAM"}


def is_private_original(exercise, metadata):
    """Paid originals are recognized only inside an explicitly private compilation."""
    source_id = exercise.get("sourceId", "")
    provider = metadata.get("provider")
    prefix = PRIVATE_PROVIDERS.get(provider)
    url = urlparse(exercise.get("sourceUrl", ""))
    return (metadata.get("visibility") == "private"
            and prefix is not None
            and exercise.get("provider") == provider
            and isinstance(source_id, str)
            and re.fullmatch(re.escape(prefix) + r"-[A-Z0-9]+-P[12]-Q(?:0[1-9]|1[0-9]|20)", source_id) is not None
            and source_id.rsplit("-P", 1)[0].lower() == metadata.get("pairId")
            and metadata.get("id") == f"{metadata.get('pairId')}-p{metadata.get('paper')}"
            and f"-P{metadata.get('paper')}-Q" in source_id
            and url.scheme == "https" and url.hostname == "jzmaths.com"
            and not url.username and not url.password
            and url.path == "/simulator/" + source_id.rsplit("-Q", 1)[0].lower().replace("-", "_")
            and isinstance(exercise.get("source"), str) and bool(exercise["source"].strip()))


def private_marked(value):
    if isinstance(value, dict):
        return (value.get("visibility") == "private" or value.get("provider") in PRIVATE_PROVIDERS
                or any(private_marked(item) for item in value.values()))
    if isinstance(value, list):
        return any(private_marked(item) for item in value)
    return False


def outside_site(filename, label="Private file"):
    resolved = Path(filename).resolve()
    site = Path(__file__).resolve().parent.parent
    if resolved == site or site in resolved.parents or any((parent / ".git").exists() for parent in [resolved, *resolved.parents]):
        raise ValueError(f"{label} must stay outside the public repository")
    return resolved


def lesson_index(catalog, concepts=None):
    """Resolve references at build time so the resulting paper stays self-contained."""
    if isinstance(catalog, Path):
        catalog = json.loads(catalog.read_text(encoding="utf-8"))
    if not isinstance(catalog, dict) or type(catalog.get("version")) is not int or catalog["version"] != 1 or not isinstance(catalog.get("booklets"), list):
        raise ValueError("Studied-lessons catalogue needs version 1 and a booklets list")
    indexed = {}
    for booklet in catalog["booklets"]:
        if not isinstance(booklet, dict) or type(booklet.get("paper")) is not int or booklet["paper"] not in (1, 2) or type(booklet.get("booklet")) is not int or booklet["booklet"] < 1 or not isinstance(booklet.get("lessons"), list):
            raise ValueError("Each studied booklet needs paper 1 or 2, a positive booklet number and lessons")
        for lesson in booklet["lessons"]:
            if not isinstance(lesson, dict) or any(not isinstance(lesson.get(key), str) or not lesson[key].strip() for key in ("id", "title")) or any(type(lesson.get(key)) is not int or lesson[key] < 1 for key in ("number", "pdfPage")):
                raise ValueError("Each studied lesson needs an id, title, positive number and PDF page")
            if "sourceLabel" in lesson and (not isinstance(lesson["sourceLabel"], str) or not lesson["sourceLabel"].strip()):
                raise ValueError(f"Studied lesson {lesson['id']}: sourceLabel must be nonempty text")
            if lesson["id"] in indexed:
                raise ValueError(f"Duplicate studied lesson ID: {lesson['id']}")
            indexed[lesson["id"]] = {"title": lesson["title"], "paper": booklet["paper"], "booklet": booklet["booklet"], "number": lesson["number"], "pdfPage": lesson["pdfPage"]}
            if "sourceLabel" in lesson:
                indexed[lesson["id"]]["sourceLabel"] = lesson["sourceLabel"]
    if isinstance(concepts, Path):
        concepts = json.loads(concepts.read_text(encoding="utf-8"))
    if concepts is not None:
        if not isinstance(concepts, dict) or concepts.get("version") != 1 or not isinstance(concepts.get("additionalConcepts"), list):
            raise ValueError("Additional concepts need version 1 and an additionalConcepts list")
        for concept in concepts["additionalConcepts"]:
            if not isinstance(concept, dict) or not isinstance(concept.get("id"), str) or not re.fullmatch(r"p[12]-extra-[a-z0-9-]+", concept["id"]) or type(concept.get("paper")) is not int or concept["paper"] not in (1, 2) or not concept["id"].startswith(f"p{concept['paper']}-") or not isinstance(concept.get("title"), str) or not concept["title"].strip() or concept["id"] in indexed:
                raise ValueError("Invalid additional concept identity")
            references = concept.get("references")
            if not isinstance(references, list) or not references:
                raise ValueError("Additional concept needs official source references")
            for ref in references:
                if not isinstance(ref, dict) or ref.get("type") not in ("syllabus", "question") or not isinstance(ref.get("label"), str) or not ref["label"].strip() or not isinstance(ref.get("url"), str):
                    raise ValueError("Invalid additional concept reference")
                url = urlparse(ref["url"])
                if url.scheme != "https" or not url.hostname or url.username or url.password:
                    raise ValueError("Invalid additional concept source URL")
            indexed[concept["id"]] = {"title": concept["title"], "paper": concept["paper"], "kind": "additional", "sourceLabel": "New learning"}
    return indexed


def validate(data, catalog=None, concepts=None, *, allow_private=False):
    if not isinstance(data, dict):
        raise ValueError("Paper must be a JSON object")
    meta = data.get("metadata", {})
    questions = data.get("questions", [])
    if not isinstance(meta, dict) or meta.get("format") != "tmua-paper-v1":
        raise ValueError("metadata.format must be tmua-paper-v1")
    if private_marked(data) and not allow_private:
        raise ValueError("Private purchased content requires the audited private-pair compiler")
    if allow_private and (meta.get("visibility") != "private" or meta.get("provider") not in PRIVATE_PROVIDERS):
        raise ValueError("Private compilation needs explicit visibility and provider identity")
    policy = meta.get("practicePolicy")
    if allow_private and policy != "after-miss-up-to-3":
        raise ValueError("Private papers must preserve after-miss-up-to-3 practice")
    if policy is not None and policy != "after-miss-up-to-3":
        raise ValueError("metadata.practicePolicy must be after-miss-up-to-3 when provided")
    adaptive = policy == "after-miss-up-to-3"
    if not isinstance(meta.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", meta["id"]):
        raise ValueError("metadata.id must be 1–80 lowercase letters, numbers, hyphens or underscores, starting with a letter or number")
    if type(meta.get("paper")) is not int or meta["paper"] not in (1, 2) or type(meta.get("version")) is not int or meta["version"] != 1:
        raise ValueError("metadata.paper must be 1 or 2 and version must be 1")
    revision = meta.get('contentRevision', 1)
    if type(revision) is not int or revision not in (1, 2):
        raise ValueError('metadata.contentRevision must be 1 or 2')
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
    original_sources = set()
    assessment_sources = {g.get('original', {}).get('sourceId') for g in questions if isinstance(g, dict) and isinstance(g.get('original'), dict)}
    assessment_papers = {sid.rsplit('-Q', 1)[0] for sid in assessment_sources if isinstance(sid, str)}
    recall_steps = []
    for group in questions:
        if allow_private and ('legacySimilar' in group and (not isinstance(group['legacySimilar'], list) or group['legacySimilar'])):
            raise ValueError('Private releases cannot include unaudited legacy exercises')
        if not isinstance(group, dict) or not isinstance(group.get("id"), str) or not group["id"] or group["id"] in ids:
            raise ValueError("Every question needs a unique id")
        ids.add(group["id"])
        if not isinstance(group.get("similar"), list) or (adaptive and len(group["similar"]) > 3) or (not adaptive and not group["similar"]):
            raise ValueError(f"{group['id']} needs " + ("zero to three similar exercises" if adaptive else "at least one similar exercise"))
        similar_sources = set()
        for position, exercise in enumerate([group.get("original"), *group["similar"]]):
            if not isinstance(exercise, dict):
                raise ValueError(f"{group['id']}: exercise must be an object")
            if adaptive:
                source_id = exercise.get("sourceId")
                official_id = isinstance(source_id, str) and re.fullmatch(r"(?:20[0-9]{2}|SPEC|specimen)-P[12]-Q(?:0[1-9]|1[0-9]|20)", source_id)
                private_original = allow_private and position == 0 and is_private_original(exercise, meta)
                if allow_private and position == 0 and not private_original:
                    raise ValueError(f"{group['id']}: private original needs exact provider identity and source URL")
                if not official_id and not private_original and not (position > 0 and is_reviewed_fallback(exercise)):
                    raise ValueError(f"{group['id']}: official sourceId must look like 2020-P2-Q01 or SPEC-P2-Q01")
                if position == 0:
                    if source_id in original_sources:
                        raise ValueError(f"Duplicate original sourceId: {source_id}")
                    original_sources.add(source_id)
                else:
                    if source_id.rsplit('-Q', 1)[0] in assessment_papers:
                        raise ValueError(f"{group['id']}: questions from this assessment cannot be used as followups")
                    if source_id == group["original"]["sourceId"] or source_id in similar_sources:
                        raise ValueError(f"{group['id']}: similar sourceId must be distinct from the original and other followups")
                    similar_sources.add(source_id)
            for key in ("label", "lead", "solution"):
                if not isinstance(exercise.get(key), str) or not exercise[key].strip():
                    raise ValueError(f"{group['id']}: {key} must be a nonempty string")
            for key in ("tail", "latex", "fallback", "formulaLabel", "source", "sourceId"):
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
                if "recall" in hint:
                    references = hint["recall"]
                    if not isinstance(references, list) or not 1 <= len(references) <= 2:
                        raise ValueError(f"{group['id']}: recall must contain one or two lesson references")
                    seen = set()
                    for reference in references:
                        if not isinstance(reference, dict) or any(not isinstance(reference.get(key), str) or not reference[key].strip() for key in ("lessonId", "reminder")):
                            raise ValueError(f"{group['id']}: each recall reference needs a lessonId and nonempty reminder text")
                        if reference["lessonId"] in seen:
                            raise ValueError(f"{group['id']}: duplicate recall lessonId {reference['lessonId']}")
                        seen.add(reference["lessonId"])
                    recall_steps.append((group["id"], hint))
    if recall_steps:
        if catalog is None:
            raise ValueError("Recall references need the studied-lessons catalogue")
        indexed = lesson_index(catalog, concepts)
        resolved = []
        for question_id, hint in recall_steps:
            references = []
            for reference in hint["recall"]:
                lesson_id = reference["lessonId"]
                if lesson_id not in indexed:
                    raise ValueError(f"{question_id}: unknown recall lessonId {lesson_id}")
                references.append({"lessonId": lesson_id, "reminder": reference["reminder"], **indexed[lesson_id]})
            resolved.append((hint, references))
        for hint, references in resolved:
            hint["recall"] = references
    if revision == 2:
        if not adaptive or any(not isinstance(group.get('legacySimilar'), list) for group in questions):
            raise ValueError('Revision 2 needs the complete legacySimilar pool for every adaptive group')
        legacy = {'metadata': {**meta, 'contentRevision': 1}, 'questions': [
            {'id': group['id'], 'original': copy.deepcopy(group['original']), 'similar': copy.deepcopy(group['legacySimilar'])}
            for group in questions]}
        validate(legacy, catalog, concepts, allow_private=allow_private)
        for group, old in zip(questions, legacy['questions']):
            group['legacySimilar'] = old['similar']
    return data


def script_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c").replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build(source, output, catalog_path=None, concepts_path=None, *, allow_private=False):
    site_root = Path(__file__).resolve().parent.parent
    if allow_private:
        outside_site(source, "Private input")
        outside_site(output, "Private output")
    data = validate(json.loads(source.read_text(encoding="utf-8")),
                    catalog_path if catalog_path is not None else site_root / "content" / "studied-lessons.json",
                    concepts_path if concepts_path is not None else (site_root / "assets" / "studied-concepts.json" if catalog_path is None else None), allow_private=allow_private)
    if allow_private:
        for group in data["questions"]:
            original = group["original"]
            if original.get("provider") in PRIVATE_PROVIDERS:
                original["lead"] = re.sub(r"<img\b", '<img data-diagram-only="true"', original["lead"])
                original["solution"] = re.sub(
                    r'<img\b[^>]*class="source-question"[^>]*>',
                    lambda match: '<p class="diagram-scroll-note">Scroll sideways to read the diagram.</p>'
                    '<div class="solution-diagram" role="region" aria-label="Solution diagram" tabindex="0">'
                    + match.group(0) + '</div>', original["solution"])
    template_dir = site_root / "templates"
    replacements = {
        "TITLE": html.escape(data["metadata"]["title"]),
        "METADATA": script_json(data["metadata"]),
        "DATA": script_json(data),
        "CSS": (template_dir / "paper.css").read_text(encoding="utf-8"),
        "PLAYER": (template_dir / "paper-player.js").read_text(encoding="utf-8"),
        "VIEWCSS": (template_dir / "view-modes.css").read_text(encoding="utf-8") if (template_dir / "view-modes.css").exists() else "",
        "VIEWPLAYER": (template_dir / "view-modes.js").read_text(encoding="utf-8") if (template_dir / "view-modes.js").exists() else "",
    }
    if allow_private:
        # Native mathematical options need room for fractions and full statements.
        # Scanned official follow-ups retain their compact letter-only controls.
        replacements["VIEWCSS"] += """
body:not(.has-source-image) #choices { grid-template-columns: minmax(0, 1fr); }
body:not(.has-source-image) #choices .choice { justify-content: flex-start; padding: 12px 16px; }
body:not(.has-source-image) #choices .choice input,
body:not(.has-source-image) #choices .choice strong { flex: 0 0 auto; }
body:not(.has-source-image) #choices .choice > span { min-width: 0; max-width: 100%; overflow-x: auto; padding-block: 4px; }
body:not(.has-source-image) #choices .choice img { display: block; max-width: 100%; height: auto; }
.solution-diagram { max-width: 100%; overflow-x: auto; padding-bottom: 10px; }
.solution-diagram .source-question { width: 1000px; min-width: 1000px; max-width: none; }
.diagram-scroll-note { font-size: 14px; color: #476376; }
"""
        replacements["VIEWPLAYER"] = replacements["VIEWPLAYER"].replace(
            "#question-text .source-question'", "#question-text .source-question:not([data-diagram-only])'")
    shell = (template_dir / "paper-shell.html").read_text(encoding="utf-8")
    rendered = re.sub(r"\{\{(TITLE|METADATA|DATA|CSS|PLAYER|VIEWCSS|VIEWPLAYER)\}\}", lambda match: replacements[match.group(1)], shell)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(f"Built {output} ({len(data['questions'])} questions, Paper {data['metadata']['paper']})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--catalog", type=Path, help="Override content/studied-lessons.json when using recall references")
    parser.add_argument("--concept-catalog", type=Path, help="Additional concept catalogue for New learning reminders")
    args = parser.parse_args()
    try:
        build(args.input, args.output, args.catalog, args.concept_catalog)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Cannot build paper: {error}\n")
