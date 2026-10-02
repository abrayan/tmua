import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';
import vm from 'node:vm';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const js=await readFile(path.join(root,'assets/history.js'),'utf8');
const css=await readFile(path.join(root,'assets/history.css'),'utf8');
const siteCss=await readFile(path.join(root,'assets/site.css'),'utf8');
const key='tmua-attempt-history-v1:/study/';
const libraryKey='tmua-practice-library-v1:/study/';
const catalog = {papers: [1,2].map(paper => ({format:'tmua-paper-v1', id:`tmua-2020-p${paper}`,
  title:`TMUA 2020 · Paper ${paper}`, paper, questionCount:20, version:1}))};
catalog.papers.push({format:'tmua-paper-v1',id:'jz-mock-d-p1-preview',title:'JZ Mock D · Questions 1–2',paper:1,questionCount:2,version:1});
const savedProgress=(overrides={},updatedAt='2026-09-30T14:00:00Z') => ({version:1,updatedAt,
  progress:{questionIndex:4,total:20,completed:3,firstAttempted:4,firstCorrect:2,afterKnown:true,afterCorrect:3,
    practiceAttempted:2,practiceCorrect:1,finished:false,...overrides}});
const attempt=(number,overrides={})=>({id:`session-${number}`,paperId:'sample-paper',title:'Sample paper',paper:1,total:20,firstCorrect:10,afterCorrect:16,completedAt:`2026-09-${String(number).padStart(2,'0')}T12:00:00Z`,source:'guided',attemptContext:'first',...overrides});

function harness(initial={version:1,attempts:[]},{blocked=false,library={},metadata=catalog}={}) {
  const stored=new Map([[key,JSON.stringify(initial)],[libraryKey,JSON.stringify(library)]]);
  const nodes=new Map(), documentEvents=new Map(), windowEvents=new Map();
  const document={activeElement:null};
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:false,clientWidth:800,dataset:{},attributes:{},events:{},classList:{add(){}},
      setAttribute(name,value){this.attributes[name]=value;},focus(){document.activeElement=this;},
      addEventListener(type,listener){(this.events[type]||=[]).push(listener);},
      querySelector(selector){return selector==='details'&&this.innerHTML.includes('<details')?(this.details||={open:false}):null;}
    });
    return nodes.get(id);
  };
  Object.assign(document,{getElementById:node,addEventListener(type,listener){documentEvents.set(type,listener);}});
  const window={location:new URL('https://history.test/study/'),addEventListener(type,listener){windowEvents.set(type,listener);}};
  vm.runInNewContext(js,{document,window,URL,Date,fetch:async()=>({ok:true,json:async()=>metadata}),
    localStorage:{getItem(name){if(blocked)throw Error('Storage unavailable');return stored.get(name)||null;}},setTimeout,clearTimeout});
  return {node,document,window,ready:new Promise(resolve=>setImmediate(resolve)),
    emit(detail){documentEvents.get('tmua-history-updated')({detail});},
    library(value,persisted){documentEvents.get('tmua-local-updated')({detail:{kind:'library',value,persisted}});},
    cloud(payload,persistence){documentEvents.get('tmua-cloud-applied')({detail:{payload,persistence}});},
    storage(value,name=key){stored.set(name,JSON.stringify(value));windowEvents.get('storage')({key:name});},
    event(type,event){for(const listener of node('history-section').events[type]||[])listener(event);}};
}

test('empty history contains no fabricated chart or scores',()=>{
  const app=harness();
  for(const paper of [1,2]){
    assert.match(app.node(`history-panel-${paper}`).innerHTML,/Your graph will appear after you complete a paper\./);
    assert.doesNotMatch(app.node(`history-panel-${paper}`).innerHTML,/<svg|history-score-card|<table/);
  }
});

test('history displays K and L from twelve-option questions without altering scores',()=>{
  const saved=attempt(1,{firstCorrect:0,afterCorrect:1,
    state:{records:[{first:0,everSolved:true}]},
    answerLog:[{questionIndex:0,firstAnswer:'K',latestAnswer:'L',firstCorrect:0,afterCorrect:true}]});
  const before=JSON.stringify(saved),app=harness({version:1,attempts:[saved]});
  const html=app.node('history-panel-1').innerHTML;
  assert.match(html,/First answer: K · Incorrect/);assert.match(html,/Latest answer: L/);
  assert.match(html,/0 correct out of 20/);assert.equal(JSON.stringify(saved),before);
});

test('separate papers, zero scores and unknown after-learning scores keep their meaning',()=>{
  const app=harness({version:1,attempts:[attempt(1,{firstCorrect:0,afterCorrect:null}),attempt(2,{paper:2,total:10,firstCorrect:7,afterCorrect:9})]});
  const first=app.node('history-panel-1').innerHTML,second=app.node('history-panel-2').innerHTML;
  assert.match(first,/0 correct out of 20/);
  assert.match(first,/Not recorded/);
  assert.equal((first.match(/class="history-point /g)||[]).length,1);
  assert.match(first,/One completed attempt is shown/);
  assert.match(second,/7 correct out of 10/);
  assert.match(second,/70%/);
  assert.match(second,/9 \/ 10 \(90%\)/);
  assert.match(first,/not TMUA scaled scores/);
  assert.match(first,/<caption>All completed Paper 1 attempts/);
});

test('repeated sessions remain separate, graph keeps twelve, table keeps all',()=>{
  const app=harness({version:1,attempts:Array.from({length:15},(_,index)=>attempt(index+1,{attemptContext:index===14?'practised':'first'}))});
  const html=app.node('history-panel-1').innerHTML;
  assert.equal((html.match(/class="history-point /g)||[]).length,24);
  assert.equal((html.match(/<th scope="row">/g)||[]).length,15);
  assert.match(html,/The latest 12 completed attempts/);
  assert.match(html,/Practised before/);
  assert.match(html,/<th scope="row">15<\/th>/);
});

test('missing after-learning scores break the coral line rather than inventing measurements',()=>{
  const app=harness({version:1,attempts:[attempt(1),attempt(2,{afterCorrect:null}),attempt(3)]});
  const line=/class="history-line history-after" d="([^"]*)"/.exec(app.node('history-panel-1').innerHTML)[1];
  assert.equal((line.match(/M/g)||[]).length,2);
  assert.equal((line.match(/L/g)||[]).length,0);
});

test('attempt numbers belong to each paper and manual score records remain visible',()=>{
  const app=harness({version:1,attempts:[attempt(1),attempt(2,{paperId:'second-paper',title:'Another paper'}),
    attempt(3,{source:'manual',attemptNumber:2}),attempt(4,{paperId:'second-paper',title:'Another paper'})]});
  const html=app.node('history-panel-1').innerHTML;
  assert.equal((html.match(/<th scope="row">1<\/th>/g)||[]).length,2);
  assert.equal((html.match(/<th scope="row">2<\/th>/g)||[]).length,2);
  assert.match(html,/Score record only/);assert.match(html,/Manual record/);
});

test('saved unfinished attempts expose retained answers without entering completed score graphs',()=>{
  const partial=attempt(2,{finished:false,completedAt:null,updatedAt:'2026-09-02T12:00:00Z',firstAttempted:2,
    firstCorrect:0,afterCorrect:1,attemptNumber:2,state:{records:[{first:0,everSolved:true},{first:0,firstKind:'hint',everSolved:false}]},
    answerLog:[{questionIndex:0,firstAnswer:'A',latestAnswer:'C',firstCorrect:0,afterCorrect:true,assisted:true},
      {questionIndex:1,firstAnswer:null,latestAnswer:null,firstKind:'hint',firstCorrect:0,afterCorrect:false}]});
  const app=harness({version:1,attempts:[attempt(1),partial]});
  const html=app.node('history-panel-1').innerHTML;
  assert.equal((html.match(/class="history-point /g)||[]).length,2);
  assert.equal((html.match(/<th scope="row">/g)||[]).length,2);
  assert.match(html,/Saved unfinished attempt/);assert.match(html,/0 \/ 2 answered/);
  assert.match(html,/First answer: A · Incorrect/);assert.match(html,/Latest answer: C/);
  assert.match(html,/Hint before answering/);assert.match(html,/Help or retry used/);
  assert.match(html,/Latest answer: Not recorded/);
  const noFinished=harness({version:1,attempts:[partial]}).node('history-panel-1').innerHTML;
  assert.doesNotMatch(noFinished,/<svg/);assert.match(noFinished,/Answers and details/);
});

test('answer letters are validated before rendering untrusted historical snapshots',()=>{
  const app=harness({version:1,attempts:[attempt(1,{total:1,firstCorrect:0,afterCorrect:0,
    answerLog:[{questionIndex:0,firstAnswer:'<img src=x>',latestAnswer:'<script>',firstCorrect:0,afterCorrect:false}]})]});
  const html=app.node('history-panel-1').innerHTML;
  assert.match(html,/First answer: Not recorded/);assert.match(html,/Latest answer: Not recorded/);
  assert.doesNotMatch(html,/<img|<script/);
});

test('in-memory updates work without storage and disclose visit-only history',()=>{
  const app=harness(undefined,{blocked:true});
  app.emit({attempts:[attempt(2,{paper:2})],persisted:false});
  assert.match(app.node('history-panel-2').innerHTML,/10 correct out of 20/);
  assert.equal(app.node('history-panel-2').hidden,false,'first available paper becomes visible');
  assert.match(app.node('history-storage-note').textContent,/available for this visit/);
});

test('storage updates reread the shared key and preserve the chosen tab',()=>{
  const app=harness();
  const target={dataset:{historyPaper:'2'},closest(selector){return selector==='[data-history-paper]'?this:null;}};
  app.event('click',{target});
  app.storage({version:1,attempts:[attempt(1),attempt(2,{paper:2})]});
  assert.equal(app.node('history-tab-2').attributes['aria-selected'],'true');
  assert.equal(app.node('history-panel-1').hidden,true);
  assert.equal(app.node('history-panel-2').hidden,false);
});

test('tab arrows move focus and selection with complete ARIA state',()=>{
  const app=harness();let prevented=false;
  const target={closest(){return {dataset:{historyPaper:'1'}};}};
  app.event('keydown',{key:'ArrowRight',target,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(app.document.activeElement.id,'history-tab-2');
  assert.equal(app.node('history-tab-1').tabIndex,-1);
  assert.equal(app.node('history-tab-2').tabIndex,0);
});

test('malformed attempts are ignored and titles cannot inject markup',()=>{
  const app=harness({version:1,attempts:[attempt(1,{title:'<img src=x onerror=alert(1)>'}),attempt(2,{total:0}),attempt(3,{firstCorrect:21}),attempt(4,{afterCorrect:-1}),attempt(5,{completedAt:'invalid'}),attempt(6,{source:'elsewhere'}),attempt(7,{firstCorrect:15,afterCorrect:14})]});
  const html=app.node('history-panel-1').innerHTML;
  assert.equal((html.match(/<th scope="row">/g)||[]).length,1);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html,/<img src=x/);
});

test('current full-paper attempt shows only answered-question scores without fabricating history',async()=>{
  const app=harness(undefined,{library:{'tmua-2020-p2':savedProgress()}});
  await app.ready;
  const html=app.node('history-panel-2').innerHTML;
  assert.match(html,/Current attempt/);
  assert.match(html,/TMUA 2020 · Paper 2/);
  assert.match(html,/First answers so far<\/span><strong>2 \/ 4/);
  assert.match(html,/After practice so far<\/span><strong>3 \/ 4/);
  assert.match(html,/4 answered so far/);
  assert.match(html,/3 of 20 exercises completed/);
  assert.match(html,/href="#paper\/tmua-2020-p2"/);
  assert.doesNotMatch(html,/<svg|<table|50%|2 \/ 20/);
  assert.equal(app.node('history-tab-2').attributes['aria-selected'],'true');
});

test('hints and unknown after-learning scores do not invent independent success',async()=>{
  const app=harness(undefined,{library:{'tmua-2020-p1':savedProgress({firstCorrect:0,firstAttempted:1,completed:0,questionIndex:0,afterCorrect:0})}});
  await app.ready;
  assert.match(app.node('history-panel-1').innerHTML,/First answers so far<\/span><strong>0 \/ 1/);
  app.library({'tmua-2020-p1':savedProgress({afterKnown:false,afterCorrect:null})});
  assert.match(app.node('history-panel-1').innerHTML,/After practice so far<\/span><strong>Not recorded/);
  assert.doesNotMatch(app.node('history-panel-1').innerHTML,/After practice so far<\/span><strong>0/);
});

test('preview papers, malformed totals and impossible partial scores stay out of live totals',async()=>{
  const invalid=[
    {'jz-mock-d-p1-preview':savedProgress()},
    {'unknown-paper':savedProgress()},
    {'tmua-2020-p1':savedProgress({total:2})},
    {'tmua-2020-p1':savedProgress({firstCorrect:5})},
    {'tmua-2020-p1':savedProgress({firstAttempted:21})},
    {'tmua-2020-p1':savedProgress({firstAttempted:2})},
    {'tmua-2020-p1':savedProgress({afterCorrect:5})},
    {'tmua-2020-p1':savedProgress({afterCorrect:1})},
    {'tmua-2020-p1':savedProgress({afterKnown:false,afterCorrect:3})},
    {'tmua-2020-p1':savedProgress({firstCorrect:0,firstAttempted:0,completed:0,afterCorrect:0})},
    {'tmua-2020-p1':savedProgress({},'bad-date')},
    {'tmua-2020-p1':{...savedProgress(),version:2}}
  ];
  const app=harness();await app.ready;
  for(const value of invalid){
    app.library(value);
    assert.doesNotMatch(app.node('history-panel-1').innerHTML,/class="history-live"/,JSON.stringify(value));
    assert.doesNotMatch(app.node('history-panel-2').innerHTML,/class="history-live"/);
  }
});

test('latest unfinished attempt selects its paper until the student chooses a tab',async()=>{
  const app=harness({version:1,attempts:[attempt(1)]},{library:{
    'tmua-2020-p1':savedProgress({},'2026-09-30T12:00:00Z'),
    'tmua-2020-p2':savedProgress({},'2026-09-30T13:00:00Z')}});
  await app.ready;
  assert.equal(app.node('history-tab-2').attributes['aria-selected'],'true');
  const target={dataset:{historyPaper:'1'},closest(selector){return selector==='[data-history-paper]'?this:null;}};
  app.event('click',{target});
  app.library({'tmua-2020-p2':savedProgress({},'2026-09-30T16:00:00Z')});
  assert.equal(app.node('history-tab-1').attributes['aria-selected'],'true');
  assert.match(app.node('history-panel-1').innerHTML,/<svg/,'completed graph remains');
});

test('completed work leaves the live card without adding or altering finished history',async()=>{
  const old=attempt(1,{paper:2,firstCorrect:12,afterCorrect:18});
  const app=harness({version:1,attempts:[old]},{library:{'tmua-2020-p2':savedProgress()}});
  await app.ready;
  const before=app.node('history-panel-2').innerHTML.match(/<svg[\s\S]*<\/svg>/)[0];
  app.library({'tmua-2020-p2':savedProgress({finished:true,firstAttempted:20,completed:20,questionIndex:19,firstCorrect:14,afterCorrect:20})});
  const html=app.node('history-panel-2').innerHTML;
  assert.doesNotMatch(html,/class="history-live"/);
  assert.equal(html.match(/<svg[\s\S]*<\/svg>/)[0],before);
  assert.equal((html.match(/<th scope="row">/g)||[]).length,1);
  assert.match(html,/12 correct out of 20/);
});

test('library and cloud events retain in-memory partial work when local writes fail',async()=>{
  const app=harness(undefined,{blocked:true});await app.ready;
  app.library({'tmua-2020-p2':savedProgress()});
  assert.match(app.node('history-panel-2').innerHTML,/2 \/ 4/);
  app.cloud({library:{'tmua-2020-p2':savedProgress({firstAttempted:5,firstCorrect:3,completed:4,afterCorrect:4})},
    history:{version:1,attempts:[attempt(1)]}}, {library:false,history:false});
  assert.match(app.node('history-panel-2').innerHTML,/3 \/ 5/);
  assert.match(app.node('history-panel-1').innerHTML,/<svg/);
  assert.match(app.node('history-storage-note').textContent,/available for this visit/);
  app.emit({attempts:[attempt(1),attempt(2)],persisted:false});
  assert.match(app.node('history-panel-2').innerHTML,/3 \/ 5/,'history update must not reread stale local library');
});

test('library storage updates refresh only live work and preserve the finished graph',async()=>{
  const app=harness({version:1,attempts:[attempt(1)]});await app.ready;
  app.storage({'tmua-2020-p2':savedProgress()},libraryKey);
  assert.match(app.node('history-panel-2').innerHTML,/2 \/ 4/);
  assert.match(app.node('history-panel-1').innerHTML,/<svg/);
  app.storage({},libraryKey);
  assert.doesNotMatch(app.node('history-panel-2').innerHTML,/class="history-live"/);
  assert.match(app.node('history-panel-1').innerHTML,/<svg/);
});

test('history and live work ignore stale storage independently after a failed cloud write, then recover',async()=>{
  for (const persistence of [{history:false,library:false},{history:false,library:true},{history:true,library:false}]) {
    const app=harness();await app.ready;
    const remote={library:{'tmua-2020-p2':savedProgress()},history:{version:1,attempts:[attempt(1,{firstCorrect:13})]}};
    app.cloud(remote,persistence);
    app.storage({version:1,attempts:[attempt(2,{firstCorrect:5})]});
    app.storage({'tmua-2020-p2':savedProgress({firstCorrect:1})},libraryKey);
    assert.match(app.node('history-panel-1').innerHTML,new RegExp(`${persistence.history?5:13} correct out of 20`));
    assert.match(app.node('history-panel-2').innerHTML,new RegExp(`First answers so far</span><strong>${persistence.library?1:2} / 4`));
    app.emit({attempts:remote.history.attempts,persisted:true});
    app.library(remote.library,true);
    app.storage({version:1,attempts:[attempt(2,{firstCorrect:5})]});
    app.storage({'tmua-2020-p2':savedProgress({firstCorrect:1})},libraryKey);
    assert.match(app.node('history-panel-1').innerHTML,/5 correct out of 20/);
    assert.match(app.node('history-panel-2').innerHTML,/First answers so far<\/span><strong>1 \/ 4/);
  }
});

const require=createRequire(import.meta.url);
let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch(_){}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});

test('browser: responsive graph, keyboard points and table use real stored attempts', {skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const errors=[];
  await context.addInitScript(({key,attempts,libraryKey,library})=>{
    localStorage.setItem(key,JSON.stringify({version:1,attempts}));
    localStorage.setItem(libraryKey,JSON.stringify(library));
  },{key,attempts:[attempt(1,{firstCorrect:0,afterCorrect:null}),attempt(2,{firstCorrect:15,afterCorrect:19,attemptContext:'practised'})],
    libraryKey,library:{'tmua-2020-p1':savedProgress()}});
  await context.route('https://history.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('papers/catalog.json'))return route.fulfill({contentType:'application/json',body:JSON.stringify(catalog)});
    if(pathname.endsWith('history.js'))return route.fulfill({contentType:'text/javascript',body:js});
    if(pathname.endsWith('history.css'))return route.fulfill({contentType:'text/css',body:css});
    if(pathname.endsWith('site.css'))return route.fulfill({contentType:'text/css',body:siteCss});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/history.css"><main class="library-view"><section id="history-section"></section></main><script src="assets/history.js"></script>'});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('https://history.test/study/');
    await page.locator('#history-live-1').waitFor();
    assert.match(await page.locator('#history-live-1').innerText(),/2 \/ 4/);
    assert.match(await page.locator('#history-live-1').innerText(),/3 of 20 exercises completed/);
    assert.equal(await page.locator('#history-live-1 progress').getAttribute('max'),'20');
    assert.equal(await page.locator('#history-panel-1 .history-point').count(),3);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.locator('#history-panel-1 .history-point').first().focus();
    assert.match(await page.locator('#history-tooltip-1').innerText(),/0 \/ 20 \(0%\)/);
    await page.locator('#history-tab-1').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#history-tab-2').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#history-panel-1').isVisible(),false);
    await page.keyboard.press('Home');
    await page.locator('#history-panel-1 summary').click();
    assert.equal(await page.locator('#history-panel-1 tbody tr').count(),2);
    assert.match(await page.locator('#history-panel-1 tbody tr').first().innerText(),/Practised before/);
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('tmua-local-updated',{detail:{kind:'library',value:{}}})));
    assert.equal(await page.locator('#history-live-1').count(),0);
    assert.equal(await page.locator('#history-panel-1 tbody tr').count(),2);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('browser: visible player repeat action archives unfinished answers and starts the next numbered attempt',{skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),errors=[];
  const entry={...catalog.papers[0],source:'Official TMUA',description:'Test paper',href:'papers/paper-1/tmua-2020-p1.html'};
  const initial={...savedProgress(),attemptNumber:1,
    progress:{...savedProgress().progress,attemptId:'attempt-0001',startedAt:'2026-09-30T12:00:00Z'},
    state:{version:1,attemptId:'attempt-0001',questionIndex:4,records:Array.from({length:20},()=>({first:null,everSolved:false}))},
    answerLog:[{questionIndex:0,firstAnswer:'A',latestAnswer:'B',firstCorrect:0,afterCorrect:true}]};
  await context.addInitScript(({libraryKey,initial,id})=>{if(window===window.top)localStorage.setItem(libraryKey,JSON.stringify({[id]:initial}));},{libraryKey,initial,id:entry.id});
  const appSource=await readFile(path.join(root,'assets/app.js'),'utf8');
  const homepage=(await readFile(path.join(root,'index.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'') + '<script src="assets/app.js"></script><script src="assets/history.js"></script>';
  await context.route('https://history.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('/papers/catalog.json'))return route.fulfill({contentType:'application/json',body:JSON.stringify({papers:[entry]})});
    if(pathname.endsWith(entry.href))return route.fulfill({contentType:'text/html',body:`<script>parent.postMessage({type:'tmua-ready',paperId:'${entry.id}'},'*')</script>`});
    if(pathname.endsWith('/assets/app.js'))return route.fulfill({contentType:'text/javascript',body:appSource});
    if(pathname.endsWith('/assets/history.js'))return route.fulfill({contentType:'text/javascript',body:js});
    if(pathname.endsWith('/assets/site.css'))return route.fulfill({contentType:'text/css',body:siteCss});
    if(pathname.endsWith('/assets/history.css'))return route.fulfill({contentType:'text/css',body:css});
    if(pathname.endsWith('.css'))return route.fulfill({contentType:'text/css',body:''});
    return route.fulfill({contentType:'text/html',body:homepage});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`https://history.test/study/#paper/${entry.id}`);
    const repeat=page.locator('#start-another-paper-attempt');
    await repeat.waitFor({state:'visible'});
    assert.match(await page.locator('#player-progress').textContent(),/Attempt 1/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'toolbar fits a mobile screen');
    await repeat.click();
    assert.equal(await repeat.isHidden(),true);
    const archived=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts,key);
    assert.equal(archived.length,1);assert.equal(archived[0].finished,false);
    assert.equal(archived[0].answerLog[0].firstAnswer,'A');
    const frame=await page.locator('#paper-frame').contentFrame();
    await frame.locator('body').waitFor();
    await page.frames().find(candidate=>candidate!==page.mainFrame()).evaluate(id=>parent.postMessage({type:'tmua-progress',paperId:id,
      progress:{questionIndex:0,total:20,completed:1,firstAttempted:1,firstCorrect:1,practiceAttempted:0,practiceCorrect:0,
        finished:false,attemptId:'attempt-0002',startedAt:'2026-09-30T15:00:00Z',afterKnown:true,afterCorrect:1},
      state:{version:1,attemptId:'attempt-0002',questionIndex:0,mode:'original',selected:'B',lastOutcome:'correct',
        records:Array.from({length:20},(_,i)=>({first:i===0?1:null,everSolved:i===0,firstKind:i===0?'answer':null}))}},'*'),entry.id);
    await page.waitForFunction(()=>document.getElementById('player-progress').textContent.includes('Attempt 2'));
    assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts,key),archived);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
