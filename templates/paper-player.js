(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('tmua-paper-data').textContent);
  const meta = data.metadata;
  const $ = id => document.getElementById(id);
  const letters = 'ABCDEFGHIJ';
  const adaptive = meta.practicePolicy === 'after-miss-up-to-3';
  const contentRevision = Number.isInteger(meta.contentRevision) && meta.contentRevision > 0 ? meta.contentRevision : 1;
  const embedded = window.parent !== window;
  const storageKey = `tmua-paper:${meta.id}:v${meta.version}`;
  function newAttemptId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const emptyRecord = () => ({first: null, firstKind: null, practice: null, practiceKind: null, everSolved: false, originalReviewed: false, practiceReviewed: false, completed: false, ...(adaptive ? {followups: []} : {})});
  const fresh = () => ({version: 1, contentRevision, attemptId: newAttemptId(), startedAt: new Date().toISOString(), questionIndex: 0, mode: 'original', similarIndex: 0, piecesShown: 0, helpVisible: false, solutionVisible: false, selected: null, lastOutcome: null, records: data.questions.map(emptyRecord), finished: false, summaryVisible: false});
  let state = fresh();
  let userActed = false;
  let receivedResume = false;
  const group = () => data.questions[state.questionIndex];
  // Keep a saved attempt on the question pool it began with. A fresh attempt uses the current pool.
  const similarPool = (index = state.questionIndex, revision = state.contentRevision) => revision === contentRevision ? data.questions[index].similar : data.questions[index].legacySimilar;
  const exercise = () => state.mode === 'original' ? group().original : similarPool()[state.similarIndex];
  const record = () => state.records[state.questionIndex];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const display = value => String(value).replace(/^-/, '−');
  const optionText = option => typeof option === 'object' ? option.text : display(option);
  const optionHTML = option => typeof option === 'object' ? option.html : esc(display(option));
  const focus = id => requestAnimationFrame(() => { $(id).scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'}); $(id).focus({preventScroll: true}); });
  const binary = value => value === null || value === 0 || value === 1;
  const firstKind = (value, kind) => kind === undefined ? (value === null ? null : 'answer') : kind;
  const validKind = (value, kind) => value === null ? kind === null : ['answer', 'hint'].includes(kind) && (kind === 'answer' || value === 0);
  function recordFirst(result, kind) {
    const r = record();
    if (adaptive && state.mode === 'similar') {
      const f = currentFollowup();
      if (f.first === null) { f.first = result; f.firstKind = kind; }
      r.practice = r.followups[0].first;
      r.practiceKind = r.followups[0].firstKind;
    } else {
      const key = state.mode === 'original' ? 'first' : 'practice';
      const kindKey = state.mode === 'original' ? 'firstKind' : 'practiceKind';
      if (r[key] === null) { r[key] = result; r[kindKey] = kind; }
    }
  }
  const currentFollowup = () => record().followups.find(item => item.index === state.similarIndex);
  const sourceLabel = q => {
    const match = /^(20[0-9]{2}|SPEC|specimen)-P([12])-Q(\d{2})$/.exec(q.sourceId || '');
    return match ? `TMUA ${['SPEC', 'specimen'].includes(match[1]) ? 'Specimen' : match[1]} · Paper ${match[2]} · Question ${Number(match[3])}` : q.label;
  };
  function nextCandidate(index = state.questionIndex, records = state.records, revision = state.contentRevision) {
    const seen = new Set(data.questions.slice(0, index + 1).map(item => item.original.sourceId));
    for (const r of records) for (const followup of r.followups || []) seen.add(followup.sourceId);
    return similarPool(index, revision).findIndex(q => !seen.has(q.sourceId));
  }
  function policyComplete(index = state.questionIndex, records = state.records, revision = state.contentRevision) {
    const r = records[index];
    if (!r.originalReviewed) return false;
    if (r.movedOn === true) return r.followups.every(item => item.reviewed);
    if (r.first === 1) return true;
    return r.followups.every(item => item.reviewed) && (r.followups.some(item => item.first === 1) || r.followups.length >= 3 || nextCandidate(index, records, revision) < 0);
  }
  function canOfferFollowup() {
    const r = record();
    return r.originalReviewed && r.first === 0 && !r.completed && r.followups.length < 3 && r.followups.every(item => item.reviewed && item.first === 0) && nextCandidate() >= 0;
  }

  function validateState(candidate) {
    if (!candidate || typeof candidate !== 'object' || candidate.version !== 1) return null;
    const c = candidate;
    const revision = c.contentRevision === undefined ? 1 : c.contentRevision;
    if (!Number.isInteger(revision) || revision < 1 || (revision !== contentRevision && (revision !== 1 || !data.questions.every(q => Array.isArray(q.legacySimilar))))) return null;
    const legacyAttempt = c.attemptId === undefined && c.startedAt === undefined;
    if (!legacyAttempt && (typeof c.attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.attemptId) || typeof c.startedAt !== 'string' || !Number.isFinite(Date.parse(c.startedAt)) || new Date(c.startedAt).toISOString() !== c.startedAt)) return null;
    if (!Number.isInteger(c.questionIndex) || c.questionIndex < 0 || c.questionIndex >= data.questions.length) return null;
    if (!['original', 'similar'].includes(c.mode) || !Number.isInteger(c.similarIndex) || c.similarIndex < 0 || (c.mode === 'similar' && c.similarIndex >= similarPool(c.questionIndex, revision).length) || (c.mode === 'original' && c.similarIndex !== 0)) return null;
    if (!Array.isArray(c.records) || c.records.length !== data.questions.length) return null;
    const seenFollowups = new Set();
    const solved = [];
    for (const [index, r] of c.records.entries()) {
      if (!r || !binary(r.first) || !binary(r.practice) || ['originalReviewed', 'practiceReviewed', 'completed'].some(k => typeof r[k] !== 'boolean')) return null;
      if (!validKind(r.first, firstKind(r.first, r.firstKind)) || !validKind(r.practice, firstKind(r.practice, r.practiceKind))) return null;
      const everSolved = r.everSolved === undefined ? (r.first === 1 ? true : r.first === 0 ? null : false) : r.everSolved;
      if (![true, false, null].includes(everSolved) || (r.first === 1 && everSolved !== true) || (r.first === null && everSolved !== false)) return null;
      solved.push(everSolved);
      if (r.movedOn !== undefined && (r.movedOn !== true || !r.originalReviewed || !r.completed)) return null;
      if (r.originalReviewed && r.first === null || r.practice !== null && !r.originalReviewed || r.practiceReviewed && r.practice === null) return null;
      if (adaptive) {
        if (!Array.isArray(r.followups) || r.followups.length > 3 || (r.followups.length && (!r.originalReviewed || r.first !== 0))) return null;
        for (const [position, f] of r.followups.entries()) {
          if (!f || !Number.isInteger(f.index) || f.index < 0 || f.index >= similarPool(index, revision).length || !binary(f.first) || typeof f.reviewed !== 'boolean' || (f.reviewed && f.first === null)) return null;
          if (!validKind(f.first, firstKind(f.first, f.firstKind))) return null;
          if (f.sourceId !== similarPool(index, revision)[f.index].sourceId || seenFollowups.has(f.sourceId) || data.questions.slice(0, index + 1).some(item => item.original.sourceId === f.sourceId)) return null;
          if (position < r.followups.length - 1 && (!f.reviewed || f.first !== 0)) return null;
          seenFollowups.add(f.sourceId);
        }
        if (firstKind(r.practice, r.practiceKind) !== (r.followups[0] ? firstKind(r.followups[0].first, r.followups[0].firstKind) : null)) return null;
        if (r.practice !== (r.followups[0]?.first ?? null) || r.practiceReviewed !== Boolean(r.followups[0]?.reviewed)) return null;
      } else {
        if (r.movedOn === true && r.practice !== null && !r.practiceReviewed) return null;
        if (r.completed !== (r.originalReviewed && (r.practiceReviewed || r.movedOn === true))) return null;
      }
    }
    if (adaptive && c.records.some((r, index) => r.completed !== policyComplete(index, c.records, revision))) return null;
    if (c.records.slice(0, c.questionIndex).some(r => !r.completed)) return null;
    if (c.records.slice(c.questionIndex + 1).some(r => r.first !== null || r.practice !== null || r.completed)) return null;
    const q = c.mode === 'original' ? data.questions[c.questionIndex].original : similarPool(c.questionIndex, revision)[c.similarIndex];
    const r = c.records[c.questionIndex];
    if (c.mode === 'similar' && !r.originalReviewed) return null;
    const followup = adaptive && c.mode === 'similar' ? r.followups.at(-1) : null;
    if (adaptive && ((c.mode === 'similar' && (!followup || followup.index !== c.similarIndex)) || (c.mode === 'original' && r.followups.some(f => !f.reviewed)))) return null;
    if (!Number.isInteger(c.piecesShown) || c.piecesShown < 0 || c.piecesShown > q.hints.length) return null;
    if (['helpVisible', 'solutionVisible', 'finished'].some(k => typeof c[k] !== 'boolean')) return null;
    const summaryVisible = c.summaryVisible === undefined ? c.finished : c.summaryVisible;
    if (typeof summaryVisible !== 'boolean' || summaryVisible && !c.finished) return null;
    if (c.selected !== null && !letters.slice(0, q.options.length).includes(c.selected) || c.selected !== null && (typeof c.selected !== 'string' || c.selected.length !== 1)) return null;
    if (![null, 'correct', 'incorrect'].includes(c.lastOutcome)) return null;
    if (c.helpVisible && (!c.piecesShown || c.solutionVisible)) return null;
    if ((c.solutionVisible || c.piecesShown || c.lastOutcome) && (c.mode === 'original' ? r.first : adaptive ? followup.first : r.practice) === null) return null;
    if (c.solutionVisible && !(c.mode === 'original' ? r.originalReviewed : adaptive ? followup.reviewed : r.practiceReviewed)) return null;
    if (c.finished && (c.questionIndex !== data.questions.length - 1 || !c.records.every(r => r.completed))) return null;
    return {version: 1, contentRevision: revision, attemptId: legacyAttempt ? state.attemptId : c.attemptId, startedAt: legacyAttempt ? state.startedAt : c.startedAt, questionIndex: c.questionIndex, mode: c.mode, similarIndex: c.similarIndex, piecesShown: c.piecesShown, helpVisible: c.helpVisible, solutionVisible: c.solutionVisible, selected: c.selected, lastOutcome: c.lastOutcome, records: c.records.map((r, index) => ({first: r.first, firstKind: firstKind(r.first, r.firstKind), practice: r.practice, practiceKind: firstKind(r.practice, r.practiceKind), everSolved: solved[index], originalReviewed: r.originalReviewed, practiceReviewed: r.practiceReviewed, completed: r.completed, ...(r.movedOn === true ? {movedOn: true} : {}), ...(adaptive ? {followups: r.followups.map(f => ({index: f.index, sourceId: f.sourceId, first: f.first, firstKind: firstKind(f.first, f.firstKind), reviewed: f.reviewed}))} : {})})), finished: c.finished, summaryVisible};
  }

  function progress() {
    const attempts = adaptive ? state.records.flatMap(r => r.followups.map(f => f.first)) : state.records.map(r => r.practice);
    const afterKnown = state.records.every(r => r.everSolved !== null);
    return {attemptId: state.attemptId, startedAt: state.startedAt, questionIndex: state.questionIndex, completed: state.records.filter(r => r.completed).length, total: data.questions.length, firstCorrect: state.records.reduce((n, r) => n + (r.first || 0), 0), firstAttempted: state.records.filter(r => r.first !== null).length, afterCorrect: afterKnown ? state.records.filter(r => r.everSolved === true).length : null, afterKnown, practiceCorrect: attempts.reduce((n, first) => n + (first || 0), 0), practiceAttempted: attempts.filter(first => first !== null).length, finished: state.finished, ...(adaptive ? {recovered: state.records.filter(r => r.first === 0 && r.followups.some(f => f.first === 1)).length} : {})};
  }
  function save() {
    if (embedded) window.parent.postMessage({type: 'tmua-progress', paperId: meta.id, progress: progress(), state}, '*');
    else {
      try { localStorage.setItem(storageKey, JSON.stringify(state)); }
      catch (_) { $('save-note').textContent = 'Progress can be kept while this page stays open.'; }
    }
  }
  function scoreHTML(first, after, practice) {
    return `<div><span>First attempt · on your own</span><strong>${first}</strong></div><div><span>After practice · including retries</span><strong>${after}</strong></div><div class="similar-score"><span>Similar exercises · first attempts</span><strong>${practice}</strong></div>`;
  }
  function recallHTML(hint) {
    return (hint.recall || []).map(lesson => {
      if (lesson.kind === 'additional') {
        return `<aside class="lesson-recall" data-lesson-id="${esc(lesson.lessonId)}"><p class="recall-label">New learning · Paper ${esc(lesson.paper)}</p><p class="recall-title">${esc(lesson.title)}</p><p class="recall-reminder">${lesson.reminder}</p></aside>`;
      }
      const section = /^method/i.test(lesson.sourceLabel || '') ? 'Section' : 'Lesson';
      return `<aside class="lesson-recall" data-lesson-id="${esc(lesson.lessonId)}"><p class="recall-label">Remember · Paper ${esc(lesson.paper)} · Booklet ${esc(lesson.booklet)} · ${section} ${esc(lesson.number)}</p><p class="recall-title">${esc(lesson.title)} <span class="recall-page">PDF p. ${esc(lesson.pdfPage)}</span></p><p class="recall-reminder">${lesson.reminder}</p></aside>`;
    }).join('');
  }
  function recapHTML(q) {
    return '<h3>The knowledge steps</h3>' + q.hints.map((h, i) => `<div class="recap-step"><div class="recap-number">${i + 1}</div><div><h4>${esc(h.title)}</h4><p>${h.recap}</p>${recallHTML(h)}<p class="pitfall"><strong>Watch for:</strong> ${h.pitfall}</p></div></div>`).join('');
  }
  function answerHTML(q) {
    const option = q.options[letters.indexOf(q.correct)];
    if (optionText(option).trim() === q.correct) return `Correct answer: ${q.correct}`;
    return `<span class="sr-only">${q.correct} · ${esc(optionText(option))}</span><span aria-hidden="true">${q.correct} · ${optionHTML(option)}</span>`;
  }
  function emitViewState() {
    document.dispatchEvent(new CustomEvent('tmua-render', {detail: {questionIndex: state.questionIndex, total: data.questions.length, completed: state.records.filter(r => r.completed).length, mode: state.mode, source: sourceLabel(exercise()), records: state.records.map(r => ({first: r.first, completed: r.completed})), finished: state.finished, summaryVisible: state.summaryVisible}}));
  }
  function render() {
    const q = exercise(), r = record(), p = progress();
    $('exercise-label').textContent = q.sourceId ? `${state.mode === 'similar' ? `Similar ${adaptive ? r.followups.length + ' · ' : 'exercise · '}` : ''}${sourceLabel(q)}` : `Paper ${meta.paper} · ${state.mode === 'similar' ? 'Similar exercise' : 'Question ' + (state.questionIndex + 1)}`;
    $('position').textContent = state.finished ? `${p.total} of ${p.total} questions completed` : `Question ${state.questionIndex + 1} of ${p.total} · ${p.completed} completed`;
    $('progress-fill').style.width = `${p.completed / p.total * 100}%`;
    $('practice').hidden = state.summaryVisible;
    $('finished').hidden = !state.summaryVisible;
    $('question-text').innerHTML = q.lead;
    $('question-tail').innerHTML = q.tail || '';
    $('question-tail').hidden = !q.tail;
    $('formula').innerHTML = q.fallback || '';
    $('formula').hidden = !q.fallback;
    $('formula').setAttribute('aria-label', q.formulaLabel || 'Question formula');
    $('choices').innerHTML = q.options.map((option, i) => `<label class="choice"><input type="radio" name="answer" value="${letters[i]}" aria-label="${optionText(option).trim() === letters[i] ? "Answer " + letters[i] : letters[i] + ". " + esc(optionText(option))}"${state.selected === letters[i] ? ' checked' : ''}${state.solutionVisible ? ' disabled' : ''}><strong aria-hidden="true">${letters[i]}</strong><span aria-hidden="true">${optionHTML(option)}</span></label>`).join('');
    $('check-answer').disabled = state.solutionVisible;
    $('give-hint').hidden = state.solutionVisible;
    $('feedback').hidden = state.lastOutcome === null;
    $('feedback').className = 'feedback ' + (state.lastOutcome === 'correct' ? 'good' : 'bad');
    $('feedback').textContent = state.lastOutcome === 'correct' ? 'Correct. Recap the knowledge steps and their pitfalls below.' : 'Compare your answer with the worked solution. You can also go through the hints, one step at a time.';
    $('review').hidden = !state.helpVisible;
    $('knowledge-list').innerHTML = q.hints.slice(0, state.piecesShown).map((h, i) => `<div class="knowledge" id="knowledge-${i + 1}" tabindex="-1"><h3>Help step ${i + 1} · ${esc(h.title)}</h3><div>${h.body}</div>${recallHTML(h)}<p class="pitfall"><strong>Watch for:</strong> ${h.pitfall}</p><small>${h.pause}</small></div>`).join('');
    $('next-piece').hidden = state.piecesShown >= q.hints.length;
    $('reveal-solution').hidden = false;
    $('solution').hidden = !state.solutionVisible;
    $('correct-answer').innerHTML = answerHTML(q);
    $('knowledge-recap').innerHTML = recapHTML(q);
    $('solution-content').innerHTML = q.solution;
    $('attribution').innerHTML = q.source || '';
    $('attribution').hidden = !q.source;
    $('score-summary').hidden = !r.completed;
    const followupCount = adaptive ? r.followups.filter(f => f.first !== null).length : (r.practice === null ? 0 : 1);
    const followupCorrect = adaptive ? r.followups.reduce((sum, f) => sum + (f.first || 0), 0) : r.practice;
    $('score-summary').innerHTML = `<h3>Question complete</h3><div class="score-grid">${scoreHTML(`${r.first}/1`, r.everSolved === null ? 'Not recorded' : `${r.everSolved ? 1 : 0}/1`, followupCount === 0 ? (adaptive && r.first === 1 ? 'Not needed' : 'None attempted') : `${followupCorrect}/${followupCount}`)}</div><p>Your first score counts answers given before help. After practice counts correct answers you submit when you retry the original.</p>`;
    $('similar-button').hidden = adaptive && !canOfferFollowup();
    $('similar-button').disabled = adaptive && !canOfferFollowup();
    $('similar-button').textContent = adaptive && r.followups.length ? 'Try another similar question' : 'Try a similar exercise';
    $('redo-button').textContent = adaptive && state.mode === 'similar' ? 'Redo the original question' : 'Redo the exercise';
    $('next-exercise-button').disabled = !state.solutionVisible;
    $('next-exercise-button').textContent = state.questionIndex === data.questions.length - 1 ? 'Finish paper' : 'Next exercise';
    const exhausted = adaptive && r.completed && r.first === 0 && !r.followups.some(f => f.first === 1) && r.followups.length < 3 && nextCandidate() < 0;
    $('completion-note').hidden = r.completed && !exhausted;
    $('completion-note').textContent = 'Redo the question, try a similar exercise, or continue. You can try up to three different matching questions.';
    $('overall-scores').innerHTML = scoreHTML(`${p.firstCorrect}/${p.total}`, p.afterKnown ? `${p.afterCorrect}/${p.total}` : 'Not recorded', p.practiceAttempted === 0 ? (state.records.some(item => item.first === 0) ? 'None attempted' : 'Not needed') : `${p.practiceCorrect}/${p.practiceAttempted}`);
    $('score-explanation').textContent = 'Both scores cover the same original questions. The first counts correct answers given before hints or solutions. After practice counts correct submissions, including retries. Opening a solution does not earn a mark. Similar-question first attempts are recorded separately.' + (p.afterKnown ? '' : ' Earlier saved work did not record whether every missed original was later solved, so its after-practice score is unavailable.');
    if (state.contentRevision !== contentRevision) $('score-explanation').textContent += ' This saved attempt keeps its original follow-up questions. A new attempt uses the updated set.';
    $('recovery-summary').hidden = !adaptive;
    $('recovery-summary').textContent = adaptive ? `${p.recovered} of ${state.records.filter(item => item.first === 0).length} missed originals were followed by a correct first answer to a matching question.` : '';
    $('results-table').innerHTML = `<thead><tr><th>Question</th><th>On your own</th><th>After practice</th><th>${adaptive ? 'Similar first answers' : 'Similar first answer'}</th></tr></thead><tbody>` + state.records.map((item, i) => {
      const count = adaptive ? item.followups.filter(f => f.first !== null).length : 0;
      const practiceResult = adaptive ? (count ? `${item.followups.reduce((sum, f) => sum + (f.first || 0), 0)}/${count}` : item.first === 1 ? 'Not needed' : 'None attempted') : item.practice === null ? 'None attempted' : item.practice ? 'Correct' : 'Incorrect';
      return `<tr><td>${i + 1}</td><td>${item.firstKind === 'hint' ? 'Used a hint' : item.first ? 'Correct' : 'Incorrect'}</td><td>${item.everSolved === null ? 'Not recorded' : item.everSolved ? 'Solved' : 'Not yet solved'}</td><td>${practiceResult}</td></tr>`;
    }).join('') + '</tbody>';
    emitViewState();
  }
  function commit(focusId) { userActed = true; render(); save(); if (focusId) focus(focusId); }
  function resetAttempt() { state.piecesShown = 0; state.helpVisible = false; state.solutionVisible = false; state.selected = null; state.lastOutcome = null; state.summaryVisible = false; }
  function openSolution() {
    state.helpVisible = false;
    state.solutionVisible = true;
    if (state.mode === 'original') record().originalReviewed = true;
    else if (adaptive) {
      currentFollowup().reviewed = true;
      record().practiceReviewed = Boolean(record().followups[0].reviewed);
    } else { record().practiceReviewed = true; record().completed = true; }
    if (adaptive) record().completed = policyComplete();
    commit('solution');
  }
  $('answer-form').addEventListener('change', event => { if (event.target.name === 'answer') { state.selected = event.target.value; userActed = true; save(); } });
  function checkAnswer() {
    if (state.solutionVisible) return;
    const chosen = $('answer-form').querySelector('input:checked');
    if (!chosen) {
      $('feedback').textContent = 'Choose your answer before checking. You can ask for a hint at any time.';
      $('feedback').className = 'feedback neutral';
      $('feedback').hidden = false;
      focus('answer-form');
      return;
    }
    if (chosen) {
      const correct = chosen.value === exercise().correct;
      recordFirst(correct ? 1 : 0, 'answer');
      if (correct && state.mode === 'original') record().everSolved = true;
      state.lastOutcome = correct ? 'correct' : 'incorrect';
      state.selected = chosen.value;
    }
    openSolution();
  }
  function openHint(advance) {
    recordFirst(0, 'hint');
    state.solutionVisible = false;
    state.helpVisible = true;
    state.lastOutcome = null;
    state.selected = null;
    state.piecesShown = advance ? Math.min(state.piecesShown + 1, exercise().hints.length) : Math.max(1, state.piecesShown);
    commit(`knowledge-${state.piecesShown}`);
  }
  $('answer-form').addEventListener('submit', event => { event.preventDefault(); checkAnswer(); });
  $('give-hint').addEventListener('click', () => openHint(true));
  $('solution-hints').addEventListener('click', () => { if (state.solutionVisible) openHint(false); });
  $('next-piece').addEventListener('click', () => {
    if (!state.helpVisible || state.piecesShown >= exercise().hints.length) return;
    state.piecesShown++; commit(`knowledge-${state.piecesShown}`);
  });
  $('try-again').addEventListener('click', () => { state.helpVisible = false; state.solutionVisible = false; state.lastOutcome = null; commit('question-section'); });
  $('reveal-solution').addEventListener('click', () => { if (state.helpVisible) checkAnswer(); });
  $('redo-button').addEventListener('click', () => {
    if (!state.solutionVisible) return;
    if (adaptive && state.mode === 'similar') { state.mode = 'original'; state.similarIndex = 0; }
    resetAttempt(); commit('question-section');
  });
  $('similar-button').addEventListener('click', () => {
    if (!state.solutionVisible || !record().originalReviewed) return;
    if (adaptive) {
      if (!canOfferFollowup()) return;
      state.similarIndex = nextCandidate();
      record().followups.push({index: state.similarIndex, sourceId: similarPool()[state.similarIndex].sourceId, first: null, firstKind: null, reviewed: false});
    } else state.similarIndex = state.mode === 'similar' ? (state.similarIndex + 1) % similarPool().length : 0;
    state.mode = 'similar'; resetAttempt(); commit('question-section');
  });
  $('next-exercise-button').addEventListener('click', () => {
    if (!state.solutionVisible) return;
    if (!record().completed) { record().movedOn = true; record().completed = true; }
    if (state.questionIndex === data.questions.length - 1) { state.finished = true; state.summaryVisible = true; commit('finished'); }
    else { state.questionIndex++; state.mode = 'original'; state.similarIndex = 0; resetAttempt(); commit('question-section'); }
  });
  $('review-last').addEventListener('click', () => { state.summaryVisible = false; state.solutionVisible = true; state.helpVisible = false; commit('solution'); });
  $('start-new-attempt').addEventListener('click', () => {
    if (!state.finished || !state.summaryVisible) return;
    state = fresh(); commit('question-section');
  });
  $('return-library').hidden = !embedded;
  $('return-library').addEventListener('click', () => window.parent.postMessage({type: 'tmua-exit', paperId: meta.id}, '*'));
  document.addEventListener('tmua-request-render', emitViewState);
  document.addEventListener('tmua-review-question', event => {
    const index = event.detail?.index;
    if (!Number.isInteger(index) || index < 0 || index >= data.questions.length) return;
    if (!state.records[index].completed) { if (index === state.questionIndex) focus('question-section'); return; }
    const q = data.questions[index].original;
    document.dispatchEvent(new CustomEvent('tmua-review-content', {detail: {index, source: sourceLabel(q), questionHTML: `${q.lead}${q.fallback ? `<div class="formula">${q.fallback}</div>` : ''}${q.tail || ''}`, solutionHTML: `<div class="answer">${answerHTML(q)}</div><div class="knowledge-recap">${recapHTML(q)}</div>${q.solution}`, sourceHTML: q.source || ''}}));
  });
  window.addEventListener('message', event => {
    if (embedded && event.source === window.parent && event.data?.type === 'tmua-storage-status') {
      if (typeof event.data.message === 'string' && event.data.message.length <= 180) $('save-note').textContent = event.data.message;
      return;
    }
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
  else save();
})();
