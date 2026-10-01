import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {mappingHash,validateMappingData} from '../tools/validate-concept-mappings.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>readFile(path.join(root,name),'utf8');
const analytics=await read('assets/progress-analytics.js');
const publishedAnalytics=await read('tests/fixtures/progress-analytics-published-dbb92eb.js');
const production=JSON.parse(await read('assets/concept-map.json'));
const catalogue=JSON.parse(await read('assets/studied-concepts.json'));
const clone=v=>JSON.parse(JSON.stringify(v));
function api(script=analytics){const window={};vm.runInNewContext(script,{window,URL,Date});return window.TmuaProgressAnalytics;}
const A='p1-b1-l01',B='p1-b1-l02',C='p1-b1-l03';
const lessons=[A,B,C].map(id=>({id,paper:1}));
const q=(sourceId,lessonIds,canonicalSourceId=sourceId)=>({sourceId,canonicalSourceId,lessonIds,knowledgePattern:`Knowledge ${sourceId}`});
const p=(id,questions)=>({id,paper:1,title:id,version:1,contentRevisions:[1],questions});
function fixture(oldIds=[A,B],newIds=[A],{reprint=false}={}){
  const old=[p('test-p1',[q('2020-P1-Q01',oldIds),q('2020-P1-Q02',[C])])];
  const current=[p('test-p1',[q('2020-P1-Q01',newIds),q('2020-P1-Q02',[C])])];
  if(reprint){old.push(p('test-p2',[q('2019-P2-Q01',oldIds,'2020-P1-Q01'),q('2019-P2-Q02',[C])]));current.push(p('test-p2',[q('2019-P2-Q01',newIds,'2020-P1-Q01'),q('2019-P2-Q02',[C])]));}
  const versions=[{id:'old',papers:old},{id:'new',papers:current}].map(v=>({...v,sha256:mappingHash(v.papers)}));
  return {version:2,papers:current,assessmentMappings:{version:1,versions,editionBindings:current.flatMap(paper=>[{paperId:paper.id,teachingEdition:'original',mappingVersion:'old'},{paperId:paper.id,teachingEdition:'old-review',mappingVersion:'old'},{paperId:paper.id,teachingEdition:'new-review',mappingVersion:'new'}])}};
}
const blank=()=>({first:null,firstKind:null,everSolved:false});
const correct=()=>({first:1,firstKind:'answer',everSolved:true});
const wrong=()=>({first:0,firstKind:'answer',everSolved:false});
const sitting=(pin='original',r=correct(),extras={})=>({version:1,updatedAt:'2026-09-30T12:00:00Z',startedAt:'2026-09-30T11:00:00Z',teachingEdition:pin,attemptNumber:1,state:{version:1,contentRevision:1,records:[r,blank()]},...extras});
const history=saved=>({...saved,id:'guided:test-p1:first',paperId:'test-p1',source:'guided',attemptContext:'first'});
function evaluate(map,library={},history=[]){const a=api();return a.evidence({papers:a.validateMap(map),lessons,library,history});}
const row=(rows,id)=>rows.find(r=>r.id===id);
const simple=rows=>rows.map(({id,total,score,questions})=>({id,total,score,questions:questions.map(q=>({...q,lessonIds:[...q.lessonIds],sources:[...q.sources]}))}));

test('published legacy map and analytics retain exact scores, labels, source sets and denominators',()=>{
  const baseline=production.assessmentMappings.versions.find(v=>v.id==='published-dbb92eb');
  assert.equal(baseline.sha256,'09798f85445100fd84d5dbcf89b83a71500c153c06897a3d6fbbccd5ad0e5cfc');
  const old=api(publishedAnalytics),now=api(),oldPapers=old.validateMap({version:1,papers:baseline.papers}),papers=now.validateMap(production);
  const allLessons=now.validateLessons(catalogue),library={},archived=[];
  baseline.papers.forEach((paper,j)=>{
    const records=paper.questions.map((q,i)=>i%5===0?correct():i%5===1?{first:0,firstKind:'hint',everSolved:true}:i%5===2?wrong():i%5===3?{first:0,firstKind:'answer',everSolved:true}:blank());
    const saved={...sitting(j%2?'review-20260930':undefined),state:{version:1,contentRevision:1,records},answerLog:[{questionIndex:1,solvedWithHints:true,solutionSeenBeforeSolve:false}],updatedAt:`2026-09-${10+j}T12:00:00Z`};
    library[paper.id]=saved;
    archived.push({...saved,id:`guided:${paper.id}:first`,paperId:paper.id,source:'guided',state:{...saved.state,records:records.map(r=>r.first===null?r:wrong())},updatedAt:'2026-09-01T12:00:00Z'});
  });
  const before=JSON.stringify({library,archived});
  assert.deepEqual(JSON.parse(JSON.stringify(simple(now.evidence({papers,lessons:allLessons,library,history:archived})))),JSON.parse(JSON.stringify(simple(old.evidence({papers:oldPapers,lessons:allLessons,library,history:archived})))));
  assert.equal(JSON.stringify({library,archived}),before);
});

test('missing historical pin and explicit old pin use preserved A+B; new pin uses corrected A',()=>{
  for(const pin of [undefined,'original','old-review']){const rows=evaluate(fixture(),{'test-p1':sitting(pin)});assert.equal(row(rows,A).score,100);assert.equal(row(rows,B).score,100);}
  const rows=evaluate(fixture(),{'test-p1':sitting('new-review')});assert.equal(row(rows,A).score,100);assert.equal(row(rows,B).score,null);
});

test('old success retains removed concept and old failure retains its denominator after corrected retry',()=>{
  for(const [first,expected] of [[correct(),100],[wrong(),0]]){
    const old=history(sitting('old-review',first));
    const current=sitting('new-review',correct(),{attemptNumber:2,startedAt:'2026-10-01T12:00:00Z'});
    const rows=evaluate(fixture(),{'test-p1':current},[old]);
    assert.equal(row(rows,A).score,expected===100?100:25);assert.equal(row(rows,B).score,expected);assert.equal(row(rows,B).total,1);
  }
});

test('new concept on repeated edition gets partial credit only and never appears before evidence',()=>{
  const map=fixture([A],[A,C]),old=history(sitting('old-review'));
  assert.equal(row(evaluate(map,{},[old]),C).score,null);
  const rows=evaluate(map,{'test-p1':sitting('new-review',correct(),{attemptNumber:2,startedAt:'2026-10-01T12:00:00Z'})},[old]);
  assert.equal(row(rows,A).score,100);assert.equal(row(rows,C).score,25);assert.equal(row(rows,C).total,1);
});

test('cross-paper exact reprints keep canonical independence across mapping versions',()=>{
  const map=fixture([A],[A,C],{reprint:true}),old=history(sitting('old-review',wrong()));
  const rows=evaluate(map,{'test-p2':sitting('new-review',correct(),{startedAt:'2026-10-01T12:00:00Z'})},[old]);
  assert.equal(row(rows,A).score,25);assert.equal(row(rows,A).total,1);assert.equal(row(rows,C).score,25);
  assert.equal(row(rows,A).questions[0].sources.size,2);
});

test('adding an unattempted alias cannot inflate old mappings or evidence',()=>{
  const map=fixture([A],[A,C],{reprint:true});
  const rows=evaluate(map,{'test-p1':sitting('old-review')});
  assert.equal(row(rows,A).score,100);assert.equal(row(rows,C).score,null);
});

test('same sitting merges current/history once with the authoritative saved pin',()=>{
  const old=history(sitting('old-review',wrong(),{progress:{attemptId:'first'}}));
  const current=sitting('new-review',correct(),{progress:{attemptId:'first'},updatedAt:'2026-10-01T12:00:00Z'});
  const rows=evaluate(fixture(),{'test-p1':current},[old]);
  assert.equal(row(rows,A).score,100);assert.equal(row(rows,A).total,1);assert.equal(row(rows,B).score,null);
});

test('100/50/25/0 weights, recap behaviour and missing help timing are unchanged',()=>{
  for(const [record,log,score] of [[correct(),{solutionSeenBeforeSolve:true},100],[{first:0,everSolved:true,firstKind:'hint'},{solvedWithHints:true,solutionSeenBeforeSolve:false},50],[{first:0,everSolved:true},{solutionSeenBeforeSolve:true},25],[{first:0,everSolved:true},{},25],[wrong(),{},0]]){
    const rows=evaluate(fixture(),{'test-p1':sitting('new-review',record,{answerLog:[{questionIndex:0,...log}]})});assert.equal(row(rows,A).score,score);
  }
});

test('unknown answered edition fails visibly rather than guessing or inventing zero; blanks ignored',()=>{
  assert.throws(()=>evaluate(fixture(),{'test-p1':sitting('missing-review')}),e=>e.code==='CONCEPT_MAPPING_UNAVAILABLE');
  const rows=evaluate(fixture(),{'test-p1':sitting('missing-review',blank())});assert.equal(row(rows,A).score,null);
});

test('unknown historical concepts, duplicate versions/bindings, missing maps and changed source identity reject',()=>{
  const a=api();
  for(const change of [m=>m.assessmentMappings.versions.push(clone(m.assessmentMappings.versions[0])),m=>m.assessmentMappings.editionBindings.push(clone(m.assessmentMappings.editionBindings[0])),m=>m.assessmentMappings.editionBindings[0].mappingVersion='missing',m=>m.assessmentMappings.versions[0].papers[0].questions.reverse(),m=>m.assessmentMappings.versions[0].papers[0].questions[0].canonicalSourceId='OTHER']){const m=fixture();change(m);assert.throws(()=>a.validateMap(m));}
  const m=fixture();m.assessmentMappings.versions[0].papers[0].questions[0].lessonIds=['p1-extra-unknown'];assert.throws(()=>a.validateMappedLessons(a.validateMap(m),lessons),/Unknown concept/);
});

test('mapping gate preserves hashes/bindings, requires every published edition and current parity',()=>{
  const map=fixture(),base={map,locks:{version:1,versions:map.assessmentMappings.versions.map(({id,sha256})=>({id,sha256})),editionBindings:clone(map.assessmentMappings.editionBindings)},published:{papers:[{id:'test-p1'}]},editions:{editions:[{paperId:'test-p1',editionId:'old-review'},{paperId:'test-p1',editionId:'new-review'}]},catalogue:{version:1,lessons:catalogue.lessons,additionalConcepts:[]},analytics};
  assert.equal(validateMappingData(base).bindings,3);
  for(const change of [b=>b.map.assessmentMappings.versions[0].papers[0].questions[0].lessonIds=[C],b=>b.locks.editionBindings[0].mappingVersion='new',b=>b.editions.editions.push({paperId:'test-p1',editionId:'missing-review'}),b=>b.map.papers[0].questions[0].lessonIds=[C]]){const b=clone(base);change(b);assert.throws(()=>validateMappingData(b));}
  const prior=clone(base.locks),changed=clone(base);changed.map.assessmentMappings.editionBindings[0].mappingVersion='new';changed.locks.editionBindings[0].mappingVersion='new';assert.throws(()=>validateMappingData({...changed,priorLocks:prior}),/previously published binding changed/);
  changed.map.assessmentMappings.editionBindings=clone(map.assessmentMappings.editionBindings);changed.locks.editionBindings=clone(map.assessmentMappings.editionBindings);changed.map.assessmentMappings.versions[0].papers[0].questions[0].lessonIds=[C];const v=changed.map.assessmentMappings.versions[0];v.sha256=mappingHash(v.papers);changed.locks.versions[0].sha256=v.sha256;assert.throws(()=>validateMappingData({...changed,priorLocks:prior}),/previously published mapping changed/);
});

test('cloud-equivalent snapshots and separate accounts remain read-only and isolated',()=>{
  const map=fixture(),student={'test-p1':sitting('old-review')},manager={'test-p1':sitting('new-review',wrong())};
  const before=JSON.stringify({map,student,manager});
  assert.deepEqual(JSON.parse(JSON.stringify(simple(evaluate(map,student)))),JSON.parse(JSON.stringify(simple(evaluate(map,clone(student))))));
  assert.equal(row(evaluate(map,manager),A).score,0);assert.equal(row(evaluate(map,manager),B).score,null);
  assert.equal(row(evaluate(map,student),B).score,100);assert.equal(JSON.stringify({map,student,manager}),before);
});

import {createRequire} from 'node:module';
import {before,after} from 'node:test';
const require=createRequire(import.meta.url);let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});after(async()=>{await browser?.close();});
test('browser: new attempt and reload retain frozen historical percentages, current mapping and account isolation',{skip:!chromium},async()=>{
  const map=fixture();
  for(const group of [map.papers,...map.assessmentMappings.versions.map(v=>v.papers)]){
    const questions=group[0].questions;while(questions.length<20)questions.push(q(`2020-P1-Q${String(questions.length+1).padStart(2,'0')}`,[C]));
  }
  for(const version of map.assessmentMappings.versions)version.sha256=mappingHash(version.papers);
  const libraryKey='tmua-practice-library-v1:/study/',historyKey='tmua-attempt-history-v1:/study/';
  const paper={format:'tmua-paper-v1',id:'test-p1',paper:1,title:'Edition mapping test',source:'Local QA',description:'Test',questionCount:20,version:1,href:'papers/paper-1/test-p1.html',contentHash:'1111111111111111',currentEditionId:'new-review',editions:['old-review','new-review'].map((id,i)=>({id,href:`assets/editions/${id}/test-p1.html`,contentHash:String(i+2).repeat(16)}))};
  const progress={questionIndex:0,completed:0,total:20,firstCorrect:0,firstAttempted:1,practiceCorrect:0,practiceAttempted:0,finished:false,attemptId:'attempt-001',startedAt:'2026-09-30T11:00:00Z',afterKnown:true,afterCorrect:0};
  const initial=sitting('old-review',wrong(),{progress});initial.state.records.push(...Array.from({length:18},blank));initial.state.attemptId='attempt-001';
  const appJs=await read('assets/app.js'),conceptsJs=await read('assets/concepts.js');
  const homepage=(await read('index.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')+'<script src="assets/progress-analytics.js"></script><script src="assets/app.js"></script><script src="assets/concepts.js"></script>';
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(({key,value})=>{if(window===window.top && !localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(value));},{key:libraryKey,value:{'test-p1':initial}});
  await context.route('https://mapping.test/**',async route=>{
    const name=new URL(route.request().url()).pathname.replace(/^\/study\//,'');
    const files={'assets/app.js':appJs,'assets/progress-analytics.js':analytics,'assets/concepts.js':conceptsJs,'assets/concept-map.json':JSON.stringify(map),'assets/studied-concepts.json':JSON.stringify(catalogue),'papers/catalog.json':JSON.stringify({papers:[paper]})};
    if(Object.hasOwn(files,name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'application/json',body:files[name]});
    if(name.endsWith('.css'))return route.fulfill({contentType:'text/css',body:await read(name)});
    if(name.includes('/test-p1.html')){
      const pin=name.includes('new-review')?'new-review':'old-review';
      return route.fulfill({contentType:'text/html',body:`<!doctype html><p id="pin">${pin}</p><button id="answer">Submit answer</button><script>window.resume=null;addEventListener('message',e=>{if(e.data.type==='tmua-resume')window.resume=e.data.state;});parent.postMessage({type:'tmua-ready',paperId:'test-p1'},'*');document.querySelector('button').onclick=()=>{const state={version:1,contentRevision:1,attemptId:'attempt-002',questionIndex:0,mode:'original',selected:'A',lastOutcome:'correct',records:Array.from({length:20},(_,i)=>i===0?{first:1,everSolved:true,firstKind:'answer'}:{first:null,firstKind:null,everSolved:false})};parent.postMessage({type:'tmua-progress',paperId:'test-p1',state,progress:{...${JSON.stringify(progress)},attemptId:'attempt-002',startedAt:'2026-10-01T12:00:00Z',firstCorrect:1,afterCorrect:1}},'*');};</script>`});
    }
    return route.fulfill({contentType:'text/html',body:homepage});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('https://mapping.test/study/#paper/test-p1');await page.frameLocator('#paper-frame').locator('#pin').filter({hasText:'old-review'}).waitFor();
    await page.locator('#start-another-paper-attempt').click();await page.frameLocator('#paper-frame').locator('#pin').filter({hasText:'new-review'}).waitFor();
    await page.frameLocator('#paper-frame').locator('#answer').click();
    await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key))?.['test-p1']?.state?.records?.[0]?.first===1,libraryKey);
    const data=await page.evaluate(({libraryKey,historyKey})=>({library:JSON.parse(localStorage.getItem(libraryKey)),history:JSON.parse(localStorage.getItem(historyKey))}),{libraryKey,historyKey});
    assert.equal(data.library['test-p1'].teachingEdition,'new-review');assert.equal(data.library['test-p1'].attemptNumber,2);assert.equal(data.history.attempts[0].teachingEdition,'old-review');
    await page.reload();await page.frameLocator('#paper-frame').locator('#pin').filter({hasText:'new-review'}).waitFor();
    await page.evaluate(()=>location.hash='#concepts');
    await page.locator(`[data-concept="${A}"][data-score="25"]`).waitFor();await page.locator(`[data-concept="${B}"][data-score="0"]`).waitFor();
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('tmua-cloud-lock')));assert.equal(await page.locator('[data-score]').count(),0);
    await page.evaluate(({library,history})=>document.dispatchEvent(new CustomEvent('tmua-cloud-applied',{detail:{payload:{library,history},persistence:{library:false,history:false}}})),data);
    await page.locator(`[data-concept="${A}"][data-score="25"]`).waitFor();await page.locator(`[data-concept="${B}"][data-score="0"]`).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('freeze command appends a fresh version and only new bindings without rewriting current papers or old locks',async t=>{
  const {mkdtemp,mkdir,writeFile,copyFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {execFileSync}=await import('node:child_process');
  const dir=await mkdtemp(path.join(tmpdir(),'tmua-mapping-freeze-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const folder of ['tools','assets','content'])await mkdir(path.join(dir,folder));
  for(const name of ['freeze-concept-mappings.mjs','validate-concept-mappings.mjs'])await copyFile(path.join(root,'tools',name),path.join(dir,'tools',name));
  const map=clone(fixture()),oldVersions=clone(map.assessmentMappings.versions),oldBindings=clone(map.assessmentMappings.editionBindings);
  map.papers[0].questions[0].lessonIds=[A,C];
  const locks={version:1,versions:map.assessmentMappings.versions.map(({id,sha256})=>({id,sha256})),editionBindings:oldBindings};
  for(const [name,value] of Object.entries({'assets/concept-map.json':map,'content/concept-mapping-locks.json':locks,'content/published-papers.json':{papers:[{id:'test-p1'}]},'content/paper-editions.json':{editions:[{paperId:'test-p1',editionId:'old-review'},{paperId:'test-p1',editionId:'new-review'},{paperId:'test-p1',editionId:'final-review'}]}}))await writeFile(path.join(dir,name),JSON.stringify(value));
  execFileSync(process.execPath,[path.join(dir,'tools/freeze-concept-mappings.mjs'),'final-mapping']);
  const output=JSON.parse(await readFile(path.join(dir,'assets/concept-map.json'),'utf8'));
  assert.deepEqual(output.papers,map.papers);assert.deepEqual(output.assessmentMappings.versions.slice(0,2),oldVersions);assert.deepEqual(output.assessmentMappings.editionBindings.slice(0,3),oldBindings);
  assert.deepEqual(output.assessmentMappings.editionBindings.at(-1),{paperId:'test-p1',teachingEdition:'final-review',mappingVersion:'final-mapping'});
  assert.deepEqual(output.assessmentMappings.versions.at(-1).papers,map.papers);
  const before=await readFile(path.join(dir,'assets/concept-map.json'),'utf8');
  assert.throws(()=>execFileSync(process.execPath,[path.join(dir,'tools/freeze-concept-mappings.mjs'),'final-mapping'],{stdio:'pipe'}),/already exists/);
  assert.equal(await readFile(path.join(dir,'assets/concept-map.json'),'utf8'),before);
});
