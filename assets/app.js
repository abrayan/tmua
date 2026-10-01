(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const siteBase = new URL('.', window.location.href);
  const storageKey = `tmua-practice-library-v1:${siteBase.pathname}`;
  let frame = byId('paper-frame');
  let papers = [];
  let publicPapers = [];
  let playerGeneration = 0;
  let selectedCategory = null;
  let activePaper = null;
  let repeatButton = null;
  let editionNotice = null;
  let catalogReady = false;
  let loading = false;
  let libraryPersistent = true;
  let saved = readSaved();
  const historyKey = `tmua-attempt-history-v1:${siteBase.pathname}`;
  let memoryHistory = [];
  let historyPersistent = true;
  const retiredAttempts = new Set();
  const copy = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
  const hasActivity = record => record?.progress?.firstAttempted > 0 || record?.progress?.completed > 0;
  const attemptDate = entry => entry.completedAt || entry.updatedAt || entry.startedAt;
  function readHistory() {
    if (!historyPersistent) return memoryHistory;
    try { const value = JSON.parse(localStorage.getItem(historyKey) || 'null');
      return value?.version === 1 && Array.isArray(value.attempts) ? value.attempts.filter(e=>e && typeof e.id==='string' && typeof e.paperId==='string' && typeof e.title==='string' && [1,2].includes(e.paper) && Number.isInteger(e.total) && e.total>0 && e.total<=1000 && Number.isInteger(e.firstCorrect) && e.firstCorrect>=0 && e.firstCorrect<=e.total && (e.afterCorrect===null || Number.isInteger(e.afterCorrect) && e.afterCorrect>=e.firstCorrect && e.afterCorrect<=e.total) && typeof attemptDate(e)==='string' && Number.isFinite(Date.parse(attemptDate(e)))) : [];
    } catch (_) { return memoryHistory; }
  }
  function attemptNumber(paper, id, attempts = readHistory()) {
    const same = attempts.filter(entry => entry.paperId === paper.id).sort((a,b) => Date.parse(attemptDate(a)) - Date.parse(attemptDate(b)));
    const previous = same.find(entry => entry.id === id);
    if (previous) return previous.attemptNumber || same.indexOf(previous) + 1;
    return same.reduce((max, entry, index) => Math.max(max, entry.attemptNumber || index + 1), 0) + 1;
  }
  function recordAttempt(paper, record, archive = false) {
    const progress = record?.progress;
    if (!hasActivity(record) || (!progress.finished && !archive)) return;
    const attempts = readHistory();
    const id = `guided:${paper.id}:${progress.attemptId || record.attemptKey || record.updatedAt}`;
    const previous = attempts.find(entry => entry.id === id);
    const now = new Date().toISOString();
    const entry = {id, paperId:paper.id, title:paper.title, paper:paper.paper,
      attemptNumber:previous?.attemptNumber || record.attemptNumber || attemptNumber(paper,id,attempts),
      total:paper.questionCount, firstCorrect:previous?.finished !== false ? previous?.firstCorrect ?? progress.firstCorrect : progress.firstCorrect,
      afterCorrect:progress.afterKnown ? Math.max(previous?.afterCorrect ?? 0, progress.afterCorrect) : previous?.afterCorrect ?? null,
      completedAt:previous?.completedAt || (progress.finished ? now : null), finished:progress.finished,
      startedAt:previous?.startedAt || progress.startedAt || record.updatedAt || now, updatedAt:record.updatedAt || now,
      firstAttempted:progress.firstAttempted, source:'guided',
      attemptContext:previous?.attemptContext || (attempts.some(item => item.paperId===paper.id && item.id!==id) ? 'practised' : 'first'),
      state:copy(record.state), answerLog:copy(record.answerLog || []), progress:copy(progress),
      teachingEdition:record.teachingEdition ?? 'original'};
    memoryHistory = [...attempts.filter(item => item.id !== id),entry];
    try { localStorage.setItem(historyKey,JSON.stringify({version:1,attempts:memoryHistory})); historyPersistent=true; }
    catch (_) { historyPersistent=false; }
    document.dispatchEvent(new CustomEvent('tmua-history-updated',{detail:{attempts:memoryHistory,persisted:historyPersistent}}));
  }
  document.addEventListener('tmua-history-updated',event=>{if(Array.isArray(event.detail?.attempts)) memoryHistory=event.detail.attempts;if(typeof event.detail?.persisted==='boolean')historyPersistent=event.detail.persisted;});

  function clearPlayerFrame() {
    ++playerGeneration;
    frame.removeAttribute('src');
    frame.removeAttribute('srcdoc');
    // A new browsing context rejects queued messages from the prior account or
    // sitting; an iframe WindowProxy would otherwise survive a URL change.
    if (typeof frame.cloneNode === 'function' && typeof frame.replaceWith === 'function') {
      const replacement = frame.cloneNode(false);
      frame.replaceWith(replacement); frame = replacement;
    }
    activePaper = null;
  }
  function readSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function captureAnswers(state, previous) {
    if (!Array.isArray(state.records)) return previous?.answerLog || [];
    return state.records.map((record,index) => {
      const old = previous?.answerLog?.find(answer => answer.questionIndex === index);
      const before = previous?.state?.records?.[index];
      const selected = state.questionIndex === index && state.mode === 'original' && ['correct','incorrect'].includes(state.lastOutcome) && /^[A-J]$/.test(state.selected || '') ? state.selected : null;
      const firstKind = record.firstKind === undefined ? record.first === null ? null : 'answer' : record.firstKind;
      // A restored old answer cannot be reconstructed from correctness alone.
      const firstAnswer = old?.firstAnswer || (selected && firstKind === 'answer' && before?.first === null ? selected : null);
      const newSubmission = selected && (!previous?.state || state.lastOutcome !== previous.state.lastOutcome || selected !== previous.state.selected || previous.state.solutionVisible === false && state.solutionVisible === true);
      const hintCount = Math.max(old?.hintCount || 0,state.questionIndex === index && state.mode === 'original' && Number.isInteger(state.piecesShown) ? state.piecesShown : 0);
      const solve = old && typeof old.helpUsedBeforeSolve === 'boolean' ? {
        helpUsedBeforeSolve:old.helpUsedBeforeSolve,solutionSeenBeforeSolve:old.solutionSeenBeforeSolve,solvedWithHints:old.solvedWithHints
      } : record.first === 1 ? {helpUsedBeforeSolve:false,solutionSeenBeforeSolve:false,solvedWithHints:false}
        : record.everSolved === true && before && before.everSolved === false ? {
          helpUsedBeforeSolve:hintCount > 0 || firstKind === 'hint',
          solutionSeenBeforeSolve:Boolean(old?.solutionViewed || before.originalReviewed),
          solvedWithHints:Boolean((hintCount > 0 || firstKind === 'hint') && !old?.solutionViewed && !before.originalReviewed)
        } : {};
      return {questionIndex:index, firstAnswer, latestAnswer:selected || old?.latestAnswer || null,
        firstKind, firstCorrect:record.first, afterCorrect:record.everSolved === undefined ? record.first === 1 ? true : record.first === null ? false : null : record.everSolved,
        hintCount,solutionViewed:Boolean(old?.solutionViewed || record.originalReviewed),...solve,
        assisted:Boolean(old?.assisted || firstKind === 'hint' || state.questionIndex === index && state.mode === 'original' && (state.helpVisible || state.piecesShown > 0 || newSubmission && before?.originalReviewed))};
    });
  }
  function persistLibrary() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved));
      libraryPersistent = true;
      byId('storage-note').textContent = 'Progress is saved in this browser.';
    } catch (_) {
      libraryPersistent = false;
      byId('storage-note').textContent = 'Progress is available for this visit.';
    }
    document.dispatchEvent(new CustomEvent('tmua-local-updated',{detail:{kind:'library',value:saved,persisted:libraryPersistent}}));
  }
  function saveProgress(paper, state, progress) {
    const selected = teachingRoute(paper);
    if (!selected || selected.id !== paper.teachingEdition) { editionUnavailable(paper); return false; }
    if (progress.attemptId && retiredAttempts.has(`${paper.id}:${progress.attemptId}`)) return false;
    let previous = saved[paper.id];
    if (hasActivity(previous) && !previous.progress.finished && progress.firstAttempted < previous.progress.firstAttempted) {
      byId('storage-note').textContent = 'Your earlier attempt is safe. Return to the library to continue it or start another attempt.';
      return false;
    }
    if (previous?.progress?.attemptId && progress.attemptId && previous.progress.attemptId !== progress.attemptId) {
      const latest = papers.find(item => item.id === paper.id) || paper;
      // Frozen players have their own 'start new attempt' action. Its empty
      // first save must switch teaching before any new answers are accepted.
      if (previous.progress.finished && progress.firstAttempted === 0 && teachingRoute(latest,null)?.id !== paper.teachingEdition) {
        startAnotherAttempt(latest); return false;
      }
      if (hasActivity(previous) && !previous.progress.finished) {
        byId('storage-note').textContent = 'Your earlier attempt is safe. Return to the library to continue it or start another attempt.';
        return false;
      }
      recordAttempt(paper,previous,true);
      retiredAttempts.add(`${paper.id}:${previous.progress.attemptId}`);
      previous = null;
    }
    const now = new Date().toISOString();
    const attemptKey = progress.attemptId || previous?.attemptKey || `legacy-${now}`;
    const id = `guided:${paper.id}:${attemptKey}`;
    const record = {...previous, version:paper.version, state:copy(state), progress:copy(progress), attemptKey,
      answerLog:captureAnswers(state,previous), updatedAt:now, teachingEdition:paper.teachingEdition || 'original'};
    if (hasActivity(record)) record.attemptNumber = previous?.attemptNumber || attemptNumber(paper,id);
    saved[paper.id] = record;
    recordAttempt(paper,record);
    persistLibrary();
    return true;
  }
  function startAnotherAttempt(paper) {
    if (window.TmuaCloud?.blocked) return;
    const previous = storedFor(paper);
    if (!previous || (!hasActivity(previous) && !previous.state && previous.teachingEdition === undefined)) return;
    recordAttempt(paper,previous,true);
    if (previous.progress?.attemptId) retiredAttempts.add(`${paper.id}:${previous.progress.attemptId}`);
    // The previous snapshot is now in history, including unfinished work.
    delete saved[paper.id];
    persistLibrary();
    if (activePaper) clearPlayerFrame();
    window.location.hash = `paper/${paper.id}`;
    openPaper(papers.find(item => item.id === paper.id) || paper);
  }
  function storedFor(paper) {
    const value = saved[paper.id];
    return value && value.version === paper.version ? value : null;
  }
  function safePaper(value) {
    if (!value || typeof value !== 'object' || value.format !== 'tmua-paper-v1' || value.version !== 1) return null;
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.id) || ![1, 2].includes(value.paper)) return null;
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) return null;
    if (typeof value.source !== 'string' || typeof value.description !== 'string') return null;
    if (!Number.isInteger(value.questionCount) || value.questionCount < 1 || value.questionCount > 1000) return null;
    if (typeof value.href !== 'string' || !value.href.startsWith('papers/') || !/\.html$/i.test(value.href)) return null;
    const url = new URL(value.href, siteBase);
    if (url.origin !== siteBase.origin || !url.pathname.startsWith(new URL('papers/', siteBase).pathname) || url.search || url.hash) return null;
    if (value.contentHash !== undefined) {
      if (typeof value.contentHash !== 'string' || !/^[a-f0-9]{16}$/.test(value.contentHash)) return null;
      url.searchParams.set('v', value.contentHash);
    }
    const editions = [], seen = new Set();
    if (value.editions !== undefined) {
      if (!Array.isArray(value.editions)) return null;
      for (const edition of value.editions) {
        if (!edition || typeof edition.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(edition.id) || edition.id === 'original' || seen.has(edition.id)
          || edition.href !== `assets/editions/${edition.id}/${value.id}.html` || typeof edition.contentHash !== 'string' || !/^[a-f0-9]{16}$/.test(edition.contentHash)) return null;
        const editionUrl = new URL(edition.href,siteBase);
        if (editionUrl.origin !== siteBase.origin || !editionUrl.pathname.startsWith(new URL('assets/editions/',siteBase).pathname) || editionUrl.search || editionUrl.hash) return null;
        editionUrl.searchParams.set('v',edition.contentHash);
        editions.push({...edition,url:editionUrl.href}); seen.add(edition.id);
      }
    }
    if (value.currentEditionId !== undefined && !seen.has(value.currentEditionId)) return null;
    if (editions.length && value.currentEditionId !== editions.at(-1).id) return null;
    return {...value, editions, url:url.href, originalUrl:url.href};
  }
  function teachingRoute(paper, record = storedFor(paper)) {
    const historical = record && (record.state || hasActivity(record));
    const id = record?.teachingEdition !== undefined ? record.teachingEdition : historical ? 'original' : paper.currentEditionId || 'original';
    if (id === 'original') return paper.private ? null : {id, url:paper.originalUrl || paper.url};
    return paper.editions?.find(edition => edition.id === id) || null;
  }
  function editionUnavailable(paper) {
    clearPlayerFrame(); frame.hidden = true;
    byId('library-view').hidden = true; byId('player-view').hidden = false;
    byId('player-category').textContent = `Paper ${paper.paper}`;
    byId('player-title').textContent = paper.title;
    byId('player-progress').textContent = 'Saved teaching edition unavailable';
    if (repeatButton) repeatButton.hidden = true;
    if (!editionNotice) {
      editionNotice = el('div','load-error'); editionNotice.id = 'teaching-edition-unavailable';
      editionNotice.setAttribute('role','alert'); byId('player-view').prepend(editionNotice);
    }
    editionNotice.replaceChildren(el('h2','', 'This saved attempt needs its original teaching edition.'),
      el('p','', 'Your answers and scores are safe. Refresh the library to restore the missing edition, or deliberately start another attempt with the current teaching. Your saved work will remain in history.'));
    const fresh = el('button','button secondary','Start another attempt with current teaching');
    fresh.type = 'button'; fresh.addEventListener('click',() => startAnotherAttempt(paper));
    editionNotice.append(fresh); editionNotice.hidden = false;
  }
  function validatedProgress(value, paper) {
    if (!value || typeof value !== 'object') return null;
    const fields = ['questionIndex', 'completed', 'total', 'firstCorrect', 'firstAttempted', 'practiceCorrect', 'practiceAttempted'];
    const adaptive = paper.practicePolicy === 'after-miss-up-to-3';
    if (fields.some((field) => !Number.isInteger(value[field]) || value[field] < 0 || value[field] > paper.questionCount * (adaptive && field.startsWith('practice') ? 3 : 1))) return null;
    if (value.total !== paper.questionCount || value.questionIndex >= paper.questionCount || value.completed > value.firstAttempted) return null;
    if (value.firstCorrect > value.firstAttempted || value.practiceCorrect > value.practiceAttempted) return null;
    if (typeof value.finished !== 'boolean' || (value.finished && value.completed !== paper.questionCount)) return null;
    const extra = {};
    if (value.attemptId !== undefined) {
      if (typeof value.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.attemptId)) return null;
      if (typeof value.startedAt !== 'string' || value.startedAt.length>40 || !Number.isFinite(Date.parse(value.startedAt))) return null;
      if (typeof value.afterKnown !== 'boolean') return null;
      if (value.afterKnown ? (!Number.isInteger(value.afterCorrect) || value.afterCorrect<value.firstCorrect || value.afterCorrect>value.firstAttempted) : value.afterCorrect!==null) return null;
      Object.assign(extra,{attemptId:value.attemptId,startedAt:value.startedAt,afterKnown:value.afterKnown,afterCorrect:value.afterCorrect});
    }
    return {...Object.fromEntries([...fields, 'finished'].map((key) => [key, value[key]])),...extra};
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function countLabel(count) { return count === 1 ? '1 paper' : `${count} papers`; }
  function updateCounts() {
    [1, 2].forEach((type) => {
      const category = papers.filter((paper) => paper.paper === type);
      const full = category.filter(paper => paper.questionCount === 20).length;
      const samples = category.length - full;
      byId(`count-${type}`).textContent = catalogReady ? `${countLabel(full)}${samples ? ` · ${samples} sample${samples === 1 ? '' : 's'}` : ''}` : 'Loading papers…';
      byId(`choose-${type}`).setAttribute('aria-pressed', String(selectedCategory === type));
    });
  }
  function renderCard(paper) {
    const card = el('article', 'paper-card');
    const top = el('div', 'card-top');
    top.append(el('span', 'source-tag', paper.source), el('span', 'question-count', `${paper.questionCount} questions`));
    const title = el('h3', '', paper.title);
    title.id = `title-${paper.id}`;
    card.setAttribute('aria-labelledby', title.id);
    card.append(top, title, el('p', 'card-description', paper.description));
    const bottom = el('div', 'card-bottom');
    const record = storedFor(paper);
    const progress = record ? validatedProgress(record.progress, paper) : null;
    const attempted = progress && (progress.firstAttempted > 0 || progress.completed > 0);
    const completed = progress ? progress.completed : 0;
    const finished = progress && progress.finished;
    bottom.append(el('p', `paper-status${finished ? ' complete' : ''}`, finished ? '✓ Completed' : attempted ? `${completed} of ${paper.questionCount} exercises complete` : 'Ready when you are'));
    if (attempted) bottom.append(el('p','result-count',`Attempt ${record.attemptNumber || attemptNumber(paper,`guided:${paper.id}:${progress.attemptId}`)}`));
    if (finished) {
      const score = el('div', 'paper-score');
      const first = el('div');
      first.append(el('span', '', 'On your own · first answers'), el('strong', '', `${progress.firstCorrect}/${paper.questionCount}`));
      const practice = el('div');
      practice.append(el('span', '', 'After practice'), el('strong', '', progress.afterKnown ? `${progress.afterCorrect}/${paper.questionCount}` : 'Not recorded'));
      score.append(first, practice);
      bottom.append(score);
      bottom.append(el('p','result-count',progress.practiceAttempted ? `Similar questions: ${progress.practiceCorrect}/${progress.practiceAttempted} on first answer` : progress.firstCorrect===progress.firstAttempted ? 'None needed' : 'None attempted'));
    } else {
      const track = el('div', 'progress-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = el('span');
      fill.style.width = `${100 * completed / paper.questionCount}%`;
      track.append(fill);
      bottom.append(track);
    }
    const link = el('a', 'button', finished ? 'View results' : attempted ? 'Continue paper' : 'Start paper');
    link.href = `#paper/${encodeURIComponent(paper.id)}`;
    link.setAttribute('aria-label', `${link.textContent}: ${paper.title}`);
    bottom.append(link);
    if (attempted) {
      const repeat = el('button','button secondary','Start another attempt');
      repeat.type = 'button';
      repeat.setAttribute('aria-label',`Start another attempt: ${paper.title}. Your previous answers will stay in history.`);
      repeat.addEventListener('click',() => startAnotherAttempt(paper));
      bottom.append(repeat);
    }
    card.append(bottom);
    return card;
  }
  function renderLibrary() {
    updateCounts();
    byId('papers-section').hidden = selectedCategory === null;
    if (selectedCategory === null) return;
    byId('papers-heading').textContent = `Paper ${selectedCategory}`;
    const query = byId('paper-search').value.trim().toLocaleLowerCase();
    const categoryPapers = papers.filter((paper) => paper.paper === selectedCategory);
    const visible = categoryPapers.filter((paper) => `${paper.title} ${paper.source} ${paper.description}`.toLocaleLowerCase().includes(query));
    const grid = byId('paper-grid');
    grid.replaceChildren(...visible.map(renderCard));
    byId('empty-state').hidden = !catalogReady || visible.length !== 0;
    byId('empty-title').textContent = query ? 'No matching papers.' : `No Paper ${selectedCategory} papers yet.`;
    byId('empty-message').textContent = query ? 'Try another title, topic or source.' : 'Your papers will appear here when they are added.';
    byId('result-count').textContent = !catalogReady ? 'Loading papers…' : query ? `${countLabel(visible.length)} found` : '';
  }
  function showLibrary(type) {
    if (editionNotice) editionNotice.hidden = true;
    if (activePaper) {
      clearPlayerFrame();
    }
    selectedCategory = [1, 2].includes(type) ? type : null;
    const guidedLibrary = byId('guided-library');
    if (guidedLibrary && selectedCategory !== null) guidedLibrary.open = true;
    byId('player-view').hidden = true;
    byId('library-view').hidden = false;
    document.title = selectedCategory ? `Paper ${selectedCategory} · TMUA practice` : 'TMUA · Practice library';
    renderLibrary();
    window.TmuaConcepts?.route();
  }
  function updatePlayerProgress(progress, paper = activePaper) {
    const label = progress && progress.finished ? 'Paper complete' : progress && progress.firstAttempted > 0 ? `${progress.completed} of ${progress.total} exercises complete` : 'Ready to begin';
    const number = paper && progress?.firstAttempted > 0 ? storedFor(paper)?.attemptNumber || attemptNumber(paper,`guided:${paper.id}:${progress.attemptId}`) : null;
    byId('player-progress').textContent = `${number ? `Attempt ${number} · ` : ''}${label}`;
    if (!repeatButton) {
      const toolbar = byId('player-view').querySelector?.('.player-toolbar');
      if (toolbar) {
        repeatButton = el('button','button secondary','Start another attempt');
        repeatButton.id = 'start-another-paper-attempt';
        repeatButton.type = 'button';
        repeatButton.title = 'Your current answers and scores will stay in history.';
        repeatButton.addEventListener('click',() => {if(activePaper)startAnotherAttempt(activePaper);});
        toolbar.append(repeatButton);
        toolbar.classList.add('has-attempt-action');
      }
    }
    if (repeatButton) repeatButton.hidden = !progress || progress.firstAttempted === 0;
  }
  function openPaper(paper) {
    if (window.TmuaCloud?.blocked) return;
    const selected = teachingRoute(paper);
    if (!selected) { editionUnavailable(paper); return; }
    if (editionNotice) editionNotice.hidden = true;
    frame.hidden = false;
    selectedCategory = paper.paper;
    byId('library-view').hidden = true;
    byId('player-view').hidden = false;
    byId('player-category').textContent = `Paper ${paper.paper}`;
    byId('player-title').textContent = paper.title;
    byId('back-to-library').href = '#';
    document.title = `${paper.title} · TMUA practice`;
    updatePlayerProgress(storedFor(paper)?.progress,paper);
    const changed = !activePaper || activePaper.id !== paper.id || activePaper.url !== selected.url;
    if (changed) clearPlayerFrame();
    activePaper = {...paper, url:selected.url, teachingEdition:selected.id};
    if (changed) {
      frame.title = `${paper.title} — Paper ${paper.paper}`;
      if (paper.private) {
        frame.setAttribute('sandbox','allow-scripts allow-forms');
        frame.hidden = true;
        byId('player-progress').textContent = 'Loading your paper…';
        const request = playerGeneration;
        window.TmuaPrivate.loadHTML(paper.id,selected.id).then(html => {
          if (request !== playerGeneration || window.TmuaCloud?.blocked || activePaper?.id !== paper.id || activePaper?.teachingEdition !== selected.id) return;
          frame.srcdoc = html; frame.hidden = false; updatePlayerProgress(storedFor(paper)?.progress,paper);
        }).catch(() => {
          if (request !== playerGeneration) return;
          frame.hidden = true; byId('player-progress').textContent = 'Your private paper could not load. Return to Practice and try again.';
          activePaper = null;
        });
      } else {
        frame.setAttribute('sandbox','allow-scripts allow-forms allow-popups');
        frame.src = selected.url;
      }
      byId('player-title').focus({preventScroll: true});
      window.scrollTo(0, 0);
    }
    window.TmuaConcepts?.route();
  }
  function route() {
    const hash = window.location.hash.slice(1);
    const libraryMatch = /^library\/([12])$/.exec(hash);
    if (libraryMatch) return showLibrary(Number(libraryMatch[1]));
    const paperMatch = /^paper\/([a-z0-9_-]+)$/.exec(hash);
    if (paperMatch) {
      if (!catalogReady) return;
      const paper = papers.find((item) => item.id === paperMatch[1]);
      if (paper) return openPaper(paper);
      showLibrary(null);
      byId('catalog-status').textContent = 'That paper is not in the library. Choose another paper below.';
      byId('catalog-status').hidden = false;
      return;
    }
    showLibrary(null);
  }
  function combineCatalog() {
    const seen = new Set(publicPapers.map(paper => paper.id));
    const privatePapers = (window.TmuaPrivate?.catalog() || []).filter(paper => !seen.has(paper.id)).map(paper => ({
      ...paper, editions:paper.editions.map(edition => ({...edition,url:`private:${paper.id}:${edition.id}`}))
    }));
    papers = [...publicPapers,...privatePapers];
  }
  document.addEventListener('tmua-private-catalog',event => {
    combineCatalog();
    const status = byId('private-paper-status');
    if (status) { status.hidden = !event.detail?.error; status.textContent = event.detail?.error || ''; }
    if (activePaper?.private && !papers.some(paper => paper.id === activePaper.id)) clearPlayerFrame();
    if (catalogReady) { renderLibrary(); route(); }
  });
  async function loadCatalog() {
    if (loading) return;
    loading = true;
    byId('load-error').hidden = true;
    byId('catalog-status').hidden = true;
    try {
      const url = new URL('papers/catalog.json', siteBase);
      const response = await fetch(url, {cache: 'no-store'});
      if (!response.ok) throw new Error('catalog unavailable');
      const data = await response.json();
      if (!Array.isArray(data.papers)) throw new Error('invalid catalog');
      const ids = new Set();
      publicPapers = data.papers.map(safePaper).filter((paper) => {
        if (!paper || ids.has(paper.id)) return false;
        ids.add(paper.id); return true;
      });
      combineCatalog();
      catalogReady = true;
      renderLibrary();
      route();
    } catch (_) {
      byId('load-error').hidden = false;
      if (window.location.protocol === 'file:') {
        byId('error-title').textContent = 'Open the website to load your papers.';
        byId('error-message').textContent = 'For a local preview, double-click Start Website.command in the website folder. Online, use your website address.';
      } else {
        byId('error-title').textContent = 'The library could not load.';
        byId('error-message').textContent = 'Please reload the library. Your saved progress is still here.';
      }
      [1, 2].forEach((type) => { byId(`count-${type}`).textContent = 'Library unavailable'; });
    } finally { loading = false; }
  }

  [1, 2].forEach((type) => {
    byId(`choose-${type}`).addEventListener('click', () => {
      byId('paper-search').value = '';
      window.location.hash = `library/${type}`;
      showLibrary(type);
      byId('papers-heading').focus({preventScroll: true});
    });
  });
  byId('paper-search').addEventListener('input', renderLibrary);
  byId('refresh-library').addEventListener('click', () => { loadCatalog(); window.TmuaPrivate?.refresh(); });
  byId('retry-load').addEventListener('click', loadCatalog);
  window.addEventListener('hashchange', route);
  window.addEventListener('focus', () => { if (!activePaper) { loadCatalog(); window.TmuaPrivate?.refresh(); } });
  window.addEventListener('storage', (event) => {
    if ((event.key === historyKey || event.key === null) && historyPersistent) memoryHistory=readHistory();
    if ((event.key === storageKey || event.key === null) && libraryPersistent) { saved = readSaved(); if (!activePaper) renderLibrary(); }
  });
  document.addEventListener('tmua-cloud-applied', event => {
    const payload = event.detail?.payload;
    if (!payload?.library) return;
    saved = payload.library;
    memoryHistory = payload.history.attempts;
    retiredAttempts.clear();
    historyPersistent = event.detail.persistence?.history !== false;
    libraryPersistent = event.detail.persistence?.library !== false;
    // Re-create the frame only after a shared snapshot is deliberately applied.
    // The player validates restored state before accepting it.
    if (activePaper) clearPlayerFrame();
    renderLibrary(); route();
  });
  document.addEventListener('tmua-cloud-lock', clearPlayerFrame);
  document.addEventListener('tmua-cloud-unlock', route);
  window.addEventListener('message', (event) => {
    if (window.TmuaCloud?.blocked) return;
    if (!activePaper || event.source !== frame.contentWindow || !event.data || event.data.paperId !== activePaper.id) return;
    const data = event.data;
    if (teachingRoute(activePaper)?.id !== activePaper.teachingEdition) { editionUnavailable(activePaper); return; }
    if (data.type === 'tmua-view-ready') {
      frame.contentWindow.postMessage({type:'tmua-view-resume',paperId:activePaper.id,view:saved[activePaper.id]?.view || null},'*');
    } else if (data.type === 'tmua-view') {
      if (!['normal','pearson'].includes(data.view?.mode) || !Array.isArray(data.view.flags)) return;
      const flags = data.view.flags.filter(n=>Number.isInteger(n) && n>=0 && n<activePaper.questionCount);
      saved[activePaper.id] = {...saved[activePaper.id],version:activePaper.version,teachingEdition:activePaper.teachingEdition,view:{mode:data.view.mode,flags}};
      try { localStorage.setItem(storageKey,JSON.stringify(saved)); libraryPersistent=true; } catch (_) { libraryPersistent=false; }
      document.dispatchEvent(new CustomEvent('tmua-local-updated',{detail:{kind:'library',value:saved,persisted:libraryPersistent}}));
    } else if (data.type === 'tmua-ready') {
      if (teachingRoute(activePaper)?.id !== activePaper.teachingEdition) { editionUnavailable(activePaper); return; }
      const record = storedFor(activePaper);
      const progress = record && validatedProgress(record.progress, activePaper);
      const state = record?.state ? {...record.state, ...(progress?.finished ? {summaryVisible: true} : {})} : null;
      frame.contentWindow.postMessage({type: 'tmua-resume', paperId: activePaper.id, state}, '*');
    } else if (data.type === 'tmua-progress') {
      const progress = validatedProgress(data.progress, activePaper);
      if (!progress || !data.state || typeof data.state !== 'object') return;
      if (progress.attemptId && data.state.attemptId !== progress.attemptId) return;
      try { if (JSON.stringify(data.state).length > 500000) return; } catch (_) { return; }
      if (saveProgress(activePaper, data.state, progress)) updatePlayerProgress(progress);
    } else if (data.type === 'tmua-exit') {
      window.location.hash = `library/${activePaper.paper}`;
    }
  });
  route();
  loadCatalog();
})();
