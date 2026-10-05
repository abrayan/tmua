// Run with: node tools/test_paper_player.js
// Exercises the actual player event handlers without needing browser dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {readFrozenEditionSource} from './validate-edition-sources.mjs';
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
  const check = () => {element('answer-form').events.submit({preventDefault() {}}); checked = null;};
  const answer = letter => {checked = {value: letter}; element('answer-form').events.change({target: {name: 'answer', value: letter}}); check();};
  const resume = (state, overrides = {}) => listeners.message({source: window.parent, data: {type: 'tmua-resume', paperId: paper.metadata.id, state}, ...overrides});
  const state = () => embedded ? messages.filter(m => m.type === 'tmua-progress').at(-1).state : writes.at(-1);
  return {element, messages, click, answer, check, resume, state, window, viewEvents, viewEvent: (type, detail) => document.dispatchEvent({type, detail})};
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
assert.equal(app.element('next-exercise-button').disabled, false, 'a checked original can advance without mandatory similar practice');
app.click('similar-button');
app.answer('A');
assert.equal(app.state().piecesShown, 0, 'checking an answer reveals the solution without automatically opening a hint');
assert.equal(app.state().records[0].practice, 0);
assert.equal(app.state().solutionVisible, true);
app.click('solution-hints');
assert.equal(app.state().piecesShown, 1);
assert.equal(app.state().solutionVisible, false);
app.click('try-again');
assert.equal(app.state().helpVisible, false);
app.answer('B');
assert.equal(app.state().solutionVisible, true);
app.click('solution-hints');
assert.equal(app.state().piecesShown, 1, 'revisiting help retains the revealed piece without exposing further knowledge');
app.click('next-piece'); app.click('next-piece'); app.click('next-piece'); app.click('try-again'); app.answer('D');
assert.equal(app.state().records[0].completed, true);
assert.equal(app.element('next-exercise-button').disabled, false);
app.click('redo-button'); app.answer('D');
assert.equal(app.state().records[0].practice, 0, 'redo must not overwrite first similar score');
app.click('similar-button'); app.answer('C');
assert.equal(app.state().records[0].practice, 0, 'extra similar must not overwrite first similar score');
app.click('next-exercise-button');
assert.equal(app.state().questionIndex, 1);
assert.equal(app.state().mode, 'original');
app.answer('A'); app.click('solution-hints'); app.click('try-again'); app.answer('D');
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
// K/L must be real choices, retain their labels on resume, and use the same scoring rules.
for (const correct of ['K','L']) {
  const twelve = structuredClone(ten);
  twelve.questions[0].original.options.push('eleven','twelve');
  twelve.questions[0].original.correct = correct;
  const wide = create({paper:twelve}); wide.resume(null);
  assert.equal((wide.element('choices').innerHTML.match(/class="choice"/g)||[]).length,12);
  assert.match(wide.element('choices').innerHTML,/value="K" aria-label="K\. eleven"/);
  assert.match(wide.element('choices').innerHTML,/value="L" aria-label="L\. twelve"/);
  wide.answer(correct);
  assert.equal(wide.state().records[0].first,1);
  const resumed = create({paper:twelve}); resumed.resume(wide.state());
  assert.equal(resumed.state().selected,correct);
  assert.equal(resumed.state().records[0].first,1);
  assert.equal(resumed.element('solution').hidden,false);
  resumed.click('redo-button'); resumed.answer(correct==='K'?'L':'K');
  assert.equal(resumed.state().records[0].first,1,'retry leaves first score fixed');
  const bad = create({paper:twelve}); bad.resume({...wide.state(),selected:'M'});
  assert.equal(bad.state().records[0].first,null,'unavailable option rejects malformed saved state');
}
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
const wrongRecall = create({paper: recalledPaper}); wrongRecall.resume(null); wrongRecall.answer('A'); wrongRecall.click('solution-hints');
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
threeMisses.answer('A'); threeMisses.click('solution-hints'); threeMisses.click('try-again'); threeMisses.answer('E');
assert.equal(threeMisses.element('next-exercise-button').disabled, false, 'after reviewing an answer the learner may continue or choose related practice');
for (const [i, correct] of ['D', 'C', 'E'].entries()) {
  threeMisses.click('similar-button');
  assert.equal(threeMisses.state().records[0].followups.length, i + 1);
  assert.equal(threeMisses.element('solution').hidden, true, 'followup starts with solution hidden');
  assert.equal(threeMisses.element('review').hidden, true);
  threeMisses.answer('A');
  const midway = create({paper: policy}); midway.resume(threeMisses.state());
  assert.equal(midway.state().records[0].followups[i].first, 0, 'missed followup restores its immutable first attempt');
  threeMisses.click('solution-hints'); threeMisses.click('try-again'); threeMisses.answer(correct);
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
recovery.answer('A'); recovery.click('solution-hints'); recovery.click('try-again'); recovery.answer('E'); recovery.click('similar-button'); recovery.answer('D');
assert.equal(recovery.state().records[0].completed, true, 'successful first followup ends followups early');
assert.equal(recovery.element('similar-button').hidden, true);
assert.equal(recovery.messages.at(-1).progress.recovered, 1);
recovery.click('next-exercise-button'); recovery.answer('A'); recovery.click('solution-hints'); recovery.click('try-again'); recovery.answer('D'); recovery.click('similar-button');
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
exhausted.answer('A'); exhausted.click('solution-hints'); exhausted.click('try-again'); exhausted.answer('E'); exhausted.click('similar-button'); exhausted.answer('D'); exhausted.click('next-exercise-button');
exhausted.answer('A'); exhausted.click('solution-hints'); exhausted.click('try-again'); exhausted.answer('D');
assert.equal(exhausted.state().records[1].completed, true, 'no unseen matching questions permits continuation');
assert.equal(exhausted.element('similar-button').hidden, true);
assert.match(exhausted.element('completion-note').textContent, /continue/);
const noCandidates = policyPaper(); noCandidates.questions[0].similar = [];
const none = create({paper: noCandidates}); none.resume(null); none.answer('A'); none.click('solution-hints'); none.click('try-again'); none.answer('E');
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
  assert.equal(longJourney.state().solutionVisible, true);
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
const scoreJourney = create({paper: policy}); scoreJourney.resume(null);
const originalAttemptId = scoreJourney.state().attemptId;
const originalStartedAt = scoreJourney.state().startedAt;
assert.match(originalAttemptId, /^[0-9a-f-]{36}$/i);
assert.equal(new Date(originalStartedAt).toISOString(), originalStartedAt);
assert.equal(scoreJourney.messages.at(-1).progress.afterCorrect, 0);
assert.equal(scoreJourney.messages.at(-1).progress.afterKnown, true);
scoreJourney.click('start-new-attempt');
assert.equal(scoreJourney.state().attemptId, originalAttemptId, 'new attempt cannot be started outside the final screen');
scoreJourney.answer('A');
assert.equal(scoreJourney.state().solutionVisible, true);
assert.equal(scoreJourney.state().records[0].everSolved, false, 'viewing the original solution is not a solved submission');
assert.equal(scoreJourney.messages.at(-1).progress.afterCorrect, 0);
scoreJourney.click('similar-button'); scoreJourney.answer('D');
assert.equal(scoreJourney.state().records[0].everSolved, false, 'solving a followup does not solve the original');
assert.equal(scoreJourney.messages.at(-1).progress.afterCorrect, 0);
scoreJourney.click('next-exercise-button'); scoreJourney.answer('D');
assert.equal(scoreJourney.state().records[1].everSolved, true);
assert.equal(scoreJourney.messages.at(-1).progress.firstCorrect, 1);
assert.equal(scoreJourney.messages.at(-1).progress.afterCorrect, 1, 'first-correct originals count in both scores');
scoreJourney.click('next-exercise-button');
assert.equal(scoreJourney.state().finished, true);
assert.match(scoreJourney.element('overall-scores').innerHTML, /First attempt · on your own/);
assert.match(scoreJourney.element('overall-scores').innerHTML, /After practice · including retries/);
assert.match(scoreJourney.element('overall-scores').innerHTML, /Similar exercises · first attempts/);
const finishedScoreState = scoreJourney.state();
const resumeScores = create({paper: policy}); resumeScores.resume(finishedScoreState);
assert.equal(resumeScores.state().attemptId, originalAttemptId);
assert.equal(resumeScores.state().startedAt, originalStartedAt);
assert.equal(resumeScores.messages.at(-1).progress.afterCorrect, 1);
scoreJourney.click('start-new-attempt');
assert.notEqual(scoreJourney.state().attemptId, originalAttemptId, 'a new full attempt has a different history key');
assert.equal(scoreJourney.state().questionIndex, 0);
assert.equal(scoreJourney.state().finished, false);
assert.equal(scoreJourney.messages.at(-1).progress.firstCorrect, 0);
assert.equal(scoreJourney.messages.at(-1).progress.afterCorrect, 0);
assert.equal(finishedScoreState.finished, true, 'previous emitted finished state is left intact for parent history');

const repairedOriginal = create({paper: policy}); repairedOriginal.resume(null);
repairedOriginal.answer('A'); repairedOriginal.click('solution-hints'); repairedOriginal.click('try-again'); repairedOriginal.answer('E');
assert.equal(repairedOriginal.state().records[0].first, 0);
assert.equal(repairedOriginal.state().records[0].everSolved, true);
assert.equal(repairedOriginal.messages.at(-1).progress.afterCorrect, 1);
const repairedId = repairedOriginal.state().attemptId;
repairedOriginal.click('redo-button'); repairedOriginal.answer('A');
assert.equal(repairedOriginal.state().records[0].everSolved, true, 'ever solved stays true after a later wrong retry');
assert.equal(repairedOriginal.state().attemptId, repairedId, 'ordinary redo keeps the same whole-paper attempt');

const historical = structuredClone(finalState);
delete historical.attemptId; delete historical.startedAt;
for (const r of historical.records) delete r.everSolved;
const migrated = create(); migrated.resume(historical);
assert.equal(migrated.state().records[0].everSolved, true, 'legacy first-correct is known solved');
assert.equal(migrated.state().records[1].everSolved, null, 'legacy wrong first answer has unknown later-solving history');
assert.equal(migrated.messages.at(-1).progress.afterKnown, false);
assert.equal(migrated.messages.at(-1).progress.afterCorrect, null);
assert.match(migrated.element('overall-scores').innerHTML, /Not recorded/);
assert.equal(migrated.messages.at(-1).progress.firstCorrect, 1, 'legacy first score preserved');
const migratedAgain = create(); migratedAgain.resume(migrated.state());
assert.equal(migratedAgain.state().attemptId, migrated.state().attemptId, 'migration identity persists on later resume');
const impossible = structuredClone(finishedScoreState); impossible.records[1].everSolved = false;
const rejectsImpossible = create({paper: policy}); rejectsImpossible.resume(impossible);
assert.equal(rejectsImpossible.state().records[1].first, null, 'first-correct plus never-solved is rejected');
const verifyAfterSimilar = create({paper: policy}); verifyAfterSimilar.resume(null);
verifyAfterSimilar.answer('A');
assert.equal(verifyAfterSimilar.state().solutionVisible, true);
verifyAfterSimilar.click('similar-button'); verifyAfterSimilar.answer('D');
assert.equal(verifyAfterSimilar.messages.at(-1).progress.afterCorrect, 0);
assert.equal(verifyAfterSimilar.element('redo-button').textContent, 'Redo the original question');
const followupsBeforeRedo = JSON.stringify(verifyAfterSimilar.state().records[0].followups);
verifyAfterSimilar.click('redo-button');
assert.equal(verifyAfterSimilar.state().mode, 'original');
assert.equal(verifyAfterSimilar.state().records[0].first, 0);
assert.equal(verifyAfterSimilar.state().records[0].completed, true, 'redo does not revoke completed followup policy');
const resumeOriginalRedo = create({paper: policy}); resumeOriginalRedo.resume(verifyAfterSimilar.state());
assert.equal(resumeOriginalRedo.state().mode, 'original');
assert.equal(JSON.stringify(resumeOriginalRedo.state().records[0].followups), followupsBeforeRedo, 'original redo with existing followups resumes');
verifyAfterSimilar.answer('E');
assert.equal(verifyAfterSimilar.messages.at(-1).progress.afterCorrect, 1);
assert.equal(verifyAfterSimilar.messages.at(-1).progress.firstCorrect, 0);
assert.equal(JSON.stringify(verifyAfterSimilar.state().records[0].followups), followupsBeforeRedo);
assert.equal(verifyAfterSimilar.element('next-exercise-button').disabled, false);
assert.match(verifyAfterSimilar.element('score-summary').innerHTML, /After practice · including retries/);
const afterScoreResume = create({paper: policy}); afterScoreResume.resume(verifyAfterSimilar.state());
assert.equal(afterScoreResume.messages.at(-1).progress.afterCorrect, 1);
const unknownOriginal = structuredClone(verifyAfterSimilar.state());
delete unknownOriginal.records[0].everSolved;
const legacyRepair = create({paper: policy}); legacyRepair.resume(unknownOriginal);
assert.equal(legacyRepair.messages.at(-1).progress.afterCorrect, null);
legacyRepair.click('redo-button'); legacyRepair.answer('E');
assert.equal(legacyRepair.messages.at(-1).progress.afterKnown, true, 'a new correct original submission resolves legacy uncertainty');
assert.equal(legacyRepair.messages.at(-1).progress.afterCorrect, 1);
assert.equal(legacyRepair.state().records[0].first, 0);
function revisedPaper(previous) {
  const revised = structuredClone(previous);
  revised.metadata.contentRevision = 2;
  revised.questions.forEach((g, index) => {
    g.legacySimilar = structuredClone(g.similar);
    g.similar = Array.from({length:3}, (_, i) => {
      const q = structuredClone(data.questions[0].similar[i % 2]);
      q.sourceId = `2019-P2-Q${String(index * 3 + i + 1).padStart(2, '0')}`;
      return q;
    });
  });
  return revised;
}
const revisedPolicy = revisedPaper(policy);
const oldFinished = structuredClone(threeMisses.state());
delete oldFinished.contentRevision;
const revisedFinished = create({paper:revisedPolicy}); revisedFinished.resume(oldFinished);
assert.equal(revisedFinished.state().contentRevision, 1);
assert.equal(revisedFinished.state().finished, true, 'a full old attempt keeps its completed state');
assert.equal(revisedFinished.state().attemptId, oldFinished.attemptId, 'history identity survives a pool replacement');
assert.equal(revisedFinished.state().startedAt, oldFinished.startedAt);
assert.deepEqual(revisedFinished.state().records, oldFinished.records, 'all original, followup and after-practice records survive unchanged');
assert.match(revisedFinished.element('score-explanation').textContent, /keeps its original follow-up questions/);
const revisedFinishedAgain = create({paper:revisedPolicy}); revisedFinishedAgain.resume(revisedFinished.state());
assert.deepEqual(revisedFinishedAgain.state(), revisedFinished.state(), 'migrated state is stable on later reloads');
const retiredActive = create({paper:policy}); retiredActive.resume(null);
retiredActive.answer('A'); retiredActive.click('solution-hints'); retiredActive.click('try-again'); retiredActive.answer('E');
retiredActive.click('similar-button'); retiredActive.answer('A');
const oldMidway = structuredClone(retiredActive.state()); delete oldMidway.contentRevision;
const revisedMidway = create({paper:revisedPolicy}); revisedMidway.resume(oldMidway);
assert.equal(revisedMidway.state().mode, 'similar');
assert.equal(revisedMidway.state().records[0].followups[0].sourceId, '2021-P2-Q01');
assert.equal(revisedMidway.state().piecesShown, oldMidway.piecesShown);
assert.equal(revisedMidway.state().attemptId, oldMidway.attemptId);
assert.match(revisedMidway.element('exercise-label').textContent, /TMUA 2021/);
revisedMidway.click('solution-hints'); revisedMidway.click('try-again'); revisedMidway.answer('D');
assert.equal(revisedMidway.state().records[0].followups[0].first, 0, 'retrying a retired followup preserves its first answer');
revisedMidway.click('similar-button');
assert.equal(revisedMidway.state().records[0].followups[1].sourceId, '2022-P2-Q01', 'unfinished old attempt continues with its original ordered pool');
const oldEmpty = structuredClone(none.state()); delete oldEmpty.contentRevision;
const revisedEmptyPaper = revisedPaper(noCandidates);
const revisedEmpty = create({paper:revisedEmptyPaper}); revisedEmpty.resume(oldEmpty);
assert.equal(revisedEmpty.state().contentRevision, 1);
assert.equal(revisedEmpty.state().records[0].completed, true, 'old zero-pool completion is not revoked when three candidates are added');
assert.equal(revisedEmpty.state().records[0].followups.length, 0, 'migration never fabricates a practice attempt');
assert.equal(revisedEmpty.element('similar-button').hidden, true);
revisedEmpty.click('next-exercise-button');
assert.equal(revisedEmpty.state().questionIndex, 1, 'completed earlier group remains traversable');
const revisedLocal = create({paper:revisedPolicy,embedded:false,saved:oldMidway});
assert.equal(revisedLocal.state().attemptId, oldMidway.attemptId, 'standalone local storage migrates as well');
revisedFinished.click('start-new-attempt');
assert.equal(revisedFinished.state().contentRevision, 2);
assert.notEqual(revisedFinished.state().attemptId, oldFinished.attemptId);
revisedFinished.answer('A'); revisedFinished.click('solution-hints'); revisedFinished.click('try-again'); revisedFinished.answer('E'); revisedFinished.click('similar-button');
assert.equal(revisedFinished.state().records[0].followups[0].sourceId, '2019-P2-Q01', 'new attempts use the replacement pool');
const invalidRevision = structuredClone(oldMidway); invalidRevision.contentRevision=99;
const futureRevision = create({paper:revisedPolicy}); futureRevision.resume(invalidRevision);
assert.equal(futureRevision.state().contentRevision, 2);
assert.notEqual(futureRevision.state().attemptId, oldMidway.attemptId, 'unsupported revision cannot masquerade as a known attempt');

// The learner can ask for knowledge without choosing, but checking requires an answer.
// Assistance never earns an independent first-answer mark or a solved-submission mark.
function assertSameResume(app, paper, reason) {
  const reloaded = create({paper}); reloaded.resume(app.state());
  assert.deepEqual(reloaded.state(), app.state(), reason);
  return reloaded;
}
const hintFirst = create({paper:policy}); hintFirst.resume(null);
hintFirst.click('give-hint');
assert.equal(hintFirst.state().records[0].first, 0);
assert.equal(hintFirst.state().records[0].firstKind, 'hint');
assert.equal(hintFirst.state().records[0].originalReviewed, false);
assert.equal(hintFirst.state().records[0].everSolved, false);
assert.equal(hintFirst.state().piecesShown, 1);
assert.equal(hintFirst.state().helpVisible, true);
assert.equal(hintFirst.state().solutionVisible, false);
assert.equal(hintFirst.state().selected, null);
assert.equal(hintFirst.messages.at(-1).progress.firstAttempted, 1);
assert.equal(hintFirst.messages.at(-1).progress.firstCorrect, 0);
assert.equal(hintFirst.messages.at(-1).progress.afterCorrect, 0);
assert.equal(hintFirst.element('next-exercise-button').disabled, true);
assertSameResume(hintFirst,policy,'hint-only work restores, even before the original has been reviewed');
hintFirst.click('try-again');
assert.equal(hintFirst.state().helpVisible, false);
assert.equal(hintFirst.state().solutionVisible, false);
hintFirst.click('give-hint');
assert.equal(hintFirst.state().piecesShown, 2, 'a second hint request from the question supplies the next knowledge piece');
hintFirst.click('try-again'); hintFirst.answer('E');
assert.equal(hintFirst.state().records[0].first, 0, 'a correct answer after hints does not become independent credit');
assert.equal(hintFirst.state().records[0].firstKind, 'hint');
assert.equal(hintFirst.state().records[0].everSolved, true);
assert.equal(hintFirst.messages.at(-1).progress.afterCorrect, 1);
assert.equal(hintFirst.state().solutionVisible, true);
assertSameResume(hintFirst,policy,'assisted correct original submission retains both scores and help provenance');
hintFirst.click('solution-hints');
assert.equal(hintFirst.state().piecesShown, 2, 'revisiting hints after the solution does not automatically reveal all steps');
assert.equal(hintFirst.state().solutionVisible, false);
assert.equal(hintFirst.state().helpVisible, true);
assertSameResume(hintFirst,policy,'returning from solution to help is a valid saved state');
hintFirst.click('try-again');
assert.equal(hintFirst.state().solutionVisible, false);
assert.equal(hintFirst.state().helpVisible, false);
assert.equal(hintFirst.element('check-answer').disabled,false);

const noChoice = create({paper:policy}); noChoice.resume(null);
const untouched = structuredClone(noChoice.state()); noChoice.check();
assert.deepEqual(noChoice.state(),untouched,'checking without a selected answer does not change scores or progress');
assert.equal(noChoice.state().records[0].first,null);
assert.equal(noChoice.element('solution').hidden,true);
assert.match(noChoice.element('feedback').textContent,/Choose your answer/);
noChoice.click('give-hint');
const hinted = structuredClone(noChoice.state()); noChoice.click('reveal-solution');
assert.deepEqual(noChoice.state(),hinted,'checking from hints still requires an answer');
assert.equal(noChoice.element('solution').hidden,true);
assert.equal(noChoice.state().helpVisible,true);
noChoice.click('try-again'); noChoice.answer('E');
assert.equal(noChoice.state().records[0].first,0);
assert.equal(noChoice.state().records[0].firstKind,'hint');
assert.equal(noChoice.messages.at(-1).progress.afterCorrect,1);
const localHintResume=create({paper:policy,embedded:false,saved:noChoice.state()});
assert.deepEqual(localHintResume.state(),noChoice.state(),'standalone saved assisted work restores');

const correctThenHints = create({paper:policy}); correctThenHints.resume(null); correctThenHints.answer('E');
assert.equal(correctThenHints.state().records[0].firstKind,'answer');
correctThenHints.click('solution-hints');
assert.equal(correctThenHints.state().records[0].first,1,'later recap requests never remove earned first-answer credit');
assert.equal(correctThenHints.state().records[0].firstKind,'answer');
assert.equal(correctThenHints.state().records[0].everSolved,true);
assert.equal(correctThenHints.state().records[0].completed,true);
correctThenHints.click('try-again'); correctThenHints.check();
assert.equal(correctThenHints.state().records[0].first,1);
assert.equal(correctThenHints.state().records[0].firstKind,'answer');
assertSameResume(correctThenHints,policy,'first-correct credit survives subsequent help and an empty check');

const helpedFollowups = create({paper:policy}); helpedFollowups.resume(null); helpedFollowups.answer('A');
assert.equal(helpedFollowups.state().records[0].firstKind,'answer');
assert.equal(helpedFollowups.state().solutionVisible,true,'wrong selected answer also opens its solution immediately');
helpedFollowups.click('similar-button'); helpedFollowups.click('give-hint');
assert.equal(helpedFollowups.state().records[0].practice,0);
assert.equal(helpedFollowups.state().records[0].practiceKind,'hint');
assert.equal(helpedFollowups.state().records[0].followups[0].first,0);
assert.equal(helpedFollowups.state().records[0].followups[0].firstKind,'hint');
assert.equal(helpedFollowups.state().records[0].followups[0].reviewed,false);
assertSameResume(helpedFollowups,policy,'active hinted followup restores before review');
helpedFollowups.click('try-again'); helpedFollowups.answer('D');
assert.equal(helpedFollowups.state().records[0].followups[0].firstKind,'hint');
assert.equal(helpedFollowups.state().records[0].followups[0].reviewed,true);
helpedFollowups.click('similar-button'); helpedFollowups.answer('A');
assert.equal(helpedFollowups.state().records[0].followups[1].firstKind,'answer');
assert.equal(helpedFollowups.messages.at(-1).progress.practiceCorrect,0);
assert.equal(helpedFollowups.messages.at(-1).progress.practiceAttempted,2);
helpedFollowups.click('similar-button'); helpedFollowups.answer('E');
assert.equal(helpedFollowups.state().records[0].followups[2].firstKind,'answer');
assert.equal(helpedFollowups.state().records[0].completed,true);
assert.equal(helpedFollowups.messages.at(-1).progress.practiceCorrect,1);
assert.equal(helpedFollowups.messages.at(-1).progress.practiceAttempted,3);
assert.equal(helpedFollowups.messages.at(-1).progress.afterCorrect,0,'assistance and followup success do not earn original solved credit');
assertSameResume(helpedFollowups,policy,'hinted and answered followup provenance restores unchanged');

const hintedPair = create(); hintedPair.resume(null); hintedPair.answer('E'); hintedPair.click('similar-button'); hintedPair.click('give-hint');
assert.equal(hintedPair.state().records[0].practiceKind,'hint','non-adaptive similar exercise tracks assistance too');
hintedPair.click('try-again'); hintedPair.answer('D');
assert.equal(hintedPair.state().records[0].practice,0);
assert.equal(hintedPair.state().records[0].completed,true);
assertSameResume(hintedPair,data,'non-adaptive assisted similar exercise state restores');

const oldKinds = structuredClone(threeMisses.state());
for(const r of oldKinds.records){delete r.firstKind;delete r.practiceKind;for(const f of r.followups)delete f.firstKind;}
const withKinds = create({paper:policy}); withKinds.resume(oldKinds);
assert.equal(withKinds.state().attemptId,oldKinds.attemptId,'adding provenance fields preserves historical attempt identity');
for(const r of withKinds.state().records){
  assert.equal(r.firstKind,r.first===null?null:'answer');
  assert.equal(r.practiceKind,r.practice===null?null:'answer');
  for(const f of r.followups)assert.equal(f.firstKind,f.first===null?null:'answer');
}
assert.equal(withKinds.messages.at(-1).progress.firstCorrect,threeMisses.messages.at(-1).progress.firstCorrect);
assert.equal(withKinds.messages.at(-1).progress.afterCorrect,threeMisses.messages.at(-1).progress.afterCorrect);
function assertRejectedProvenance(bad,reason){const attempt=create({paper:policy});attempt.resume(bad);assert.notEqual(attempt.state().attemptId,bad.attemptId,reason);}
const falseIndependent=structuredClone(correctThenHints.state());falseIndependent.records[0].firstKind='hint';
assertRejectedProvenance(falseIndependent,'assisted provenance cannot carry independent first-correct credit');
const unknownKind=structuredClone(noChoice.state());unknownKind.records[0].firstKind='unknown';
assertRejectedProvenance(unknownKind,'unknown provenance value is rejected');
const mismatchedKind=structuredClone(helpedFollowups.state());mismatchedKind.records[0].practiceKind='answer';
assertRejectedProvenance(mismatchedKind,'aggregate practice provenance must agree with its first followup');

// Navigation follows the submitted exercise, not compulsory followup completion.
function assertCannotAdvance(app, reason) {
  assert.equal(app.element('next-exercise-button').disabled, true, reason);
  const before = structuredClone(app.state());
  app.click('next-exercise-button');
  assert.deepEqual(app.state(), before, reason + ': the handler also refuses an unsubmitted exercise');
}
const unsubmitted = create({paper:policy}); unsubmitted.resume(null);
assertCannotAdvance(unsubmitted, 'an unanswered original cannot advance');
unsubmitted.check();
assertCannotAdvance(unsubmitted, 'checking without a choice cannot unlock Next');
unsubmitted.click('give-hint');
assertCannotAdvance(unsubmitted, 'a hint alone cannot unlock Next');
unsubmitted.click('try-again');
assertCannotAdvance(unsubmitted, 'returning from a hint requires an answer before Next');
unsubmitted.answer('A');
assert.equal(unsubmitted.element('next-exercise-button').disabled, false, 'a checked wrong original can advance');
assert.equal(unsubmitted.state().records[0].completed, false, 'allowing Next does not silently complete the group');
const firstSkippedAttempt = unsubmitted.state().attemptId;
unsubmitted.click('next-exercise-button');
assert.equal(unsubmitted.state().questionIndex, 1);
assert.equal(unsubmitted.state().records[0].completed, true);
assert.equal(unsubmitted.state().records[0].movedOn, true, 'explicitly continuing records why the group is complete');
assert.equal(unsubmitted.state().records[0].first, 0);
assert.equal(unsubmitted.state().records[0].firstKind, 'hint');
assert.equal(unsubmitted.state().records[0].everSolved, false);
assert.equal(unsubmitted.state().records[0].practice, null);
assert.equal(unsubmitted.state().records[0].followups.length, 0, 'skipping related practice does not fabricate an attempt');
assert.equal(unsubmitted.messages.at(-1).progress.firstCorrect, 0);
assert.equal(unsubmitted.messages.at(-1).progress.afterCorrect, 0);
assert.equal(unsubmitted.messages.at(-1).progress.practiceAttempted, 0);
const skipReload = assertSameResume(unsubmitted, policy, 'early continuation restores the next original and immutable scores');
assert.equal(skipReload.state().attemptId, firstSkippedAttempt);
assertCannotAdvance(skipReload, 'the next original still needs its own submitted answer');
skipReload.answer('D'); skipReload.click('next-exercise-button');
assert.equal(skipReload.state().finished, true, 'an early skipped group can coexist with normal policy completion');
assert.equal(skipReload.messages.at(-1).progress.firstCorrect, 1);
assert.equal(skipReload.messages.at(-1).progress.afterCorrect, 1);
assert.equal(skipReload.messages.at(-1).progress.practiceAttempted, 0);
assertSameResume(skipReload, policy, 'a finished attempt with early continuation restores');

const skipSimilar = create({paper:policy}); skipSimilar.resume(null);
skipSimilar.answer('A'); skipSimilar.click('similar-button');
assertCannotAdvance(skipSimilar, 'a newly started related exercise must be answered');
skipSimilar.click('give-hint');
assertCannotAdvance(skipSimilar, 'help on a related exercise does not count as reviewing its answer');
skipSimilar.click('try-again'); skipSimilar.answer('A');
assert.equal(skipSimilar.element('next-exercise-button').disabled, false, 'a checked wrong related exercise can advance');
assert.equal(skipSimilar.element('similar-button').hidden, false, 'another related exercise remains available before moving on');
skipSimilar.click('next-exercise-button');
assert.equal(skipSimilar.state().questionIndex, 1);
assert.equal(skipSimilar.state().records[0].movedOn, true);
assert.equal(skipSimilar.state().records[0].followups.length, 1);
assert.equal(skipSimilar.state().records[0].followups[0].reviewed, true);
assert.equal(skipSimilar.messages.at(-1).progress.firstCorrect, 0);
assert.equal(skipSimilar.messages.at(-1).progress.afterCorrect, 0);
assert.equal(skipSimilar.messages.at(-1).progress.practiceAttempted, 1);
assert.equal(skipSimilar.messages.at(-1).progress.practiceCorrect, 0);
assertSameResume(skipSimilar, policy, 'continuing after one missed related exercise restores without requiring all three');

const submittedRedo = create({paper:policy}); submittedRedo.resume(null); submittedRedo.answer('E');
assert.equal(submittedRedo.state().records[0].completed, true);
submittedRedo.click('redo-button');
assertCannotAdvance(submittedRedo, 'starting a redo requires an answer even when the group was already complete');
submittedRedo.check();
assertCannotAdvance(submittedRedo, 'an empty check during a redo cannot reuse a previous checked answer');
submittedRedo.answer('A');
assert.equal(submittedRedo.element('next-exercise-button').disabled, false, 'a checked redo may continue regardless of correctness');
submittedRedo.click('next-exercise-button');
assert.equal(submittedRedo.state().records[0].first, 1);
assert.equal(submittedRedo.state().records[0].everSolved, true);
assert.equal(submittedRedo.state().questionIndex, 1);
assertSameResume(submittedRedo, policy, 'redo then continuation preserves previously earned credit');

for (const letter of ['A', 'E']) {
  const previewNext = create(); previewNext.resume(null); previewNext.answer(letter);
  assert.equal(previewNext.element('next-exercise-button').disabled, false, 'the preview also permits continuing after checking an original');
  previewNext.click('next-exercise-button');
  assert.equal(previewNext.state().questionIndex, 1);
  assert.equal(previewNext.state().records[0].movedOn, true);
  assert.equal(previewNext.state().records[0].completed, true);
  assert.equal(previewNext.state().records[0].practice, null);
  assert.equal(previewNext.state().records[0].practiceReviewed, false);
  assert.equal(previewNext.messages.at(-1).progress.practiceAttempted, 0);
  assert.equal(previewNext.messages.at(-1).progress.firstCorrect, letter === 'E' ? 1 : 0);
  assert.equal(previewNext.messages.at(-1).progress.afterCorrect, letter === 'E' ? 1 : 0);
  assertSameResume(previewNext, data, 'preview continuation without similar practice restores');
  previewNext.answer('D'); previewNext.click('next-exercise-button');
  assert.equal(previewNext.state().finished, true);
  assert.equal(previewNext.messages.at(-1).progress.practiceAttempted, 0, 'finishing never invents preview practice scores');
  assertSameResume(previewNext, data, 'a preview finished without similar exercises restores');
}

const invalidMovedOnType = structuredClone(unsubmitted.state()); invalidMovedOnType.records[0].movedOn = 'yes';
assertRejectedProvenance(invalidMovedOnType, 'moved-on provenance must be boolean');
const uncheckedMovedOn = structuredClone(unsubmitted.state()); uncheckedMovedOn.records[0].originalReviewed = false;
assertRejectedProvenance(uncheckedMovedOn, 'moved-on completion requires a checked original');
const pendingMovedOn = structuredClone(skipSimilar.state()); pendingMovedOn.records[0].followups[0].reviewed = false; pendingMovedOn.records[0].practiceReviewed = false;
assertRejectedProvenance(pendingMovedOn, 'moved-on completion cannot conceal an unreviewed started followup');

// Exercise every published production plan, including reviewed two-follow-up
// groups. Prefer the actual current edition so the test also covers its legacy pool.
const planNames = fs.readdirSync(path.join(root, 'content')).filter(name => name.endsWith('-plan.json')).sort();
const editionManifestPath=path.join(root,'content/paper-editions.json');
const currentEditions=new Map(fs.existsSync(editionManifestPath)?JSON.parse(fs.readFileSync(editionManifestPath,'utf8')).editions.map(entry=>[entry.paperId,entry]):[]);
let readyPlansChecked = 0, productionFollowupsChecked = 0;
for (const name of planNames) {
  const planPath = path.join(root, 'content', name);
  if (!fs.existsSync(planPath)) continue;
  let plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const publishedPath = path.join(root, 'papers', `paper-${plan.metadata.paper}`, `${plan.metadata.id}.html`);
  if (!fs.existsSync(publishedPath)) continue; // An authoring plan is not a published paper.
  const currentEdition=currentEditions.get(plan.metadata.id);
  const frozen=currentEdition?await readFrozenEditionSource(root,plan.metadata.id,currentEdition.editionId):null;
  if(frozen)plan=frozen.plan;
  const bank=frozen?.bank.questions||JSON.parse(fs.readFileSync(path.join(root, 'content/official-question-bank.json'), 'utf8')).questions;
  const compiled = currentEdition
    ? JSON.parse(fs.readFileSync(path.join(root,currentEdition.href),'utf8').match(/<script\b[^>]*id="tmua-paper-data"[^>]*>([\s\S]*?)<\/script>/)[1])
    : {metadata:plan.metadata, questions:plan.groups.map(g => ({id:g.id,original:bank[g.originalId],similar:g.candidates.map(id=>bank[id]),...(Array.isArray(g.legacyCandidates)?{legacySimilar:g.legacyCandidates.map(id=>bank[id])}:{})}))};
  assert.equal(compiled.questions.length, 20, `${name}: full assessment has twenty originals`);
  const candidateIds = compiled.questions.flatMap(g => g.similar.map(q=>q.sourceId));
  assert(compiled.questions.every(g=>g.similar.length<=3), `${name}: every original has at most three followups`);
  if(plan.metadata.requiresThreeFollowups===true)assert(compiled.questions.every(g=>g.similar.length===3), `${name}: authoring plan requires three followups`);
  assert.deepEqual(compiled.questions.map(g=>g.similar.map(q=>q.sourceId)),plan.groups.map(g=>g.candidates),`${name}: test the published edition’s frozen reviewed candidate selections`);
  assert.equal(new Set(candidateIds).size, candidateIds.length, `${name}: every followup is distinct`);
  const originalsOnly = create({paper:compiled}); originalsOnly.resume(null);
  for (let index = 0; index < 20; index++) {
    const q = compiled.questions[index].original;
    assert.equal(originalsOnly.state().questionIndex, index);
    originalsOnly.answer(q.correct === 'A' ? 'B' : 'A');
    assert.equal(originalsOnly.element('next-exercise-button').disabled, false, `${name} Q${index + 1}: a checked miss can continue`);
    assert.equal(originalsOnly.element('similar-button').hidden, compiled.questions[index].similar.length===0, `${name} Q${index + 1}: only available related practice is offered`);
    originalsOnly.click('next-exercise-button');
    assert.equal(originalsOnly.state().records[index].movedOn===true, compiled.questions[index].similar.length>0);
    assert.equal(originalsOnly.state().records[index].completed, true);
    assert.equal(originalsOnly.state().records[index].followups.length, 0);
    assertSameResume(originalsOnly, compiled, `${name} Q${index + 1}: originals-only progress restores`);
  }
  const originalsScore = originalsOnly.messages.at(-1).progress;
  assert.equal(originalsScore.finished, true, `${name}: all twenty checked originals can finish without forced related exercises`);
  assert.equal(originalsScore.completed, 20);
  assert.equal(originalsScore.firstAttempted, 20);
  assert.equal(originalsScore.firstCorrect, 0);
  assert.equal(originalsScore.afterKnown, true);
  assert.equal(originalsScore.afterCorrect, 0);
  assert.equal(originalsScore.practiceAttempted, 0);
  assert.equal(originalsScore.practiceCorrect, 0);
  const run = create({paper:compiled}); run.resume(null);
  const seen = new Set();
  const exerciseInRun = () => {const s=run.state(),g=compiled.questions[s.questionIndex];return s.mode==='original'?g.original:g.similar[s.similarIndex];};
  const missAndReveal = () => {
    const q=exerciseInRun();run.answer(q.correct==='A'?'B':'A');
    assert.equal(run.state().solutionVisible,true);
  };
  for(let i=0;i<20;i++) {
    assert.equal(run.state().questionIndex,i);
    missAndReveal();
    const followupCount=compiled.questions[i].similar.length;
    assert.equal(run.state().records[i].completed,followupCount===0, `${name} Q${i+1}: a miss leaves only available followup work`);
    for(let followup=0;followup<followupCount;followup++) {
      assert.equal(run.element('similar-button').hidden,false, `${name} Q${i+1}: followup ${followup+1} available`);
      run.click('similar-button');
      const q=exerciseInRun();
      assert(!seen.has(q.sourceId)); seen.add(q.sourceId);
      assert.equal(run.element('solution').hidden,true);
      missAndReveal();
      assert.equal(run.state().records[i].completed,followup===followupCount-1);
    }
    assert.equal(run.element('similar-button').hidden,true);
    run.click('redo-button');
    assert.equal(run.state().mode,'original');
    run.answer(compiled.questions[i].original.correct);
    const reloaded=create({paper:compiled});reloaded.resume(run.state());
    assert.deepEqual(reloaded.state(),run.state(),`${name} Q${i+1}: retry and all followup scores restore`);
    run.click('next-exercise-button');
  }
  const p=run.messages.at(-1).progress;
  assert.equal(p.finished,true); assert.equal(p.firstCorrect,0); assert.equal(p.firstAttempted,20);
  assert.equal(p.afterKnown,true); assert.equal(p.afterCorrect,20);
  assert.equal(p.practiceCorrect,0); assert.equal(p.practiceAttempted,candidateIds.length); assert.equal(seen.size,candidateIds.length);
  if(compiled.metadata.contentRevision===2 && compiled.questions.every(g=>Array.isArray(g.legacySimilar))) {
    const oldPaper={metadata:{...compiled.metadata,contentRevision:1},questions:compiled.questions.map(g=>({...g,similar:g.legacySimilar}))};
    const oldRun=create({paper:oldPaper});oldRun.resume(null);
    for(let i=0;i<20;i++) {
      const original=oldPaper.questions[i].original;
      oldRun.answer(original.correct==='A'?'B':'A');
      assert.equal(oldRun.state().solutionVisible,true);
      while(!oldRun.state().records[i].completed) {
        oldRun.click('similar-button');
        const followup=oldPaper.questions[i].similar[oldRun.state().similarIndex];
        oldRun.answer(followup.correct==='A'?'B':'A');
        const beforeUpdate=oldRun.state();delete beforeUpdate.contentRevision;
        const migratedMidway=create({paper:compiled});migratedMidway.resume(beforeUpdate);
        assert.equal(migratedMidway.state().attemptId,beforeUpdate.attemptId,`${name} Q${i+1}: real historical active followup survives`);
        assert.deepEqual(migratedMidway.state().records,beforeUpdate.records);
        assert.equal(oldRun.state().solutionVisible,true);
      }
      oldRun.click('next-exercise-button');
    }
    const oldState=oldRun.state();delete oldState.contentRevision;
    const migratedFull=create({paper:compiled});migratedFull.resume(oldState);
    assert.equal(migratedFull.state().finished,true,`${name}: actual previous completed paper remains complete`);
    assert.equal(migratedFull.state().attemptId,oldState.attemptId);
    assert.deepEqual(migratedFull.state().records,oldState.records);
    assert.equal(migratedFull.messages.at(-1).progress.afterCorrect,0,'solution views must remain zero after migration');
    migratedFull.click('start-new-attempt');
    assert.equal(migratedFull.state().contentRevision,2);
    assert.notEqual(migratedFull.state().attemptId,oldState.attemptId);
  }
  readyPlansChecked++;
  productionFollowupsChecked+=candidateIds.length;
}
if (process.env.TMUA_REQUIRE_READY_PLANS) assert.equal(readyPlansChecked, Number(process.env.TMUA_REQUIRE_READY_PLANS), 'requested production readiness gate must run all required plans');
console.log(`PASS: player/score regressions; saved revision-1 pools survive revision-2 updates; ${readyPlansChecked} production plans checked through ${readyPlansChecked*20} original misses, ${productionFollowupsChecked} unique followup misses and ${readyPlansChecked*20} successful original retries.`);
