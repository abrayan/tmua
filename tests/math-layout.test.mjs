import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium, browser, temporary, html;
try { ({chromium} = require(process.env.TMUA_PLAYWRIGHT_PATH || 'playwright')); } catch {}
const options = {skip: !chromium};
const math = content => `<math xmlns="http://www.w3.org/1998/Math/MathML">${content}</math>`;
const fraction = math('<mfrac><mn>1</mn><mn>3</mn></mfrac>');
const radical = math('<mfrac><mfrac><mn>3</mn><mn>7</mn></mfrac><msqrt><mfrac><mn>5</mn><mn>2</mn></mfrac></msqrt></mfrac>');
const term = '<mfrac><msqrt><mrow><mi>x</mi><mo>+</mo><mn>2</mn></mrow></msqrt><mrow><mi>a</mi><mo>−</mo><mn>5</mn></mrow></mfrac><mo>+</mo>';
const wide = math(term.repeat(16) + '<mn>1</mn>');
const responsive = math(term.repeat(5) + '<mn>1</mn>');

before(async () => {
  if (!chromium) return;
  temporary = await mkdtemp(path.join(tmpdir(), 'tmua-math-layout-'));
  // Synthetic questions exercise the real private builder, including its option CSS.
  // No provider content is fetched or copied into this fixture.
  const question = number => ({
    sourceId: `JZ-EXAM-FIXTURE-P1-Q0${number}`, provider: 'jzmaths-exam',
    sourceUrl: 'https://jzmaths.com/simulator/jz_exam_fixture_p1', source: 'Synthetic layout fixture',
    label: 'Synthetic fraction and radical',
    lead: `<p>Read ${math('<mn>1</mn>')}, ${fraction} and ${radical}.</p><p id="resize-formula">${responsive}</p>`,
    options: [{text: 'one third', html: fraction}, {text: 'long synthetic expression', html: wide}], correct: 'A',
    hints: [{title: 'Synthetic layout hint', body: `<p>${wide}</p>`, recap: `Read the radical ${radical}.`, pitfall: 'Keep the denominator.', pause: 'Continue on paper.'}],
    solution: `<p>The synthetic answer is ${fraction}.</p><p>${wide}</p>`
  });
  const data = {
    metadata: {format: 'tmua-paper-v1', id: 'jz-exam-fixture-p1', pairId: 'jz-exam-fixture', paper: 1, version: 1,
      title: 'Synthetic layout test', source: 'Synthetic fixture', description: '', questionCount: 2,
      visibility: 'private', provider: 'jzmaths-exam', practicePolicy: 'after-miss-up-to-3'},
    questions: [1, 2].map(n => ({id: `q${n}`, original: question(n), similar: []}))
  };
  const input = path.join(temporary, 'paper.json'), output = path.join(temporary, 'paper.html');
  await writeFile(input, JSON.stringify(data));
  execFileSync('python3', ['-c', 'import sys; from pathlib import Path; from build_paper import build; build(Path(sys.argv[1]), Path(sys.argv[2]), allow_private=True)', input, output], {cwd: path.join(root, 'tools')});
  html = await readFile(output, 'utf8');
  browser = await chromium.launch({headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar']});
});
after(async () => { await browser?.close(); if (temporary) await rm(temporary, {recursive: true, force: true}); });

async function settled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function checkLayout(page, label) {
  await settled(page);
  const result = await page.evaluate(() => {
    const maths = [...document.querySelectorAll('math')].filter(m => m.getClientRects().length);
    const ancestors = new Set();
    for (const m of maths) for (let e = m; e && e !== document.body; e = e.parentElement) ancestors.add(e);
    return {
      width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      mathCount: document.querySelectorAll('math').length, wrapperCount: document.querySelectorAll('.math-wrap').length,
      doubled: document.querySelectorAll('.math-wrap .math-wrap').length,
      // An enclosing scroller, not only MathML itself, can clip the bottom of a fraction.
      clipped: [...ancestors].filter(e => e.clientHeight > 0 && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 0.5)
        .map(e => ({tag: e.tagName, className: e.className, height: e.clientHeight, scrollHeight: e.scrollHeight})),
      scalarScrollbars: [...document.querySelectorAll('#choices .choice:first-child .math-scroll')].length
    };
  });
  assert.deepEqual(result.clipped, [], `${label}: vertical equation clipping`);
  assert.ok(result.scrollWidth <= result.width + 1, `${label}: page overflow`);
  assert.equal(result.wrapperCount, result.mathCount, `${label}: every expression wrapped once`);
  assert.equal(result.doubled, 0, `${label}: wrapper idempotence`);
  assert.equal(result.scalarScrollbars, 0, `${label}: short fraction needs no scrollbar`);
}

for (const mode of ['normal', 'pearson']) test(`MathML remains visible and long equations scroll in ${mode} view`, options, async t => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, reducedMotion: 'reduce'});
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://layout.test/**', route => route.fulfill({contentType: 'text/html', body: html}));
  await page.goto('https://layout.test/');
  await page.locator('#view-mode').selectOption(mode);
  await checkLayout(page, 'mobile question');
  assert.equal(await page.locator('#resize-formula .math-scroll').count(), 1);
  const horizontal = await page.locator('#choices .choice:last-child .math-scroll').evaluate(e => {
    e.scrollLeft = e.scrollWidth;
    return {position: e.scrollLeft, end: e.scrollWidth - e.clientWidth};
  });
  assert.ok(horizontal.position > 0, 'long equation can be scrolled');
  assert.ok(Math.abs(horizontal.position - horizontal.end) <= 1, 'end of long equation is reachable');
  await page.setViewportSize({width: 1280, height: 900});
  await checkLayout(page, 'desktop question');
  assert.equal(await page.locator('#resize-formula .math-scroll').count(), 0, 'resize removes unneeded scrolling');
  await page.setViewportSize({width: 390, height: 844});
  await checkLayout(page, 'return to mobile');
  assert.equal(await page.locator('#resize-formula .math-scroll').count(), 1, 'resize restores necessary scrolling');
  await page.locator('#give-hint').click();
  await checkLayout(page, 'new hint content');
  assert.ok(await page.locator('#knowledge-list .math-scroll').count() > 0);
  await page.locator('#try-again').click();
  await page.locator('input[value="A"]').check();
  await page.locator('#check-answer').click();
  await checkLayout(page, 'previously hidden solution');
  assert.ok(await page.locator('#solution-content .math-scroll').count() > 0);
  await page.locator('#redo-button').click();
  await checkLayout(page, 'repeated question rendering');
  await page.locator('input[value="A"]').check();
  await page.locator('#check-answer').click();
  await page.locator('#next-exercise-button').click();
  await checkLayout(page, 'next question replaces old wrappers');
  assert.deepEqual(errors, []);
});
