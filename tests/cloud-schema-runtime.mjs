import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Keep the optional embedded database dependency outside this static site's
// dependency tree. Pass its installed ESM entry as TMUA_PGLITE_MODULE.
const modulePath = process.env.TMUA_PGLITE_MODULE;
const readSql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const empty = { version: 1, library: {}, history: { version: 1, attempts: [] }, roadmap: { version: 1, pairs: {} } };
const options = { skip: modulePath ? false : 'Set TMUA_PGLITE_MODULE to run the real PostgreSQL account-isolation checks.' };
const manager = '77777777-7777-4777-8777-777777777777';
const student = '88888888-8888-4888-8888-888888888888';
const asUser = async (db, id) => {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
};
const readAccount = async db => (await db.query('select public.tmua_read_state_v2() as state')).rows[0].state;
const suite = async db => {
  const results = await db.exec(await readSql('tests/rls.sql'));
  assert.ok(results.some(result => result.rows?.some(row => row.result === 'TMUA RLS integration checks passed; test changes rolled back.')));
};

test('embedded PostgreSQL: fresh/repeated install and real account isolation/constraint suite', options, async () => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  try {
    await db.exec(await readSql('tests/embedded-fixture.sql'));
    const schema = await readSql('schema.sql');
    await db.exec(schema);
    await db.exec(schema);
    await suite(db);
    for (const table of ['auth.users', 'public.tmua_members', 'public.tmua_sync_state', 'public.tmua_sync_backups', 'public.tmua_sync_state_v2', 'public.tmua_sync_backups_v2', 'public.tmua_pdf_versions', 'storage.objects']) {
      const count = await db.query(`select count(*)::int as count from ${table}`);
      assert.equal(count.rows[0].count, 0, `${table} fixtures rolled back; no shared row is created`);
    }
  } finally { await db.close(); }
});

test('embedded PostgreSQL: migration preserves the unattributed archive and existing account rows on reruns', options, async () => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  const legacy = { ...empty, history: { version: 1, attempts: [{ id: 'shared-legacy-attempt', paperKey: '2020-p1', total: 20 }] } };
  try {
    await db.exec(await readSql('tests/embedded-fixture.sql'));
    await db.exec(await readSql('tests/legacy-shared-schema.sql'));
    await db.exec(`insert into auth.users(id) values ('${manager}'), ('${student}');
      insert into public.tmua_members(user_id, role) values ('${manager}', 'manager'), ('${student}', 'student');`);
    await db.query('update public.tmua_sync_state set revision = 17, payload = $1, updated_by = $2 where id = \'main\'', [legacy, manager]);
    await db.query('insert into public.tmua_sync_backups(payload,created_by) values ($1,$2),($1,$3)', [legacy, manager, student]);
    const before = (await db.query('select * from public.tmua_sync_state')).rows;
    const backupsBefore = (await db.query('select * from public.tmua_sync_backups order by id')).rows;
    const migration = await readSql('migrations/20260930_account_progress_v2.sql');
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from public.tmua_sync_state')).rows, before);
    assert.deepEqual((await db.query('select * from public.tmua_sync_backups order by id')).rows, backupsBefore);
    assert.equal((await db.query('select count(*)::int as count from public.tmua_sync_state_v2')).rows[0].count, 0, 'migration assigns no legacy work');

    for (const [id, label] of [[manager, 'manager'], [student, 'student']]) {
      await asUser(db, id);
      const fresh = await readAccount(db);
      assert.equal(fresh.user_id, id);
      assert.equal(fresh.revision, 0);
      assert.deepEqual(fresh.payload, empty);
      const own = { ...empty, history: { version: 1, attempts: [1, 2].map(number => ({ id: `${label}-attempt-${number}`, paperKey: '2020-p1', attemptNumber: number, total: 20, state: { completed: number === 1 } })) } };
      const write = await db.query('select public.tmua_write_state_v2(0, $1) as state', [own]);
      assert.equal(write.rows[0].state.revision, 1);
      assert.equal(write.rows[0].state.user_id, id);
      await db.query('select public.tmua_save_backup_v2($1)', [own]);
      assert.deepEqual((await readAccount(db)).payload, own);
      await db.exec('reset role;');
    }
    const accountsBefore = (await db.query('select * from public.tmua_sync_state_v2 order by user_id')).rows;
    const privateBackupsBefore = (await db.query('select * from public.tmua_sync_backups_v2 order by id')).rows;
    await db.exec(await readSql('schema.sql'));
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from public.tmua_sync_state_v2 order by user_id')).rows, accountsBefore, 'reinstall preserves each account payload, revision and timestamps');
    assert.deepEqual((await db.query('select * from public.tmua_sync_backups_v2 order by id')).rows, privateBackupsBefore, 'reinstall preserves private backups');
    assert.deepEqual((await db.query('select * from public.tmua_sync_state')).rows, before, 'legacy shared row remains unchanged');
    assert.deepEqual((await db.query('select * from public.tmua_sync_backups order by id')).rows, backupsBefore);
    await suite(db);
    assert.deepEqual((await db.query('select * from public.tmua_sync_state_v2 order by user_id')).rows, accountsBefore, 'integration suite rolls back all test changes');
  } finally { await db.close(); }
});
