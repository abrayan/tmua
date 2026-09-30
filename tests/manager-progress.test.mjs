import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [analyticsJs,managerJs,syncJs,css,siteCss,map,catalogue] = await Promise.all([
  'assets/progress-analytics.js','assets/manager-progress.js','assets/cloud-sync.js','assets/manager-progress.css','assets/site.css','assets/concept-map.json','assets/studied-concepts.json'
].map(file => readFile(path.join(root,file),'utf8')));
const conceptMap = JSON.parse(map), concepts = JSON.parse(catalogue);
const clone = value => JSON.parse(JSON.stringify(value));
const state = (records = {}) => ({version:1,contentRevision:1,records:Array.from({length:20},(_,i) => records[i+1] || {first:null,firstKind:null,everSolved:false})});
const record = (first,everSolved,firstKind='answer') => ({first,firstKind,everSolved});
const current = (overrides = {}) => ({version:1,updatedAt:'2026-09-30T14:00:00Z',attemptNumber:1,state:state({1:record(1,true),2:record(0,true,'hint'),3:record(0,false),4:record(1,true)}),
  answerLog:[{questionIndex:1,solvedWithHints:true,solutionSeenBeforeSolve:false}],
  progress:{attemptId:'current001',startedAt:'2026-09-30T13:00:00Z',questionIndex:3,total:20,completed:3,firstAttempted:4,firstCorrect:2,afterKnown:true,afterCorrect:3,practiceAttempted:1,practiceCorrect:1,finished:false},...overrides});
const attempt = (overrides = {}) => ({id:'guided:tmua-2020-p1:complete01',paperId:'tmua-2020-p1',title:'TMUA 2020 · Paper 1',paper:1,total:20,firstCorrect:10,afterCorrect:16,completedAt:'2026-09-29T12:00:00Z',updatedAt:'2026-09-29T12:00:00Z',source:'guided',attemptContext:'first',attemptNumber:1,...overrides});
const payload = (library = {}, attempts = []) => ({version:1,library,history:{version:1,attempts},roadmap:{version:1,pairs:{}}});
const response = value => ({data:{student:{user_id:'student-id'},revision:3,payload:value,updated_at:'2026-09-30T14:00:00Z'},error:null});
function pure() {
  const window = {};
  vm.runInNewContext(analyticsJs,{window,URL,Date});
  const api = window.TmuaProgressAnalytics;
  return {...api,papers:api.validateMap(conceptMap),lessons:api.validateLessons(concepts)};
}
function harness({rpc = async () => response(payload()),fetchFail = false} = {}) {
  const attributes = {}, events = new Map(), classes = new Set(), focused = [];
  const section = {innerHTML:'',attributes,events,classList:{add(value){classes.add(value);},remove(value){classes.delete(value);}},
    setAttribute(key,value){attributes[key]=value;},removeAttribute(key){delete attributes[key];},
    addEventListener(type,fn){events.set(type,fn);},removeEventListener(type,fn){if(events.get(type)===fn)events.delete(type);},
    querySelector(selector){return {focus(){focused.push(selector);}};}};
  const requests = [], calls = [];
  const window = {location:new URL('https://manager.test/study/')};
  const localStorage = new Proxy({}, {get(){throw Error('Manager must not use browser storage');}});
  const context = vm.createContext({window,URL,Date,localStorage,fetch:async(url,args) => {
    requests.push({url:String(url),args});
    if (typeof fetchFail === 'function' ? fetchFail() : fetchFail) throw Error('Offline');
    return {ok:true,json:async() => String(url).endsWith('concept-map.json') ? conceptMap : concepts};
  }});
  for (const script of [syncJs,analyticsJs,managerJs]) vm.runInContext(script,context);
  const client = {async rpc(name,...args){calls.push({name,args});return rpc(name,...args);}};
  const controller = window.TmuaManager.mount(section,{client});
  return {window,section,controller,requests,calls,client,focused,click(selector,dataset = {}) {events.get('click')?.({target:{closest(query){return query===selector?{dataset}:null;}}});}};
}

const api = pure();
const dataFor = (library,history = []) => ({papers:api.papers,lessons:api.lessons,library,history});
const rowFor = (rows,id) => rows.find(row => row.id === id);

test('shared concept weights match independent, hinted, solution, retry, unknown and unresolved outcomes', () => {
  for (const [saved,log,expected] of [
    [record(1,true),{solutionViewed:true},100],
    [record(0,true,'hint'),{solvedWithHints:true,solutionSeenBeforeSolve:false},50],
    [record(0,true),{solutionSeenBeforeSolve:true},25],
    [record(0,true),{},25],
    [record(0,false),{},0],
    [record(0,undefined),{},0]
  ]) {
    const input = dataFor({'tmua-2020-p1':current({state:state({1:saved}),answerLog:[{questionIndex:0,...log}]})});
    const before = JSON.stringify(input);
    assert.equal(rowFor(api.evidence(input),'p1-b1-l18').score,expected);
    assert.equal(JSON.stringify(input),before,'analytics does not mutate its caller');
  }
});

test('same sitting snapshots merge; repeat sittings and exact reprints do not earn new independent concept credit', () => {
  const old = attempt({id:'guided:tmua-2020-p1:current001',completedAt:null,finished:false,firstAttempted:4,state:state({1:record(0,false,'hint')}),progress:{attemptId:'current001'},startedAt:'2026-09-30T13:00:00Z'});
  const live = current({state:state({1:record(0,true,'hint')}),answerLog:[{questionIndex:0,solvedWithHints:true,solutionSeenBeforeSolve:false}]});
  assert.equal(rowFor(api.evidence(dataFor({'tmua-2020-p1':live},[old])),'p1-b1-l18').score,50);
  const repeated = current({attemptNumber:2,state:state({1:record(1,true)})});
  assert.equal(rowFor(api.evidence(dataFor({'tmua-2020-p1':repeated})),'p1-b1-l18').score,25);
  const reprints = {
    'tmua-2019-p2':current({updatedAt:'2026-09-28T14:00:00Z',state:state({2:record(0,false)}),progress:{attemptId:'older0001',startedAt:'2026-09-28T13:00:00Z'}}),
    'tmua-2020-p1':current({state:state({2:record(1,true)})})
  };
  const row = rowFor(api.evidence(dataFor(reprints)),'p1-b4-l02');
  assert.equal(row.score,25);assert.equal(row.total,1);
});

test('missing, malformed and incompatible question records never invent concept evidence; manual totals are excluded', () => {
  const library = {'tmua-2020-p1':current({state:{...state({1:record(1,true)}),contentRevision:999}}),
    'tmua-2020-p2':current({state:state({1:record(1,false),2:record(2,true),3:record(1,true,'hint')})})};
  const rows = api.evidence(dataFor(library,[attempt({source:'manual',state:state({1:record(1,true)})})]));
  assert.ok(rows.every(row => row.total === 0 && row.score === null));
});

test('attempt analytics merges live and archived copies but preserves repeats and manually entered results', () => {
  const archive = attempt({id:'guided:tmua-2020-p1:current001',finished:false,completedAt:null,firstAttempted:2,firstCorrect:1,afterCorrect:1,attemptNumber:2});
  const manual = attempt({id:'manual:first',paperId:'tmua-2020-p2',title:'Paper 2 manual',paper:2,source:'manual',afterCorrect:null});
  const input = dataFor({'tmua-2020-p1':current({attemptNumber:2})},[attempt(),archive,manual]);
  const before = JSON.stringify(input), rows = api.attempts(input);
  assert.equal(rows.length,3);assert.equal(rows.filter(row => row.finished).length,2);
  const live = rows.find(row => row.current);
  assert.equal(live.id,archive.id);assert.equal(live.firstAttempted,4);assert.equal(live.firstCorrect,2);assert.equal(live.afterCorrect,3);
  assert.equal(rows.find(row => row.source==='manual').afterCorrect,null);
  assert.equal(JSON.stringify(input),before);
});

test('partial totals, malformed progress and previews stay out of completed scores', () => {
  for (const change of [{firstCorrect:5},{afterCorrect:5},{afterKnown:false,afterCorrect:3},{firstAttempted:21},{finished:true},{questionIndex:20},{total:2}]) {
    const saved=current();Object.assign(saved.progress,change);
    assert.equal(api.attempts(dataFor({'tmua-2020-p1':saved})).length,0);
  }
  assert.equal(api.attempts(dataFor({'unknown':current()})).length,0);
  const saved=current();saved.progress.afterKnown=false;saved.progress.afterCorrect=null;
  const row=api.attempts(dataFor({'tmua-2020-p1':saved}))[0];
  assert.equal(row.finished,false);assert.equal(row.afterCorrect,null);
  const invalid=attempt({finished:false,completedAt:null,updatedAt:'2026-09-29T12:00:00Z',firstAttempted:4,firstCorrect:2,afterCorrect:7});
  assert.equal(api.attempts(dataFor({},[invalid])).length,0);
});

test('completed library state without an archive appears once, and legacy copies deduplicate by sitting number', () => {
  const saved=current();Object.assign(saved.progress,{questionIndex:19,completed:20,firstAttempted:20,firstCorrect:12,afterCorrect:19,finished:true});
  const row=api.attempts(dataFor({'tmua-2020-p1':saved}))[0];
  assert.equal(row.finished,true);assert.equal(row.current,false);assert.equal(row.firstCorrect,12);
  const legacy=current();delete legacy.progress.attemptId;
  const rows=api.attempts(dataFor({'tmua-2020-p1':legacy},[attempt({finished:false,completedAt:null,firstAttempted:4,firstCorrect:1,afterCorrect:2})]));
  assert.equal(rows.length,1);assert.equal(rows[0].firstCorrect,2);
});

test('mount is lazy and the only account request is the read RPC; payload remains isolated from own practice', async () => {
  const app=harness({rpc:async()=>response(payload({'tmua-2020-p1':current()},[attempt({source:'manual',id:'manual:1'})]))});
  assert.equal(app.calls.length,0);assert.equal(app.requests.length,0);
  await app.controller.refresh();
  assert.deepEqual(app.calls,[{name:'tmua_read_student_progress',args:[]}]);
  assert.equal(app.requests.length,2);
  const html=app.section.innerHTML;
  assert.match(html,/Ryan’s progress/);assert.match(html,/Last synced by Ryan/);
  assert.match(html,/4 \/ 20<\/strong> questions answered/);assert.match(html,/First answers so far<strong>2 \/ 4/);
  assert.match(html,/After practice so far<strong>3 \/ 4/);assert.match(html,/Manually entered result/);
  assert.match(html,/data-manager-concept="p1-b1-l18" data-score="100"/);
  assert.doesNotMatch(html,/Continue paper|Start paper|Edit result|href="#paper\//);
});

test('unknown after-practice results have no chart point or invented zero', async () => {
  const app=harness({rpc:async()=>response(payload({},[attempt({afterCorrect:null})]))});
  await app.controller.refresh();
  assert.match(app.section.innerHTML,/Not recorded/);
  assert.doesNotMatch(app.section.innerHTML,/class="manager-point manager-after"/);
  assert.match(app.section.innerHTML,/class="manager-point manager-first"/);
});

test('empty student, no saved state, invalid response and transport errors are distinct safe states with retry', async () => {
  for (const data of [
    {student:null,revision:null,payload:null,updated_at:null},
    {student:{user_id:'id'},revision:null,payload:null,updated_at:null}
  ]) {
    const app=harness({rpc:async()=>({data})});await app.controller.refresh();
    assert.match(app.section.innerHTML,data.student?/has not synced any progress/:/No student account/);
    assert.doesNotMatch(app.section.innerHTML,/<svg|<table|data-score=/);
  }
  for (const result of [{error:{message:'database secret'}},response({version:1}),{data:{student:null,payload:payload(),revision:1,updated_at:'2026-09-30'}}]) {
    const app=harness({rpc:async()=>result});await app.controller.refresh();
    assert.match(app.section.innerHTML,/could not be loaded/);assert.match(app.section.innerHTML,/Try again/);
    assert.doesNotMatch(app.section.innerHTML,/database secret|<table|data-score=/);
  }
  let fail=true;const app=harness({fetchFail:()=>fail});await app.controller.refresh();
  assert.match(app.section.innerHTML,/could not be loaded/);fail=false;await app.controller.refresh();
  assert.match(app.section.innerHTML,/Last synced by Ryan/);
});

test('newer refresh wins and destroying a mounted view clears data and blocks stale responses', async () => {
  const pending=[];const app=harness({rpc:()=>new Promise(resolve=>pending.push(resolve))});
  const first=app.controller.refresh(),second=app.controller.refresh();
  pending[1](response(payload({},[attempt({title:'New result'})])));await second;
  pending[0](response(payload({},[attempt({title:'Stale result'})])));await first;
  assert.match(app.section.innerHTML,/New result/);assert.doesNotMatch(app.section.innerHTML,/Stale result/);
  const third=app.controller.refresh();app.controller.destroy();
  assert.equal(app.section.innerHTML,'');assert.equal(app.section.events.size,0);
  pending[2](response(payload({},[attempt({title:'Private stale result'})])));await third;
  assert.equal(app.section.innerHTML,'');await app.controller.refresh();assert.equal(app.calls.length,3);
});

test('remount destroys the old controller and metadata text is escaped', async () => {
  let resolve;const app=harness({rpc:()=>new Promise(done=>{resolve=done;})});
  const pending=app.controller.refresh();
  const next=app.window.TmuaManager.mount(app.section,{client:{rpc:async()=>response(payload({},[attempt({title:'<img src=x onerror=alert(1)>'})]))}});
  await next.refresh();resolve(response(payload({},[attempt({title:'Old account'})])));await pending;
  assert.doesNotMatch(app.section.innerHTML,/<img|Old account/);assert.match(app.section.innerHTML,/&lt;img/);
  next.destroy();assert.equal(app.section.innerHTML,'');
});

test('concept tabs support keyboard selection and maintain one selected tab', async () => {
  const app=harness();await app.controller.refresh();let prevented=false;
  app.section.events.get('keydown')({target:{closest:()=>({dataset:{managerPaper:'1'}})},key:'End',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.match(app.section.innerHTML,/id="manager-concepts-tab-2"[^>]*aria-selected="true" tabindex="0"/);
  assert.deepEqual(app.focused,['#manager-concepts-tab-2']);
});

const require=createRequire(import.meta.url);
let chromium,browser;
try { ({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright')); } catch (_) {}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
test('browser: read-only manager view is responsive and leaves own storage and practice events untouched',{skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const fixture=response(payload({'tmua-2020-p1':current()},[attempt({source:'manual',id:'manual-result',afterCorrect:null})]));
  await context.addInitScript(({fixture})=>{
    window.managerFixture=fixture;window.managerEvents=0;window.managerCalls=[];
    localStorage.setItem('own-practice','unchanged');
    document.addEventListener('tmua-cloud-applied',()=>window.managerEvents++);
    document.addEventListener('tmua-local-updated',()=>window.managerEvents++);
  },{fixture});
  const files={'manager-progress.js':managerJs,'progress-analytics.js':analyticsJs,'cloud-sync.js':syncJs,'manager-progress.css':css,'site.css':siteCss,'concept-map.json':map,'studied-concepts.json':catalogue};
  await context.route('https://manager.test/**',route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1);
    if(Object.hasOwn(files,name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/json',body:files[name]});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/manager-progress.css"><main class="library-view"><section id="student-progress-section"></section></main><script src="assets/cloud-sync.js"></script><script src="assets/progress-analytics.js"></script><script src="assets/manager-progress.js"></script><script>window.manager=TmuaManager.mount(document.querySelector("section"),{client:{rpc:async(name)=>{managerCalls.push(name);return managerFixture;}}});</script>'});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto('https://manager.test/study/');assert.deepEqual(await page.evaluate(()=>managerCalls),[]);
    await page.evaluate(()=>manager.refresh());
    await page.locator('[data-manager-concept="p1-b1-l18"][data-score="100"]').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('.manager-table tbody tr').count(),2);
    assert.equal(await page.evaluate(()=>localStorage.getItem('own-practice')),'unchanged');
    assert.equal(await page.evaluate(()=>managerEvents),0);
    await page.locator('#manager-concepts-tab-1').focus();await page.keyboard.press('End');
    assert.equal(await page.locator('#manager-concepts-tab-2').getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');await page.locator('[data-manager-concept="p1-b1-l18"] summary').click();
    assert.match(await page.locator('[data-manager-concept="p1-b1-l18"] details').innerText(),/independently/);
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:'/tmp/tmua-manager-progress-mobile.png',fullPage:false});
    await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/tmua-manager-progress-desktop.png',fullPage:false});
    await page.evaluate(()=>manager.destroy());assert.equal(await page.locator('#student-progress-section').innerHTML(),'');
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});
