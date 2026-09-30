import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Keep the optional embedded database dependency outside this static site's
// dependency tree. Pass its installed ESM entry as TMUA_PGLITE_MODULE.
const modulePath = process.env.TMUA_PGLITE_MODULE;
const readSql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');

test('embedded PostgreSQL: install, reinstall, and execute the real role/constraint suite', {
  skip: modulePath ? false : 'Set TMUA_PGLITE_MODULE to the installed @electric-sql/pglite ESM entry to run database checks.',
}, async () => {
  const { PGlite } = await import(pathToFileURL(modulePath).href);
  const db = new PGlite();
  try {
    await db.exec(await readSql('tests/embedded-fixture.sql'));
    const schema = await readSql('schema.sql');
    await db.exec(schema);
    await db.exec(schema);

    const initial = await db.query('select id, revision::text, payload from public.tmua_sync_state');
    assert.equal(initial.rows.length, 1);
    assert.equal(initial.rows[0].id, 'main');
    assert.equal(initial.rows[0].revision, '0');
    assert.deepEqual(initial.rows[0].payload, {
      version: 1, library: {}, history: { version: 1, attempts: [] }, roadmap: { version: 1, pairs: {} },
    });

    const results = await db.exec(await readSql('tests/rls.sql'));
    assert.ok(results.some(result => result.rows?.some(row => row.result === 'TMUA RLS integration checks passed; test changes rolled back.')));

    const restored = await db.query('select revision::text, payload from public.tmua_sync_state');
    assert.equal(restored.rows[0].revision, '0');
    assert.deepEqual(restored.rows[0].payload, initial.rows[0].payload);
    for (const table of ['auth.users', 'public.tmua_members', 'public.tmua_sync_backups', 'public.tmua_pdf_versions', 'storage.objects']) {
      const count = await db.query(`select count(*)::int as count from ${table}`);
      assert.equal(count.rows[0].count, 0, `${table} test fixtures were rolled back`);
    }
  } finally {
    await db.close();
  }
});
