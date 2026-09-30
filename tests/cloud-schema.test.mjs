import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const integration = await readFile(new URL('../supabase/tests/rls.sql', import.meta.url), 'utf8');
const sql = schema.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const tables = ['tmua_members', 'tmua_sync_state', 'tmua_sync_backups', 'tmua_pdf_versions'];

test('cloud schema: every application table has RLS and resets unsafe client grants', () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`, 'i'));
  }
  assert.match(sql, /role text not null unique check \(role in \('manager', 'student'\)\)/i);
  const tableGrants = [...sql.matchAll(/grant ([^;]+) on table public\.(tmua_\w+) to ([^;]+);/gi)];
  assert.deepEqual(tableGrants.map(([, privileges, table, role]) => [table, privileges, role]), [
    ['tmua_members', 'select', 'authenticated'],
    ['tmua_sync_state', 'select', 'authenticated'],
    ['tmua_sync_backups', 'select', 'authenticated'],
    ['tmua_pdf_versions', 'select, insert', 'authenticated'],
  ]);
});

test('cloud schema: security-definer entry points have fixed search paths and explicit execution grants', () => {
  const functions = [...sql.matchAll(/create or replace function public\.(tmua_\w+)\(([^)]*)\)(.*?)as \$\$(.*?)\$\$;/gi)]
    .filter(([, , , definition]) => /security definer/i.test(definition));
  assert.equal(functions.length, 4);
  for (const [, name, , definition] of functions) {
    assert.match(definition, /security definer set search_path = ''/i, name);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^;]*\\) from public, anon, authenticated;`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`, 'i'));
  }
  for (const name of ['tmua_write_state', 'tmua_save_backup']) {
    const body = functions.find(([, found]) => found === name)[4];
    assert.match(body, /if not public\.tmua_is_member\(\) then raise exception using errcode = '42501'/i);
    assert.match(body, /if not public\.tmua_payload_valid\(new_payload\) then/i);
  }
});

test('cloud schema: payload validator rejects incomplete envelopes and is callable only by the owner', () => {
  assert.match(sql, /tmua_payload_valid\(value jsonb\) returns boolean language sql immutable set search_path = ''/i);
  assert.match(sql, /select coalesce\(.*octet_length\(value::text\) <= 5242880, false \)/i);
  for (const key of ['library', 'history,version', 'history,attempts', 'roadmap,version', 'roadmap,pairs']) {
    assert.ok(sql.includes(key));
  }
  assert.match(sql, /revoke all on function public\.tmua_payload_valid\(jsonb\) from public, anon, authenticated;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.tmua_payload_valid/i);
  assert.equal([...sql.matchAll(/payload jsonb not null check \(public\.tmua_payload_valid\(payload\)\)/g)].length, 2);
});

test('cloud schema: state write is a revision-guarded atomic update with conflict failure', () => {
  assert.match(sql, /id text primary key default 'main' check \(id = 'main'\)/i);
  assert.match(sql, /revision bigint not null default 0 check \(revision >= 0\)/i);
  const initial = schema.match(/values \('main', 0, '([^']+)'::jsonb\)/i);
  assert.ok(initial);
  assert.deepEqual(JSON.parse(initial[1]), {
    version: 1, library: {}, history: { version: 1, attempts: [] }, roadmap: { version: 1, pairs: {} },
  });
  assert.match(sql, /update public\.tmua_sync_state set revision = revision \+ 1, payload = new_payload, updated_at = clock_timestamp\(\), updated_by = auth\.uid\(\) where id = 'main' and revision = expected_revision returning \* into saved;/i);
  assert.match(sql, /if not found then raise exception using errcode = '40001', message = 'TMUA_SYNC_CONFLICT';/i);
  assert.match(sql, /return jsonb_build_object\( 'revision', saved\.revision, 'payload', saved\.payload, 'updated_at', saved\.updated_at \)/i);
});

test('cloud schema: backup visibility is scoped and inserts stamp the authenticated member', () => {
  assert.match(sql, /for select to authenticated using \( \(select public\.tmua_is_manager\(\)\) or \(\(select public\.tmua_is_member\(\)\) and created_by = \(select auth\.uid\(\)\)\) \)/i);
  assert.match(sql, /insert into public\.tmua_sync_backups \(payload, created_by\) values \(new_payload, auth\.uid\(\)\) returning id into backup_id;/i);
  assert.match(sql, /tmua_save_backup\(new_payload jsonb\) returns uuid/i);
});

test('cloud schema: PDF bucket is private, size and MIME restricted, with insert/select policies only', () => {
  assert.match(sql, /values \('tmua-pdfs', 'tmua-pdfs', false, 52428800, array\['application\/pdf'\]\)/i);
  assert.match(sql, /on conflict \(id\) do update set public = false, file_size_limit = excluded\.file_size_limit, allowed_mime_types = excluded\.allowed_mime_types/i);
  const storagePolicies = [...sql.matchAll(/create policy (\w+) on storage\.objects for (\w+) to ([^;]+);/gi)];
  assert.equal(storagePolicies.length, 2);
  assert.deepEqual(storagePolicies.map(([, , operation]) => operation).sort(), ['insert', 'select']);
  for (const [, , , policy] of storagePolicies) {
    assert.match(policy, /^authenticated /i);
    assert.match(policy, /bucket_id = 'tmua-pdfs'/i);
    assert.match(policy, /public\.tmua_is_manager\(\)/i);
  }
  assert.match(sql, /object_path text not null unique check/);
  assert.match(sql, /sha256 text not null check \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /bytes bigint not null check \(bytes between 1 and 52428800\)/);
  assert.match(sql, /created_by = \(select auth\.uid\(\)\)/);
});

test('cloud schema: database integration suite is transactional and covers denied access and CAS conflict', () => {
  const clean = integration.replace(/--[^\n]*/g, '').trim();
  assert.match(clean, /^begin;/i);
  assert.match(clean, /reset role;\s*rollback;/i);
  for (const evidence of ['set local role anon', 'set local role authenticated', "'40001'", "'42501'", "'22023'", 'student reads own backup only', 'storage update denied', 'storage delete denied', 'self role assignment denied', 'conflict leaves state unchanged']) {
    assert.ok(integration.includes(evidence), `Missing integration check: ${evidence}`);
  }
});
