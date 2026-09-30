# TMUA guided practice

The Practice route presents exam pairs, with Paper 1 followed by Paper 2. Existing published HTML files and paper IDs are immutable so saved attempts remain compatible.

## Add an exam pair

1. In Manage PDFs, select separate Paper 1 and Paper 2 PDFs from the same exam. Both are required, must contain different bytes, and share an exam name and pair reference. Revised uploads create a new complete pair version; earlier sources remain private and intact.
2. Prepare and review both guided papers. Each needs all 20 original questions, checked solutions, progressive hints, knowledge reminders, pitfalls, and up to three reviewed follow-ups for each original. Where a third close match is absent, publish fewer useful questions and document the gap rather than padding the pool. Private PDF upload alone does not trigger conversion; the authenticated upload-to-preparation queue is not connected yet.
3. Put the two standalone HTML files in their respective paper folders. New metadata must use the same `pairId` for both files and `paper` values 1 and 2. The build rejects an incomplete pair. Do not extend the legacy exceptions in `content/pair-publication.json`.
4. Run the checks and publish both papers together. Preserve `content/published-papers.json` locks and every previous paper's bytes and URL.

The private source archive remains manager-only. Archive and Remove from my list are account-specific visibility preferences for prepared roadmap pairs. They do not delete source files, questions, saved answers, attempt history or concept evidence. Restore puts the same pair back into the active route.

## Concepts

`assets/studied-concepts.json` retains the 84 studied booklet lessons, with real booklet and lesson references. Add further reviewed concepts in its `additionalConcepts` array when supported by the published TMUA syllabus or an official TMUA question; do not invent booklet references.

An additional concept has an ID such as `p1-extra-short-name`, `paper`, `title`, a nonempty `knowledge` array and a nonempty `references` array. Each reference records `type` (`syllabus` or `question`), a precise `label` (specification section, or year/paper/question) and an HTTPS source `url`. Check that the mathematics remains within the current published syllabus. Record new concepts as new learning under Beyond the booklets. Do not add topics solely because they occur in a third-party mock.

Record every directly assessed booklet and additional concept on the reviewed question-bank entry in its authoritative `conceptIds` array, and keep `assets/concept-map.json` aligned with that array. A new concept has no score until a linked question has been attempted; it uses the same independent/hinted/retry scoring as booklet concepts. Extend the reviewed question bank and its knowledge references when publishing future pairs, rather than rewriting frozen paper HTML.

## Cloud setup

See `supabase/README.md`. Apply `supabase/migrations/20260930_required_pdf_pairs.sql` before publishing the paired uploader to an existing installation. The migration preserves legacy source rows and all account data; new metadata is inserted as an atomic two-row array sharing `pair_id`, with `paper_number` 1 and 2.


## Manager progress view

A manager sees a **Ryan’s progress** tab beside Practice and Concepts. It loads the student's latest synced snapshot on opening and supports refresh; it never imports that snapshot into the manager's local progress, attempts or cloud save. Completed papers, current answers, separate first-answer and after-practice scores, all sittings and concept evidence are read only. Student accounts cannot call this view.

Before deploying this feature to an existing installation, apply `supabase/migrations/20260930_manager_student_progress.sql`. It adds one manager-only read function and makes no changes to saved work or existing write permissions. Scores and concept calculations use the same shared definitions as the student's Concepts page. The timestamp is the latest cloud save, not a live online-status indicator.

## Immutable teaching editions

Keep every published paper HTML and its original `papers/` URL unchanged. A reviewed teaching update lives in a new file at `assets/editions/<editionId>/<paperId>.html`. It keeps the original paper ID, paper number, metadata version, question count and practice policy. Preserve question order and state compatibility; do not use an edition to replace a different paper.

Append each reviewed file to `content/paper-editions.json`:

```json
{"version":1,"editions":[{"editionId":"review-20260930","paperId":"tmua-2020-p1","href":"assets/editions/review-20260930/tmua-2020-p1.html","sha256":"FULL_SHA256_OF_THE_FINAL_FILE"}]}
```

The build verifies the exact safe path, full file hash, regular files, matching original metadata and unique edition IDs for each paper. It adds `editions` and `currentEditionId` to that paper's catalogue entry, while leaving its original `href` and hash intact. The last manifest entry for each paper is the teaching used for a new sitting. The manifest is optional in older repositories. Publish reviewed Paper 1 and Paper 2 teaching together after checking both.

Never edit, replace or remove an already published edition file or manifest entry. Append a new edition ID instead. Existing records without a `teachingEdition` pin resume the original paper; pinned records resume their exact edition. Both current saves and archived attempts retain the pin. “Start another attempt” archives previous answers and starts the current edition. An unavailable or unrecognized pin stops the player with an explicit recovery message rather than silently loading different teaching. Account changes replace the player browsing context so queued messages cannot write another account's answers.

Validate edition routing with `node --test tests/teaching-editions.test.mjs` alongside the normal build and regression checks.

Generate the reviewed editions with `npm run editions:review` (or `node tools/build-reviewed-editions.mjs --edition NEW-EDITION-ID`). The default edition ID is `review-20260930`. The command first requires complete, fresh question, concept and follow-up match audit records. It reads the protected originals, the current `content/*-plan.json` follow-up selections, reviewed question bank and preview source, then replaces the embedded `tmua-paper-data` JSON. Hint recall references are resolved from `content/studied-lessons.json`; authoritative question `conceptIds` are included. A reviewed plan can also update the description in both JSON metadata scripts, so a reduced follow-up pool is accurately described in the latest student catalogue. All state-critical metadata, the player and remaining shell stay unchanged, as do all original HTML files and their publication lock. Existing `legacySimilar` source IDs and order remain intact with refreshed reviewed teaching.

The compiler stages the complete edition directory before appending its hashes to the manifest. Rerunning the same inputs verifies the existing bytes without changing them. If reviewed content or planned follow-ups have changed, an existing edition ID is rejected: use a new ID after completing the new audits. Never regenerate an original paper to deliver teaching corrections. `tests/reviewed-editions.test.mjs` checks source fidelity, preview coverage, immutable reruns and refusal of stale reviews or changed originals.
