/* Pure progress calculations shared by the student's Concepts page and manager view. */
(() => {
  'use strict';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
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
  function snapshots({papers, library = {}, history = []}) {
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
  function evidence({papers, lessons, library = {}, history = []}) {
    const originals = new Map(), registry = new Map();
    for (const paper of papers) for (const question of paper.questions) {
      if (!registry.has(question.canonicalSourceId)) registry.set(question.canonicalSourceId, {lessonIds:new Set(), sources:new Set()});
      const definition = registry.get(question.canonicalSourceId);
      question.lessonIds.forEach(id => definition.lessonIds.add(id));
      definition.sources.add(question.sourceId);
    }
    for (const snapshot of snapshots({papers, library, history})) {
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


  // Reading a snapshot never changes it or imports it into the current account.
  function attempts({papers, library = {}, history = []}) {
    const merged = new Map();
    function validHistory(entry) {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.paperId !== 'string'
        || typeof entry.title !== 'string' || !entry.title.trim() || ![1,2].includes(entry.paper)
        || !['guided','manual'].includes(entry.source) || !['first','practised'].includes(entry.attemptContext)
        || !Number.isInteger(entry.total) || entry.total < 1 || entry.total > 1000
        || !Number.isInteger(entry.firstCorrect) || entry.firstCorrect < 0 || entry.firstCorrect > entry.total) return null;
      const finished = entry.finished !== false && Boolean(date(entry.completedAt));
      const answered = finished ? entry.total : entry.firstAttempted;
      if (!finished && (entry.finished !== false || !Number.isInteger(answered) || answered < entry.firstCorrect || answered > entry.total)) return null;
      if (entry.afterCorrect !== null && (!Number.isInteger(entry.afterCorrect) || entry.afterCorrect < entry.firstCorrect || entry.afterCorrect > answered)) return null;
      const when = entry.completedAt || entry.updatedAt || entry.startedAt;
      if (!date(when)) return null;
      return {...entry, finished, firstAttempted:answered, current:false, date:when};
    }
    function add(row) {
      const previous = merged.get(row.id);
      const time = date(row.updatedAt) || date(row.date);
      const oldTime = date(previous?.updatedAt) || date(previous?.date);
      if (!previous || time > oldTime || (time === oldTime && row.current)) merged.set(row.id, row);
    }
    history.forEach(entry => { const row = validHistory(entry); if (row) add(row); });
    for (const paper of papers) {
      const saved = Object.hasOwn(library, paper.id) ? library[paper.id] : null;
      const progress = saved?.progress, total = paper.questions.length;
      if (!object(saved) || saved.version !== paper.version || !object(progress) || total !== 20 || progress.total !== total
        || typeof progress.finished !== 'boolean' || !date(saved.updatedAt)) continue;
      const counts = ['questionIndex','completed','firstCorrect','firstAttempted','practiceCorrect','practiceAttempted'];
      if (counts.some(key => !Number.isInteger(progress[key]) || progress[key] < 0 || progress[key] > total * (key.startsWith('practice') ? 3 : 1))
        || progress.questionIndex >= total || !progress.firstAttempted || progress.completed > progress.firstAttempted
        || progress.firstCorrect > progress.firstAttempted || progress.practiceCorrect > progress.practiceAttempted
        || (progress.finished && progress.completed !== total)) continue;
      if (progress.afterKnown !== undefined && typeof progress.afterKnown !== 'boolean') continue;
      if (progress.afterKnown === true && (!Number.isInteger(progress.afterCorrect) || progress.afterCorrect < progress.firstCorrect || progress.afterCorrect > progress.firstAttempted)) continue;
      if (progress.afterKnown === false && progress.afterCorrect !== null) continue;
      const samePaper = [...merged.values()].filter(row => row.paperId === paper.id && row.source === 'guided');
      const legacy = !progress.attemptId && samePaper.find(row => row.attemptNumber === (saved.attemptNumber || 1));
      const id = legacy?.id || `guided:${paper.id}:${progress.attemptId || saved.attemptKey || saved.updatedAt}`;
      const previous = merged.get(id);
      const number = saved.attemptNumber || previous?.attemptNumber || samePaper.reduce((n,row) => Math.max(n,row.attemptNumber || 0),0) + 1;
      add({id, paperId:paper.id, title:paper.title, paper:paper.paper, total,
        firstCorrect:progress.firstCorrect, firstAttempted:progress.firstAttempted,
        afterCorrect:progress.afterKnown === true ? progress.afterCorrect : null,
        finished:progress.finished, completedAt:progress.finished ? previous?.completedAt || saved.updatedAt : null,
        date:progress.finished ? previous?.completedAt || saved.updatedAt : saved.updatedAt,
        updatedAt:saved.updatedAt, startedAt:progress.startedAt || saved.startedAt,
        attemptNumber:number, source:'guided', attemptContext:previous?.attemptContext || (number > 1 ? 'practised' : 'first'),
        current:!progress.finished, state:saved.state, answerLog:saved.answerLog || [], progress});
    }
    const numbers = new Map();
    return [...merged.values()].sort((a,b) => date(a.date) - date(b.date) || a.id.localeCompare(b.id)).map(row => {
      const next = (numbers.get(row.paperId) || 0) + 1;
      const number = Number.isInteger(row.attemptNumber) && row.attemptNumber > 0 ? row.attemptNumber : next;
      numbers.set(row.paperId, Math.max(number,next));
      return {...row, attemptNumber:number};
    });
  }

  window.TmuaProgressAnalytics = Object.freeze({validateMap, validateLessons, result, snapshots, evidence, attempts});
})();
