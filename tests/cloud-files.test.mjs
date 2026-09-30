import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto, createHash} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../assets/cloud-files.js', import.meta.url), 'utf8');
const manager = '10000000-0000-4000-8000-000000000001';
const uuid = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const pdf = (text = '%PDF-1.7\nexample', type = 'application/pdf', name = 'notes.pdf') => Object.assign(new Blob([text], {type}), {name});
const paper1 = () => pdf('%PDF-1.7\npaper one', 'application/pdf', 'paper-1.pdf');
const paper2 = () => pdf('%PDF-1.7\npaper two', 'application/pdf', 'paper-2.pdf');
const row = (number, changes = {}) => ({id:uuid(number), document_key:'notes', title:'Study notes', filename:`notes-${number}.pdf`, object_path:`${uuid(number)}.pdf`, sha256:'a'.repeat(64), bytes:2000, created_at:`2026-09-${String(Math.min(number, 28)).padStart(2, '0')}T12:00:00Z`, created_by:manager, ...changes});
const pair = (number, changes = {}) => [1, 2].map(paper_number => row(number * 2 + paper_number, {document_key:'practice-papers', title:'Practice papers', pair_id:uuid(1000 + number), paper_number, sha256:String(paper_number).repeat(64), created_at:`2026-09-${String(number).padStart(2, '0')}T12:00:00Z`, ...changes}));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const settle = () => new Promise(resolve => setImmediate(resolve));

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.hidden = false; this.disabled = false; this._value = ''; this._text = ''; this.className = ''; }
  set value(value) { this._value = value; if (this.type === 'file' && value === '') this.files = []; }
  get value() { return this._value; }
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
  const container = new Node(), urls = [], revoked = [], statuses = [], insertions = [], uploads = [], downloads = [], ranges = [], confirmations = [];
  const data = options.rows || [];
  const timers = new Map(); let timerId = 0;
  const client = {
    auth:{async getUser(){ return options.getUser ? options.getUser() : {data:{user:{id:options.authUser || manager}}, error:options.authError}; }},
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
        async maybeSingle(){ confirmations.push(selectedId); return options.confirm ? options.confirm(selectedId, data) : {data:data.find(item => item.id === selectedId) || null,error:null}; },
        async insert(items) {
          assert.ok(Array.isArray(items), 'Both papers must be inserted together in one array');
          const copy = Array.from(items, item => ({...item})); insertions.push(copy);
          if (options.insert) return options.insert(copy, data);
          data.unshift(...copy.map(item => ({...item,created_at:'2026-09-30T12:00:00Z'})));
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
  const app = {container, client, data, uploads, insertions, downloads, ranges, confirmations, urls, revoked, statuses, destroy, byTag, bySuffix, byText, timers,
    status:() => statuses.at(-1)?.text,
    async choose(first = paper1(), second = paper2()) {
      bySuffix('paper-1').files = first ? [first] : []; await bySuffix('paper-1').emit('change');
      bySuffix('paper-2').files = second ? [second] : []; await bySuffix('paper-2').emit('change');
    },
    async submit(first = paper1(), second = paper2(), {title = 'Practice papers', key = 'practice-papers', existing = ''} = {}) {
      await app.choose(first, second);
      bySuffix('title').value = title; bySuffix('key').value = key; bySuffix('document').value = existing;
      await byTag('form').emit('submit');
    }
  };
  return app;
}

test('both papers are required and the submit control enables only with a complete pair', async () => {
  const app = harness(); await settle();
  assert.equal(app.bySuffix('paper-1').required, true); assert.equal(app.bySuffix('paper-2').required, true);
  assert.equal(app.byText('Save paper pair').disabled, true);
  await app.choose(paper1(), null); assert.equal(app.byText('Save paper pair').disabled, true);
  await app.choose(null, paper2()); assert.equal(app.byText('Save paper pair').disabled, true);
  await app.choose(); assert.equal(app.byText('Save paper pair').disabled, false);
});

test('a missing paper cannot be submitted programmatically', async () => {
  for (const files of [[paper1(), null], [null, paper2()], [null, null]]) {
    const app = harness(); await settle(); await app.submit(...files);
    assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0);
    assert.equal(app.byTag('fieldset').disabled, false);
    assert.match(app.status(), /both|Paper [12]/i);
  }
});

test('two PDFs are hashed and saved in one atomic metadata insertion with immutable private objects', async () => {
  const app = harness(); await settle();
  const first = paper1(), second = paper2(); await app.submit(first, second);
  assert.equal(app.uploads.length, 2); assert.equal(app.insertions.length, 1);
  const saved = app.insertions[0]; assert.equal(saved.length, 2);
  assert.match(saved[0].pair_id, /^[0-9a-f-]{36}$/); assert.equal(saved[0].pair_id, saved[1].pair_id);
  assert.notEqual(saved[0].id, saved[1].id); assert.notEqual(saved[0].sha256, saved[1].sha256);
  for (const [index, file] of [first, second].entries()) {
    assert.match(saved[index].id, /^[0-9a-f-]{36}$/);
    assert.equal(saved[index].paper_number, index + 1);
    assert.equal(app.uploads[index].path, `${saved[index].id}.pdf`);
    assert.equal(app.uploads[index].settings.upsert, false);
    assert.equal(app.uploads[index].settings.contentType, 'application/pdf');
    assert.equal(saved[index].sha256, createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'));
    assert.equal(saved[index].created_by, manager); assert.equal(saved[index].document_key, 'practice-papers');
    assert.equal(saved[index].title, 'Practice papers'); assert.equal(saved[index].bytes, file.size);
  }
  assert.match(app.status(), /Paper pair saved privately/); assert.equal(app.byTag('fieldset').disabled, false);
  assert.equal(app.byText('Save paper pair').disabled, true);
  await app.submit(pdf('%PDF-2.0\nnew paper one'), pdf('%PDF-2.0\nnew paper two'), {existing:'practice-papers'});
  assert.equal(app.uploads.length, 4); assert.equal(app.insertions.length, 2);
  assert.notEqual(app.insertions[0][0].pair_id, app.insertions[1][0].pair_id);
  assert.equal(new Set(app.uploads.map(upload => upload.path)).size, 4);
  assert.match(app.container.textContent, /Older versions \(1\)/);
});

test('invalid MIME, header, size, filename and document fields prevent all uploads', async () => {
  const cases = [
    [pdf('%PDF-1.7', 'text/plain'), {}, /application\/pdf/],
    [pdf('a fake PDF file'), {}, /valid PDF header/],
    [{name:'big.pdf',type:'application/pdf',size:50 * 1024 * 1024 + 1}, {}, /50 MB/],
    [pdf('%PDF-', 'application/pdf', 'bad.txt'), {}, /filename must end in \.pdf/],
    [paper1(), {key:'../bad-key'}, /key/],
    [paper1(), {title:'   '}, /title/]
  ];
  for (const [file, fields, expected] of cases) {
    const app = harness(); await settle(); await app.submit(file, paper2(), fields);
    assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0);
    assert.match(app.status(), expected); assert.equal(app.byTag('fieldset').disabled, false);
  }
});

test('Paper 2 is fully validated and hashed before Paper 1 can upload', async () => {
  for (const second of [pdf('a fake PDF file'), pdf('%PDF-1.7', 'text/plain'), {name:'paper-2.pdf',type:'application/pdf',size:100,slice:()=>new Blob(['%PDF-']),arrayBuffer:async()=>{throw new Error('Could not read Paper 2');}}]) {
    const app = harness(); await settle(); await app.submit(paper1(), second);
    assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0);
    assert.equal(app.byTag('fieldset').disabled, false);
  }
});

test('identical PDF bytes cannot occupy both paper slots even with different filenames', async () => {
  const app = harness(); await settle();
  await app.submit(pdf('%PDF-1.7\nsame paper', 'application/pdf', 'paper-1.pdf'), pdf('%PDF-1.7\nsame paper', 'application/pdf', 'paper-2.pdf'));
  assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0);
  assert.match(app.status(), /different|same|identical/i); assert.equal(app.byTag('fieldset').disabled, false);
});

test('a new pair key cannot silently append to an existing pair or a legacy document', async () => {
  for (const rows of [pair(1), [row(1, {document_key:'practice-papers'})]]) {
    const app = harness({rows}); await settle(); await app.submit();
    assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0);
    assert.match(app.status(), /already|existing|legacy/i);
  }
});

test('metadata is not inserted while either storage upload is pending', async () => {
  const request = deferred(), started = deferred(); let uploads = 0;
  const app = harness({upload:async () => { if (++uploads === 2) { started.resolve(); return request.promise; } return {error:null}; }});
  await settle(); const done = app.submit(); await started.promise;
  assert.equal(app.insertions.length, 0); assert.equal(app.container.all(node => node.tagName === 'article').length, 0);
  request.resolve({error:null}); await done; assert.equal(app.insertions.length, 1);
});

test('a second upload failure holds the incomplete pair and retries only its missing file', async () => {
  let attempts = 0;
  const app = harness({upload:async () => ++attempts === 2 ? {error:{message:'Storage unavailable'}} : {error:null}});
  await settle(); await app.submit();
  assert.equal(app.uploads.length, 2); assert.equal(app.insertions.length, 0);
  assert.match(app.status(), /Storage unavailable/); assert.equal(app.byTag('fieldset').disabled, true);
  assert.equal(app.byText('Retry saving pair').disabled, false);
  assert.equal(app.container.all(node => node.tagName === 'article').length, 0);
  await app.byText('Download recovery record').click();
  const recovery = JSON.parse(await app.urls[0].blob.text());
  assert.match(recovery.pending_pair.pair_id, /^[0-9a-f-]{36}$/);
  assert.equal(recovery.pending_pair.papers.length, 2);
  assert.deepEqual(recovery.pending_pair.papers.map(item => item.uploaded), [true, false]);
  assert.equal(recovery.pending_pair.papers[0].object_path, app.uploads[0].path);
  assert.equal(recovery.pending_pair.papers[1].object_path, app.uploads[1].path);
  assert.equal(recovery.pending_pair.papers[0].pair_id, recovery.pending_pair.pair_id);
  assert.doesNotMatch(await app.urls[0].blob.text(), /%PDF-|access_token|signedUrl|"files"/);
  await app.submit(pdf('%PDF-1.7\nreplacement one'), pdf('%PDF-1.7\nreplacement two'));
  assert.equal(app.uploads.length, 2); assert.equal(app.insertions.length, 0);
  await app.byText('Retry saving pair').click();
  assert.equal(app.uploads.length, 3); assert.equal(app.uploads[2].path, app.uploads[1].path);
  assert.equal(app.insertions.length, 1); assert.equal(app.byTag('fieldset').disabled, false);
  assert.equal(app.insertions[0][0].object_path, app.uploads[0].path);
  assert.equal(app.insertions[0][1].object_path, app.uploads[1].path);
  assert.match(app.status(), /Paper pair saved privately/); app.destroy();
});

test('a first upload failure retains both original papers for an explicit retry', async () => {
  let attempts = 0;
  const app = harness({upload:async () => ++attempts === 1 ? {error:{message:'Storage unavailable'}} : {error:null}});
  await settle(); await app.submit();
  assert.equal(app.insertions.length, 0); assert.equal(app.byTag('fieldset').disabled, true);
  await app.byText('Retry saving pair').click();
  assert.equal(app.uploads.length, 3); assert.equal(app.uploads[0].path, app.uploads[1].path);
  assert.equal(app.insertions.length, 1); assert.match(app.status(), /Paper pair saved privately/);
});

test('metadata failure retries the same pair in one insertion without uploading either file again', async () => {
  let attempts = 0;
  const app = harness({insert(items,data){
    if (++attempts === 1) return {error:{message:'The library is temporarily unavailable.'}};
    data.unshift(...items.map(item => ({...item,created_at:'2026-09-30T12:00:00Z'}))); return {error:null};
  }});
  await settle(); await app.submit();
  assert.equal(app.uploads.length, 2); assert.equal(app.byTag('fieldset').disabled, true);
  assert.equal(app.byText('Retry saving pair').disabled, false);
  await app.byText('Download recovery record').click();
  const recovery = JSON.parse(await app.urls[0].blob.text());
  assert.deepEqual(recovery.pending_pair.papers.map(item => item.uploaded), [true, true]);
  assert.deepEqual(recovery.pending_pair.papers.map(item => item.id), app.insertions[0].map(item => item.id));
  await app.byText('Retry saving pair').click();
  assert.equal(app.uploads.length, 2); assert.equal(app.insertions.length, 2);
  assert.deepEqual(app.insertions[0], app.insertions[1]);
  assert.equal(app.byTag('fieldset').disabled, false); assert.match(app.status(), /Paper pair saved privately/);
  app.destroy();
});

test('a lost metadata response is confirmed only when both exact immutable rows exist', async () => {
  const app = harness({insert(items,data){ data.unshift(...items.map(item => ({...item,created_at:'2026-09-30T12:00:00Z'}))); return {error:{message:'Network response lost'}}; }});
  await settle(); await app.submit();
  assert.match(app.status(), /Paper pair saved privately/); assert.equal(app.byTag('fieldset').disabled, false);
  assert.equal(app.insertions.length, 1);
  assert.deepEqual(new Set(app.confirmations), new Set(app.insertions[0].map(item => item.id)));
});

test('a missing or mismatched second row never falsely confirms a lost metadata response', async () => {
  for (const mismatch of [null, {sha256:'f'.repeat(64)}, {pair_id:uuid(9999)}, {paper_number:1}]) {
    const app = harness({insert(items,data){
      data.unshift({...items[0],created_at:'2026-09-30T12:00:00Z'});
      if (mismatch) data.unshift({...items[1], ...mismatch, created_at:'2026-09-30T12:00:00Z'});
      return {error:{message:'Network response lost'}};
    }});
    await settle(); await app.submit();
    assert.equal(app.byTag('fieldset').disabled, true); assert.equal(app.byText('Retry saving pair').disabled, false);
    assert.doesNotMatch(app.status(), /Paper pair saved privately/);
    assert.equal(app.container.all(node => node.tagName === 'article').length, 0);
  }
});

test('a changed account cannot upload a manager pair', async () => {
  const app = harness({authUser:uuid(9)}); await settle(); await app.submit();
  assert.equal(app.uploads.length, 0); assert.equal(app.insertions.length, 0); assert.match(app.status(), /same manager account/);
});

test('retrying after an account change cannot upload the remaining paper or insert metadata', async () => {
  let account = manager, attempts = 0;
  const app = harness({getUser:async () => ({data:{user:{id:account}},error:null}), upload:async () => ++attempts === 2 ? {error:{message:'Try again'}} : {error:null}});
  await settle(); await app.submit(); account = uuid(9);
  await app.byText('Retry saving pair').click();
  assert.equal(app.uploads.length, 2); assert.equal(app.insertions.length, 0);
  assert.match(app.status(), /same manager account/); assert.equal(app.byTag('fieldset').disabled, true);
});

test('complete pairs are grouped by pair version with separate downloads and shared source records', async () => {
  const app = harness({rows:[...pair(2), ...pair(1)]}); await settle();
  assert.equal(app.container.all(node => node.tagName === 'article').length, 1);
  assert.match(app.container.textContent, /Older versions \(1\)/); assert.match(app.container.textContent, /Version 2.*Latest/);
  assert.equal(app.container.all(node => node.tagName === 'button' && /Paper 1/.test(node.textContent)).length, 2);
  assert.equal(app.container.all(node => node.tagName === 'button' && /Paper 2/.test(node.textContent)).length, 2);
  const controls = app.container.all(node => node.tagName === 'button' && /Paper [12]/.test(node.textContent));
  await controls[0].click(); await controls[1].click();
  assert.deepEqual(new Set(app.downloads), new Set(pair(2).map(item => item.object_path)));
  await app.byText('Download source record').click();
  const record = JSON.parse(await app.urls.at(-1).blob.text());
  assert.equal(record.versions.length, 4); assert.equal(record.bucket, 'tmua-pdfs');
  assert.equal(record.versions[0].pair_id, pair(2)[0].pair_id);
  assert.equal(record.versions[0].paper_number, 1); app.destroy();
});

test('orphaned pair rows are not presented as a complete pair version', async () => {
  const app = harness({rows:[pair(2)[0], ...pair(1)]}); await settle();
  assert.doesNotMatch(app.container.textContent, /Version 2|Older versions/);
  assert.equal(app.container.all(node => node.tagName === 'button' && /Paper [12]/.test(node.textContent)).length, 2);
});

test('legacy documents stay safely downloadable but are unavailable for new pair versions', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const app = harness({rows:[row(2,{title:unsafe}), row(1), row(3,{object_path:'../other.pdf'})]}); await settle();
  assert.equal(app.container.all(node => node.tagName === 'article').length, 1);
  assert.match(app.container.textContent, /Older versions \(1\)/);
  assert.match(app.container.textContent, /Version 2Latest/); assert.match(app.container.textContent, /2 Sept 2026/);
  assert.equal(app.container.find(node => node.tagName === 'h5').textContent, unsafe);
  assert.equal(app.container.all(node => node.tagName === 'img').length, 0);
  assert.equal(app.bySuffix('document').children.some(option => option.value === 'notes'), false);
  assert.equal(app.urls.length, 0); assert.equal(app.downloads.length, 0);
  await app.byText('Download source record').click();
  const record = JSON.parse(await app.urls[0].blob.text());
  assert.equal(record.versions.length, 2); assert.equal(record.bucket, 'tmua-pdfs');
  assert.equal(record.versions[0].object_path, `${uuid(2)}.pdf`);
  assert.doesNotMatch(await app.urls[0].blob.text(), /signedUrl|access_token/); app.destroy();
});

test('private legacy download uses the authenticated SDK and revokes temporary URLs on disposal', async () => {
  const app = harness({rows:[row(1)]}); await settle();
  await app.byText('Download PDF').click();
  assert.deepEqual(app.downloads, [`${uuid(1)}.pdf`]); assert.equal(app.urls.length, 1);
  assert.match(app.status(), /Download started/); app.destroy();
  assert.equal(app.container.children.length, 0); assert.deepEqual(app.revoked, ['blob:private-0']); assert.equal(app.timers.size, 0);
});

test('download failures restore the download control', async () => {
  const app = harness({rows:[row(1)], download:async () => ({error:{message:'Sign-in expired'}})}); await settle();
  const control = app.byText('Download PDF'); await control.click();
  assert.equal(control.disabled, false); assert.match(app.status(), /Sign-in expired/); assert.equal(app.urls.length, 0);
});

test('disposal during a pending list cannot restore private data', async () => {
  const request = deferred(); const app = harness({list:() => request.promise});
  app.destroy(); request.resolve({data:pair(1),error:null}); await settle();
  assert.equal(app.container.children.length, 0); assert.equal(app.statuses.length, 1);
});

test('disposal during download prevents a late browser download', async () => {
  const request = deferred(); const app = harness({rows:[row(1)],download:() => request.promise}); await settle();
  const done = app.byText('Download PDF').click(); app.destroy(); request.resolve({data:pdf(),error:null}); await done;
  assert.equal(app.urls.length, 0); assert.equal(app.container.children.length, 0);
});

test('disposal during Paper 1 upload prevents Paper 2 and metadata work', async () => {
  const request = deferred(), started = deferred();
  const app = harness({upload:() => {started.resolve(); return request.promise;}}); await settle();
  const done = app.submit(); await started.promise; const statusCount = app.statuses.length;
  app.destroy(); request.resolve({error:null}); await done;
  assert.equal(app.uploads.length, 1); assert.equal(app.insertions.length, 0);
  assert.equal(app.statuses.length, statusCount); assert.equal(app.container.children.length, 0);
});

test('disposal during Paper 2 upload prevents metadata work', async () => {
  const request = deferred(), started = deferred(); let uploads = 0;
  const app = harness({upload:async () => {if (++uploads === 2) {started.resolve(); return request.promise;} return {error:null};}}); await settle();
  const done = app.submit(); await started.promise; const statusCount = app.statuses.length;
  app.destroy(); request.resolve({error:null}); await done;
  assert.equal(app.insertions.length, 0); assert.equal(app.statuses.length, statusCount); assert.equal(app.container.children.length, 0);
});

test('listing paginates without dropping older legacy versions', async () => {
  const rows = Array.from({length:501}, (_,index) => row(1,{id:uuid(index + 1),object_path:`${uuid(index + 1)}.pdf`}));
  const app = harness({rows}); await settle();
  assert.deepEqual(app.ranges, [[0,499],[500,999]]); assert.match(app.container.textContent, /Older versions \(500\)/);
});

test('paired versions stay complete when the two papers straddle pagination boundaries', async () => {
  const rows = Array.from({length:251}, (_,index) => pair(index + 1, {created_at:'2026-09-01T12:00:00Z'})).flat();
  const boundary = rows.splice(498, 2); rows.splice(499, 0, boundary[0]); rows.push(boundary[1]);
  const app = harness({rows}); await settle();
  assert.deepEqual(app.ranges, [[0,499],[500,999]]); assert.match(app.container.textContent, /Older versions \(250\)/);
  assert.equal(app.container.all(node => node.tagName === 'button' && /Paper [12]/.test(node.textContent)).length, 502);
});
