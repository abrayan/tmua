/* The caller mounts this panel only after verifying manager membership. Storage
   and database policies remain the authority for every request. */
(() => {
  'use strict';
  const BUCKET = 'tmua-pdfs';
  const TABLE = 'tmua_pdf_versions';
  const MAX_BYTES = 50 * 1024 * 1024;
  const FIELDS = 'id,document_key,title,filename,object_path,sha256,bytes,created_at,created_by,pair_id,paper_number';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
  let mountCount = 0;
  const message = error => error?.message || 'Please try again.';
  const sizeLabel = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const dateLabel = value => new Date(value).toLocaleString('en-GB', {day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'});
  function validRow(row) {
    return row && UUID.test(row.id) && KEY.test(row.document_key) &&
      typeof row.title === 'string' && typeof row.filename === 'string' &&
      row.object_path === `${row.id}.pdf` && /^[0-9a-f]{64}$/i.test(row.sha256) &&
      Number.isInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_BYTES &&
      UUID.test(row.created_by) && Number.isFinite(Date.parse(row.created_at)) &&
      ((row.pair_id == null && row.paper_number == null) || (UUID.test(row.pair_id) && [1, 2].includes(row.paper_number)));
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className = 'cloud-files-button') {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }
  function mount(container, {client, userId, onStatus} = {}) {
    if (!container || !client?.storage || !client?.from || !client?.auth?.getUser) {
      throw new Error('The private PDF panel needs an authenticated client and a container.');
    }
    const prefix = `cloud-files-${++mountCount}`;
    let disposed = false, busy = false, loading = false, listRequest = 0;
    let rows = [], pending = null;
    const urls = new Set(), timers = new Set();
    const panel = element('section', 'cloud-files');
    panel.setAttribute('aria-labelledby', `${prefix}-heading`);
    const heading = element('div', 'cloud-files-heading');
    const headingCopy = element('div');
    headingCopy.append(element('p', 'eyebrow', 'Source library'));
    const headingTitle = element('h3', '', 'Your paper pairs');
    headingTitle.id = `${prefix}-heading`;
    headingCopy.append(headingTitle);
    heading.append(headingCopy, element('span', 'cloud-files-private', 'Private · managers only'));
    const intro = element('p', 'cloud-files-intro', 'Add Paper 1 and Paper 2 from the same exam. Both PDFs are required and will be kept together.');
    const form = element('form', 'cloud-files-form');
    const fieldset = element('fieldset', 'cloud-files-fields');
    fieldset.append(element('legend', '', 'Add a paper pair'));
    function field(labelText, node, suffix, helpText) {
      const wrapper = element('div', 'cloud-files-field');
      node.id = `${prefix}-${suffix}`;
      const label = element('label', '', labelText);
      label.htmlFor = node.id;
      wrapper.append(label, node);
      if (helpText) {
        const help = element('p', 'cloud-files-help', helpText);
        help.id = `${node.id}-help`;
        node.setAttribute('aria-describedby', help.id);
        wrapper.append(help);
      }
      fieldset.append(wrapper);
      return wrapper;
    }
    const fileInputs = [1, 2].map(number => {
      const input = element('input');
      input.type = 'file'; input.accept = '.pdf,application/pdf'; input.required = true;
      field(`Paper ${number}`, input, `paper-${number}`, 'Required · PDF only · up to 50 MB');
      return input;
    });
    const titleInput = element('input');
    titleInput.type = 'text'; titleInput.required = true; titleInput.maxLength = 200;
    titleInput.placeholder = 'For example, TMUA 2024';
    field('Exam name', titleInput, 'title');
    const documentSelect = element('select');
    field('Paper pair', documentSelect, 'document', 'Choose an existing pair to upload a new version of both papers.');
    const keyInput = element('input');
    keyInput.type = 'text'; keyInput.required = true; keyInput.maxLength = 100;
    keyInput.pattern = '[a-z0-9][a-z0-9._-]{0,99}'; keyInput.placeholder = 'tmua-2024';
    const keyField = field('Pair reference', keyInput, 'key', 'A short name using lowercase letters, numbers, hyphens, dots or underscores.');
    const uploadButton = button('Save paper pair', 'cloud-files-button cloud-files-primary');
    uploadButton.type = 'submit';
    const formFooter = element('div', 'cloud-files-form-footer');
    formFooter.append(uploadButton, element('p', 'cloud-files-help', 'Choose both PDFs to save the pair. Earlier versions are kept.'));
    fieldset.append(formFooter); form.append(fieldset);
    const status = element('p', 'cloud-files-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const recovery = element('div', 'cloud-files-recovery'); recovery.hidden = true;
    recovery.append(element('p', '', 'This pair is not yet saved. Retry to finish uploading both papers and save them together. Keep this page open while retrying; the recovery record keeps the file references.'));
    const retryButton = button('Retry saving pair');
    const recoveryButton = button('Download recovery record');
    recovery.append(retryButton, recoveryButton);
    const toolbar = element('div', 'cloud-files-toolbar');
    toolbar.append(element('h4', '', 'Saved paper pairs'));
    const actions = element('div', 'cloud-files-actions');
    const refreshButton = button('Refresh');
    const recordButton = button('Download source record');
    actions.append(refreshButton, recordButton); toolbar.append(actions);
    const list = element('div', 'cloud-files-list');
    const note = element('p', 'cloud-files-note', 'Both papers stay together for preparation. Guided questions are added after their answers, hints and worked steps have been checked.');
    panel.append(heading, intro, form, status, recovery, toolbar, list, note);
    container.replaceChildren(panel);

    function report(text, kind = '') {
      if (disposed) return;
      status.textContent = text;
      status.dataset.kind = kind;
      if (typeof onStatus === 'function') onStatus(text, kind);
    }
    function controls() {
      if (disposed) return;
      fieldset.disabled = busy || loading || Boolean(pending);
      uploadButton.textContent = busy ? 'Saving…' : 'Save paper pair';
      uploadButton.disabled = busy || loading || Boolean(pending) || fileInputs.some(input => !input.files?.[0]);
      refreshButton.disabled = busy || loading;
      retryButton.disabled = busy;
      recoveryButton.disabled = busy;
      recordButton.disabled = !rows.length;
      recovery.hidden = !pending;
      form.setAttribute('aria-busy', String(busy));
      list.setAttribute('aria-busy', String(loading));
    }
    function active() {
      if (disposed) throw new Error('This private PDF panel has been closed.');
    }
    function selectDocument() {
      const isNew = documentSelect.value === '';
      keyField.hidden = !isNew;
      keyInput.required = isNew;
      keyInput.disabled = !isNew;
      if (!isNew) {
        const existing = rows.find(row => row.pair_id && row.document_key === documentSelect.value);
        if (existing) titleInput.value = existing.title;
      }
    }
    function downloadBlob(blob, filename) {
      active();
      const url = URL.createObjectURL(blob);
      urls.add(url);
      const anchor = element('a'); anchor.href = url; anchor.download = filename;
      anchor.hidden = true; panel.append(anchor); anchor.click(); anchor.remove();
      // Allow the browser to start saving before releasing its temporary URL.
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); timers.delete(timer); }, 30000);
      timers.add(timer);
    }
    function exportRecord(includePending = false) {
      if (disposed) return;
      const record = {format:'tmua-private-pdf-sources', version:2, exported_at:new Date().toISOString(), bucket:BUCKET,
        note:'This record contains metadata, not PDFs or access credentials. Download PDFs while signed in to a manager account.',
        versions:rows.map(row => Object.fromEntries(FIELDS.split(',').map(key => [key, row[key]])))};
      if (includePending && pending) record.pending_pair = {pair_id:pending.rows[0].pair_id, papers:pending.rows.map((row, index) => ({...row, uploaded:pending.uploaded[index]}))};
      downloadBlob(new Blob([JSON.stringify(record, null, 2)], {type:'application/json'}), includePending ? 'tmua-pdf-recovery.json' : 'tmua-pdf-sources.json');
    }
    async function download(row, control) {
      if (disposed) return;
      control.disabled = true;
      try {
        const result = await client.storage.from(BUCKET).download(row.object_path);
        active();
        if (result.error) throw result.error;
        if (!result.data) throw new Error('The PDF could not be downloaded.');
        downloadBlob(result.data, row.filename);
        report(`Download started: ${row.filename}`);
      } catch (error) { report(`PDF download failed. ${message(error)}`, 'error'); }
      finally { if (!disposed) control.disabled = false; }
    }
    function versionRow(row, version, latest) {
      const item = element('div', 'cloud-files-version');
      const copy = element('div', 'cloud-files-version-copy');
      const label = element('p', 'cloud-files-version-label');
      label.append(element('strong', '', row.pair_id ? `Paper ${row.paper_number}` : `Version ${version}`));
      if (latest) label.append(element('span', 'cloud-files-latest', 'Latest'));
      copy.append(label, element('p', 'cloud-files-filename', row.filename));
      const meta = element('p', 'cloud-files-version-meta');
      const date = element('time', '', dateLabel(row.created_at)); date.dateTime = row.created_at;
      meta.append(date, document.createTextNode(` · ${sizeLabel(row.bytes)}`)); copy.append(meta);
      const control = button(row.pair_id ? `Download Paper ${row.paper_number}` : 'Download PDF');
      control.setAttribute('aria-label', `Download ${row.filename}, version ${version}`);
      control.addEventListener('click', () => download(row, control));
      item.append(copy, control); return item;
    }
    function render() {
      if (disposed) return;
      const selected = documentSelect.value || '';
      const groups = new Map();
      rows.forEach(row => { if (!groups.has(row.document_key)) groups.set(row.document_key, []); groups.get(row.document_key).push(row); });
      const newOption = element('option', '', 'New pair'); newOption.value = '';
      documentSelect.replaceChildren(newOption);
      const selectable = new Set();
      for (const [key, versions] of groups) {
        if (!versions.some(row => row.pair_id)) continue;
        selectable.add(key);
        const option = element('option', '', `${versions[0].title} (${key})`); option.value = key; documentSelect.append(option);
      }
      documentSelect.value = selectable.has(selected) ? selected : '';
      keyField.hidden = documentSelect.value !== '';
      keyInput.required = documentSelect.value === '';
      keyInput.disabled = documentSelect.value !== '';
      list.replaceChildren();
      if (!groups.size) list.append(element('p', 'cloud-files-empty', 'No paper pairs saved yet. Add Paper 1 and Paper 2 above.'));
      for (const [key, versions] of groups) {
        const card = element('article', 'cloud-files-document');
        card.append(element('h5', '', versions[0].title), element('p', 'cloud-files-document-key', key));
        const pairs = new Map(), legacy = [];
        versions.forEach(row => {
          if (!row.pair_id) { legacy.push(row); return; }
          if (!pairs.has(row.pair_id)) pairs.set(row.pair_id, []);
          pairs.get(row.pair_id).push(row);
        });
        // A malformed or incomplete record is never presented as a saved pair.
        const complete = [...pairs.values()].filter(pair => pair.length === 2 && pair.some(row => row.paper_number === 1) && pair.some(row => row.paper_number === 2));
        function pairVersion(pair, version, latest) {
          const block = element('div', 'cloud-files-pair');
          block.append(element('p', 'cloud-files-pair-title', `Version ${version}${latest ? ' · Latest' : ''}`));
          pair.sort((a, b) => a.paper_number - b.paper_number).forEach(row => block.append(versionRow(row, version, false)));
          return block;
        }
        if (complete.length) card.append(pairVersion(complete[0], complete.length, true));
        if (complete.length > 1) {
          const older = element('details', 'cloud-files-older');
          older.append(element('summary', '', `Older versions (${complete.length - 1})`));
          complete.slice(1).forEach((pair, index) => older.append(pairVersion(pair, complete.length - index - 1, false)));
          card.append(older);
        }
        if (legacy.length) {
          card.append(element('p', 'cloud-files-help', 'Previously saved source PDFs'));
          card.append(versionRow(legacy[0], legacy.length, true));
          if (legacy.length > 1) {
            const older = element('details', 'cloud-files-older');
            older.append(element('summary', '', `Older versions (${legacy.length - 1})`));
            legacy.slice(1).forEach((row, index) => older.append(versionRow(row, legacy.length - index - 1, false)));
            card.append(older);
          }
        }
        if (complete.length || legacy.length) list.append(card);
      }
      controls();
    }
    async function load(announce = true) {
      const request = ++listRequest;
      loading = true; controls();
      if (announce) report('Loading your private PDFs…');
      try {
        // Paginate because the backend may cap a response at 1,000 rows.
        const all = [];
        for (let offset = 0; ; offset += 500) {
          const result = await client.from(TABLE).select(FIELDS).order('created_at', {ascending:false}).order('id', {ascending:false}).range(offset, offset + 499);
          active();
          if (request !== listRequest) return false;
          if (result.error) throw result.error;
          if (!Array.isArray(result.data)) throw new Error('The source library returned an unexpected response.');
          all.push(...result.data);
          if (result.data.length < 500) break;
        }
        rows = all.filter(validRow);
        render();
        if (announce) report(rows.length ? `${rows.length} PDF version${rows.length === 1 ? '' : 's'} saved privately.` : 'Ready to save your first paper pair.');
        return true;
      } catch (error) {
        if (!disposed && request === listRequest) report(`Could not load the PDF library. ${message(error)}`, 'error');
        return false;
      } finally {
        if (!disposed && request === listRequest) { loading = false; controls(); }
      }
    }
    async function currentUser(expectedId) {
      const result = await client.auth.getUser(); active();
      if (result.error) throw result.error;
      const id = result.data?.user?.id;
      if (!id || (expectedId && expectedId !== id) || (userId && userId !== id)) throw new Error('Please sign in again with the same manager account.');
      return id;
    }
    async function saveEntries(pairRows) {
      // One database transaction: both paper records or neither.
      const result = await client.from(TABLE).insert(pairRows); active();
      if (!result.error) return;
      try {
        let confirmed = 0;
        for (const row of pairRows) {
          const existing = await client.from(TABLE).select(FIELDS).eq('id', row.id).maybeSingle(); active();
          if (!existing.error && existing.data && Object.keys(row).every(key => existing.data[key] === row[key])) confirmed++;
        }
        if (confirmed === 2) return;
      } catch (_) { active(); }
      throw result.error;
    }
    async function hashFile(file) {
      const bytes = await file.arrayBuffer(); active();
      const hash = await crypto.subtle.digest('SHA-256', bytes); active();
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    async function finishPair() {
      const pair = pending;
      for (let i = 0; i < 2; i++) {
        await currentUser(pair.rows[0].created_by);
        if (pair.uploaded[i]) continue;
        const row = pair.rows[i];
        report(`Saving Paper ${i + 1} privately…`);
        const result = await client.storage.from(BUCKET).upload(row.object_path, pair.files[i], {contentType:'application/pdf', upsert:false}); active();
        if (result.error) {
          // A network failure may hide a successful upload. Confirm the exact
          // bytes before accepting an existing immutable object on retry.
          const existing = await client.storage.from(BUCKET).download(row.object_path); active();
          if (existing.error || !existing.data || existing.data.size !== row.bytes || await hashFile(existing.data) !== row.sha256) throw result.error;
        }
        pair.uploaded[i] = true;
      }
      await currentUser(pair.rows[0].created_by);
      await saveEntries(pair.rows); active();
      pending = null;
      fileInputs.forEach(input => { input.value = ''; });
      titleInput.value = ''; keyInput.value = ''; documentSelect.value = ''; delete keyInput.dataset.edited;
      selectDocument();
      const refreshed = await load(false); active();
      report(refreshed ? 'Paper pair saved privately. Both papers are linked and earlier versions are still available.' : 'Paper pair saved privately, but the list could not refresh. Use Refresh to try again.', refreshed ? 'success' : 'error');
    }
    async function upload(event) {
      event.preventDefault();
      if (disposed || busy || loading || pending) return;
      busy = true; controls();
      try {
        const files = fileInputs.map(input => input.files?.[0]);
        const title = titleInput.value.trim();
        const documentKey = documentSelect.value || keyInput.value.trim();
        if (files.some(file => !file)) throw new Error('Choose both Paper 1 and Paper 2 before saving.');
        for (const file of files) {
          if (file.type !== 'application/pdf') throw new Error('Choose a PDF file with the application/pdf file type for each paper.');
          if (typeof file.name !== 'string' || file.name.length > 255 || !/\.pdf$/i.test(file.name)) throw new Error('Each filename must end in .pdf and contain no more than 255 characters.');
          if (file.size < 5 || file.size > MAX_BYTES) throw new Error('Each PDF must be no larger than 50 MB and must not be empty.');
        }
        if (!title || title.length > 200) throw new Error('Enter an exam title of up to 200 characters.');
        if (!KEY.test(documentKey)) throw new Error('Enter a document key of up to 100 lowercase letters, numbers, dots, hyphens or underscores, starting with a letter or number.');
        if (!documentSelect.value && rows.some(row => row.document_key === documentKey)) throw new Error('That reference already exists. Choose the existing paper pair to add a version, or a new reference for a new pair.');
        report('Checking both PDFs…');
        for (const file of files) {
          const header = new Uint8Array(await file.slice(0, 5).arrayBuffer()); active();
          if (String.fromCharCode(...header) !== '%PDF-') throw new Error('Both files must have a valid PDF header.');
        }
        const createdBy = await currentUser();
        if (!crypto?.subtle || !crypto?.randomUUID) throw new Error('A secure browser connection is needed to save PDFs.');
        const hashes = [];
        for (const file of files) hashes.push(await hashFile(file));
        if (hashes[0] === hashes[1]) throw new Error('Paper 1 and Paper 2 must be different PDFs. Choose the matching two papers.');
        const pairId = crypto.randomUUID();
        const pairRows = files.map((file, index) => {
          const id = crypto.randomUUID();
          return {id, pair_id:pairId, paper_number:index + 1, document_key:documentKey, title, filename:file.name, object_path:`${id}.pdf`, sha256:hashes[index], bytes:file.size, created_by:createdBy};
        });
        pending = {rows:pairRows, files, uploaded:[false, false]}; controls();
        await finishPair();
      } catch (error) {
        report(pending ? `The paper pair is not yet confirmed. Retry saving the pair. ${message(error)}` : `Paper pair could not be saved. ${message(error)}`, 'error');
      } finally { if (!disposed) { busy = false; controls(); } }
    }
    async function retry() {
      if (disposed || busy || !pending) return;
      busy = true; controls(); report('Retrying the paper pair…');
      try { await currentUser(pending.rows[0].created_by); await finishPair(); }
      catch (error) { report(`The paper pair is not yet confirmed. ${message(error)}`, 'error'); }
      finally { if (!disposed) { busy = false; controls(); } }
    }
    fileInputs.forEach(input => input.addEventListener('change', controls));
    form.addEventListener('submit', upload);
    documentSelect.addEventListener('change', selectDocument);
    titleInput.addEventListener('input', () => {
      if (!keyInput.dataset.edited && !documentSelect.value) keyInput.value = titleInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
    });
    keyInput.addEventListener('input', () => { keyInput.dataset.edited = 'true'; });
    refreshButton.addEventListener('click', () => load());
    retryButton.addEventListener('click', retry);
    recordButton.addEventListener('click', () => exportRecord());
    recoveryButton.addEventListener('click', () => exportRecord(true));
    render(); load();
    function destroy() {
      if (disposed) return;
      disposed = true; listRequest += 1;
      rows = []; pending = null;
      timers.forEach(timer => clearTimeout(timer)); timers.clear();
      urls.forEach(url => URL.revokeObjectURL(url)); urls.clear();
      fileInputs.forEach(input => { input.value = ''; }); titleInput.value = ''; keyInput.value = '';
      list.replaceChildren(); documentSelect.replaceChildren(); status.textContent = '';
      panel.remove();
    }
    return Object.freeze({destroy});
  }
  window.TmuaFiles = Object.freeze({mount});
})();
