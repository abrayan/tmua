// Additional real-browser QA. All network requests are fulfilled locally;
// private uploads exercise the actual UI with an explicitly simulated SDK.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test,{before,after} from 'node:test';
import {discoverPapers} from '../tools/build-site.mjs';
import {readPaperData} from '../tools/build-reviewed-editions.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
const options={skip:!chromium,timeout:60000};
const pdf=(name,text)=>({name,mimeType:'application/pdf',buffer:Buffer.from(`%PDF-1.7\n${text}\n%%EOF`)});
const files=[pdf('paper-1.pdf','Local QA paper one'),pdf('paper-2.pdf','Local QA paper two')];
const screenshot=async(page,name)=>{await mkdir(path.join(root,'audit-work'),{recursive:true});await page.screenshot({path:path.join(root,'audit-work',name),fullPage:true});};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);

async function pdfUI({failSecond=false,width=390}={}){
  const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true});
  const page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({failSecond})=>{
    const owner='10000000-0000-4000-8000-000000000001';
    const rows=[],objects=new Map();let failed=false;
    window.qaFiles={uploads:[],insertions:[],downloads:[]};
    window.qaClient={auth:{async getUser(){return {data:{user:{id:owner}},error:null};}},
      storage:{from(){return {
        async upload(key,file,settings){
          window.qaFiles.uploads.push({key,settings,name:file.name,bytes:file.size});
          if(failSecond&&!failed&&window.qaFiles.uploads.length===2){failed=true;return {error:{message:'QA interrupted Paper 2'}};}
          objects.set(key,file);return {error:null};
        },
        async download(key){window.qaFiles.downloads.push(key);return objects.has(key)?{data:objects.get(key),error:null}:{data:null,error:{message:'Not found'}};}
      };}},
      from(){let selected;const query={select(){return query;},order(){return query;},
        async range(start,end){return {data:rows.slice(start,end+1),error:null};},
        eq(_key,value){selected=value;return query;},async maybeSingle(){return {data:rows.find(row=>row.id===selected)||null,error:null};},
        async insert(value){window.qaFiles.insertions.push(structuredClone(value));rows.unshift(...value.map(row=>({...row,created_at:new Date().toISOString()})));return {error:null};}
      };return query;}
    };
    window.qaMount=()=>window.qaController=window.TmuaFiles.mount(document.getElementById('files'),{client:window.qaClient,userId:owner});
  },{failSecond});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://runtime-files.test'){requests.push(url.href);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/cloud-files.css"><main style="padding:12px;max-width:1000px;margin:auto"><div id="files"></div></main><script src="/assets/cloud-files.js"></script><script>qaMount()</script>'});
    if(!/^\/assets\/(site\.css|cloud-files\.(js|css))$/.test(url.pathname)){requests.push(url.href);return route.abort();}
    return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(path.join(root,url.pathname.slice(1)))});
  });
  await page.goto('https://runtime-files.test/');
  await page.locator('.cloud-files-list[aria-busy="false"]').waitFor();
  const choose=async(first=files[0],second=files[1])=>{
    await page.getByLabel('Paper 1',{exact:true}).setInputFiles(first?[first]:[]);
    await page.getByLabel('Paper 2',{exact:true}).setInputFiles(second?[second]:[]);
  };
  const fill=async()=>{await page.getByLabel('Exam name',{exact:true}).fill('Local QA pair');await page.getByLabel('Pair reference',{exact:true}).fill('local-qa-pair');};
  const saved=()=>page.waitForFunction(()=>document.querySelector('.cloud-files-status')?.textContent.includes('Paper pair saved privately'));
  return {context,page,errors,requests,choose,fill,saved};
}

test('browser: paired PDF chooser validates real files, saves immutable versions, downloads exact bytes and exports metadata on mobile',options,async()=>{
  const run=await pdfUI();const {page}=run;
  try{
    const save=page.getByRole('button',{name:'Save paper pair',exact:true});
    assert.equal(await save.isDisabled(),true);
    await run.choose(files[0],null);assert.equal(await save.isDisabled(),true);
    await run.choose();await run.fill();assert.equal(await save.isEnabled(),true);
    await save.click();await run.saved();
    const stored=await page.evaluate(()=>window.qaFiles);
    assert.equal(stored.uploads.length,2);assert.equal(stored.insertions.length,1);
    const rows=stored.insertions[0];assert.equal(rows.length,2);assert.equal(rows[0].pair_id,rows[1].pair_id);
    for(const [index,row] of rows.entries()){
      assert.equal(row.paper_number,index+1);assert.equal(row.sha256,createHash('sha256').update(files[index].buffer).digest('hex'));
      assert.equal(stored.uploads[index].settings.upsert,false);
    }
    const downloadPromise=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download paper-1.pdf, version 1',exact:true}).click();
    const download=await downloadPromise;assert.equal(download.suggestedFilename(),'paper-1.pdf');
    assert.deepEqual(await readFile(await download.path()),files[0].buffer);
    const exportPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download source record',exact:true}).click();
    const metadata=JSON.parse(await readFile(await (await exportPromise).path(),'utf8'));
    assert.equal(metadata.versions.length,2);assert.equal(metadata.format,'tmua-private-pdf-sources');
    assert.equal(JSON.stringify(metadata).includes('access_token'),false);
    await page.getByLabel('Paper pair',{exact:true}).selectOption('local-qa-pair');
    assert.equal(await page.getByLabel('Pair reference',{exact:true}).isVisible(),false);
    await run.choose(pdf('paper-1-v2.pdf','Revised local paper one'),pdf('paper-2-v2.pdf','Revised local paper two'));
    await save.click();await run.saved();
    assert.equal(await page.locator('.cloud-files-older summary').innerText(),'Older versions (1)');
    await page.locator('.cloud-files-older summary').click();
    assert.equal(await page.getByRole('button',{name:'Download paper-1.pdf, version 1',exact:true}).isVisible(),true);
    const final=await page.evaluate(()=>window.qaFiles);
    assert.equal(final.insertions.length,2);assert.equal(new Set(final.uploads.map(row=>row.key)).size,4);
    assert.notEqual(final.insertions[0][0].pair_id,final.insertions[1][0].pair_id);
    assert.equal(await page.locator('.cloud-files-private').innerText(),'Private · managers only');
    assert.ok(await overflow(page)<=2,'private PDF panel fits mobile width');
    await screenshot(page,'qa-runtime-pdf-mobile.png');
    assert.deepEqual(run.errors,[]);assert.deepEqual(run.requests,[]);
  }finally{await run.context.close();}
});

test('browser: invalid PDF headers and identical files are rejected before upload; interrupted pair retries only the missing PDF',options,async()=>{
  const run=await pdfUI({failSecond:true,width:1000});const {page}=run;
  try{
    await run.fill();await run.choose(files[0],{name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('not PDF')});
    await page.getByRole('button',{name:'Save paper pair',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cloud-files-status')?.textContent.includes('valid PDF header'));
    assert.equal(await page.evaluate(()=>window.qaFiles.uploads.length),0);
    await run.choose(files[0],{...files[0],name:'different-name.pdf'});
    await page.getByRole('button',{name:'Save paper pair',exact:true}).click();
    await page.waitForFunction(()=>/different|identical|same/.test(document.querySelector('.cloud-files-status')?.textContent));
    assert.equal(await page.evaluate(()=>window.qaFiles.uploads.length),0);
    await run.choose();await page.getByRole('button',{name:'Save paper pair',exact:true}).click();
    await page.getByRole('button',{name:'Retry saving pair',exact:true}).waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.qaFiles.insertions.length),0);
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download recovery record',exact:true}).click();
    const record=JSON.parse(await readFile(await (await pending).path(),'utf8'));
    assert.deepEqual(record.pending_pair.papers.map(row=>row.uploaded),[true,false]);
    await page.getByRole('button',{name:'Retry saving pair',exact:true}).click();await run.saved();
    const final=await page.evaluate(()=>window.qaFiles);
    assert.equal(final.uploads.length,3);assert.equal(final.uploads[1].key,final.uploads[2].key);
    assert.equal(final.insertions.length,1);assert.equal(final.insertions[0].length,2);
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.locator('.cloud-files-list[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('.cloud-files-document').count(),1);
    assert.deepEqual(run.errors,[]);assert.deepEqual(run.requests,[]);
  }finally{await run.context.close();}
});

test('browser: actual paper keeps answers through Pearson flags, review, three follow-ups, reload and a second numbered attempt',options,async()=>{
  const {catalog}=await discoverPapers(root);const entry=catalog.papers.find(paper=>paper.id==='tmua-2022-p1');
  const current=entry.editions.find(edition=>edition.id===entry.currentEditionId);
  const data=readPaperData(await readFile(path.join(root,current.href),'utf8'));
  assert.equal(data.questions[0].similar.length,3,'this journey covers all three actual follow-ups');
  const context=await browser.newContext({viewport:{width:390,height:844}}),errors=[],requests=[];
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://runtime-paper.test'){requests.push(url.href);return route.abort();}
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
  const answer=async letter=>{await frame().locator(`input[name="answer"][value="${letter}"]`).check();await frame().locator('#check-answer').click();};
  try{
    await page.goto(`https://runtime-paper.test/study/#paper/${entry.id}`);await frame().locator('#check-answer').waitFor();
    await wait('record.state && record.progress.firstAttempted === 0');
    const initial=await saved();assert.equal(initial.teachingEdition,entry.currentEditionId);
    await frame().locator('#view-mode').selectOption('pearson');await frame().locator('#flag-question').check();
    await wait("record.view?.mode === 'pearson' && record.view.flags[0] === 0");
    assert.deepEqual((await saved()).state,initial.state,'display controls cannot change exercise state');
    await frame().locator('#palette-review').click();assert.equal(await frame().locator('#question-review-dialog').isVisible(),true);
    assert.equal(await frame().locator('#dialog-content [data-review-index="1"]').isDisabled(),true);
    await frame().locator('#close-review').click();assert.equal(await frame().locator('#palette-review').evaluate(node=>node===document.activeElement),true);
    await frame().locator('#question-text .source-question').click();await frame().locator('#question-review-dialog').waitFor();
    assert.equal(await frame().locator('.enlarged-question').count(),1);await frame().locator('#close-review').click();
    const correct=data.questions[0].original.correct,wrong=correct==='A'?'B':'A';
    await answer(wrong);await wait('record.progress.firstAttempted === 1');
    const attemptId=(await saved()).progress.attemptId;
    for(const [index,question] of data.questions[0].similar.entries()){
      await frame().locator('#similar-button').click();await answer(question.correct==='A'?'B':'A');
      await wait(`record.progress.practiceAttempted === ${index+1}`);
      // Independent success ends adaptive follow-ups early. Deliberate misses
      // followed by learning/redo exercise the full three-question path.
      await frame().locator('#solution-hints').click();await frame().locator('#try-again').click();await answer(question.correct);
    }
    assert.equal(await frame().locator('#similar-button').isVisible(),false);
    await frame().locator('#redo-button').click();await answer(correct);await wait('record.progress.afterCorrect === 1');
    let record=await saved();assert.equal(record.progress.firstCorrect,0);assert.equal(record.progress.practiceCorrect,0);
    assert.equal(record.answerLog[0].firstAnswer,wrong);assert.equal(record.answerLog[0].latestAnswer,correct);
    await frame().locator('#next-exercise-button').click();await wait('record.state.questionIndex === 1');
    const beforeReview=(await saved()).state;
    await frame().locator('#palette-review').click();await frame().locator('#dialog-content [data-review-index="0"]').click();
    assert.equal(await frame().locator('.reviewed-question').count(),1);assert.equal(await frame().locator('.reviewed-solution').count(),1);
    await frame().locator('#close-review').click();assert.deepEqual((await saved()).state,beforeReview);
    const currentFrame=page.frames().find(candidate=>candidate.url().includes(current.href));
    assert.ok(await currentFrame.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=2,'Pearson paper fits mobile width');
    await screenshot(page,'qa-runtime-pearson-mobile.png');
    await page.reload();await frame().locator('#check-answer').waitFor();await wait('record.state.questionIndex === 1');
    assert.equal(await frame().locator('#view-mode').inputValue(),'pearson');
    assert.match(await frame().locator('#palette-buttons [data-review-index="0"]').getAttribute('aria-label'),/flagged/);
    record=await saved();assert.equal(record.progress.attemptId,attemptId);assert.equal(record.teachingEdition,entry.currentEditionId);
    await frame().locator('#view-mode').selectOption('normal');await wait("record.view.mode === 'normal'");
    assert.deepEqual((await saved()).state,record.state);
    await page.locator('#start-another-paper-attempt').click();await frame().locator('#check-answer').waitFor();
    await wait('record.progress.firstAttempted === 0');
    const archived=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts,historyKey);
    assert.equal(archived.length,1);assert.equal(archived[0].attemptNumber,1);assert.equal(archived[0].finished,false);
    assert.equal(archived[0].teachingEdition,entry.currentEditionId);assert.equal(archived[0].answerLog[0].firstAnswer,wrong);
    await answer(correct);await wait('record.attemptNumber === 2 && record.progress.firstCorrect === 1');
    record=await saved();assert.notEqual(record.progress.attemptId,attemptId);assert.equal(record.teachingEdition,entry.currentEditionId);
    assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts,historyKey),archived);
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  }finally{await context.close();}
});
