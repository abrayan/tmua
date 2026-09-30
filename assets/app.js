(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const siteBase = new URL('.', window.location.href);
  const storageKey = `tmua-practice-library-v1:${siteBase.pathname}`;
  const frame = byId('paper-frame');
  let papers = [];
  let selectedCategory = null;
  let activePaper = null;
  let catalogReady = false;
  let loading = false;
  let libraryPersistent = true;
  let saved = readSaved();
  const historyKey = `tmua-attempt-history-v1:${siteBase.pathname}`;
  let memoryHistory = [];
  let historyPersistent = true;
  function readHistory() {
    if (!historyPersistent) return memoryHistory;
    try { const value = JSON.parse(localStorage.getItem(historyKey) || 'null');
      return value?.version === 1 && Array.isArray(value.attempts) ? value.attempts.filter(e=>e && typeof e.id==='string' && typeof e.paperId==='string' && typeof e.title==='string' && [1,2].includes(e.paper) && Number.isInteger(e.total) && e.total>0 && e.total<=1000 && Number.isInteger(e.firstCorrect) && e.firstCorrect>=0 && e.firstCorrect<=e.total && (e.afterCorrect===null || Number.isInteger(e.afterCorrect) && e.afterCorrect>=e.firstCorrect && e.afterCorrect<=e.total) && typeof e.completedAt==='string' && Number.isFinite(Date.parse(e.completedAt))) : [];
    } catch (_) { return memoryHistory; }
  }
  function recordFinishedAttempt(paper, progress) {
    if (!progress.finished || !progress.attemptId) return;
    const attempts = readHistory();
    const id = `guided:${paper.id}:${progress.attemptId}`;
    const previous = attempts.find(entry => entry.id === id);
    const entry = {id, paperId:paper.id, title:paper.title, paper:paper.paper,
      total:paper.questionCount, firstCorrect:previous?.firstCorrect ?? progress.firstCorrect,
      afterCorrect:progress.afterKnown ? Math.max(previous?.afterCorrect ?? 0, progress.afterCorrect) : previous?.afterCorrect ?? null,
      completedAt:previous?.completedAt || new Date().toISOString(), source:'guided',
      attemptContext:previous?.attemptContext || (attempts.some(item => item.paperId===paper.id) ? 'practised' : 'first')};
    memoryHistory = [...attempts.filter(item => item.id !== id),entry];
    try { localStorage.setItem(historyKey,JSON.stringify({version:1,attempts:memoryHistory})); historyPersistent=true; }
    catch (_) { historyPersistent=false; }
    document.dispatchEvent(new CustomEvent('tmua-history-updated',{detail:{attempts:memoryHistory,persisted:historyPersistent}}));
  }
  document.addEventListener('tmua-history-updated',event=>{if(Array.isArray(event.detail?.attempts)) memoryHistory=event.detail.attempts;if(typeof event.detail?.persisted==='boolean')historyPersistent=event.detail.persisted;});

  function readSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function saveProgress(paper, state, progress) {
    saved[paper.id] = {...saved[paper.id], version: paper.version, state, progress, updatedAt: new Date().toISOString()};
    recordFinishedAttempt(paper,progress);
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
    return {...value, url: url.href};
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
    if (finished) {
      const score = el('div', 'paper-score');
      const first = el('div');
      first.append(el('span', '', 'First attempt · on your own'), el('strong', '', `${progress.firstCorrect}/${paper.questionCount}`));
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
    if (activePaper) {
      frame.removeAttribute('src');
      activePaper = null;
    }
    selectedCategory = [1, 2].includes(type) ? type : null;
    const guidedLibrary = byId('guided-library');
    if (guidedLibrary && selectedCategory !== null) guidedLibrary.open = true;
    byId('player-view').hidden = true;
    byId('library-view').hidden = false;
    document.title = selectedCategory ? `Paper ${selectedCategory} · TMUA practice` : 'TMUA · Practice library';
    renderLibrary();
  }
  function updatePlayerProgress(progress) {
    byId('player-progress').textContent = progress && progress.finished ? 'Paper complete' : progress && progress.firstAttempted > 0 ? `${progress.completed} of ${progress.total} exercises complete` : 'Ready to begin';
  }
  function openPaper(paper) {
    if (window.TmuaCloud?.blocked) return;
    selectedCategory = paper.paper;
    byId('library-view').hidden = true;
    byId('player-view').hidden = false;
    byId('player-category').textContent = `Paper ${paper.paper}`;
    byId('player-title').textContent = paper.title;
    byId('back-to-library').href = '#';
    document.title = `${paper.title} · TMUA practice`;
    updatePlayerProgress(storedFor(paper)?.progress);
    if (!activePaper || activePaper.id !== paper.id || activePaper.url !== paper.url) {
      activePaper = paper;
      frame.title = `${paper.title} — Paper ${paper.paper}`;
      frame.src = paper.url;
      byId('player-title').focus({preventScroll: true});
      window.scrollTo(0, 0);
    }
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
      papers = data.papers.map(safePaper).filter((paper) => {
        if (!paper || ids.has(paper.id)) return false;
        ids.add(paper.id); return true;
      });
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
  byId('refresh-library').addEventListener('click', loadCatalog);
  byId('retry-load').addEventListener('click', loadCatalog);
  window.addEventListener('hashchange', route);
  window.addEventListener('focus', () => { if (!activePaper) loadCatalog(); });
  window.addEventListener('storage', (event) => {
    if ((event.key === historyKey || event.key === null) && historyPersistent) memoryHistory=readHistory();
    if ((event.key === storageKey || event.key === null) && libraryPersistent) { saved = readSaved(); if (!activePaper) renderLibrary(); }
  });
  document.addEventListener('tmua-cloud-applied', event => {
    const payload = event.detail?.payload;
    if (!payload?.library) return;
    saved = payload.library;
    memoryHistory = payload.history.attempts;
    historyPersistent = event.detail.persistence?.history !== false;
    libraryPersistent = event.detail.persistence?.library !== false;
    // Re-create the frame only after a shared snapshot is deliberately applied.
    // The player validates restored state before accepting it.
    if (activePaper) { frame.removeAttribute('src'); activePaper = null; }
    renderLibrary(); route();
  });
  document.addEventListener('tmua-cloud-lock', () => { frame.removeAttribute('src'); activePaper=null; });
  document.addEventListener('tmua-cloud-unlock', route);
  window.addEventListener('message', (event) => {
    if (window.TmuaCloud?.blocked) return;
    if (!activePaper || event.source !== frame.contentWindow || !event.data || event.data.paperId !== activePaper.id) return;
    const data = event.data;
    if (data.type === 'tmua-view-ready') {
      frame.contentWindow.postMessage({type:'tmua-view-resume',paperId:activePaper.id,view:saved[activePaper.id]?.view || null},'*');
    } else if (data.type === 'tmua-view') {
      if (!['normal','pearson'].includes(data.view?.mode) || !Array.isArray(data.view.flags)) return;
      const flags = data.view.flags.filter(n=>Number.isInteger(n) && n>=0 && n<activePaper.questionCount);
      saved[activePaper.id] = {...saved[activePaper.id],version:activePaper.version,view:{mode:data.view.mode,flags}};
      try { localStorage.setItem(storageKey,JSON.stringify(saved)); libraryPersistent=true; } catch (_) { libraryPersistent=false; }
      document.dispatchEvent(new CustomEvent('tmua-local-updated',{detail:{kind:'library',value:saved,persisted:libraryPersistent}}));
    } else if (data.type === 'tmua-ready') {
      const record = storedFor(activePaper);
      const progress = record && validatedProgress(record.progress, activePaper);
      const state = record?.state ? {...record.state, ...(progress?.finished ? {summaryVisible: true} : {})} : null;
      frame.contentWindow.postMessage({type: 'tmua-resume', paperId: activePaper.id, state}, '*');
    } else if (data.type === 'tmua-progress') {
      const progress = validatedProgress(data.progress, activePaper);
      if (!progress || !data.state || typeof data.state !== 'object') return;
      if (progress.attemptId && data.state.attemptId !== progress.attemptId) return;
      try { if (JSON.stringify(data.state).length > 500000) return; } catch (_) { return; }
      saveProgress(activePaper, data.state, progress);
      updatePlayerProgress(progress);
    } else if (data.type === 'tmua-exit') {
      window.location.hash = `library/${activePaper.paper}`;
    }
  });
  route();
  loadCatalog();
})();
