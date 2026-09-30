(() => {
  'use strict';

  const section = document.getElementById('roadmap-section');
  if (!section) return;
  const siteBase = new URL('.', window.location.href);
  const storageKey = `tmua-paired-roadmap-v1:${siteBase.pathname}`;
  const contexts = {first: 'First attempt', practised: 'Practised before'};
  let pairs = [];
  let comingSoon = [];
  let records = readRecords();
  let showAll = false;
  let loading = false;
  let persistenceAvailable = true;
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

  function pairRecord(pair) {
    const stored = Object.hasOwn(records, pair.id) ? records[pair.id] : null;
    const result = {papers: {}, reviewed: false};
    if (!stored || typeof stored !== 'object') return result;
    [1, 2].forEach((paper) => {
      const value = stored.papers && stored.papers[paper];
      if (validScore(value)) result.papers[paper] = {...value};
    });
    result.reviewed = stored.reviewed === true && Boolean(result.papers[1] && result.papers[2]);
    return result;
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({version: 1, pairs: records}));
      persistenceAvailable = true;
    } catch (_) { persistenceAvailable = false; }
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

  function saveScore(pair, paper, input, context) {
    const raw = input.value.trim();
    const score = Number(raw);
    input.setCustomValidity(raw === '' || !Number.isInteger(score) || score < 0 || score > 20
      ? 'Enter a whole-number score from 0 to 20.' : '');
    context.setCustomValidity(Object.hasOwn(contexts, context.value) ? '' : 'Choose an attempt type.');
    if (!input.reportValidity() || !context.reportValidity()) return;
    const record = pairRecord(pair);
    const old = record.papers[paper.paper];
    if (!old || old.score !== score || old.context !== context.value) record.reviewed = false;
    record.papers[paper.paper] = {score, context: context.value, updatedAt: new Date().toISOString()};
    records[pair.id] = record;
    persist();
    notice = `Paper ${paper.paper}: ${score}/20 recorded manually · ${contexts[context.value]}.`;
    render(`roadmap-save-${pair.id}-${paper.paper}`);
  }

  function makePaper(pair, paper, record) {
    const number = paper.paper;
    const saved = record.papers[number];
    const key = `${pair.id}-${number}`;
    const panel = node('div', `roadmap-paper roadmap-paper-${number}`);
    const title = node('h4', '', `Paper ${number}`);
    title.id = `roadmap-paper-${key}`;
    panel.setAttribute('aria-labelledby', title.id);
    const top = node('div', 'roadmap-paper-heading');
    top.append(node('span', 'roadmap-order', String(number)), title);
    panel.append(top);
    const actions = node('div', 'roadmap-paper-actions');
    const link = node('a', 'roadmap-open', `Open Paper ${number}`);
    link.href = paper.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', paper.kind === 'external'
      ? `Open Paper ${number} on JZMaths: ${pair.title} (new tab)`
      : `Open Paper ${number} PDF: ${pair.title} (new tab)`);
    const arrow = node('span', '', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    link.append(arrow);
    actions.append(link);
    if (paper.interactiveId) {
      const guided = node('a', 'roadmap-guided', 'Guided practice');
      guided.href = `#paper/${encodeURIComponent(paper.interactiveId)}`;
      guided.setAttribute('aria-label', `Guided practice: ${pair.title}, Paper ${number}`);
      actions.append(guided);
    }
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
        node('span', 'roadmap-score-context', `${contexts[saved.context]} · Manual record`));
    } else summary.append(node('span', '', 'Record a score'));
    details.append(summary);
    const form = node('form', 'roadmap-score-form');
    form.setAttribute('aria-label', `Manual score for ${pair.title}, Paper ${number}`);
    const scoreLabel = node('label', '', 'Manual score');
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
    input.addEventListener('input', () => input.setCustomValidity(''));
    const outOf = node('span', '', '/ 20');
    outOf.id = `roadmap-outof-${key}`;
    scoreLine.append(input, outOf);
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
      const clear = node('button', 'roadmap-clear', 'Clear record');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        const updated = pairRecord(pair);
        delete updated.papers[number];
        updated.reviewed = false;
        records[pair.id] = updated;
        persist();
        notice = `Paper ${number} manual record cleared.`;
        render(`roadmap-score-${key}`);
      });
      buttons.append(clear);
    }
    form.append(scoreLabel, scoreLine, contextLabel, context, buttons);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      openForms.add(key);
      saveScore(pair, paper, input, context);
    });
    details.append(form);
    panel.append(details);
    return panel;
  }

  function makePair(pair, index, next, range) {
    const record = pairRecord(pair);
    const bothScores = Boolean(record.papers[1] && record.papers[2]);
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
      : record.papers[1] || record.papers[2] ? 'In progress' : 'Ready when you are';
    if (isNext) status = 'Up next';
    const badge = node('span', 'roadmap-stage-status', status);
    if (record.reviewed) badge.prepend(node('span', 'roadmap-checkmark', '✓ '));
    heading.append(naming, badge);
    stage.append(heading);
    if (pair.focus.trim()) stage.append(node('p', 'roadmap-focus', pair.focus));
    if (isNext) {
      const nextStep = bothScores ? 'Review both papers and finish your corrections.'
        : record.papers[1] ? 'Continue with Paper 2, then review the pair.' : 'Start with Paper 1, then work through Paper 2.';
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
      updated.reviewed = checkbox.checked && Boolean(updated.papers[1] && updated.papers[2]);
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
    const next = nextIndex();
    const range = visibleRange(next);
    const completed = pairs.filter((pair) => pairRecord(pair).reviewed).length;
    section.classList.add('roadmap-section');
    section.setAttribute('aria-labelledby', 'roadmap-heading');
    const head = node('div', 'roadmap-header');
    const copy = node('div');
    copy.append(node('div', 'eyebrow', 'Your paired roadmap'));
    const title = node('h2', '', 'One pair at a time.');
    title.id = 'roadmap-heading';
    copy.append(title, node('p', 'roadmap-intro', 'Work through Paper 1 then Paper 2. Review your answers before the next pair.'));
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
      ? `All ${pairs.length} stages are available.`
      : `Showing stages ${range.start + 1}–${range.end} of ${pairs.length}. You can open any pair from the full roadmap.`);
    const manualNote = node('p', 'roadmap-manual-note', 'Scores entered here are manual records. Guided-practice scores stay separate.');
    const live = node('p', 'roadmap-notice', '');
    live.id = 'roadmap-notice';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const storage = node('p', 'roadmap-storage', persistenceAvailable
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
  load();
})();
