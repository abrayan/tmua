(() => {
  'use strict';

  const section = document.getElementById('roadmap-section');
  if (!section) return;
  const guidedOnly = section.dataset.mode !== 'resources';
  const siteBase = new URL('.', window.location.href);
  const storageKey = `tmua-paired-roadmap-v1:${siteBase.pathname}`;
  const historyKey = `tmua-attempt-history-v1:${siteBase.pathname}`;
  const libraryKey = `tmua-practice-library-v1:${siteBase.pathname}`;
  const contexts = {first: 'First attempt', practised: 'Practised before'};
  let pairs = [];
  let comingSoon = [];
  let records = readRecords();
  let library = readLibrary();
  let catalog = new Map();
  let loading = false;
  let persistenceAvailable = true;
  let historyPersistenceAvailable = true;
  let libraryPersistenceAvailable = true;
  let historyAttempts = readHistory();
  const unsavedHistory = new Map();
  let notice = '';
  const openForms = new Set();

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function readRecords() {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return stored && stored.version === 1 && stored.pairs && typeof stored.pairs === 'object'
        && !Array.isArray(stored.pairs) ? stored.pairs : {};
    } catch (_) { return {}; }
  }

  function readLibrary() {
    try {
      const stored = JSON.parse(localStorage.getItem(libraryKey) || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch (_) { return {}; }
  }

  function fullGuidedPaper(paper) {
    const item = paper.interactiveId && catalog.get(paper.interactiveId);
    return item && item.paper === paper.paper && item.questionCount === 20 ? item : null;
  }

  function guidedProgress(paper) {
    const item = fullGuidedPaper(paper);
    const saved = item && library[item.id];
    const progress = saved?.progress;
    if (!saved || saved.version !== item.version || !saved.state || typeof saved.state !== 'object'
      || !progress || progress.total !== 20 || typeof progress.finished !== 'boolean') return null;
    const fields = ['questionIndex', 'completed', 'firstCorrect', 'firstAttempted'];
    if (fields.some(key => !Number.isInteger(progress[key]) || progress[key] < 0 || progress[key] > 20)
      || progress.questionIndex >= 20 || progress.completed > progress.firstAttempted
      || progress.firstCorrect > progress.firstAttempted || (progress.finished && progress.completed !== 20)) return null;
    return {...progress, updatedAt: saved.updatedAt};
  }

  function paperStatus(pair, paper) {
    const manual = pairRecord(pair).papers[paper.paper];
    const guided = historyAttempts.filter(attempt => fullGuidedPaper(paper) && attempt.source === 'guided'
      && attempt.paperId === paper.interactiveId && attempt.paper === paper.paper && attempt.total === 20)
      .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0] || null;
    const progress = guidedProgress(paper);
    const started = Boolean(progress && !progress.finished
      && (progress.firstAttempted > 0 || progress.completed > 0 || progress.questionIndex > 0)
      || !fullGuidedPaper(paper) && manual?.draft && Number.isFinite(Date.parse(manual.startedAt)));
    const updatedAt = progress?.updatedAt || manual?.startedAt;
    const previousVersion = Boolean(fullGuidedPaper(paper) && library[paper.interactiveId]
      && library[paper.interactiveId].version !== catalog.get(paper.interactiveId).version);
    const complete = Boolean(validScore(manual) || guided || progress?.finished);
    return {manual, guided, progress, started, previousVersion, complete, updatedAt};
  }

  function bothCompleted(pair) { return pair.papers.every(paper => paperStatus(pair, paper).complete); }
  function pairReviewed(pair) {
    const record = pairRecord(pair);
    if (!record.reviewed || !bothCompleted(pair) || pair.papers.some(paper => paperStatus(pair, paper).started)) return false;
    return !record.reviewEvidence || record.reviewEvidence === reviewEvidence(pair);
  }
  function reviewEvidence(pair) {
    return JSON.stringify(pair.papers.map(paper => {
      const status = paperStatus(pair, paper);
      return [status.manual?.historyId, status.manual?.score, status.manual?.afterCorrect,
        status.manual?.context, status.guided?.id, status.guided?.firstCorrect, status.guided?.afterCorrect,
        status.progress?.finished ? status.progress.attemptId : null];
    }));
  }

  function validScore(value) {
    return value && Number.isInteger(value.score) && value.score >= 0 && value.score <= 20
      && Object.hasOwn(contexts, value.context);
  }

  function assessmentMetadata(value, context) {
    return context === 'first' && value && value.unseen === true && value.timed === true
      && value.unaided === true && value.durationMinutes === 75
      ? {unseen: true, timed: true, unaided: true, durationMinutes: 75} : null;
  }

  function validAfterScore(score, after) {
    return Number.isInteger(after) && after >= score && after <= 20;
  }

  function historyIdFor(pair, paper) {
    const random = window.crypto.randomUUID ? window.crypto.randomUUID()
      : Array.from(window.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
    return `manual:${pair.id}:p${paper}:${random}`;
  }

  function validHistoryId(id, pair, paper) {
    const prefix = `manual:${pair.id}:p${paper}:`;
    return typeof id === 'string' && id.startsWith(prefix) && /^[a-z0-9-]{16,80}$/i.test(id.slice(prefix.length));
  }

  function validHistoryEntry(attempt) {
    return attempt && typeof attempt === 'object' && typeof attempt.id === 'string' && Boolean(attempt.id)
      && typeof attempt.paperId === 'string' && Boolean(attempt.paperId)
      && typeof attempt.title === 'string' && Boolean(attempt.title.trim()) && [1, 2].includes(attempt.paper)
      && Number.isInteger(attempt.total) && attempt.total > 0 && attempt.total <= 1000
      && Number.isInteger(attempt.firstCorrect) && attempt.firstCorrect >= 0 && attempt.firstCorrect <= attempt.total
      && (attempt.afterCorrect === null || Number.isInteger(attempt.afterCorrect)
        && attempt.afterCorrect >= attempt.firstCorrect && attempt.afterCorrect <= attempt.total)
      && typeof attempt.completedAt === 'string' && Number.isFinite(Date.parse(attempt.completedAt))
      && ['manual', 'guided'].includes(attempt.source) && Object.hasOwn(contexts, attempt.attemptContext);
  }

  function readHistory() {
    if (!historyPersistenceAvailable) return historyAttempts;
    try {
      const stored = JSON.parse(localStorage.getItem(historyKey) || 'null');
      return stored && stored.version === 1 && Array.isArray(stored.attempts) ? stored.attempts.filter(validHistoryEntry) : [];
    } catch (_) { return []; }
  }

  function saveHistory(pair, paper, saved) {
    const merged = new Map();
    // Read immediately before merging so a newer guided attempt is not overwritten.
    [...historyAttempts, ...readHistory(), ...unsavedHistory.values()].forEach((attempt) => {
      if (validHistoryEntry(attempt)) merged.set(attempt.id, attempt);
    });
    const old = merged.get(saved.historyId);
    const entry = {id: saved.historyId, paperId: `${pair.id}-p${paper.paper}`,
      title: `${pair.title} · Paper ${paper.paper}`, paper: paper.paper, total: 20,
      firstCorrect: saved.score, afterCorrect: saved.afterCorrect,
      completedAt: old && typeof old.completedAt === 'string' && Number.isFinite(Date.parse(old.completedAt))
        ? old.completedAt : new Date().toISOString(),
      source: 'manual', attemptContext: saved.context};
    const assessment = assessmentMetadata(saved.assessment, saved.context);
    if (assessment) entry.assessment = assessment;
    merged.set(entry.id, entry);
    historyAttempts = Array.from(merged.values());
    try {
      localStorage.setItem(historyKey, JSON.stringify({version: 1, attempts: historyAttempts}));
      unsavedHistory.clear();
      historyPersistenceAvailable = true;
    } catch (_) {
      unsavedHistory.set(entry.id, entry);
      historyPersistenceAvailable = false;
    }
    document.dispatchEvent(new CustomEvent('tmua-history-updated', {detail: {attempts: historyAttempts, persisted: historyPersistenceAvailable}}));
  }

  function pairRecord(pair) {
    const stored = Object.hasOwn(records, pair.id) ? records[pair.id] : null;
    const result = {papers: {}, reviewed: false};
    if (!stored || typeof stored !== 'object') return result;
    [1, 2].forEach((paper) => {
      const value = stored.papers && stored.papers[paper];
      if (validScore(value)) {
        result.papers[paper] = {...value, afterCorrect: validAfterScore(value.score, value.afterCorrect) ? value.afterCorrect : null};
        if (!validHistoryId(value.historyId, pair, paper)) delete result.papers[paper].historyId;
        const assessment = assessmentMetadata(value.assessment, value.context);
        if (assessment) result.papers[paper].assessment = assessment;
        else delete result.papers[paper].assessment;
      } else if (value && value.draft === true && validHistoryId(value.historyId, pair, paper)) {
        result.papers[paper] = {draft: true, score: null, afterCorrect: null, context: '', historyId: value.historyId};
        if (typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))) result.papers[paper].startedAt = value.startedAt;
      }
    });
    result.reviewed = stored.reviewed === true;
    if (typeof stored.reviewEvidence === 'string') result.reviewEvidence = stored.reviewEvidence;
    return result;
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({version: 1, pairs: records}));
      persistenceAvailable = true;
    } catch (_) { persistenceAvailable = false; }
    document.dispatchEvent(new CustomEvent('tmua-local-updated',{detail:{kind:'roadmap',value:{version:1,pairs:records}}}));
  }

  function safePdf(href) {
    if (typeof href !== 'string' || !href.startsWith('assets/bank/')) return null;
    const url = new URL(href, siteBase);
    const bankPath = new URL('assets/bank/', siteBase).pathname;
    return url.origin === siteBase.origin && url.pathname.startsWith(bankPath)
      && /\.pdf$/i.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  }

  function safeExternal(href, paper) {
    // Compare the complete address so credentials, ports and URL suffixes cannot be normalised away.
    return ['jz_exam_c', 'jz_exam_d', 'tyler_exam_a'].some((exam) =>
      href === `https://jzmaths.com/simulator/${exam}_p${paper}`) ? href : null;
  }

  function validateRoadmap(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.pairs) || !data.pairs.length) {
      throw new Error('Invalid roadmap');
    }
    const ids = new Set();
    const validatedPairs = data.pairs.map((pair) => {
      if (!pair || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(pair.id || '') || ids.has(pair.id)
        || typeof pair.title !== 'string' || !pair.title.trim() || pair.title.length > 200
        || typeof pair.focus !== 'string' || pair.focus.length > 800
        || !Array.isArray(pair.papers) || pair.papers.length !== 2) throw new Error('Invalid pair');
      ids.add(pair.id);
      const papers = [1, 2].map((number) => {
        const paper = pair.papers.find((value) => value && value.paper === number);
        const external = paper && safeExternal(paper.href, number);
        const href = paper && (external || safePdf(paper.href));
        if (!paper || !href) throw new Error('Missing paper');
        const interactiveId = typeof paper.interactiveId === 'string'
          && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(paper.interactiveId) ? paper.interactiveId : null;
        return {...paper, paper: number, href, interactiveId, kind: external ? 'external' : 'pdf',
          provider: external ? 'JZMaths' : null};
      });
      return {...pair, papers};
    });
    if (data.comingSoon !== undefined && !Array.isArray(data.comingSoon)) throw new Error('Invalid coming soon');
    const validatedComingSoon = (data.comingSoon || []).map((item) => {
      if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200
        || typeof item.note !== 'string' || !item.note.trim() || item.note.length > 800) {
        throw new Error('Invalid coming soon');
      }
      return {title: item.title, note: item.note};
    });
    return {pairs: validatedPairs, comingSoon: validatedComingSoon};
  }

  function nextIndex() { return pairs.findIndex(pair => !pairReviewed(pair) && (!guidedOnly || pair.papers.some(paper => fullGuidedPaper(paper)))); }

  function recommendation() {
    const active = pairs.flatMap((pair, index) => pair.papers.map(paper => ({pair, paper, index, status: paperStatus(pair, paper)})))
      .filter(item => item.status.started && (!guidedOnly || fullGuidedPaper(item.paper)))
      .sort((a, b) => (Date.parse(b.status.updatedAt) || 0) - (Date.parse(a.status.updatedAt) || 0));
    if (active.length) return {...active[0], kind: 'continue'};
    const index = nextIndex();
    if (index < 0) return null;
    const pair = pairs[index];
    const paper = pair.papers.find(paper => !paperStatus(pair, paper).complete && (!guidedOnly || fullGuidedPaper(paper)));
    if (!paper && !bothCompleted(pair)) return null;
    return {pair, paper, index, kind: paper ? 'start' : 'review'};
  }

  function paperLink(pair, paper, label, className) {
    const guided = fullGuidedPaper(paper);
    if (guidedOnly && !guided) {
      const pending = node('button', 'roadmap-pending', `Paper ${paper.paper}`);
      pending.type = 'button'; pending.disabled = true;
      pending.setAttribute('aria-label', `Paper ${paper.paper}: ${pair.title} — guided exercises being prepared`);
      return pending;
    }
    const link = node('a', className, label);
    link.href = guided ? `#paper/${encodeURIComponent(paper.interactiveId)}` : paper.href;
    if (!guided) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.addEventListener('click', () => {
        const record = pairRecord(pair);
        if (validScore(record.papers[paper.paper])) return;
        record.papers[paper.paper] = {draft: true, score: null, afterCorrect: null, context: '',
          historyId: record.papers[paper.paper]?.historyId || historyIdFor(pair, paper.paper), startedAt: new Date().toISOString()};
        record.reviewed = false;
        records[pair.id] = record;
        persist();
        // Let the browser follow the link before updating its DOM.
        window.setTimeout(() => render(), 0);
      });
    }
    link.setAttribute('aria-label', `${label}: ${pair.title}${guided ? '' : ' (new tab)'}`);
    return link;
  }

  function renderReadyPair() {
    const ready = document.getElementById('ready-pair');
    if (!ready) return;
    ready.replaceChildren();
    ready.hidden = !pairs.length;
    if (!pairs.length) return;
    const next = recommendation();
    const copy = node('div', 'ready-pair-copy');
    copy.append(node('p', 'eyebrow', next?.kind === 'continue' ? 'Continue your paper' : next?.kind === 'review' ? 'Review this pair' : next ? 'Your next paper' : 'Your roadmap'));
    const title = node('h2', '', next ? `${next.pair.title}${next.paper ? ` · Paper ${next.paper.paper}` : ''}` : guidedOnly && pairs.some(pair => !pairReviewed(pair)) ? 'More guided papers are being prepared' : 'All pairs reviewed');
    title.id = 'ready-pair-heading';
    ready.setAttribute('aria-labelledby', title.id);
    const description = next?.kind === 'continue'
      ? next.status.progress ? `${next.status.progress.completed} of 20 exercises complete. Pick up where you left off.`
        : 'Continue the paper you opened, then return here to record your score.'
      : next?.kind === 'review' ? 'Both papers are complete. Review your answers, finish your corrections, then mark this pair reviewed below.'
        : next ? `Pair ${next.index + 1} of ${pairs.length}. ${next.paper.paper === 1 ? 'Start with Paper 1, then continue with Paper 2.'
          : paperStatus(next.pair, next.pair.papers.find(paper => paper.paper === 1)).complete
            ? 'Paper 1 is complete. Continue with Paper 2.'
            : 'Start with Paper 2 while the Paper 1 exercises are being prepared.'}`
          : guidedOnly && pairs.some(pair => !pairReviewed(pair)) ? 'Your progress is saved. Revisit a completed paper while the next exercises are prepared.' : 'Your results are saved. Return to any paper below for another attempt.';
    copy.append(title, node('p', 'ready-pair-description', description));
    const actions = node('div', 'ready-pair-actions');
    if (next?.paper) actions.append(paperLink(next.pair, next.paper,
      `${next.kind === 'continue' ? 'Continue' : 'Open'} Paper ${next.paper.paper}`, 'button'));
    const browse = node('a', `button${next?.paper ? ' secondary' : ''}`, next?.kind === 'review' ? 'Review this pair' : 'See all papers');
    browse.href = next?.kind === 'review' ? `#roadmap-stage-${next.pair.id}` : '#roadmap-section';
    actions.append(browse);
    ready.append(copy, actions);
  }

  function saveScore(pair, paper, input, afterInput, context, assessmentInput) {
    const raw = input.value.trim();
    const score = Number(raw);
    const afterRaw = afterInput.value.trim();
    const afterCorrect = afterRaw === '' ? null : Number(afterRaw);
    input.setCustomValidity(raw === '' || !Number.isInteger(score) || score < 0 || score > 20
      ? 'Enter a whole-number score from 0 to 20.' : '');
    context.setCustomValidity(Object.hasOwn(contexts, context.value) ? '' : 'Choose an attempt type.');
    afterInput.setCustomValidity(afterCorrect !== null && !validAfterScore(score, afterCorrect)
      ? 'Enter a whole-number total from your first-try score to 20, or leave this blank.' : '');
    if (!input.reportValidity() || !afterInput.reportValidity() || !context.reportValidity()) return;
    const record = pairRecord(pair);
    const old = record.papers[paper.paper];
    if (!old || old.score !== score || old.afterCorrect !== afterCorrect || old.context !== context.value) record.reviewed = false;
    record.papers[paper.paper] = {score, afterCorrect, context: context.value,
      historyId: old?.historyId || historyIdFor(pair, paper.paper), updatedAt: new Date().toISOString()};
    if (context.value === 'first' && assessmentInput.checked) {
      record.papers[paper.paper].assessment = {unseen: true, timed: true, unaided: true, durationMinutes: 75};
    }
    records[pair.id] = record;
    persist();
    saveHistory(pair, paper, record.papers[paper.paper]);
    notice = `Paper ${paper.paper}: ${score}/20 first try${afterCorrect === null ? '' : `, ${afterCorrect}/20 after practice`} recorded manually · ${contexts[context.value]}.`;
    render(`roadmap-save-${pair.id}-${paper.paper}`);
  }

  function makePaper(pair, paper, record) {
    const number = paper.paper;
    const current = record.papers[number];
    const saved = validScore(current) ? current : null;
    const key = `${pair.id}-${number}`;
    const panel = node('div', `roadmap-paper roadmap-paper-${number}`);
    const title = node('h4', '', `Paper ${number}`);
    title.id = `roadmap-paper-${key}`;
    panel.setAttribute('aria-labelledby', title.id);
    const top = node('div', 'roadmap-paper-heading');
    top.append(node('span', 'roadmap-order', String(number)), title);
    panel.append(top);
    const actions = node('div', 'roadmap-paper-actions');
    const guided = fullGuidedPaper(paper);
    const status = paperStatus(pair, paper);
    if (guidedOnly && !guided) panel.classList.add('is-preparing');
    if (!guidedOnly) panel.append(node('p', `roadmap-readiness roadmap-format${guided ? ' is-ready' : ''}`,
      guided ? 'Guided practice · 20 questions' : paper.kind === 'external' ? 'JZMaths online paper · 20 questions' : 'PDF paper · 20 questions'));
    panel.append(node('p', 'roadmap-paper-status', status.started
      ? status.progress ? `In progress · ${status.progress.completed} of 20 exercises complete${status.complete ? ' · Earlier attempt completed' : ''}` : 'In progress · Score not yet recorded'
      : status.complete ? 'Completed' : guidedOnly && !guided ? 'Being prepared' : current?.draft ? 'New attempt to record' : 'Not started'));
    actions.append(paperLink(pair, paper, `${status.started ? 'Continue' : 'Open'} Paper ${number}`,
      `roadmap-open roadmap-primary${guided ? ' roadmap-guided' : ''}`));
    if (guided && !guidedOnly) {
      const original = node('a', 'roadmap-original', 'Original PDF');
      original.href = paper.href;
      original.target = '_blank';
      original.rel = 'noopener noreferrer';
      original.setAttribute('aria-label', `Open original PDF: ${pair.title}, Paper ${number} (new tab)`);
      actions.append(original);
    }
    panel.append(actions);
    if (paper.kind === 'external' && !guidedOnly) panel.append(node('p', 'roadmap-range roadmap-provider', 'Opens on JZMaths'));
    if (status.guided || status.progress?.finished) {
      const result = status.guided;
      const first = result ? result.firstCorrect : status.progress.firstCorrect;
      const after = result ? result.afterCorrect : status.progress.afterKnown && validAfterScore(first, status.progress.afterCorrect) ? status.progress.afterCorrect : null;
      panel.append(node('p', 'roadmap-guided-result', `Guided result: ${first}/20 first attempt${after === null ? '' : ` → ${after}/20 after practice`}${result ? ` · ${contexts[result.attemptContext]}` : ''}${status.started ? ' · Earlier completed attempt' : ''}`));
    }
    if (status.previousVersion) panel.append(node('p', 'roadmap-range', 'An earlier saved version is on record. Open this paper to start the current version.'));
    const details = node('details', 'roadmap-score-details');
    details.open = openForms.has(key);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) openForms.add(key); else openForms.delete(key);
    });
    const summary = node('summary', 'roadmap-score-summary');
    if (saved) {
      summary.append(node('span', 'roadmap-score-value', `${saved.score}/20`),
        node('span', 'roadmap-score-context', `First try${saved.afterCorrect === null ? '' : ` → ${saved.afterCorrect}/20 after practice`} · ${contexts[saved.context]} · Manual record`));
    } else summary.append(node('span', '', current?.draft ? 'Record your new attempt' : status.guided || status.progress?.finished ? 'Record a separate paper attempt' : guidedOnly ? 'Record an earlier result' : 'Record a score'));
    details.append(summary);
    const form = node('form', 'roadmap-score-form');
    form.setAttribute('aria-label', `Manual score for ${pair.title}, Paper ${number}`);
    const scoreLabel = node('label', '', 'First try');
    scoreLabel.htmlFor = `roadmap-score-${key}`;
    const scoreLine = node('div', 'roadmap-score-input');
    const input = node('input');
    input.id = scoreLabel.htmlFor;
    input.type = 'number';
    input.name = 'score';
    input.min = '0';
    input.max = '20';
    input.step = '1';
    input.inputMode = 'numeric';
    input.required = true;
    input.value = saved ? String(saved.score) : '';
    input.setAttribute('aria-describedby', `roadmap-outof-${key}`);
    const outOf = node('span', '', '/ 20');
    outOf.id = `roadmap-outof-${key}`;
    scoreLine.append(input, outOf);
    const afterLabel = node('label', '', 'After practice (optional)');
    afterLabel.htmlFor = `roadmap-after-${key}`;
    const afterLine = node('div', 'roadmap-score-input');
    const afterInput = node('input');
    afterInput.id = afterLabel.htmlFor;
    afterInput.type = 'number';
    afterInput.name = 'afterCorrect';
    afterInput.min = saved ? String(saved.score) : '0';
    afterInput.max = '20';
    afterInput.step = '1';
    afterInput.inputMode = 'numeric';
    afterInput.value = saved && saved.afterCorrect !== null ? String(saved.afterCorrect) : '';
    afterInput.setAttribute('aria-describedby', `roadmap-after-outof-${key} roadmap-score-help-${key}`);
    const afterOutOf = node('span', '', '/ 20');
    afterOutOf.id = `roadmap-after-outof-${key}`;
    afterLine.append(afterInput, afterOutOf);
    input.addEventListener('input', () => {
      input.setCustomValidity('');
      afterInput.setCustomValidity('');
      afterInput.min = input.value !== '' && Number.isInteger(Number(input.value))
        && Number(input.value) >= 0 && Number(input.value) <= 20 ? input.value : '0';
    });
    afterInput.addEventListener('input', () => afterInput.setCustomValidity(''));
    const scoreHelp = node('p', 'roadmap-score-help', 'After practice is the total you can now solve, including your first-try successes. Leave it blank until you have practised. Both scores are recorded manually.');
    scoreHelp.id = `roadmap-score-help-${key}`;
    const contextLabel = node('label', '', 'When you took this paper');
    contextLabel.htmlFor = `roadmap-context-${key}`;
    const context = node('select');
    context.id = contextLabel.htmlFor;
    context.name = 'context';
    context.required = true;
    const placeholder = node('option', '', 'Choose attempt type');
    placeholder.value = '';
    context.append(placeholder);
    Object.entries(contexts).forEach(([value, label]) => {
      const option = node('option', '', label);
      option.value = value;
      context.append(option);
    });
    context.value = saved ? saved.context : '';
    const assessmentLabel = node('label', 'roadmap-assessment');
    const assessmentInput = node('input');
    assessmentInput.type = 'checkbox';
    assessmentInput.name = 'assessment';
    assessmentInput.id = `roadmap-assessment-${key}`;
    assessmentInput.checked = Boolean(saved && assessmentMetadata(saved.assessment, saved.context));
    assessmentInput.disabled = context.value !== 'first';
    assessmentLabel.append(assessmentInput, node('span', '', 'Unseen paper · 75 minutes · no help'));
    context.addEventListener('change', () => {
      context.setCustomValidity('');
      assessmentInput.disabled = context.value !== 'first';
      if (assessmentInput.disabled) assessmentInput.checked = false;
    });
    const buttons = node('div', 'roadmap-form-actions');
    const save = node('button', 'roadmap-save', saved ? 'Update record' : 'Save score');
    save.type = 'submit';
    save.id = `roadmap-save-${key}`;
    buttons.append(save);
    if (saved) {
      const newAttempt = node('button', 'roadmap-save roadmap-new-attempt', 'New attempt');
      newAttempt.type = 'button';
      newAttempt.addEventListener('click', () => {
        const updated = pairRecord(pair);
        updated.papers[number] = {draft: true, score: null, afterCorrect: null, context: '', historyId: historyIdFor(pair, number)};
        updated.reviewed = false;
        records[pair.id] = updated;
        openForms.add(key);
        persist();
        notice = `Paper ${number}: a new attempt is ready to record. Earlier results stay in your history.`;
        render(`roadmap-score-${key}`);
      });
      buttons.append(newAttempt);
    }
    if (current) {
      const clear = node('button', 'roadmap-clear', 'Clear current entry');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        const updated = pairRecord(pair);
        delete updated.papers[number];
        updated.reviewed = false;
        records[pair.id] = updated;
        persist();
        notice = `Paper ${number} current entry cleared. Earlier results stay in your history.`;
        render(`roadmap-score-${key}`);
      });
      buttons.append(clear);
    }
    form.append(scoreLabel, scoreLine, afterLabel, afterLine, contextLabel, context, assessmentLabel, scoreHelp, buttons);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      openForms.add(key);
      saveScore(pair, paper, input, afterInput, context, assessmentInput);
    });
    details.append(form);
    panel.append(details);
    return panel;
  }

  function makePair(pair, index, next) {
    const record = pairRecord(pair);
    const bothScores = bothCompleted(pair);
    const reviewed = pairReviewed(pair);
    const hasActiveAttempt = pair.papers.some(paper => paperStatus(pair, paper).started);
    const isNext = index === next;
    const stage = node('li', `roadmap-stage${isNext ? ' is-next' : ''}${reviewed ? ' is-reviewed' : ''}`);
    stage.id = `roadmap-stage-${pair.id}`;
    const heading = node('div', 'roadmap-stage-heading');
    const naming = node('div', 'roadmap-stage-name');
    naming.append(node('span', 'roadmap-stage-label', `Pair ${index + 1}`));
    const title = node('h3', '', pair.title);
    title.id = `roadmap-title-${pair.id}`;
    naming.append(title);
    stage.setAttribute('aria-labelledby', title.id);
    let status = reviewed ? 'Reviewed' : bothScores ? 'Review next'
      : pair.papers.some(paper => paperStatus(pair, paper).started || paperStatus(pair, paper).complete) ? 'In progress' : 'To do';
    if (isNext && !bothScores) status = 'Up next';
    const waiting = guidedOnly && pair.papers.some(paper => !fullGuidedPaper(paper));
    const badge = node('span', 'roadmap-stage-status', waiting && !bothCompleted(pair) ? 'Being prepared' : status);
    if (waiting) stage.classList.add('is-preparing');
    if (reviewed) badge.prepend(node('span', 'roadmap-checkmark', '✓ '));
    heading.append(naming, badge);
    stage.append(heading);
    const papers = node('div', 'roadmap-paper-pair');
    pair.papers.forEach((paper) => papers.append(makePaper(pair, paper, record)));
    stage.append(papers);
    const review = node('div', 'roadmap-review');
    const label = node('label', 'roadmap-review-label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.id = `roadmap-review-${pair.id}`;
    checkbox.checked = reviewed;
    checkbox.disabled = !bothScores || hasActiveAttempt;
    const description = node('span', '', 'Both papers reviewed and corrected');
    label.append(checkbox, description);
    review.append(label);
    if (!bothScores || hasActiveAttempt) {
      const help = node('p', 'roadmap-review-help', hasActiveAttempt && bothScores
        ? 'Finish your current attempt first.'
        : 'Complete both papers first.');
      help.id = `roadmap-review-help-${pair.id}`;
      checkbox.setAttribute('aria-describedby', help.id);
      review.append(help);
    }
    checkbox.addEventListener('change', () => {
      const updated = pairRecord(pair);
      updated.reviewed = checkbox.checked && bothCompleted(pair) && !pair.papers.some(paper => paperStatus(pair, paper).started);
      updated.reviewEvidence = reviewEvidence(pair);
      records[pair.id] = updated;
      persist();
      notice = updated.reviewed ? `Pair ${index + 1} reviewed. Your progress is saved.`
        : `Pair ${index + 1} marked for review.`;
      if (updated.reviewed && pairs.every(pairReviewed)) notice = 'All pairs reviewed. Your scores and corrections are recorded.';
      render(checkbox.id);
    });
    stage.append(review);
    return stage;
  }

  function render(focusId) {
    renderReadyPair();
    const next = nextIndex();
    const completed = pairs.filter(pairReviewed).length;
    const completedPapers = pairs.reduce((count, pair) => count + pair.papers.filter(paper => paperStatus(pair, paper).complete).length, 0);
    const totalPapers = pairs.length * 2;
    section.classList.add('roadmap-section');
    section.setAttribute('aria-labelledby', 'roadmap-heading');
    const head = node('div', 'roadmap-header');
    const copy = node('div');
    copy.append(node('div', 'eyebrow', 'Your full paper collection'));
    const title = node('h2', '', 'Your paper checklist');
    title.id = 'roadmap-heading';
    copy.append(title, node('p', 'roadmap-intro', 'Follow the pairs in order: Paper 1, then Paper 2, then review your answers. All your papers are listed below.'));
    const counts = node('div', 'roadmap-counts');
    counts.append(node('span', 'roadmap-count roadmap-completion-count', `${completedPapers} of ${totalPapers} papers completed`),
      node('span', 'roadmap-review-count', `${completed} of ${pairs.length} pairs reviewed`));
    head.append(copy, counts);
    const progress = node('div', 'roadmap-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Papers completed');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', String(totalPapers));
    progress.setAttribute('aria-valuenow', String(completedPapers));
    const fill = node('span');
    fill.style.width = `${100 * completedPapers / totalPapers}%`;
    progress.append(fill);
    const tools = node('div', 'roadmap-tools');
    const statusText = next < 0 ? (pairs.every(pairReviewed) ? 'All pairs reviewed — return to any paper below.' : 'Your completed work is saved. More guided exercises are being prepared.')
      : `Next suggested pair: Pair ${next + 1} · ${pairs[next].title}`;
    tools.append(node('p', 'roadmap-current', statusText));
    const list = node('ol', 'roadmap-stages');
    list.id = 'roadmap-stages';
    pairs.forEach((pair, index) => list.append(makePair(pair, index, next)));
    const rangeNote = node('p', 'roadmap-range', `All ${pairs.length} pairs · ${totalPapers} papers. Each pair has Paper 1 followed by Paper 2.`);
    const manualNote = node('p', 'roadmap-manual-note', guidedOnly ? 'Each ready paper opens guided exercises. Your answers and place are saved automatically.' : 'Guided papers save your results automatically. For PDF and JZMaths papers, record your first-try score and your after-practice total here. Every recorded attempt appears in your progress history.');
    const live = node('p', 'roadmap-notice', '');
    live.id = 'roadmap-notice';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const storage = node('p', 'roadmap-storage', persistenceAvailable && historyPersistenceAvailable
      ? 'Your roadmap is saved in this browser.' : 'Your roadmap is available for this visit. This browser could not save it.');
    section.replaceChildren(head, progress, tools, rangeNote, list, manualNote, live, storage);
    if (comingSoon.length) {
      const upcoming = node('aside', 'roadmap-review roadmap-coming-soon');
      upcoming.setAttribute('aria-labelledby', 'roadmap-coming-heading');
      const heading = node('h3', 'roadmap-current', 'Coming soon');
      heading.id = 'roadmap-coming-heading';
      upcoming.append(heading);
      comingSoon.forEach((item) => {
        const note = node('p', 'roadmap-manual-note');
        note.append(node('strong', '', item.title), document.createTextNode(` — ${item.note}`));
        upcoming.append(note);
      });
      section.append(upcoming);
    }
    const announcement = notice;
    window.requestAnimationFrame(() => { if (live.isConnected) live.textContent = announcement; });
    if (focusId) {
      const target = document.getElementById(focusId);
      if (target && !target.closest('[hidden]')) target.focus({preventScroll: true});

    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    section.classList.add('roadmap-section');
    section.setAttribute('aria-busy', 'true');
    section.replaceChildren(node('p', 'roadmap-loading', 'Loading your paired roadmap…'));
    try {
      const [roadmapResponse, catalogResult] = await Promise.all([
        fetch(new URL('assets/roadmap.json', siteBase), {cache: 'no-store'}),
        fetch(new URL('papers/catalog.json', siteBase), {cache: 'no-store'})
          .then(response => response.ok ? response.json() : null).catch(() => null)
      ]);
      if (!roadmapResponse.ok) throw new Error('Roadmap unavailable');
      const data = validateRoadmap(await roadmapResponse.json());
      catalog = new Map((Array.isArray(catalogResult?.papers) ? catalogResult.papers : [])
        .filter(item => item && item.format === 'tmua-paper-v1' && item.version === 1
          && typeof item.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(item.id)
          && [1, 2].includes(item.paper) && Number.isInteger(item.questionCount))
        .map(item => [item.id, item]));
      pairs = data.pairs;
      comingSoon = data.comingSoon;
      render();
    } catch (_) {
      const error = node('div', 'roadmap-error');
      error.setAttribute('role', 'alert');
      error.append(node('h2', '', 'Your roadmap could not load.'),
        node('p', '', 'Please try again. Your saved records are still here.'));
      const retry = node('button', 'roadmap-save', 'Reload roadmap');
      retry.type = 'button';
      retry.addEventListener('click', load);
      error.append(retry);
      section.replaceChildren(error);
    } finally {
      loading = false;
      section.removeAttribute('aria-busy');
    }
  }

  window.addEventListener('storage', (event) => {
    if (![storageKey, historyKey, libraryKey, null].includes(event.key)) return;
    if ((event.key === storageKey || event.key === null) && persistenceAvailable) records = readRecords();
    if (event.key === historyKey || event.key === null) historyAttempts = readHistory();
    if ((event.key === libraryKey || event.key === null) && libraryPersistenceAvailable) library = readLibrary();
    notice = '';
    if (pairs.length) render();
  });
  document.addEventListener('tmua-cloud-applied', event => {
    if (!event.detail?.payload?.roadmap) return;
    records = event.detail.payload.roadmap.pairs;
    historyAttempts = event.detail.payload.history.attempts.filter(validHistoryEntry);
    library = event.detail.payload.library;
    persistenceAvailable = event.detail.persistence?.roadmap !== false;
    historyPersistenceAvailable = event.detail.persistence?.history !== false;
    libraryPersistenceAvailable = event.detail.persistence?.library !== false;
    unsavedHistory.clear();
    notice = '';
    if (pairs.length) render();
  });
  document.addEventListener('tmua-local-updated', event => {
    if (event.detail?.kind !== 'library' || !event.detail.value) return;
    library = event.detail.value;
    if (typeof event.detail.persisted === 'boolean') libraryPersistenceAvailable = event.detail.persisted;
    if (pairs.length) render();
  });
  document.addEventListener('tmua-history-updated', (event) => {
    if (Array.isArray(event.detail?.attempts)) historyAttempts = event.detail.attempts.filter(validHistoryEntry);
    if (event.detail?.persisted === false) {
      historyPersistenceAvailable = false;
      historyAttempts.forEach(attempt => unsavedHistory.set(attempt.id, attempt));
    } else if (event.detail?.persisted === true) {
      historyPersistenceAvailable = true;
      unsavedHistory.clear();
    }
    if (pairs.length) render();
  });
  load();
})();
