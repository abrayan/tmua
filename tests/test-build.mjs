import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildSite, discoverPapers, parseMetadata } from '../tools/build-site.mjs';

function metadata(overrides = {}) {
  return { format: 'tmua-paper-v1', id: 'sample-p1', title: 'Sample paper', paper: 1,
    source: 'Test source', description: 'Practice questions.', questionCount: 3, version: 1, ...overrides };
}

function paper(values = {}) {
  return '<!doctype html><html><head><script type="application/json" id="tmua-paper-meta">'
    + JSON.stringify(metadata(values)) + '</script></head><body>Questions</body></html>';
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tmua-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Library</title>');
  return root;
}

async function put(root, filename, contents) {
  await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await writeFile(path.join(root, filename), contents);
}

test('published paper protection allows additions but rejects changing, renaming or removing an existing paper', async t => {
  const root = await fixture(t);
  const href = 'papers/paper-1/first.html';
  const html = paper({questionCount:20});
  await put(root, href, html);
  await put(root, 'content/published-papers.json', JSON.stringify({version:1,papers:[{
    id:'sample-p1', href, sha256:createHash('sha256').update(html).digest('hex')
  }]}));
  await buildSite(root);
  await put(root, 'papers/paper-2/new.html', paper({id:'new-p2',paper:2,questionCount:20}));
  const result = await buildSite(root);
  assert.equal(result.catalog.papers.length,2);
  const previous = await readFile(path.join(root,'dist/papers/catalog.json'),'utf8');
  for (const changed of [html.replace('Questions','Changed answer'),html.replace('sample-p1','renamed-p1')]) {
    await put(root,href,changed);
    await assert.rejects(buildSite(root),/Published paper sample-p1 changed or is missing/);
    assert.equal(await readFile(path.join(root,'dist/papers/catalog.json'),'utf8'),previous);
  }
  await rm(path.join(root,href));
  await assert.rejects(buildSite(root),/Published paper sample-p1 changed or is missing/);
  await put(root,'papers/paper-1/moved.html',html);
  await assert.rejects(buildSite(root),/Published paper sample-p1 changed or is missing/);
});

test('build discovers both paper categories and publishes only website content', async (t) => {
  const root = await fixture(t);
  await put(root, 'papers/paper-1/first.html', paper());
  await put(root, 'papers/paper-2/second.html', paper({ id: 'sample-p2', paper: 2 }));
  await put(root, 'assets/styles.css', 'body { color: #123; }');
  await put(root, 'assets/icons/check.svg', '<svg></svg>');
  await put(root, 'content/private.json', '{}');
  await put(root, 'templates/paper.html', '<p>Template</p>');
  await put(root, 'server.py', '# private development server');
  await put(root, 'papers/paper-2/.gitkeep', '');
  const { catalog, destination } = await buildSite(root);
  assert.deepEqual(catalog.papers.map(({ paper, href }) => ({ paper, href })), [
    { paper: 1, href: 'papers/paper-1/first.html' },
    { paper: 2, href: 'papers/paper-2/second.html' },
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'papers/catalog.json'), 'utf8')), catalog);
  assert.deepEqual((await readdir(destination)).sort(), ['.nojekyll', 'assets', 'index.html', 'papers']);
  assert.equal(await readFile(path.join(destination, 'assets/styles.css'), 'utf8'), 'body { color: #123; }');
  assert.equal(await readFile(path.join(destination, 'assets/icons/check.svg'), 'utf8'), '<svg></svg>');
  assert.equal(await readFile(path.join(destination, 'papers/paper-1/first.html'), 'utf8'), paper());
  assert.deepEqual(catalog.errors, []);
});

test('new standalone HTML appears automatically on the next build', async (t) => {
  const root = await fixture(t);
  await put(root, 'papers/paper-1/first.html', paper());
  assert.equal((await buildSite(root)).catalog.papers.length, 1);
  await put(root, 'papers/paper-2/new.html', paper({ id: 'new-p2', paper: 2 }));
  assert.equal((await buildSite(root)).catalog.papers.length, 2);
  await rm(path.join(root, 'papers/paper-1/first.html'));
  const { catalog, destination } = await buildSite(root);
  assert.equal(catalog.papers.length, 1);
  assert.deepEqual(await readdir(path.join(destination, 'papers/paper-1')), []);
});

test('publishing changed paper and app content refreshes their cache without changing paper identity', async (t) => {
  const root = await fixture(t);
  await put(root, 'index.html', '<link href="assets/site.css" rel="stylesheet"><script src="assets/app.js"></script>');
  await put(root, 'assets/site.css', 'body { color: navy; }');
  await put(root, 'assets/app.js', 'const release = 1;');
  await put(root, 'papers/paper-1/first.html', paper());
  const first = await buildSite(root);
  const firstIndex = await readFile(path.join(first.destination, 'index.html'), 'utf8');
  const original = first.catalog.papers[0];
  assert.match(original.contentHash, /^[a-f0-9]{16}$/);
  assert.match(firstIndex, /assets\/app\.js\?v=[a-f0-9]{16}/);
  assert.match(firstIndex, /assets\/site\.css\?v=[a-f0-9]{16}/);
  assert.equal((await buildSite(root)).catalog.papers[0].contentHash, original.contentHash);
  await put(root, 'papers/paper-1/first.html', paper().replace('Questions', 'Questions and a hint button'));
  await put(root, 'assets/app.js', 'const release = 2;');
  const second = await buildSite(root);
  const updated = second.catalog.papers[0];
  const secondIndex = await readFile(path.join(second.destination, 'index.html'), 'utf8');
  assert.notEqual(updated.contentHash, original.contentHash);
  assert.notEqual(secondIndex, firstIndex);
  assert.equal(updated.id, original.id);
  assert.equal(updated.version, original.version);
  assert.equal(updated.href, original.href);
  assert.equal(firstIndex.match(/assets\/site\.css\?v=[a-f0-9]{16}/)[0], secondIndex.match(/assets\/site\.css\?v=[a-f0-9]{16}/)[0]);
});

test('nested files use encoded relative URLs that work under a hosting subfolder', async (t) => {
  const root = await fixture(t);
  const filename = 'papers/paper-1/Mock set/July #1.html';
  await put(root, filename, paper());
  const { catalog } = await buildSite(root);
  assert.equal(catalog.papers[0].href, 'papers/paper-1/Mock%20set/July%20%231.html');
  assert.equal(new URL(catalog.papers[0].href, 'https://example.org/my-site/').href,
    'https://example.org/my-site/papers/paper-1/Mock%20set/July%20%231.html');
  assert.equal(await readFile(path.join(root, 'dist', filename), 'utf8'), paper());
});

test('an empty library builds with both category folders and no pretend papers', async (t) => {
  const root = await fixture(t);
  const { destination, catalog } = await buildSite(root);
  assert.deepEqual(catalog, { papers: [], errors: [] });
  assert.deepEqual(await readdir(path.join(destination, 'papers/paper-1')), []);
  assert.deepEqual(await readdir(path.join(destination, 'papers/paper-2')), []);
});

test('malformed or missing metadata fails instead of hiding a paper', async (t) => {
  const root = await fixture(t);
  await put(root, 'papers/bad.html', '<script id="tmua-paper-meta" type="application/json">{oops}</script>');
  await assert.rejects(buildSite(root), /bad\.html: paper metadata is not valid JSON/);
  await put(root, 'papers/bad.html', '<html>No metadata</html>');
  await assert.rejects(buildSite(root), /exactly one complete tmua-paper-meta/);
});

test('metadata validates schema, category, ID, and counts', () => {
  for (const overrides of [
    { format: 'unknown' }, { version: 2 }, { version: true }, { id: '../escape' },
    { id: 'Uppercase' }, { id: 'a'.repeat(81) }, { paper: '1' }, { paper: 3 },
    { questionCount: 0 }, { questionCount: 1.5 }, { questionCount: true }, { title: ' ' },
    { title: 'x'.repeat(201) }, { source: null }, { description: '\u0000' },
  ]) assert.throws(() => parseMetadata(paper(overrides)), undefined, JSON.stringify(overrides));
  assert.equal(parseMetadata(paper({ description: '' })).description, '');
  assert.throws(() => parseMetadata(paper().replace('application/json', 'text/javascript')), /application\/json/);
  assert.throws(() => parseMetadata(paper() + paper()), /exactly one/);
  assert.throws(() => parseMetadata(paper() + '<script id="tmua-paper-meta">'), /incomplete/);
});

test('metadata handles attribute order and quotes and ignores HTML comments', () => {
  const html = "<!-- <script id='tmua-paper-meta' type='application/json'>{}</script> -->"
    + "<script id='tmua-paper-meta' type=application/json>"
    + JSON.stringify(metadata({ description: 'Example <!-- preserved -->' })) + '</script>';
  assert.equal(parseMetadata(html).description, 'Example <!-- preserved -->');
});

test('duplicate IDs fail and preserve an earlier successful build', async (t) => {
  const root = await fixture(t);
  await put(root, 'papers/paper-1/original.html', paper());
  const { destination } = await buildSite(root);
  const previous = await readFile(path.join(destination, 'papers/catalog.json'), 'utf8');
  await put(root, 'papers/paper-2/duplicate.html', paper({ paper: 2 }));
  await assert.rejects(buildSite(root), /duplicate paper ID "sample-p1"/);
  assert.equal(await readFile(path.join(destination, 'papers/catalog.json'), 'utf8'), previous);
});

test('folder category mismatch fails the build', async (t) => {
  const root = await fixture(t);
  await put(root, 'papers/paper-2/wrong.html', paper());
  await assert.rejects(discoverPapers(root), /category does not match its folder/);
});

test('symbolic links cannot publish files outside the website', async (t) => {
  const root = await fixture(t);
  await put(root, 'papers/paper-1/original.html', paper());
  await symlink(path.join(root, 'index.html'), path.join(root, 'papers/paper-1/linked.html'));
  await assert.rejects(buildSite(root), /symbolic links are not supported/);
});
