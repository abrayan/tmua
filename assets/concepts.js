(() => {
  'use strict';
  const section = document.getElementById('concepts-section');
  if (!section) return;
  const base = new URL('.', window.location.href);
  const storageKey = `tmua-practice-library-v1:${base.pathname}`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  let library = readLibrary(), map = [], selectedPaper = 1, tabChosen = false, acceptStorage = true;
  function readLibrary() {
    try { const value = JSON.parse(localStorage.getItem(storageKey) || '{}'); return object(value) ? value : {}; }
    catch (_) { return {}; }
  }
  function validateMap(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.papers)) throw Error('Unavailable map');
    const seen = new Set();
    return value.papers.map(paper => {
      if (!object(paper) || !/^[a-z0-9-]{1,80}$/.test(paper.id) || seen.has(paper.id) || ![1,2].includes(paper.paper) || paper.version !== 1 || typeof paper.title !== 'string' || !Array.isArray(paper.areas) || !Array.isArray(paper.questions) || !paper.questions.length || !Array.isArray(paper.contentRevisions)) throw Error('Invalid paper map');
      seen.add(paper.id);
      const ids = new Set();
      paper.areas.forEach(area => {
        if (!object(area) || !/^[a-z0-9-]{1,60}$/.test(area.id) || ids.has(area.id) || typeof area.label !== 'string' || !area.label.trim() || area.label.length > 100) throw Error('Invalid area');
        ids.add(area.id);
      });
      const questions = new Set();
      paper.questions.forEach(question => {
        if (!object(question) || !ids.has(question.area) || typeof question.sourceId !== 'string' || questions.has(question.sourceId)) throw Error('Invalid question');
        questions.add(question.sourceId);
      });
      if (!paper.contentRevisions.every(revision => Number.isInteger(revision) && revision > 0)) throw Error('Invalid revisions');
      return paper;
    });
  }
  function questionResult(record) {
    if (!object(record) || ![0,1].includes(record.first)) return null;
    const kind = record.firstKind === undefined ? 'answer' : record.firstKind;
    if (!['answer','hint'].includes(kind) || (kind === 'hint' && record.first !== 0)) return null;
    const after = record.everSolved === undefined ? (record.first === 1 ? true : null) : record.everSolved;
    if (![true,false,null].includes(after) || (record.first === 1 && after !== true)) return null;
    return {first:record.first,after,hint:kind==='hint'};
  }
  function evidence(number) {
    const areas = new Map(), papers = [];
    map.filter(paper => paper.paper === number).forEach(paper => {
      const saved = library[paper.id], state = saved?.state;
      if (!object(saved) || saved.version !== paper.version || !object(state) || state.version !== 1 || !paper.contentRevisions.includes(state.contentRevision ?? 1) || !Array.isArray(state.records) || state.records.length !== paper.questions.length) return;
      let attempted = 0;
      paper.questions.forEach((question,index) => {
        const result = questionResult(state.records[index]);
        if (!result) return;
        attempted++;
        const area = paper.areas.find(item => item.id === question.area);
        if (!areas.has(area.id)) areas.set(area.id,{id:area.id,label:area.label,total:0,first:0,solved:0,unknown:0,hints:0,questions:[]});
        const row = areas.get(area.id);
        row.total++; row.first += result.first; row.solved += Number(result.after===true); row.unknown += Number(result.after===null); row.hints += Number(result.hint);
        row.questions.push({sourceId:question.sourceId,paperId:paper.id,index:index+1,...result});
      });
      if (attempted) papers.push({paper,attempted,updatedAt:Number.isFinite(Date.parse(saved.updatedAt))?Date.parse(saved.updatedAt):0});
    });
    const order = map.filter(paper=>paper.paper===number).flatMap(paper=>paper.areas.map(area=>area.id));
    return {areas:[...areas.values()].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id)),papers};
  }
  section.classList.add('concepts-section');
  section.setAttribute('aria-labelledby','concepts-heading');
  section.innerHTML = '<div class="concepts-heading"><h2 id="concepts-heading">Concepts</h2><p>Your answers, by topic.</p></div>' +
    '<div class="concepts-tabs" role="tablist" aria-label="Concept progress by paper">' + [1,2].map(paper=>`<button type="button" role="tab" id="concepts-tab-${paper}" aria-controls="concepts-panel-${paper}" data-concepts-paper="${paper}">Paper ${paper}</button>`).join('') + '</div>' +
    [1,2].map(paper=>`<div id="concepts-panel-${paper}" role="tabpanel" aria-labelledby="concepts-tab-${paper}" tabindex="0"><p class="concepts-empty">Loading your concept progress…</p></div>`).join('');
  function activate(paper,focus=false) {
    selectedPaper=paper;
    [1,2].forEach(number=>{
      const tab=document.getElementById(`concepts-tab-${number}`);
      tab.setAttribute('aria-selected',String(number===paper));tab.tabIndex=number===paper?0:-1;
      document.getElementById(`concepts-panel-${number}`).hidden=number!==paper;
    });
    if(focus)document.getElementById(`concepts-tab-${paper}`).focus();
  }
  function bar(row,after) {
    const solved=after?row.solved:row.first, unknown=after?row.unknown:0;
    const label=after?'After practice':'On your own';
    const text=unknown?`${solved} solved · ${unknown} not recorded`:`${solved} / ${row.total}`;
    const description=unknown?`${label}: ${solved} solved out of ${row.total} attempted; ${unknown} ${unknown===1?'result':'results'} not recorded.`:`${label}: ${solved} solved out of ${row.total} attempted.`;
    return `<div class="concepts-bar-row"><div class="concepts-bar-label"><span>${label}</span><strong>${text}</strong></div><div class="concepts-track${after?' concepts-after':''}" role="img" aria-label="${escape(description)}"><span class="concepts-fill" style="width:${100*solved/row.total}%"></span>${unknown?`<span class="concepts-unknown" style="left:${100*solved/row.total}%;width:${100*unknown/row.total}%"></span>`:''}</div></div>`;
  }
  function card(row,paper) {
    const gain=row.solved-row.first;
    const status=row.total<3?{kind:'building',label:'Building evidence'}:row.first/row.total>=0.8?{kind:'strong',label:'Strong so far'}:{kind:'practice',label:'Needs practice'};
    const caption=gain>0?`${gain} more solved after practice`:`Solved independently: ${row.first} / ${row.total}`;
    const needs=row.questions.find(question=>question.first===0&&question.after!==true);
    const detail=row.questions.map(question=>`<li><span>${escape(question.sourceId.replace(/^(\d{4})-P([12])-Q0?/, '$1 · P$2 · Q'))}</span><span>${question.hint?'Used a hint':question.first?'Correct on your own':'First answer incorrect'}${question.after===true&&question.first===0?' · Solved on retry':question.after===null?' · Retry not recorded':''}</span></li>`).join('');
    return `<article class="concepts-card" data-concept="${escape(row.id)}"><div class="concepts-card-heading"><h3>${escape(row.label)}</h3></div><div class="concepts-card-meta"><span class="concepts-status concepts-status-${status.kind}">${status.label}</span><span>${row.total} question${row.total===1?'':'s'}</span></div>${bar(row,false)}${bar(row,true)}<p class="concepts-outcome${gain>0?' has-gain':''}">${caption}${row.hints?`<span>${row.hints} started with a hint</span>`:''}</p><details><summary>Question details</summary><ul>${detail}</ul>${needs?`<a href="#paper/${encodeURIComponent(needs.paperId)}">Continue Paper ${paper}</a>`:''}</details></article>`;
  }
  function render() {
    const rows={1:evidence(1),2:evidence(2)};
    if(!tabChosen) {
      const latest=[...rows[1].papers,...rows[2].papers].sort((a,b)=>b.updatedAt-a.updatedAt)[0];
      selectedPaper=latest?.paper.paper||1;
    }
    [1,2].forEach(paper=>{
      const panel=document.getElementById(`concepts-panel-${paper}`),data=rows[paper];
      if(!data.areas.length) {
        panel.innerHTML='<div class="concepts-empty"><h3>Concept progress appears as you answer guided questions.</h3><p>Start a paper to build your picture by topic.</p></div>';
        return;
      }
      const attempts=data.papers.map(item=>`${escape(item.paper.title)} · ${item.attempted} / ${item.paper.questions.length} attempted`).join('<br>');
      panel.innerHTML=`<p class="concepts-context"><strong>Current guided attempts</strong><br>${attempts}</p><div class="concepts-cards">${data.areas.map(row=>card(row,paper)).join('')}</div><details class="concepts-guide"><summary>How progress is measured</summary><p><strong>Strong so far:</strong> at least 3 different original questions, with at least 80% correct before help. Below 80% is <strong>Needs practice</strong>; fewer than 3 is <strong>Building evidence</strong>.</p><p>Both bars use the same attempted questions. After practice keeps correct first answers and adds originals solved on a retry. Status uses independent answers from your current guided attempts.</p><p>Keep checking with fresh questions to confirm that the knowledge sticks.</p></details>`;
    });
    activate(selectedPaper);
  }
  section.addEventListener('click',event=>{const tab=event.target.closest('[data-concepts-paper]');if(tab){tabChosen=true;activate(Number(tab.dataset.conceptsPaper));}});
  section.addEventListener('keydown',event=>{
    const tab=event.target.closest('[data-concepts-paper]');
    if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();tabChosen=true;activate(event.key==='Home'?1:event.key==='End'?2:selectedPaper===1?2:1,true);
  });
  document.addEventListener('tmua-local-updated',event=>{if(event.detail?.kind==='library'&&object(event.detail.value)){library=event.detail.value;render();}});
  document.addEventListener('tmua-cloud-applied',event=>{if(object(event.detail?.payload?.library)){library=event.detail.payload.library;acceptStorage=event.detail.persistence?.library!==false;render();}});
  window.addEventListener('storage',event=>{if(acceptStorage&&(event.key===storageKey||event.key===null)){library=readLibrary();render();}});
  activate(selectedPaper);
  fetch(new URL('assets/concept-map.json',base),{cache:'no-cache'}).then(response=>{if(!response.ok)throw Error('Cannot load concepts');return response.json();}).then(value=>{map=validateMap(value);render();}).catch(()=>{
    [1,2].forEach(paper=>{document.getElementById(`concepts-panel-${paper}`).innerHTML='<div class="concepts-empty"><h3>Your concept progress could not be loaded.</h3><p>Refresh the page to try again. Your saved answers are unchanged.</p></div>';});
  });
})();
