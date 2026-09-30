import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';

const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require(process.env.TMUA_PLAYWRIGHT_PATH || 'playwright')); } catch (_) {}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = await readFile(path.join(root, 'assets/roadmap.js'), 'utf8');
const css = await readFile(path.join(root, 'assets/roadmap.css'), 'utf8');
const siteCss = await readFile(path.join(root, 'assets/site.css'), 'utf8');
const fixture = {version: 1, pairs: Array.from({length: 14}, (_, i) => ({
  id: `pair-${i+1}`, title: i === 0 ? 'TMUA early specimen' : `TMUA pair ${i+1}`,
  focus: 'Connect your methods, check your reasoning and review your corrections.',
  papers: [1, 2].map(paper => ({paper, label: `Paper ${paper}`,
    href: `assets/bank/pair-${i+1}-paper-${paper}.pdf`,
    interactiveId: i === 0 && paper === 2 ? 'tmua-2020-p2' : null}))
}))};
const externalFixture = structuredClone(fixture);
['jz_exam_c', 'jz_exam_d', 'tyler_exam_a'].forEach((exam, index) => {
  externalFixture.pairs.push({
    id: `pair-${15 + index}`, title: ['JZ Exam Set C', 'JZ Exam Set D', 'Tyler Exam Set A'][index],
    focus: 'Work through both papers and review your answers.',
    papers: [1, 2].map(paper => ({paper, label: `Paper ${paper}`, kind: 'external', provider: 'JZMaths',
      href: `https://jzmaths.com/simulator/${exam}_p${paper}`, interactiveId: null}))
  });
});
externalFixture.comingSoon = [{title: 'Tyler Exam Set B', note: 'Available after its release on JZMaths.'}];
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roadmap test</title>
<link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/roadmap.css">
<main><div id="library-view" class="library-view"><section id="roadmap-section"></section></div></main>
<script defer src="assets/roadmap.js"></script>`;
let browser;
before(async () => { if (chromium) browser = await chromium.launch({headless: true}); });
after(async () => { await browser?.close(); });

async function harness({blockedStorage = false, initialData = fixture} = {}) {
  const context = await browser.newContext({viewport: {width: 1100, height: 900}});
  let data = initialData;
  const errors = [];
  if (blockedStorage) await context.addInitScript(() => {
    Storage.prototype.setItem = function () { throw new DOMException('Storage unavailable', 'QuotaExceededError'); };
  });
  await context.route('http://roadmap.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/assets/roadmap.js')) return route.fulfill({contentType: 'text/javascript; charset=utf-8', body: js});
    if (pathname.endsWith('/assets/roadmap.css')) return route.fulfill({contentType: 'text/css; charset=utf-8', body: css});
    if (pathname.endsWith('/assets/site.css')) return route.fulfill({contentType: 'text/css; charset=utf-8', body: siteCss});
    if (pathname.endsWith('/assets/roadmap.json')) return route.fulfill({contentType: 'application/json', body: JSON.stringify(data)});
    if (pathname.endsWith('.pdf')) return route.fulfill({contentType: 'application/pdf', body: '%PDF-1.7\n'});
    return route.fulfill({contentType: 'text/html', body: html});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://roadmap.test/study/');
  await page.waitForFunction(() => !document.getElementById('roadmap-section').hasAttribute('aria-busy'));
  return {context, page, errors, setData(value) {data = value;}};
}

async function record(page, paper, score, attempt, pair = 1) {
  const panel = page.locator(`#roadmap-stage-pair-${pair} .roadmap-paper-${paper}`);
  const details = panel.locator('details');
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
  await panel.locator('input[name="score"]').fill(String(score));
  if (attempt !== undefined) await panel.locator('select').selectOption(attempt);
  await panel.locator('button[type="submit"]').click();
}

test('all papers are accessible and manual records require both scores plus review', {skip: !chromium}, async () => {
  const {context, page, errors} = await harness();
  try {
    assert.equal(await page.locator('.roadmap-stage:visible').count(), 3);
    assert.equal(await page.locator('.roadmap-stage.is-next').getAttribute('id'), 'roadmap-stage-pair-1');
    assert.match(await page.locator('.roadmap-current').innerText(), /Stage 1 · TMUA early specimen/);
    assert.equal(await page.locator('.roadmap-open').count(), 28);
    assert.equal(await page.locator('.roadmap-open[target="_blank"][rel="noopener noreferrer"]').count(), 28);
    assert.equal(await page.locator('.roadmap-guided').getAttribute('href'), '#paper/tmua-2020-p2');
    await page.locator('#roadmap-toggle').click();
    assert.equal(await page.locator('.roadmap-stage:visible').count(), 14);
    assert.equal(new Set(await page.locator('.roadmap-open').evaluateAll(links => links.map(link => link.href))).size, 28);
    await page.evaluate(() => localStorage.setItem('tmua-practice-library-v1:/study/', '{"untouched":true}'));
    await record(page, 1, 0, 'first');
    assert.equal(await page.locator('#roadmap-review-pair-1').isDisabled(), true);
    assert.equal(await page.locator('.roadmap-stage.is-reviewed').count(), 0);
    await record(page, 2, 19, 'practised');
    assert.equal(await page.locator('#roadmap-review-pair-1').isDisabled(), false);
    assert.equal(await page.locator('.roadmap-stage.is-reviewed').count(), 0);
    await page.locator('#roadmap-review-pair-1').check();
    assert.equal(await page.locator('.roadmap-stage.is-next').getAttribute('id'), 'roadmap-stage-pair-2');
    assert.match(await page.locator('.roadmap-count').innerText(), /^1 of 14/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tmua-paired-roadmap-v1:/study/')));
    assert.equal(stored.pairs['pair-1'].papers[1].score, 0, 'zero is a recorded score');
    assert.equal(stored.pairs['pair-1'].papers[1].context, 'first');
    assert.equal(stored.pairs['pair-1'].papers[2].context, 'practised');
    assert.equal(stored.pairs['pair-1'].reviewed, true);
    assert.equal(await page.evaluate(() => localStorage.getItem('tmua-practice-library-v1:/study/')), '{"untouched":true}');
    await page.reload();
    await page.waitForSelector('.roadmap-stage');
    assert.equal(await page.locator('#roadmap-review-pair-1').isChecked(), true);
    assert.match(await page.locator('#roadmap-stage-pair-1 .roadmap-paper-1 summary').innerText(), /0\/20.*First attempt.*Manual record/s);
    await record(page, 1, 1, 'first');
    assert.equal(await page.locator('#roadmap-review-pair-1').isChecked(), false, 'a changed score requires a fresh review');
    const p2 = page.locator('#roadmap-stage-pair-1 .roadmap-paper-2');
    await p2.locator('summary').click();
    await p2.locator('.roadmap-clear').click();
    assert.equal(await page.locator('#roadmap-review-pair-1').isDisabled(), true);
    const beforeInvalid = await page.evaluate(() => localStorage.getItem('tmua-paired-roadmap-v1:/study/'));
    for (const invalid of ['21', '-1', '1.5', '']) await record(page, 2, invalid, 'first');
    assert.equal(await page.evaluate(() => localStorage.getItem('tmua-paired-roadmap-v1:/study/')), beforeInvalid);
    await record(page, 2, 20, '');
    assert.equal(await page.evaluate(() => localStorage.getItem('tmua-paired-roadmap-v1:/study/')), beforeInvalid, 'attempt context must be chosen');
    await record(page, 2, 20, 'practised');
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page does not overflow horizontally');
    assert.equal(await page.locator('.roadmap-paper-pair').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1);
    if (process.env.TMUA_ROADMAP_SCREENSHOT) await page.screenshot({path: process.env.TMUA_ROADMAP_SCREENSHOT, fullPage: true});
    const other = await context.newPage();
    await other.goto('http://roadmap.test/other/');
    await other.waitForSelector('.roadmap-stage');
    assert.equal(await other.locator('.roadmap-stage.is-reviewed').count(), 0);
    assert.equal(await other.locator('.roadmap-score-value').count(), 0, 'records are scoped to the site base path');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('unavailable storage preserves this visit without claiming a persistent save', {skip: !chromium}, async () => {
  const {context, page, errors} = await harness({blockedStorage: true});
  try {
    await record(page, 1, 12, 'practised');
    assert.match(await page.locator('.roadmap-storage').innerText(), /available for this visit/);
    assert.equal(await page.locator('.roadmap-score-value').innerText(), '12/20');
    await record(page, 2, 8, 'first');
    await page.locator('#roadmap-review-pair-1').check();
    assert.equal(await page.locator('.roadmap-stage.is-reviewed').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('unsafe or incomplete paper data fails visibly and can be retried', {skip: !chromium}, async () => {
  const invalid = structuredClone(fixture);
  invalid.pairs[0].papers[0].href = 'javascript:alert(1)';
  const {context, page, setData, errors} = await harness({initialData: invalid});
  try {
    assert.match(await page.locator('.roadmap-error').innerText(), /could not load/);
    assert.equal(await page.locator('.roadmap-open').count(), 0);
    setData(fixture);
    await page.getByRole('button', {name: 'Reload roadmap'}).click();
    await page.waitForSelector('.roadmap-stage');
    assert.equal(await page.locator('.roadmap-open').count(), 28);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('approved JZMaths papers use external labels, retain manual scores and exclude coming soon from stages', {skip: !chromium}, async () => {
  const data = structuredClone(externalFixture);
  delete data.pairs[14].papers[0].kind;
  delete data.pairs[14].papers[0].provider;
  const {context, page, errors} = await harness({initialData: data});
  try {
    assert.equal(await page.locator('.roadmap-count').innerText(), '0 of 17 pairs reviewed');
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuemax'), '17');
    assert.equal(await page.locator('.roadmap-open').count(), 34);
    assert.equal(await page.locator('.roadmap-open[aria-label*=" PDF:"]').count(), 28);
    assert.equal(await page.locator('.roadmap-provider').count(), 6);
    assert.deepEqual(await page.locator('.roadmap-provider').allTextContents(), Array(6).fill('Opens on JZMaths'));
    await page.getByRole('button', {name: 'Show full roadmap'}).click();
    assert.equal(await page.locator('.roadmap-stage:visible').count(), 17);
    for (const pair of data.pairs.slice(14)) {
      for (const paper of pair.papers) {
        const link = page.getByRole('link', {name: `Open Paper ${paper.paper} on JZMaths: ${pair.title} (new tab)`, exact: true});
        assert.equal(await link.getAttribute('href'), paper.href);
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        assert.equal(await link.isVisible(), true);
      }
    }
    const upcoming = page.getByRole('complementary', {name: 'Coming soon'});
    assert.match(await upcoming.innerText(), /Tyler Exam Set B — Available after its release on JZMaths\./);
    assert.equal(await upcoming.locator('a, button, input, form, .roadmap-stage').count(), 0);
    assert.equal(await page.locator('.roadmap-stage-label').last().textContent(), 'Stage 17');
    assert.equal(await page.locator('#roadmap-section > :last-child').getAttribute('class'), 'roadmap-review roadmap-coming-soon');
    await record(page, 1, 17, 'first', 15);
    await record(page, 2, 18, 'practised', 15);
    assert.equal(await page.locator('#roadmap-review-pair-15').isChecked(), false);
    await page.locator('#roadmap-review-pair-15').check();
    assert.equal(await page.locator('.roadmap-count').innerText(), '1 of 17 pairs reviewed');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tmua-paired-roadmap-v1:/study/')));
    assert.equal(stored.pairs['pair-15'].papers[1].score, 17);
    assert.equal(stored.pairs['pair-15'].papers[1].context, 'first');
    assert.equal(stored.pairs['pair-15'].papers[2].context, 'practised');
    assert.equal(stored.pairs['pair-15'].reviewed, true);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('external addresses reject every unapproved host, path, protocol, port, credential and suffix', {skip: !chromium}, async () => {
  const approved = 'https://jzmaths.com/simulator/jz_exam_c_p1';
  const invalidAddresses = [
    'http://jzmaths.com/simulator/jz_exam_c_p1',
    '//jzmaths.com/simulator/jz_exam_c_p1',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://example.com/simulator/jz_exam_c_p1',
    'https://www.jzmaths.com/simulator/jz_exam_c_p1',
    'https://jzmaths.com.example.com/simulator/jz_exam_c_p1',
    'https://jzmaths.com@evil.example/simulator/jz_exam_c_p1',
    'https://student@jzmaths.com/simulator/jz_exam_c_p1',
    'https://student:password@jzmaths.com/simulator/jz_exam_c_p1',
    'https://jzmaths.com:443/simulator/jz_exam_c_p1',
    'https://jzmaths.com:8443/simulator/jz_exam_c_p1',
    'https://jzmaths.com/simulator/tyler_exam_b_p1',
    'https://jzmaths.com/simulator/jz_exam_a_p1',
    'https://jzmaths.com/simulator/jz_exam_c_p3',
    'https://jzmaths.com/simulator/jz_exam_c_p2',
    'https://jzmaths.com/other/jz_exam_c_p1',
    'https://jzmaths.com/simulator/../simulator/jz_exam_c_p1',
    'https://jzmaths.com/simulator/%6az_exam_c_p1',
    'https://JZMATHS.com/simulator/jz_exam_c_p1',
    `${approved}/`, `${approved}?test=1`, `${approved}?`, `${approved}#test`, `${approved}#`,
    `${approved}\n`, ` ${approved}`
  ];
  const {context, page, setData, errors} = await harness({initialData: externalFixture});
  try {
    for (const href of invalidAddresses) {
      const invalid = structuredClone(externalFixture);
      invalid.pairs[14].papers[0].href = href;
      setData(invalid);
      await page.reload();
      await page.waitForSelector('.roadmap-error');
      assert.equal(await page.locator('.roadmap-open').count(), 0, `Rejected ${JSON.stringify(href)}`);
    }
    setData(externalFixture);
    await page.getByRole('button', {name: 'Reload roadmap'}).click();
    await page.waitForSelector('.roadmap-stage');
    assert.equal(await page.locator('.roadmap-open').count(), 34);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
