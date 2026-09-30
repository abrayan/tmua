import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto, createHash} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../assets/cloud-files.js', import.meta.url), 'utf8');
const manager = '10000000-0000-4000-8000-000000000001';
const uuid = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const pdf = (text = '%PDF-1.7\nexample', type = 'application/pdf', name = 'notes.pdf') => Object.assign(new Blob([text], {type}), {name});
const row = (number, changes = {}) => ({id:uuid(number), document_key:'notes', title:'Study notes', filename:`notes-${number}.pdf`, object_path:`${uuid(number)}.pdf`, sha256:'a'.repeat(64), bytes:2000, created_at:`2026-09-${String(number).padStart(2, '0')}T12:00:00Z`, created_by:manager, ...changes});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const settle = () => new Promise(resolve => setImmediate(resolve));

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.className = ''; }
  append(...children) { for (const child of children) { this.children.push(child); child.parentNode = this; } }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...children); }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(handler); }
  async emit(type) { for (const handler of this.events.get(type) || []) await handler({preventDefault(){}}); }
  click() { this.clicked = true; return this.emit('click'); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  all(predicate) { return this.children.flatMap(node => [...(predicate(node) ? [node] : []), ...node.all(predicate)]); }
  find(predicate) { return this.all(predicate)[0]; }
}

function harness(options = {}) {
  const container = new Node(), urls = [], revoked = [], statuses = [], insertions = [], uploads = [], downloads = [], ranges = [];
  const data = options.rows || [];
  const timers = new Map(); let timerId = 0;
  const client = {
    auth:{async getUser(){ return {data:{user:{id:options.authUser || manager}}, error:options.authError}; }},
    storage:{from(bucket){
      assert.equal(bucket, 'tmua-pdfs');
      return {
        async upload(path, file, settings) { uploads.push({path, file, settings}); return options.upload ? options.upload(path, file, settings) : {data:{path}, error:null}; },
        async download(path) { downloads.push(path); return options.download ? options.download(path) : {data:pdf(), error:null}; }
      };
    }},
    from(table) {
      assert.equal(table, 'tmua_pdf_versions');
      let selectedId;
      const query = {
        select(){ return query; }, order(){ return query; },
        async range(start, end) { ranges.push([start,end]); return options.list ? options.list(start,end) : {data:data.slice(start,end + 1), error:null}; },
        eq(key,value){ assert.equal(key,'id'); selectedId = value; return query; },
        async maybeSingle(){ return {data:data.find(item => item.id === selectedId) || null,error:null}; },
        async insert(item) {
          const copy = {...item}; insertions.push(copy);
          if (options.insert) return options.insert(copy, data);
          data.unshift({...copy,created_at:'2026-09-30T12:00:00Z'});
          return {error:null};
        }
      };
      return query;
    }
  };
  const document = {createElement:tag => new Node(tag), createTextNode:text => { const node = new Node('#text'); node.textContent = text; return node; }};
  const window = {};
  vm.runInNewContext(source, {window, document, Blob, Uint8Array, Date, crypto:webcrypto,
    URL:{createObjectURL(blob){ const url = `blob:private-${urls.length}`; urls.push({url,blob}); return url; }, revokeObjectURL(url){revoked.push(url);}},
    setTimeout(callback){const id = ++timerId; timers.set(id, callback);return id;}, clearTimeout(id){timers.delete(id);}
  });
  const {destroy} = window.TmuaFiles.mount(container, {client,userId:manager,onStatus:(text,kind) => statuses.push({text,kind})});
  const byTag = tag => container.find(node => node.tagName === tag);
  const bySuffix = suffix => container.find(node => node.id?.endsWith(`-${suffix}`));
  const byText = text => container.find(node => node.tagName === 'button' && node.textContent === text);
  const app = {container, client, data, uploads, insertions, downloads, ranges, urls, revoked, statuses, destroy, byTag, bySuffix, byText, timers,
    status:() => statuses.at(-1)?.text,
    async submit(file = pdf(), {title = 'Study notes', key = 'study-notes', existing = ''} = {}) {
      bySuffix('file').files = [file]; bySuffix('title').value = title; bySuffix('key').value = key; bySuffix('document').value = existing;
      await byTag('form').emit('submit');
    }
  };
  return app;
}

test('valid PDF is hashed and appended with a unique immutable private object', async () => {
  const app = harness(); await settle();
  const first = pdf(); await app.submit(first);
  assert.equal(app.uploads.length, 1); assert.equal(app.insertions.length, 1);
  const saved = app.insertions[0];
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(app.uploads[0].path, `${saved.id}.pdf`);
  assert.equal(app.uploads[0].settings.upsert, false);
  assert.equal(app.uploads[0].settings.contentType, 'application/pdf');
  assert.equal(saved.sha256, createHash('sha256').update(Buffer.from(await first.arrayBuffer())).digest('hex'));
  assert.equal(saved.created_by, manager); assert.equal(saved.document_key, 'study-notes');
  assert.equal(saved.bytes, first.size); assert.match(app.status(), /PDF saved privately/);
  assert.equal(app.byTag('fieldset').disabled, false);
  await app.submit(pdf('%PDF-2.0\nnew version'), {existing:'study-notes'});
  assert.equal(app.uploads.length, 2); assert.notEqual(app.uploads[0].path, app.uploads[1].path);
  assert.equal(app.insertions[1].document_key, 'study-notes');
  assert.match(app.container.textContent, /Older versions \(1\)/);
});

test('invalid MIME, header, size, filename and document keys do not upload', async () => {
  const cases = [
    [pdf('%PDF-1.7', 'text/plain'), {}, /application\/pdf/],
    [pdf('a fake PDF file'), {}, /valid PDF header/],
    [{name:'big.pdf',type:'application/pdf',size:50 * 1024 * 1024 + 1}, {}, /50 MB/],
    [pdf('%PDF-', 'application/pdf', 'bad.txt'), {}, /filename must end in \.pdf/],
    [pdf(), {key:'../bad-key'}, /document key/],
    [pdf(), {title:'   '}, /title/]
  ];
  for (const [file, fields, expected] of cases) {
    const app = harness(); await settle(); await app.submit(file, fields);
    assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0);
    assert.match(app.status(), expected); assert.equal(app.byTag('fieldset').disabled, false);
  }
});

test('new-document keys cannot silently append to an existing document', async () => {
  const app = harness({rows:[row(1)]}); await settle(); await app.submit(pdf(), {key:'notes'});
  assert.equal(app.uploads.length, 0); assert.match(app.status(), /Choose the existing document/);
});

test('metadata failure keeps the file and retries the same ID without uploading again', async () => {
  let attempts = 0;
  const app = harness({insert(item,data){
    if (++attempts === 1) return {error:{message:'The library is temporarily unavailable.'}};
    data.unshift({...item,created_at:'2026-09-30T12:00:00Z'}); return {error:null};
  }});
  await settle(); await app.submit();
  assert.equal(app.uploads.length, 1); assert.match(app.status(), /stored privately.*entry is not confirmed/);
  assert.equal(app.byTag('fieldset').disabled, true);
  assert.equal(app.byText('Retry library entry').disabled, false);
  await app.byText('Download recovery record').click();
  const recovery = JSON.parse(await app.urls[0].blob.text());
  assert.equal(recovery.pending_library_entry.id, app.insertions[0].id);
  assert.equal(recovery.pending_library_entry.object_path, app.uploads[0].path);
  await app.byText('Retry library entry').click();
  assert.equal(app.uploads.length, 1); assert.equal(app.insertions.length, 2);
  assert.equal(app.insertions[0].id, app.insertions[1].id);
  assert.equal(app.byTag('fieldset').disabled, false); assert.match(app.status(), /PDF saved privately/);
  app.destroy();
});

test('an insert whose response was lost is confirmed by its exact immutable metadata', async () => {
  const app = harness({insert(item,data){ data.unshift({...item,created_at:'2026-09-30T12:00:00Z'}); return {error:{message:'Network response lost'}}; }});
  await settle(); await app.submit();
  assert.match(app.status(), /PDF saved privately/);
  assert.equal(app.byTag('fieldset').disabled, false); assert.equal(app.insertions.length, 1);
});

test('upload failure creates no metadata and allows another attempt', async () => {
  const app = harness({upload:async () => ({error:{message:'Storage unavailable'}})}); await settle(); await app.submit();
  assert.equal(app.insertions.length, 0); assert.match(app.status(), /Storage unavailable/);
  assert.equal(app.byTag('fieldset').disabled, false);
});

test('a changed account cannot upload a manager file', async () => {
  const app = harness({authUser:uuid(9)}); await settle(); await app.submit();
  assert.equal(app.uploads.length, 0); assert.match(app.status(), /same manager account/);
});

test('versions are grouped safely, listed with dates and exported only on a click', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const app = harness({rows:[row(2,{title:unsafe}), row(1), row(3,{object_path:'../other.pdf'})]}); await settle();
  assert.equal(app.container.all(node => node.tagName === 'article').length, 1);
  assert.match(app.container.textContent, /Older versions \(1\)/);
  assert.match(app.container.textContent, /Version 2Latest/); assert.match(app.container.textContent, /2 Sept 2026/);
  assert.equal(app.container.find(node => node.tagName === 'h5').textContent, unsafe);
  assert.equal(app.container.all(node => node.tagName === 'img').length, 0);
  assert.equal(app.urls.length, 0); assert.equal(app.downloads.length, 0);
  await app.byText('Download source record').click();
  const record = JSON.parse(await app.urls[0].blob.text());
  assert.equal(record.versions.length, 2); assert.equal(record.bucket, 'tmua-pdfs');
  assert.equal(record.versions[0].object_path, `${uuid(2)}.pdf`);
  assert.doesNotMatch(await app.urls[0].blob.text(), /signedUrl|access_token/);
  app.destroy();
});

test('private download uses the authenticated SDK and revokes temporary URLs on disposal', async () => {
  const app = harness({rows:[row(1)]}); await settle();
  await app.byText('Download PDF').click();
  assert.deepEqual(app.downloads, [`${uuid(1)}.pdf`]); assert.equal(app.urls.length, 1);
  assert.match(app.status(), /Download started/);
  app.destroy();
  assert.equal(app.container.children.length, 0); assert.deepEqual(app.revoked, ['blob:private-0']); assert.equal(app.timers.size, 0);
});

test('download failures restore the download control', async () => {
  const app = harness({rows:[row(1)], download:async () => ({error:{message:'Sign-in expired'}})}); await settle();
  const control = app.byText('Download PDF'); await control.click();
  assert.equal(control.disabled, false); assert.match(app.status(), /Sign-in expired/); assert.equal(app.urls.length, 0);
});

test('disposal during a pending list cannot restore private data', async () => {
  const request = deferred();
  const app = harness({list:() => request.promise});
  app.destroy(); request.resolve({data:[row(1)],error:null}); await settle();
  assert.equal(app.container.children.length, 0); assert.equal(app.statuses.length, 1);
});

test('disposal during download prevents a late browser download', async () => {
  const request = deferred(); const app = harness({rows:[row(1)],download:() => request.promise}); await settle();
  const done = app.byText('Download PDF').click(); app.destroy(); request.resolve({data:pdf(),error:null}); await done;
  assert.equal(app.urls.length, 0); assert.equal(app.container.children.length, 0);
});

test('disposal during storage upload stops later metadata work and UI updates', async () => {
  const request = deferred(); const started = deferred();
  const app = harness({upload:() => {started.resolve(); return request.promise;}}); await settle();
  const done = app.submit(); await started.promise; const statusCount = app.statuses.length;
  app.destroy(); request.resolve({error:null}); await done;
  assert.equal(app.insertions.length, 0); assert.equal(app.statuses.length, statusCount); assert.equal(app.container.children.length, 0);
});

test('listing paginates without dropping older versions', async () => {
  const rows = Array.from({length:501}, (_,index) => row(1,{id:uuid(index + 1),object_path:`${uuid(index + 1)}.pdf`}));
  const app = harness({rows}); await settle();
  assert.deepEqual(app.ranges, [[0,499],[500,999]]);
  assert.match(app.container.textContent, /Older versions \(500\)/);
});
