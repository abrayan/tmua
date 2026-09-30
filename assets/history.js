(() => {
  'use strict';
  const section = document.getElementById('history-section');
  if (!section) return;
  const storageKey = `tmua-attempt-history-v1:${new URL('.', window.location.href).pathname}`;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const percentage = (correct, total) => Math.round(correct / total * 1000) / 10;
  const dateLabel = value => new Date(value).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  const score = (correct, total) => correct === null ? 'Not recorded' : `${correct} / ${total} (${percentage(correct, total)}%)`;
  const contextLabel = attempt => attempt.attemptContext === 'practised' ? 'Practised before' : 'First sitting';
  function validAttempts(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.filter(attempt => {
      if (!attempt || typeof attempt !== 'object' || typeof attempt.id !== 'string' || !attempt.id || seen.has(attempt.id)) return false;
      if (typeof attempt.paperId !== 'string' || typeof attempt.title !== 'string' || !attempt.title.trim() || ![1,2].includes(attempt.paper)) return false;
      if (!Number.isInteger(attempt.total) || attempt.total < 1 || attempt.total > 1000) return false;
      if (!Number.isInteger(attempt.firstCorrect) || attempt.firstCorrect < 0 || attempt.firstCorrect > attempt.total) return false;
      if (attempt.afterCorrect !== null && (!Number.isInteger(attempt.afterCorrect) || attempt.afterCorrect < attempt.firstCorrect || attempt.afterCorrect > attempt.total)) return false;
      if (typeof attempt.completedAt !== 'string' || !Number.isFinite(Date.parse(attempt.completedAt))) return false;
      if (!['guided','manual'].includes(attempt.source) || !['first','practised'].includes(attempt.attemptContext)) return false;
      seen.add(attempt.id);
      return true;
    }).map(attempt => ({...attempt})).sort((a,b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  }
  let persisted = true;
  function read() {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey));
      return data?.version === 1 ? validAttempts(data.attempts) : [];
    } catch (_) { persisted=false;return []; }
  }
  let attempts = read();
  let selectedPaper = attempts.some(attempt => attempt.paper === 1) || !attempts.length ? 1 : 2;
  let tabChosen = false;
  section.classList.add('history-section');
  section.setAttribute('aria-labelledby','history-heading');
  section.innerHTML = '<div class="history-heading"><div><p class="eyebrow">Your progress</p><h2 id="history-heading">See how your scores change</h2><p>Compare your first answers with your score after learning.</p></div></div>' +
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
      [['firstCorrect','First attempt','first'],['afterCorrect','After learning','after']].forEach(([key,label,kind]) => {
        if (attempt[key] === null) return;
        const detail = `${attempt.title} · Paper ${paper} · ${dateLabel(attempt.completedAt)} · ${label}: ${score(attempt[key],attempt.total)} · ${contextLabel(attempt)}`;
        const cx=x(index), cy=y(percentage(attempt[key],attempt.total));
        const attributes = `class="history-point history-${kind}" tabindex="0" role="img" aria-label="${escape(detail)}" data-history-detail="${escape(detail)}" data-history-tooltip="history-tooltip-${paper}"`;
        lines += kind === 'first' ? `<circle ${attributes} cx="${cx}" cy="${cy}" r="5"><title>${escape(detail)}</title></circle>` : `<polygon ${attributes} points="${cx},${cy-8} ${cx+8},${cy} ${cx},${cy+8} ${cx-8},${cy}"><title>${escape(detail)}</title></polygon>`;
      });
    });
    return `<div class="history-chart-card"><div class="history-chart-header"><h3>Paper ${paper} scores</h3><div class="history-legend"><span><i class="history-key-first" aria-hidden="true"></i>First attempt</span><span><i class="history-key-after" aria-hidden="true"></i>After learning</span></div></div><svg class="history-chart" viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="history-chart-title-${paper} history-chart-description-${paper}"><title id="history-chart-title-${paper}">Paper ${paper}: percentage correct by completed attempt</title><desc id="history-chart-description-${paper}">The vertical scale is zero to one hundred percent correct. Blue circles show first attempts; coral diamonds show scores after learning. ${rows.length===1?'One completed attempt is shown.':`The latest ${rows.length} completed attempts are shown, oldest to newest.`} Missing after-learning scores have no point. All scores and dates are in the history table below.</desc>${lines}</svg><p class="history-axis-caption">Completed attempts · oldest to newest</p><p class="history-point-detail" id="history-tooltip-${paper}" aria-live="polite">Choose a point to see its score.</p><p class="history-chart-note">Correct answers ÷ questions in that paper. These are percentages, not TMUA scaled scores. Papers differ in difficulty; each sitting is shown separately.</p></div>`;
  }
  function renderPanel(paper) {
    const rows = attempts.filter(attempt => attempt.paper === paper);
    const panel = document.getElementById(`history-panel-${paper}`);
    document.getElementById(`history-tab-${paper}`).textContent = `Paper ${paper}${rows.length ? ` · ${rows.length}` : ''}`;
    if (!rows.length) {
      panel.innerHTML = '<div class="history-empty"><span aria-hidden="true">↗</span><h3>Your graph will appear after you complete a paper.</h3><p>Finish a guided paper or record your scores in the roadmap below.</p></div>';
      return;
    }
    const latest = rows.at(-1);
    const card = (key,label,kind) => `<div class="history-score-card history-score-${kind}"><span>${label}</span><strong>${latest[key]===null?'Not recorded':`${percentage(latest[key],latest.total)}<small>%</small>`}</strong><p>${latest[key]===null?'':`${latest[key]} correct out of ${latest.total}`}</p></div>`;
    panel.innerHTML = `<p class="history-latest">Latest · <strong>${escape(latest.title)}</strong> · <time datetime="${escape(latest.completedAt)}">${dateLabel(latest.completedAt)}</time><span class="history-context${latest.attemptContext==='practised'?' is-practised':''}">${contextLabel(latest)}</span></p><div class="history-score-cards">${card('firstCorrect','First attempt','first')}${card('afterCorrect','After learning','after')}</div>` + chart(rows.slice(-12),paper,rows.length) +
      `<details class="history-records"><summary>All Paper ${paper} attempts <span>${rows.length}</span></summary><div class="history-table-scroll" tabindex="0" role="region" aria-label="Paper ${paper} score history"><table class="history-table"><caption>All completed Paper ${paper} attempts, newest first. Scores show correct answers out of the paper’s total.</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Paper</th><th scope="col">Date</th><th scope="col">First attempt</th><th scope="col">After learning</th><th scope="col">Context</th><th scope="col">Recorded from</th></tr></thead><tbody>${rows.slice().reverse().map((attempt,index) => `<tr><th scope="row">${rows.length-index}</th><td>${escape(attempt.title)}</td><td><time datetime="${escape(attempt.completedAt)}">${dateLabel(attempt.completedAt)}</time></td><td>${score(attempt.firstCorrect,attempt.total)}</td><td>${score(attempt.afterCorrect,attempt.total)}</td><td><span class="history-context${attempt.attemptContext==='practised'?' is-practised':''}">${contextLabel(attempt)}</span></td><td>${attempt.source==='guided'?'Guided practice':'Manual record'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  function render() {
    if(!tabChosen && !attempts.some(attempt=>attempt.paper===selectedPaper) && attempts.length)selectedPaper=attempts[0].paper;
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
  document.addEventListener('tmua-history-updated',event => {persisted=event.detail?.persisted!==false;attempts=Array.isArray(event.detail?.attempts)?validAttempts(event.detail.attempts):read();render();});
  window.addEventListener('storage',event => {if(event.key===storageKey || event.key===null){persisted=true;attempts=read();render();}});
  let resize;
  window.addEventListener('resize',() => {clearTimeout(resize);resize=setTimeout(render,120);});
  render();
})();
