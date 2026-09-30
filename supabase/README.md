# Private household cloud setup

This adds shared lesson state for one manager and one student. Both accounts can
read and save lesson progress. Only the manager can upload, list, or read the
private PDF archive. An authenticated account without an approved membership has
no access to either feature.

## Trusted setup

1. Create a dedicated Supabase project. Keep its database password and secret or
   service-role key out of the site, source files, screenshots, and repository.
2. In **Authentication → Users**, manually create the manager and student users
   with their own passwords. Confirm their email addresses through the dashboard
   or the normal confirmation flow. Do not store their passwords in this repo.
   Disable new user signups in the Auth settings; this app does not need public
   registration.
3. Open **SQL Editor** as the project owner and run all of
   [`schema.sql`](schema.sql). It creates the tables, private `tmua-pdfs` bucket,
   policies, and state-saving functions. The singleton `main` state starts at
   revision `0`. Rerunning the file preserves existing state and archived files.
4. Copy each approved user's ID from Authentication and replace the placeholders
   in this SQL **inside the SQL Editor only**:

   ```sql
   insert into public.tmua_members (user_id, role) values
     ('MANAGER_AUTH_USER_UUID'::uuid, 'manager'),
     ('STUDENT_AUTH_USER_UUID'::uuid, 'student');
   ```

   Each role is unique, so the schema permits at most one manager and one student.
   Only the trusted owner can assign or change these memberships; profiles and
   authentication metadata never grant access.
5. Configure the site's cloud connection with the project URL and **publishable
   key** (or the legacy `anon` key). These are public client configuration. Never
   use a secret or service-role key in a browser. Each device signs in separately
   with its approved account; passwords are not site configuration.
6. Run the verification below before relying on the cloud copy.

The script is intended for a new dedicated project. Existing broad policies on
`storage.objects` can grant additional access because PostgreSQL combines
permissive policies with OR. If reusing a project, inspect its existing storage
policies and ensure none also grants access to `tmua-pdfs`. Do not remove policies
needed by another application. The four `tmua_*` tables should have only the
policies defined in this script.

## Application contract

| Resource | Approved student | Approved manager |
| --- | --- | --- |
| `tmua_members` | Read own row | Read own row |
| `tmua_sync_state` | Read shared `main` row | Read shared `main` row |
| `tmua_write_state` | Save with matching revision | Save with matching revision |
| `tmua_save_backup` | Save own conflict backup | Save own conflict backup |
| `tmua_sync_backups` | Read own backups | Read all backups |
| `tmua_pdf_versions`, `tmua-pdfs` | No access | Insert and read |

No client role can directly insert, update, or delete shared state or membership.
All client roles are denied PDF update and deletion. An archived revision always
uses a fresh object and a fresh metadata row.

### Shared state

Read `public.tmua_sync_state` where `id = 'main'`. Its initial payload is:

```json
{
  "version": 1,
  "library": {},
  "history": { "version": 1, "attempts": [] },
  "roadmap": { "version": 1, "pairs": {} }
}
```

Call `tmua_write_state` with `{ "expected_revision": 0, "new_payload": {...} }`.
Success returns `{ "revision": 1, "payload": {...}, "updated_at": "..." }`.
The database performs revision comparison and update atomically. A stale revision
raises SQLSTATE `40001` with message `TMUA_SYNC_CONFLICT`, without modifying the
saved state. The caller should preserve its local changes, fetch the current
server version, and resolve the conflict rather than blindly retrying a stale
write. Use `tmua_save_backup({ "new_payload": {...} })` to preserve an additional
conflict copy; it returns the created backup UUID as a JSON string.

Payloads must have `version: 1`, an object `library`, a `history` object with
`version: 1` and an `attempts` array, and a `roadmap` object with `version: 1` and
an object `pairs`. Missing fields, nulls, and unsupported versions are rejected
with SQLSTATE `22023`. Table constraints enforce the same shape for trusted
database writes. The limit is 5 MiB (5,242,880 bytes) measured using
PostgreSQL's UTF-8 JSON text representation, which can include spacing different
from a browser's `JSON.stringify`. Allow a little room below the limit in the
client. Both sync and backup RPCs enforce this bound. Backups do not change the
shared revision.

### PDF archive

- Bucket: `tmua-pdfs`, private, maximum 50 MiB (52,428,800 bytes), MIME type
  `application/pdf` only.
- Object path: exactly a lowercase UUID followed by `.pdf`, with no folders.
  Upload with `upsert: false`; do not reuse a path.
- `tmua_pdf_versions` fields: `id` UUID, `document_key`, `title`, `filename`,
  `object_path`, lowercase hex `sha256`, `bytes`, `created_at`, and `created_by`.
  IDs/timestamps/creator have defaults. Metadata insertion requires the signed-in
  manager as creator.
- `document_key` starts with a lowercase letter or digit and contains 1–100
  lowercase letters, digits, dots, hyphens, or underscores. Title is 1–200
  characters after trimming. Filename is 5–255 characters, ends in `.pdf`
  case-insensitively, and contains no slash or backslash. SHA-256 is 64 lowercase
  hexadecimal characters. Size is a positive byte count within the bucket limit.
- Use authenticated downloads or short-lived signed URLs. A signed URL is a
  bearer link until it expires, so keep it out of the shared lesson payload and
  public exports. The student does not receive archive download access.

Upload the object before inserting its metadata. If a network failure leaves an
object without metadata, preserve it and retry the metadata insertion using the
same identifiers after checking for an existing matching row. Client deletion is
deliberately unavailable. Any cleanup or membership change is a trusted owner
operation in Supabase, outside the site.

The database validates declared size, hash format, and path format; it does not
calculate the file's hash or inspect PDF content. The upload UI validates the file
and calculates its SHA-256, and Supabase Storage enforces upload size and MIME.

## Verification

Run structural source checks from the site directory:

```sh
node --test tests/cloud-schema.test.mjs
```

These checks inspect the SQL contract; they do not replace a database test.

To execute the actual PostgreSQL schema and permissions locally without Docker,
install the optional test runtime outside the repository and run:

```sh
npm install --prefix /tmp/tmua-pg-test --no-save --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.8
TMUA_PGLITE_MODULE=/tmp/tmua-pg-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/cloud-schema-runtime.mjs
```

This uses embedded PostgreSQL with the minimal Supabase-shaped fixture in
[`tests/embedded-fixture.sql`](tests/embedded-fixture.sql). It installs the real
schema twice, executes the real SQL integration suite, and verifies rollback.
It exercises PostgreSQL grants, RLS, constraints, RPCs, and stale-revision
conflicts; it does not reproduce the Supabase Auth or Storage HTTP services, nor
does it simulate simultaneous database connections. The fixture must never be
run inside a real Supabase project. The runtime test skips unless
`TMUA_PGLITE_MODULE` is set.

For integration checks, run [`tests/rls.sql`](tests/rls.sql) as the trusted owner
in the Supabase SQL Editor **after** installing the schema, preferably in a
disposable project first. The script uses synthetic users, temporarily replaces
membership within one transaction, checks permissions under `anon` and
`authenticated`, and rolls everything back. It checks role isolation, denied
self-enrollment, approved writes, stale-revision conflicts, payload limits,
backup visibility, and immutable manager-only PDF metadata and storage objects.
A successful run ends with `TMUA RLS integration checks passed; test changes
rolled back.` If a check fails, the transaction is aborted; issue `rollback;` if
your SQL client leaves that transaction open. Do not run isolated fragments.

The SQL checks do not exercise the Storage HTTP service or browser login. Finish
with these checks using the actual approved accounts:

1. Sign in on two devices, save lesson progress on one, then load cloud state on
   the other. Confirm the library, history, and roadmap match.
2. Load the same revision on both, save distinct changes, and confirm the second
   save reports a conflict while preserving the first save and the local copy.
3. Upload a small PDF as manager, list and download it, and verify the bytes.
   Confirm a non-PDF and an over-50-MiB file are rejected.
4. Sign in as student and confirm the PDF manager and archive contents are
   unavailable. Sign out and confirm cloud state and PDF reads are denied.
5. Confirm neither account can change its role, and an unapproved authenticated
   test account receives no shared state or files.

Keep the site's local export/import available as an additional recovery copy.
The initial schema does not configure scheduled database backups or a retention
policy for conflict backups; manage those separately in the trusted dashboard.
