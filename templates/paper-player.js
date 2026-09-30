(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('tmua-paper-data').textContent);
  const meta = data.metadata;
  const $ = id => document.getElementById(id);
  const letters = 'ABCDEFGHIJ';
  const embedded = window.parent !== window;
  const storageKey = `tmua-paper:${meta.id}:v${meta.version}`;
  const emptyRecord = () => ({first: null, practice: null, originalReviewed: false, practiceReviewed: false, completed: false});
  const fresh = () => ({version: 1, questionIndex: 0, mode: 'original', similarIndex: 0, piecesShown: 0, helpVisible: false, solutionVisible: false, selected: null, lastOutcome: null, records: data.questions.map(emptyRecord), finished: false, summaryVisible: false});
  let state = fresh();
  let userActed = false;
  let receivedResume = false;
  const group = () => data.questions[state.questionIndex];
  const exercise = () => state.mode === 'original' ? group().original : group().similar[state.similarIndex];
  const record = () => state.records[state.questionIndex];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const display = value => String(value).replace(/^-/, '−');
  const optionText = option => typeof option === 'object' ? option.text : display(option);
  const optionHTML = option => typeof option === 'object' ? option.html : esc(display(option));
  const focus = id => requestAnimationFrame(() => { $(id).scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'}); $(id).focus({preventScroll: true}); });
  const binary = value => value === null || value === 0 || value === 1;

  function validateState(candidate) {
    if (!candidate || typeof candidate !== 'object' || candidate.version !== 1) return null;
    const c = candidate;
    if (!Number.isInteger(c.questionIndex) || c.questionIndex < 0 || c.questionIndex >= data.questions.length) return null;
    if (!['original', 'similar'].includes(c.mode) || !Number.isInteger(c.similarIndex) || c.similarIndex < 0 || c.similarIndex >= data.questions[c.questionIndex].similar.length) return null;
    if (!Array.isArray(c.records) || c.records.length !== data.questions.length) return null;
    for (const r of c.records) {
      if (!r || !binary(r.first) || !binary(r.practice) || ['originalReviewed', 'practiceReviewed', 'completed'].some(k => typeof r[k] !== 'boolean')) return null;
      if (r.originalReviewed && r.first === null || r.practice !== null && !r.originalReviewed || r.practiceReviewed && r.practice === null) return null;
      if (r.completed !== (r.originalReviewed && r.practiceReviewed)) return null;
    }
    if (c.records.slice(0, c.questionIndex).some(r => !r.completed)) return null;
    if (c.records.slice(c.questionIndex + 1).some(r => r.first !== null || r.practice !== null || r.completed)) return null;
    const q = c.mode === 'original' ? data.questions[c.questionIndex].original : data.questions[c.questionIndex].similar[c.similarIndex];
    const r = c.records[c.questionIndex];
    if (c.mode === 'similar' && !r.originalReviewed) return null;
    if (!Number.isInteger(c.piecesShown) || c.piecesShown < 0 || c.piecesShown > q.hints.length) return null;
    if (['helpVisible', 'solutionVisible', 'finished'].some(k => typeof c[k] !== 'boolean')) return null;
    const summaryVisible = c.summaryVisible === undefined ? c.finished : c.summaryVisible;
    if (typeof summaryVisible !== 'boolean' || summaryVisible && !c.finished) return null;
    if (c.selected !== null && !letters.slice(0, q.options.length).includes(c.selected) || c.selected !== null && (typeof c.selected !== 'string' || c.selected.length !== 1)) return null;
    if (![null, 'correct', 'incorrect'].includes(c.lastOutcome)) return null;
    if (c.helpVisible && (!c.piecesShown || c.solutionVisible)) return null;
    if ((c.solutionVisible || c.piecesShown || c.lastOutcome) && (c.mode === 'original' ? r.first : r.practice) === null) return null;
    if (c.solutionVisible && !(c.mode === 'original' ? r.originalReviewed : r.practiceReviewed)) return null;
    if (c.finished && (c.questionIndex !== data.questions.length - 1 || !c.records.every(r => r.completed))) return null;
    return {version: 1, questionIndex: c.questionIndex, mode: c.mode, similarIndex: c.similarIndex, piecesShown: c.piecesShown, helpVisible: c.helpVisible, solutionVisible: c.solutionVisible, selected: c.selected, lastOutcome: c.lastOutcome, records: c.records.map(r => ({first: r.first, practice: r.practice, originalReviewed: r.originalReviewed, practiceReviewed: r.practiceReviewed, completed: r.completed})), finished: c.finished, summaryVisible};
  }

  function progress() {
    return {questionIndex: state.questionIndex, completed: state.records.filter(r => r.completed).length, total: data.questions.length, firstCorrect: state.records.reduce((n, r) => n + (r.first || 0), 0), firstAttempted: state.records.filter(r => r.first !== null).length, practiceCorrect: state.records.reduce((n, r) => n + (r.practice || 0), 0), practiceAttempted: state.records.filter(r => r.practice !== null).length, finished: state.finished};
  }
  function save() {
    if (embedded) window.parent.postMessage({type: 'tmua-progress', paperId: meta.id, progress: progress(), state}, '*');
    else {
      try { localStorage.setItem(storageKey, JSON.stringify(state)); }
      catch (_) { $('save-note').textContent = 'Progress can be kept while this page stays open.'; }
    }
  }
  function scoreHTML(first, practice) {
    return `<div><span>First attempt · original</span><strong>${first}</strong></div><div><span>First attempt · similar</span><strong>${practice}</strong></div>`;
  }
  function render() {
    const q = exercise(), r = record(), p = progress();
    $('exercise-label').textContent = `Paper ${meta.paper} · ${state.mode === 'similar' ? 'Similar exercise' : 'Question ' + (state.questionIndex + 1)}`;
    $('position').textContent = state.finished ? `${p.total} of ${p.total} question pairs completed` : `Question ${state.questionIndex + 1} of ${p.total} · ${p.completed} completed`;
    $('progress-fill').style.width = `${p.completed / p.total * 100}%`;
    $('practice').hidden = state.summaryVisible;
    $('finished').hidden = !state.summaryVisible;
    $('question-text').innerHTML = q.lead;
    $('question-tail').innerHTML = q.tail || '';
    $('question-tail').hidden = !q.tail;
    $('formula').innerHTML = q.fallback || '';
    $('formula').hidden = !q.fallback;
    $('formula').setAttribute('aria-label', q.formulaLabel || 'Question formula');
    $('choices').innerHTML = q.options.map((option, i) => `<label class="choice"><input type="radio" name="answer" value="${letters[i]}" aria-label="${letters[i]}. ${esc(optionText(option))}"${state.selected === letters[i] ? ' checked' : ''}${state.solutionVisible ? ' disabled' : ''}><strong aria-hidden="true">${letters[i]}</strong><span aria-hidden="true">${optionHTML(option)}</span></label>`).join('');
    $('answer-form').querySelector('button').disabled = state.solutionVisible;
    $('feedback').hidden = state.lastOutcome === null;
    $('feedback').className = 'feedback ' + (state.lastOutcome === 'correct' ? 'good' : 'bad');
    $('feedback').textContent = state.lastOutcome === 'correct' ? 'Correct. Recap the knowledge steps and their pitfalls below.' : `That answer is incorrect. ${state.piecesShown < q.hints.length ? `Help step ${state.piecesShown} is ready below.` : 'You have all the help steps.'} Work on paper, then try again.`;
    $('review').hidden = !state.helpVisible;
    $('knowledge-list').innerHTML = q.hints.slice(0, state.piecesShown).map((h, i) => `<div class="knowledge" id="knowledge-${i + 1}" tabindex="-1"><h3>Help step ${i + 1} · ${esc(h.title)}</h3><p>${h.body}</p><p class="pitfall"><strong>Watch for:</strong> ${h.pitfall}</p><small>${h.pause}</small></div>`).join('');
    $('next-piece').hidden = state.piecesShown >= q.hints.length;
    $('reveal-solution').hidden = state.piecesShown < q.hints.length;
    $('solution').hidden = !state.solutionVisible;
    const correctOption = q.options[letters.indexOf(q.correct)];
    $('correct-answer').innerHTML = `<span class="sr-only">${q.correct} · ${esc(optionText(correctOption))}</span><span aria-hidden="true">${q.correct} · ${optionHTML(correctOption)}</span>`;
    $('knowledge-recap').innerHTML = '<h3>The knowledge steps</h3>' + q.hints.map((h, i) => `<div class="recap-step"><div class="recap-number">${i + 1}</div><div><h4>${esc(h.title)}</h4><p>${h.recap}</p><p class="pitfall"><strong>Watch for:</strong> ${h.pitfall}</p></div></div>`).join('');
    $('solution-content').innerHTML = q.solution;
    $('attribution').innerHTML = q.source || '';
    $('attribution').hidden = !q.source;
    $('score-summary').hidden = !r.completed;
    $('score-summary').innerHTML = `<h3>Question pair complete</h3><div class="score-grid">${scoreHTML(`${r.first}/1`, `${r.practice}/1`)}</div><p>First answers are recorded once. Retries, help and extra similar exercises do not change these scores.</p>`;
    $('next-exercise-button').disabled = !r.completed;
    $('next-exercise-button').textContent = state.questionIndex === data.questions.length - 1 ? 'Finish paper' : 'Next exercise';
    $('completion-note').hidden = r.completed;
    $('completion-note').textContent = state.questionIndex === data.questions.length - 1 ? 'Complete one similar exercise to finish the paper.' : 'Complete one similar exercise to unlock the next question.';
    $('overall-scores').innerHTML = scoreHTML(`${p.firstCorrect}/${p.total}`, `${p.practiceCorrect}/${p.total}`);
    $('results-table').innerHTML = '<thead><tr><th>Question</th><th>Original first answer</th><th>Similar first answer</th></tr></thead><tbody>' + state.records.map((item, i) => `<tr><td>${i + 1}</td><td>${item.first ? 'Correct' : 'Incorrect'}</td><td>${item.practice ? 'Correct' : 'Incorrect'}</td></tr>`).join('') + '</tbody>';
  }
  function commit(focusId) { userActed = true; render(); save(); if (focusId) focus(focusId); }
  function resetAttempt() { state.piecesShown = 0; state.helpVisible = false; state.solutionVisible = false; state.selected = null; state.lastOutcome = null; state.summaryVisible = false; }
  function openSolution() {
    state.helpVisible = false;
    state.solutionVisible = true;
    if (state.mode === 'original') record().originalReviewed = true;
    else { record().practiceReviewed = true; record().completed = true; }
    commit('solution');
  }
  $('answer-form').addEventListener('change', event => { if (event.target.name === 'answer') { state.selected = event.target.value; userActed = true; save(); } });
  $('answer-form').addEventListener('submit', event => {
    event.preventDefault();
    if (state.solutionVisible) return;
    const chosen = $('answer-form').querySelector('input:checked');
    if (!chosen) {
      $('feedback').textContent = 'Choose an answer before checking.';
      $('feedback').className = 'feedback neutral'; $('feedback').hidden = false;
      return;
    }
    const correct = chosen.value === exercise().correct;
    const scoreKey = state.mode === 'original' ? 'first' : 'practice';
    if (record()[scoreKey] === null) record()[scoreKey] = correct ? 1 : 0;
    state.lastOutcome = correct ? 'correct' : 'incorrect';
    state.selected = chosen.value;
    if (correct) openSolution();
    else {
      state.selected = null;
      state.piecesShown = Math.min(state.piecesShown + 1, exercise().hints.length);
      state.helpVisible = true;
      commit(`knowledge-${state.piecesShown}`);
    }
  });
  $('next-piece').addEventListener('click', () => {
    if (!state.helpVisible || state.piecesShown >= exercise().hints.length) return;
    state.piecesShown++; commit(`knowledge-${state.piecesShown}`);
  });
  $('try-again').addEventListener('click', () => { state.helpVisible = false; state.lastOutcome = null; commit('question-section'); });
  $('reveal-solution').addEventListener('click', () => { if (state.helpVisible && state.piecesShown === exercise().hints.length) { state.lastOutcome = null; openSolution(); } });
  $('redo-button').addEventListener('click', () => { if (!state.solutionVisible) return; resetAttempt(); commit('question-section'); });
  $('similar-button').addEventListener('click', () => {
    if (!state.solutionVisible || !record().originalReviewed) return;
    state.similarIndex = state.mode === 'similar' ? (state.similarIndex + 1) % group().similar.length : 0;
    state.mode = 'similar'; resetAttempt(); commit('question-section');
  });
  $('next-exercise-button').addEventListener('click', () => {
    if (!record().completed) return;
    if (state.questionIndex === data.questions.length - 1) { state.finished = true; state.summaryVisible = true; commit('finished'); }
    else { state.questionIndex++; state.mode = 'original'; state.similarIndex = 0; resetAttempt(); commit('question-section'); }
  });
  $('review-last').addEventListener('click', () => { state.summaryVisible = false; state.solutionVisible = true; state.helpVisible = false; commit('solution'); });
  $('return-library').hidden = !embedded;
  $('return-library').addEventListener('click', () => window.parent.postMessage({type: 'tmua-exit', paperId: meta.id}, '*'));
  window.addEventListener('message', event => {
    if (!embedded || event.source !== window.parent || !event.data || event.data.type !== 'tmua-resume' || event.data.paperId !== meta.id || receivedResume) return;
    receivedResume = true;
    if (userActed) return;
    const restored = validateState(event.data.state);
    if (restored) state = restored;
    render(); save();
  });
  if (!embedded) {
    try { const restored = validateState(JSON.parse(localStorage.getItem(storageKey))); if (restored) state = restored; }
    catch (_) { $('save-note').textContent = 'Progress can be kept while this page stays open.'; }
  }
  render();
  if (embedded) window.parent.postMessage({type: 'tmua-ready', paperId: meta.id}, '*');
})();
