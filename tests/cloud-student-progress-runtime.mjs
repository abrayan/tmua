import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.TMUA_PGLITE_MODULE;
const options = { skip: modulePath ? false : 'Set TMUA_PGLITE_MODULE to run PostgreSQL student-view permission checks.' };
const readSql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const manager = '77777777-7777-4777-8777-777777777777';
const student = '88888888-8888-4888-8888-888888888888';
const outsider = '99999999-9999-4999-8999-999999999999';
const empty = { version: 1, library: {}, history: { version: 1, attempts: [] }, roadmap: { version: 1, pairs: {} } };
const noStudent = { student: null, revision: null, payload: null, updated_at: null };
const migrationName = 'migrations/20260930_manager_student_progress.sql';
const readProgress = async db => (await db.query('select public.tmua_read_student_progress() as progress')).rows[0].progress;
const asUser = async (db, id) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
const forbidden = (run, label) => assert.rejects(run, error => error.code === '42501', label);
const snapshots = async db => {
  await db.exec('reset role;');
  const result = {};
  for (const table of ['tmua_members', 'tmua_sync_state', 'tmua_sync_backups', 'tmua_sync_state_v2', 'tmua_sync_backups_v2']) {
    result[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') as rows from public.${table} t`)).rows[0].rows;
  }
  return result;
};
const setup = async (withStudent = true, incremental = false) => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  await db.exec(await readSql('tests/embedded-fixture.sql'));
  await db.exec(await readSql(incremental ? 'migrations/20260930_account_progress_v2.sql' : 'schema.sql'));
  await db.exec(`insert into auth.users(id) values ('${manager}'), ('${student}'), ('${outsider}');
    insert into public.tmua_members(user_id,role) values ('${manager}','manager');`);
  if (withStudent) await db.query('insert into public.tmua_members(user_id,role) values ($1, $2)', [student, 'student']);
  return db;
};

test('student-progress schema and migration share the same read-only manager contract', async () => {
  const block = /-- Manager student progress\.[\s\S]*?-- End manager student progress\./;
  const schema = await readSql('schema.sql');
  const migration = await readSql(migrationName);
  assert.ok(schema.match(block));
  assert.equal(schema.match(block)[0], migration.match(block)[0]);
  assert.match(migration, /tmua_read_student_progress\(\)/);
  assert.match(migration, /language plpgsql stable security definer set search_path = ''/);
  assert.match(migration, /if not public\.tmua_is_manager\(\) then/);
  assert.doesNotMatch(migration, /tmua_read_state_v2\(|\b(?:insert|update|delete)\s+(?:into|from|public\.)/i);
});

test('PostgreSQL: manager reads both empty states without creating account rows', options, async () => {
  const db = await setup(false);
  try {
    const before = await snapshots(db);
    await asUser(db, manager);
    assert.deepEqual(await readProgress(db), noStudent);
    assert.deepEqual(await readProgress(db), noStudent);
    assert.deepEqual(await snapshots(db), before, 'no student creates no progress or backup rows');

    await db.query('insert into public.tmua_members(user_id,role) values ($1, $2)', [student, 'student']);
    const withMember = await snapshots(db);
    await asUser(db, manager);
    assert.deepEqual(await readProgress(db), { ...noStudent, student: { user_id: student } });
    assert.deepEqual(await snapshots(db), withMember, 'uninitialized student remains uninitialized; manager row is not created');
    assert.equal(withMember.tmua_sync_state_v2.length, 0);
  } finally { await db.close(); }
});

test('PostgreSQL: only manager can read the approved student; reads preserve all stored data', options, async () => {
  const db = await setup();
  try {
    for (const [id, label, revision] of [[manager, 'manager', 9], [student, 'student', 12], [outsider, 'outsider', 30]]) {
      const payload = { ...empty, history: { version: 1, attempts: [{ id: `${label}-attempt`, paperKey: '2020-p1', score: revision }] } };
      await db.query(`insert into public.tmua_sync_state_v2(user_id,revision,payload,updated_at,updated_by)
        values ($1,$2,$3,'2026-09-30T12:00:00Z',$1)`, [id, revision, payload]);
      await db.query('insert into public.tmua_sync_backups_v2(user_id,payload) values ($1,$2)', [id, payload]);
    }
    const before = await snapshots(db);
    const saved = before.tmua_sync_state_v2.find(row => row.user_id === student);
    await asUser(db, manager);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await readProgress(db), { student: { user_id: student }, revision: saved.revision, payload: saved.payload, updated_at: saved.updated_at });
    }
    assert.deepEqual((await db.query('select user_id from public.tmua_sync_state_v2')).rows, [{ user_id: manager }], 'direct table reads do not gain cross-account access');
    assert.deepEqual((await db.query('select user_id from public.tmua_sync_backups_v2')).rows, [{ user_id: manager }], 'student backups remain private');
    await forbidden(() => db.query('update public.tmua_sync_state_v2 set revision = 99 where user_id = $1', [student]), 'manager cannot edit student progress');
    await assert.rejects(() => db.query('select public.tmua_read_student_progress($1::uuid)', [outsider]), error => error.code === '42883', 'there is no arbitrary-user overload');

    for (const id of [student, outsider]) {
      await asUser(db, id);
      await assert.rejects(() => readProgress(db), error => error.code === '42501' && error.message.includes('TMUA_MANAGER_REQUIRED'));
    }
    await db.exec("set role anon; set request.jwt.claim.sub = '';");
    await forbidden(() => readProgress(db), 'anonymous execution denied');
    await db.exec(`set request.jwt.claim.sub = '${manager}';`);
    await forbidden(() => readProgress(db), 'anonymous role remains denied even with a claimed manager id');
    assert.deepEqual(await snapshots(db), before, 'successful and denied calls change no payload, revision, timestamps, membership or backup');

    await db.query('delete from public.tmua_members where user_id = $1', [student]);
    await db.query('insert into public.tmua_members(user_id,role) values ($1,$2)', [outsider, 'student']);
    await asUser(db, manager);
    assert.equal((await readProgress(db)).student.user_id, outsider, 'selection follows the current approved student membership');
    assert.equal((await readProgress(db)).revision, 30);
    await db.exec('reset role;');
    await db.query('delete from public.tmua_members where user_id = $1', [manager]);
    await asUser(db, manager);
    await forbidden(() => readProgress(db), 'manager access is revoked immediately with membership');
  } finally { await db.close(); }
});

test('PostgreSQL: incremental manager migration and reinstalls preserve existing rows and write functions', options, async () => {
  const db = await setup(true, true);
  try {
    const studentPayload = { ...empty, library: { 'student-paper': { completed: true } } };
    await db.query('insert into public.tmua_sync_state_v2(user_id,revision,payload) values ($1,7,$2)', [student, studentPayload]);
    await db.query('insert into public.tmua_sync_backups_v2(user_id,payload) values ($1,$2)', [student, studentPayload]);
    const writeDefinitions = async () => (await db.query(`select proname, pg_get_functiondef(oid) as definition from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('tmua_write_state_v2','tmua_save_backup_v2') order by proname`)).rows;
    const definitionsBefore = await writeDefinitions();
    const before = await snapshots(db);
    const migration = await readSql(migrationName);
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(await readSql('schema.sql'));
    await db.exec(migration);
    assert.deepEqual(await writeDefinitions(), definitionsBefore, 'write RPC definitions are unchanged');
    assert.deepEqual(await snapshots(db), before, 'upgrades and reruns leave every existing row unchanged');
    await asUser(db, manager);
    assert.deepEqual((await readProgress(db)).payload, studentPayload);
    assert.deepEqual(await snapshots(db), before, 'first manager read does not initialize manager progress');

    await asUser(db, student);
    const next = { ...empty, library: { 'student-paper': { completed: true, score: 18 } } };
    const written = (await db.query('select public.tmua_write_state_v2(7,$1) as state', [next])).rows[0].state;
    assert.equal(written.revision, 8);
    assert.equal(written.user_id, student);
    await asUser(db, manager);
    const refreshed = await readProgress(db);
    assert.equal(refreshed.revision, 8);
    assert.deepEqual(refreshed.payload, next, 'refresh sees the newer student-owned save');
    const catalog = (await db.query(`select p.provolatile, p.prosecdef, p.proconfig from pg_proc p
      where p.oid = 'public.tmua_read_student_progress()'::regprocedure`)).rows[0];
    assert.equal(catalog.provolatile, 's');
    assert.equal(catalog.prosecdef, true);
    assert.deepEqual(catalog.proconfig, ['search_path=""']);
  } finally { await db.close(); }
});
