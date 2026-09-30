import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';

const require = createRequire(import.meta.url);
let chromium, browser;
try { ({chromium} = require(process.env.TMUA_PLAYWRIGHT_PATH || 'playwright')); } catch (_) {}
before(async () => { if (chromium) browser = await chromium.launch({headless:true}); });
after(async () => { await browser?.close(); });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = value => JSON.parse(JSON.stringify(value));
const empty = () => ({version:1,library:{},history:{version:1,attempts:[]},roadmap:{version:1,pairs:{}}});
const student = '10000000-0000-4000-8000-000000000001';
const manager = '10000000-0000-4000-8000-000000000002';
const otherStudent = '10000000-0000-4000-8000-000000000004';
const unknown = '10000000-0000-4000-8000-000000000003';
const attempt = (id, firstCorrect = 7, afterCorrect = 17) => ({id,paperId:'sample',title:'Sample paper',paper:1,total:20,firstCorrect,afterCorrect,completedAt:'2026-09-01T12:00:00Z',source:'guided',attemptContext:'first'});
const progress = (...attempts) => ({...empty(),history:{version:1,attempts}});
const keys = {library:'tmua-practice-library-v1:/study/',history:'tmua-attempt-history-v1:/study/',roadmap:'tmua-paired-roadmap-v1:/study/'};
const pendingKey = id => `tmua-cloud-pending-v2:tmuaexample.supabase.co:${id}`;
const cacheKey = id => `tmua-cloud-cache-v2:tmuaexample.supabase.co:${id}`;
const archiveKey = 'tmua-legacy-device-v1:tmuaexample.supabase.co:/study/';

// This is only the SDK-shaped transport adapter. The application, sync
// controller, file manager and progress views all run their real browser code.
const sdkStub = `(${function () {
  const config = window.__testCloudConfig;
  let session = config.userId ? {user:{id:config.userId}} : null;
  const listeners = [];
  window.__testChangeSession = id => {session=id?{user:{id}}:null;listeners.forEach(callback=>callback(id?'SIGNED_IN':'SIGNED_OUT',session));};
  window.supabase = {createClient(url,key,options) {
    window.__testClientConfig = {url,key,options};
    return {
      auth:{
        async getSession(){return {data:{session},error:null};},
        async getUser(){return {data:{user:session?.user || null},error:null};},
        onAuthStateChange(callback){listeners.push(callback);return {data:{subscription:{unsubscribe(){}}}};},
        async signInWithPassword(credentials){
          window.__testSignIn = {email:credentials.email,passwordLength:credentials.password.length};
          if(config.rejectLogin)return {data:{session:null},error:{message:'INVALID PASSWORD SECRET'}};
          session={user:{id:config.signInId}};
          listeners.forEach(callback=>callback('SIGNED_IN',session));
          return {data:{session},error:null};
        },
        async signOut(){session=null;listeners.forEach(callback=>callback('SIGNED_OUT',null));return {error:null};}
      },
      from(table){
        const request={table,filters:[]};
        const query={
          select(columns){request.columns=columns;return query;},
          eq(column,value){request.filters.push([column,value]);return query;},
          order(){return query;},
          single(){return window.__tmuaTestTransport({...request,userId:session?.user.id,operation:'single'});},
          maybeSingle(){return window.__tmuaTestTransport({...request,userId:session?.user.id,operation:'maybeSingle'});},
          range(start,end){return window.__tmuaTestTransport({...request,userId:session?.user.id,operation:'range',start,end});},
          insert(value){return window.__tmuaTestTransport({...request,userId:session?.user.id,operation:'insert',value});}
        };return query;
      },
      rpc(name,args){return window.__tmuaTestTransport({operation:'rpc',name,args,userId:session?.user.id});},
      storage:{from(){return {upload(){throw Error('Unexpected PDF upload');},download(){throw Error('Unexpected PDF download');}}}}
    };
  }};
}})();`;

function backend(payload = empty(), revision = 0, owner = student) {
  const row = (id, value = empty(), rev = 0) => ({user_id:id,revision:rev,payload:clone(value),updated_at:'2026-09-01T12:00:00Z'});
  const state = {rows:{[owner]:row(owner,payload,revision)},calls:[],backups:[],backupOwners:[],failWrites:false,failReads:false,
    members:{[student]:'student',[otherStudent]:'student',[manager]:'manager'},pdfRows:[],legacy:progress(attempt('legacy-shared',11,19))};
  Object.defineProperty(state,'row',{get:()=>state.rows[owner],set:value=>{state.rows[owner]={user_id:owner,...value};}});
  state.transport = async request => {
    state.calls.push(clone(request));
    // userId is captured inside the SDK adapter from the auth session. Neither
    // table filters nor RPC arguments can select another user's progress.
    const id=request.userId,member=state.members[id];
    if (request.table === 'tmua_members') {
      assert.equal(request.filters.find(([column]) => column === 'user_id')?.[1],id);
      return {data:member ? {role:member} : null,error:null};
    }
    assert.ok(member,'private data requires an authenticated member');
    if (request.table === 'tmua_pdf_versions' && request.operation === 'range') {
      assert.equal(member,'manager');
      return {data:clone(state.pdfRows.slice(request.start,request.end + 1)),error:null};
    }
    assert.equal(request.operation,'rpc','progress must use only the v2 RPC boundary');
    assert.ok(['tmua_read_state_v2','tmua_write_state_v2','tmua_save_backup_v2','tmua_read_legacy_state_v2'].includes(request.name),`Unexpected RPC ${request.name}`);
    if(request.name==='tmua_read_legacy_state_v2') {
      assert.equal(member,'manager');assert.deepEqual(request.args ?? {},{});
      return {data:clone(state.legacy),error:null};
    }
    if(request.name==='tmua_read_state_v2') {
      assert.deepEqual(request.args ?? {},{});
      if(state.failReads)return {data:null,error:state.readError || {message:'PRIVATE BACKEND ERROR'}};
      state.rows[id] ??= row(id);
      return {data:clone(state.rows[id]),error:null};
    }
    if (request.name === 'tmua_save_backup_v2') {
      assert.deepEqual(Object.keys(request.args),['new_payload']);
      if(state.beforeBackup)await state.beforeBackup(request.args.new_payload);
      state.backups.push(clone(request.args.new_payload));state.backupOwners.push(id);
      return {data:`backup-${state.backups.length}`,error:null};
    }
    assert.deepEqual(Object.keys(request.args).sort(),['expected_revision','new_payload']);
    if (state.failWrites) return {data:null,error:{message:'PRIVATE WRITE ERROR'}};
    state.rows[id] ??= row(id);
    if (request.args.expected_revision !== state.rows[id].revision) return {data:null,error:{code:'40001'}};
    state.rows[id]=row(id,request.args.new_payload,state.rows[id].revision+1);
    return {data:clone(state.rows[id]),error:null};
  };
  return state;
}

async function device(t, server, {local = empty(), userId = student, signInId = student, rejectLogin = false, cache = null,
  sharedContext = null, seed = true, pending = null, rawOverrides = {}, blockedWriteKeys = [], papers = []} = {}) {
  const context = sharedContext || await browser.newContext({viewport:{width:1000,height:900}});
  if(!sharedContext)t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__tmuaTestTransport', server.transport);
  await page.addInitScript(({local,userId,signInId,rejectLogin,cache,keys,seed,pending,rawOverrides,blockedWriteKeys}) => {
    window.__testCloudConfig={userId,signInId,rejectLogin};
    window.__testApplied=[];window.__testPersistence=[];
    document.addEventListener('tmua-cloud-applied',event=>{window.__testApplied.push(event.detail.payload);window.__testPersistence.push(event.detail.persistence);});
    if (window.top === window && seed && !sessionStorage.getItem('tmua-browser-test-seeded')) {
      Object.entries(keys).forEach(([kind,key])=>localStorage.setItem(key,JSON.stringify(local[kind])));
      if(cache)localStorage.setItem(`tmua-cloud-cache-v2:tmuaexample.supabase.co:${userId}`,JSON.stringify(cache));
      if(pending)localStorage.setItem(`tmua-cloud-pending-v2:tmuaexample.supabase.co:${userId}`,JSON.stringify(pending));
      Object.entries(rawOverrides).forEach(([key,value])=>localStorage.setItem(key,value));
      sessionStorage.setItem('tmua-browser-test-seeded','1');
    }
    if(window.top === window && blockedWriteKeys.length){
      const setItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        if(blockedWriteKeys.includes(key))throw new DOMException('Simulated quota failure for selected key','QuotaExceededError');
        return setItem.call(this,key,value);
      };
    }
  }, {local,userId,signInId,rejectLogin,cache,keys,seed,pending,rawOverrides,blockedWriteKeys});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://account.test') {unexpectedRequests.push(url.href);return route.abort();}
    const file = url.pathname.replace(/^\/study\//, '') || 'index.html';
    if(file === 'assets/cloud-config.js')return route.fulfill({contentType:'text/javascript',body:"window.TMUA_CLOUD_CONFIG={enabled:true,url:'https://tmuaexample.supabase.co',publishableKey:'sb_publishable_browser_test_only'};"});
    if(file === 'assets/vendor/supabase-2.117.2.js')return route.fulfill({contentType:'text/javascript',body:sdkStub});
    if(file === 'papers/catalog.json')return route.fulfill({contentType:'application/json',body:JSON.stringify({papers})});
    if(file === 'papers/paper-1/sample.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Mock paper transport</title><p>Guided paper test fixture</p>'});
    if (!/^(?:index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(file)) {unexpectedRequests.push(url.href);return route.abort();}
    try {
      const body=await readFile(path.join(root,file));
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html',body});
    } catch (_) {return route.fulfill({status:404,body:'Not found'});}
  });
  await page.goto('https://account.test/study/');
  return {page,context,errors,unexpectedRequests,async saved(){await page.waitForFunction(()=>document.getElementById('cloud-status')?.textContent==='Saved across your devices');},
    async local(){return page.evaluate(keys=>Object.fromEntries(Object.entries(keys).map(([kind,key])=>[kind,JSON.parse(localStorage.getItem(key))])),keys);},
    async signIn(id) {await page.evaluate(id=>{window.__testCloudConfig.signInId=id;},id);await page.locator('#cloud-email').fill('learner@example.test');await page.locator('#cloud-password').fill('test-only-password');await page.locator('#cloud-login-submit').click();},
    async signOut() {await page.locator('#cloud-signout').click();await page.locator('#cloud-login').waitFor({state:'visible'});},
    async stored(key) {return page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);},
    async history(attempts) {await page.evaluate(({attempts,key})=>{localStorage.setItem(key,JSON.stringify({version:1,attempts}));document.dispatchEvent(new CustomEvent('tmua-history-updated',{detail:{attempts,persisted:true}}));},{attempts,key:keys.history});}
  };
}

test('browser: signed-out and rejected sign-in states archive legacy practice and hide manager controls', {skip:!chromium}, async t => {
  const original=progress(attempt('old',0,12)), server=backend();
  const app=await device(t,server,{userId:null,rejectLogin:true,local:original});
  await app.page.locator('#cloud-login').waitFor({state:'visible'});
  assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),true);
  assert.equal(await app.page.locator('#cloud-files-toggle').isVisible(),false);
  await app.page.locator('#cloud-email').fill('learner@example.test'); await app.page.locator('#cloud-password').fill('test-only-password');
  await app.page.locator('#cloud-login-submit').click();
  await app.page.waitForFunction(()=>document.getElementById('cloud-login-message').textContent.includes('Sign-in failed'));
  assert.equal(await app.page.locator('#cloud-password').inputValue(),'');
  assert.equal(await app.page.locator('#cloud-login-submit').isEnabled(),true);
  assert.deepEqual((await app.local()).history,empty().history);
  assert.equal((await app.stored(archiveKey)).values[keys.history],JSON.stringify(original.history));assert.equal(server.calls.length,0);
  assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);
});

test('browser: an account without membership cannot load progress or private PDFs', {skip:!chromium}, async t => {
  const server=backend(),app=await device(t,server,{userId:null,signInId:unknown});
  await app.page.locator('#cloud-login').waitFor({state:'visible'});
  await app.page.locator('#cloud-email').fill('unknown@example.test');await app.page.locator('#cloud-password').fill('test-only-password');
  await app.page.locator('#cloud-login-submit').click();
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('not been added'));
  assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),true);
  assert.equal(await app.page.locator('#cloud-files-toggle').isVisible(),false);
  assert.equal(await app.page.locator('#cloud-files-area').innerHTML(),'');
  assert.equal(server.calls.every(call=>call.table==='tmua_members'),true); assert.deepEqual(app.errors,[]);
});

test('browser: an old shared device snapshot and v1 pending record are archived without assigning them to a new account', {skip:!chromium}, async t => {
  const initial=progress(attempt('earlier-shared',0,15));
  initial.library.sample={version:1,state:{attemptId:'earlier-shared',answers:[{firstCorrect:false}]},view:{mode:'pearson',flags:[1]}};
  initial.roadmap.pairs.sample={p1:{score:7,context:'first',completedAt:'2026-09-01T12:00:00Z'}};
  const oldPendingKey=`tmua-cloud-pending-v1:tmuaexample.supabase.co:${student}`;
  const oldPending=JSON.stringify({version:1,revision:0,payload:initial});
  const server=backend(),app=await device(t,server,{local:initial,rawOverrides:{[oldPendingKey]:oldPending}});await app.saved();
  assert.deepEqual(server.row.payload,empty());assert.equal(server.row.revision,0);
  assert.deepEqual(await app.local(),{library:{},history:empty().history,roadmap:empty().roadmap});
  const archive=await app.stored(archiveKey);
  for(const [kind,key] of Object.entries(keys))assert.equal(archive.values[key],JSON.stringify(initial[kind]));
  assert.equal(await app.page.evaluate(key=>localStorage.getItem(key),oldPendingKey),oldPending);
  assert.equal(server.calls.some(call=>call.name==='tmua_write_state_v2'),false);
  assert.equal(server.calls.some(call=>call.name==='tmua_read_legacy_state_v2'),false);
  assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),false);
  assert.equal(await app.page.locator('#cloud-files-toggle').isVisible(),false);
  assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);
});

test('browser: a manager sees private PDFs and sign-out clears that UI while preserving offline changes', {skip:!chromium}, async t => {
  const server=backend(empty(),0,manager);server.pdfRows=[{id:'30000000-0000-4000-8000-000000000001',document_key:'notes',title:'Private revision notes',filename:'notes.pdf',object_path:'30000000-0000-4000-8000-000000000001.pdf',sha256:'a'.repeat(64),bytes:100,created_by:manager,created_at:'2026-09-01T12:00:00Z'}];
  const app=await device(t,server,{userId:manager});await app.saved();
  await app.page.locator('#cloud-files-toggle').click();
  await app.page.getByRole('heading',{name:'Private revision notes'}).waitFor();
  server.failWrites=true;
  const revised=[attempt('offline-attempt',3,13)];await app.history(revised);
  await app.page.locator('#cloud-signout').click();
  await app.page.locator('#cloud-login').waitFor({state:'visible'});
  assert.equal(await app.page.locator('#cloud-files-area').innerHTML(),'');
  assert.equal(await app.page.locator('#cloud-files-toggle').isVisible(),false);
  assert.deepEqual((await app.local()).history.attempts,[]);
  assert.deepEqual((await app.stored(cacheKey(manager))).history.attempts,revised);
  const pending=await app.page.evaluate(key=>JSON.parse(localStorage.getItem(key)),pendingKey(manager));
  assert.deepEqual(pending.payload.history.attempts,revised);
  assert.deepEqual(server.row.payload.history.attempts,[]);
  assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);
});

test('browser: another device receives a complete remote snapshot and updates the score history', {skip:!chromium}, async t => {
  const server=backend(),first=await device(t,server),second=await device(t,server);
  await first.saved();await second.saved();
  const changed=[attempt('remote-new',6,18)];await first.history(changed);await first.saved();
  await second.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await second.page.waitForFunction(()=>window.__testApplied.length>0);
  await second.saved();
  assert.deepEqual((await second.local()).history.attempts,changed);
  assert.match(await second.page.locator('#history-panel-1').innerText(),/6 correct out of 20/);
  const applied=await second.page.evaluate(()=>window.__testApplied.at(-1));assert.deepEqual(applied,server.row.payload);
  assert.equal(await second.page.locator('#main').evaluate(node=>node.inert),false);
  assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
});

test('browser: conflicting first scores cannot merge and choosing remote preserves the local backup', {skip:!chromium}, async t => {
  const local=progress(attempt('same-attempt',0,19)),remote=progress(attempt('same-attempt',12,18));
  const server=backend(remote,4),app=await device(t,server,{cache:local,pending:{version:1,revision:0,payload:local}});
  await app.page.locator('#cloud-conflict').waitFor({state:'visible'});
  assert.equal(await app.page.locator('#cloud-merge').isVisible(),false);
  assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),true);
  await app.page.locator('#cloud-use-remote').click();await app.saved();
  assert.deepEqual(server.backups,[local]);assert.deepEqual(server.row.payload,remote);
  assert.deepEqual((await app.local()).history,remote.history);
  assert.equal((await app.local()).history.attempts[0].firstCorrect,12);
  assert.equal(server.backups[0].history.attempts[0].firstCorrect,0);
  assert.deepEqual(app.errors,[]);
});

test('browser: choosing this device preserves its first score and backs up the other copy', {skip:!chromium}, async t => {
  const local=progress(attempt('same-attempt',2,15)),remote=progress(attempt('same-attempt',18,20));
  const server=backend(remote,8),app=await device(t,server,{cache:local,pending:{version:1,revision:0,payload:local}});
  await app.page.locator('#cloud-conflict').waitFor({state:'visible'});
  await app.page.locator('#cloud-use-local').click();await app.saved();
  assert.deepEqual(server.backups,[remote]);assert.deepEqual(server.row.payload,local);
  assert.equal(server.row.payload.history.attempts[0].firstCorrect,2);
  assert.equal(server.backups[0].history.attempts[0].firstCorrect,18);assert.deepEqual(app.errors,[]);
});

test('browser: combining separate attempts preserves each first score and backs up both copies', {skip:!chromium}, async t => {
  const local=progress(attempt('local-attempt',3,19)),remote=progress(attempt('remote-attempt',16,18));
  const server=backend(remote,2),app=await device(t,server,{cache:local,pending:{version:1,revision:0,payload:local}});
  await app.page.locator('#cloud-conflict').waitFor({state:'visible'});
  await app.page.locator('#cloud-merge').click();await app.saved();
  assert.deepEqual(server.backups,[remote,local]);
  assert.deepEqual(server.row.payload.history.attempts.map(item=>[item.id,item.firstCorrect]),[['remote-attempt',16],['local-attempt',3]]);
  assert.deepEqual((await app.local()).history,server.row.payload.history);assert.deepEqual(app.errors,[]);
});

test('browser: history downloaded from another device survives a selected storage failure and a new finished paper', {skip:!chromium}, async t => {
  const remote=progress(attempt('downloaded-attempt',4,16));
  remote.roadmap.pairs.remote={papers:{1:{score:4,context:'first',afterCorrect:16}},reviewed:false};
  const server=backend(remote,3);
  const papers=[{format:'tmua-paper-v1',id:'sample',title:'Sample paper',paper:1,source:'Test fixture',description:'A one-question test paper.',questionCount:1,version:1,href:'papers/paper-1/sample.html'}];
  const app=await device(t,server,{blockedWriteKeys:[keys.history],papers});await app.saved();
  assert.deepEqual((await app.local()).history.attempts,[],'failed history write leaves the older browser value intact');
  assert.deepEqual((await app.local()).roadmap,remote.roadmap,'other storage keys still work');
  assert.deepEqual(await app.page.evaluate(()=>window.__testPersistence.at(-1)),{library:true,history:false,roadmap:true});
  assert.match(await app.page.locator('#history-panel-1').innerText(),/4 correct out of 20/);
  await app.page.evaluate(()=>location.hash='paper/sample');
  const iframe=await app.page.locator('#paper-frame').elementHandle();
  await app.page.waitForFunction(()=>document.getElementById('paper-frame').getAttribute('src')?.includes('sample.html'));
  const frame=await iframe.contentFrame();await frame.waitForLoadState();
  await frame.evaluate(()=>parent.postMessage({type:'tmua-progress',paperId:'sample',
    state:{attemptId:'fresh-attempt-001',answers:[{firstCorrect:false}]},
    progress:{questionIndex:0,completed:1,total:1,firstCorrect:0,firstAttempted:1,practiceCorrect:1,practiceAttempted:1,finished:true,
      attemptId:'fresh-attempt-001',startedAt:'2026-09-20T12:00:00Z',afterKnown:true,afterCorrect:1}},'*'));
  await app.page.waitForFunction(()=>document.getElementById('player-progress').textContent==='Attempt 2 · Paper complete');
  await app.saved();
  assert.deepEqual(server.row.payload.history.attempts.map(item=>[item.id,item.firstCorrect,item.afterCorrect]),[
    ['downloaded-attempt',4,16],['guided:sample:fresh-attempt-001',0,1]
  ]);
  assert.equal(server.row.payload.history.attempts[1].attemptNumber,2,'new work follows the downloaded attempt number even when the history storage key is unwritable');
  assert.deepEqual(server.row.payload.roadmap,remote.roadmap);
  assert.deepEqual((await app.local()).history.attempts,[],'the test really kept the history key unwritable');
  assert.equal((await app.local()).library.sample.progress.firstCorrect,0);
  assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);
});

test('browser: failure to persist the account pending record warns that this tab must stay open', {skip:!chromium}, async t => {
  const server=backend(),app=await device(t,server,{blockedWriteKeys:[pendingKey(student)]});await app.saved();
  server.failWrites=true;
  await app.history([attempt('unsaved-pending-record',5,15)]);
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('Keep this tab open'));
  await app.page.locator('#cloud-retry').click();
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('Keep this tab open'));
  assert.equal(await app.page.evaluate(key=>localStorage.getItem(key),pendingKey(student)),null);
  assert.equal((await app.local()).history.attempts[0].firstCorrect,5);
  assert.deepEqual(server.row.payload.history.attempts,[]);assert.deepEqual(app.errors,[]);
});

test('browser: only one tab in a browser can practise and another can connect after it closes', {skip:!chromium}, async t => {
  const server=backend(progress(attempt('shared-browser-attempt',8,17)),2);
  const first=await device(t,server);await first.saved();
  const callsBefore=server.calls.length;
  const second=await device(t,server,{sharedContext:first.context,seed:false});
  await second.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('already open in another tab'));
  assert.equal(await second.page.locator('#main').evaluate(node=>node.inert),true);
  assert.equal(await second.page.locator('#cloud-retry').innerText(),'Connect here');
  assert.equal(server.calls.length,callsBefore,'the blocked tab must not read or write cloud progress');
  await first.page.close();
  await second.page.locator('#cloud-retry').click();await second.saved();
  assert.equal(await second.page.locator('#main').evaluate(node=>node.inert),false);
  assert.deepEqual((await second.local()).history,server.row.payload.history);
  assert.equal(server.row.revision,2);assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
});

test('browser: a different local snapshot is backed up before pending work replaces it', {skip:!chromium}, async t => {
  const present=progress(attempt('present-local',9,18)),pending=progress(attempt('pending-local',1,12));
  const server=backend(empty(),5);
  let enteredBackup,releaseBackup;
  const entered=new Promise(resolve=>{enteredBackup=resolve;});
  const release=new Promise(resolve=>{releaseBackup=resolve;});
  server.beforeBackup=async payload=>{assert.deepEqual(payload,present);enteredBackup();await release;};
  const app=await device(t,server,{cache:present,pending:{version:1,revision:5,payload:pending}});
  await entered;
  assert.deepEqual((await app.stored(cacheKey(student))).history,present.history,'account cache stays intact while backup is unconfirmed');
  assert.deepEqual((await app.local()).history,empty().history,'the view stays empty until ownership and recovery are confirmed');
  assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),true);
  releaseBackup();await app.saved();
  assert.deepEqual(server.backups,[present]);assert.deepEqual(server.row.payload,pending);
  assert.deepEqual((await app.local()).history,pending.history);
  assert.equal(server.calls.find(call=>call.operation==='rpc').name,'tmua_save_backup_v2');
  assert.deepEqual(app.errors,[]);
});

test('browser: malformed legacy browser progress is preserved without blocking an owner account', {skip:!chromium}, async t => {
  for(const raw of ['{broken-json',JSON.stringify({version:9,attempts:[]})]){
    const remote=progress(attempt('remote-owner',12,18)),server=backend(remote,4);
    const app=await device(t,server,{rawOverrides:{[keys.history]:raw}});await app.saved();
    assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),false);
    assert.equal((await app.stored(archiveKey)).values[keys.history],raw);
    assert.deepEqual((await app.local()).history,remote.history);
    assert.equal(server.row.revision,4);
    assert.equal(server.calls.some(call=>call.name==='tmua_write_state_v2'),false);
    assert.deepEqual(app.errors,[]);
  }
});

test('browser: pagehide preserves pending work and a persisted pageshow reloads before reacquiring the tab lock', {skip:!chromium}, async t => {
  const server=backend(empty(),0,manager),first=await device(t,server,{userId:manager});await first.saved();
  const pendingAttempts=[attempt('before-pagehide',2,15)];
  server.failWrites=true;
  await first.history(pendingAttempts);
  const pendingBefore=await first.page.evaluate(key=>JSON.parse(localStorage.getItem(key)),pendingKey(manager));
  assert.deepEqual(pendingBefore.payload.history.attempts,pendingAttempts);
  // Chromium's test launcher disables BFCache; dispatch the real lifecycle
  // event types to exercise our handlers with native Web Locks and a real reload.
  await first.page.evaluate(()=>{
    window.__beforeRestoreSentinel=true;
    window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
  });
  assert.equal(await first.page.locator('#main').evaluate(node=>node.inert),true);
  assert.equal(await first.page.locator('#cloud-files-area').innerHTML(),'');
  assert.deepEqual(await first.page.evaluate(key=>JSON.parse(localStorage.getItem(key)),pendingKey(manager)),pendingBefore);
  await first.page.waitForFunction(async()=>!(await navigator.locks.query()).held.some(lock=>lock.name==='tmua-practice-active:tmuaexample.supabase.co'));
  const callsAfterHide=server.calls.length;
  await first.page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});
  assert.equal(server.calls.length,callsAfterHide,'a hidden old controller cannot refresh or resume syncing');
  server.failWrites=false;
  const second=await device(t,server,{sharedContext:first.context,seed:false,userId:manager});await second.saved();
  assert.deepEqual(server.row.payload.history.attempts,pendingAttempts,'the next lock holder recovers the pending work');
  assert.equal(await first.page.locator('#main').evaluate(node=>node.inert),true);
  const reloaded=first.page.waitForNavigation({waitUntil:'load'});
  await first.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await reloaded;
  await first.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('already open in another tab'));
  assert.equal(await first.page.evaluate(()=>window.__beforeRestoreSentinel),undefined,'the cached JavaScript context was replaced');
  assert.equal(await first.page.evaluate(()=>performance.getEntriesByType('navigation')[0].type),'reload');
  assert.equal(await first.page.locator('#main').evaluate(node=>node.inert),true,'restoration cannot bypass the second tab lock');
  await second.page.close();
  await first.page.locator('#cloud-retry').click();await first.saved();
  assert.deepEqual((await first.local()).history.attempts,pendingAttempts);
  assert.equal(server.row.revision,1,'recovery did not duplicate or replace the saved attempt');
  assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
});

test('browser: switching accounts in one browser clears every view and never uploads the previous account', {skip:!chromium}, async t => {
  const first=progress(attempt('student-a',2,13)),second=progress(attempt('student-b',18,20));
  first.library.a={state:{attemptId:'student-a'}};first.roadmap.pairs.a={reviewed:true};
  second.library.b={state:{attemptId:'student-b'}};second.roadmap.pairs.b={reviewed:false};
  const server=backend(first,3);
  server.rows[otherStudent]={user_id:otherStudent,revision:7,payload:second,updated_at:'2026-09-01T12:00:00Z'};
  const app=await device(t,server);await app.saved();
  assert.deepEqual((await app.local()).history,first.history);
  await app.signOut();
  assert.deepEqual(await app.local(),{library:{},history:empty().history,roadmap:empty().roadmap});
  assert.doesNotMatch(await app.page.locator('#history-panel-1').innerText(),/2 correct out of 20/);
  assert.deepEqual(await app.stored(cacheKey(student)),first);
  await app.signIn(otherStudent);await app.saved();
  assert.deepEqual(await app.local(),{library:second.library,history:second.history,roadmap:second.roadmap});
  assert.match(await app.page.locator('#history-panel-1').innerText(),/18 correct out of 20/);
  assert.doesNotMatch(await app.page.locator('#history-panel-1').innerText(),/2 correct out of 20/);
  assert.deepEqual(server.rows[student].payload,first);assert.deepEqual(server.rows[otherStudent].payload,second);
  assert.equal(server.calls.some(call=>call.name==='tmua_write_state_v2'),false);
  await app.signOut();await app.signIn(student);await app.saved();
  assert.deepEqual((await app.local()).history,first.history);
  assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);
});

test('browser: two independent users each synchronize only their own progress across devices', {skip:!chromium}, async t => {
  const server=backend();
  const a1=await device(t,server),a2=await device(t,server);
  const b1=await device(t,server,{userId:otherStudent}),b2=await device(t,server,{userId:otherStudent});
  await Promise.all([a1.saved(),a2.saved(),b1.saved(),b2.saved()]);
  const ownA=[attempt('account-a-only',3,13)],ownB=[attempt('account-b-only',17,19)];
  await a1.history(ownA);await b1.history(ownB);await Promise.all([a1.saved(),b1.saved()]);
  await a2.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await b2.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await a2.page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).attempts[0]?.id==='account-a-only',keys.history);
  await b2.page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).attempts[0]?.id==='account-b-only',keys.history);
  await Promise.all([a2.saved(),b2.saved()]);
  assert.deepEqual((await a2.local()).history.attempts,ownA);assert.deepEqual((await b2.local()).history.attempts,ownB);
  assert.deepEqual(server.rows[student].payload.history.attempts,ownA);assert.deepEqual(server.rows[otherStudent].payload.history.attempts,ownB);
  assert.equal(server.rows[student].revision,1);assert.equal(server.rows[otherStudent].revision,1);
  for(const app of [a1,a2,b1,b2]){assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);}
});

test('browser: offline pending changes survive an account switch and recover only for their owner', {skip:!chromium}, async t => {
  const server=backend(),app=await device(t,server);await app.saved();
  server.failWrites=true;
  const pendingAttempts=[attempt('owner-a-offline',1,14)];await app.history(pendingAttempts);
  await app.page.locator('#cloud-retry').click();
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('Not synced yet'));
  const pending=await app.stored(pendingKey(student));assert.deepEqual(pending.payload.history.attempts,pendingAttempts);
  await app.signOut();server.failWrites=false;
  await app.signIn(otherStudent);await app.saved();
  assert.deepEqual((await app.local()).history.attempts,[]);
  assert.deepEqual(server.rows[otherStudent].payload,empty());
  assert.deepEqual(await app.stored(pendingKey(student)),pending);
  assert.equal(await app.stored(pendingKey(otherStudent)),null);
  const secondAttempts=[attempt('owner-b-new',18,20)];await app.history(secondAttempts);await app.saved();
  await app.signOut();await app.signIn(student);await app.saved();
  assert.deepEqual((await app.local()).history.attempts,pendingAttempts);
  assert.deepEqual(server.rows[student].payload.history.attempts,pendingAttempts);
  assert.deepEqual(server.rows[otherStudent].payload.history.attempts,secondAttempts);
  assert.equal(await app.stored(pendingKey(student)),null);
  assert.deepEqual(app.errors,[]);assert.deepEqual(app.unexpectedRequests,[]);
});

test('browser: a failed cloud read displays only the signed-in owner cache', {skip:!chromium}, async t => {
  const owned=progress(attempt('owner-cached',4,16)),legacy=progress(attempt('unowned-browser',19,20));
  const server=backend();server.failReads=true;
  const app=await device(t,server,{cache:owned,local:legacy});
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('Not synced yet'));
  assert.deepEqual((await app.local()).history,owned.history);
  assert.deepEqual(await app.stored(cacheKey(student)),owned);
  assert.equal((await app.stored(archiveKey)).values[keys.history],JSON.stringify(legacy.history));
  await app.signOut();await app.signIn(otherStudent);
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('Not synced yet'));
  assert.deepEqual((await app.local()).history,empty().history);
  assert.deepEqual(await app.stored(cacheKey(student)),owned);
  assert.equal(server.calls.some(call=>call.name==='tmua_write_state_v2'),false);
  assert.deepEqual(app.errors,[]);
});


test('browser: an authentication switch cancels the former owner sync before another session can send it', {skip:!chromium}, async t => {
  const server=backend(),app=await device(t,server);await app.saved();
  const changed=[attempt('account-a-unsent',2,18)];await app.history(changed);
  await app.page.evaluate(id=>{
    window.__testChangeSession(id);
    window.dispatchEvent(new Event('online'));
  },otherStudent);
  await app.page.waitForFunction(key=>localStorage.getItem(key)!==null,cacheKey(otherStudent));
  await app.saved();
  assert.deepEqual(server.rows[otherStudent].payload,empty(),'queued former-owner work must never be sent using the new session');
  assert.deepEqual((await app.local()).history.attempts,[]);
  assert.deepEqual((await app.stored(pendingKey(student))).payload.history.attempts,changed);
  assert.equal(server.calls.filter(call=>call.name==='tmua_write_state_v2' && call.userId===otherStudent).length,0);
  assert.deepEqual(app.errors,[]);
});

test('browser: malformed owned cache and pending JSON stay intact and block recovery until checked', {skip:!chromium}, async t => {
  for(const key of [cacheKey(student),pendingKey(student)]){
    const raw='{broken-owned-json',server=backend(progress(attempt('remote',12,18)),4);
    const app=await device(t,server,{rawOverrides:{[key]:raw}});
    await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('checking'));
    assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),true);
    assert.equal(await app.page.evaluate(key=>localStorage.getItem(key),key),raw);
    assert.equal(server.calls.some(call=>call.name==='tmua_write_state_v2'),false);
    assert.equal(server.calls.some(call=>call.name==='tmua_read_state_v2'),false);
    assert.deepEqual(app.errors,[]);
  }
});

test('browser: an unapplied v2 database migration keeps practice locked without using the old shared API', {skip:!chromium}, async t => {
  const old=progress(attempt('old-shared',5,19)),server=backend();server.failReads=true;
  server.readError={code:'PGRST202',message:'Could not find the function public.tmua_read_state_v2'};
  const app=await device(t,server,{local:old});
  await app.page.waitForFunction(()=>document.getElementById('cloud-status').textContent.includes('Not synced yet'));
  assert.equal(await app.page.locator('#main').evaluate(node=>node.inert),true);
  assert.deepEqual((await app.local()).history,empty().history);
  assert.equal((await app.stored(archiveKey)).values[keys.history],JSON.stringify(old.history));
  assert.equal(server.calls.filter(call=>call.operation==='rpc').every(call=>call.name==='tmua_read_state_v2'),true);
  assert.equal(server.row.revision,0);assert.deepEqual(app.errors,[]);
});
