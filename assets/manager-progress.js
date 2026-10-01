/* A read-only view of the assigned student's cloud snapshot. */
(() => {
  'use strict';
  const mounts = new WeakMap();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const dateLabel = value => validDate(value) ? new Date(value).toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Not recorded';
  const percent = (correct, total) => Math.round(correct / total * 1000) / 10;
  const score = (correct, total) => correct === null ? 'Not recorded' : `${correct} / ${total}`;

  function mount(section, {client} = {}) {
    if (!section || !client || typeof client.rpc !== 'function') throw Error('A progress section and signed-in client are required');
    mounts.get(section)?.destroy();
    const base = new URL('.', window.location.href);
    let destroyed = false, generation = 0, snapshot = null, metadata = null, metadataRequest = null, selectedPaper = 1;
    section.classList.add('manager-progress');
    section.setAttribute('aria-labelledby','manager-progress-heading');
    const heading = () => '<div class="manager-heading"><div><p class="eyebrow">A shared view of learning</p><h2 id="manager-progress-heading" tabindex="-1">Ryan’s progress</h2><p>Completed papers, current answers and concepts to revisit.</p></div><button class="manager-refresh" type="button" data-manager-refresh>Refresh progress</button></div>';
    function message(title, detail, kind = 'empty') {
      if (destroyed) return;
      section.setAttribute('aria-busy', String(kind === 'loading'));
      section.innerHTML = heading() + `<div class="manager-message manager-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><h3>${escape(title)}</h3><p>${escape(detail)}</p>${kind === 'error' ? '<button type="button" data-manager-refresh>Try again</button>' : ''}</div>`;
    }
    async function loadMetadata() {
      if (metadata) return metadata;
      if (!metadataRequest) {
        metadataRequest = Promise.all(['concept-map.json','studied-concepts.json'].map(name => fetch(new URL(`assets/${name}`,base), {cache:'no-cache'}).then(response => {
          if (!response.ok) throw Error('Metadata unavailable');
          return response.json();
        }))).then(([map,catalogue]) => {
          const analytics = window.TmuaProgressAnalytics;
          if (!analytics) throw Error('Progress calculations unavailable');
          const papers = analytics.validateMap(map), lessons = analytics.validateLessons(catalogue);
          analytics.validateMappedLessons(papers,lessons);
          return {papers,lessons};
        }).catch(error => { metadataRequest = null; throw error; });
      }
      return metadataRequest;
    }
    function validateResponse(value) {
      if (!object(value) || !Object.hasOwn(value,'student')) throw Error('Invalid progress response');
      if (value.student === null) {
        if (value.payload !== null || value.revision !== null || value.updated_at !== null) throw Error('Invalid student response');
        return value;
      }
      if (!object(value.student) || typeof value.student.user_id !== 'string' || !value.student.user_id) throw Error('Invalid student');
      if (value.payload === null) {
        if (value.revision !== null || value.updated_at !== null) throw Error('Invalid empty progress');
        return value;
      }
      if (!Number.isInteger(value.revision) || value.revision < 0 || !validDate(value.updated_at)
        || !window.TmuaSync?.validatePayload(value.payload)) throw Error('Invalid saved progress');
      return value;
    }
    function chart(rows, paper) {
      if (!rows.length) return `<div class="manager-chart"><div class="manager-chart-head"><h3>Paper ${paper} score trend</h3></div><p class="manager-caption">A trend will appear after Ryan syncs a completed Paper ${paper} attempt.</p></div>`;
      const shown = rows.slice(-12), width = 620, height = 238, left = 43, right = 600, top = 22, bottom = 198;
      const x = index => shown.length === 1 ? (left + right)/2 : left + index*(right-left)/(shown.length-1);
      const y = value => bottom - value*(bottom-top)/100;
      let marks = [0,25,50,75,100].map(value => `<line class="manager-gridline" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="manager-axis" x="${left-8}" y="${y(value)+4}" text-anchor="end">${value}%</text>`).join('');
      for (const [key,kind,label] of [['firstCorrect','first','First answers'],['afterCorrect','after','After practice']]) {
        let path = '', open = false;
        shown.forEach((row,index) => {
          if (row[key] === null) { open = false; return; }
          path += `${open ? ' L' : ' M'}${x(index)},${y(percent(row[key],row.total))}`; open = true;
        });
        marks += `<path class="manager-line manager-${kind}" d="${path}"/>`;
        shown.forEach((row,index) => {
          if (row[key] === null) return;
          const detail = `${row.title} · Attempt ${row.attemptNumber} · ${dateLabel(row.date)} · ${label}: ${score(row[key],row.total)} (${percent(row[key],row.total)}%)`;
          const cx = x(index), cy = y(percent(row[key],row.total));
          marks += kind === 'first' ? `<circle class="manager-point manager-first" cx="${cx}" cy="${cy}" r="4.5"><title>${escape(detail)}</title></circle>` : `<polygon class="manager-point manager-after" points="${cx},${cy-6} ${cx+6},${cy} ${cx},${cy+6} ${cx-6},${cy}"><title>${escape(detail)}</title></polygon>`;
        });
      }
      shown.forEach((row,index) => { marks += `<text class="manager-axis" x="${x(index)}" y="${bottom+23}" text-anchor="middle">${rows.length-shown.length+index+1}</text>`; });
      return `<div class="manager-chart"><div class="manager-chart-head"><h3>Paper ${paper} score trend</h3><p><span class="manager-legend-first">● First answers</span><span class="manager-legend-after">◆ After practice</span></p></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="manager-chart-title-${paper} manager-chart-desc-${paper}"><title id="manager-chart-title-${paper}">Paper ${paper} completed scores</title><desc id="manager-chart-desc-${paper}">Latest ${shown.length} completed attempts, oldest to newest, on a zero to one hundred percent scale. Blue circles show first answers; peach diamonds show after-practice scores. Missing scores have no point. Exact scores and dates are in the complete attempt list.</desc>${marks}</svg><p class="manager-caption">Completed attempts, oldest to newest · percentages correct, not TMUA scaled scores. Papers differ in difficulty.</p></div>`;
    }
    function attemptList(rows) {
      if (!rows.length) return '<p class="manager-empty-note">No paper attempts have been synced yet.</p>';
      return `<div class="manager-table-scroll" role="region" tabindex="0" aria-label="All paper attempts"><table class="manager-table"><caption>All ${rows.length} recorded attempts, newest first</caption><thead><tr><th scope="col">Paper and sitting</th><th scope="col">Recorded</th><th scope="col">Progress</th><th scope="col">First answers</th><th scope="col">After practice</th><th scope="col">Source</th></tr></thead><tbody>${rows.slice().reverse().map(row => `<tr data-manager-attempt="${escape(row.id)}"><th scope="row">${escape(row.title)}<span>Attempt ${row.attemptNumber} · ${row.attemptContext === 'practised' ? 'Practised before' : 'First sitting'}</span></th><td><time datetime="${escape(row.date)}">${dateLabel(row.date)}</time></td><td>${row.finished ? 'Completed' : `${row.current ? 'In progress' : 'Saved unfinished'} · ${row.firstAttempted} / ${row.total} answered`}</td><td>${score(row.firstCorrect,row.finished ? row.total : row.firstAttempted)}${row.finished ? ` <span>(${percent(row.firstCorrect,row.total)}%)</span>` : ' answered'}</td><td>${score(row.afterCorrect,row.finished ? row.total : row.firstAttempted)}${row.afterCorrect !== null && !row.finished ? ' answered' : ''}</td><td>${row.source === 'manual' ? 'Manually entered result' : 'Guided practice'}</td></tr>`).join('')}</tbody></table></div>`;
    }
    function conceptList(rows) {
      const selected = rows.filter(row => row.paper === selectedPaper), tested = selected.filter(row => row.total);
      const card = row => {
        const label = !row.total ? 'Not yet tested' : row.total < 3 ? 'Building evidence' : row.score >= 80 ? 'Strong so far' : 'Needs practice';
        const reference = row.additional ? `Paper ${row.paper} · Beyond the booklets` : `Booklet ${row.booklet} · Lesson ${row.lesson} · p. ${row.printedPage || row.pdfPage}`;
        return `<article class="manager-concept" data-manager-concept="${escape(row.id)}"${row.score === null ? '' : ` data-score="${row.score}"`}><p class="manager-reference">${reference}</p><div><h4>${escape(row.title)}</h4><strong>${row.score === null ? '—' : `${row.score}%`}</strong></div><p class="manager-concept-meta"><span>${label}</span><span>${row.total} unique question${row.total === 1 ? '' : 's'}</span></p>${row.total ? `<div class="manager-track" role="img" aria-label="${row.score}% weighted practice indicator"><span style="width:${row.score}%"></span></div>` : ''}<details><summary>${row.additional ? 'Learn this concept · example and common mistake' : 'Knowledge and evidence'}</summary>${row.additional ? window.TmuaProgressAnalytics.learningDetails(row) : `<ul>${row.knowledge.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`}${row.questions.length ? `<ul class="manager-evidence">${row.questions.map(question => `<li><strong>${escape(question.sourceId)}</strong> · ${escape(question.knowledgePattern)}<span>${escape(question.label)} · ${question.score} / 100${question.sources.size > 1 ? ' · Reprints counted once' : ''}</span></li>`).join('')}</ul>` : '<p>No question-level evidence yet.</p>'}</details></article>`;
      };
      const cards = selected.filter(row => !row.additional).map(card).join('');
      const extraCards = selected.filter(row => row.additional).map(card).join('');
      return `<section class="manager-concepts" aria-labelledby="manager-concepts-heading"><h3 id="manager-concepts-heading">Concept performance</h3><p class="manager-caption">${selectedPaper === 1 ? 'Paper 1 mathematical knowledge also applies to Paper 2. These concepts support both papers.' : 'Paper 2 focuses on mathematical reasoning, used alongside the mathematical knowledge in the Paper 1 tab.'}</p>${extraCards ? '<button type="button" class="manager-jump" data-manager-extra>Explore additional concepts <span aria-hidden="true">↓</span></button>' : ''}<p class="manager-caption">${tested.length} of ${selected.length} Paper ${selectedPaper} concepts have evidence. Fewer than 3 unique questions is still building evidence.</p><div class="manager-paper-tabs" role="tablist" aria-label="Concepts by paper">${[1,2].map(paper => `<button type="button" id="manager-concepts-tab-${paper}" role="tab" aria-controls="manager-concepts-panel" aria-selected="${selectedPaper === paper}" tabindex="${selectedPaper === paper ? 0 : -1}" data-manager-paper="${paper}">Paper ${paper}</button>`).join('')}</div><details class="manager-scoring"><summary>How the concept percentages work</summary><p>The same weighted practice indicator as Ryan’s Concepts page: 100 points for an independent correct first encounter, 50 with hints before the full solution, 25 after a solution or retry, and 0 when attempted but not solved. A later repeat can add at most 25 points. Each original question counts once; unattempted questions and manually entered totals are excluded. A question may contribute to several concepts. This is not a TMUA grade.</p></details><div id="manager-concepts-panel" role="tabpanel" aria-labelledby="manager-concepts-tab-${selectedPaper}" >${cards ? `<div class="manager-concept-grid">${cards}</div>` : ''}${extraCards ? `<section class="manager-additional" aria-labelledby="manager-extra-heading"><h4 id="manager-extra-heading" tabindex="-1">Beyond the booklets</h4><p class="manager-caption">Short lessons, worked examples and common mistakes, with their syllabus references.</p><div class="manager-concept-grid">${extraCards}</div></section>` : ''}</div></section>`;
    }
    function render() {
      if (destroyed || !snapshot || !metadata) return;
      section.setAttribute('aria-busy','false');
      if (!snapshot.student) { message('No student account is connected yet.', 'Ryan’s progress will appear here once his account is connected.'); return; }
      if (!snapshot.payload) { message('Ryan has not synced any progress yet.', 'Completed papers and saved answers will appear after his first sync.'); return; }
      const {papers,lessons} = metadata, {library,history} = snapshot.payload;
      const rows = window.TmuaProgressAnalytics.attempts({papers,library,history:history.attempts});
      const completed = rows.filter(row => row.finished), completedPapers = new Set(completed.map(row => row.paperId)).size;
      const current = rows.filter(row => row.current).sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
      let concepts;
      try { concepts = window.TmuaProgressAnalytics.evidence({papers,lessons,library,history:history.attempts}); }
      catch (_) { concepts = null; }
      const latest = completed.at(-1);
      const currentCard = current ? `<article class="manager-current"><p class="eyebrow">Current paper · Attempt ${current.attemptNumber}</p><h3>${escape(current.title)}</h3><p class="manager-answered"><strong>${current.firstAttempted} / ${current.total}</strong> questions answered</p><progress value="${current.firstAttempted}" max="${current.total}" aria-label="${current.firstAttempted} of ${current.total} questions answered"></progress><div class="manager-current-scores"><p>First answers so far<strong>${score(current.firstCorrect,current.firstAttempted)}</strong></p><p>After practice so far<strong>${score(current.afterCorrect,current.firstAttempted)}</strong></p></div><p class="manager-caption">Scores above use the ${current.firstAttempted} answered question${current.firstAttempted === 1 ? '' : 's'}. ${current.progress.completed} / ${current.total} exercises completed.</p></article>` : '<article class="manager-current manager-no-current"><h3>No paper currently in progress</h3><p>Ryan’s next saved attempt will appear here.</p></article>';
      section.innerHTML = heading() + `<p class="manager-sync">Last synced by Ryan: <time datetime="${escape(snapshot.updated_at)}">${dateLabel(snapshot.updated_at)}</time></p><div class="manager-overview"><article class="manager-completed"><p>Completed papers</p><strong>${completedPapers}</strong><span>${completed.length} completed sitting${completed.length === 1 ? '' : 's'}${latest ? ` · Latest: ${escape(latest.title)}` : ''}</span></article>${currentCard}</div><div class="manager-trends">${[1,2].map(paper => chart(completed.filter(row => row.paper === paper),paper)).join('')}</div><section class="manager-attempts" aria-labelledby="manager-attempts-heading"><h3 id="manager-attempts-heading">All attempts</h3>${attemptList(rows)}</section>${concepts ? conceptList(concepts) : '<div class="manager-message manager-error" role="alert"><h3>Concept progress is temporarily unavailable.</h3><p>A saved teaching edition needs its concept mapping. Ryan’s saved answers and paper scores are unchanged.</p></div>'}`;
    }
    async function refresh() {
      if (destroyed) return;
      const request = ++generation;
      snapshot = null;
      message('Loading Ryan’s latest progress…', 'Reading his most recently synced work.', 'loading');
      try {
        const [response,definitions] = await Promise.all([client.rpc('tmua_read_student_progress'),loadMetadata()]);
        if (destroyed || request !== generation) return;
        if (response?.error) throw response.error;
        const next = validateResponse(response?.data);
        metadata = definitions; snapshot = next;
        render();
      } catch (_) {
        if (destroyed || request !== generation) return;
        snapshot = null;
        message('Ryan’s progress could not be loaded.', 'Check your connection and try again. Your own practice has not been changed.', 'error');
      }
    }
    function click(event) {
      if (event.target.closest('[data-manager-extra]')) {
        const heading = section.querySelector('#manager-extra-heading');
        heading?.scrollIntoView({block:'start'}); heading?.focus({preventScroll:true});
        return;
      }
      if (event.target.closest('[data-manager-refresh]')) { refresh(); return; }
      const tab = event.target.closest('[data-manager-paper]');
      if (tab && [1,2].includes(Number(tab.dataset.managerPaper))) { selectedPaper = Number(tab.dataset.managerPaper); render(); section.querySelector(`#manager-concepts-tab-${selectedPaper}`)?.focus(); }
    }
    function keydown(event) {
      if (!event.target.closest('[data-manager-paper]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); selectedPaper = event.key === 'Home' ? 1 : event.key === 'End' ? 2 : selectedPaper === 1 ? 2 : 1;
      render(); section.querySelector(`#manager-concepts-tab-${selectedPaper}`)?.focus();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true; ++generation; snapshot = null; metadata = null; metadataRequest = null;
      section.removeEventListener('click',click); section.removeEventListener('keydown',keydown);
      section.innerHTML = ''; section.removeAttribute('aria-busy'); section.removeAttribute('aria-labelledby');
      section.classList.remove('manager-progress');
      if (mounts.get(section) === controller) mounts.delete(section);
    }
    const controller = Object.freeze({refresh,destroy});
    section.addEventListener('click',click); section.addEventListener('keydown',keydown);
    mounts.set(section,controller);
    message('Ryan’s shared progress', 'Open this view to load his most recently synced work.');
    return controller;
  }
  window.TmuaManager = Object.freeze({mount});
})();
