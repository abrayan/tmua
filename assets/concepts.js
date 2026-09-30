(() => {
  'use strict';
  const section = document.getElementById('concepts-section');
  if (!section) return;
  const base = new URL('.', window.location.href);
  const libraryKey = `tmua-practice-library-v1:${base.pathname}`;
  const historyKey = `tmua-attempt-history-v1:${base.pathname}`;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } };
  let library = read(libraryKey, {}), history = read(historyKey, {}).attempts || [];
  let papers = [], lessons = [], selectedPaper = 1, libraryPersistent = true, historyPersistent = true;
  if (!object(library)) library = {};
  if (!Array.isArray(history)) history = [];

  const {validateMap, validateLessons} = window.TmuaProgressAnalytics;
  const evidence = () => window.TmuaProgressAnalytics.evidence({papers,lessons,library,history});

  section.classList.add('concepts-section');
  section.setAttribute('aria-labelledby','concepts-heading');
  section.innerHTML = '<div class="concepts-heading"><div class="eyebrow">Your mathematical knowledge</div><h2 id="concepts-heading" tabindex="-1">Concepts</h2><p>Build on your booklet lessons, then learn the additional concepts that appear in TMUA.</p></div>' +
    '<div class="concepts-tabs" role="tablist" aria-label="Concepts by paper">' + [1,2].map(paper => `<button type="button" role="tab" id="concepts-tab-${paper}" aria-controls="concepts-panel-${paper}" data-concepts-paper="${paper}">Paper ${paper} concepts</button>`).join('') + '</div>' +
    '<div class="concepts-guide"><p><strong>Your percentage is a weighted practice indicator, not a TMUA grade.</strong> Each unique original question contributes once: <strong>100</strong> for a correct independent first encounter, <strong>50</strong> for a correct answer with hints before the full solution, <strong>25</strong> after a full solution, a retry or help whose timing was not recorded, and <strong>0</strong> for an attempted question not yet solved.</p><p>Repeated sittings and exact reprints cannot earn new independent credit; a later solve can add at most 25 points. Opening a recap after a correct answer does not reduce it. A question may test several lessons, so its outcome contributes to each linked lesson; it cannot identify which particular step you understood. Unattempted questions and manually entered totals are excluded.</p></div>' +
    [1,2].map(paper => `<div id="concepts-panel-${paper}" role="tabpanel" aria-labelledby="concepts-tab-${paper}" tabindex="0"><p class="concepts-empty">Loading your concepts…</p></div>`).join('');
  function activate(paper, focus=false) {
    selectedPaper = paper;
    [1,2].forEach(number => {
      const tab = document.getElementById(`concepts-tab-${number}`);
      tab.setAttribute('aria-selected', String(number === paper));
      tab.tabIndex = number === paper ? 0 : -1;
      document.getElementById(`concepts-panel-${number}`).hidden = number !== paper;
    });
    if (focus) document.getElementById(`concepts-tab-${paper}`).focus();
  }
  function reference(lesson) { if (lesson.additional) return `Paper ${lesson.paper} · Beyond the booklets`; return `Paper ${lesson.paper} · Booklet ${lesson.booklet} · Lesson ${lesson.lesson} · p. ${lesson.printedPage || lesson.pdfPage}`; }
  function card(row) {
    const status = !row.total ? {kind:'untested',label:'Not yet tested'} : row.total < 3 ? {kind:'building',label:'Building evidence'} : row.score >= 80 ? {kind:'strong',label:'Strong so far'} : {kind:'practice',label:'Needs practice'};
    const count = `${row.total} unique question${row.total === 1 ? '' : 's'}`;
    const detail = row.questions.map(question => `<li><a href="#paper/${encodeURIComponent(question.paperId)}">${escape(question.sourceId.replace(/^(\d{4})-P([12])-Q0?/, '$1 · P$2 · Q'))}</a><span>${escape(question.knowledgePattern)}</span><span>${escape(question.label)} · ${question.score} / 100</span>${question.sources.size > 1 ? `<span class="concepts-reprint">Same original: ${[...question.sources].map(escape).join(' / ')} · counted once</span>` : ''}</li>`).join('');
    return `<article class="concepts-card" data-concept="${escape(row.id)}"${row.score === null ? '' : ` data-score="${row.score}"`}><p class="concepts-reference">${reference(row)}</p>${row.additional ? '<span class="concepts-new-learning">New learning</span>' : ''}<div class="concepts-card-heading"><h3>${escape(row.title)}</h3><strong class="concepts-percentage">${row.score === null ? '—' : `${row.score}%`}</strong></div><div class="concepts-card-meta"><span class="concepts-status concepts-status-${status.kind}">${status.label}</span><span>${count}</span></div>${row.total ? `<div class="concepts-track" role="img" aria-label="${row.score}% weighted practice indicator from ${count}"><span class="concepts-fill" style="width:${row.score}%"></span></div>` : '<p class="concepts-not-tested">Answer a linked question to begin. No score is assigned yet.</p>'}<details><summary>${row.additional ? 'Learn this concept · example and common mistake' : 'Knowledge and question evidence'}</summary>${row.additional ? window.TmuaProgressAnalytics.learningDetails(row) : `<ul class="concepts-knowledge">${row.knowledge.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`}${detail ? `<h4>Tested patterns</h4><ul class="concepts-question-list">${detail}</ul><p class="concepts-denominator">Percentage = total question points ÷ ${count}. Each question has a maximum of 100 points.</p>` : '<p>No question-level evidence yet.</p>'}</details></article>`;
  }
  function render() {
    const rows = evidence();
    [1,2].forEach(number => {
      const selected = rows.filter(row => row.paper === number), tested = selected.filter(row => row.total > 0);
      const originals = new Set(selected.flatMap(row => row.questions.map(question => question.canonicalSourceId)));
      const booklets = [...new Set(selected.filter(row => !row.additional).map(row => row.booklet))];
      document.getElementById(`concepts-panel-${number}`).innerHTML = `<p class="concepts-scope">${number === 1 ? 'Paper 1 mathematical knowledge also applies to Paper 2. These concepts support both papers.' : 'Paper 2 focuses on mathematical reasoning. Use these ideas alongside the mathematical knowledge in the Paper 1 tab.'}</p>${selected.some(row => row.additional) ? `<button class="concepts-jump" type="button" data-concepts-extra="${number}">Explore additional concepts <span aria-hidden="true">↓</span></button>` : ''}<p class="concepts-context"><strong>${tested.length} of ${selected.length} concepts have evidence</strong> · ${originals.size} unique original question${originals.size === 1 ? '' : 's'}<br>Fewer than 3 questions: building evidence. With 3 or more, 80% or above is strong so far.</p>` + booklets.map(booklet => {
        const group = selected.filter(row => row.booklet === booklet);
        return `<section class="concepts-booklet" aria-label="Booklet ${booklet}"><h3>Booklet ${booklet} <span>${escape(group[0].bookletTitle)}</span></h3><div class="concepts-cards">${group.map(card).join('')}</div></section>`;
      }).join('') + (selected.some(row => row.additional) ? `<section class="concepts-booklet" aria-label="Beyond the booklets"><h3 id="concepts-extra-heading-${number}" tabindex="-1">Beyond the booklets <span>Additional TMUA knowledge</span></h3><p class="concepts-additional-note">Open a concept for a short lesson, a worked example and a common mistake to avoid.</p><div class="concepts-cards">${selected.filter(row => row.additional).map(card).join('')}</div></section>` : '');
    });
    activate(selectedPaper);
  }
  function route() {
    const active = window.location.hash === '#concepts';
    const studentActive = window.location.hash === '#student-progress' && window.TmuaCloud?.role === 'manager';
    const studentSection = document.getElementById('student-progress-section');
    if (studentSection) studentSection.hidden = !studentActive;
    section.hidden = !active;
    for (const id of ['welcome-section', 'course-layout']) {
      const node = document.getElementById(id);
      if (node) node.hidden = active || studentActive;
    }
    for (const [id, current] of [['course-tab-concepts',active], ['course-tab-papers',!active && !studentActive], ['course-tab-student',studentActive]]) {
      const node = document.getElementById(id);
      if (node) node.setAttribute('aria-current', current ? 'page' : 'false');
    }
    if (active) document.title = 'Concepts · TMUA practice';
    if (studentActive) document.title = 'Ryan’s progress · TMUA practice';
  }
  window.TmuaConcepts = {route};
  window.addEventListener('hashchange', route);
  section.addEventListener('click', event => {
    const jump = event.target.closest('[data-concepts-extra]');
    if (jump) {
      const heading = document.getElementById(`concepts-extra-heading-${Number(jump.dataset.conceptsExtra)}`);
      heading?.scrollIntoView({block:'start'}); heading?.focus({preventScroll:true});
      return;
    }
    const tab = event.target.closest('[data-concepts-paper]');
    if (tab) activate(Number(tab.dataset.conceptsPaper));
  });
  section.addEventListener('keydown', event => {
    if (!event.target.closest('[data-concepts-paper]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    activate(event.key === 'Home' ? 1 : event.key === 'End' ? 2 : selectedPaper === 1 ? 2 : 1, true);
  });
  document.addEventListener('tmua-local-updated', event => {
    if (event.detail?.kind === 'library' && object(event.detail.value)) library = event.detail.value;
    if (event.detail?.kind === 'history' && Array.isArray(event.detail.value?.attempts)) history = event.detail.value.attempts;
    render();
  });
  document.addEventListener('tmua-history-updated', event => { if (Array.isArray(event.detail?.attempts)) { history = event.detail.attempts; render(); } });
  document.addEventListener('tmua-cloud-applied', event => {
    if (!object(event.detail?.payload?.library)) return;
    library = event.detail.payload.library;
    history = Array.isArray(event.detail.payload.history?.attempts) ? event.detail.payload.history.attempts : [];
    libraryPersistent = event.detail.persistence?.library !== false;
    historyPersistent = event.detail.persistence?.history !== false;
    render();
  });
  document.addEventListener('tmua-cloud-lock', () => { library = {}; history = []; libraryPersistent = false; historyPersistent = false; render(); });
  window.addEventListener('storage', event => {
    if (libraryPersistent && (event.key === libraryKey || event.key === null)) { const value = read(libraryKey, {}); library = object(value) ? value : {}; }
    if (historyPersistent && (event.key === historyKey || event.key === null)) { const value = read(historyKey, {}); history = Array.isArray(value.attempts) ? value.attempts : []; }
    render();
  });
  activate(selectedPaper); route();
  Promise.all(['concept-map.json', 'studied-concepts.json'].map(name => fetch(new URL(`assets/${name}`,base), {cache:'no-cache'}).then(response => { if (!response.ok) throw Error('Cannot load concepts'); return response.json(); }))).then(([map, catalogue]) => {
    papers = validateMap(map); lessons = validateLessons(catalogue);
    const known = new Set(lessons.map(lesson => lesson.id));
    if (papers.some(paper => paper.questions.some(question => question.lessonIds.some(id => !known.has(id))))) throw Error('Unknown concept');
    render();
  }).catch(() => { [1,2].forEach(paper => { document.getElementById(`concepts-panel-${paper}`).innerHTML = '<div class="concepts-empty"><h3>Your concept progress could not be loaded.</h3><p>Refresh the page to try again. Your saved answers are unchanged.</p></div>'; }); });
})();
