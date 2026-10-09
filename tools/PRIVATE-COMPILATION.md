# Private guided pair compiler

Paid source content, authored banks, plans, reviews and compiled HTML must live **outside this public repository**. Do not add them to `assets`, `papers`, `content`, or Git. Public authoring and builds continue to reject private content. Private originals support `jzmaths-tyler` for `TYLER-EXAM-A-P1-Q01`-style identities and `jzmaths-exam` for `JZ-EXAM-D-P1-Q01`-style identities. The provider, exact exam set, paper number and matching simulator URL must agree; never relabel these as official TMUA questions or conflate an Exam Set with a Mock Set.

Run:

```sh
python3 tools/build_private_pair.py /private/path/pair-config.json /private/path/compiled --node /path/to/node
```

The uploaded MioMath 2024 pair uses provider `miomath`, pair ID
`miomath-tmua-2024`, paper IDs `miomath-tmua-2024-p1` and
`miomath-tmua-2024-p2`, and question IDs `MIOMATH-2024-P1-Q01` through
`MIOMATH-2024-P2-Q20`. Each plan must include a distinct `metadata.sourceUrl`
identifying its uploaded PDF in `tmua-pdfs`; every original in that paper must
repeat that exact URL. Use the stable authenticated object URL, never a signed
download URL, token, password or public-storage URL. This is provenance only;
the player does not fetch the source PDF to display compiled questions. The
provider is rejected by public-build guards even without a private marker.

Supporting a provider does not approve a source or make its answer key reliable.
An unresolved source defect holds the complete pair. Keep draft banks with
unresolved answers outside the repository; do not manufacture review approvals
to make them compile.

Configuration, with all source filenames resolved relative to that configuration:

```json
{
  "version": 1,
  "visibility": "private",
  "pairId": "tyler-exam-a",
  "editionId": "private-tyler-a-20261001",
  "mappingVersionId": "private-tyler-a-20261001",
  "plans": ["p1-plan.json", "p2-plan.json"],
  "bank": "question-bank.json",
  "questionAudits": "question-audits.json",
  "followupAudits": "followup-audits.json",
  "qa": "independent-qa.json"
}
```

Plans use the existing `metadata`, `groups` and `matches` structure. Both must have 20 questions, the same `pairId`, `visibility: "private"`, a provider matching the pair identity (`jzmaths-tyler`, `jzmaths-exam`, or `miomath` for the uploaded 2024 pair), and `practicePolicy: "after-miss-up-to-3"`. Every private original requires a precise `knowledgePattern`, `source`, `sourceUrl` and assessed `conceptIds`. A group with fewer than three reviewed matches must document `followupGap`. Follow-ups remain official TMUA questions or explicitly reviewed `tmua-co-uk` fallbacks; no original from either member of the pair can be a follow-up. Different follow-ups in the same paper cannot reuse a source.

The private bank is merged with the public bank in memory. It may add new questions or include a reviewed private teaching copy of an existing `official-tmua` question. Such a copy must preserve every source and question field exactly, including stem/crop, options, correct answer, diagram hash, provider and source identity. Only `hints`, `solution`, `conceptIds`, `knowledgePattern` and `knowledgeTags` may change. Each copy requires a fresh private question audit, renewed dependent relationship reviews and independent QA against its new semantic and full hashes; no public question file is changed. Record any defect discovered in the public teaching separately for its own reviewed edition. Reused official question reviews are read from the current public audit file. The private question review file supplies reviews for the new exercises and any explicitly re-reviewed reused official exercises. All private review `issues` must be empty; record corrected historical findings separately. Every question still passes the existing content and concept audit gates; every relationship passes the existing follow-up gate.

Independent QA has this structure:

```json
{
  "version": 1,
  "author": "Author identity",
  "reviewer": "Different reviewer identity",
  "status": "approved",
  "questions": [],
  "relationships": []
}
```

`questions` must cover every distinct original and follow-up used by the two plans, with `sourceId`, `contentHash`, `fullHash`, question-specific `verification`, `hintVerdict`, `remainingWork`, `conceptReason`, and empty `issues`. `contentHash` is the existing `questionFingerprint(question)`. `fullHash` is SHA-256 of `canonicalJson(question)`, covering all additional presentation and provenance fields too. Hash the authored question before build-time lesson-reference resolution. The `canonicalJson` helper is exported by `tools/validate-content-audit.mjs`. Do not refresh either fingerprint without re-reviewing the final material.

`relationships` has the same shape as the normal follow-up audit reviews and must cover every edge exactly once, with current `contentHash`, matching `verdict`, `sharedConceptIds`, and a substantive independent `reason`. The author and reviewer must differ. These checks prove completeness and freshness of the supplied reviews, not mathematical correctness by themselves.

The compiler creates both immutable `<paperId>/<editionId>.html` files plus `manifest.json`. It checks both output collisions before writing either paper, rejects differing existing bytes, and rechecks the reviewed input hashes before saving. The manifest's `papers` rows are ready for a trusted owner's private-storage uploader:

- `paper_id`, `edition_id`, `pair_id`, `paper_number`;
- `object_path`, full HTML `sha256`, original `metadata`;
- `concept_mapping: {versionId, sha256, paper}`.

The mapping hash is SHA-256 of `canonicalJson(paper)`. Its `questions` contains **20 originals in assessment order**, preserving the existing analytics contract; follow-up concepts remain explicit in the exercise payload and audit evidence. The mapping's `contentRevisions` reflects the compiled plan, and canonical IDs for reused questions retain the public map's identity.

The compiler does not upload, deploy, change storage permissions, mutate accounts or freeze public mappings. Publication uses the separately authorized private-storage path only. Public build guards reject marked JSON and HTML in copied assets, including a JSON payload renamed with another extension; no compiler can identify arbitrary unmarked binary content as purchased, so source files must remain in private storage.
