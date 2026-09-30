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
const attempt=(number,overrides={})=>({id:`session-${number}`,paperId:'sample-paper',title:'Sample paper',paper:1,total:20,firstCorrect:10,afterCorrect:16,completedAt:`2026-09-${String(number).padStart(2,'0')}T12:00:00Z`,source:'guided',attemptContext:'first',...overrides});

function harness(initial={version:1,attempts:[]},{blocked=false}={}) {
  let stored=JSON.stringify(initial);
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
  vm.runInNewContext(js,{document,window,URL,Date,localStorage:{getItem(){if(blocked)throw Error('Storage unavailable');return stored;}},setTimeout,clearTimeout});
  return {node,document,window,emit(detail){documentEvents.get('tmua-history-updated')({detail});},storage(value){stored=JSON.stringify(value);windowEvents.get('storage')({key});},event(type,event){for(const listener of node('history-section').events[type]||[])listener(event);}};
}

test('empty history contains no fabricated chart or scores',()=>{
  const app=harness();
  for(const paper of [1,2]){
    assert.match(app.node(`history-panel-${paper}`).innerHTML,/Your graph will appear after you complete a paper\./);
    assert.doesNotMatch(app.node(`history-panel-${paper}`).innerHTML,/<svg|history-score-card|<table/);
  }
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

const require=createRequire(import.meta.url);
let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch(_){}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});

test('browser: responsive graph, keyboard points and table use real stored attempts', {skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const errors=[];
  await context.addInitScript(({key,attempts})=>localStorage.setItem(key,JSON.stringify({version:1,attempts})),{key,attempts:[attempt(1,{firstCorrect:0,afterCorrect:null}),attempt(2,{firstCorrect:15,afterCorrect:19,attemptContext:'practised'})]});
  await context.route('https://history.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('history.js'))return route.fulfill({contentType:'text/javascript',body:js});
    if(pathname.endsWith('history.css'))return route.fulfill({contentType:'text/css',body:css});
    if(pathname.endsWith('site.css'))return route.fulfill({contentType:'text/css',body:siteCss});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/history.css"><main class="library-view"><section id="history-section"></section></main><script src="assets/history.js"></script>'});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('https://history.test/study/');
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
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
