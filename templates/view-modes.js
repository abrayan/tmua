(() => {
  'use strict';
  const meta = JSON.parse(document.getElementById('tmua-paper-meta').textContent);
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = `tmua-view:${meta.id}`;
  let mode = 'normal', flags = [], snapshot = null, viewChanged = false;
  try { const saved = JSON.parse(localStorage.getItem(key)); if(saved){mode=saved.mode==='pearson'?'pearson':'normal';flags=Array.isArray(saved.flags)?saved.flags.filter(Number.isInteger):[];} } catch (_) {}
  const toolbar = document.createElement('div');
  toolbar.className = 'view-toolbar';
  toolbar.innerHTML = '<span class="pearson-brand">Test of Mathematics for University Admission</span><span class="view-status" id="view-position"></span><span class="view-untimed">Untimed practice</span><label class="view-switch">View <select id="view-mode"><option value="normal">Normal</option><option value="pearson">Pearson</option></select></label>';
  document.body.prepend(toolbar);
  const reviewbar=document.createElement('div');reviewbar.className='pearson-reviewbar';
  reviewbar.innerHTML='<label><input id="flag-question" type="checkbox"> Flag for review</label><button id="palette-review" type="button">Review questions</button>';
  $('question-section').prepend(reviewbar);
  const palette=document.createElement('aside');palette.className='question-palette';palette.setAttribute('aria-label','Question palette');
  palette.innerHTML='<h2>Question palette</h2><div id="palette-buttons"></div><p><span class="palette-green">Green:</span> completed<br><span class="palette-flag">⚑</span> flagged</p><small>Completed questions open for review.</small>';
  document.querySelector('main').append(palette);
  const modal=document.createElement('dialog');modal.className='view-dialog';modal.id='question-review-dialog';
  modal.innerHTML='<div class="dialog-bar"><h2 id="dialog-title">Review</h2><button type="button" id="close-review">Back to practice</button></div><div id="dialog-content"></div>';
  document.body.append(modal);
  let opener=null;
  function save(){if(window.parent!==window){window.parent.postMessage({type:'tmua-view',paperId:meta.id,view:{mode,flags}},'*');}else{try{localStorage.setItem(key,JSON.stringify({mode,flags}));}catch(_){}}}
  function setMode(value,persist=true){mode=value==='pearson'?'pearson':'normal';document.body.dataset.view=mode;$('view-mode').value=mode;if(persist)save();}
  function close(){modal.close();if(opener?.isConnected)opener.focus();}
  function show(title,html,button){if(!modal.open)opener=button||document.activeElement;modal.classList.remove('source-zoom');$('dialog-title').textContent=title;$('dialog-content').innerHTML=html;modal.showModal();$('close-review').focus();}
  $('view-mode').addEventListener('change',e=>{viewChanged=true;setMode(e.target.value);});
  $('close-review').addEventListener('click',close);
  modal.addEventListener('cancel',()=>{if(opener?.isConnected)opener.focus();});
  $('flag-question').addEventListener('change',e=>{if(!snapshot)return;viewChanged=true;const n=snapshot.questionIndex;flags=e.target.checked?[...new Set([...flags,n])]:flags.filter(x=>x!==n);save();renderPalette();});
  function renderPalette(){if(!snapshot)return;const s=snapshot;
    $('view-position').textContent=`${s.questionIndex+1} of ${s.total}`;
    $('flag-question').checked=flags.includes(s.questionIndex);
    $('palette-buttons').innerHTML=s.records.map((r,i)=>`<button type="button" data-review-index="${i}" class="${r.completed?'is-complete ':''}${i===s.questionIndex?'is-current ':''}" ${!r.completed&&i!==s.questionIndex?'disabled':''} aria-label="Question ${i+1}${flags.includes(i)?', flagged':''}${r.completed?', completed':i===s.questionIndex?', current':', not yet reached'}" ${i===s.questionIndex?'aria-current="step"':''}>${i+1}${flags.includes(i)?'<span class="flag-dot" aria-hidden="true">⚑</span>':''}</button>`).join('');
    document.body.classList.toggle('has-source-image',!!document.querySelector('#question-text .source-question'));
  }
  document.addEventListener('click',e=>{const b=e.target.closest('[data-review-index]');if(b){document.dispatchEvent(new CustomEvent('tmua-review-question',{detail:{index:Number(b.dataset.reviewIndex)}}));}});
  $('palette-review').addEventListener('click',e=>{if(!snapshot)return;show('Review questions','<div class="review-question-list">'+snapshot.records.map((r,i)=>`<button type="button" data-review-index="${i}" ${r.completed?'':'disabled'}>Question ${i+1} ${flags.includes(i)?'⚑':''}<span>${r.completed?'Completed':r.first===null?'Not yet attempted':'In progress'}</span></button>`).join('')+'</div>',e.target);});
  document.addEventListener('tmua-render',e=>{snapshot=e.detail;renderPalette();});
  document.addEventListener('tmua-review-content',e=>{const q=e.detail;show(q.source||`Question ${q.index+1}`,`<div class="reviewed-question">${q.questionHTML}</div><div class="reviewed-solution">${q.solutionHTML}</div>${q.sourceHTML||''}`);});
  // Source zoom is presentation only; the saved attempt is never changed.
  function sourceQuestionHTML(image){
    return `<p class="source-zoom-help" id="source-zoom-help">Scroll across and down to read the full question.</p><div class="source-question-scroll" tabindex="0" role="region" aria-label="Enlarged question" aria-describedby="source-zoom-help"><img class="enlarged-question" src="${esc(image.src)}" alt="${esc(image.alt)}"></div>`;
  }
  function showSourceQuestion(image){
    show('Question',sourceQuestionHTML(image),image);
    modal.classList.add('source-zoom');
    modal.querySelector('.source-question-scroll').focus({preventScroll:true});
  }
  document.addEventListener('click',e=>{const image=e.target.closest('.source-question');if(image)showSourceQuestion(image);});
  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.source-question')){e.preventDefault();showSourceQuestion(e.target);}});
  window.addEventListener('message',e=>{if(e.source!==window.parent || e.data?.type!=='tmua-view-resume' || e.data.paperId!==meta.id || viewChanged)return;const v=e.data.view;if(v){flags=Array.isArray(v.flags)?v.flags.filter(n=>Number.isInteger(n)&&n>=0&&n<meta.questionCount):[];setMode(v.mode,false);renderPalette();}});
  setMode(mode,false);
  if(window.parent!==window)window.parent.postMessage({type:'tmua-view-ready',paperId:meta.id},'*');
  document.dispatchEvent(new CustomEvent('tmua-request-render'));
})();
