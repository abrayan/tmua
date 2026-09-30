// Run with: node tools/test_paper_player.js
// Exercises the actual player event handlers without needing browser dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'content/jz-mock-d-p1-preview.json'), 'utf8'));
for (const group of data.questions) for (const exercise of [group.original, ...group.similar]) for (const hint of exercise.hints) delete hint.recall;
const player = fs.readFileSync(path.join(root, 'templates/paper-player.js'), 'utf8');

function create({embedded = true, saved = null, denyStorage = false, paper = data} = {}) {
  const elements = new Map(), messages = [], listeners = {}, writes = [], documentListeners = {}, viewEvents = [];
  let checked = null;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {id, hidden: false, textContent: '', innerHTML: '', style: {}, events: {}, setAttribute() {}, scrollIntoView() {}, focus() {}, addEventListener(name, fn) { this.events[name] = fn; }, querySelector(selector) { return selector === 'input:checked' ? checked : element(id + ':' + selector); }});
    return elements.get(id);
  };
  element('tmua-paper-data').textContent = JSON.stringify(paper);
  const window = {addEventListener(name, fn) {listeners[name] = fn;}, matchMedia() {return {matches: true};}};
  window.parent = embedded ? {postMessage(message) {messages.push(JSON.parse(JSON.stringify(message)));}} : window;
  const document = {getElementById: element, addEventListener(name, fn) {documentListeners[name] = fn;}, dispatchEvent(event) {viewEvents.push(event); if (documentListeners[event.type]) documentListeners[event.type](event);}};
  const context = {document, CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options?.detail;}}, window, requestAnimationFrame: fn => fn(), localStorage: {getItem() {if (denyStorage) throw Error('unavailable'); return saved === null ? null : JSON.stringify(saved);}, setItem(key, value) {if (denyStorage) throw Error('unavailable'); writes.push(JSON.parse(value));}}};
  vm.runInNewContext(player, context);
  const click = id => {assert.ok(element(id).events.click, 'missing click handler: ' + id); element(id).events.click();};
  const answer = letter => {checked = {value: letter}; element('answer-form').events.change({target: {name: 'answer', value: letter}}); element('answer-form').events.submit({preventDefault() {}}); checked = null;};
  const resume = (state, overrides = {}) => listeners.message({source: window.parent, data: {type: 'tmua-resume', paperId: paper.metadata.id, state}, ...overrides});
  const state = () => embedded ? messages.filter(m => m.type === 'tmua-progress').at(-1).state : writes.at(-1);
  return {element, messages, click, answer, resume, state, window, viewEvents, viewEvent: (type, detail) => document.dispatchEvent({type, detail})};
}

const app = create();
assert.equal(app.messages[0].type, 'tmua-ready');
assert.equal(app.element('review').hidden, true);
assert.equal(app.element('solution').hidden, true);
app.resume(null);
app.answer('E');
assert.equal(app.state().records[0].first, 1);
assert.equal(app.element('solution').hidden, false);
assert.match(app.element('knowledge-recap').innerHTML, /Watch for:/);
assert.equal(app.element('next-exercise-button').disabled, true);
app.click('similar-button');
app.answer('A');
assert.equal(app.state().piecesShown, 1);
assert.equal(app.state().records[0].practice, 0);
app.click('try-again');
assert.equal(app.state().helpVisible, false);
app.answer('B');
assert.equal(app.state().piecesShown, 2);
app.click('next-piece'); app.click('next-piece'); app.click('reveal-solution');
assert.equal(app.state().records[0].completed, true);
assert.equal(app.element('next-exercise-button').disabled, false);
app.click('redo-button'); app.answer('D');
assert.equal(app.state().records[0].practice, 0, 'redo must not overwrite first similar score');
app.click('similar-button'); app.answer('C');
assert.equal(app.state().records[0].practice, 0, 'extra similar must not overwrite first similar score');
app.click('next-exercise-button');
assert.equal(app.state().questionIndex, 1);
assert.equal(app.state().mode, 'original');
app.answer('A'); app.click('try-again'); app.answer('D');
assert.equal(app.state().records[1].first, 0, 'original retry must not overwrite first score');
app.click('similar-button'); app.answer('C');
assert.equal(app.element('next-exercise-button').textContent, 'Finish paper');
app.click('next-exercise-button');
assert.equal(app.state().finished, true);
assert.equal(app.element('finished').hidden, false);
assert.equal(app.messages.at(-1).progress.firstCorrect, 1);
assert.equal(app.messages.at(-1).progress.practiceCorrect, 1);
const finalState = app.state();
app.click('review-last');
assert.equal(app.state().finished, true, 'reviewing a finished paper preserves completion');
assert.equal(app.state().summaryVisible, false);
assert.equal(app.element('practice').hidden, false);
assert.equal(app.messages.at(-1).progress.finished, true);
app.click('redo-button');
assert.equal(app.state().finished, true, 'further practice preserves completion');
const reviewed = create(); reviewed.resume(app.state());
assert.equal(reviewed.state().finished, true);
assert.equal(reviewed.element('finished').hidden, true, 'resume restores practice view independently of completion');
const restored = create(); restored.resume(finalState);
assert.equal(restored.state().finished, true, 'completed paper resumes');
const invalid = create(); invalid.resume({...finalState, records: []});
assert.equal(invalid.state().questionIndex, 0, 'malformed state discarded');
assert.equal(invalid.state().finished, false);
const foreign = create(); foreign.resume(finalState, {source: {}});
assert.equal(foreign.messages.length, 1, 'foreign frame message ignored');
foreign.resume(finalState);
assert.equal(foreign.state().finished, true);
const local = create({embedded: false, saved: finalState});
assert.equal(local.element('finished').hidden, false, 'standalone local resume');
assert.equal(local.element('return-library').hidden, true);
const blocked = create({embedded: false, denyStorage: true}); blocked.answer('E');
assert.equal(blocked.element('solution').hidden, false, 'storage unavailable does not prevent practice');
const eight = structuredClone(data);
eight.metadata.paper = 2;
eight.questions[0].original.options = ['one','two','three','four','five','six','seven','eight'];
eight.questions[0].original.correct = 'H';
const generic = create({paper: eight}); generic.resume(null); generic.answer('H');
assert.equal(generic.state().records[0].first, 1);
assert.match(generic.element('exercise-label').textContent, /^Paper 2/);
assert.equal((generic.element('choices').innerHTML.match(/class="choice"/g) || []).length, 8);
const ten = structuredClone(eight);
ten.questions[0].original.options.push(
  {html: '<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>', text: 'one half'},
  {html: '<math><mi>x</mi><mo>&lt;</mo><mfrac><mn>3</mn><mn>4</mn></mfrac></math>', text: 'x is less than three quarters'}
);
ten.questions[0].original.correct = 'J';
const rich = create({paper: ten}); rich.resume(null); rich.answer('J');
assert.equal(rich.state().records[0].first, 1);
assert.equal((rich.element('choices').innerHTML.match(/class="choice"/g) || []).length, 10);
assert.match(rich.element('choices').innerHTML, /aria-label="I\. one half"/);
assert.match(rich.element('choices').innerHTML, /<mfrac><mn>1<\/mn><mn>2<\/mn><\/mfrac>/);
assert.match(rich.element('correct-answer').innerHTML, /<mi>x<\/mi><mo>&lt;<\/mo>/);
assert.match(rich.element('correct-answer').innerHTML, /x is less than three quarters/);
const legacy = create(); const legacyState = structuredClone(finalState); delete legacyState.summaryVisible; legacy.resume(legacyState);
assert.equal(legacy.element('finished').hidden, false, 'earlier saved states retain their summary view');
const recalledPaper = structuredClone(data);
const fixtureMethod = {lessonId: 'fixture-method-11', paper: 1, booklet: 1, number: 11, pdfPage: 14, sourceLabel: 'METHOD 11', title: 'Count repeated choices', reminder: 'Choose a term from each bracket, then track <math><mi>x</mi></math>.'};
const fixtureLesson = {lessonId: 'fixture-lesson-8', paper: 1, booklet: 3, number: 8, pdfPage: 9, sourceLabel: 'Lesson 8', title: 'Add the powers', reminder: 'Add all selected powers before counting arrangements.'};
recalledPaper.questions[0].original.hints[0].recall = [fixtureMethod];
recalledPaper.questions[0].original.hints[1].recall = [fixtureLesson];
recalledPaper.questions[0].similar[0].hints[0].recall = [fixtureMethod];
const firstCorrectRecall = create({paper: recalledPaper}); firstCorrectRecall.resume(null);
assert.equal(firstCorrectRecall.element('review').hidden, true);
assert.equal(firstCorrectRecall.element('solution').hidden, true);
assert.equal(firstCorrectRecall.element('knowledge-list').innerHTML, '', 'no recall content on the initial question screen');
firstCorrectRecall.answer('E');
assert.equal(firstCorrectRecall.state().records[0].first, 1);
assert.match(firstCorrectRecall.element('knowledge-recap').innerHTML, /Remember · Paper 1 · Booklet 1 · Section 11/);
assert.doesNotMatch(firstCorrectRecall.element('knowledge-recap').innerHTML, /Booklet 1 · Lesson 11/);
assert.match(firstCorrectRecall.element('knowledge-recap').innerHTML, /Remember · Paper 1 · Booklet 3 · Lesson 8/);
assert.match(firstCorrectRecall.element('knowledge-recap').innerHTML, /Count repeated choices/);
assert.match(firstCorrectRecall.element('knowledge-recap').innerHTML, /PDF p\. 14/);
assert.match(firstCorrectRecall.element('knowledge-recap').innerHTML, /<math><mi>x<\/mi><\/math>/);
const wrongRecall = create({paper: recalledPaper}); wrongRecall.resume(null); wrongRecall.answer('A');
assert.match(wrongRecall.element('knowledge-list').innerHTML, /Section 11/);
assert.doesNotMatch(wrongRecall.element('knowledge-list').innerHTML, /Lesson 8/, 'unrevealed steps do not expose their recalls');
wrongRecall.click('next-piece');
assert.match(wrongRecall.element('knowledge-list').innerHTML, /Booklet 3 · Lesson 8/);
wrongRecall.click('try-again');
assert.equal(wrongRecall.element('review').hidden, true, 'taking it from here hides recall with help');
firstCorrectRecall.click('similar-button'); firstCorrectRecall.answer('D');
assert.match(firstCorrectRecall.element('knowledge-recap').innerHTML, /Section 11/, 'similar-exercise correct answers also recap prior study');
function policyPaper() {
  const paper = structuredClone(data);
  paper.metadata.practicePolicy = 'after-miss-up-to-3';
  paper.metadata.paper = 2;
  paper.questions[0].original.sourceId = '2020-P2-Q01';
  paper.questions[1].original.sourceId = '2020-P2-Q02';
  paper.questions[0].similar.push(structuredClone(paper.questions[0].original));
  paper.questions[0].similar.forEach((q, i) => {q.sourceId = `${2021 + i}-P2-Q01`;});
  paper.questions[1].similar.forEach((q, i) => {q.sourceId = `${2021 + i}-P2-Q01`;});
  return paper;
}
const policy = policyPaper();
const immediate = create({paper: policy}); immediate.resume(null); immediate.answer('E');
assert.equal(immediate.state().records[0].completed, true, 'correct first original needs no followup');
assert.equal(immediate.element('next-exercise-button').disabled, false);
assert.equal(immediate.element('similar-button').hidden, true);
assert.equal(immediate.messages.at(-1).progress.practiceAttempted, 0);
assert.match(immediate.element('exercise-label').textContent, /TMUA 2020 · Paper 2 · Question 1/);
immediate.click('next-exercise-button');
assert.equal(immediate.state().questionIndex, 1);
const beforeModal = JSON.stringify(immediate.state());
immediate.viewEvent('tmua-review-question', {index: 0});
assert.equal(immediate.viewEvents.at(-1).type, 'tmua-review-content');
assert.match(immediate.viewEvents.at(-1).detail.solutionHTML, /The knowledge steps/);
assert.equal(JSON.stringify(immediate.state()), beforeModal, 'palette review never changes active sequence');
immediate.viewEvent('tmua-request-render');
assert.equal(immediate.viewEvents.at(-1).detail.questionIndex, 1);

const threeMisses = create({paper: policy}); threeMisses.resume(null);
threeMisses.answer('A'); threeMisses.click('try-again'); threeMisses.answer('E');
assert.equal(threeMisses.element('next-exercise-button').disabled, true);
for (const [i, correct] of ['D', 'C', 'E'].entries()) {
  threeMisses.click('similar-button');
  assert.equal(threeMisses.state().records[0].followups.length, i + 1);
  assert.equal(threeMisses.element('solution').hidden, true, 'followup starts with solution hidden');
  assert.equal(threeMisses.element('review').hidden, true);
  threeMisses.answer('A');
  const midway = create({paper: policy}); midway.resume(threeMisses.state());
  assert.equal(midway.state().records[0].followups[i].first, 0, 'missed followup restores its immutable first attempt');
  threeMisses.click('try-again'); threeMisses.answer(correct);
  assert.equal(threeMisses.state().records[0].followups[i].first, 0);
}
assert.equal(threeMisses.state().records[0].completed, true);
assert.equal(threeMisses.element('similar-button').hidden, true);
threeMisses.click('similar-button');
assert.equal(threeMisses.state().records[0].followups.length, 3, 'three is a hard limit with no loop');
threeMisses.click('redo-button'); threeMisses.answer('E');
assert.equal(threeMisses.messages.at(-1).progress.practiceCorrect, 0, 'redo does not revise any followup score');
assert.equal(threeMisses.messages.at(-1).progress.practiceAttempted, 3);
threeMisses.click('next-exercise-button'); threeMisses.answer('D'); threeMisses.click('next-exercise-button');
assert.equal(threeMisses.state().finished, true);
assert.match(threeMisses.element('overall-scores').innerHTML, /0\/3/);
assert.equal(threeMisses.messages.at(-1).progress.firstCorrect, 1);
const restoredPolicy = create({paper: policy}); restoredPolicy.resume(threeMisses.state());
assert.equal(restoredPolicy.state().finished, true);

const recovery = create({paper: policy}); recovery.resume(null);
recovery.answer('A'); recovery.click('try-again'); recovery.answer('E'); recovery.click('similar-button'); recovery.answer('D');
assert.equal(recovery.state().records[0].completed, true, 'successful first followup ends followups early');
assert.equal(recovery.element('similar-button').hidden, true);
assert.equal(recovery.messages.at(-1).progress.recovered, 1);
recovery.click('next-exercise-button'); recovery.answer('A'); recovery.click('try-again'); recovery.answer('D'); recovery.click('similar-button');
assert.equal(recovery.state().similarIndex, 1, 'globally seen source is skipped');
assert.equal(recovery.state().records[1].followups[0].sourceId, '2022-P2-Q01');
const duplicatedState = structuredClone(recovery.state());
duplicatedState.records[1].followups[0].sourceId = '2021-P2-Q01';
duplicatedState.records[1].followups[0].index = 0;
duplicatedState.similarIndex = 0;
const rejectsDuplicate = create({paper: policy}); rejectsDuplicate.resume(duplicatedState);
assert.equal(rejectsDuplicate.state().questionIndex, 0, 'duplicate source in restored history is rejected');

const exhaustedPaper = policyPaper(); exhaustedPaper.questions[1].similar = [exhaustedPaper.questions[1].similar[0]];
const exhausted = create({paper: exhaustedPaper}); exhausted.resume(null);
exhausted.answer('A'); exhausted.click('try-again'); exhausted.answer('E'); exhausted.click('similar-button'); exhausted.answer('D'); exhausted.click('next-exercise-button');
exhausted.answer('A'); exhausted.click('try-again'); exhausted.answer('D');
assert.equal(exhausted.state().records[1].completed, true, 'no unseen matching questions permits continuation');
assert.equal(exhausted.element('similar-button').hidden, true);
assert.match(exhausted.element('completion-note').textContent, /No unused matching/);
const noCandidates = policyPaper(); noCandidates.questions[0].similar = [];
const none = create({paper: noCandidates}); none.resume(null); none.answer('A'); none.click('try-again'); none.answer('E');
assert.equal(none.state().records[0].completed, true);
const noCandidatesRestored = create({paper: noCandidates}); noCandidatesRestored.resume(none.state());
assert.equal(noCandidatesRestored.state().records[0].completed, true, 'zero-candidate original state restores');
const overlapping = policyPaper();
overlapping.metadata.questionCount = 20;
overlapping.questions = Array.from({length: 20}, (_, i) => {
  const original = structuredClone(data.questions[i % 2].original);
  original.sourceId = `2020-P2-Q${String(i + 1).padStart(2, '0')}`;
  const similar = Array.from({length: 3}, (_, j) => {
    const q = structuredClone(data.questions[0].similar[j % 2]);
    q.sourceId = `2023-P2-Q${String((i + j) % 6 + 1).padStart(2, '0')}`;
    return q;
  });
  return {id: `q${i + 1}`, original, similar};
});
const longJourney = create({paper: overlapping}); longJourney.resume(null);
const encountered = new Set();
function assertLongResume() {
  const restored = create({paper: overlapping}); restored.resume(longJourney.state());
  assert.equal(JSON.stringify(restored.state()), JSON.stringify(longJourney.state()), 'every milestone restores unchanged despite overlapping candidate pools');
}
function currentLongQuestion() {
  const s = longJourney.state(), g = overlapping.questions[s.questionIndex];
  return s.mode === 'original' ? g.original : g.similar[s.similarIndex];
}
function missAndReview() {
  const q = currentLongQuestion();
  longJourney.answer(q.correct === 'A' ? 'B' : 'A');
  assertLongResume();
  for (let piece = 1; piece < q.hints.length; piece++) longJourney.click('next-piece');
  longJourney.click('reveal-solution');
  assertLongResume();
}
for (let index = 0; index < 20; index++) {
  assert.equal(longJourney.state().questionIndex, index);
  if (index % 4 === 0) longJourney.answer(currentLongQuestion().correct);
  else missAndReview();
  assertLongResume();
  while (!longJourney.state().records[index].completed) {
    longJourney.click('similar-button');
    const id = currentLongQuestion().sourceId;
    assert.equal(encountered.has(id), false, `followup ${id} must never repeat`);
    encountered.add(id);
    assertLongResume();
    if (encountered.size % 3 === 0) longJourney.answer(currentLongQuestion().correct);
    else missAndReview();
    assertLongResume();
  }
  longJourney.click('next-exercise-button');
  assertLongResume();
}
assert.equal(longJourney.state().finished, true);
assert.equal(longJourney.messages.at(-1).progress.firstCorrect, 5);
assert.equal(longJourney.messages.at(-1).progress.practiceAttempted, encountered.size);
assert.ok(encountered.size <= 6, 'twenty originals consume each of the six shared followups at most once');
assert.ok(longJourney.state().records.some(r => r.first === 0 && r.followups.length === 0 && r.completed), 'later exhausted pools finish without phantom attempts');
console.log('PASS: legacy/recall regression, adaptive policy, immutable scores, palette review, and a 20-question overlapping-bank journey with resume checks at every milestone.');
