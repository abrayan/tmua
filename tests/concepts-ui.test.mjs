import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';
import vm from 'node:vm';
import {discoverPapers} from '../tools/build-site.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const js=await readFile(path.join(root,'assets/concepts.js'),'utf8');
const css=await readFile(path.join(root,'assets/concepts.css'),'utf8');
const siteCss=await readFile(path.join(root,'assets/site.css'),'utf8');
const conceptMap=JSON.parse(await readFile(path.join(root,'assets/concept-map.json'),'utf8'));
const key='tmua-practice-library-v1:/study/';
const blank=()=>({first:null,firstKind:null,everSolved:false});
const record=(first,after,kind='answer')=>({first,firstKind:kind,...(after===undefined?{}:{everSolved:after})});
function paper(number,results={},updatedAt='2026-09-30T11:00:00Z') {
  return {version:1,updatedAt,state:{version:1,contentRevision:number===2?2:1,records:Array.from({length:20},(_,i)=>results[i+1]||blank())}};
}
async function harness(initial={},options={}) {
  let stored=JSON.stringify(initial);
  const nodes=new Map(), documentEvents=new Map(), windowEvents=new Map();
  const document={activeElement:null};
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:false,dataset:{},attributes:{},events:{},classList:{add(){}},setAttribute(name,value){this.attributes[name]=value;},focus(){document.activeElement=this;},addEventListener(type,listener){(this.events[type]||=[]).push(listener);}});
    return nodes.get(id);
  };
  Object.assign(document,{getElementById:node,addEventListener(type,listener){documentEvents.set(type,listener);}});
  const window={location:new URL('https://concepts.test/study/'),addEventListener(type,listener){windowEvents.set(type,listener);}};
  const requests=[];
  vm.runInNewContext(js,{document,window,URL,Date,localStorage:{getItem(){if(options.blocked)throw Error('Storage unavailable');return stored;}},fetch:async(url,args)=>{requests.push({url:String(url),args});if(options.fetchFail)throw Error('Offline');return {ok:true,json:async()=>options.map||conceptMap};}});
  await new Promise(resolve=>setImmediate(resolve));
  return {node,document,requests,emit(type,detail){documentEvents.get(type)?.({detail});},storage(value){stored=JSON.stringify(value);windowEvents.get('storage')({key});},event(type,event){for(const listener of node('concepts-section').events[type]||[])listener(event);}};
}
const panel=(app,paper)=>app.node(`concepts-panel-${paper}`).innerHTML;
function choose(app,paper){const target={dataset:{conceptsPaper:String(paper)},closest(){return this;}};app.event('click',{target});}

test('map covers each guided original once and its evidence agrees with the source bank',async()=>{
  const bank=JSON.parse(await readFile(path.join(root,'content/official-question-bank.json'),'utf8')).questions;
  const published=(await discoverPapers(root)).catalog.papers.filter(paper=>paper.questionCount===20);
  assert.deepEqual(conceptMap.papers.map(paper=>paper.id).sort(),published.map(paper=>paper.id).sort());
  for(const mapped of conceptMap.papers){
    const plan=JSON.parse(await readFile(path.join(root,`content/${mapped.id}-plan.json`),'utf8'));
    assert.deepEqual(mapped.questions.map(q=>q.sourceId),plan.groups.map(group=>group.originalId));
    assert.equal(mapped.questions.length,20);
    assert.equal(new Set(mapped.areas.map(area=>area.id)).size,mapped.areas.length);
    for(const q of mapped.questions){
      assert.ok(mapped.areas.some(area=>area.id===q.area));
      assert.equal(q.knowledgePattern,bank[q.sourceId].knowledgePattern);
      assert.deepEqual(q.lessonIds,[...new Set(bank[q.sourceId].hints.flatMap(h=>h.recall.map(r=>r.lessonId)))]);
    }
  }
});

test('empty or manually recorded totals never become concept evidence',async()=>{
  const app=await harness({'tmua-2020-p1':{version:1,progress:{firstCorrect:20,firstAttempted:20}},'jz-mock-d-p1-preview':paper(1,{1:record(1,true)})});
  for(const number of [1,2]){
    assert.match(panel(app,number),/Concept progress appears as you answer guided questions/);
    assert.doesNotMatch(panel(app,number),/concepts-track|100%|concepts-card-heading/);
  }
  app.emit('tmua-history-updated',{attempts:[{paperId:'tmua-2020-p1',firstCorrect:20}]});
  assert.doesNotMatch(panel(app,1),/concepts-track/);
  assert.match(app.requests[0].url,/\/study\/assets\/concept-map.json$/);
  assert.equal(app.requests[0].args.cache,'no-cache');
});

test('ongoing originals count immediately; hints are not independent successes and followups never inflate bars',async()=>{
  const first=record(0,true,'hint');first.followups=[{first:1,sourceId:'2019-P2-Q16'}];
  const app=await harness({'tmua-2020-p2':paper(2,{1:first,2:record(1,true),3:record(0,false),4:record(0,false,'hint')})});
  const html=panel(app,2);
  assert.equal(app.node('concepts-tab-2').attributes['aria-selected'],'true');
  assert.match(html,/4 \/ 20 attempted/);
  assert.equal((html.match(/class="concepts-card"/g)||[]).length,4);
  assert.match(html,/On your own: 0 solved out of 1 attempted/);
  assert.match(html,/After practice: 1 solved out of 1 attempted/);
  assert.match(html,/1 more solved after practice/);
  assert.match(html,/Used a hint/);
  assert.doesNotMatch(html,/2019 · P2 · Q16|Mastery|100% mastered/);
});

test('each area compares the same attempted questions with explicit counts',async()=>{
  const app=await harness({'tmua-2020-p1':paper(1,{2:record(1,true),3:record(0,true),9:record(0,false)})});
  const html=panel(app,1);
  assert.match(html,/3 questions/);
  assert.match(html,/On your own: 1 solved out of 3 attempted/);
  assert.match(html,/After practice: 2 solved out of 3 attempted/);
  assert.match(html,/width:33\.333333333333336%/);
  assert.match(html,/width:66\.66666666666667%/);
  assert.match(html,/1 more solved after practice/);
});

test('unknown older redo results remain unrecorded rather than treated as failures or successes',async()=>{
  const app=await harness({'tmua-2020-p1':paper(1,{2:record(1,undefined),3:record(0,undefined),9:record(0,true)})});
  const html=panel(app,1);
  assert.match(html,/2 solved · 1 not recorded/);
  assert.match(html,/After practice: 2 solved out of 3 attempted; 1 result not recorded/);
  assert.match(html,/class="concepts-unknown"/);
  assert.match(html,/Retry not recorded/);
  assert.doesNotMatch(html,/After practice<\/span><strong>2 \/ 3/);
});

test('concept status needs at least three distinct independent checks and never upgrades from retries',async()=>{
  const small=await harness({'tmua-2020-p1':paper(1,{2:record(1,true),3:record(1,true)})});
  assert.match(panel(small,1),/concepts-status-building[^>]*>Building evidence/);
  assert.doesNotMatch(panel(small,1),/concepts-status-strong/);
  const strong=await harness({'tmua-2020-p1':paper(1,{2:record(1,true),3:record(1,true),9:record(1,true)})});
  assert.match(panel(strong,1),/concepts-status-strong[^>]*>Strong so far/);
  const retry=await harness({'tmua-2020-p1':paper(1,{2:record(0,true,'hint'),3:record(1,true),9:record(1,true)})});
  assert.match(panel(retry,1),/concepts-status-practice[^>]*>Needs practice/);
  assert.match(panel(retry,1),/After practice: 3 solved out of 3 attempted/);
  assert.doesNotMatch(panel(retry,1),/concepts-status-strong|Mastered/);
  assert.match(panel(retry,1),/at least 3 different original questions, with at least 80% correct before help/);
  assert.equal(conceptMap.statusRule.minimumDistinctOriginals,3);
  assert.equal(conceptMap.statusRule.independentAccuracyThreshold,0.8);
});

test('eighty percent threshold uses the attempted denominator, including answers that needed a hint',async()=>{
  const atThreshold={2:record(1,true),3:record(1,true),9:record(1,true),17:record(1,true),19:record(0,true,'hint')};
  const app=await harness({'tmua-2020-p1':paper(1,atThreshold)});
  assert.match(panel(app,1),/On your own: 4 solved out of 5 attempted/);
  assert.match(panel(app,1),/concepts-status-strong[^>]*>Strong so far/);
  app.emit('tmua-local-updated',{kind:'library',value:{'tmua-2020-p1':paper(1,{...atThreshold,20:record(0,true)})}});
  assert.match(panel(app,1),/On your own: 4 solved out of 6 attempted/);
  assert.match(panel(app,1),/concepts-status-practice[^>]*>Needs practice/);
});

test('malformed records and unknown question revisions cannot misattribute knowledge',async()=>{
  const app=await harness({'tmua-2020-p2':paper(2,{1:record(1,false),2:record(2,true),3:record(1,true,'hint'),4:record(0,'yes'),5:record(null,true)}),'tmua-2020-p1':{...paper(1,{1:record(1,true)}),state:{...paper(1).state,contentRevision:99}}});
  assert.doesNotMatch(panel(app,1)+panel(app,2),/concepts-track/);
  app.emit('tmua-local-updated',{kind:'library',value:{'tmua-2020-p1':{...paper(1),state:{version:1,records:[record(1,true)]}}}});
  assert.doesNotMatch(panel(app,1),/concepts-track/);
});

test('most recently active paper is selected unless the student has chosen a tab',async()=>{
  const library={'tmua-2020-p1':paper(1,{1:record(1,true)},'2026-09-29T10:00:00Z'),'tmua-2020-p2':paper(2,{1:record(1,true)},'2026-09-30T10:00:00Z')};
  const app=await harness(library);
  assert.equal(app.node('concepts-panel-2').hidden,false);
  choose(app,1);
  app.emit('tmua-local-updated',{kind:'library',value:library});
  assert.equal(app.node('concepts-panel-1').hidden,false);
  let prevented=false;
  app.event('keydown',{target:{closest(){return {dataset:{conceptsPaper:'1'}};}},key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(app.document.activeElement.id,'concepts-tab-2');
  assert.equal(app.node('concepts-tab-1').tabIndex,-1);assert.equal(app.node('concepts-tab-2').tabIndex,0);
});

test('live updates reflect real decreases on a fresh attempt rather than retaining a best-ever score',async()=>{
  const app=await harness({'tmua-2020-p1':paper(1,{2:record(1,true),3:record(1,true)})});
  assert.match(panel(app,1),/On your own: 2 solved out of 2 attempted/);
  app.emit('tmua-local-updated',{kind:'library',value:{'tmua-2020-p1':paper(1,{2:record(0,false)})}});
  assert.match(panel(app,1),/1 \/ 20 attempted/);
  assert.match(panel(app,1),/On your own: 0 solved out of 1 attempted/);
  assert.doesNotMatch(panel(app,1),/On your own: 2 solved/);
});

test('cloud answers stay authoritative if browser storage could not be updated',async()=>{
  const old={'tmua-2020-p2':paper(2,{1:record(0,false)})};
  const app=await harness(old);
  app.emit('tmua-cloud-applied',{payload:{library:{'tmua-2020-p2':paper(2,{1:record(0,true)})}},persistence:{library:false}});
  assert.match(panel(app,2),/After practice: 1 solved out of 1 attempted/);
  app.storage(old);
  assert.match(panel(app,2),/After practice: 1 solved out of 1 attempted/);
  app.emit('tmua-cloud-applied',{payload:{library:old},persistence:{library:true}});
  app.storage({'tmua-2020-p2':paper(2,{1:record(1,true)})});
  assert.match(panel(app,2),/On your own: 1 solved out of 1 attempted/);
});

test('in-memory answers still render when storage is blocked; map errors disclose the problem',async()=>{
  const app=await harness(undefined,{blocked:true});
  app.emit('tmua-local-updated',{kind:'library',value:{'tmua-2020-p2':paper(2,{1:record(1,true)})}});
  assert.match(panel(app,2),/On your own: 1 solved out of 1 attempted/);
  const failed=await harness({}, {fetchFail:true});
  assert.match(panel(failed,1),/could not be loaded/);
  assert.doesNotMatch(panel(failed,1),/concepts-track/);
});

const require=createRequire(import.meta.url);
let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch(_){}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});

test('browser: partial concept bars are accessible, responsive and update after a cloud retry', {skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),{key,value:{'tmua-2020-p2':paper(2,{1:record(0,false),2:record(1,true),3:record(0,false),4:record(0,false)})}});
  await context.route('https://concepts.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('concepts.js'))return route.fulfill({contentType:'text/javascript',body:js});
    if(pathname.endsWith('concepts.css'))return route.fulfill({contentType:'text/css',body:css});
    if(pathname.endsWith('site.css'))return route.fulfill({contentType:'text/css',body:siteCss});
    if(pathname.endsWith('concept-map.json'))return route.fulfill({contentType:'application/json',body:JSON.stringify(conceptMap)});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/concepts.css"><main style="padding:16px"><section id="concepts-section"></section></main><script src="assets/concepts.js"></script>'});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('https://concepts.test/study/');
    await page.locator('#concepts-panel-2 .concepts-card').first().waitFor();
    assert.equal(await page.locator('#concepts-panel-2 .concepts-card').count(),4);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.equal(await page.locator('#concepts-tab-2').getAttribute('aria-selected'),'true');
    await page.locator('#concepts-tab-2').focus();await page.keyboard.press('Home');
    assert.equal(await page.locator('#concepts-tab-1').getAttribute('aria-selected'),'true');
    await page.keyboard.press('End');
    await page.locator('#concepts-panel-2 summary').first().click();
    assert.match(await page.locator('#concepts-panel-2 details').first().innerText(),/First answer incorrect/);
    await page.evaluate(value=>document.dispatchEvent(new CustomEvent('tmua-cloud-applied',{detail:{payload:{library:value},persistence:{library:false}}})),{'tmua-2020-p2':paper(2,{1:record(0,true),2:record(1,true),3:record(0,false),4:record(0,false)})});
    assert.match(await page.locator('#concepts-panel-2').innerText(),/1 more solved after practice/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
