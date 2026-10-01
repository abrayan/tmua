// Release checks for the actual 2022 pair. Run after merging and compiling both
// plans: TMUA_PLAYWRIGHT_PATH=/path/to/playwright node --test tests/tmua-2022-pair.test.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import {discoverPapers,parseMetadata} from '../tools/build-site.mjs';
import {readPaperData} from '../tools/build-reviewed-editions.mjs';
import {questionFingerprint,validateContentAudit} from '../tools/validate-content-audit.mjs';
import {validateFollowupAudit} from '../tools/validate-followup-audit.mjs';

const root=process.env.TMUA_PAIR_QA_ROOT?path.resolve(process.env.TMUA_PAIR_QA_ROOT):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const readJson=async name=>JSON.parse(await readFile(path.join(root,name),'utf8'));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const pairIds=['tmua-2022-p1','tmua-2022-p2'];
const sourceIds=paper=>Array.from({length:20},(_,index)=>`2022-P${paper}-Q${String(index+1).padStart(2,'0')}`);
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
    return {entry,href,html,data:readPaperData(html),plan:await readJson(`content/${id}-plan.json`),paper:index+1};
  }))};
}
const stripResolvedRecall=question=>({...question,hints:question.hints.map(hint=>({...hint,recall:hint.recall.map(({lessonId,reminder})=>({lessonId,reminder}))}))});

test('2022 release preserves every original and reviewed edition from the pre-task snapshot',async()=>{
  const baseline=await readJson('tests/fixtures/qa-2022-immutable-baseline.json');
  const originals=await readJson('content/published-papers.json');
  const editions=await readJson('content/paper-editions.json');
  assert.equal(baseline.sourceRevision,'dbb92eb');
  assert.equal(baseline.originals.length,11);assert.equal(baseline.editions.length,11);
  for(const previous of baseline.originals){
    assert.deepEqual(originals.papers.find(entry=>entry.id===previous.id),previous,`${previous.id}: original protection entry changed.`);
    assert.equal(sha256(await readFile(path.join(root,previous.href))),previous.sha256,`${previous.href}: old original bytes changed.`);
  }
  for(const previous of baseline.editions){
    assert.deepEqual(editions.editions.find(entry=>entry.paperId===previous.paperId&&entry.editionId===previous.editionId),previous,`${previous.paperId}: old teaching edition entry changed.`);
    assert.equal(sha256(await readFile(path.join(root,previous.href))),previous.sha256,`${previous.href}: old teaching bytes changed.`);
  }
});

test('both 2022 papers contain exactly their twenty ordered originals and form one new complete release pair',async()=>{
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

test('every compiled 2022 original and follow-up contains audited teaching and genuine booklet or New learning references',async()=>{
  const {bank,catalogue,studied,papers}=await pair();
  const known=new Set([...catalogue.lessons,...catalogue.additionalConcepts].map(concept=>concept.id));
  const lessons=new Map(studied.booklets.flatMap(booklet=>booklet.lessons.map(lesson=>[lesson.id,{title:lesson.title,paper:booklet.paper,booklet:booklet.booklet,number:lesson.number,pdfPage:lesson.pdfPage,...(lesson.sourceLabel?{sourceLabel:lesson.sourceLabel}:{})}])));
  for(const concept of catalogue.additionalConcepts)lessons.set(concept.id,{title:concept.title,paper:concept.paper,kind:'additional',sourceLabel:'New learning'});
  for(const {data,paper} of papers){
    const ownOriginals=new Set(sourceIds(paper)),used=new Set();
    for(const group of data.questions){
      assert.ok(group.similar.length<=3,`${group.id}: at most three defensible follow-ups.`);
      for(const exercise of [group.original,...group.similar]){
        const authored=bank.questions[exercise.sourceId];
        assert.ok(authored,`${exercise.sourceId}: missing reviewed bank entry.`);
        assert.equal(questionFingerprint(stripResolvedRecall(exercise)),questionFingerprint(stripResolvedRecall(authored)),`${exercise.sourceId}: compiled mathematical or teaching content differs from reviewed bank.`);
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
        assert.ok(!used.has(followup.sourceId),`${followup.sourceId}: repeated follow-up within Paper ${paper}.`);used.add(followup.sourceId);
      }
    }
  }
});

test('new 2022 questions, concepts and follow-up relationships have complete fresh audit coverage',async()=>{
  await pair();
  const content=await validateContentAudit(root),followups=await validateFollowupAudit(root);
  assert.ok(content.questions>=310,'The existing280 bank entries plus24 previously absent2022 originals and6 preview exercises are required.');
  assert.ok(content.concepts>=108);assert.equal(content.syllabusClauses,126);
  assert.ok(followups.papers>=12);assert.ok(followups.groups>=240);
});

const require=createRequire(import.meta.url);let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function runPaper(paper,viewport){
  const context=await browser.newContext({viewport});
  const homepage=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style><script>window.progressEvents=[];addEventListener('message',e=>{if(e.source!==document.querySelector('iframe')?.contentWindow)return;if(e.data.type==='tmua-ready')e.source.postMessage({type:'tmua-resume',paperId:e.data.paperId,state:null},'*');if(e.data.type==='tmua-progress')window.progressEvents.push(e.data);if(e.data.type==='qa-sync')window.qaSync=e.data.token;});</script><iframe title="2022 paper" src="/${paper.href}"></iframe>`;
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://tmua-2022-qa.test')return route.abort();
    if(url.pathname===`/${paper.href}`)return route.fulfill({contentType:'text/html',body:paper.html});
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:homepage});
    return route.fulfill({status:404,body:'Unknown QA asset'});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('https://tmua-2022-qa.test/');
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

for(const paperNumber of [1,2])test(`browser: 2022 Paper ${paperNumber} mobile hint flow, native maths, independent recap scores and completion`,{skip:!chromium,timeout:120000},async()=>{
  const compiled=(await pair()).papers[paperNumber-1];
  const run=await runPaper(compiled,{width:390,height:844});
  const {page,frame,state,errors}=run;
  try{
    assert.equal(await frame.locator('#solution').isVisible(),false);
    await frame.locator('#check-answer').click();
    assert.equal(await frame.locator('#solution').isVisible(),false);
    assert.equal((await state()).progress.firstAttempted,0,'checking without an answer must not count as an attempt');
    let practice=0;
    for(const [index,group] of compiled.data.questions.entries()){
      await verifyLayout(frame,`P${paperNumber} Q${index+1} question`);
      if(index===0){
        await frame.locator('#give-hint').click();assert.equal(await frame.locator('#knowledge-list .knowledge').count(),1);await allHints(frame,group.original.hints.length);
        await verifyLayout(frame,`P${paperNumber} Q1 hints before answering`);
        await frame.locator('#try-again').click();
      }
      const noFollowups=group.similar.length===0;
      await answer(frame,noFollowups?(group.original.correct==='A'?'B':'A'):group.original.correct);
      if(noFollowups){
        assert.equal(await frame.locator('#similar-button').isVisible(),false,'a documented match gap must not offer unrelated filler');
        assert.equal(await frame.locator('#next-exercise-button').isDisabled(),false,'a checked miss with no follow-ups can continue safely');
      }
      await verifyLayout(frame,`P${paperNumber} Q${index+1} solution`);
      const before=(await state()).progress.firstCorrect;
      await frame.locator('#solution-hints').click();await allHints(frame,group.original.hints.length);
      await verifyLayout(frame,`P${paperNumber} Q${index+1} full hint ladder`);
      assert.equal((await state()).progress.firstCorrect,before,'recap after a correct answer must retain first-answer credit');
      if(index===0){
        const directory=process.env.TMUA_PAIR_SCREENSHOT_DIR||path.join(root,'audit-work');await mkdir(directory,{recursive:true});
        await page.screenshot({path:path.join(directory,`qa-2022-p${paperNumber}-mobile-hints.png`),fullPage:true});
      }
      await frame.locator('#try-again').click();await answer(frame,group.original.correct);
      if(index===0&&group.similar.length){
        await frame.locator('#similar-button').click();assert.equal(await frame.locator('#solution').isVisible(),false);
        await verifyLayout(frame,`P${paperNumber} first follow-up`);await answer(frame,group.similar[0].correct);practice++;
        assert.equal((await state()).progress.practiceAttempted,practice);
      }
      await frame.locator('#next-exercise-button').click();
    }
    const final=(await state()).progress;
    assert.equal(final.finished,true);assert.equal(final.completed,20);assert.equal(final.firstAttempted,20);
    assert.equal(final.firstCorrect,compiled.data.questions.filter((group,index)=>index>0&&group.similar.length>0).length,'the first original used prior hints, and no-follow-up groups deliberately tested the checked-miss path');
    assert.equal(final.afterCorrect,20);assert.equal(final.practiceAttempted,practice);assert.equal(final.practiceCorrect,practice);
    assert.equal(await frame.locator('#finished').isVisible(),true);assert.deepEqual(errors,[]);
  }finally{await run.context.close();}
});

test('browser: both 2022 papers render their first question and complete hint ladder at desktop width',{skip:!chromium,timeout:60000},async()=>{
  for(const compiled of (await pair()).papers){
    const run=await runPaper(compiled,{width:1440,height:1000});
    try{
      await verifyLayout(run.frame,`${compiled.entry.id} desktop question`);
      await run.frame.locator('#give-hint').click();await allHints(run.frame,compiled.data.questions[0].original.hints.length);
      await verifyLayout(run.frame,`${compiled.entry.id} desktop hints`);
      const directory=process.env.TMUA_PAIR_SCREENSHOT_DIR||path.join(root,'audit-work');await mkdir(directory,{recursive:true});
      await run.page.screenshot({path:path.join(directory,`qa-2022-p${compiled.paper}-desktop-hints.png`),fullPage:true});
      assert.deepEqual(run.errors,[]);
    }finally{await run.context.close();}
  }
});
