import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {compileReviewedPaper,readPaperData,replacePaperData,upgradeAdditionalRecallRenderer,upgradeMathPresentation} from '../tools/build-reviewed-editions.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>readFile(path.join(root,name),'utf8');
const json=async name=>JSON.parse(await read(name));
const html=await read('papers/paper-1/tmua-2020-p1.html');
const [bank,plan,studiedLessons,catalogue,questionAudits]=await Promise.all(['content/official-question-bank.json','content/tmua-2020-p1-plan.json','content/studied-lessons.json','assets/studied-concepts.json','content/question-audits.json'].map(json));
const compiled=compileReviewedPaper({html,bank,plan,studiedLessons,catalogue,questionAudits});
const renderer=value=>value.match(/  function recallHTML\(hint\) \{[\s\S]*?\n  \}/)?.[0];
const legacyRenderer=renderer(html),currentRenderer=renderer(await read('templates/paper-player.js'));
const extraId='p1-extra-simultaneous-equations';

test('new-learning recall is authoritative, self-contained and has no invented booklet/page reference',()=>{
  const data=readPaperData(compiled),q=data.questions.find(g=>g.original.sourceId==='2020-P1-Q02').original;
  const reference=q.hints.flatMap(h=>h.recall).find(ref=>ref.lessonId===extraId);
  const concept=catalogue.additionalConcepts.find(c=>c.id===extraId);
  assert.deepEqual(reference,{lessonId:extraId,reminder:bank.questions[q.sourceId].hints.flatMap(h=>h.recall).find(ref=>ref.lessonId===extraId).reminder,title:concept.title,paper:1,kind:'additional',sourceLabel:'New learning'});
  for(const key of ['booklet','number','pdfPage'])assert.equal(Object.hasOwn(reference,key),false);
  assert.equal(renderer(compiled),currentRenderer);
  const strip=value=>replacePaperData(value,null).replace(renderer(value),'RECALL-RENDERER').replace(/(<script[^>]*id="tmua-paper-meta"[^>]*>)[\s\S]*?(<\/script>)/,'$1null$2');
  assert.equal(strip(compiled),strip(upgradeMathPresentation(html)),'outside the reviewed recall and MathML presentation upgrades, all player/state/scoring bytes remain frozen');
});

test('renderer upgrade is idempotent, script-scoped and refuses missing, duplicate or unknown player forms',()=>{
  assert.equal(upgradeAdditionalRecallRenderer(compiled),compiled);
  assert.equal(renderer(upgradeAdditionalRecallRenderer(html)),currentRenderer);
  assert.throws(()=>upgradeAdditionalRecallRenderer(html.replace(legacyRenderer,legacyRenderer.replace('function recallHTML','function anotherFunction'))),/recognized player renderer/);
  assert.throws(()=>upgradeAdditionalRecallRenderer(html+`<script>${legacyRenderer}</script>`),/recognized player renderer/);
  assert.throws(()=>upgradeAdditionalRecallRenderer(`<!-- <script>${legacyRenderer}</script> -->`),/recognized player renderer/);
  assert.throws(()=>upgradeAdditionalRecallRenderer(`<script type="application/json">${legacyRenderer}</script>`),/recognized player renderer/);
});

test('catalogue titles are JSON-script-safe and escaped at render time, while reminder MathML remains intact',()=>{
  const malicious='Equations </script><img src=x onerror="window.bad=1"> & title';
  const copy=structuredClone(catalogue);copy.additionalConcepts.find(c=>c.id===extraId).title=malicious;
  const output=compileReviewedPaper({html,bank,plan,studiedLessons,catalogue:copy,questionAudits});
  assert.equal((output.match(/<\/script>/g)||[]).length,(html.match(/<\/script>/g)||[]).length);
  const window={},context={window};vm.createContext(context);
  vm.runInContext(`const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));${currentRenderer};window.render=recallHTML;`,context);
  const result=window.render({recall:[{lessonId:extraId,kind:'additional',paper:1,title:malicious,reminder:'Use <math><mi>x</mi></math>.'}]});
  assert.doesNotMatch(result,/<img|<\/script>|Booklet|PDF p\./);assert.match(result,/&lt;img/);assert.match(result,/<math><mi>x<\/mi><\/math>/);
  const ordinary=window.render({recall:[{lessonId:'p1-b1-l01',paper:1,booklet:1,number:1,pdfPage:2,title:'Real lesson',reminder:'Recall the rule.'}]});
  assert.match(ordinary,/Remember · Paper 1 · Booklet 1 · Lesson 1/);assert.match(ordinary,/PDF p\. 2/);
});

test('extra recall without a reviewed catalogue or safe provenance fails closed',()=>{
  assert.throws(()=>compileReviewedPaper({html,bank,plan,studiedLessons,questionAudits}),/unknown knowledge recall/);
  for(const mutate of [c=>c.additionalConcepts.find(c=>c.id===extraId).paper=2,c=>c.additionalConcepts.find(c=>c.id===extraId).references=[],c=>c.additionalConcepts.push(structuredClone(c.additionalConcepts[0]))]){
    const copy=structuredClone(catalogue);mutate(copy);assert.throws(()=>compileReviewedPaper({html,bank,plan,studiedLessons,catalogue:copy,questionAudits}),/invalid additional concept/);
  }
});

const require=createRequire(import.meta.url);let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true});});after(async()=>{await browser?.close();});
test('browser: progressive hints and correct-answer recap both show New learning and native maths',{skip:!chromium},async()=>{
  for(const useHints of [true,false]){
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.route('https://recall.test/**',async route=>{
      const name=new URL(route.request().url()).pathname;
      if(name.endsWith('/paper.html'))return route.fulfill({contentType:'text/html',body:compiled});
      if(name.startsWith('/assets/bank/')){try{return route.fulfill({body:await readFile(path.join(root,name.slice(1)))});}catch{}}
      return route.fulfill({status:404,body:''});
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await page.goto('https://recall.test/papers/paper-1/paper.html');
      await page.locator(`input[value="${bank.questions['2020-P1-Q01'].correct}"]`).check();await page.locator('#check-answer').click();await page.locator('#next-exercise-button').click();
      await page.locator('#exercise-label').filter({hasText:'Question 2'}).waitFor();
      if(useHints){
        await page.locator('#give-hint').click();await page.locator('#next-piece').click();await page.locator('#next-piece').click();
        const recall=page.locator(`#knowledge-list [data-lesson-id="${extraId}"]`);
        assert.match(await recall.innerText(),/New learning · Paper 1/);assert.doesNotMatch(await recall.innerText(),/Booklet|PDF p\.|undefined/);
        assert.ok(await page.locator('#knowledge-list math').count()>0);
        await page.locator('#try-again').click();
      }
      await page.locator(`input[value="${bank.questions['2020-P1-Q02'].correct}"]`).check();await page.locator('#check-answer').click();
      const recap=page.locator(`#knowledge-recap [data-lesson-id="${extraId}"]`);
      assert.match(await recap.innerText(),/New learning · Paper 1/);assert.doesNotMatch(await recap.innerText(),/Booklet|PDF p\.|undefined/);
      assert.equal(await page.locator('#feedback').innerText(),'Correct. Recap the knowledge steps and their pitfalls below.');
      const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('tmua-paper:tmua-2020-p1:v1')));
      assert.equal(saved.records[1].first,useHints?0:1);assert.equal(saved.records[1].everSolved,true);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  }
});
