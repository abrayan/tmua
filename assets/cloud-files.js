/* The caller mounts this panel only after verifying manager membership. Storage
   and database policies remain the authority for every request. */
(() => {
  'use strict';
  const BUCKET = 'tmua-pdfs';
  const TABLE = 'tmua_pdf_versions';
  const MAX_BYTES = 50 * 1024 * 1024;
  const FIELDS = 'id,document_key,title,filename,object_path,sha256,bytes,created_at,created_by';
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
      UUID.test(row.created_by) && Number.isFinite(Date.parse(row.created_at));
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
    const headingTitle = element('h3', '', 'Your private PDFs');
    headingTitle.id = `${prefix}-heading`;
    headingCopy.append(headingTitle);
    heading.append(headingCopy, element('span', 'cloud-files-private', 'Private · managers only'));
    const intro = element('p', 'cloud-files-intro', 'Keep PDFs here for future paper updates. Upload a revised PDF as a new version to preserve the original.');
    const form = element('form', 'cloud-files-form');
    const fieldset = element('fieldset', 'cloud-files-fields');
    fieldset.append(element('legend', '', 'Add a PDF'));
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
    const fileInput = element('input');
    fileInput.type = 'file'; fileInput.accept = '.pdf,application/pdf'; fileInput.required = true;
    field('PDF file', fileInput, 'file', 'PDF only · up to 50 MB');
    const titleInput = element('input');
    titleInput.type = 'text'; titleInput.required = true; titleInput.maxLength = 200;
    titleInput.placeholder = 'For example, TMUA Paper 1 notes';
    field('Title', titleInput, 'title');
    const documentSelect = element('select');
    field('Document', documentSelect, 'document', 'Choose an existing document to add an updated version.');
    const keyInput = element('input');
    keyInput.type = 'text'; keyInput.required = true; keyInput.maxLength = 100;
    keyInput.pattern = '[a-z0-9][a-z0-9._-]{0,99}'; keyInput.placeholder = 'tmua-paper-1-notes';
    const keyField = field('New document key', keyInput, 'key', 'A short name using lowercase letters, numbers, hyphens, dots or underscores.');
    const uploadButton = button('Save PDF', 'cloud-files-button cloud-files-primary');
    uploadButton.type = 'submit';
    const formFooter = element('div', 'cloud-files-form-footer');
    formFooter.append(uploadButton, element('p', 'cloud-files-help', 'Every upload is kept as a separate version.'));
    fieldset.append(formFooter); form.append(fieldset);
    const status = element('p', 'cloud-files-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const recovery = element('div', 'cloud-files-recovery'); recovery.hidden = true;
    recovery.append(element('p', '', 'The private file is stored, but its library entry is not confirmed. Retry saving the entry before uploading another version. Keep this page open until it is confirmed, or download the recovery record.'));
    const retryButton = button('Retry library entry');
    const recoveryButton = button('Download recovery record');
    recovery.append(retryButton, recoveryButton);
    const toolbar = element('div', 'cloud-files-toolbar');
    toolbar.append(element('h4', '', 'Saved documents'));
    const actions = element('div', 'cloud-files-actions');
    const refreshButton = button('Refresh');
    const recordButton = button('Download source record');
    actions.append(refreshButton, recordButton); toolbar.append(actions);
    const list = element('div', 'cloud-files-list');
    const note = element('p', 'cloud-files-note', 'When you want new practice material, download the relevant PDF and attach it to your request. The source record lists saved versions for reference. Uploading a PDF does not automatically create or change questions.');
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
      uploadButton.textContent = busy ? 'Saving…' : 'Save PDF';
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
        const existing = rows.find(row => row.document_key === documentSelect.value);
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
      const record = {format:'tmua-private-pdf-sources', version:1, exported_at:new Date().toISOString(), bucket:BUCKET,
        note:'This record contains metadata, not PDFs or access credentials. Download PDFs while signed in to a manager account.',
        versions:rows.map(row => Object.fromEntries(FIELDS.split(',').map(key => [key, row[key]])))};
      if (includePending && pending) record.pending_library_entry = {...pending};
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
      label.append(element('strong', '', `Version ${version}`));
      if (latest) label.append(element('span', 'cloud-files-latest', 'Latest'));
      copy.append(label, element('p', 'cloud-files-filename', row.filename));
      const meta = element('p', 'cloud-files-version-meta');
      const date = element('time', '', dateLabel(row.created_at)); date.dateTime = row.created_at;
      meta.append(date, document.createTextNode(` · ${sizeLabel(row.bytes)}`)); copy.append(meta);
      const control = button('Download PDF');
      control.setAttribute('aria-label', `Download ${row.filename}, version ${version}`);
      control.addEventListener('click', () => download(row, control));
      item.append(copy, control); return item;
    }
    function render() {
      if (disposed) return;
      const selected = documentSelect.value || '';
      const groups = new Map();
      rows.forEach(row => { if (!groups.has(row.document_key)) groups.set(row.document_key, []); groups.get(row.document_key).push(row); });
      const newOption = element('option', '', 'New document'); newOption.value = '';
      documentSelect.replaceChildren(newOption);
      for (const [key, versions] of groups) {
        const option = element('option', '', `${versions[0].title} (${key})`); option.value = key; documentSelect.append(option);
      }
      documentSelect.value = groups.has(selected) ? selected : '';
      // Refreshing the list must not replace a title the manager is editing.
      keyField.hidden = documentSelect.value !== '';
      keyInput.required = documentSelect.value === '';
      keyInput.disabled = documentSelect.value !== '';
      list.replaceChildren();
      if (!groups.size) list.append(element('p', 'cloud-files-empty', 'No PDFs saved yet. Add your first source above.'));
      for (const [key, versions] of groups) {
        const card = element('article', 'cloud-files-document');
        card.append(element('h5', '', versions[0].title), element('p', 'cloud-files-document-key', key), versionRow(versions[0], versions.length, true));
        if (versions.length > 1) {
          const older = element('details', 'cloud-files-older');
          older.append(element('summary', '', `Older versions (${versions.length - 1})`));
          versions.slice(1).forEach((row, index) => older.append(versionRow(row, versions.length - index - 1, false)));
          card.append(older);
        }
        list.append(card);
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
        if (announce) report(rows.length ? `${rows.length} PDF version${rows.length === 1 ? '' : 's'} saved privately.` : 'Ready to save your first PDF.');
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
    async function saveEntry(row) {
      const result = await client.from(TABLE).insert(row); active();
      if (!result.error) return;
      // A response can be lost after an insert succeeds. Confirm the exact
      // immutable entry before asking the manager to retry the same ID.
      try {
        const existing = await client.from(TABLE).select(FIELDS).eq('id', row.id).maybeSingle(); active();
        if (!existing.error && existing.data && Object.keys(row).every(key => existing.data[key] === row[key])) return;
      } catch (_) { active(); }
      throw result.error;
    }
    async function finishEntry() {
      const row = pending;
      await saveEntry(row); active();
      pending = null;
      fileInput.value = ''; titleInput.value = ''; keyInput.value = ''; documentSelect.value = ''; delete keyInput.dataset.edited;
      selectDocument();
      const refreshed = await load(false); active();
      report(refreshed ? 'PDF saved privately. Its earlier versions are still available.' : 'PDF saved privately, but the list could not refresh. Use Refresh to try again.', refreshed ? 'success' : 'error');
    }
    async function upload(event) {
      event.preventDefault();
      if (disposed || busy || loading || pending) return;
      busy = true; controls();
      try {
        const file = fileInput.files?.[0];
        const title = titleInput.value.trim();
        const documentKey = documentSelect.value || keyInput.value.trim();
        if (!file || file.type !== 'application/pdf') throw new Error('Choose a PDF file with the application/pdf file type.');
        if (typeof file.name !== 'string' || file.name.length > 255 || !/\.pdf$/i.test(file.name)) throw new Error('The filename must end in .pdf and contain no more than 255 characters.');
        if (file.size < 5 || file.size > MAX_BYTES) throw new Error('The PDF must be no larger than 50 MB and must not be empty.');
        if (!title || title.length > 200) throw new Error('Enter a title of up to 200 characters.');
        if (!KEY.test(documentKey)) throw new Error('Enter a document key of up to 100 lowercase letters, numbers, dots, hyphens or underscores, starting with a letter or number.');
        if (!documentSelect.value && rows.some(row => row.document_key === documentKey)) throw new Error('That document key already exists. Choose the existing document to add a version.');
        report('Checking your PDF…');
        const header = new Uint8Array(await file.slice(0, 5).arrayBuffer()); active();
        if (String.fromCharCode(...header) !== '%PDF-') throw new Error('This file does not have a valid PDF header.');
        const createdBy = await currentUser();
        if (!crypto?.subtle || !crypto?.randomUUID) throw new Error('A secure browser connection is needed to save PDFs.');
        const bytes = await file.arrayBuffer(); active();
        const hash = await crypto.subtle.digest('SHA-256', bytes); active();
        const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        const id = crypto.randomUUID();
        const row = {id, document_key:documentKey, title, filename:file.name, object_path:`${id}.pdf`, sha256, bytes:file.size, created_by:createdBy};
        report('Saving your PDF privately…');
        const result = await client.storage.from(BUCKET).upload(row.object_path, file, {contentType:'application/pdf', upsert:false}); active();
        if (result.error) throw result.error;
        pending = row; controls();
        await finishEntry();
      } catch (error) {
        report(pending ? `Your PDF is stored privately, but its library entry is not confirmed. ${message(error)}` : `PDF could not be saved or confirmed. ${message(error)}`, 'error');
      } finally { if (!disposed) { busy = false; controls(); } }
    }
    async function retry() {
      if (disposed || busy || !pending) return;
      busy = true; controls(); report('Retrying the library entry…');
      try { await currentUser(pending.created_by); await finishEntry(); }
      catch (error) { report(`Your PDF remains stored privately. Its library entry is still not confirmed. ${message(error)}`, 'error'); }
      finally { if (!disposed) { busy = false; controls(); } }
    }
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
      fileInput.value = ''; titleInput.value = ''; keyInput.value = '';
      list.replaceChildren(); documentSelect.replaceChildren(); status.textContent = '';
      panel.remove();
    }
    return Object.freeze({destroy});
  }
  window.TmuaFiles = Object.freeze({mount});
})();
