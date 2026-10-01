import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Synthetic users, metadata and storage rows only. This never connects to Supabase.
const modulePath = process.env.TMUA_PGLITE_MODULE;
const options = { skip: modulePath ? false : 'Set TMUA_PGLITE_MODULE to exercise PostgreSQL policies.' };
const readSql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const manager = '77777777-7777-4777-8777-777777777777';
const student = '88888888-8888-4888-8888-888888888888';
const outsider = '99999999-9999-4999-8999-999999999999';
const migrationName = 'migrations/20261001_private_guided_editions.sql';
const asUser = (db, id) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
const rejectsCode = (operation, code, message) => assert.rejects(operation, error => error.code === code, message);
const makePair = (pairId = 'synthetic-a', editionId = 'review-1') => [1, 2].map(number => {
  const id = `${pairId}-p${number}`;
  return {
    paper_id: id, edition_id: editionId, pair_id: pairId, paper_number: number,
    object_path: `${id}/${editionId}.html`, sha256: String(number).repeat(64),
    metadata: {
      visibility: 'private', format: 'tmua-paper-v1', id, pairId, paper: number, version: 1,
      title: `Synthetic A · Paper ${number}`, source: 'Synthetic private fixture',
      description: 'Schema test only.', questionCount: 20, practicePolicy: 'after-miss-up-to-3',
    },
    concept_mapping: {
      versionId: `private-${pairId}-${editionId}`, sha256: String(number + 2).repeat(64),
      paper: {
        id, paper: number, title: `Synthetic A · Paper ${number}`, version: 1, contentRevisions: [2],
        questions: Array.from({ length: 20 }, (_, index) => ({
          sourceId: `SYNTHETIC-P${number}-Q${index + 1}`,
          canonicalSourceId: `SYNTHETIC-P${number}-Q${index + 1}`,
          knowledgePattern: 'Synthetic arithmetic check', lessonIds: [`p${number}-b1-l01`],
        })),
      },
    },
  };
});
const objects = async (db, rows) => {
  for (const row of rows) await db.query("insert into storage.objects(bucket_id,name,metadata) values ('tmua-guided',$1,$2)", [row.object_path, { mimetype: 'text/html', size: 100 }]);
};
const publish = (db, rows) => db.query(`insert into public.tmua_guided_editions
  (paper_id,edition_id,pair_id,paper_number,object_path,sha256,metadata,concept_mapping)
  select paper_id,edition_id,pair_id,paper_number,object_path,sha256,metadata,concept_mapping
  from jsonb_to_recordset($1::jsonb) as edition(paper_id text,edition_id text,pair_id text,
    paper_number smallint,object_path text,sha256 text,metadata jsonb,concept_mapping jsonb)
  returning *`, [JSON.stringify(rows)]);
const list = async db => (await db.query('select * from public.tmua_guided_editions order by paper_id,edition_id')).rows;
const fixture = async () => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  await db.exec(await readSql('tests/embedded-fixture.sql'));
  await db.exec(await readSql('schema.sql'));
  await db.exec(`insert into auth.users(id) values ('${manager}'),('${student}'),('${outsider}');
    insert into public.tmua_members(user_id,role) values ('${manager}','manager'),('${student}','student');`);
  await db.exec(await readSql(migrationName));
  return db;
};

test('private guided schema: only existing members can read published metadata and HTML objects', options, async () => {
  const db = await fixture();
  try {
    const pair = makePair();
    await objects(db, pair);
    await objects(db, makePair('unpublished'));
    await publish(db, pair);
    for (const member of [student, manager]) {
      await asUser(db, member);
      assert.equal((await list(db)).length, 2);
      assert.deepEqual((await db.query("select name from storage.objects where bucket_id='tmua-guided' order by name")).rows.map(row => row.name), pair.map(row => row.object_path));
      await rejectsCode(() => publish(db, makePair('client-write')), '42501');
      await rejectsCode(() => db.exec("update public.tmua_guided_editions set sha256=repeat('0',64)"), '42501');
      await rejectsCode(() => db.exec('delete from public.tmua_guided_editions'), '42501');
      await rejectsCode(() => objects(db, makePair('client-upload')), '42501');
      assert.equal((await db.query("update storage.objects set metadata='{}' where bucket_id='tmua-guided' returning name")).rows.length, 0);
      assert.equal((await db.query("delete from storage.objects where bucket_id='tmua-guided' returning name")).rows.length, 0);
    }
    await asUser(db, outsider);
    assert.deepEqual(await list(db), []);
    assert.equal((await db.query("select * from storage.objects where bucket_id='tmua-guided'")).rows.length, 0);
    await rejectsCode(() => publish(db, makePair('outsider-write')), '42501');
    await db.exec("set role anon; set request.jwt.claim.sub='';");
    await rejectsCode(() => list(db), '42501');
    assert.equal((await db.query("select * from storage.objects where bucket_id='tmua-guided'")).rows.length, 0);
    await db.exec('reset role;');
    assert.equal((await list(db)).length, 2);
    assert.equal((await db.query("select count(*)::int as n from storage.objects where bucket_id='tmua-guided'")).rows[0].n, 4);
  } finally { await db.close(); }
});

test('private guided schema: incomplete releases roll back; complete releases are atomic and pin both maps', options, async () => {
  const db = await fixture();
  try {
    const pair = makePair();
    await objects(db, pair);
    await rejectsCode(() => publish(db, pair.slice(0, 1)), '23514', 'Paper 1 cannot be committed alone');
    await rejectsCode(() => publish(db, pair.slice(1)), '23514', 'Paper 2 cannot be committed alone');
    assert.deepEqual(await list(db), []);
    await db.exec('begin;');
    await publish(db, pair.slice(0, 1));
    assert.equal((await list(db)).length, 1, 'deferred check allows partner within same transaction');
    await publish(db, pair.slice(1));
    await db.exec('commit;');
    const saved = await list(db);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].created_at.valueOf(), saved[1].created_at.valueOf());
    assert.equal(saved[0].concept_mapping.versionId, saved[1].concept_mapping.versionId);
    await rejectsCode(() => publish(db, pair), '23505', 'a released edition cannot be appended again');
    for (const [field, mutate] of [
      ['pair', rows => { rows[1].pair_id = 'other'; rows[1].metadata.pairId = 'other'; }],
      ['edition', rows => { rows[1].edition_id = 'other'; rows[1].object_path = `${rows[1].paper_id}/other.html`; }],
      ['mapping-version', rows => { rows[1].concept_mapping.versionId = 'other-version'; }],
      ['duplicate-html', rows => { rows[1].sha256 = rows[0].sha256; }],
    ]) {
      const invalid = makePair(`invalid-${field}`); mutate(invalid);
      await objects(db, invalid);
      await rejectsCode(() => publish(db, invalid), '23514', `${field} mismatch blocks both rows`);
    }
    const unavailable = makePair('missing-object');
    await objects(db, unavailable.slice(0, 1));
    await rejectsCode(() => publish(db, unavailable), '23514', 'both stored objects must exist before release');
    assert.deepEqual(await list(db), saved);
  } finally { await db.close(); }
});

test('private guided schema: malformed identities, metadata and concept maps cannot be published', options, async () => {
  const db = await fixture();
  try {
    for (const [label, mutate] of [
      ['metadata-id', r => { r.metadata.id = 'wrong'; }],
      ['metadata-url', r => { r.metadata.href = 'https://example.test/secret.html'; }],
      ['missing-paper', r => { delete r.metadata.paper; }],
      ['missing-visibility', r => { delete r.metadata.visibility; }],
      ['wrong-total', r => { r.metadata.questionCount = 19; }],
      ['short-sha', r => { r.sha256 = '123'; }],
      ['mapping-id', r => { r.concept_mapping.paper.id = 'wrong'; }],
      ['mapping-size', r => { r.concept_mapping.paper.questions.pop(); }],
      ['mapping-null', r => { r.concept_mapping = null; }],
      ['mapping-shape', r => { r.concept_mapping.paper.questions = 'wrong'; }],
      ['repeated-question', r => { r.concept_mapping.paper.questions[1] = r.concept_mapping.paper.questions[0]; }],
      ['no-concept', r => { r.concept_mapping.paper.questions[0].lessonIds = []; }],
      ['unknown-concept-format', r => { r.concept_mapping.paper.questions[0].lessonIds = ['anything']; }],
      ['bad-revision', r => { r.concept_mapping.paper.contentRevisions = [0]; }],
      ['bad-path', r => { r.object_path = `${r.paper_id}/other.html`; }],
      ['reserved-edition', r => { r.edition_id = 'original'; r.object_path = `${r.paper_id}/original.html`; }],
    ]) {
      const pair = makePair(`invalid-${label}`);
      mutate(pair[0]);
      await objects(db, pair);
      await rejectsCode(() => publish(db, pair), label === 'mapping-null' ? '23502' : '23514', label);
      assert.deepEqual(await list(db), [], `${label} leaves no release rows`);
    }
    await rejectsCode(() => db.query("insert into storage.objects(bucket_id,name) values('tmua-guided','../escape.html')"), '23514');
    await rejectsCode(() => db.query("insert into storage.objects(bucket_id,name) values('tmua-guided','paper/file.pdf')"), '23514');
    const bucket = (await db.query("select public,file_size_limit,allowed_mime_types from storage.buckets where id='tmua-guided'")).rows[0];
    assert.deepEqual(bucket, { public: false, file_size_limit: 15728640, allowed_mime_types: ['text/html'] });
  } finally { await db.close(); }
});

test('private guided schema: trusted worker inserts pairs but neither worker nor owner can overwrite a release', options, async () => {
  const db = await fixture();
  try {
    const pair = makePair();
    await db.exec('set role service_role;');
    await objects(db, pair);
    await publish(db, pair);
    const first = await list(db);
    await rejectsCode(() => db.exec("update public.tmua_guided_editions set sha256=repeat('f',64)"), '42501');
    await rejectsCode(() => db.exec('delete from public.tmua_guided_editions'), '42501');
    for (const sql of [
      "update storage.objects set metadata='{}' where bucket_id='tmua-guided'",
      "delete from storage.objects where bucket_id='tmua-guided'",
      "update storage.objects set bucket_id='tmua-pdfs' where bucket_id='tmua-guided'",
    ]) await rejectsCode(() => db.exec(sql), '55000');
    await db.exec('reset role;');
    await rejectsCode(() => db.exec("update public.tmua_guided_editions set sha256=repeat('f',64)"), '55000');
    await rejectsCode(() => db.exec('delete from public.tmua_guided_editions'), '55000');
    const next = makePair('synthetic-a', 'review-2');
    next[0].concept_mapping.paper.questions[0].lessonIds = ['p1-extra-domain'];
    await objects(db, next);
    await publish(db, next);
    const all = await list(db);
    assert.equal(all.length, 4);
    assert.deepEqual(all.filter(row => row.edition_id === 'review-1'), first);
    assert.deepEqual(all.find(row => row.paper_id === next[0].paper_id && row.edition_id === 'review-2').concept_mapping, next[0].concept_mapping);
  } finally { await db.close(); }
});

test('private guided schema: later editions preserve paper identities and ordered original question IDs', options, async () => {
  const db = await fixture();
  try {
    const original = makePair();
    await objects(db, original); await publish(db, original);
    const saved = await list(db);
    for (const [label, mutate] of [
      ['title', r => { r.metadata.title = 'Different paper'; }],
      ['source', r => { r.metadata.source = 'Different source'; }],
      ['question-order', r => { r.concept_mapping.paper.questions.reverse(); }],
      ['canonical-identity', r => { r.concept_mapping.paper.questions[0].canonicalSourceId = 'DIFFERENT-Q1'; }],
      ['pair-reassigned', r => { r.pair_id = 'different-pair'; r.metadata.pairId = r.pair_id; }],
      ['id-reassigned', r => { r.paper_id = 'different-id'; r.metadata.id = r.paper_id; r.concept_mapping.paper.id = r.paper_id; r.object_path = `${r.paper_id}/${r.edition_id}.html`; }],
    ]) {
      const next = makePair('synthetic-a', `review-${label}`); mutate(next[0]);
      await objects(db, next);
      await rejectsCode(() => publish(db, next), '23514', label);
      assert.deepEqual(await list(db), saved);
    }
    const changedMap = makePair('synthetic-a', 'review-reused-mapping');
    for (const row of changedMap) row.concept_mapping.versionId = original[0].concept_mapping.versionId;
    changedMap[0].concept_mapping.paper.questions[0].lessonIds = ['p1-extra-new-concept'];
    await objects(db, changedMap);
    await rejectsCode(() => publish(db, changedMap), '23514', 'a frozen mapping version cannot receive changed concepts');
    const mappingCollision = makePair('different-exam', 'review-collision');
    for (const row of mappingCollision) row.concept_mapping.versionId = original[0].concept_mapping.versionId;
    await objects(db, mappingCollision);
    await rejectsCode(() => publish(db, mappingCollision), '23514', 'mapping version namespace cannot be reused by another pair');
    assert.deepEqual(await list(db), saved);
  } finally { await db.close(); }
});

test('private guided schema: repeated migration preserves releases, memberships and existing account data', options, async () => {
  const db = await fixture();
  try {
    const pair = makePair(); await objects(db, pair); await publish(db, pair);
    const payload = { version: 1, library: {}, history: { version: 1, attempts: [{ id: 'existing-private-attempt', paperId: pair[0].paper_id }] }, roadmap: { version: 1, pairs: {} } };
    await asUser(db, student);
    await db.query('select public.tmua_write_state_v2(0,$1)', [payload]);
    await db.exec('reset role;');
    const tables = ['tmua_members', 'tmua_sync_state_v2', 'tmua_sync_backups_v2', 'tmua_pdf_versions', 'tmua_guided_editions'];
    const before = {};
    for (const table of tables) before[table] = (await db.query(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`)).rows;
    const stored = (await db.query('select * from storage.objects order by name')).rows;
    const sourceBucket = (await db.query("select * from storage.buckets where id='tmua-pdfs'")).rows;
    await db.exec(await readSql(migrationName));
    await db.exec(await readSql('schema.sql'));
    await db.exec(await readSql(migrationName));
    const existingSuite = await db.exec(await readSql('tests/rls.sql'));
    assert.ok(existingSuite.some(result => result.rows?.some(row => row.result === 'TMUA RLS integration checks passed; test changes rolled back.')),
      'existing account and manager-only PDF isolation suite still passes with the new migration installed');
    for (const table of tables) assert.deepEqual((await db.query(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`)).rows, before[table], table);
    assert.deepEqual((await db.query('select * from storage.objects order by name')).rows, stored);
    assert.deepEqual((await db.query("select * from storage.buckets where id='tmua-pdfs'")).rows, sourceBucket);
    const constraint = (await db.query("select condeferrable,condeferred from pg_constraint where conname='tmua_guided_complete_pair'")).rows;
    assert.deepEqual(constraint, [{ condeferrable: true, condeferred: true }]);
    await db.exec(`delete from public.tmua_members where user_id='${student}';`);
    await asUser(db, student);
    assert.deepEqual(await list(db), [], 'membership revocation removes private catalog access');
    assert.equal((await db.query("select * from storage.objects where bucket_id='tmua-guided'")).rows.length, 0, 'membership revocation removes private object access');
  } finally { await db.close(); }
});
