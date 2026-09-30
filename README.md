# TMUA guided practice

The Practice route presents exam pairs, with Paper 1 followed by Paper 2. Existing published HTML files and paper IDs are immutable so saved attempts remain compatible.

## Add an exam pair

1. In Manage PDFs, select separate Paper 1 and Paper 2 PDFs from the same exam. Both are required, must contain different bytes, and share an exam name and pair reference. Revised uploads create a new complete pair version; earlier sources remain private and intact.
2. Prepare and review both guided papers. Each needs all 20 original questions, checked solutions, progressive hints, knowledge reminders, pitfalls, and three reviewed follow-ups for each original. Private PDF upload alone does not trigger conversion; the authenticated upload-to-preparation queue is not connected yet.
3. Put the two standalone HTML files in their respective paper folders. New metadata must use the same `pairId` for both files and `paper` values 1 and 2. The build rejects an incomplete pair. Do not extend the legacy exceptions in `content/pair-publication.json`.
4. Run the checks and publish both papers together. Preserve `content/published-papers.json` locks and every previous paper's bytes and URL.

The private source archive remains manager-only. Archive and Remove from my list are account-specific visibility preferences for prepared roadmap pairs. They do not delete source files, questions, saved answers, attempt history or concept evidence. Restore puts the same pair back into the active route.

## Concepts

`assets/studied-concepts.json` retains the 84 studied booklet lessons, with real booklet and lesson references. Add further reviewed concepts in its `additionalConcepts` array when supported by the published TMUA syllabus or an official TMUA question; do not invent booklet references.

An additional concept has an ID such as `p1-extra-short-name`, `paper`, `title`, a nonempty `knowledge` array and a nonempty `references` array. Each reference records `type` (`syllabus` or `question`), a precise `label` (specification section, or year/paper/question) and an HTTPS source `url`. Check that the mathematics remains within the current published syllabus. Record new concepts as new learning under Beyond the booklets. Do not add topics solely because they occur in a third-party mock.

Record extra concept IDs on the reviewed question-bank entry as `additionalConceptIds`, and map those IDs alongside booklet lessons in `assets/concept-map.json`. Existing booklet mappings remain valid. A new concept has no score until a linked question has been attempted; it uses the same independent/hinted/retry scoring as booklet concepts. Extend the reviewed question bank and its knowledge references when publishing future pairs, rather than rewriting frozen paper HTML.

## Cloud setup

See `supabase/README.md`. Apply `supabase/migrations/20260930_required_pdf_pairs.sql` before publishing the paired uploader to an existing installation. The migration preserves legacy source rows and all account data; new metadata is inserted as an atomic two-row array sharing `pair_id`, with `paper_number` 1 and 2.


## Manager progress view

A manager sees a **Ryan’s progress** tab beside Practice and Concepts. It loads the student's latest synced snapshot on opening and supports refresh; it never imports that snapshot into the manager's local progress, attempts or cloud save. Completed papers, current answers, separate first-answer and after-practice scores, all sittings and concept evidence are read only. Student accounts cannot call this view.

Before deploying this feature to an existing installation, apply `supabase/migrations/20260930_manager_student_progress.sql`. It adds one manager-only read function and makes no changes to saved work or existing write permissions. Scores and concept calculations use the same shared definitions as the student's Concepts page. The timestamp is the latest cloud save, not a live online-status indicator.
