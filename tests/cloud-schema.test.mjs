import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260930_account_progress_v2.sql', import.meta.url), 'utf8');
const pairMigration = await readFile(new URL('../supabase/migrations/20260930_required_pdf_pairs.sql', import.meta.url), 'utf8');
const integration = await readFile(new URL('../supabase/tests/rls.sql', import.meta.url), 'utf8');
const normalize = value => value.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const sql = normalize(schema);
const tables = ['tmua_members', 'tmua_sync_state', 'tmua_sync_backups', 'tmua_sync_state_v2', 'tmua_sync_backups_v2', 'tmua_pdf_versions'];

test('cloud schema: fresh install and idempotent migration have identical safety rules', () => {
  const pairBlock = /-- Required PDF pairs\.[\s\S]*?-- End required PDF pairs\./;
  assert.equal(normalize(migration), normalize(schema.replace(pairBlock, '')));
  assert.equal(schema.match(pairBlock)?.[0], pairMigration.match(pairBlock)?.[0]);
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`, 'i'));
  }
  assert.match(sql, /role text not null unique check \(role in \('manager', 'student'\)\)/i);
  const tableGrants = [...sql.matchAll(/grant ([^;]+) on table public\.(tmua_\w+) to ([^;]+);/gi)];
  assert.deepEqual(tableGrants.map(([, privileges, table, role]) => [table, privileges, role]), [
    ['tmua_members', 'select', 'authenticated'],
    ['tmua_sync_state_v2', 'select', 'authenticated'],
    ['tmua_sync_backups_v2', 'select', 'authenticated'],
    ['tmua_pdf_versions', 'select, insert', 'authenticated'],
  ]);
});

test('cloud schema: paired inserts are required and checked together at transaction commit', () => {
  const pairs = normalize(pairMigration);
  assert.match(pairs, /add column if not exists pair_id uuid, add column if not exists paper_number smallint/i);
  assert.match(pairs, /unique \(pair_id, paper_number\)/i);
  assert.match(pairs, /paper_number in \(1, 2\)/i);
  assert.match(pairs, /before insert on public\.tmua_pdf_versions/i);
  assert.match(pairs, /if new\.pair_id is null or new\.paper_number is null then/i);
  assert.match(pairs, /create constraint trigger tmua_pdf_pair_complete after insert on public\.tmua_pdf_versions deferrable initially deferred/i);
  assert.match(pairs, /count\(\*\) <> 2/);
  assert.match(pairs, /count\(distinct sha256\) <> 2/);
  for (const field of ['document_key', 'title', 'created_by']) {
    assert.ok(pairs.includes(`${field} is distinct from new.${field}`));
  }
  assert.doesNotMatch(pairs, /(?:update|delete from) public\.tmua_pdf_versions/i);
  assert.doesNotMatch(pairs, /grant|create policy|security definer/i);
});

test('cloud schema: owner-bound entry points have fixed search paths and explicit grants', () => {
  const functions = [...sql.matchAll(/create or replace function public\.(tmua_\w+)\(([^)]*)\)(.*?)as \$\$(.*?)\$\$;/gi)]
    .filter(([, , , definition]) => /security definer/i.test(definition));
  assert.equal(functions.length, 8);
  for (const [, name, , definition] of functions) {
    assert.match(definition, /security definer set search_path = ''/i, name);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^;]*\\) from public, anon, authenticated;`, 'i'));
    const obsolete = ['tmua_write_state', 'tmua_save_backup'].includes(name);
    const grant = new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`, 'i');
    if (obsolete) assert.doesNotMatch(sql, grant);
    else assert.match(sql, grant);
  }
  for (const name of ['tmua_read_state_v2', 'tmua_write_state_v2', 'tmua_save_backup_v2']) {
    const fn = functions.find(([, found]) => found === name);
    assert.doesNotMatch(fn[2], /user_id|owner|created_by/);
    assert.match(fn[4], /if not public\.tmua_is_member\(\) then raise exception using errcode = '42501'/i);
  }
});

test('cloud schema: payload envelopes are constrained and validator is owner-only', () => {
  assert.match(sql, /tmua_payload_valid\(value jsonb\) returns boolean language sql immutable set search_path = ''/i);
  assert.match(sql, /select coalesce\(.*octet_length\(value::text\) <= 5242880, false \)/i);
  for (const key of ['library', 'history,version', 'history,attempts', 'roadmap,version', 'roadmap,pairs']) assert.ok(sql.includes(key));
  assert.match(sql, /revoke all on function public\.tmua_payload_valid\(jsonb\) from public, anon, authenticated;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.tmua_payload_valid/i);
  assert.equal([...sql.matchAll(/payload jsonb not null check \(public\.tmua_payload_valid\(payload\)\)/g)].length, 4);
});

test('cloud schema: independent account revisions use auth.uid and an atomic comparison', () => {
  assert.match(sql, /user_id uuid primary key references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /on conflict \(user_id\) do nothing/i);
  assert.match(sql, /update public\.tmua_sync_state_v2 set revision = revision \+ 1, payload = new_payload, updated_at = clock_timestamp\(\), updated_by = auth\.uid\(\) where user_id = auth\.uid\(\) and revision = expected_revision returning \* into saved;/i);
  assert.match(sql, /if not found then raise exception using errcode = '40001', message = 'TMUA_SYNC_CONFLICT';/i);
  assert.doesNotMatch(sql, /insert into public\.tmua_sync_state\s*\(/i);
  assert.doesNotMatch(sql, /update public\.tmua_sync_state\s+set/i);
});

test('cloud schema: current progress and backups are private even from the manager', () => {
  for (const table of ['tmua_sync_state_v2', 'tmua_sync_backups_v2']) {
    assert.match(sql, new RegExp(`create policy \\w+ on public\\.${table} for select to authenticated using \\( \\(select public\\.tmua_is_member\\(\\)\\) and user_id = \\(select auth\\.uid\\(\\)\\) \\)`));
  }
  assert.match(sql, /insert into public\.tmua_sync_backups_v2 \(user_id, payload\) values \(auth\.uid\(\), new_payload\) returning id into backup_id;/i);
  assert.match(sql, /tmua_read_legacy_state_v2\(\).*if not public\.tmua_is_manager\(\) then raise exception using errcode = '42501', message = 'TMUA_MANAGER_REQUIRED'/i);
  assert.equal([...sql.matchAll(/message = 'TMUA_ACCOUNT_UPGRADE_REQUIRED'/g)].length, 2);
});

test('cloud schema: PDF permissions remain private, manager-only, and append-only', () => {
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

test('cloud schema: real role suite checks account isolation, stale writes and frozen legacy data', () => {
  assert.match(normalize(integration), /^begin;/i);
  assert.match(integration, /reset role;[\s\S]*rollback;/i);
  for (const evidence of ['set local role anon', 'set local role authenticated', "'40001'", "'42501'", "'22023'", 'student reads own backup only', 'manager reads own backup only', 'student cannot see manager progress', 'manager cannot read student progress', 'spoofed owner inside payload cannot redirect a write', 'storage update denied', 'storage delete denied', 'conflict leaves state unchanged', 'legacy archive remains unchanged']) {
    assert.ok(integration.includes(evidence), `Missing integration check: ${evidence}`);
  }
});
