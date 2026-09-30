(() => {
  'use strict';
  const section = document.getElementById('history-section');
  if (!section) return;
  const siteBase = new URL('.', window.location.href);
  const storageKey = `tmua-attempt-history-v1:${siteBase.pathname}`;
  const libraryKey = `tmua-practice-library-v1:${siteBase.pathname}`;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const percentage = (correct, total) => Math.round(correct / total * 1000) / 10;
  const dateLabel = value => new Date(value).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  const score = (correct, total) => correct === null ? 'Not recorded' : `${correct} / ${total} (${percentage(correct, total)}%)`;
  const contextLabel = attempt => attempt.attemptContext === 'practised' ? 'Practised before' : 'First sitting';
  const attemptDate = attempt => attempt.completedAt || attempt.updatedAt || attempt.startedAt;
  const completed = attempt => attempt.finished !== false && typeof attempt.completedAt === 'string';
  function validAttempts(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const numbers = new Map();
    return value.filter(attempt => {
      if (!attempt || typeof attempt !== 'object' || typeof attempt.id !== 'string' || !attempt.id || seen.has(attempt.id)) return false;
      if (typeof attempt.paperId !== 'string' || typeof attempt.title !== 'string' || !attempt.title.trim() || ![1,2].includes(attempt.paper)) return false;
      if (!Number.isInteger(attempt.total) || attempt.total < 1 || attempt.total > 1000) return false;
      if (!Number.isInteger(attempt.firstCorrect) || attempt.firstCorrect < 0 || attempt.firstCorrect > attempt.total) return false;
      if (attempt.afterCorrect !== null && (!Number.isInteger(attempt.afterCorrect) || attempt.afterCorrect < attempt.firstCorrect || attempt.afterCorrect > attempt.total)) return false;
      if (typeof attemptDate(attempt) !== 'string' || !Number.isFinite(Date.parse(attemptDate(attempt)))) return false;
      if (!completed(attempt) && (attempt.finished !== false || !Number.isInteger(attempt.firstAttempted) || attempt.firstAttempted < attempt.firstCorrect || attempt.firstAttempted > attempt.total)) return false;
      if (!['guided','manual'].includes(attempt.source) || !['first','practised'].includes(attempt.attemptContext)) return false;
      seen.add(attempt.id);
      return true;
    }).map(attempt => ({...attempt})).sort((a,b) => Date.parse(attemptDate(a)) - Date.parse(attemptDate(b))).map(attempt => {
      const next = (numbers.get(attempt.paperId) || 0) + 1;
      const number = Number.isInteger(attempt.attemptNumber) && attempt.attemptNumber > 0 ? attempt.attemptNumber : next;
      numbers.set(attempt.paperId,Math.max(number,next));
      return {...attempt,attemptNumber:number};
    });
  }
  let persisted = true;
  let libraryPersisted = true;
  function read() {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey));
      return data?.version === 1 ? validAttempts(data.attempts) : [];
    } catch (_) { persisted=false;return []; }
  }
  function validLibrary(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function readLibrary() {
    try { return validLibrary(JSON.parse(localStorage.getItem(libraryKey) || '{}')); }
    catch (_) { return {}; }
  }
  let library = readLibrary();
  let catalog = [];
  function liveAttempts() {
    return catalog.flatMap(paper => {
      const saved = Object.hasOwn(library, paper.id) ? library[paper.id] : null;
      const progress = saved?.progress;
      if (!saved || saved.version !== paper.version || !progress || typeof progress !== 'object'
        || progress.finished !== false || progress.total !== paper.questionCount) return [];
      const counts = ['questionIndex', 'completed', 'firstCorrect', 'firstAttempted', 'practiceCorrect', 'practiceAttempted'];
      if (counts.some(key => !Number.isInteger(progress[key]) || progress[key] < 0
        || progress[key] > paper.questionCount * (key.startsWith('practice') ? 3 : 1))) return [];
      if (!progress.firstAttempted || progress.questionIndex >= paper.questionCount
        || progress.completed > progress.firstAttempted || progress.firstCorrect > progress.firstAttempted
        || progress.practiceCorrect > progress.practiceAttempted) return [];
      if (progress.afterKnown !== undefined && typeof progress.afterKnown !== 'boolean') return [];
      if (progress.afterKnown === true && (!Number.isInteger(progress.afterCorrect)
        || progress.afterCorrect < progress.firstCorrect || progress.afterCorrect > progress.firstAttempted)) return [];
      if (progress.afterKnown === false && progress.afterCorrect !== null) return [];
      if (typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) return [];
      const history = attempts.filter(attempt => attempt.paperId === paper.id);
      const number = saved.attemptNumber || history.find(attempt => attempt.id === `guided:${paper.id}:${progress.attemptId}`)?.attemptNumber || history.reduce((max,attempt) => Math.max(max,attempt.attemptNumber),0) + 1;
      return [{paper, progress, attemptNumber:number, updatedAt: saved.updatedAt}];
    }).sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  function liveCard(paper) {
    const live = liveAttempts().find(item => item.paper.paper === paper);
    if (!live) return '';
    const {paper: current, progress, attemptNumber} = live;
    const after = progress.afterKnown === true ? `${progress.afterCorrect} / ${progress.firstAttempted}` : 'Not recorded';
    return `<article class="history-live" id="history-live-${paper}" aria-labelledby="history-live-heading-${paper}"><div class="history-live-heading"><p class="eyebrow">Current attempt · Attempt ${attemptNumber}</p><h3 id="history-live-heading-${paper}">${escape(current.title)}</h3><a class="history-live-resume" href="#paper/${encodeURIComponent(current.id)}">Continue paper →</a></div><div class="history-live-scores"><div><span>First answers so far</span><strong>${progress.firstCorrect} / ${progress.firstAttempted}</strong></div><div><span>After practice so far</span><strong>${after}</strong></div></div><p>${progress.firstAttempted} answered so far</p><div class="history-live-progress"><label for="history-live-progress-${paper}">${progress.completed} of ${current.questionCount} exercises completed</label><progress id="history-live-progress-${paper}" value="${progress.completed}" max="${current.questionCount}">${progress.completed} / ${current.questionCount}</progress></div></article>`;
  }
  async function loadCatalog() {
    try {
      const response = await fetch(new URL('papers/catalog.json', siteBase), {cache:'no-store'});
      if (!response.ok) return;
      const data = await response.json();
      const seen = new Set();
      catalog = (Array.isArray(data?.papers) ? data.papers : []).filter(paper => {
        if (!paper || paper.format !== 'tmua-paper-v1' || paper.version !== 1
          || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(paper.id || '') || seen.has(paper.id)
          || ![1,2].includes(paper.paper) || paper.questionCount !== 20
          || typeof paper.title !== 'string' || !paper.title.trim() || paper.title.length > 200) return false;
        seen.add(paper.id);
        return true;
      });
      render();
    } catch (_) { /* Completed history remains available if the catalogue cannot load. */ }
  }
  let attempts = read();
  let selectedPaper = attempts.some(attempt => attempt.paper === 1) || !attempts.length ? 1 : 2;
  let tabChosen = false;
  section.classList.add('history-section');
  section.setAttribute('aria-labelledby','history-heading');
  section.innerHTML = '<div class="history-heading"><div><p class="eyebrow">Your progress</p><h2 id="history-heading">Your scores</h2><p>First answers and progress after practice.</p></div></div>' +
    '<div class="history-tabs" role="tablist" aria-label="Score history by paper">' + [1,2].map(paper => `<button type="button" role="tab" id="history-tab-${paper}" aria-controls="history-panel-${paper}" data-history-paper="${paper}">Paper ${paper}</button>`).join('') + '</div>' +
    [1,2].map(paper => `<div id="history-panel-${paper}" role="tabpanel" aria-labelledby="history-tab-${paper}" tabindex="0"></div>`).join('') + '<p id="history-storage-note" class="history-storage-note"></p>';
  function activate(paper, moveFocus = false) {
    selectedPaper = paper;
    [1,2].forEach(number => {
      const tab = document.getElementById(`history-tab-${number}`);
      tab.setAttribute('aria-selected', String(number === paper));
      tab.tabIndex = number === paper ? 0 : -1;
      document.getElementById(`history-panel-${number}`).hidden = number !== paper;
    });
    if (moveFocus) document.getElementById(`history-tab-${paper}`).focus();
  }
  function chart(rows, paper, totalCount) {
    const width = Math.max(280, Math.min(1000, (section.clientWidth || 800) - 44));
    const height = 284, left = 48, right = width - 20, top = 24, bottom = 231;
    const x = index => rows.length === 1 ? (left + right) / 2 : left + index * (right - left) / (rows.length - 1);
    const y = value => bottom - value * (bottom - top) / 100;
    let lines = '';
    [0,25,50,75,100].forEach(value => {
      lines += `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" class="history-gridline"/><text x="${left-10}" y="${y(value)+4}" text-anchor="end" class="history-axis-label">${value}%</text>`;
    });
    const pathFor = key => {
      let path = '', open = false;
      rows.forEach((attempt,index) => {
        if (attempt[key] === null) {open=false;return;}
        path += `${open?' L':' M'}${x(index)},${y(percentage(attempt[key],attempt.total))}`;
        open=true;
      });
      return path;
    };
    lines += `<path class="history-line history-first" d="${pathFor('firstCorrect')}"/><path class="history-line history-after" d="${pathFor('afterCorrect')}"/>`;
    rows.forEach((attempt,index) => {
      const ordinal = totalCount - rows.length + index + 1;
      lines += `<text x="${x(index)}" y="${bottom+24}" text-anchor="middle" class="history-axis-label">${ordinal}</text>`;
      [['firstCorrect','On your own','first'],['afterCorrect','After practice','after']].forEach(([key,label,kind]) => {
        if (attempt[key] === null) return;
        const detail = `${attempt.title} · Attempt ${attempt.attemptNumber} · Paper ${paper} · ${dateLabel(attempt.completedAt)} · ${label}: ${score(attempt[key],attempt.total)} · ${contextLabel(attempt)}`;
        const cx=x(index), cy=y(percentage(attempt[key],attempt.total));
        const attributes = `class="history-point history-${kind}" tabindex="0" role="img" aria-label="${escape(detail)}" data-history-detail="${escape(detail)}" data-history-tooltip="history-tooltip-${paper}"`;
        lines += kind === 'first' ? `<circle ${attributes} cx="${cx}" cy="${cy}" r="5"><title>${escape(detail)}</title></circle>` : `<polygon ${attributes} points="${cx},${cy-8} ${cx+8},${cy} ${cx},${cy+8} ${cx-8},${cy}"><title>${escape(detail)}</title></polygon>`;
      });
    });
    return `<div class="history-chart-card"><div class="history-chart-header"><h3>Paper ${paper} scores</h3><div class="history-legend"><span><i class="history-key-first" aria-hidden="true"></i>On your own</span><span><i class="history-key-after" aria-hidden="true"></i>After practice</span></div></div><svg class="history-chart" viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="history-chart-title-${paper} history-chart-description-${paper}"><title id="history-chart-title-${paper}">Paper ${paper}: percentage correct by completed attempt</title><desc id="history-chart-description-${paper}">The vertical scale is zero to one hundred percent correct. Blue circles show first answers without help; coral diamonds show scores after practice. ${rows.length===1?'One completed attempt is shown.':`The latest ${rows.length} completed attempts are shown, oldest to newest.`} Missing after-practice scores have no point. All scores and dates are in the history table below.</desc>${lines}</svg><p class="history-axis-caption">Completed attempts · oldest to newest</p><p class="history-point-detail" id="history-tooltip-${paper}" aria-live="polite">Choose a point to see its score.</p><p class="history-chart-note">Correct answers ÷ questions in that paper. These are percentages, not TMUA scaled scores. Papers differ in difficulty; each sitting is shown separately.</p></div>`;
  }
  function answerDetails(attempt) {
    if (attempt.source === 'manual') return '<span class="history-answer-note">Score record only</span>';
    const records = Array.isArray(attempt.state?.records) ? attempt.state.records : [];
    const log = Array.isArray(attempt.answerLog) ? attempt.answerLog : [];
    if (!records.length && !log.length) return '<span class="history-answer-note">Answers not recorded</span>';
    const answer = value => typeof value === 'string' && /^[A-J]$/.test(value) ? value : 'Not recorded';
    const outcome = value => value === 1 ? 'Correct' : value === 0 ? 'Incorrect' : 'Not answered';
    return `<details class="history-answers"><summary>Answers and details</summary><p>First answers stay fixed. Latest answers include later practice. Earlier answer letters may not have been recorded.</p><ol>${Array.from({length:attempt.total},(_,index) => {
      const saved = log.find(entry => entry?.questionIndex === index);
      const record = records[index] || {};
      const kind = saved?.firstKind ?? record.firstKind;
      const first = saved?.firstCorrect ?? record.first;
      const after = saved?.afterCorrect ?? record.everSolved;
      const assistance = saved?.assisted === true || kind === 'hint';
      return `<li><strong>Question ${index + 1}</strong><span>First answer: ${kind === 'hint' ? 'Hint before answering' : answer(saved?.firstAnswer)} · ${kind === 'hint' ? '0 on your own' : outcome(first)}</span><span>Latest answer: ${answer(saved?.latestAnswer)}</span><span>After practice: ${after === true ? 'Correct' : after === false && first !== null && first !== undefined ? 'Not yet correct' : 'Not recorded'}${assistance ? ' · Help or retry used' : ''}</span></li>`;
    }).join('')}</ol></details>`;
  }
  function historyTable(rows,paper) {
    if (!rows.length) return '';
    return `<details class="history-records"><summary>All Paper ${paper} attempts <span>${rows.length}</span></summary><div class="history-table-scroll" tabindex="0" role="region" aria-label="Paper ${paper} score history"><table class="history-table"><caption>All ${rows.every(completed) ? 'completed ' : ''}Paper ${paper} attempts, newest first. Attempt numbers belong to each individual paper.</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Paper</th><th scope="col">Date</th><th scope="col">On your own</th><th scope="col">After practice</th><th scope="col">Context</th><th scope="col">Recorded from</th><th scope="col">Answers</th></tr></thead><tbody>${rows.slice().reverse().map(attempt => `<tr><th scope="row">${attempt.attemptNumber}</th><td>${escape(attempt.title)}${completed(attempt) ? '' : '<span class="history-answer-note">Saved unfinished attempt</span>'}</td><td><time datetime="${escape(attemptDate(attempt))}">${dateLabel(attemptDate(attempt))}</time></td><td>${completed(attempt) ? score(attempt.firstCorrect,attempt.total) : `${attempt.firstCorrect} / ${attempt.firstAttempted} answered`}</td><td>${completed(attempt) ? score(attempt.afterCorrect,attempt.total) : attempt.afterCorrect === null ? 'Not recorded' : `${attempt.afterCorrect} / ${attempt.firstAttempted} answered`}</td><td><span class="history-context${attempt.attemptContext==='practised'?' is-practised':''}">${contextLabel(attempt)}</span></td><td>${attempt.source==='guided'?'Guided practice':'Manual record'}</td><td>${answerDetails(attempt)}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  function renderPanel(paper) {
    const allRows = attempts.filter(attempt => attempt.paper === paper);
    const rows = allRows.filter(completed);
    const panel = document.getElementById(`history-panel-${paper}`);
    document.getElementById(`history-tab-${paper}`).textContent = `Paper ${paper}${rows.length ? ` · ${rows.length}` : ''}`;
    const live = liveCard(paper);
    if (!rows.length) {
      panel.innerHTML = live + '<div class="history-empty"><span aria-hidden="true">↗</span><h3>Your graph will appear after you complete a paper.</h3><p>Finish a guided paper or record your scores in the paper checklist.</p></div>' + historyTable(allRows,paper);
      return;
    }
    const latest = rows.at(-1);
    const card = (key,label,kind) => `<div class="history-score-card history-score-${kind}"><span>${label}</span><strong>${latest[key]===null?'Not recorded':`${percentage(latest[key],latest.total)}<small>%</small>`}</strong><p>${latest[key]===null?'':`${latest[key]} correct out of ${latest.total}`}</p></div>`;
    panel.innerHTML = live + `<p class="history-latest">Latest · <strong>${escape(latest.title)}</strong> · Attempt ${latest.attemptNumber} · <time datetime="${escape(latest.completedAt)}">${dateLabel(latest.completedAt)}</time><span class="history-context${latest.attemptContext==='practised'?' is-practised':''}">${contextLabel(latest)}</span></p><div class="history-score-cards">${card('firstCorrect','On your own','first')}${card('afterCorrect','After practice','after')}</div>` + chart(rows.slice(-12),paper,rows.length) + historyTable(allRows,paper);
  }
  function render() {
    if (!tabChosen) {
      const current = liveAttempts()[0];
      if (current) selectedPaper = current.paper.paper;
      else if (!attempts.some(attempt => attempt.paper === selectedPaper) && attempts.length) selectedPaper = attempts[0].paper;
    }
    const expanded = [1,2].map(paper => document.getElementById(`history-panel-${paper}`).querySelector('details')?.open || false);
    [1,2].forEach(paper => {renderPanel(paper); const details=document.getElementById(`history-panel-${paper}`).querySelector('details'); if(details)details.open=expanded[paper-1];});
    activate(selectedPaper);
    document.getElementById('history-storage-note').textContent = persisted ? 'Score history is saved in this browser.' : 'History is available for this visit.';
  }
  section.addEventListener('click',event => {
    const tab=event.target.closest('[data-history-paper]');
    if(tab) {tabChosen=true;activate(Number(tab.dataset.historyPaper));}
    const point=event.target.closest('[data-history-detail]');
    if(point) document.getElementById(point.dataset.historyTooltip).textContent=point.dataset.historyDetail;
  });
  section.addEventListener('keydown',event => {
    const tab=event.target.closest('[data-history-paper]');
    if(!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    tabChosen=true;
    activate(event.key==='Home'?1:event.key==='End'?2:selectedPaper===1?2:1,true);
  });
  ['focusin','pointerover'].forEach(type => section.addEventListener(type,event => {
    const point=event.target.closest('[data-history-detail]');
    if(point)document.getElementById(point.dataset.historyTooltip).textContent=point.dataset.historyDetail;
  }));
  document.addEventListener('tmua-history-updated',event => {if(typeof event.detail?.persisted==='boolean')persisted=event.detail.persisted;attempts=Array.isArray(event.detail?.attempts)?validAttempts(event.detail.attempts):persisted?read():attempts;render();});
  document.addEventListener('tmua-local-updated', event => {
    if (event.detail?.kind !== 'library') return;
    library = validLibrary(event.detail.value);
    if (typeof event.detail.persisted === 'boolean') libraryPersisted = event.detail.persisted;
    render();
  });
  document.addEventListener('tmua-cloud-applied', event => {
    if (!event.detail?.payload) return;
    persisted = event.detail.persistence?.history !== false;
    libraryPersisted = event.detail.persistence?.library !== false;
    attempts = validAttempts(event.detail.payload.history?.attempts);
    library = validLibrary(event.detail.payload.library);
    render();
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== libraryKey && event.key !== null) return;
    if ((event.key === storageKey || event.key === null) && persisted) attempts=read();
    if ((event.key === libraryKey || event.key === null) && libraryPersisted) library=readLibrary();
    render();
  });
  let resize;
  window.addEventListener('resize',() => {clearTimeout(resize);resize=setTimeout(render,120);});
  render();
  loadCatalog();
})();
