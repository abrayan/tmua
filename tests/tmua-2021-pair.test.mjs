// Release checks for the actual 2021 pair. Run after merging and compiling both
// plans: TMUA_PLAYWRIGHT_PATH=/path/to/playwright node --test tests/tmua-2021-pair.test.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import {discoverPapers,parseMetadata} from '../tools/build-site.mjs';
import {readPaperData} from '../tools/build-reviewed-editions.mjs';
import {readFrozenEditionSource} from '../tools/validate-edition-sources.mjs';
import {questionFingerprint,validateContentAudit} from '../tools/validate-content-audit.mjs';
import {validateFollowupAudit} from '../tools/validate-followup-audit.mjs';

const root=process.env.TMUA_PAIR_QA_ROOT?path.resolve(process.env.TMUA_PAIR_QA_ROOT):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const readJson=async name=>JSON.parse(await readFile(path.join(root,name),'utf8'));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const pairIds=['tmua-2021-p1','tmua-2021-p2'];
const sourceIds=paper=>Array.from({length:20},(_,index)=>`2021-P${paper}-Q${String(index+1).padStart(2,'0')}`);
async function pair(){
  const bank=await readJson('content/official-question-bank.json');
  const catalogue=await readJson('assets/studied-concepts.json');
  const studied=await readJson('content/studied-lessons.json');
  const {catalog}=await discoverPapers(root);
  return {bank,catalogue,studied,papers:await Promise.all(pairIds.map(async(id,index)=>{
    const entry=catalog.papers.find(paper=>paper.id===id);
    assert.ok(entry,`${id}: compile and include both complete new papers before running release QA.`);
    const latest=entry.editions?.find(edition=>edition.id===entry.currentEditionId);
    const href=latest?.href||entry.href;
    const html=await readFile(path.join(root,href),'utf8');
    const frozen=await readFrozenEditionSource(root,id,entry.currentEditionId);
    return {entry,href,html,data:readPaperData(html),plan:frozen.plan,frozen,paper:index+1};
  }))};
}
const stripResolvedRecall=question=>({...question,hints:question.hints.map(hint=>({...hint,recall:hint.recall.map(({lessonId,reminder})=>({lessonId,reminder}))}))});

test('2021 release preserves every original and reviewed edition from the pre-task snapshot',async()=>{
  const baseline=await readJson('tests/fixtures/qa-2021-immutable-baseline.json');
  const originals=await readJson('content/published-papers.json');
  const editions=await readJson('content/paper-editions.json');
  assert.equal(baseline.sourceRevision,'3daf61182616b6043b24c0f0fb2f76d1f62f5277');
  assert.equal(baseline.originals.length,13);assert.equal(baseline.editions.length,41);
  assert.deepEqual(await readJson('content/pair-publication.json'),baseline.pairPublicationPolicy,'Legacy pairing exceptions must remain unchanged.');
  const currentLocks=await readJson('content/concept-mapping-locks.json');
  for(const row of baseline.conceptMappingLocks.versions)assert.deepEqual(currentLocks.versions.find(now=>now.id===row.id),row,'Frozen historical mapping changed.');
  for(const row of baseline.conceptMappingLocks.editionBindings)assert.deepEqual(currentLocks.editionBindings.find(now=>now.paperId===row.paperId&&now.teachingEdition===row.teachingEdition),row,'Historical edition binding changed.');
  for(const previous of baseline.originals){
    assert.deepEqual(originals.papers.find(entry=>entry.id===previous.id),previous,`${previous.id}: original protection entry changed.`);
    assert.equal(sha256(await readFile(path.join(root,previous.href))),previous.sha256,`${previous.href}: old original bytes changed.`);
  }
  for(const previous of baseline.editions){
    assert.deepEqual(editions.editions.find(entry=>entry.paperId===previous.paperId&&entry.editionId===previous.editionId),previous,`${previous.paperId}: old teaching edition entry changed.`);
    assert.equal(sha256(await readFile(path.join(root,previous.href))),previous.sha256,`${previous.href}: old teaching bytes changed.`);
  }
});

test('both 2021 papers contain exactly their twenty ordered originals and form one new complete release pair',async()=>{
  const {papers}=await pair();
  const policy=await readJson('content/pair-publication.json');
  const pairId=papers[0].entry.pairId;
  assert.ok(pairId,'The new pair requires an explicit shared pairId.');
  for(const {entry,data,html,plan,paper} of papers){
    const metadata=parseMetadata(html);
    assert.equal(entry.pairId,pairId);assert.equal(metadata.pairId,pairId);
    assert.equal(entry.paper,paper);assert.equal(metadata.paper,paper);assert.equal(metadata.id,entry.id);
    assert.equal(metadata.questionCount,20);assert.equal(data.questions.length,20);
    assert.equal(metadata.practicePolicy,'after-miss-up-to-3');assert.equal(metadata.version,1);
    assert.ok(!policy.legacyPaperIds.includes(entry.id),'A new pair must not bypass pairing checks as a legacy paper.');
    assert.deepEqual(data.questions.map(group=>group.id),Array.from({length:20},(_,i)=>`q${i+1}`));
    assert.deepEqual(data.questions.map(group=>group.original.sourceId),sourceIds(paper));
    assert.deepEqual(plan.groups.map(group=>group.originalId),sourceIds(paper));
    assert.deepEqual(data.questions.map(group=>group.similar.map(q=>q.sourceId)),plan.groups.map(group=>group.candidates));
  }
});

test('every compiled 2021 original and follow-up contains audited teaching and genuine booklet or New learning references',async()=>{
  const {bank,catalogue,studied,papers}=await pair();
  const known=new Set([...catalogue.lessons,...catalogue.additionalConcepts].map(concept=>concept.id));
  const lessons=new Map(studied.booklets.flatMap(booklet=>booklet.lessons.map(lesson=>[lesson.id,{title:lesson.title,paper:booklet.paper,booklet:booklet.booklet,number:lesson.number,pdfPage:lesson.pdfPage,...(lesson.sourceLabel?{sourceLabel:lesson.sourceLabel}:{})}])));
  for(const concept of catalogue.additionalConcepts)lessons.set(concept.id,{title:concept.title,paper:concept.paper,kind:'additional',sourceLabel:'New learning'});
  for(const {data,paper,frozen} of papers){
    const ownOriginals=new Set(sourceIds(paper));
    for(const group of data.questions){
      assert.ok(group.similar.length<=3,`${group.id}: at most three defensible follow-ups.`);
      for(const exercise of [group.original,...group.similar]){
        const authored=frozen.bank.questions[exercise.sourceId];
        assert.ok(authored,`${exercise.sourceId}: missing frozen reviewed source entry.`);
        assert.equal(questionFingerprint(stripResolvedRecall(exercise)),questionFingerprint(stripResolvedRecall(authored)),`${exercise.sourceId}: compiled mathematical or teaching content differs from its frozen reviewed source.`);
        assert.ok(exercise.conceptIds.length>0&&exercise.conceptIds.every(id=>known.has(id)));
        // An unescaped comparison such as x<n silently becomes an HTML tag,
        // swallowing the rest of a hint. Check authored teaching, not crops.
        const teachingTags=new Set('p br strong em b i span a div ul ol li table tr td th thead tbody math mrow mi mn mo msup msub msubsup mfrac msqrt mroot mtext mspace mstyle mtable mtr mtd mfenced mover munder munderover semantics annotation menclose mphantom mpadded'.split(' '));
        const teachingFields=[exercise.solution,...exercise.hints.flatMap(hint=>[hint.title,hint.body,hint.recap,hint.pitfall,hint.pause,...hint.recall.map(reference=>reference.reminder)])];
        for(const value of teachingFields)for(const match of value.matchAll(/<([A-Za-z][\w:-]*)(?=[\s>])/g)){
          assert.ok(teachingTags.has(match[1]),`${exercise.sourceId}: unescaped comparison or unsupported teaching tag <${match[1]}>.`);
        }

        for(const hint of exercise.hints)for(const recall of hint.recall){
          assert.ok(lessons.has(recall.lessonId),`${exercise.sourceId}: hint reminders must resolve to actual booklet lessons or sourced additional concepts.`);
          assert.deepEqual(recall,{lessonId:recall.lessonId,reminder:recall.reminder,...lessons.get(recall.lessonId)});
        }
      }
      for(const followup of group.similar){
        assert.ok(!ownOriginals.has(followup.sourceId),`${followup.sourceId}: assessment question leaked as its own follow-up.`);
        assert.equal(group.similar.filter(candidate=>candidate.sourceId===followup.sourceId).length,1,`${followup.sourceId}: repeated follow-up within one original.`);
      }
    }
  }
});

test('new 2021 questions, concepts and follow-up relationships have complete fresh audit coverage',async()=>{
  await pair();
  const content=await validateContentAudit(root),followups=await validateFollowupAudit(root);
  assert.ok(content.questions>=329,'The existing304 bank entries plus19 previously absent2021 originals and6 preview exercises are required.');
  assert.ok(content.concepts>=112);assert.equal(content.syllabusClauses,126);
  assert.ok(followups.papers>=14);assert.ok(followups.groups>=280);
});

const require=createRequire(import.meta.url);let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function runPaper(paper,viewport){
  const context=await browser.newContext({viewport});
  const homepage=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style><script>window.progressEvents=[];addEventListener('message',e=>{if(e.source!==document.querySelector('iframe')?.contentWindow)return;if(e.data.type==='tmua-ready')e.source.postMessage({type:'tmua-resume',paperId:e.data.paperId,state:null},'*');if(e.data.type==='tmua-progress')window.progressEvents.push(e.data);if(e.data.type==='qa-sync')window.qaSync=e.data.token;});</script><iframe title="2021 paper" src="/${paper.href}"></iframe>`;
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://tmua-2021-qa.test')return route.abort();
    if(url.pathname===`/${paper.href}`)return route.fulfill({contentType:'text/html',body:paper.html});
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:homepage});
    return route.fulfill({status:404,body:'Unknown QA asset'});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('https://tmua-2021-qa.test/');
  await page.waitForFunction(()=>window.progressEvents?.length>0);
  const frame=page.frames().find(frame=>frame.url().endsWith(paper.href));
  let synced=0;
  const state=async()=>{
    // Message delivery is asynchronous. A same-source barrier ensures all of
    // the player's earlier progress messages arrived before assertions read it.
    const token=++synced;
    await frame.evaluate(token=>parent.postMessage({type:'qa-sync',token},'*'),token);
    await page.waitForFunction(token=>window.qaSync===token,token);
    return page.evaluate(()=>window.progressEvents.at(-1));
  };
  return {context,page,frame,state,errors};
}
async function verifyLayout(frame,label){
  await frame.waitForFunction(()=>[...document.querySelectorAll('#question-text img')].every(img=>img.complete&&img.naturalWidth>0));
  const result=await frame.evaluate(async()=>{
    await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const visible=node=>Boolean(node.getClientRects().length);
    const maths=[...document.querySelectorAll('math')].filter(visible);
    const visibleText=[...document.querySelectorAll('#question-section,#review,#solution')].filter(visible).map(node=>node.innerText).join('\n');
    return {overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      math:maths.map(node=>({namespace:node.namespaceURI,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,error:Boolean(node.querySelector('merror,parsererror'))})),
      rawLatex:/\\(?:\(|\)|\[|\]|frac\b|sqrt\b|begin\b)/.test(visibleText),
      longEquations:[...document.querySelectorAll('math,.math-scroll,.formula')].filter(visible).filter(node=>node.scrollWidth>node.clientWidth+3).map(node=>{const old=node.scrollLeft;node.scrollLeft=9999;const moved=node.scrollLeft;node.scrollLeft=old;return {tag:node.tagName,width:node.clientWidth,scrollWidth:node.scrollWidth,overflow:getComputedStyle(node).overflowX,scrollable:moved>0};})};
  });
  assert.ok(result.overflow<=2,`${label}: page overflows by ${result.overflow}px.`);
  assert.equal(result.rawLatex,false,`${label}: unrendered LaTeX in visible teaching.`);
  for(const equation of result.longEquations)assert.equal(equation.scrollable,true,`${label}: long equation is clipped and cannot scroll: ${JSON.stringify(equation)}`);
  for(const math of result.math){assert.equal(math.namespace,'http://www.w3.org/1998/Math/MathML',label);assert.ok(math.width>0&&math.height>0,`${label}: invisible native maths.`);assert.equal(math.error,false,label);}
}
async function answer(frame,letter){await frame.locator(`input[name="answer"][value="${letter}"]`).check();await frame.locator('#check-answer').click();}
async function allHints(frame,count){
  const initial=await frame.locator('#knowledge-list .knowledge').count();
  assert.ok(initial>=1&&initial<=count,'a recap may retain help steps already opened earlier');
  for(let shown=initial;shown<count;shown++){assert.equal(await frame.locator('#knowledge-list .knowledge').count(),shown);await frame.locator('#next-piece').click();}
  assert.equal(await frame.locator('#knowledge-list .knowledge').count(),count);
  assert.equal(await frame.locator('#next-piece').isVisible(),false);
  assert.equal(await frame.locator('#solution').isVisible(),false);
}


for(const paperNumber of [1,2])for(const mode of ['normal','pearson'])for(const [size,viewport] of Object.entries({mobile:{width:390,height:844},desktop:{width:1440,height:1000}}))test(`browser: 2021 Paper ${paperNumber} ${mode} ${size} checks every original and follow-up, cumulative hints, redo and final scores`,{skip:!chromium,timeout:300000},async()=>{
  const compiled=(await pair()).papers[paperNumber-1];
  const run=await runPaper(compiled,viewport);
  const {page,frame,state,errors}=run;
  try{
    await frame.locator('#view-mode').selectOption(mode);
    assert.equal(await frame.locator('#solution').isVisible(),false);
    await frame.locator('#check-answer').click();
    assert.equal(await frame.locator('#solution').isVisible(),false);
    assert.equal((await state()).progress.firstAttempted,0,'checking without an answer must not count as an attempt');
    let practice=0;
    for(const [index,group] of compiled.data.questions.entries()){
      const label=`P${paperNumber} ${mode} ${size} Q${index+1}`;
      assert.equal(await frame.locator('#solution').isVisible(),false,`${label}: solution must start hidden`);
      await verifyLayout(frame,`${label} question`);
      if(index===0){
        await frame.locator('#give-hint').click();assert.equal(await frame.locator('#knowledge-list .knowledge').count(),1);await allHints(frame,group.original.hints.length);
        await verifyLayout(frame,`${label} hints before answering`);
        await frame.locator('#try-again').click();
      }
      const noFollowups=group.similar.length===0;
      await answer(frame,group.original.correct==='A'?'B':'A');
      if(noFollowups){
        assert.equal(await frame.locator('#similar-button').isVisible(),false,'a documented match gap must not offer unrelated filler');
        assert.equal(await frame.locator('#next-exercise-button').isDisabled(),false,'a checked miss with no follow-ups can continue safely');
      }
      await verifyLayout(frame,`${label} solution`);
      const before=(await state()).progress.firstCorrect;
      await frame.locator('#solution-hints').click();await allHints(frame,group.original.hints.length);
      await verifyLayout(frame,`${label} full hint ladder`);
      assert.equal((await state()).progress.firstCorrect,before,'recap after a correct answer must retain first-answer credit');
      if(index===0){
        const directory=process.env.TMUA_PAIR_SCREENSHOT_DIR||path.join(root,'audit-work');await mkdir(directory,{recursive:true});
        await page.screenshot({path:path.join(directory,`qa-runtime-2021-p${paperNumber}-${mode}-${size}-hints.png`),fullPage:true});
      }
      await frame.locator('#try-again').click();await answer(frame,group.original.correct);
      for(const [similarIndex,similar] of group.similar.entries()){
        await frame.locator('#similar-button').click();assert.equal(await frame.locator('#solution').isVisible(),false);
        const followupLabel=`${label} follow-up ${similarIndex+1} (${similar.sourceId})`;
        await verifyLayout(frame,`${followupLabel} question`);
        // Miss the first answer so that every reviewed follow-up remains
        // reachable; successful independent work normally ends the ladder.
        await answer(frame,similar.correct==='A'?'B':'A');practice++;
        assert.equal((await state()).progress.practiceAttempted,practice);
        await verifyLayout(frame,`${followupLabel} solution`);
        await frame.locator('#solution-hints').click();await allHints(frame,similar.hints.length);
        await verifyLayout(frame,`${followupLabel} cumulative hints`);
        await frame.locator('#try-again').click();await answer(frame,similar.correct);
      }
      if(group.similar.length)assert.equal(await frame.locator('#similar-button').isVisible(),false,'reviewed follow-up limit must be enforced');
      await frame.locator('#next-exercise-button').click();
    }
    const final=(await state()).progress;
    assert.equal(final.finished,true);assert.equal(final.completed,20);assert.equal(final.firstAttempted,20);
    assert.equal(final.firstCorrect,0,'deliberate checked misses must not be overwritten by correct redos');
    assert.equal(final.afterCorrect,20);assert.equal(final.practiceAttempted,practice);assert.equal(final.practiceCorrect,0,'correct redos must not rewrite missed independent follow-up answers');
    assert.equal(await frame.locator('#finished').isVisible(),true);assert.deepEqual(errors,[]);
  }finally{await run.context.close();}
});

for(const paperNumber of [1,2])test(`browser: actual 2021 Paper ${paperNumber} site routing, reload, view controls and next numbered attempt preserve the original answers`,{skip:!chromium,timeout:90000},async()=>{
  const {catalog}=await discoverPapers(root);const compiled=(await pair()).papers[paperNumber-1];
  const entry=compiled.entry,edition=entry.currentEditionId||'original';
  const context=await browser.newContext({viewport:paperNumber===1?{width:390,height:844}:{width:1440,height:1000}}),errors=[],requests=[];
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://tmua-2021-site.test'){requests.push(url.href);return route.abort();}
    const file=url.pathname.replace(/^\/study\//,'')||'index.html';
    if(file==='assets/cloud-config.js')return route.fulfill({contentType:'text/javascript',body:'window.TMUA_CLOUD_CONFIG={enabled:false};'});
    if(file==='papers/catalog.json')return route.fulfill({contentType:'application/json',body:JSON.stringify(catalog)});
    if(file!=='index.html'&&!/^(assets|papers)\/[a-zA-Z0-9_./-]+$/.test(file)||file.includes('..')){requests.push(url.href);return route.abort();}
    try{return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html',body:await readFile(path.join(root,file))});}
    catch{return route.fulfill({status:404,body:'Missing QA asset'});}
  });
  const key='tmua-practice-library-v1:/study/',historyKey='tmua-attempt-history-v1:/study/';
  const saved=()=>page.evaluate(({key,id})=>JSON.parse(localStorage.getItem(key)||'{}')[id],{key,id:entry.id});
  const wait=predicate=>page.waitForFunction(({key,id,predicate})=>{const record=JSON.parse(localStorage.getItem(key)||'{}')[id];return record&&new Function('record',`return (${predicate})`)(record);},{key,id:entry.id,predicate});
  const frame=()=>page.frameLocator('#paper-frame');
  const submit=async letter=>{await frame().locator(`input[name="answer"][value="${letter}"]`).check();await frame().locator('#check-answer').click();};
  try{
    await page.goto(`https://tmua-2021-site.test/study/#paper/${entry.id}`);await frame().locator('#check-answer').waitFor();
    await wait('record.state && record.progress.firstAttempted === 0');
    const initial=await saved();assert.equal(initial.teachingEdition,edition);
    await frame().locator('#view-mode').selectOption('pearson');await frame().locator('#flag-question').check();
    await wait("record.view?.mode === 'pearson' && record.view.flags[0] === 0");
    assert.deepEqual((await saved()).state,initial.state,'display controls cannot change exercise state');
    await frame().locator('#palette-review').click();assert.equal(await frame().locator('#question-review-dialog').isVisible(),true);
    assert.equal(await frame().locator('#dialog-content [data-review-index="1"]').isDisabled(),true);
    await frame().locator('#close-review').click();assert.equal(await frame().locator('#palette-review').evaluate(node=>node===document.activeElement),true);
    await frame().locator('#question-text .source-question').click();await frame().locator('#question-review-dialog').waitFor();
    assert.equal(await frame().locator('.enlarged-question').count(),1);await frame().locator('#close-review').click();
    const correct=compiled.data.questions[0].original.correct,wrong=correct==='A'?'B':'A';
    await submit(wrong);await wait('record.progress.firstAttempted === 1');
    const attemptId=(await saved()).progress.attemptId;
    await frame().locator('#solution-hints').click();await frame().locator('#try-again').click();await submit(correct);await wait('record.progress.afterCorrect === 1');
    let record=await saved();assert.equal(record.progress.firstCorrect,0);assert.equal(record.answerLog[0].firstAnswer,wrong);assert.equal(record.answerLog[0].latestAnswer,correct);
    await frame().locator('#next-exercise-button').click();await wait('record.state.questionIndex === 1');
    const beforeReview=(await saved()).state;
    await frame().locator('#palette-review').click();await frame().locator('#dialog-content [data-review-index="0"]').click();
    assert.equal(await frame().locator('.reviewed-question').count(),1);assert.equal(await frame().locator('.reviewed-solution').count(),1);
    await frame().locator('#close-review').click();assert.deepEqual((await saved()).state,beforeReview);
    await page.reload();await frame().locator('#check-answer').waitFor();await wait('record.state.questionIndex === 1');
    assert.equal(await frame().locator('#view-mode').inputValue(),'pearson');assert.match(await frame().locator('#palette-buttons [data-review-index="0"]').getAttribute('aria-label'),/flagged/);
    record=await saved();assert.equal(record.progress.attemptId,attemptId);assert.equal(record.teachingEdition,edition);
    await frame().locator('#view-mode').selectOption('normal');await wait("record.view.mode === 'normal'");assert.deepEqual((await saved()).state,record.state);
    await page.locator('#start-another-paper-attempt').click();await frame().locator('#check-answer').waitFor();await wait('record.progress.firstAttempted === 0');
    const archived=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts,historyKey);
    assert.equal(archived.length,1);assert.equal(archived[0].attemptNumber,1);assert.equal(archived[0].finished,false);assert.equal(archived[0].teachingEdition,edition);assert.equal(archived[0].answerLog[0].firstAnswer,wrong);
    await submit(correct);await wait('record.attemptNumber === 2 && record.progress.firstCorrect === 1');record=await saved();assert.notEqual(record.progress.attemptId,attemptId);assert.equal(record.teachingEdition,edition);
    await frame().locator('#solution-hints').click();await frame().locator('#try-again').click();await submit(correct);await wait('record.progress.firstCorrect === 1');
    assert.equal((await saved()).progress.firstCorrect,1,'a correct independent answer keeps full credit after a recap and redo');
    assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts,historyKey),archived);assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  }finally{await context.close();}
});
