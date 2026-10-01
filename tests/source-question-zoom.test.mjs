import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {upgradeSourceQuestionZoom,readPaperData} from '../tools/build-reviewed-editions.mjs';
const require=createRequire(import.meta.url);
const read=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
const css=await read('templates/view-modes.css'),view=await read('templates/view-modes.js');
const legacyHtml=await read('papers/paper-1/tmua-2020-p1.html');
const legacyView=[...legacyHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes("modal.className='view-dialog'"));
const oldShow=legacyView.split('\n').find(x=>x.startsWith('  function show(title,'));
const newShow=view.split('\n').find(x=>x.startsWith('  function show(title,'));
const oldHandlers=legacyView.split('\n').filter(x=>x.includes('class="enlarged-question"')).join('\n');
const marker='  // Source zoom is presentation only; the saved attempt is never changed.';
const newHandlers=view.slice(view.indexOf(marker),view.indexOf("  window.addEventListener('message'",view.indexOf(marker))).trimEnd();
const oldStyle='.enlarged-question{display:block;width:100%;height:auto}';
const newStyle=css.slice(css.indexOf('.enlarged-question{'),css.indexOf('.reviewed-solution{')).trimEnd();

test('source zoom updates only three known presentation fragments in every frozen original and is idempotent',async()=>{
  const locks=JSON.parse(await read('content/published-papers.json'));
  for(const row of locks.papers){
    const html=await read(row.href),expected=html.replace(oldStyle,newStyle).replace(oldShow,newShow).replace(oldHandlers,newHandlers);
    const actual=upgradeSourceQuestionZoom(html);
    assert.equal(actual,expected,`${row.id}: nothing outside the three presentation fragments changes`);
    assert.equal(upgradeSourceQuestionZoom(actual),actual,`${row.id}: idempotent`);
    assert.deepEqual(readPaperData(actual),readPaperData(html),`${row.id}: answers, hints, attempt metadata and concepts untouched`);
  }
  const modern=`<style>${css}</style><script>${view}</script>`;
  assert.equal(upgradeSourceQuestionZoom(modern),modern,'current template and compiler recognition constants agree exactly');
});

test('unknown or partial zoom upgrades fail closed while data-only fixtures are unchanged',()=>{
  const modern=`<style>${css}</style><script>${view}</script>`;
  const legacy=`<style>${oldStyle}</style><script>${legacyView}</script>`;
  for(const html of [
    legacy.replace('width:100%','width:99%'),
    legacy.replace('function show(title,','function changedShow(title,'),
    legacy.replace(oldHandlers,oldHandlers.split('\n')[0]),
    legacy.replace(oldStyle,newStyle),
    legacy.replace(oldHandlers,newHandlers),
    modern.replace('touch-action:pan-x pan-y','touch-action:none'),
    modern.replace("show('Question',sourceQuestionHTML(image),image)","show('Question','changed',image)"),
    modern+`<style>${newStyle}</style>`,
    modern+`<script>${view}</script>`
  ])assert.throws(()=>upgradeSourceQuestionZoom(html),/source zoom/);
  const inert=`<!-- ${legacy} --><script type="application/json">${JSON.stringify({example:legacy})}</script>`;
  assert.equal(upgradeSourceQuestionZoom(inert),inert);
});

let chromium,browser;
try{({chromium}=require(process.env.TMUA_PLAYWRIGHT_PATH||'playwright'));}catch{}
before(async()=>{if(chromium)browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],args:['--disable-features=OverlayScrollbar,FluentOverlayScrollbar']});});
after(async()=>{await browser?.close();});
const source='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2400"><rect width="1800" height="2400" fill="white"/><text x="30" y="50" font-size="36">Top left question text</text><text x="1500" y="50" font-size="36">Right edge</text><text x="30" y="2370" font-size="36">Last option</text><rect x="1700" y="2300" width="90" height="90" fill="blue"/></svg>').toString('base64');
function fixture(){return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}main{width:min(900px,calc(100% - 24px));margin:auto}button{padding:10px} ${css}</style><script id="tmua-paper-meta" type="application/json">{"id":"source-zoom-fixture","questionCount":1}</script><main><section id="question-section"><div id="question-text"><img class="source-question" tabindex="0" role="button" aria-label="Enlarge question" alt="Full synthetic question including final option" src="${source}"></div><div id="choices"></div></section></main><script>${view}</script>`;}
const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
for(const width of [390,1280])for(const mode of ['normal','pearson'])test(`intrinsic image is readable and scrollable on ${mode} ${width}px; Back and focus remain available`,{skip:!chromium},async()=>{
  const context=await browser.newContext({viewport:{width,height:800},isMobile:width===390,hasTouch:width===390});const page=await context.newPage();
  try{
    await page.setContent(fixture());await page.selectOption('#view-mode',mode);await page.locator('.source-question').evaluate(im=>im.decode());
    await page.locator('.source-question').focus();await page.keyboard.press('Enter');await settle(page);
    const before=await page.evaluate(()=>{const s=document.querySelector('.source-question-scroll'),i=s.querySelector('img'),d=document.querySelector('dialog'),b=document.querySelector('#close-review'),r=b.getBoundingClientRect();return {natural:i.naturalWidth,image:i.getBoundingClientRect().width,original:document.querySelector('.source-question').getBoundingClientRect().width,w:s.clientWidth,h:s.clientHeight,sw:s.scrollWidth,sh:s.scrollHeight,focused:document.activeElement===s,role:s.getAttribute('role'),label:s.getAttribute('aria-label'),touch:getComputedStyle(s).touchAction,dialog:d.getBoundingClientRect().toJSON(),button:r.toJSON(),pageWidth:document.documentElement.clientWidth,pageScroll:document.documentElement.scrollWidth};});
    assert.equal(before.image,before.natural,'intrinsic image width is preserved instead of shrinking to mobile width');assert.ok(before.image>before.original,'enlargement increases text and diagram size');assert.ok(before.sw>before.w&&before.sh>before.h,'both axes are reachable inside the image region');assert.ok(before.focused);assert.equal(before.role,'region');assert.equal(before.label,'Enlarged question');assert.equal(before.touch,'pan-x pan-y');assert.ok(before.pageScroll<=before.pageWidth+1);
    await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>{const s=document.querySelector('.source-question-scroll');return s.scrollLeft>0&&s.scrollTop>0;});
    if(width===390){
      await page.locator('.source-question-scroll').evaluate(s=>{s.scrollTo(0,0);});await settle(page);
      const box=await page.locator('.source-question-scroll').boundingBox(),session=await context.newCDPSession(page);
      await session.send('Input.synthesizeScrollGesture',{x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2),xDistance:-120,yDistance:-180,gestureSourceType:'touch'});
      await page.waitForFunction(()=>{const s=document.querySelector('.source-question-scroll');return s.scrollTop>0||s.scrollLeft>0;});await session.detach();
    }
    await page.locator('.source-question-scroll').evaluate(s=>s.scrollTo(s.scrollWidth,s.scrollHeight));await settle(page);
    const end=await page.evaluate(()=>{const s=document.querySelector('.source-question-scroll'),i=s.querySelector('img'),b=document.querySelector('#close-review'),r=b.getBoundingClientRect(),v=s.getBoundingClientRect(),ir=i.getBoundingClientRect();return {left:s.scrollLeft,top:s.scrollTop,remainingX:s.scrollWidth-s.clientWidth-s.scrollLeft,remainingY:s.scrollHeight-s.clientHeight-s.scrollTop,button:r.toJSON(),image:ir.toJSON(),region:v.toJSON(),height:innerHeight,width:innerWidth};});
    assert.ok(end.left>0&&end.top>0);assert.ok(end.remainingX<=1&&end.remainingY<=1,'last column and final option are reachable: '+JSON.stringify(end));assert.ok(end.button.top>=0&&end.button.bottom<end.height&&end.button.left>=0&&end.button.right<=end.width,'Back button stays inside the viewport after scrolling to bottom right');assert.ok(Math.abs(end.button.top-before.button.top)<=1,'header does not move with image scroll');
    await page.click('#close-review');assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);assert.equal(await page.locator('dialog').isVisible(),false,'closed dialog is visually hidden');assert.equal(await page.locator('.source-question').evaluate(im=>im===document.activeElement),true,'button close restores source focus');
    await page.keyboard.press('Space');await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);assert.equal(await page.locator('dialog').isVisible(),false,'closed dialog is visually hidden');assert.equal(await page.locator('.source-question').evaluate(im=>im===document.activeElement),true,'Escape restores source focus');
    if(width===390){await page.locator('.source-question').tap();assert.equal(await page.locator('dialog').evaluate(d=>d.open),true,'touch opens same shared zoom');await page.locator('#close-review').tap();assert.equal(await page.locator('dialog').isVisible(),false,'touch close hides dialog');}
  }finally{await context.close();}
});
