import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let chromium,browser; try {({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH || 'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
const options={skip:!chromium};
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=name=>readFile(path.join(root,name),'utf8');
const templates=Object.fromEntries(await Promise.all(['paper-shell.html','paper.css','paper-player.js','view-modes.css','view-modes.js'].map(async name=>[name,await read(`templates/${name}`)])));
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
function fixture(edition='private-review-one',concept='p1-b1-l01',provider='jzmaths-tyler'){
  const rows=[],html={};
  const pairId=provider==='miomath'?'miomath-tmua-2024':'tyler-exam-a';
  for(const paper of [1,2]){
    const id=`${pairId}-p${paper}`,metadata={format:'tmua-paper-v1',version:1,contentRevision:2,id,pairId,paper,title:`Private fixture Paper ${paper}`,source:'Synthetic browser fixture',description:'Private delivery fixture',questionCount:20,practicePolicy:'after-miss-up-to-3',visibility:'private',provider};
    if(provider==='miomath')metadata.sourceUrl=`https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/authenticated/tmua-pdfs/00000000-0000-4000-8000-00000000000${paper}.pdf`;
    const question=i=>({label:`Fixture question ${i}`,sourceId:`${provider==='miomath'?'MIOMATH-2024':'TYLER-EXAM-A'}-P${paper}-Q${String(i).padStart(2,'0')}`,lead:'A synthetic arithmetic question: calculate 2 + 2.',options:[4,5],correct:'A',conceptIds:[concept],hints:[{title:'Add the quantities',body:'Combine the two equal quantities.',recap:'Addition combines quantities.',pitfall:'Do not multiply the two quantities.',pause:'Carry out the addition on paper.'}],solution:'Adding the two quantities gives 4.'});
    const data={metadata,questions:Array.from({length:20},(_,n)=>({id:`q${n+1}`,original:question(n+1),similar:[{...question(n+1),sourceId:`2023-P${paper}-Q${String(n+1).padStart(2,'0')}`,lead:'A synthetic follow-up: calculate 3 + 1.'}]}))};
    const replacements={TITLE:metadata.title,METADATA:json(metadata),DATA:json(data),CSS:templates['paper.css'],PLAYER:templates['paper-player.js'],VIEWCSS:templates['view-modes.css'],VIEWPLAYER:templates['view-modes.js']};
    const body=templates['paper-shell.html'].replace(/\{\{(TITLE|METADATA|DATA|CSS|PLAYER|VIEWCSS|VIEWPLAYER)\}\}/g,(_,key)=>replacements[key]);
    const mapping={id,paper,title:metadata.title,version:1,contentRevisions:[2],questions:data.questions.map(group=>({sourceId:group.original.sourceId,canonicalSourceId:group.original.sourceId,knowledgePattern:'Synthetic addition',lessonIds:[concept]}))};
    const row={paper_id:id,edition_id:edition,pair_id:pairId,paper_number:paper,object_path:`${id}/${edition}.html`,sha256:hash(body),metadata,concept_mapping:{versionId:edition,sha256:hash(canonical(mapping)),paper:mapping},created_at:edition.endsWith('two')?'2026-10-02T12:00:00Z':'2026-10-01T12:00:00Z'};
    rows.push(row);html[row.object_path]=body;
  }
  return {rows,html};
}
const baseFixture=fixture();
async function waitSaved(page, count=1) { await page.waitForFunction(count=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/') || '{}')['tyler-exam-a-p1']?.progress?.firstAttempted===count,count); }
async function setup(t,{rows=baseFixture.rows,html=baseFixture.html,viewport={width:1280,height:900}}={}){
  const context=await browser.newContext({viewport});t.after(()=>context.close());const page=await context.newPage(),errors=[],requests=[];page.setDefaultTimeout(8000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  await page.route('https://private.test/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice(1)||'index.html';
    if(name==='assets/cloud-config.js')return route.fulfill({contentType:'application/javascript',body:'window.TMUA_CLOUD_CONFIG={enabled:false};'});
    if(name==='papers/catalog.json')return route.fulfill({contentType:'application/json',body:'{"papers":[]}'});
    try {const body=await read(name);return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':'text/html',body});}catch{return route.fulfill({status:404,body:'Missing fixture'});}
  });
  await page.goto('https://private.test/');
  await page.evaluate(({rows,html})=>{
    window.TmuaCloud={blocked:false};window.__rows=rows;window.__html=html;window.__loads=[];window.__late=null;
    window.__client={from:table=>({select:()=>({order:async()=>({data:window.__rows,error:null})})}),storage:{from:bucket=>({download:async objectPath=>{window.__loads.push({bucket,objectPath});if(window.__delay)await new Promise(resolve=>window.__late=resolve);return {data:new Blob([window.__html[objectPath]],{type:'text/html'}),error:null};}})}};
  },{rows,html});
  await page.evaluate(()=>window.TmuaPrivate.connect(window.__client,'student-fixture'));
  return {page,errors,requests,frame:()=>page.frameLocator('#paper-frame'),async open(){await page.evaluate(id=>{location.hash=`#paper/${id}`;},rows[0].paper_id);await page.frameLocator('#paper-frame').locator('#question-text').waitFor({state:'attached'});}};
}

test('private catalogue accepts complete authenticated pairs and rejects partial, stale-map and escaping records',options,async t=>{
  const app=await setup(t);assert.equal(await app.page.evaluate(()=>TmuaPrivate.catalog().length),2);
  for(const mutate of ['partial','mapping','path']){
    await app.page.evaluate(({rows,mutate})=>{window.__rows=structuredClone(rows);if(mutate==='partial')window.__rows.pop();if(mutate==='mapping')window.__rows[0].concept_mapping.paper.questions[0].lessonIds=['p1-b1-l02'];if(mutate==='path')window.__rows[0].object_path='../elsewhere.html';},{rows:baseFixture.rows,mutate});
    await app.page.evaluate(()=>TmuaPrivate.refresh());assert.equal(await app.page.evaluate(()=>TmuaPrivate.catalog().length),0,mutate);
  }
  assert.deepEqual(app.errors,[]);
});

test('MioMath private pair uses existing delivery and concept mapping without requesting its source PDF',options,async t=>{
  const source=fixture('private-miomath-test','p1-b1-l01','miomath'),app=await setup(t,{...source,viewport:{width:390,height:900}});
  const catalog=await app.page.evaluate(()=>TmuaPrivate.catalog());
  assert.deepEqual(catalog.map(p=>p.id),['miomath-tmua-2024-p1','miomath-tmua-2024-p2']);
  assert.ok(catalog.every(p=>p.provider==='miomath'&&p.visibility==='private'));
  await app.open();const f=app.frame();
  for(const mode of ['normal','pearson']){await f.locator('#view-mode').selectOption(mode);assert.match(await f.locator('#question-text').textContent(),/calculate 2 \+ 2/);}
  await f.locator('input[name="answer"][value="A"]').check();await f.locator('#check-answer').click();
  await app.page.waitForFunction(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/')||'{}')['miomath-tmua-2024-p1']?.progress?.firstAttempted===1);
  const state=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/'))['miomath-tmua-2024-p1']);
  assert.equal(state.teachingEdition,'private-miomath-test');assert.equal(state.progress.firstCorrect,1);
  const merged=await app.page.evaluate(async()=>TmuaPrivate.mergeMap(await(await fetch('assets/concept-map.json')).json()));
  assert.equal(merged.papers.find(p=>p.id==='miomath-tmua-2024-p1').questions[0].sourceId,'MIOMATH-2024-P1-Q01');
  assert.ok(app.requests.every(url=>url.startsWith('https://private.test/')));assert.deepEqual(app.errors,[]);
});

for(const mode of ['normal','pearson'])for(const width of [1280,390])test(`private browser: ${mode} ${width}px hint/check/redo/follow-up/finish/resume`,options,async t=>{
  const app=await setup(t,{viewport:{width,height:900}});await app.open();const f=app.frame();
  if(mode==='pearson') await f.locator('#view-mode').selectOption('pearson');
  await f.locator('#give-hint').click();await f.locator('#knowledge-list').waitFor();await f.locator('#try-again').click();
  await f.locator('input[name="answer"][value="B"]').check();await f.locator('#check-answer').click();
  await f.locator('#similar-button').click();await f.locator('input[name="answer"][value="A"]').check();await f.locator('#check-answer').click();await f.locator('#next-exercise-button').click();
  for(let n=1;n<20;n++){await f.locator('input[name="answer"][value="A"]').check();await f.locator('#check-answer').click();await f.locator('#next-exercise-button').click();}
  await f.locator('#finished').waitFor();
  const state=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/'))['tyler-exam-a-p1']);
  assert.equal(state.teachingEdition,'private-review-one');assert.equal(state.progress.firstCorrect,19);assert.equal(state.progress.total,20);assert.equal(state.progress.finished,true);
  const history=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-attempt-history-v1:/')).attempts);assert.equal(history.length,1);assert.equal(history[0].teachingEdition,'private-review-one');
  assert.equal(await app.page.locator('#paper-frame').getAttribute('sandbox'),'allow-scripts allow-forms');assert.equal(await app.page.locator('#paper-frame').getAttribute('src'),null);
  assert.ok(app.requests.every(url=>url.startsWith('https://private.test/')),'private paper uses no remote content or signed URL');
  await app.page.evaluate(()=>{location.hash='#practice';});await app.open();await app.frame().locator('#finished').waitFor();
  assert.deepEqual(app.errors,[]);
});

test('private editions and concept bindings preserve old attempts; a new sitting selects latest edition',options,async t=>{
  const first=fixture(),next=fixture('private-review-two','p1-b1-l02'),app=await setup(t);await app.open();
  await app.frame().locator('input[name="answer"][value="A"]').check();await app.frame().locator('#check-answer').click();await waitSaved(app.page);
  await app.page.evaluate(({rows,html})=>{window.__rows=rows;window.__html=html;},{rows:[...first.rows,...next.rows],html:{...first.html,...next.html}});await app.page.evaluate(()=>TmuaPrivate.refresh());
  assert.equal(await app.frame().locator('#question-text').textContent(),first.html ? 'A synthetic arithmetic question: calculate 2 + 2.' : '');
  const before=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/'))['tyler-exam-a-p1']);assert.equal(before.teachingEdition,'private-review-one');
  await app.page.locator('#start-another-paper-attempt').click();await app.frame().locator('#question-text').waitFor({state:'attached'});await app.frame().locator('input[name="answer"][value="A"]').check();await app.frame().locator('#check-answer').click();await waitSaved(app.page);
  const after=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/'))['tyler-exam-a-p1']);assert.equal(after.teachingEdition,'private-review-two');assert.equal(after.attemptNumber,2);
  const merged=await app.page.evaluate(async()=>TmuaPrivate.mergeMap(await (await fetch('assets/concept-map.json')).json()));
  assert.equal(merged.assessmentMappings.editionBindings.find(x=>x.paperId==='tyler-exam-a-p1'&&x.teachingEdition==='private-review-one').mappingVersion,'private-review-one');
  assert.equal(merged.assessmentMappings.versions.find(x=>x.id==='private-review-one').papers[0].questions[0].lessonIds[0],'p1-b1-l01');
  assert.equal(merged.assessmentMappings.versions.find(x=>x.id==='private-review-two').papers[0].questions[0].lessonIds[0],'p1-b1-l02');assert.deepEqual(app.errors,[]);
});

test('private download hash failures fail closed and an account switch rejects late private HTML',options,async t=>{
  const app=await setup(t);await app.page.evaluate(()=>{const key=Object.keys(window.__html)[0];window.__html[key]+='tampered';});
  await app.page.evaluate(()=>{location.hash='#paper/tyler-exam-a-p1';});await app.page.locator('#player-progress').filter({hasText:'could not load'}).waitFor();assert.equal(await app.page.locator('#paper-frame').getAttribute('srcdoc'),null);
  await app.page.evaluate(html=>{window.__html=html;window.__delay=true;location.hash='#practice';},baseFixture.html);
  await app.page.evaluate(()=>{location.hash='#paper/tyler-exam-a-p1';});await app.page.waitForFunction(()=>typeof window.__late==='function');
  await app.page.evaluate(()=>{TmuaPrivate.disconnect();window.__late();});await app.page.waitForTimeout(30);
  assert.equal(await app.page.locator('#paper-frame').getAttribute('srcdoc'),null);assert.equal(await app.page.evaluate(()=>TmuaPrivate.catalog().length),0);assert.deepEqual(app.errors,[]);
});

test('private pair archive/remove/restore preserve answers and catalogue editions',options,async t=>{
  const app=await setup(t);await app.open();await app.frame().locator('input[name="answer"][value="A"]').check();await app.frame().locator('#check-answer').click();await waitSaved(app.page);
  const before=await app.page.evaluate(()=>localStorage.getItem('tmua-practice-library-v1:/'));
  await app.page.locator('#history-live-1').waitFor({state:'attached'});
  assert.match(await app.page.locator('#history-live-1').textContent(),/1 answered so far/);
  await app.page.evaluate(()=>{location.hash='#practice';});
  for(const [button,section] of [['Archive','.roadmap-archived-pairs'],['Remove from my list','.roadmap-removed-pairs']]){
    await app.page.locator('#roadmap-stage-tyler-exam-a').getByRole('button',{name:button,exact:true}).click();
    await app.page.locator(section).waitFor();
    await app.page.locator(`${section} > summary`).click();await app.page.locator(section).getByRole('button',{name:'Restore',exact:true}).click();
    assert.equal(await app.page.locator(section).count(),0);assert.equal(await app.page.evaluate(()=>localStorage.getItem('tmua-practice-library-v1:/')),before);
    assert.equal(await app.page.evaluate(()=>TmuaPrivate.catalog().length),2);
  }
  await app.open();assert.equal(await app.frame().locator('#solution').isVisible(),true);assert.deepEqual(app.errors,[]);
});

test('account replacement drops private HTML and rejects the old frame messages',options,async t=>{
  const app=await setup(t);await app.open();await app.frame().locator('input[name="answer"][value="A"]').check();await app.frame().locator('#check-answer').click();await waitSaved(app.page);
  await app.page.evaluate(()=>{
    window.__oldFrame=document.getElementById('paper-frame').contentWindow;
    window.__oldRecord=JSON.parse(localStorage.getItem('tmua-practice-library-v1:/'))['tyler-exam-a-p1'];
    TmuaCloud.blocked=true;document.dispatchEvent(new CustomEvent('tmua-cloud-lock'));TmuaPrivate.disconnect();
    const empty={version:1,library:{},history:{version:1,attempts:[]},roadmap:{version:1,pairs:{}}};
    localStorage.setItem('tmua-practice-library-v1:/','{}');localStorage.setItem('tmua-attempt-history-v1:/',JSON.stringify(empty.history));
    document.dispatchEvent(new CustomEvent('tmua-cloud-applied',{detail:{payload:empty,persistence:{library:true,history:true,roadmap:true}}}));
  });
  assert.equal(await app.page.locator('#paper-frame').getAttribute('srcdoc'),null);
  await app.page.evaluate(async()=>{await TmuaPrivate.connect(window.__client,'manager-fixture');TmuaCloud.blocked=false;document.dispatchEvent(new CustomEvent('tmua-cloud-unlock'));});await app.frame().locator('#question-text').waitFor();
  const newId=await app.page.evaluate(()=>document.getElementById('paper-frame').contentWindow!==window.__oldFrame);assert.equal(newId,true);
  await app.page.evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{source:window.__oldFrame,data:{type:'tmua-progress',paperId:'tyler-exam-a-p1',state:window.__oldRecord.state,progress:window.__oldRecord.progress}}));});
  const current=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/'))['tyler-exam-a-p1']);
  assert.equal(current?.progress?.firstAttempted || 0,0);assert.deepEqual(app.errors,[]);
});

test('private original concept evidence is visible to manager without importing student answers',options,async t=>{
  const app=await setup(t);await app.open();await app.frame().locator('input[name="answer"][value="A"]').check();await app.frame().locator('#check-answer').click();await waitSaved(app.page);
  const library=await app.page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-practice-library-v1:/')));
  await app.page.evaluate(async library=>{
    const before=localStorage.getItem('tmua-practice-library-v1:/');window.__managerBefore=before;
    const section=document.getElementById('student-progress-section');section.hidden=false;document.getElementById('library-view').hidden=false;document.getElementById('player-view').hidden=true;
    window.__manager=TmuaManager.mount(section,{client:{rpc:async()=>({data:{student:{user_id:'student-fixture'},revision:1,payload:{version:1,library,history:{version:1,attempts:[]},roadmap:{version:1,pairs:{}}},updated_at:'2026-10-01T12:00:00Z'},error:null})}});await window.__manager.refresh();
  },library);
  await app.page.locator('[data-manager-concept="p1-b1-l01"][data-score="100"]').waitFor();
  assert.equal(await app.page.evaluate(()=>localStorage.getItem('tmua-practice-library-v1:/')===window.__managerBefore),true);assert.deepEqual(app.errors,[]);
});
