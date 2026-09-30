import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test,{before,after} from 'node:test';
import vm from 'node:vm';
import {buildSite,discoverPapers} from '../tools/build-site.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appSource=await readFile(path.join(root,'assets/app.js'),'utf8');
const hash=content=>createHash('sha256').update(content).digest('hex');
const paper={format:'tmua-paper-v1',id:'sample-p1',paper:1,title:'Sample Paper 1',source:'Test fixture',description:'Edition routing check',questionCount:20,version:1,href:'papers/paper-1/sample-p1.html',contentHash:'1111111111111111'};
const edition=id=>({id,href:`assets/editions/${id}/${paper.id}.html`,contentHash:id==='review-one'?'2222222222222222':'3333333333333333'});
const entry=()=>({...paper,editions:[edition('review-one'),edition('review-two')],currentEditionId:'review-two'});
const progress=(overrides={})=>({questionIndex:0,completed:0,total:20,firstCorrect:0,firstAttempted:1,practiceCorrect:0,practiceAttempted:0,finished:false,attemptId:'attempt-001',startedAt:'2026-09-30T10:00:00Z',afterKnown:true,afterCorrect:0,...overrides});
const record=(extra={})=>({version:1,state:{version:1,attemptId:'attempt-001',questionIndex:0},progress:progress(),updatedAt:'2026-09-30T11:00:00Z',...extra});
const libraryKey='tmua-practice-library-v1:/study/';
const historyKey='tmua-attempt-history-v1:/study/';
const html=(label='original',overrides={})=>`<!doctype html><script id="tmua-paper-meta" type="application/json">${JSON.stringify({...paper,...overrides})}</script><p id="edition">${label}</p>`;
async function put(dir,name,text){await mkdir(path.dirname(path.join(dir,name)),{recursive:true});await writeFile(path.join(dir,name),text);}
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tmua-edition-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));await put(dir,'index.html','<!doctype html><title>Test</title>');await put(dir,paper.href,html());return dir;}
async function editionFile(dir,id='review-one',overrides={}){const href=`assets/editions/${id}/${paper.id}.html`,body=html(id,overrides);await put(dir,href,body);return {editionId:id,paperId:paper.id,href,sha256:hash(body)};}
async function manifest(dir,editions){await put(dir,'content/paper-editions.json',JSON.stringify({version:1,editions}));}

test('build leaves original paper bytes/URL intact and makes the last verified edition the new-sitting default',async t=>{
  const dir=await fixture(t),first=await editionFile(dir),second=await editionFile(dir,'review-two');
  await manifest(dir,[first,second]);
  await put(dir,'content/published-papers.json',JSON.stringify({version:1,papers:[{id:paper.id,href:paper.href,sha256:hash(html())}]}));
  const {catalog,destination}=await buildSite(dir),found=catalog.papers[0];
  assert.equal(found.href,paper.href);assert.equal(found.contentHash,hash(html()).slice(0,16));assert.equal(found.currentEditionId,'review-two');
  assert.deepEqual(found.editions,[first,second].map(item=>({id:item.editionId,href:item.href,contentHash:item.sha256.slice(0,16)})));
  assert.equal(await readFile(path.join(destination,paper.href),'utf8'),html());
  for(const item of [first,second])assert.equal(hash(await readFile(path.join(destination,item.href))),item.sha256);
  assert.equal((await discoverPapers(dir)).catalog.papers.length,1);
});

test('manifest is optional and invalid edition files fail before changing an existing build',async t=>{
  const dir=await fixture(t);assert.equal((await buildSite(dir)).catalog.papers[0].editions,undefined);
  const good=await editionFile(dir);await manifest(dir,[good]);await buildSite(dir);
  const previous=await readFile(path.join(dir,'dist/papers/catalog.json'),'utf8');
  await put(dir,good.href,html('tampered'));
  await assert.rejects(buildSite(dir),/immutable SHA-256/);
  assert.equal(await readFile(path.join(dir,'dist/papers/catalog.json'),'utf8'),previous);
  await rm(path.join(dir,good.href));await assert.rejects(buildSite(dir),/ENOENT/);
});

test('the latest edition description appears in the student catalogue without rewriting the original metadata',async t=>{
  const dir=await fixture(t),first=await editionFile(dir);
  const description='Worked steps, progressive hints and up to three matching follow-up questions.';
  const second=await editionFile(dir,'review-two',{description});await manifest(dir,[first,second]);
  const {catalog}=await buildSite(dir);
  assert.equal(catalog.papers[0].description,description);
  assert.equal(catalog.papers[0].href,paper.href);
  assert.equal(await readFile(path.join(dir,paper.href),'utf8'),html());
});

test('manifest rejects duplicate pins, unrecognized papers, escaping paths and changed state metadata',async t=>{
  const dir=await fixture(t),good=await editionFile(dir);
  for(const rows of [[good,good],[{...good,paperId:'unknown',href:'assets/editions/review-one/unknown.html'}],
    [{...good,href:'assets/editions/review-one/../../outside.html'}],[{...good,href:'https://elsewhere.test/x.html'}],
    [{...good,href:'assets/editions/review-one/sample-p1.html?x=1'}],[{...good,editionId:'original'}]]){
    await manifest(dir,rows);await assert.rejects(buildSite(dir),/teaching edition|Teaching edition/);
  }
  for(const override of [{id:'other'},{paper:2},{questionCount:19},{practicePolicy:'after-miss-up-to-3'}]){
    const changed=await editionFile(dir,'review-one',override);await manifest(dir,[changed]);
    await assert.rejects(buildSite(dir),/must preserve original/);
  }
});

test('edition files and their parent directories cannot be symbolic links',async t=>{
  const dir=await fixture(t),good=await editionFile(dir);await manifest(dir,[good]);
  await rm(path.join(dir,good.href));await symlink(path.join(dir,paper.href),path.join(dir,good.href));
  await assert.rejects(buildSite(dir),/regular files and directories/);
  await rm(path.join(dir,'assets/editions/review-one'),{recursive:true});
  await symlink(path.join(dir,'papers/paper-1'),path.join(dir,'assets/editions/review-one'));
  await assert.rejects(buildSite(dir),/regular files and directories/);
});

async function harness({catalog=entry(),saved={},history=[]}={}){
  const nodes=new Map(),created=[],windowEvents=new Map(),documentEvents=new Map(),replies=[],storage=new Map([[libraryKey,JSON.stringify(saved)],[historyKey,JSON.stringify({version:1,attempts:history})]]);
  let serial=0;const document={title:'',activeElement:null};
  function make(id){const events=new Map(),node={id,hidden:false,value:'',textContent:'',children:[],style:{},dataset:{},
    setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},focus(){document.activeElement=this;},
    classList:{add(){},toggle(){}},addEventListener(k,fn){events.set(k,fn);},trigger(k){events.get(k)?.({target:this});},
    querySelector(selector){return selector==='.player-toolbar'?get('toolbar'):null;},
    contentWindow:{postMessage(message){replies.push(structuredClone(message));}},
    cloneNode(){const replacement=make(this.id);replacement.hidden=this.hidden;return replacement;},replaceWith(replacement){nodes.set(this.id,replacement);}};
    created.push(node);return node;}
  function get(id){if(!nodes.has(id))nodes.set(id,make(id));return nodes.get(id);}
  Object.assign(document,{getElementById:get,createElement:tag=>make(`${tag}-${serial++}`),addEventListener(k,fn){const all=documentEvents.get(k)||[];all.push(fn);documentEvents.set(k,all);},dispatchEvent(event){for(const fn of documentEvents.get(event.type)||[])fn(event);}});
  const window={location:new URL(`https://edition.test/study/#paper/${paper.id}`),scrollTo(){},addEventListener(k,fn){windowEvents.set(k,fn);}};
  vm.runInNewContext(appSource,{document,window,URL,Date,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},fetch:async()=>({ok:true,json:async()=>({papers:[catalog]})})});
  await new Promise(resolve=>setImmediate(resolve));
  return {document,window,storage,replies,node:get,created,get frame(){return get('paper-frame');},message(data,source=get('paper-frame').contentWindow){windowEvents.get('message')({source,data:{paperId:paper.id,...data}});},emit(type,detail){document.dispatchEvent({type,detail});},async refresh(){get('refresh-library').trigger('click');await new Promise(resolve=>setImmediate(resolve));},repeat(){created.find(node=>node.id==='start-another-paper-attempt').trigger('click');}};
}

test('fresh and view-only records open current teaching, while unpinned saved state always resumes the original',async()=>{
  for(const saved of [{},{[paper.id]:{version:1,view:{mode:'normal',flags:[]}}}]){
    const app=await harness({saved});assert.match(app.frame.src,/assets\/editions\/review-two\/sample-p1.html\?v=3333333333333333$/);
    app.message({type:'tmua-ready'});assert.equal(app.replies.at(-1).state,null);
  }
  for(const saved of [record(),record({progress:progress({firstAttempted:0})})]){
    const app=await harness({saved:{[paper.id]:saved}});assert.match(app.frame.src,/papers\/paper-1\/sample-p1.html\?v=1111111111111111$/);
    app.message({type:'tmua-ready'});assert.deepEqual(app.replies.at(-1).state,saved.state);
  }
});

test('pinned earlier editions stay pinned after a new edition is published, including actual resume state and saves',async()=>{
  const original=record({teachingEdition:'review-one'}),app=await harness({saved:{[paper.id]:original}});
  assert.match(app.frame.src,/review-one/);app.message({type:'tmua-ready'});assert.deepEqual(app.replies.at(-1).state,original.state);
  app.message({type:'tmua-progress',state:original.state,progress:original.progress});
  assert.equal(JSON.parse(app.storage.get(libraryKey))[paper.id].teachingEdition,'review-one');
  await app.refresh();assert.match(app.frame.src,/review-one/);
});

test('deliberate new attempts archive old edition and answers, clear the old frame and select latest teaching',async()=>{
  const original=record(),app=await harness({saved:{[paper.id]:original}}),oldFrame=app.frame;
  app.repeat();assert.notEqual(app.frame,oldFrame);assert.match(app.frame.src,/review-two/);
  const archived=JSON.parse(app.storage.get(historyKey)).attempts;
  assert.equal(archived.length,1);assert.equal(archived[0].teachingEdition,'original');assert.deepEqual(archived[0].state,original.state);
  app.message({type:'tmua-progress',state:original.state,progress:original.progress},oldFrame.contentWindow);
  assert.equal(JSON.parse(app.storage.get(libraryKey))[paper.id],undefined,'old frame cannot overwrite a new sitting');
  const next=progress({attemptId:'attempt-002',firstAttempted:0}),state={version:1,attemptId:'attempt-002'};
  app.message({type:'tmua-progress',state,progress:next});
  assert.equal(JSON.parse(app.storage.get(libraryKey))[paper.id].teachingEdition,'review-two');
});

test('a frozen player’s own new-attempt action also switches to current teaching before answering',async()=>{
  const finished=record({progress:progress({questionIndex:19,completed:20,firstAttempted:20,firstCorrect:13,afterCorrect:18,finished:true})});
  const app=await harness({saved:{[paper.id]:finished}}),oldFrame=app.frame;
  app.message({type:'tmua-progress',state:{version:1,attemptId:'attempt-new'},progress:progress({attemptId:'attempt-new',firstAttempted:0})});
  assert.notEqual(app.frame,oldFrame);assert.match(app.frame.src,/review-two/);
  const archived=JSON.parse(app.storage.get(historyKey)).attempts;
  assert.equal(archived.length,1);assert.equal(archived[0].firstCorrect,13);assert.equal(archived[0].afterCorrect,18);assert.equal(archived[0].teachingEdition,'original');
  assert.equal(JSON.parse(app.storage.get(libraryKey))[paper.id],undefined);
});

test('unknown edition pins block the iframe with a recovery message and never substitute latest state',async()=>{
  const original=record({teachingEdition:'missing-edition'}),app=await harness({saved:{[paper.id]:original}});
  assert.equal(app.frame.src,undefined);assert.equal(app.frame.hidden,true);
  const alert=app.created.find(node=>node.id==='teaching-edition-unavailable');assert.equal(alert.hidden,false);
  assert.match(alert.children.map(node=>node.textContent).join(' '),/answers and scores are safe/);
  assert.deepEqual(JSON.parse(app.storage.get(libraryKey))[paper.id],original);
  alert.children.find(node=>node.textContent==='Start another attempt with current teaching').trigger('click');
  assert.match(app.frame.src,/review-two/);assert.equal(JSON.parse(app.storage.get(historyKey)).attempts[0].teachingEdition,'missing-edition');
});

test('runtime catalog validation rejects unsafe edition URLs, duplicate IDs and unknown defaults',async()=>{
  for(const changes of [{currentEditionId:'absent'}, {editions:[edition('review-one'),edition('review-one')],currentEditionId:'review-one'},
    {editions:[{...edition('review-two'),href:'https://attacker.test/paper.html'}]},
    {editions:[{...edition('review-two'),href:'assets/editions/review-two/../sample-p1.html'}]},
    {editions:[{...edition('review-two'),contentHash:'bad'}]}]){
    const app=await harness({catalog:{...entry(),...changes}});assert.equal(app.frame.src,undefined);
  }
});

test('account changes recreate the iframe, match the new account pin and reject previous-account messages',async()=>{
  const original=record({teachingEdition:'review-one'}),app=await harness({saved:{[paper.id]:original}}),oldFrame=app.frame;
  const next=record({teachingEdition:'original',state:{version:1,attemptId:'attempt-other'},progress:progress({attemptId:'attempt-other'})});
  app.emit('tmua-cloud-applied',{payload:{library:{[paper.id]:next},history:{version:1,attempts:[]}},persistence:{library:false,history:false}});
  assert.notEqual(app.frame,oldFrame);assert.match(app.frame.src,/papers\/paper-1/);
  app.message({type:'tmua-ready'});assert.deepEqual(app.replies.at(-1).state,next.state);
  app.message({type:'tmua-progress',state:original.state,progress:original.progress},oldFrame.contentWindow);
  assert.deepEqual(JSON.parse(app.storage.get(libraryKey))[paper.id],original,'stale source causes no storage write');
  app.emit('tmua-cloud-lock');assert.equal(app.frame.src,undefined);
});

const require=createRequire(import.meta.url);let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});after(async()=>{await browser?.close();});
test('browser: real frames fetch the pin-specific HTML and receive only the matching sitting state',{skip:!chromium},async()=>{
  const context=await browser.newContext();
  const initial=record({teachingEdition:'review-one'});
  await context.addInitScript(({key,id,initial})=>{if(window===window.top)localStorage.setItem(key,JSON.stringify({[id]:initial}));},{key:libraryKey,id:paper.id,initial});
  const homepage=(await readFile(path.join(root,'index.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')+'<script src="assets/app.js"></script>';
  const requests=[];
  await context.route('https://edition.test/**',route=>{
    const pathname=new URL(route.request().url()).pathname.replace(/^\/study\//,'');
    if(pathname==='assets/app.js')return route.fulfill({contentType:'text/javascript',body:appSource});
    if(pathname==='papers/catalog.json')return route.fulfill({contentType:'application/json',body:JSON.stringify({papers:[entry()]})});
    if(pathname===paper.href || entry().editions.some(item=>item.href===pathname)){
      requests.push(pathname);const label=pathname===paper.href?'original':pathname.split('/')[2];
      const body=html(label)+`<script>window.resume=null;addEventListener('message',e=>{if(e.data.type==='tmua-resume')window.resume=e.data.state;});parent.postMessage({type:'tmua-ready',paperId:'${paper.id}'},'*');</script>`;
      return route.fulfill({contentType:'text/html',body});
    }
    return route.fulfill({contentType:'text/html',body:homepage});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`https://edition.test/study/#paper/${paper.id}`);
    await page.frameLocator('#paper-frame').locator('#edition').waitFor();
    assert.equal(await page.frameLocator('#paper-frame').locator('#edition').innerText(),'review-one');
    const frame=page.frames().find(frame=>frame.url().includes('/review-one/'));
    await frame.waitForFunction(()=>window.resume!==null);assert.deepEqual(await frame.evaluate(()=>window.resume),initial.state);
    await page.locator('#start-another-paper-attempt').click();
    await page.frameLocator('#paper-frame').locator('#edition').filter({hasText:'review-two'}).waitFor();
    const next=page.frames().find(frame=>frame.url().includes('/review-two/'));
    assert.equal(await next.evaluate(()=>window.resume),null);
    assert.deepEqual(requests,[edition('review-one').href,edition('review-two').href]);
    assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts[0].teachingEdition,historyKey),'review-one');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
