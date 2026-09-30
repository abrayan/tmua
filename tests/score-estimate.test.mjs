import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = await readFile(path.join(root, 'assets/score-estimate.js'), 'utf8');
const css = await readFile(path.join(root, 'assets/score-estimate.css'), 'utf8');
const siteCss = await readFile(path.join(root, 'assets/site.css'), 'utf8');
const key = 'tmua-attempt-history-v1:/study/';
const now = Date.parse('2026-09-30T12:00:00Z');
const day = 86400000;
const attempt = (paper, overrides = {}) => ({
  id:`manual:tmua-2023:p${paper}:first-session`, paperId:`tmua-2023-p${paper}`,
  title:`TMUA 2023 · Paper ${paper}`, paper, total:20, firstCorrect:12, afterCorrect:null,
  completedAt:`2026-09-${paper === 1 ? '20' : '21'}T12:00:00Z`,
  source:'manual', attemptContext:'first',
  assessment:{unseen:true, timed:true, unaided:true, durationMinutes:75}, ...overrides
});

function harness(records = [], {blocked = false, version = 1} = {}) {
  const stored = new Map([[key, JSON.stringify({version, attempts:records})]]);
  const documentEvents = new Map(), windowEvents = new Map();
  const section = {innerHTML:'', attributes:{}, details:{open:false}, classList:{add(){}},
    setAttribute(name, value){this.attributes[name] = value;},
    querySelector(selector){return selector === 'details' ? this.details : null;}};
  let clock = now;
  class CurrentDate extends Date {
    constructor(...args){super(...(args.length ? args : [clock]));}
    static now(){return clock;}
  }
  vm.runInNewContext(js, {
    document:{getElementById:id => id === 'score-estimate-section' ? section : null,
      addEventListener(type, listener){documentEvents.set(type, listener);}},
    window:{location:new URL('https://scores.test/study/'),
      addEventListener(type, listener){windowEvents.set(type, listener);}},
    localStorage:{getItem(name){if (blocked) throw Error('Storage unavailable'); return stored.get(name) ?? null;},
      setItem(){throw Error('The score card must not write or modify history');}},
    URL, Date:CurrentDate
  });
  return {section, html:() => section.innerHTML,
    history(attempts, persisted = true){documentEvents.get('tmua-history-updated')({detail:{attempts, persisted}});},
    cloud(history, persistence = {history:true}){
      documentEvents.get('tmua-cloud-applied')({detail:{payload:{history}, persistence}});
    },
    storage(attempts, name = key){stored.set(name, JSON.stringify({version:1, attempts})); windowEvents.get('storage')({key:name});},
    focus(time = clock){clock = time; windowEvents.get('focus')();}
  };
}
const expectEmpty = app => {
  assert.match(app.html(), /Not estimated yet/);
  assert.doesNotMatch(app.html(), /class="score-estimate-number"/);
};
const expectScore = (app, value, raw) => {
  assert.match(app.html(), new RegExp(`class="score-estimate-number">${value.toFixed(1).replace('.', '\\.')}<span>`));
  assert.match(app.html(), new RegExp(`<strong>${raw} / 40</strong>`));
};

test('empty, partial and legacy history do not invent a scaled score', () => {
  expectEmpty(harness());
  expectEmpty(harness([attempt(1)]));
  expectEmpty(harness([attempt(1, {assessment:undefined}), attempt(2)]));
  expectEmpty(harness([attempt(1), attempt(2)], {version:2}));
  expectEmpty(harness([attempt(1), attempt(2)], {blocked:true}));
});

test('confirmed first 2023 pair uses the combined raw table, not averaged paper scales', () => {
  const app = harness([attempt(1), attempt(2)]);
  expectScore(app, 6.8, 24);
  assert.match(app.html(), /2023 benchmark/);
  assert.match(app.html(), /2023 scale/);
  assert.match(app.html(), /Current-scale estimate unavailable/);
  assert.match(app.html(), /21 Sept 2026/);
  assert.equal(app.section.attributes['aria-labelledby'], 'score-estimate-heading');
  assert.equal(app.section.details.open, false);
  assert.match(app.html(), /whatdotheyknow.com\/request\/tmua_score_conversion_2023/);
  assert.match(app.html(), /UAT-UK-TMUA-Technical-Report-2025-26.pdf/);
});

test('all 41 historical conversion entries, including genuine zero, match the primary release', () => {
  const expected = [1,1,1,1,1,1,1.5,1.9,2.4,2.8,3.2,3.5,3.9,4.2,4.5,4.8,5.1,5.4,5.7,6,6.2,6.5,6.6,6.7,6.8,6.9,7,7.1,7.2,7.3,7.4,7.6,7.7,7.8,8,8.2,8.4,8.6,9,9,9];
  expected.forEach((scaled, raw) => expectScore(harness([
    attempt(1, {firstCorrect:Math.min(raw, 20)}), attempt(2, {firstCorrect:Math.max(raw - 20, 0)})
  ]), scaled, raw));
});

test('JZ, older official papers, guided work and assisted or repeated scores cannot be calibrated as 2023', () => {
  const invalid = [
    {paperId:'jz-mock-a-p1'}, {paperId:'tmua-2020-p1'}, {paperId:'tmua-2023-p2'},
    {source:'guided'}, {source:'imported'}, {attemptContext:'practised'},
    {assessment:{unseen:false, timed:true, unaided:true, durationMinutes:75}},
    {assessment:{unseen:true, timed:false, unaided:true, durationMinutes:75}},
    {assessment:{unseen:true, timed:true, unaided:false, durationMinutes:75}},
    {assessment:{unseen:true, timed:true, unaided:true, durationMinutes:90}},
    {assessment:{unseen:true, timed:true, unaided:true, durationMinutes:'75'}},
    {assessment:{unseen:'true', timed:true, unaided:true, durationMinutes:75}},
    {hintsUsed:1}, {usedHints:true}, {solutionViewed:true}, {finished:false},
    {completed:4}, {firstAttempted:4}, {total:2, firstCorrect:1}
  ];
  invalid.forEach(overrides => expectEmpty(harness([attempt(1, overrides), attempt(2)])));
});

test('malformed scores, dates, incomplete totals and duplicate identifiers cannot produce a benchmark', () => {
  const invalid = [
    {id:''}, {firstCorrect:21}, {firstCorrect:-1}, {firstCorrect:12.5}, {firstCorrect:'12'},
    {afterCorrect:11}, {afterCorrect:21}, {afterCorrect:undefined}, {total:0},
    {paper:0}, {title:''}, {completedAt:'not-a-date'}, {completedAt:'2026-10-01T12:00:00Z'}
  ];
  invalid.forEach(overrides => expectEmpty(harness([attempt(1, overrides), attempt(2)])));
  expectEmpty(harness([attempt(1), attempt(1, {firstCorrect:19}), attempt(2)]));
  expectEmpty(harness([attempt(1), attempt(1, {firstCorrect:19}), attempt(2),
    attempt(1, {id:'later-attempt', firstCorrect:20, completedAt:'2026-09-23T12:00:00Z'})]));
});

test('first attempt marks stay independent from after-learning scores and later high repeats', () => {
  const first = attempt(1, {firstCorrect:4, afterCorrect:20});
  const repeat = attempt(1, {id:'another-session', firstCorrect:20, afterCorrect:20,
    completedAt:'2026-09-23T12:00:00Z'});
  const app = harness([repeat, first, attempt(2, {firstCorrect:12, afterCorrect:20})]);
  expectScore(app, 5.1, 16);
  expectEmpty(harness([{...first, source:'guided'}, repeat, attempt(2)]));
  expectEmpty(harness([{...first, attemptContext:'practised'}, repeat, attempt(2)]));
  expectEmpty(harness([{...first, assessment:undefined}, repeat, attempt(2)]));
  expectEmpty(harness([first, {...repeat, completedAt:first.completedAt}, attempt(2)]));
});

test('pair window is fourteen days and each sitting must be within sixty days', () => {
  const at = days => new Date(now - days * day).toISOString();
  expectScore(harness([attempt(1, {completedAt:at(60)}), attempt(2, {completedAt:at(46)})]), 6.8, 24);
  expectEmpty(harness([attempt(1, {completedAt:at(60) }), attempt(2, {completedAt:at(45)})]));
  expectEmpty(harness([attempt(1, {completedAt:at(61)}), attempt(2, {completedAt:at(60)})]));
  const app = harness([attempt(1, {completedAt:at(60)}), attempt(2, {completedAt:at(46)})]);
  app.focus(now + 1);
  expectEmpty(app);
});

test('history, cloud and other-tab updates recompute the card without changing any history', () => {
  const app = harness();
  app.history([attempt(1), attempt(2)]);
  expectScore(app, 6.8, 24);
  app.section.details.open = true;
  app.storage([attempt(1, {firstCorrect:14}), attempt(2)]);
  expectScore(app, 7, 26);
  assert.equal(app.section.details.open, true);
  app.cloud({version:1, attempts:[]});
  expectEmpty(app);
  app.storage([attempt(1), attempt(2)], 'unrelated-history');
  expectEmpty(app);
});

test('cloud and local in-memory results survive unavailable storage and stale storage events', () => {
  const app = harness([], {blocked:true});
  app.cloud({version:1, attempts:[attempt(1), attempt(2)]}, {history:false});
  expectScore(app, 6.8, 24);
  app.storage([]);
  expectScore(app, 6.8, 24);
  app.focus();
  expectScore(app, 6.8, 24);
  app.history([attempt(1, {firstCorrect:14}), attempt(2)], false);
  expectScore(app, 7, 26);
  app.storage([]);
  expectScore(app, 7, 26);
  app.cloud({version:1, attempts:[]}, {history:false});
  expectEmpty(app);
});

const require = createRequire(import.meta.url);
let chromium, browser;
try { ({chromium} = require(process.env.TMUA_PLAYWRIGHT_PATH || 'playwright')); } catch (_) {}
before(async () => { if (chromium) browser = await chromium.launch({headless:true}); });
after(async () => { await browser?.close(); });

test('browser: responsive score card keeps explanation collapsed and updates on remote history', {skip:!chromium}, async () => {
  const context = await browser.newContext({viewport:{width:390, height:844}});
  const dates = [2, 1].map(days => new Date(Date.now() - days * day).toISOString());
  const records = [attempt(1, {completedAt:dates[0]}), attempt(2, {completedAt:dates[1]})];
  await context.addInitScript(({key, records}) => localStorage.setItem(key, JSON.stringify({version:1, attempts:records})), {key, records});
  await context.route('https://scores.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('score-estimate.js')) return route.fulfill({contentType:'text/javascript', body:js});
    if (pathname.endsWith('score-estimate.css')) return route.fulfill({contentType:'text/css', body:css});
    if (pathname.endsWith('site.css')) return route.fulfill({contentType:'text/css', body:siteCss});
    return route.fulfill({contentType:'text/html', body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/score-estimate.css"><main style="max-width:600px;padding:20px"><section id="score-estimate-section"></section></main><script src="assets/score-estimate.js"></script>'});
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('https://scores.test/study/');
    assert.equal(await page.locator('.score-estimate-number').innerText(), '6.8 / 9');
    assert.equal(await page.locator('details').evaluate(element => element.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('details').evaluate(element => element.open), true);
    assert.match(await page.locator('details').innerText(), /not a prediction on the current scale/);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('tmua-cloud-applied', {
      detail:{payload:{history:{version:1, attempts:[]}}, persistence:{history:false}}
    })));
    assert.equal(await page.locator('.score-estimate-number').count(), 0);
    assert.match(await page.locator('.score-estimate-empty').innerText(), /Not estimated yet/);
    assert.equal(await page.locator('details').evaluate(element => element.open), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
