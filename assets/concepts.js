(() => {
  'use strict';
  const section = document.getElementById('concepts-section');
  if (!section) return;
  const base = new URL('.', window.location.href);
  const libraryKey = `tmua-practice-library-v1:${base.pathname}`;
  const historyKey = `tmua-attempt-history-v1:${base.pathname}`;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } };
  let library = read(libraryKey, {}), history = read(historyKey, {}).attempts || [];
  let papers = [], lessons = [], selectedPaper = 1, libraryPersistent = true, historyPersistent = true;
  if (!object(library)) library = {};
  if (!Array.isArray(history)) history = [];

  function validateMap(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.papers)) throw Error('Unavailable map');
    const seen = new Set();
    for (const paper of value.papers) {
      if (!object(paper) || !/^[a-z0-9-]{1,80}$/.test(paper.id) || seen.has(paper.id) || ![1, 2].includes(paper.paper) || paper.version !== 1 || typeof paper.title !== 'string' || !Array.isArray(paper.questions) || !paper.questions.length || !Array.isArray(paper.contentRevisions) || !paper.contentRevisions.every(n => Number.isInteger(n) && n > 0)) throw Error('Invalid paper');
      seen.add(paper.id);
      const originals = new Set();
      for (const question of paper.questions) {
        if (!object(question) || !/^[A-Z0-9-]{1,80}$/.test(question.sourceId) || originals.has(question.sourceId) || !/^[A-Z0-9-]{1,80}$/.test(question.canonicalSourceId) || typeof question.knowledgePattern !== 'string' || !Array.isArray(question.lessonIds) || !question.lessonIds.length || !question.lessonIds.every(id => /^p[12]-(?:b\d+-l\d+|extra-[a-z0-9-]+)$/.test(id))) throw Error('Invalid question');
        originals.add(question.sourceId);
      }
    }
    return value.papers;
  }
  function validateLessons(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.lessons) || !value.lessons.length) throw Error('Unavailable lessons');
    const ids = new Set();
    for (const lesson of value.lessons) {
      if (!object(lesson) || !/^p[12]-b\d+-l\d+$/.test(lesson.id) || ids.has(lesson.id) || ![1,2].includes(lesson.paper) || !Number.isInteger(lesson.booklet) || lesson.booklet < 1 || !Number.isInteger(lesson.lesson) || lesson.lesson < 1 || !Number.isInteger(lesson.pdfPage) || lesson.pdfPage < 1 || typeof lesson.title !== 'string' || !lesson.title.trim() || typeof lesson.bookletTitle !== 'string' || !Array.isArray(lesson.knowledge) || !lesson.knowledge.every(item => typeof item === 'string')) throw Error('Invalid lesson');
      ids.add(lesson.id);
    }
    const additional = value.additionalConcepts ?? [];
    if (!Array.isArray(additional)) throw Error('Invalid additional concepts');
    for (const concept of additional) {
      if (!object(concept) || !/^p[12]-extra-[a-z0-9-]+$/.test(concept.id) || ids.has(concept.id)
        || ![1,2].includes(concept.paper) || !concept.id.startsWith(`p${concept.paper}-`)
        || typeof concept.title !== 'string' || !concept.title.trim()
        || !Array.isArray(concept.knowledge) || !concept.knowledge.length || !concept.knowledge.every(item => typeof item === 'string' && item.trim())
        || !Array.isArray(concept.references) || !concept.references.length
        || concept.references.some(ref => {
          if (!object(ref) || !['syllabus','question'].includes(ref.type) || typeof ref.label !== 'string' || !ref.label.trim()) return true;
          try { const url = new URL(ref.url); return url.protocol !== 'https:' || Boolean(url.username || url.password); } catch (_) { return true; }
        })) throw Error('Additional concepts need an official syllabus or question reference');
      ids.add(concept.id);
    }
    return [...value.lessons, ...additional.map(concept => ({...concept, additional:true}))];
  }
  function result(record, log) {
    if (!object(record) || ![0,1].includes(record.first)) return null;
    const kind = record.firstKind === undefined ? 'answer' : record.firstKind;
    if (!['answer','hint'].includes(kind) || (kind === 'hint' && record.first !== 0)) return null;
    const solved = record.everSolved === undefined ? (record.first === 1 ? true : null) : record.everSolved;
    if (![true,false,null].includes(solved) || (record.first === 1 && solved !== true)) return null;
    // First success is immutable: opening the explanation afterwards is recap.
    if (record.first === 1) return {score:100, solved:true, label:'Correct independently on the first encounter'};
    if (solved !== true) return {score:0, solved:false, label:solved === null ? 'Attempted · later result not recorded' : 'Attempted · not yet solved'};
    if (object(log) && log.solvedWithHints === true && log.solutionSeenBeforeSolve === false) return {score:50, solved:true, label:'Correct with hints, before the full solution'};
    return {score:25, solved:true, label:log?.solutionSeenBeforeSolve === true ? 'Correct after viewing the full solution' : 'Correct on a retry or with earlier help not recorded'};
  }
  function snapshots() {
    const all = [];
    for (const paper of papers) {
      const current = library[paper.id];
      if (object(current) && current.version === paper.version) all.push({paper, saved:current, current:true});
      for (const entry of history) {
        if (object(entry) && entry.paperId === paper.id && entry.source === 'guided') all.push({paper, saved:entry, current:false});
      }
    }
    const merged = new Map();
    for (const item of all) {
      const {paper, saved} = item, state = saved.state;
      if (!object(state) || state.version !== 1 || !paper.contentRevisions.includes(state.contentRevision ?? 1) || !Array.isArray(state.records) || state.records.length !== paper.questions.length) continue;
      const rawId = saved.progress?.attemptId || (typeof saved.id === 'string' ? saved.id.replace(`guided:${paper.id}:`, '') : null);
      const id = `${paper.id}:${rawId || `legacy-${saved.attemptNumber || 1}`}`;
      const started = date(saved.startedAt) || date(saved.progress?.startedAt) || date(state.startedAt) || date(saved.completedAt) || date(saved.updatedAt);
      const updated = date(saved.updatedAt) || date(saved.completedAt) || started;
      const old = merged.get(id);
      if (!old || updated > old.updated || (updated === old.updated && item.current)) merged.set(id, {...item, id, started, updated});
    }
    return [...merged.values()].sort((a,b) => a.started - b.started || a.updated - b.updated || a.id.localeCompare(b.id));
  }
  function evidence() {
    const originals = new Map(), registry = new Map();
    for (const paper of papers) for (const question of paper.questions) {
      if (!registry.has(question.canonicalSourceId)) registry.set(question.canonicalSourceId, {lessonIds:new Set(), sources:new Set()});
      const definition = registry.get(question.canonicalSourceId);
      question.lessonIds.forEach(id => definition.lessonIds.add(id));
      definition.sources.add(question.sourceId);
    }
    for (const snapshot of snapshots()) {
      const {paper, saved} = snapshot;
      paper.questions.forEach((question, index) => {
        const log = Array.isArray(saved.answerLog) ? saved.answerLog.find(entry => entry?.questionIndex === index) : null;
        const value = result(saved.state.records[index], log);
        if (!value) return;
        const original = question.canonicalSourceId, existing = originals.get(original);
        // Only the earliest recorded encounter can establish independence. A
        // known restarted/practised sitting also cannot claim a first encounter.
        const repeated = Boolean(existing) || saved.attemptNumber > 1 || saved.progress?.attemptNumber > 1 || saved.attemptContext === 'practised';
        const score = repeated ? (value.solved ? 25 : 0) : value.score;
        const detail = {...value, score, sourceId:question.sourceId, canonicalSourceId:original, paperId:paper.id, index:index+1, knowledgePattern:question.knowledgePattern, ...registry.get(original)};
        if (repeated && value.solved) detail.label = 'Correct on a repeated encounter · partial credit';
        if (!existing || score > existing.score) originals.set(original, detail);
      });
    }
    return lessons.map(lesson => {
      const questions = [...originals.values()].filter(item => item.lessonIds.has(lesson.id));
      const total = questions.length, points = questions.reduce((sum,item) => sum + item.score, 0);
      return {...lesson, questions, total, score:total ? Math.round(points / total * 10) / 10 : null};
    });
  }

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
    return `<article class="concepts-card" data-concept="${escape(row.id)}"${row.score === null ? '' : ` data-score="${row.score}"`}><p class="concepts-reference">${reference(row)}</p>${row.additional ? '<span class="concepts-new-learning">New learning</span>' : ''}<div class="concepts-card-heading"><h3>${escape(row.title)}</h3><strong class="concepts-percentage">${row.score === null ? '—' : `${row.score}%`}</strong></div><div class="concepts-card-meta"><span class="concepts-status concepts-status-${status.kind}">${status.label}</span><span>${count}</span></div>${row.total ? `<div class="concepts-track" role="img" aria-label="${row.score}% weighted practice indicator from ${count}"><span class="concepts-fill" style="width:${row.score}%"></span></div>` : '<p class="concepts-not-tested">Answer a linked question to begin. No score is assigned yet.</p>'}<details><summary>Knowledge and question evidence</summary><ul class="concepts-knowledge">${row.knowledge.map(item => `<li>${escape(item)}</li>`).join('')}</ul>${row.additional ? `<ul class="concepts-sources">${row.references.map(ref => `<li><a href="${escape(ref.url)}" target="_blank" rel="noopener noreferrer">${escape(ref.label)}</a></li>`).join('')}</ul>` : ''}${detail ? `<h4>Tested patterns</h4><ul class="concepts-question-list">${detail}</ul><p class="concepts-denominator">Percentage = total question points ÷ ${count}. Each question has a maximum of 100 points.</p>` : '<p>No question-level evidence yet.</p>'}</details></article>`;
  }
  function render() {
    const rows = evidence();
    [1,2].forEach(number => {
      const selected = rows.filter(row => row.paper === number), tested = selected.filter(row => row.total > 0);
      const originals = new Set(selected.flatMap(row => row.questions.map(question => question.canonicalSourceId)));
      const booklets = [...new Set(selected.filter(row => !row.additional).map(row => row.booklet))];
      document.getElementById(`concepts-panel-${number}`).innerHTML = `<p class="concepts-context"><strong>${tested.length} of ${selected.length} concepts have evidence</strong> · ${originals.size} unique original question${originals.size === 1 ? '' : 's'}<br>Fewer than 3 questions: building evidence. With 3 or more, 80% or above is strong so far.</p>` + booklets.map(booklet => {
        const group = selected.filter(row => row.booklet === booklet);
        return `<section class="concepts-booklet" aria-label="Booklet ${booklet}"><h3>Booklet ${booklet} <span>${escape(group[0].bookletTitle)}</span></h3><div class="concepts-cards">${group.map(card).join('')}</div></section>`;
      }).join('') + (selected.some(row => row.additional) ? `<section class="concepts-booklet" aria-label="Beyond the booklets"><h3>Beyond the booklets <span>Additional TMUA knowledge</span></h3><div class="concepts-cards">${selected.filter(row => row.additional).map(card).join('')}</div></section>` : '');
    });
    activate(selectedPaper);
  }
  function route() {
    const active = window.location.hash === '#concepts';
    section.hidden = !active;
    for (const id of ['welcome-section', 'course-layout']) {
      const node = document.getElementById(id);
      if (node) node.hidden = active;
    }
    for (const [id, current] of [['course-tab-concepts',active], ['course-tab-papers',!active]]) {
      const node = document.getElementById(id);
      if (node) node.setAttribute('aria-current', current ? 'page' : 'false');
    }
    if (active) document.title = 'Concepts · TMUA practice';
  }
  window.TmuaConcepts = {route};
  window.addEventListener('hashchange', route);
  section.addEventListener('click', event => {
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
