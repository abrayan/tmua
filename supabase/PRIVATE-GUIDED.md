# Private guided teaching

Purchased questions, authored teaching, reviews and compiled papers stay outside
the public Git repository. The public site contains only the delivery code. Both
existing household members can read a released private pair after signing in;
neither browser account can upload, change or delete prepared teaching.

## Setup and release

1. Have a separate reviewer approve the final runtime and schema proposal. As the
   trusted project owner, apply
   [`migrations/20261001_private_guided_editions.sql`](migrations/20261001_private_guided_editions.sql)
   after the existing schema and account migrations. It adds one table and a
   private `tmua-guided` bucket. It does not change existing memberships, progress,
   PDF archive permissions or scoring functions.
2. Inspect existing storage policies in the target project. PostgreSQL combines
   permissive policies with OR: an unrelated broad policy must not grant access
   to `tmua-guided`. The migration does not remove other applications' policies.
3. Follow [`../tools/PRIVATE-COMPILATION.md`](../tools/PRIVATE-COMPILATION.md),
   including the independent question and relationship review. Compile both
   papers together into a private directory. Keep its manifest and audits there.
4. Through a trusted owner/service connection, upload both compiled HTML files
   into `tmua-guided` at the manifest's exact `object_path`, with MIME type
   `text/html` and **upsert disabled**. The bucket is never public. Keep secret
   keys out of the website, command arguments, logs, screenshots and Git.
5. Insert both manifest `papers` rows into `public.tmua_guided_editions` in one
   transaction (or one bulk INSERT), omitting `created_at` so its transaction
   default is identical. Supply the eight manifest fields `paper_id`,
   `edition_id`, `pair_id`, `paper_number`, `object_path`, `sha256`, `metadata`
   and `concept_mapping`. An incomplete pair cannot commit. Unlisted uploaded
   objects cannot be read by either browser account.
6. Publish the independently reviewed public runtime. Verify the private pair
   appears for each approved account, while anonymous and unapproved accounts
   cannot list or download it. Verify both stored object hashes before release.
   Do not submit test answers into a student's live account.

The shipped code is not a preparation worker. Uploading a source PDF does not
automatically author questions, initiate a review or publish a private pair.
Preparation and trusted-owner release are explicit separate steps.

## Editions and progress

Every released HTML object and database row is immutable. Corrections require a
new edition ID and a new reviewed mapping version. Upload and publish a complete
pair for each edition. Old files, rows and mappings remain available; a resumed
attempt uses its saved edition, while a fresh attempt uses the latest one.
Original question order and canonical source identities cannot change between
editions. No existing scores, weights, answers or attempt records are rewritten.

The signed-in parent fetches a private HTML object through authenticated Storage,
verifies its full SHA-256 and metadata, and renders it in an opaque sandbox using
`srcdoc`. Tokens and signed URLs are never passed to the exercise. Its content
security policy blocks external requests. Private HTML and catalogue data are
held only in memory; signing out or changing accounts clears the frame and
rejects late responses. Existing account-specific answer caching and cloud sync
continue to own progress.

Private mappings are merged in memory with public mappings. They appear in the
student Concepts tab and the manager's read-only student view. Archive, remove
and restore use the existing per-account pair preferences and never delete
teaching, attempts or scores.

## Verification scope

`tests/private-guided-schema-runtime.mjs` exercises PostgreSQL policy and trigger
behavior using synthetic users and storage metadata. It does not exercise the
production Storage HTTP service. `tests/private-papers.test.mjs` exercises local
synthetic papers in both interfaces at desktop and mobile sizes, including
feedback, hints, follow-ups, scores, old/new editions, resume, account switching,
manager concept evidence, and archive/remove/restore. The private compiler tests
exercise review freshness and public-build exclusion.

Use `TMUA_PGLITE_MODULE` and `TMUA_PLAYWRIGHT_PATH` when those dependencies are
outside the normal module path; otherwise these suites explicitly skip their
unavailable runtime. A skipped or mocked check is not production verification.
