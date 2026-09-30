(() => {
  'use strict';
  const section = document.getElementById('score-estimate-section');
  if (!section) return;
  const historyKey = `tmua-attempt-history-v1:${new URL('.', window.location.href).pathname}`;
  const day = 24 * 60 * 60 * 1000;
  // Cambridge University Press & Assessment's original FOI response, 10 January 2024.
  // Index is the combined raw mark /40 for the 2023 papers, not an average of paper scores.
  // https://www.whatdotheyknow.com/request/tmua_score_conversion_2023
  const conversion2023 = Object.freeze([
    1, 1, 1, 1, 1, 1, 1.5, 1.9, 2.4, 2.8, 3.2, 3.5, 3.9, 4.2,
    4.5, 4.8, 5.1, 5.4, 5.7, 6, 6.2, 6.5, 6.6, 6.7, 6.8, 6.9, 7,
    7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 7.8, 8, 8.2, 8.4, 8.6, 9, 9, 9
  ]);
  const dateLabel = date => new Date(date).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
  let memoryOnly = false;

  function validRecords(value) {
    if (!Array.isArray(value)) return [];
    const records = value.filter(record => record && typeof record === 'object'
      && typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 200
      && [1, 2].includes(record.paper) && record.paperId === `tmua-2023-p${record.paper}`
      && typeof record.title === 'string' && Boolean(record.title.trim())
      && Number.isInteger(record.total) && record.total > 0 && record.total <= 1000
      && Number.isInteger(record.firstCorrect) && record.firstCorrect >= 0 && record.firstCorrect <= record.total
      && (record.afterCorrect === null || Number.isInteger(record.afterCorrect)
        && record.afterCorrect >= record.firstCorrect && record.afterCorrect <= record.total)
      && ['manual', 'guided'].includes(record.source) && ['first', 'practised'].includes(record.attemptContext)
      && typeof record.completedAt === 'string' && Number.isFinite(Date.parse(record.completedAt)));
    const counts = new Map();
    records.forEach(record => counts.set(record.id, (counts.get(record.id) || 0) + 1));
    // Conflicting duplicate identifiers cannot be used to select a preferred score.
    return records.map(record => ({...record, ambiguousId:counts.get(record.id) > 1,
      assessment:record.assessment ? {...record.assessment} : null}))
      .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.id.localeCompare(b.id));
  }

  function read() {
    try {
      const stored = JSON.parse(localStorage.getItem(historyKey));
      return stored?.version === 1 ? validRecords(stored.attempts) : [];
    } catch (_) { return null; }
  }
  let attempts = read() || [];

  function benchmark() {
    const now = Date.now();
    const pair = [1, 2].map(paper => {
      const rows = attempts.filter(record => record.paper === paper);
      const first = rows[0];
      if (!first || first.ambiguousId
        || rows[1] && Date.parse(rows[1].completedAt) === Date.parse(first.completedAt)) return null;
      const timestamp = Date.parse(first.completedAt);
      const assessment = first.assessment;
      // Check the earliest recorded exposure before checking conditions. A later
      // attempt labelled "first" must never replace earlier practice or a low mark.
      if (first.source !== 'manual' || first.attemptContext !== 'first' || first.total !== 20
        || timestamp > now || now - timestamp > 60 * day
        || assessment?.unseen !== true || assessment?.timed !== true || assessment?.unaided !== true
        || assessment?.durationMinutes !== 75) return null;
      if (first.finished === false || first.completed !== undefined && first.completed !== 20
        || first.firstAttempted !== undefined && first.firstAttempted !== 20
        || first.hintsUsed !== undefined && first.hintsUsed !== 0
        || first.usedHints === true || first.solutionViewed === true) return null;
      return first;
    });
    if (pair.some(record => !record)) return null;
    const dates = pair.map(record => Date.parse(record.completedAt));
    if (Math.abs(dates[0] - dates[1]) > 14 * day) return null;
    const raw = pair[0].firstCorrect + pair[1].firstCorrect;
    return {raw, scaled:conversion2023[raw], date:Math.max(...dates), pair};
  }

  const explanation = `<details class="score-estimate-details"><summary>How this is assessed</summary>
    <div><p>A 2023 benchmark uses the first recorded sitting of both official 2023 papers: 20 questions each, unseen, 75 minutes, without help. Both sittings must be within 14 days of each other and within the last 60 days. Record those conditions when saving each score in the roadmap.</p>
    <p>We add the two first-sitting marks and use <a href="https://www.whatdotheyknow.com/request/tmua_score_conversion_2023" target="_blank" rel="noopener noreferrer">Cambridge’s published 2023 conversion</a>. Guided practice, hints, repeat attempts and after-learning scores do not establish this benchmark.</p>
    <p>The scale changed in 2024. This historical benchmark is not a prediction on the current scale. Modern results use form-specific calibration; the <a href="https://uat-wp.s3.eu-west-2.amazonaws.com/wp-content/uploads/2026/08/07161815/UAT-UK-TMUA-Technical-Report-2025-26.pdf" target="_blank" rel="noopener noreferrer">official 2025–26 technical report</a> does not publish the raw-mark conversions needed to calibrate these practice papers. See also <a href="https://esat-tmua.ac.uk/test-results/" target="_blank" rel="noopener noreferrer">UAT-UK’s explanation of practice-test scores</a>.</p></div>
    </details>`;

  function render() {
    const expanded = section.querySelector('details')?.open === true;
    const result = benchmark();
    const content = result
      ? `<div class="score-estimate-result"><div><p class="score-estimate-label">2023 benchmark</p><strong class="score-estimate-number">${result.scaled.toFixed(1)}<span> / 9</span></strong><p class="score-estimate-scale">2023 scale</p></div><div class="score-estimate-evidence"><p><strong>${result.raw} / 40</strong> first-sitting marks</p><p>Paper 1: ${result.pair[0].firstCorrect} / 20 · Paper 2: ${result.pair[1].firstCorrect} / 20</p><p>Pair completed <time datetime="${new Date(result.date).toISOString()}">${escape(dateLabel(result.date))}</time></p></div></div><p class="score-estimate-status">Current-scale estimate unavailable</p>`
      : '<p class="score-estimate-empty">Not estimated yet</p><p class="score-estimate-prompt">Record an unseen, timed 2023 pair to see your benchmark on that year’s scale.</p>';
    section.innerHTML = `<h2 id="score-estimate-heading">TMUA score</h2><div aria-live="polite" aria-atomic="true">${content}</div>${explanation}`;
    const details = section.querySelector('details');
    if (details) details.open = expanded;
  }

  section.classList.add('score-estimate');
  section.setAttribute('aria-labelledby', 'score-estimate-heading');
  document.addEventListener('tmua-history-updated', event => {
    if (Array.isArray(event.detail?.attempts)) {
      attempts = validRecords(event.detail.attempts);
      memoryOnly = event.detail.persisted === false;
    } else if (!memoryOnly) {
      const stored = read();
      if (stored !== null) attempts = stored;
    }
    render();
  });
  document.addEventListener('tmua-cloud-applied', event => {
    if (!event.detail?.payload) return;
    const history = event.detail.payload.history;
    attempts = history?.version === 1 ? validRecords(history.attempts) : [];
    memoryOnly = event.detail.persistence?.history === false;
    render();
  });
  window.addEventListener('storage', event => {
    if (memoryOnly || event.key !== historyKey && event.key !== null) return;
    const stored = read();
    if (stored !== null) attempts = stored;
    render();
  });
  window.addEventListener('focus', render);
  render();
})();
