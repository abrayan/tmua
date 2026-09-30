import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

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

const pdfPair = (overrides = {}) => {
  const pairId = randomUUID();
  return [1, 2].map(paper => ({
    pair_id: pairId, paper_number: paper, document_key: '2026-practice', title: '2026 practice',
    filename: `paper-${paper}.pdf`, object_path: `${randomUUID()}.pdf`,
    sha256: String(paper).repeat(64), bytes: 100 + paper, created_by: manager,
    ...overrides,
  }));
};
// The JSON array is expanded into one INSERT, as PostgREST does for bulk inserts.
const insertPdfs = (db, rows) => db.query(`
  insert into public.tmua_pdf_versions
    (pair_id,paper_number,document_key,title,filename,object_path,sha256,bytes,created_by)
  select pair_id,paper_number,document_key,title,filename,object_path,sha256,bytes,created_by
  from jsonb_to_recordset($1::jsonb) as pdf(
    pair_id uuid, paper_number smallint, document_key text, title text, filename text,
    object_path text, sha256 text, bytes bigint, created_by uuid)
  returning *`, [JSON.stringify(rows)]);
const pdfRows = async db => (await db.query('select * from public.tmua_pdf_versions order by id')).rows;
const rejectsCode = async (operation, code, message) => assert.rejects(operation, error => error.code === code, message);

test('embedded PostgreSQL: PDF pairs commit atomically and reject incomplete, duplicate or mismatched papers', options, async () => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  try {
    await db.exec(await readSql('tests/embedded-fixture.sql'));
    await db.exec(await readSql('schema.sql'));
    await db.exec(`insert into auth.users(id) values ('${manager}'), ('${student}');
      insert into public.tmua_members(user_id,role) values ('${manager}','manager'), ('${student}','student');`);
    await asUser(db, manager);

    await rejectsCode(() => insertPdfs(db, pdfPair().slice(0, 1)), '23514', 'standalone Paper 1 rolls back at commit');
    await rejectsCode(() => insertPdfs(db, pdfPair().slice(1)), '23514', 'standalone Paper 2 rolls back at commit');
    for (const missing of [{ pair_id: null }, { paper_number: null }, { pair_id: null, paper_number: null }]) {
      await rejectsCode(() => insertPdfs(db, pdfPair(missing)), '23514', 'new rows cannot use nullable legacy fields');
    }
    await rejectsCode(() => db.query(`insert into public.tmua_pdf_versions(document_key,title,filename,object_path,sha256,bytes)
      values ('unpaired','Unpaired','one.pdf',$1,$2,100)`, [`${randomUUID()}.pdf`, 'a'.repeat(64)]),
    '23514', 'old single-file clients are rejected when they omit both pair fields');
    assert.equal((await pdfRows(db)).length, 0);

    // The deferred check accepts the first row provisionally, then rejects the
    // entire transaction when the caller tries to commit without Paper 2.
    await db.exec('begin;');
    await insertPdfs(db, pdfPair().slice(0, 1));
    assert.equal((await pdfRows(db)).length, 1);
    await rejectsCode(() => db.exec('commit;'), '23514', 'missing partner fails at the transaction boundary');
    await db.exec('rollback;');
    assert.equal((await pdfRows(db)).length, 0);

    const valid = pdfPair();
    const committed = await db.transaction(async tx => (await insertPdfs(tx, valid)).rows);
    assert.equal(committed.length, 2, 'one JSON array inserts both papers');
    const before = await pdfRows(db);
    assert.equal(before.length, 2);
    assert.deepEqual(before.map(row => row.paper_number).sort(), [1, 2]);
    assert.ok(before.every(row => row.pair_id === valid[0].pair_id && row.created_by === manager));

    const duplicateNumber = pdfPair();
    duplicateNumber[1].paper_number = 1;
    await rejectsCode(() => insertPdfs(db, duplicateNumber), '23505', 'duplicate paper numbers reject the entire array');
    for (const [field, value] of [['paper_number', 3], ['sha256', '1'.repeat(64)], ['document_key', 'different'], ['title', 'Different title'], ['pair_id', randomUUID()]]) {
      const invalid = pdfPair();
      invalid[1][field] = value;
      await rejectsCode(() => insertPdfs(db, invalid), '23514', `mismatched ${field} rejects the entire array`);
    }
    const extra = pdfPair({ pair_id: valid[0].pair_id });
    await rejectsCode(() => insertPdfs(db, extra.slice(0, 1)), '23505', 'an existing pair cannot gain another row');
    await rejectsCode(() => insertPdfs(db, extra), '23505', 'a pair UUID cannot be reused for a new version');
    const three = pdfPair();
    three.push({ ...three[0], object_path: `${randomUUID()}.pdf` });
    await rejectsCode(() => insertPdfs(db, three), '23505', 'a third paper cannot be committed');
    assert.deepEqual(await pdfRows(db), before, 'failed requests leave every existing row unchanged');

    // Trusted inserts bypass RLS, but still must share a creator (including null).
    await db.exec('reset role;');
    for (const creator of [student, null]) {
      const invalid = pdfPair();
      invalid[1].created_by = creator;
      await rejectsCode(() => insertPdfs(db, invalid), '23514', 'pair creators must match even for a trusted insert');
    }
    assert.deepEqual(await pdfRows(db), before);
  } finally { await db.close(); }
});

test('embedded PostgreSQL: pair migration retains legacy PDFs, reruns safely, and preserves manager-only immutable access', options, async () => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  try {
    await db.exec(await readSql('tests/embedded-fixture.sql'));
    await db.exec(await readSql('migrations/20260930_account_progress_v2.sql'));
    await db.exec(`insert into auth.users(id) values ('${manager}'), ('${student}');
      insert into public.tmua_members(user_id,role) values ('${manager}','manager'), ('${student}','student');`);
    await db.query(`insert into public.tmua_pdf_versions(document_key,title,filename,object_path,sha256,bytes,created_by)
      values ('legacy','Legacy PDF','legacy.pdf',$1,$2,50,$3)`, [`${randomUUID()}.pdf`, 'a'.repeat(64), manager]);
    const legacyBefore = (await pdfRows(db)).map(row => ({ ...row, pair_id: null, paper_number: null }));
    const migration = await readSql('migrations/20260930_required_pdf_pairs.sql');
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual(await pdfRows(db), legacyBefore, 'all legacy metadata is preserved; no pair is invented');

    await asUser(db, manager);
    assert.deepEqual(await pdfRows(db), legacyBefore, 'manager retains read access to the legacy entry');
    await insertPdfs(db, pdfPair());
    const before = await pdfRows(db);
    assert.equal(before.length, 3);
    await rejectsCode(() => db.query("update public.tmua_pdf_versions set title = 'Changed'"), '42501', 'manager cannot rewrite metadata');
    await rejectsCode(() => db.query('delete from public.tmua_pdf_versions'), '42501', 'manager cannot remove a paper');
    await rejectsCode(() => insertPdfs(db, pdfPair({ created_by: student })), '42501', 'manager cannot spoof a pair creator');
    for (const name of ['tmua_require_pdf_pair', 'tmua_check_pdf_pair']) {
      await rejectsCode(() => db.query(`select public.${name}()`), '42501', 'pair validation functions are not public RPC entry points');
    }

    await asUser(db, student);
    assert.deepEqual(await pdfRows(db), [], 'student cannot read PDF metadata');
    await rejectsCode(() => insertPdfs(db, pdfPair({ created_by: student })), '42501', 'student cannot insert a valid pair');
    await db.exec("set role anon; set request.jwt.claim.sub = '';");
    await rejectsCode(() => db.query('select * from public.tmua_pdf_versions'), '42501', 'anonymous users cannot read PDF metadata');
    await rejectsCode(() => insertPdfs(db, pdfPair()), '42501', 'anonymous users cannot insert a valid pair');
    await asUser(db, '99999999-9999-4999-8999-999999999999');
    assert.deepEqual(await pdfRows(db), [], 'non-members cannot read PDF metadata');
    await rejectsCode(() => insertPdfs(db, pdfPair()), '42501', 'non-members cannot insert a valid pair');

    await db.exec('reset role;');
    await db.exec(migration);
    await db.exec(await readSql('schema.sql'));
    await db.exec(migration);
    assert.deepEqual(await pdfRows(db), before, 'repeated migration and full schema preserve legacy and paired rows exactly');
    const constraints = await db.query(`select condeferrable, condeferred from pg_constraint
      where conname = 'tmua_pdf_pair_complete' and conrelid = 'public.tmua_pdf_versions'::regclass`);
    assert.deepEqual(constraints.rows, [{ condeferrable: true, condeferred: true }], 'reinstallation retains one deferred pair constraint');
  } finally { await db.close(); }
});
