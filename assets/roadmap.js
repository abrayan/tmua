(() => {
  'use strict';

  const section = document.getElementById('roadmap-section');
  if (!section) return;
  const siteBase = new URL('.', window.location.href);
  const storageKey = `tmua-paired-roadmap-v1:${siteBase.pathname}`;
  const historyKey = `tmua-attempt-history-v1:${siteBase.pathname}`;
  const contexts = {first: 'First attempt', practised: 'Practised before'};
  let pairs = [];
  let comingSoon = [];
  let records = readRecords();
  let showAll = false;
  let loading = false;
  let persistenceAvailable = true;
  let historyPersistenceAvailable = true;
  let historyAttempts = [];
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

  function validScore(value) {
    return value && Number.isInteger(value.score) && value.score >= 0 && value.score <= 20
      && Object.hasOwn(contexts, value.context);
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
      } else if (value && value.draft === true && validHistoryId(value.historyId, pair, paper)) {
        result.papers[paper] = {draft: true, score: null, afterCorrect: null, context: '', historyId: value.historyId};
      }
    });
    result.reviewed = stored.reviewed === true && Boolean(validScore(result.papers[1]) && validScore(result.papers[2]));
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

  function nextIndex() { return pairs.findIndex((pair) => !pairRecord(pair).reviewed); }

  function visibleRange(next) {
    const count = Math.min(3, pairs.length);
    const current = next < 0 ? pairs.length - 1 : next;
    const start = Math.max(0, Math.min(current - 1, pairs.length - count));
    return {start, end: start + count};
  }

  function renderReadyPair() {
    const ready = document.getElementById('ready-pair');
    if (!ready) return;
    const complete = pair => pair.papers.every(paper => paper.interactiveId);
    const pair = pairs.find(pair => pair.id === 'tmua-2020' && complete(pair))
      || pairs.find(complete);
    ready.replaceChildren();
    ready.hidden = !pair;
    if (!pair) return;
    const copy = node('div', 'ready-pair-copy');
    copy.append(node('p', 'eyebrow', 'Start here · Guided pair ready'));
    const title = node('h2', '', pair.title);
    title.id = 'ready-pair-heading';
    ready.setAttribute('aria-labelledby', title.id);
    copy.append(title, node('p', 'ready-pair-description', 'Start with Paper 1, then Paper 2. Both include worked steps, lesson reminders, pitfalls and saved scores.'));
    const actions = node('div', 'ready-pair-actions');
    pair.papers.forEach(paper => {
      const link = node('a', `button${paper.paper === 2 ? ' secondary' : ''}`, `Start Paper ${paper.paper}`);
      link.href = `#paper/${encodeURIComponent(paper.interactiveId)}`;
      link.setAttribute('aria-label', `Start guided ${pair.title}, Paper ${paper.paper}`);
      actions.append(link);
    });
    ready.append(copy, actions);
  }

  function saveScore(pair, paper, input, afterInput, context) {
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
    panel.append(node('p', `roadmap-readiness${paper.interactiveId ? ' is-ready' : ''}`,
      paper.interactiveId ? 'Ready for guided practice' : 'Guided practice here is not ready yet.'));
    if (paper.interactiveId) {
      const guided = node('a', 'roadmap-guided', 'Start guided paper');
      guided.href = `#paper/${encodeURIComponent(paper.interactiveId)}`;
      guided.setAttribute('aria-label', `Start guided ${pair.title}, Paper ${number}`);
      actions.append(guided);
    }
    const link = node('a', 'roadmap-open', paper.kind === 'external' ? 'Open on JZMaths' : 'Download original');
    link.href = paper.href;
    if (paper.kind === 'external') {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open Paper ${number} on JZMaths: ${pair.title} (new tab)`);
    } else {
      link.download = '';
      link.setAttribute('aria-label', `Download original Paper ${number} PDF: ${pair.title}`);
    }
    const arrow = node('span', '', paper.kind === 'external' ? '↗' : '↓');
    arrow.setAttribute('aria-hidden', 'true');
    link.append(arrow);
    actions.append(link);
    panel.append(actions);
    if (paper.kind === 'external') panel.append(node('p', 'roadmap-range roadmap-provider', 'Opens on JZMaths'));
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
    } else summary.append(node('span', '', current?.draft ? 'Record your new attempt' : 'Record a score'));
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
    context.addEventListener('change', () => context.setCustomValidity(''));
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
    form.append(scoreLabel, scoreLine, afterLabel, afterLine, contextLabel, context, scoreHelp, buttons);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      openForms.add(key);
      saveScore(pair, paper, input, afterInput, context);
    });
    details.append(form);
    panel.append(details);
    return panel;
  }

  function makePair(pair, index, next, range) {
    const record = pairRecord(pair);
    const bothScores = Boolean(validScore(record.papers[1]) && validScore(record.papers[2]));
    const isNext = index === next;
    const stage = node('li', `roadmap-stage${isNext ? ' is-next' : ''}${record.reviewed ? ' is-reviewed' : ''}`);
    stage.id = `roadmap-stage-${pair.id}`;
    stage.hidden = !showAll && (index < range.start || index >= range.end);
    const heading = node('div', 'roadmap-stage-heading');
    const naming = node('div', 'roadmap-stage-name');
    naming.append(node('span', 'roadmap-stage-label', `Stage ${index + 1}`));
    const title = node('h3', '', pair.title);
    title.id = `roadmap-title-${pair.id}`;
    naming.append(title);
    stage.setAttribute('aria-labelledby', title.id);
    let status = record.reviewed ? 'Reviewed' : bothScores ? 'Review next'
      : record.papers[1] || record.papers[2] ? 'In progress'
        : pair.papers.every(paper => paper.interactiveId) ? 'Guided pair ready' : 'Originals available';
    if (isNext) status = 'Up next';
    const badge = node('span', 'roadmap-stage-status', status);
    if (record.reviewed) badge.prepend(node('span', 'roadmap-checkmark', '✓ '));
    heading.append(naming, badge);
    stage.append(heading);
    if (pair.focus.trim()) stage.append(node('p', 'roadmap-focus', pair.focus));
    if (isNext) {
      const nextStep = bothScores ? 'Review both papers and finish your corrections.'
        : validScore(record.papers[1]) ? 'Continue with Paper 2, then review the pair.'
          : pair.papers[0].interactiveId ? 'Start with Paper 1, then work through Paper 2.'
            : 'Work through the original Paper 1, then Paper 2. Guided papers are available above.';
      stage.append(node('p', 'roadmap-next-step', nextStep));
    }
    const papers = node('div', 'roadmap-paper-pair');
    pair.papers.forEach((paper) => papers.append(makePaper(pair, paper, record)));
    stage.append(papers);
    const review = node('div', 'roadmap-review');
    const label = node('label', 'roadmap-review-label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.id = `roadmap-review-${pair.id}`;
    checkbox.checked = record.reviewed;
    checkbox.disabled = !bothScores;
    const description = node('span', '', 'Review and corrections completed for both papers');
    label.append(checkbox, description);
    review.append(label);
    if (!bothScores) {
      const help = node('p', 'roadmap-review-help', 'Record both scores, then tick this once you have reviewed your answers.');
      help.id = `roadmap-review-help-${pair.id}`;
      checkbox.setAttribute('aria-describedby', help.id);
      review.append(help);
    }
    checkbox.addEventListener('change', () => {
      const updated = pairRecord(pair);
      updated.reviewed = checkbox.checked && Boolean(validScore(updated.papers[1]) && validScore(updated.papers[2]));
      records[pair.id] = updated;
      persist();
      notice = updated.reviewed ? `Stage ${index + 1} reviewed. Your next pair is ready.`
        : `Stage ${index + 1} marked for review.`;
      if (updated.reviewed && nextIndex() < 0) notice = 'All pairs reviewed. Your scores and corrections are recorded.';
      render(checkbox.id);
    });
    stage.append(review);
    return stage;
  }

  function render(focusId) {
    renderReadyPair();
    const next = nextIndex();
    const range = visibleRange(next);
    const completed = pairs.filter((pair) => pairRecord(pair).reviewed).length;
    section.classList.add('roadmap-section');
    section.setAttribute('aria-labelledby', 'roadmap-heading');
    const head = node('div', 'roadmap-header');
    const copy = node('div');
    copy.append(node('div', 'eyebrow', 'Your full paper collection'));
    const title = node('h2', '', 'Original papers & roadmap.');
    title.id = 'roadmap-heading';
    copy.append(title, node('p', 'roadmap-intro', 'Work through Paper 1 then Paper 2. Guided papers are marked ready; the other links open original PDFs or practice on JZMaths.'));
    head.append(copy, node('span', 'roadmap-count', `${completed} of ${pairs.length} pairs reviewed`));
    const progress = node('div', 'roadmap-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Pairs reviewed');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', String(pairs.length));
    progress.setAttribute('aria-valuenow', String(completed));
    const fill = node('span');
    fill.style.width = `${100 * completed / pairs.length}%`;
    progress.append(fill);
    const tools = node('div', 'roadmap-tools');
    const statusText = next < 0 ? 'All pairs reviewed — return to any paper below.'
      : `Next suggested pair: Stage ${next + 1} · ${pairs[next].title}`;
    tools.append(node('p', 'roadmap-current', statusText));
    if (pairs.length > 3) {
      const toggle = node('button', 'roadmap-toggle', showAll ? 'Show nearby stages' : 'Show full roadmap');
      toggle.type = 'button';
      toggle.id = 'roadmap-toggle';
      toggle.setAttribute('aria-expanded', String(showAll));
      toggle.setAttribute('aria-controls', 'roadmap-stages');
      toggle.addEventListener('click', () => { showAll = !showAll; render(toggle.id); });
      tools.append(toggle);
    }
    const list = node('ol', 'roadmap-stages');
    list.id = 'roadmap-stages';
    pairs.forEach((pair, index) => list.append(makePair(pair, index, next, range)));
    const rangeNote = node('p', 'roadmap-range', showAll || pairs.length <= 3
      ? `Browse all ${pairs.length} stages. Guided practice is marked ready.`
      : `Showing stages ${range.start + 1}–${range.end} of ${pairs.length}. You can open any pair from the full roadmap.`);
    const manualNote = node('p', 'roadmap-manual-note', 'Record your first-try score and, when ready, your after-practice total. These manual records appear in your history alongside separate guided-practice attempts.');
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
      else document.getElementById('roadmap-toggle')?.focus({preventScroll: true});
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    section.classList.add('roadmap-section');
    section.setAttribute('aria-busy', 'true');
    section.replaceChildren(node('p', 'roadmap-loading', 'Loading your paired roadmap…'));
    try {
      const response = await fetch(new URL('assets/roadmap.json', siteBase), {cache: 'no-store'});
      if (!response.ok) throw new Error('Roadmap unavailable');
      const data = validateRoadmap(await response.json());
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
    if (event.key !== storageKey && event.key !== null) return;
    records = readRecords();
    notice = '';
    if (pairs.length) render();
  });
  document.addEventListener('tmua-cloud-applied', event => {
    if (!event.detail?.payload?.roadmap) return;
    records = event.detail.payload.roadmap.pairs;
    historyAttempts = event.detail.payload.history.attempts;
    persistenceAvailable = event.detail.persistence?.roadmap !== false;
    historyPersistenceAvailable = event.detail.persistence?.history !== false;
    unsavedHistory.clear();
    notice = '';
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
  });
  load();
})();
