import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {before, after} from 'node:test';
import vm from 'node:vm';
import {discoverPapers} from '../tools/build-site.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const analytics=await readFile(path.join(root,'assets/progress-analytics.js'),'utf8');
const js=await readFile(path.join(root,'assets/concepts.js'),'utf8');
const css=await readFile(path.join(root,'assets/concepts.css'),'utf8');
const siteCss=await readFile(path.join(root,'assets/site.css'),'utf8');
const indexHtml=await readFile(path.join(root,'index.html'),'utf8');
const conceptMap=JSON.parse(await readFile(path.join(root,'assets/concept-map.json'),'utf8'));
const catalogue=JSON.parse(await readFile(path.join(root,'assets/studied-concepts.json'),'utf8'));
const totalConcepts=84+(catalogue.additionalConcepts||[]).length;

const learningFixture={id:'p1-extra-render-fixture',paper:1,title:'Read fractions and powers',
  knowledge:['A fraction is \\(\\frac{1}{2}\\). Treat <img src=x onerror=alert(1)> as text.'],
  references:[{type:'syllabus',label:'Official syllabus',url:'https://example.test/syllabus.pdf'}],syllabusCodes:['M4.1'],
  example:{question:'Find \\(2^3\\).',steps:['Multiply \\(2^3\\) out.'],answer:'Eight.'},pitfall:'Keep the denominator in \\(\\frac{1}{2}\\).',
  math:{version:1,expressions:{'\\frac{1}{2}':{tag:'math',attrs:{display:'inline'},children:[{tag:'mfrac',children:[{tag:'mn',children:['1']},{tag:'mn',children:['2']}]}]},'2^3':{tag:'math',children:[{tag:'msup',children:[{tag:'mn',children:['2']},{tag:'mn',children:['3']}]}]}}}};
const withLearning={...catalogue,additionalConcepts:[...(catalogue.additionalConcepts||[]),learningFixture]};
const libraryKey='tmua-practice-library-v1:/study/';
const historyKey='tmua-attempt-history-v1:/study/';
const blank=()=>({first:null,firstKind:null,everSolved:false});
const record=(first,everSolved,firstKind='answer')=>({first,firstKind,...(everSolved===undefined?{}:{everSolved})});
function paper(results={},extra={}) {
  return {version:1,updatedAt:'2026-09-30T11:00:00Z',state:{version:1,contentRevision:1,records:Array.from({length:20},(_,i)=>results[i+1]||blank())},...extra};
}
function archived(results={},extra={}) { return {id:'guided:tmua-2020-p1:first',paperId:'tmua-2020-p1',source:'guided',...paper(results),...extra}; }
async function harness(initial={},options={}) {
  const stored=new Map([[libraryKey,JSON.stringify(initial)],[historyKey,JSON.stringify({version:1,attempts:options.history||[]})]]);
  const nodes=new Map(), documentEvents=new Map(), windowEvents=new Map();
  const document={activeElement:null};
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:false,dataset:{},attributes:{},events:{},classList:{add(){}},setAttribute(name,value){this.attributes[name]=value;},focus(){document.activeElement=this;},scrollIntoView(){this.scrolled=true;},addEventListener(type,listener){(this.events[type]||=[]).push(listener);}});
    return nodes.get(id);
  };
  Object.assign(document,{getElementById:node,addEventListener(type,listener){documentEvents.set(type,listener);}});
  const window={location:new URL('https://concepts.test/study/#concepts'),addEventListener(type,listener){windowEvents.set(type,listener);}};
  const requests=[];
  vm.runInNewContext(analytics+'\n'+js,{document,window,URL,Date,localStorage:{getItem(key){if(options.blocked)throw Error('Storage unavailable');return stored.get(key)||null;}},fetch:async(url,args)=>{requests.push({url:String(url),args});if(options.fetchFail)throw Error('Offline');return {ok:true,json:async()=>String(url).endsWith('studied-concepts.json')?(options.catalogue||catalogue):(options.map||conceptMap)};}});
  await new Promise(resolve=>setImmediate(resolve));
  return {node,document,requests,emit(type,detail){documentEvents.get(type)?.({detail});},storage(key,value){stored.set(key,JSON.stringify(value));windowEvents.get('storage')({key});},event(type,event){for(const listener of node('concepts-section').events[type]||[])listener(event);},route(hash){window.location.hash=hash;window.TmuaConcepts.route();}};
}
const panel=(app,paper)=>app.node(`concepts-panel-${paper}`).innerHTML;
function card(app,id) { return (panel(app,1)+panel(app,2)).match(new RegExp(`<article class="concepts-card" data-concept="${id}"[\\s\\S]*?<\\/article>`))?.[0] || ''; }
function score(app,id) { const value=card(app,id).match(/data-score="([\d.]+)"/);return value?Number(value[1]):null; }

test('all guided originals map to real booklet lessons and exact reprints share their canonical identity',async()=>{
  const bank=JSON.parse(await readFile(path.join(root,'content/official-question-bank.json'),'utf8')).questions;
  const studied=JSON.parse(await readFile(path.join(root,'content/studied-lessons.json'),'utf8')).booklets;
  const expected=studied.flatMap(booklet=>booklet.lessons.map(lesson=>({id:lesson.id,paper:booklet.paper,booklet:booklet.booklet,bookletTitle:booklet.bookletTitle,lesson:lesson.number,title:lesson.title,pdfPage:lesson.pdfPage,printedPage:lesson.printedPage||lesson.pdfPage,knowledge:lesson.knowledge})));
  assert.deepEqual(catalogue.lessons,expected);assert.equal(catalogue.lessons.length,84);
  const published=(await discoverPapers(root)).catalog.papers.filter(paper=>paper.questionCount===20);
  assert.deepEqual(conceptMap.papers.map(paper=>paper.id).sort(),published.map(paper=>paper.id).sort());
  for(const mapped of conceptMap.papers){
    const plan=JSON.parse(await readFile(path.join(root,`content/${mapped.id}-plan.json`),'utf8'));
    assert.deepEqual(mapped.questions.map(q=>q.sourceId),plan.groups.map(group=>group.originalId));
    for(const q of mapped.questions){
      assert.equal(q.knowledgePattern,bank[q.sourceId].knowledgePattern);
      assert.deepEqual(q.lessonIds,bank[q.sourceId].conceptIds);
      assert.ok(q.lessonIds.every(id=>[...catalogue.lessons,...(catalogue.additionalConcepts||[])].some(lesson=>lesson.id===id)));
      assert.equal(q.canonicalSourceId,q.sourceId==='2019-P2-Q02'?'2020-P1-Q02':q.sourceId);
    }
  }
});

test('Practice and Concepts are separate top tabs, with no Concepts card in the progress sidebar',async()=>{
  assert.match(indexHtml,/<a id="course-tab-papers" href="#practice">Practice<\/a>/);
  assert.match(indexHtml,/<a id="course-tab-concepts" href="#concepts">Concepts<\/a>/);
  assert.doesNotMatch(indexHtml.match(/<aside id="progress-dashboard"[\s\S]*?<\/aside>/)[0],/concepts-section/);
  assert.match(indexHtml,/<details id="guided-library"[^>]*hidden>/);
  assert.match(css,/#guided-library\{display:none\}/);
  const app=await harness();
  assert.equal(app.node('concepts-section').hidden,false);assert.equal(app.node('course-layout').hidden,true);
  assert.equal(app.node('course-tab-concepts').attributes['aria-current'],'page');
  app.route('#practice');
  assert.equal(app.node('concepts-section').hidden,true);assert.equal(app.node('course-layout').hidden,false);
  assert.equal(app.node('course-tab-papers').attributes['aria-current'],'page');
});

test('every studied lesson appears and unattempted/manual scores never become zero or inflated evidence',async()=>{
  const app=await harness({'tmua-2020-p1':{version:1,progress:{firstCorrect:20,firstAttempted:20}},'jz-mock-d-p1-preview':paper({1:record(1,true)})},{history:[{...archived({1:record(1,true)}),source:'manual'}]});
  const html=panel(app,1)+panel(app,2);
  assert.equal((html.match(/class="concepts-card"/g)||[]).length,totalConcepts);
  assert.equal((html.match(/>Not yet tested</g)||[]).length,totalConcepts);
  assert.doesNotMatch(html,/data-score=|role="img"/);
  assert.match(card(app,'p1-b1-l01'),/Paper 1 · Booklet 1 · Lesson 1 · p. 3/);
  assert.match(card(app,'p1-b1-l01'),/Factor numerators and denominators/);
  assert.equal(app.requests.length,2);assert.ok(app.requests.every(request=>request.args.cache==='no-cache'));
});

test('independent, hinted, solution, retry and unresolved evidence receive 100, 50, 25, 25 and 0',async()=>{
  for(const [outcome,log,expected] of [
    [record(1,true),{},100],
    [record(0,true,'hint'),{solvedWithHints:true,solutionSeenBeforeSolve:false},50],
    [record(0,true,'hint'),{solvedWithHints:false,solutionSeenBeforeSolve:true},25],
    [record(0,true),{},25],
    [record(0,false),{},0],
    [record(0,true,'hint'),{},25]
  ]) {
    const app=await harness({'tmua-2020-p1':paper({1:outcome},{answerLog:[{questionIndex:0,...log}]})});
    assert.equal(score(app,'p1-b1-l18'),expected);
    assert.equal(score(app,'p1-b1-l01'),expected,'a question contributes to every lesson it tests');
    assert.match(card(app,'p1-b1-l18'),/1 unique question/);
    assert.match(card(app,'p1-b1-l18'),/Building evidence/);
  }
});

test('the denominator is unique attempted original questions and partial scores produce a real percentage',async()=>{
  const app=await harness({'tmua-2020-p1':paper({1:record(1,true),2:record(0,true,'hint')},{answerLog:[{questionIndex:1,solvedWithHints:true,solutionSeenBeforeSolve:false}]})});
  assert.equal(score(app,'p1-b1-l01'),75);
  assert.match(card(app,'p1-b1-l01'),/75% weighted practice indicator from 2 unique questions/);
  assert.match(card(app,'p1-b1-l01'),/Simplify a quotient to fractional powers before differentiation/);
  assert.match(app.node('concepts-section').innerHTML,/not a TMUA grade/);
  assert.match(app.node('concepts-section').innerHTML,/cannot identify which particular step/);
});

test('viewing hints or the full solution after correct first success never reduces credit',async()=>{
  const app=await harness({'tmua-2020-p1':paper({1:{...record(1,true),solutionShown:true,hintsUsed:3}},{answerLog:[{questionIndex:0,firstCorrect:1,solutionViewed:true,assisted:true,hintCount:3,solvedWithHints:false,solutionSeenBeforeSolve:false}]})});
  assert.equal(score(app,'p1-b1-l18'),100);
});

test('completed and unfinished history snapshots survive a fresh run; repeated success adds only partial credit',async()=>{
  const first=archived({1:record(0,false)},{startedAt:'2026-09-28T09:00:00Z',updatedAt:'2026-09-28T10:00:00Z',completedAt:null,finished:false,attemptNumber:1,progress:{attemptId:'first'}});
  const current=paper({1:record(1,true)},{attemptNumber:2,progress:{attemptId:'second',startedAt:'2026-09-30T10:00:00Z'}});
  const app=await harness({'tmua-2020-p1':current},{history:[first]});
  assert.equal(score(app,'p1-b1-l18'),25);
  assert.match(card(app,'p1-b1-l18'),/1 unique question/);
  assert.match(card(app,'p1-b1-l18'),/repeated encounter/);
  const noArchive=await harness({'tmua-2020-p1':current});
  assert.equal(score(noArchive,'p1-b1-l18'),25,'known repeat without historical detail cannot pretend to be a new independent encounter');
});

test('two snapshots of the same sitting merge into one current result and hints retain 50 points',async()=>{
  const past=archived({1:record(0,false,'hint')},{startedAt:'2026-09-30T09:00:00Z',updatedAt:'2026-09-30T10:00:00Z',progress:{attemptId:'first'}});
  const current=paper({1:record(0,true,'hint')},{startedAt:'2026-09-30T09:00:00Z',updatedAt:'2026-09-30T11:00:00Z',progress:{attemptId:'first'},answerLog:[{questionIndex:0,solvedWithHints:true,solutionSeenBeforeSolve:false}]});
  const app=await harness({'tmua-2020-p1':current},{history:[past]});
  assert.equal(score(app,'p1-b1-l18'),50);
  assert.match(card(app,'p1-b1-l18'),/1 unique question/);
});

test('the identical 2019 P2 Q2 and 2020 P1 Q2 count once, including independent-credit protection',async()=>{
  const app=await harness({
    'tmua-2019-p2':paper({2:record(0,false)},{updatedAt:'2026-09-28T11:00:00Z',progress:{attemptId:'old',startedAt:'2026-09-28T10:00:00Z'}}),
    'tmua-2020-p1':paper({2:record(1,true)},{progress:{attemptId:'new',startedAt:'2026-09-30T10:00:00Z'}})
  });
  assert.equal(score(app,'p1-b4-l02'),25);
  assert.match(card(app,'p1-b4-l02'),/1 unique question/);
  assert.match(card(app,'p1-b4-l02'),/2019-P2-Q02/);
  assert.match(card(app,'p1-b4-l02'),/counted once/);
});

test('confidence status needs at least three unique questions and uses the weighted percentage',async()=>{
  const app=await harness({'tmua-2020-p1':paper({1:record(1,true),2:record(1,true),7:record(1,true)})});
  assert.match(card(app,'p1-b1-l01'),/>Strong so far</);
  app.emit('tmua-local-updated',{kind:'library',value:{'tmua-2020-p1':paper({1:record(1,true),2:record(1,true),7:record(0,false)})}});
  assert.equal(score(app,'p1-b1-l01'),66.7);
  assert.match(card(app,'p1-b1-l01'),/>Needs practice</);
});

test('malformed records and incompatible revisions are ignored without inventing scores',async()=>{
  const app=await harness({'tmua-2020-p2':paper({1:record(1,false),2:record(2,true),3:record(1,true,'hint'),4:record(0,'yes'),5:record(null,true)}),'tmua-2020-p1':paper({1:record(1,true)},{state:{...paper().state,contentRevision:99}})});
  assert.doesNotMatch(panel(app,1)+panel(app,2),/data-score=/);
});

test('account changes clear all old library and history evidence; failed persistence cannot resurrect it',async()=>{
  const old={'tmua-2020-p1':paper({1:record(1,true)})};
  const app=await harness(old,{history:[archived({2:record(1,true)})]});
  app.emit('tmua-cloud-lock',{});
  assert.doesNotMatch(panel(app,1),/data-score=/);
  app.storage(libraryKey,old);
  assert.doesNotMatch(panel(app,1),/data-score=/);
  app.emit('tmua-cloud-applied',{payload:{library:{},history:{version:1,attempts:[]}},persistence:{library:false,history:false}});
  app.storage(historyKey,{version:1,attempts:[archived({1:record(1,true)})]});
  assert.doesNotMatch(panel(app,1),/data-score=/);
  app.emit('tmua-cloud-applied',{payload:{library:old,history:{version:1,attempts:[]}},persistence:{library:true,history:true}});
  assert.equal(score(app,'p1-b1-l18'),100);
});

test('local history updates and blocked browser storage work; fetch errors are visible',async()=>{
  const app=await harness({}, {blocked:true});
  app.emit('tmua-history-updated',{attempts:[archived({1:record(0,true)})]});
  assert.equal(score(app,'p1-b1-l18'),25);
  app.emit('tmua-local-updated',{kind:'library',value:{'tmua-2020-p1':paper({2:record(1,true)})}});
  assert.equal(score(app,'p1-b4-l02'),100);
  const failed=await harness({}, {fetchFail:true});
  assert.match(panel(failed,1),/could not be loaded/);
});

test('paper concept tabs support keyboard navigation with a single active tab',async()=>{
  const app=await harness();let prevented=false;
  app.event('keydown',{target:{closest(){return {dataset:{conceptsPaper:'1'}};}},key:'End',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(app.document.activeElement.id,'concepts-tab-2');
  assert.equal(app.node('concepts-tab-1').tabIndex,-1);assert.equal(app.node('concepts-tab-2').tabIndex,0);
  assert.equal(app.node('concepts-panel-2').hidden,false);
});

const require=createRequire(import.meta.url);
let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch(_){}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});

test('browser: dedicated lesson cards are responsive, accessible, and clear immediately on account change', {skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),{key:libraryKey,value:{'tmua-2020-p1':paper({1:record(0,true,'hint')},{answerLog:[{questionIndex:0,solvedWithHints:true,solutionSeenBeforeSolve:false}]})}});
  await context.route('https://concepts.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('progress-analytics.js'))return route.fulfill({contentType:'text/javascript',body:analytics});
    if(pathname.endsWith('concepts.js'))return route.fulfill({contentType:'text/javascript',body:js});
    if(pathname.endsWith('concepts.css'))return route.fulfill({contentType:'text/css',body:css});
    if(pathname.endsWith('site.css'))return route.fulfill({contentType:'text/css',body:siteCss});
    if(pathname.endsWith('concept-map.json'))return route.fulfill({contentType:'application/json',body:JSON.stringify(conceptMap)});
    if(pathname.endsWith('studied-concepts.json'))return route.fulfill({contentType:'application/json',body:JSON.stringify(withLearning)});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/site.css"><link rel="stylesheet" href="assets/concepts.css"><main><nav class="course-nav"><a id="course-tab-papers" href="#practice">Practice</a><a id="course-tab-concepts" href="#concepts">Concepts</a></nav><div id="course-layout">Practice route</div><section id="concepts-section"></section></main><script src="assets/progress-analytics.js"></script><script src="assets/concepts.js"></script>'});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('https://concepts.test/study/#concepts');
    await page.locator('[data-concept="p1-b1-l18"][data-score="50"]').waitFor();
    assert.equal(await page.locator('.concepts-card').count(),totalConcepts+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.locator('#concepts-tab-1').focus();await page.keyboard.press('End');
    assert.equal(await page.locator('#concepts-tab-2').getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');
    await page.locator('[data-concept="p1-b1-l18"] summary').click();
    assert.match(await page.locator('[data-concept="p1-b1-l18"] details').innerText(),/Correct with hints/);
    await page.locator('[data-concepts-extra="1"]').click();
    assert.match(page.url(),/#concepts$/);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'concepts-extra-heading-1');
    const learning=page.locator('[data-concept="p1-extra-render-fixture"]');
    await learning.locator('summary').click();
    assert.equal(await learning.locator('details').getAttribute('open'),'');
    assert.equal(await learning.locator('math').first().evaluate(node=>node.namespaceURI),'http://www.w3.org/1998/Math/MathML');
    assert.ok(await learning.locator('mfrac').first().evaluate(node=>node.getBoundingClientRect().height)>10);
    assert.equal(await learning.locator('img,script').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await learning.scrollIntoViewIfNeeded();
    await page.screenshot({path:'/tmp/tmua-concept-learning-mobile.png',fullPage:false});
    for (const number of [1,2]) {
      await page.locator(`#concepts-tab-${number}`).click();
      await page.locator(`#concepts-panel-${number} [data-concept*="-extra-"] details`).evaluateAll(nodes=>nodes.forEach(node=>{node.open=true;}));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`all Paper ${number} learning formulas fit a mobile viewport`);
    }
    await page.locator('#concepts-tab-1').click();
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('tmua-cloud-lock')));
    assert.equal(await page.locator('[data-score]').count(),0);
    await page.locator('#course-tab-papers').click();
    await page.locator('#concepts-section').waitFor({state:'hidden'});
    assert.equal(await page.locator('#concepts-section').isVisible(),false);
    assert.equal(await page.locator('#course-layout').isVisible(),true);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});


test('new syllabus concepts can be tracked without inventing booklet lessons',async()=>{
  const extra={id:'p1-extra-test-concept',paper:1,title:'Additional test concept',knowledge:['A reviewed mathematical step.'],references:[{type:'syllabus',label:'TMUA specification · tested section',url:'https://uat-wp.s3.eu-west-2.amazonaws.com/TMUA_Content_Specification.pdf'}]};
  const custom=structuredClone(catalogue);custom.additionalConcepts=[...(catalogue.additionalConcepts||[]),extra];
  const map=structuredClone(conceptMap);map.version=1;delete map.assessmentMappings;map.papers[0].questions[0].lessonIds.push(extra.id);
  const app=await harness({}, {catalogue:custom,map});
  assert.match(panel(app,1),/Beyond the booklets/);
  assert.match(card(app,extra.id),/New learning/);
  assert.match(card(app,extra.id),/TMUA specification/);
  assert.doesNotMatch(card(app,extra.id),/Booklet undefined|Lesson undefined/);
  assert.equal(score(app,extra.id),null);
  assert.equal((panel(app,1)+panel(app,2)).match(/class="concepts-card"/g).length,totalConcepts+1);
  const answered=await harness({[map.papers[0].id]:paper({1:record(0,true,'hint')},{answerLog:[{questionIndex:0,solvedWithHints:true,solutionSeenBeforeSolve:false}]})},{catalogue:custom,map});
  assert.equal(score(answered,extra.id),50,'additional concepts use the same partial credit');
});

test('additional concepts require provenance and safe reference URLs',async()=>{
  for(const references of [[],[{type:'blog',label:'Unsupported',url:'https://example.com'}],[{type:'question',label:'Unsafe',url:'javascript:alert(1)'}]]){
    const custom=structuredClone(catalogue);custom.additionalConcepts=[{id:'p2-extra-test',paper:2,title:'Additional',knowledge:['Step'],references}];
    const app=await harness({}, {catalogue:custom});
    assert.match(panel(app,2),/could not be loaded/);
  }
});


test('additional learning renders native MathML, worked steps, pitfalls and references without changing the route',async()=>{
  const app=await harness({}, {catalogue:withLearning});
  const html=card(app,learningFixture.id);
  assert.match(html,/<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html,/<mfrac><mn>1<\/mn><mn>2<\/mn><\/mfrac>/);
  assert.match(html,/Worked example/);assert.match(html,/<ol>/);assert.match(html,/Watch out/);assert.match(html,/Official syllabus/);
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script|<details open/);
  assert.match(panel(app,1),/mathematical knowledge also applies to Paper 2/);
  assert.match(panel(app,2),/focuses on mathematical reasoning/);
  app.event('click',{target:{closest(selector){return selector==='[data-concepts-extra]'?{dataset:{conceptsExtra:'1'}}:null;}}});
  assert.equal(app.document.activeElement.id,'concepts-extra-heading-1');
  assert.equal(app.node('concepts-extra-heading-1').scrolled,true);
  assert.equal(app.node('concepts-section').hidden,false);
});

test('math AST and learning metadata reject executable markup and malformed optional fields',()=>{
  const window={};vm.runInNewContext(analytics,{window,URL,Date});
  const api=window.TmuaProgressAnalytics;
  for(const attack of [
    {tag:'script',children:['alert(1)']},
    {tag:'math',children:[{tag:'annotation-xml',children:['<img>']}]},
    {tag:'math',attrs:{onclick:'alert(1)'}},
    {tag:'math',attrs:{href:'https://example.test'}},
    {tag:'math',attrs:{style:'color:red'}},
    {tag:'math',children:[{tag:'mi',attrs:{mathvariant:'normal" onclick="bad'},children:['x']}]}
  ]){
    const concept=structuredClone(learningFixture);concept.math.expressions['2^3']=attack;
    assert.throws(()=>api.validateLessons({...catalogue,additionalConcepts:[concept]}),/compiled concept math/);
    assert.doesNotMatch(api.learningText('\\(2^3\\)',concept),/<math|<script|onclick=/);
  }
  for(const fields of [{example:{question:'?',steps:[],answer:'x'}},{pitfall:3},{syllabusCodes:['<script>']}]){
    assert.throws(()=>api.validateLessons({...catalogue,additionalConcepts:[{...learningFixture,...fields}]}));
  }
  const text=api.learningText('Read \\(x<2\\) and <b>plain text</b>.',{});
  assert.match(text,/x&lt;2/);assert.match(text,/&lt;b&gt;plain text/);assert.doesNotMatch(text,/<b>/);
});


test('unmapped saved edition shows concept notice and clears safely on account change',async()=>{
  const app=await harness({'tmua-2020-p1':paper({1:record(1,true)},{teachingEdition:'missing-review'})});
  assert.match(panel(app,1),/concept progress is temporarily unavailable/);
  assert.match(panel(app,1),/saved answers and paper scores are unchanged/);
  assert.doesNotMatch(panel(app,1),/data-score=/);
  app.emit('tmua-cloud-lock');
  assert.doesNotMatch(panel(app,1),/temporarily unavailable/);
  assert.match(panel(app,1),/Not yet tested/);
});
