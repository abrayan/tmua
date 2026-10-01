#!/usr/bin/env node
// Create append-only teaching editions without rebuilding the frozen player.
import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverPapers, parseMetadata} from './build-site.mjs';
import {canonicalJson, questionFingerprint, validateContentAudit} from './validate-content-audit.mjs';
import {validateFollowupAudit} from './validate-followup-audit.mjs';
import {assertPublicMockPlan,assertPublicMockPaper} from './public-mock-sources.mjs';

const siteRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
const fail=message=>{throw Error(`Reviewed editions: ${message}`);};
const jsonFile=async(root,name)=>JSON.parse(await readFile(path.join(root,name),'utf8'));
const safeId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)&&value!=='original';

function dataScript(html,scriptId='tmua-paper-data'){
  const found=[];
  for(const match of html.matchAll(/<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/script\s*>|$)/gi)){
    if(match[1]===undefined)continue;
    const attrs={};
    for(const attr of match[1].matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[attr[1].toLowerCase()]=attr[2]??attr[3]??attr[4]??'';
    if(attrs.id!==scriptId)continue;
    if(attrs.type?.toLowerCase()!=='application/json'||!match[3])fail('paper data must be one complete application/json script.');
    const start=match.index+7+match[1].length+1;
    found.push({start,end:start+match[2].length,text:match[2]});
  }
  if(found.length!==1)fail(`paper must contain exactly one ${scriptId} script.`);
  return found[0];
}
export function readPaperData(html){return JSON.parse(dataScript(html).text);}
function replaceJsonScript(html,data,scriptId='tmua-paper-data'){
  const section=dataScript(html,scriptId);
  const encoded=JSON.stringify(data).replaceAll('<','\\u003c').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  return html.slice(0,section.start)+encoded+html.slice(section.end);
}
export function replacePaperData(html,data){return replaceJsonScript(html,data);}
function lessonIndex(catalogue,concepts){
  if(catalogue?.version!==1||!Array.isArray(catalogue.booklets))fail('invalid studied lessons.');
  const index=new Map();
  for(const booklet of catalogue.booklets)for(const lesson of booklet.lessons){
    if(index.has(lesson.id))fail(`duplicate studied lesson ${lesson.id}.`);
    index.set(lesson.id,{title:lesson.title,paper:booklet.paper,booklet:booklet.booklet,number:lesson.number,pdfPage:lesson.pdfPage,...(lesson.sourceLabel?{sourceLabel:lesson.sourceLabel}:{})});
  }
  if(concepts!==undefined){
    if(concepts?.version!==1||!Array.isArray(concepts.additionalConcepts))fail('invalid additional concepts.');
    for(const concept of concepts.additionalConcepts){
      if(!concept||typeof concept.id!=='string'||!/^p[12]-extra-[a-z0-9-]+$/.test(concept.id)||index.has(concept.id)||![1,2].includes(concept.paper)||!concept.id.startsWith(`p${concept.paper}-`)||typeof concept.title!=='string'||!concept.title.trim()
        ||!Array.isArray(concept.references)||!concept.references.length||concept.references.some(ref=>{
          if(!ref||!['syllabus','question'].includes(ref.type)||typeof ref.label!=='string'||!ref.label.trim())return true;
          try{const url=new URL(ref.url);return url.protocol!=='https:'||Boolean(url.username||url.password);}catch{return true;}
        }))fail(`invalid additional concept ${concept?.id}.`);
      index.set(concept.id,{title:concept.title,paper:concept.paper,kind:'additional',sourceLabel:'New learning'});
    }
  }
  return index;
}
function requireGroupOrder(groups,frozen,label){
  if(!Array.isArray(groups)||groups.length!==frozen.length||groups.some((group,index)=>group.id!==frozen[index].id))fail(`${label} must preserve original group IDs and order.`);
}

const legacyRecallRenderer="  function recallHTML(hint) {\n    return (hint.recall || []).map(lesson => {\n      const section = /^method/i.test(lesson.sourceLabel || '') ? 'Section' : 'Lesson';\n      return `<aside class=\"lesson-recall\" data-lesson-id=\"${esc(lesson.lessonId)}\"><p class=\"recall-label\">Remember \u00b7 Paper ${esc(lesson.paper)} \u00b7 Booklet ${esc(lesson.booklet)} \u00b7 ${section} ${esc(lesson.number)}</p><p class=\"recall-title\">${esc(lesson.title)} <span class=\"recall-page\">PDF p. ${esc(lesson.pdfPage)}</span></p><p class=\"recall-reminder\">${lesson.reminder}</p></aside>`;\n    }).join('');\n  }";
const additionalRecallRenderer="  function recallHTML(hint) {\n    return (hint.recall || []).map(lesson => {\n      if (lesson.kind === 'additional') {\n        return `<aside class=\"lesson-recall\" data-lesson-id=\"${esc(lesson.lessonId)}\"><p class=\"recall-label\">New learning \u00b7 Paper ${esc(lesson.paper)}</p><p class=\"recall-title\">${esc(lesson.title)}</p><p class=\"recall-reminder\">${lesson.reminder}</p></aside>`;\n      }\n      const section = /^method/i.test(lesson.sourceLabel || '') ? 'Section' : 'Lesson';\n      return `<aside class=\"lesson-recall\" data-lesson-id=\"${esc(lesson.lessonId)}\"><p class=\"recall-label\">Remember \u00b7 Paper ${esc(lesson.paper)} \u00b7 Booklet ${esc(lesson.booklet)} \u00b7 ${section} ${esc(lesson.number)}</p><p class=\"recall-title\">${esc(lesson.title)} <span class=\"recall-page\">PDF p. ${esc(lesson.pdfPage)}</span></p><p class=\"recall-reminder\">${lesson.reminder}</p></aside>`;\n    }).join('');\n  }";
// Only this presentation function changes in newly emitted teaching editions.
// A changed/unknown player fails closed; attempt/state/scoring code is untouched.
export function upgradeAdditionalRecallRenderer(html){
  const matches=[];
  for(const script of html.matchAll(/<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/script\s*>|$)/gi)){
    if(script[1]===undefined||!script[3]||/application\/json/i.test(script[1]))continue;
    for(const renderer of [legacyRecallRenderer,additionalRecallRenderer]){
      let from=0,index;
      while((index=script[2].indexOf(renderer,from))!==-1){matches.push({start:script.index+7+script[1].length+1+index,renderer});from=index+renderer.length;}
    }
  }
  if(matches.length!==1)fail('new-learning recall needs exactly one recognized player renderer.');
  const {start,renderer}=matches[0];
  return html.slice(0,start)+additionalRecallRenderer+html.slice(start+renderer.length);
}

const legacyMathStyle="    math { font-family: \"STIX Two Math\", \"Cambria Math\", Georgia, serif; math-style: normal; max-width: 100%; overflow-x: auto; vertical-align: middle; padding-block: .12em; }";
const reviewedMathStyle="    math { font-family: \"STIX Two Math\", \"Cambria Math\", Georgia, serif; math-style: normal; max-width: none; overflow: visible; vertical-align: middle; padding-block: .12em; }";
const reviewedMathWrappers=String.raw`    /* Keep MathML ink visible; scroll only equations wider than their container. */
    .math-wrap { display: inline-block; max-width: 100%; vertical-align: middle; }
    .math-wrap > math { vertical-align: baseline; }
    .math-wrap.math-scroll { overflow: auto; padding-block: .5em; }
    .choice > span { min-width: 0; }`;
const reviewedMathPresentation=String.raw`// Presentation only: do not re-render or alter the saved attempt when equations resize.
(() => {
  'use strict';
  if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return;
  const wrappers = new Set();
  const fit = wrapper => {
    if (!wrapper.clientWidth) return; // Hidden hints are measured when shown.
    const wide = wrapper.firstElementChild.getBoundingClientRect().width > wrapper.clientWidth + 1;
    wrapper.classList.toggle('math-scroll', wide);
  };
  const resize = new ResizeObserver(entries => entries.forEach(({target}) => fit(target)));
  let queued = false;
  const prepare = () => {
    queued = false;
    for (const wrapper of wrappers) if (!wrapper.isConnected) {
      resize.unobserve(wrapper); wrappers.delete(wrapper);
    }
    document.querySelectorAll('math').forEach(math => {
      if (math.parentElement.classList.contains('math-wrap')) return;
      const wrapper = document.createElement('span');
      wrapper.className = 'math-wrap';
      math.before(wrapper); wrapper.append(math);
      wrappers.add(wrapper); resize.observe(wrapper); fit(wrapper);
    });
  };
  new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(prepare); }
  }).observe(document.body, {childList:true, subtree:true});
  prepare();
})();`;

// Upgrade only layout in a new edition. Never rebuild its frozen attempt player.
// The constants mirror the tested template; unknown or partial upgrades fail closed.
function inlinePresentationBlocks(html){
  const blocks=[];
  for(const match of html.matchAll(/<!--[\s\S]*?-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/\1\s*>|$)/gi)){
    if(!match[1]||!match[4]||(match[1].toLowerCase()==='script'&&/application\/json/i.test(match[2])))continue;
    const start=match.index+1+match[1].length+match[2].length+1;
    blocks.push({tag:match[1].toLowerCase(),start,end:start+match[3].length,text:match[3]});
  }
  return blocks;
}
export function upgradeMathPresentation(html){
  const blocks=inlinePresentationBlocks(html),styles=blocks.filter(block=>block.tag==='style'),scripts=blocks.filter(block=>block.tag==='script');
  const playerMarker="  const data = JSON.parse(document.getElementById('tmua-paper-data').textContent);";
  const players=scripts.filter(block=>block.text.includes(playerMarker));
  const mathRules=styles.flatMap(block=>[...block.text.matchAll(/(?:^|\n)    math \{[^}]*\}/g)].map(match=>({block,text:match[0].replace(/^\n/,''),start:block.start+match.index+(match[0].startsWith('\n')?1:0)})));
  const presentationMarker='// Presentation only: do not re-render or alter the saved attempt when equations resize.';
  const hasPresentation=scripts.some(block=>block.text.includes(presentationMarker));
  const hasWrappers=styles.some(block=>block.text.includes('.math-wrap'));
  // Minimal synthetic/non-player documents have no presentation to upgrade.
  if(!players.length&&!mathRules.length&&!hasPresentation&&!hasWrappers)return html;
  if(players.length!==1||mathRules.length!==1)fail('MathML layout needs exactly one recognized player and math style.');
  const player=players[0],rule=mathRules[0];
  const fullWrappers=styles.reduce((n,block)=>n+block.text.split(reviewedMathWrappers).length-1,0);
  const fullHelpers=scripts.reduce((n,block)=>n+block.text.split(reviewedMathPresentation).length-1,0);
  if(rule.text===reviewedMathStyle&&hasWrappers&&hasPresentation){
    if(fullWrappers!==1||fullHelpers!==1||!player.text.endsWith(reviewedMathPresentation+'\n'))fail('MathML layout has an unknown or partial presentation upgrade.');
    return html;
  }
  if(rule.text!==legacyMathStyle||hasWrappers||hasPresentation||!player.text.endsWith("  else save();\n})();\n"))fail('MathML layout has an unknown or partial presentation upgrade.');
  const edits=[
    {start:rule.start,end:rule.start+rule.text.length,text:reviewedMathStyle+'\n'+reviewedMathWrappers},
    {start:player.end,end:player.end,text:'\n'+reviewedMathPresentation+'\n'}
  ].sort((a,b)=>b.start-a.start);
  for(const edit of edits)html=html.slice(0,edit.start)+edit.text+html.slice(edit.end);
  return html;
}

const legacySourceShow="  function show(title,html,button){if(!modal.open)opener=button||document.activeElement;$('dialog-title').textContent=title;$('dialog-content').innerHTML=html;modal.showModal();$('close-review').focus();}";
const reviewedSourceShow="  function show(title,html,button){if(!modal.open)opener=button||document.activeElement;modal.classList.remove('source-zoom');$('dialog-title').textContent=title;$('dialog-content').innerHTML=html;modal.showModal();$('close-review').focus();}";
const legacySourceHandlers="  document.addEventListener('click',e=>{const image=e.target.closest('.source-question');if(image)show('Question',`<img class=\"enlarged-question\" src=\"${esc(image.src)}\" alt=\"${esc(image.alt)}\">`,image);});\n  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.source-question')){e.preventDefault();show('Question',`<img class=\"enlarged-question\" src=\"${esc(e.target.src)}\" alt=\"${esc(e.target.alt)}\">`,e.target);}});";
const reviewedSourceHandlers="  // Source zoom is presentation only; the saved attempt is never changed.\n  function sourceQuestionHTML(image){\n    return `<p class=\"source-zoom-help\" id=\"source-zoom-help\">Scroll across and down to read the full question.</p><div class=\"source-question-scroll\" tabindex=\"0\" role=\"region\" aria-label=\"Enlarged question\" aria-describedby=\"source-zoom-help\"><img class=\"enlarged-question\" src=\"${esc(image.src)}\" alt=\"${esc(image.alt)}\"></div>`;\n  }\n  function showSourceQuestion(image){\n    show('Question',sourceQuestionHTML(image),image);\n    modal.classList.add('source-zoom');\n    modal.querySelector('.source-question-scroll').focus({preventScroll:true});\n  }\n  document.addEventListener('click',e=>{const image=e.target.closest('.source-question');if(image)showSourceQuestion(image);});\n  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.source-question')){e.preventDefault();showSourceQuestion(e.target);}});";
const legacySourceStyle=".enlarged-question{display:block;width:100%;height:auto}";
const reviewedSourceStyle=".enlarged-question{display:block;width:auto;max-width:none;height:auto}\n/* Intrinsic-size question zoom: scroll the image, keep Back to practice reachable. */\n.view-dialog.source-zoom[open]{display:flex;flex-direction:column;height:94vh;height:94dvh;overflow:hidden}\n.view-dialog.source-zoom .dialog-bar{flex:0 0 auto;position:relative}\n.view-dialog.source-zoom #dialog-content{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;padding:0;overflow:hidden}\n.source-zoom-help{flex:0 0 auto;margin:0;padding:10px 14px;font:13px/1.4 Arial,sans-serif;color:#526474}\n.source-question-scroll{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y;padding:12px}\n.source-question-scroll:focus-visible{outline:3px solid #205da0;outline-offset:-3px}";

// Only recognised source-image zoom presentation is upgraded in newly emitted editions.
export function upgradeSourceQuestionZoom(html){
  const blocks=inlinePresentationBlocks(html),styles=blocks.filter(b=>b.tag==='style'),scripts=blocks.filter(b=>b.tag==='script');
  const marker="modal.className='view-dialog';modal.id='question-review-dialog'";
  const views=scripts.filter(b=>b.text.includes(marker));
  const rules=styles.flatMap(b=>[...b.text.matchAll(/\.enlarged-question\{[^}]*\}/g)].map(m=>({block:b,text:m[0],start:b.start+m.index})));
  const hasHelper=scripts.some(b=>b.text.includes('function sourceQuestionHTML('));
  const hasStyle=styles.some(b=>b.text.includes('/* Intrinsic-size question zoom:'));
  // Synthetic data-only fixtures have no view presentation to upgrade.
  if(!views.length&&!rules.length&&!hasHelper&&!hasStyle)return html;
  if(views.length!==1||rules.length!==1)fail('source zoom needs exactly one recognised view script and image style.');
  const view=views[0],rule=rules[0],count=(s,part)=>s.split(part).length-1;
  if(hasHelper||hasStyle){
    if(count(view.text,reviewedSourceShow)!==1||count(view.text,reviewedSourceHandlers)!==1||count(rule.block.text,reviewedSourceStyle)!==1
      ||count(view.text,'function sourceQuestionHTML(')!==1||count(rule.block.text,'/* Intrinsic-size question zoom:')!==1
      ||view.text.includes(legacySourceHandlers)||view.text.includes(legacySourceShow))fail('source zoom has an unknown or partial presentation upgrade.');
    return html;
  }
  if(rule.text!==legacySourceStyle||count(view.text,legacySourceShow)!==1||count(view.text,legacySourceHandlers)!==1)fail('source zoom has an unknown or partial presentation upgrade.');
  const edits=[
    {start:rule.start,end:rule.start+rule.text.length,text:reviewedSourceStyle},
    {start:view.start+view.text.indexOf(legacySourceShow),end:view.start+view.text.indexOf(legacySourceShow)+legacySourceShow.length,text:reviewedSourceShow},
    {start:view.start+view.text.indexOf(legacySourceHandlers),end:view.start+view.text.indexOf(legacySourceHandlers)+legacySourceHandlers.length,text:reviewedSourceHandlers}
  ].sort((a,b)=>b.start-a.start);
  for(const e of edits)html=html.slice(0,e.start)+e.text+html.slice(e.end);
  return html;
}

export function compileReviewedPaper({html,bank,plan,preview,studiedLessons,catalogue,questionAudits}){
  const original=readPaperData(html),metadata=parseMetadata(html);
  if(original.metadata?.id!==metadata.id||!Array.isArray(original.questions)||original.questions.length!==metadata.questionCount)fail('embedded metadata disagrees with the frozen paper.');
  const lessons=lessonIndex(studiedLessons,catalogue);
  const reviews=new Map();
  for(const review of questionAudits?.reviews||[]){if(reviews.has(review.sourceId))fail(`duplicate audit ${review.sourceId}.`);reviews.set(review.sourceId,review);}
  function reviewed(exercise,sourceId,previewExercise=false){
    if(!exercise||typeof exercise!=='object')fail(`missing source ${sourceId}.`);
    if(!previewExercise&&exercise.sourceId!==sourceId)fail(`source ID disagrees for ${sourceId}.`);
    const raw={...clone(exercise),sourceId};
    if(previewExercise)raw.conceptIds??=clone(reviews.get(sourceId)?.conceptIds);
    const auditQuestion=previewExercise?{...raw,lead:Object.fromEntries(['lead','tail','latex','fallback','formulaLabel'].map(key=>[key,raw[key]??'']))}:raw;
    const review=reviews.get(sourceId);
    if(!review||review.verifiedAnswer!==raw.correct||review.contentHash!==questionFingerprint(auditQuestion))fail(`missing, stale or incorrect audit for ${sourceId}.`);
    if(!Array.isArray(raw.conceptIds)||!raw.conceptIds.length||canonicalJson([...raw.conceptIds].sort())!==canonicalJson([...(review.conceptIds||[])].sort()))fail(`audited conceptIds disagree for ${sourceId}.`);
    raw.hints=raw.hints.map(hint=>({...hint,recall:hint.recall.map(reference=>{
      const lesson=lessons.get(reference.lessonId);
      if(!lesson)fail(`unknown knowledge recall ${reference.lessonId} in ${sourceId}.`);
      return {lessonId:reference.lessonId,reminder:reference.reminder,...lesson};
    })}));
    return raw;
  }
  const data=clone(original);
  if(plan){
    assertPublicMockPlan(plan,bank.questions);
    if(plan.metadata?.id!==metadata.id)fail('plan ID disagrees with the frozen paper.');
    requireGroupOrder(plan.groups,original.questions,'Plan');
    // A revised description can accurately describe a reduced follow-up pool.
    // All state-critical metadata and the frozen player remain unchanged.
    if(plan.metadata.description!==undefined){
      if(typeof plan.metadata.description!=='string'||plan.metadata.description.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(plan.metadata.description))fail('invalid reviewed description.');
      data.metadata.description=plan.metadata.description;
    }
    const originals=new Set(original.questions.map(group=>group.original.sourceId));
    data.questions=original.questions.map((group,index)=>{
      const planned=plan.groups[index];
      if(planned.originalId!==group.original.sourceId)fail(`${group.id}: plan cannot change the assessment source.`);
      if(!Array.isArray(planned.candidates)||planned.candidates.length>3||new Set(planned.candidates).size!==planned.candidates.length||planned.candidates.some(id=>originals.has(id)))fail(`${group.id}: invalid reviewed follow-up selection.`);
      if(plan.metadata.requiresThreeFollowups&&planned.candidates.length!==3)fail(`${group.id}: plan requires three follow-ups.`);
      const exercise=id=>reviewed(bank.questions[id],id);
      const next={...group,original:exercise(planned.originalId),similar:planned.candidates.map(exercise)};
      // Existing revision-2 players retain their legacy pool and its order.
      // Only its teaching is refreshed; the plan cannot remove old entries.
      if(group.legacySimilar!==undefined){
        if(!Array.isArray(group.legacySimilar))fail(`${group.id}: malformed frozen legacy pool.`);
        next.legacySimilar=group.legacySimilar.map(item=>exercise(item.sourceId));
      }else if(planned.legacyCandidates!==undefined){
        if(!Array.isArray(planned.legacyCandidates))fail(`${group.id}: malformed planned legacy pool.`);
        next.legacySimilar=planned.legacyCandidates.map(exercise);
      }
      return next;
    });
  }else if(preview){
    if(preview.metadata?.id!==metadata.id)fail('preview ID disagrees with the frozen paper.');
    requireGroupOrder(preview.questions,original.questions,'Preview');
    data.questions=original.questions.map((group,index)=>{
      const source=preview.questions[index];
      if(!Array.isArray(source.similar)||source.similar.length!==group.similar.length)fail(`${group.id}: preview exercise membership must remain stable.`);
      return {...group,original:reviewed(source.original,`preview-${group.id}-original`,true),similar:source.similar.map((item,n)=>reviewed(item,`preview-${group.id}-similar${n+1}`,true))};
    });
  }else fail(`no reviewed plan or preview source for ${metadata.id}.`);
  assertPublicMockPaper(data);
  let result=upgradeSourceQuestionZoom(upgradeMathPresentation(replacePaperData(html,data)));
  const hasAdditional=data.questions.some(group=>[group.original,...group.similar,...(group.legacySimilar||[])].some(exercise=>exercise.hints.some(hint=>hint.recall.some(ref=>ref.kind==='additional'))));
  if(hasAdditional)result=upgradeAdditionalRecallRenderer(result);
  if(data.metadata.description!==metadata.description){
    const publicMetadata=JSON.parse(dataScript(result,'tmua-paper-meta').text);
    result=replaceJsonScript(result,{...publicMetadata,description:data.metadata.description},'tmua-paper-meta');
    parseMetadata(result);
  }
  return result;
}

async function regularPath(root,relative,{missing=false}={}){
  let current=root;
  for(const segment of relative.split('/')){
    current=path.join(current,segment);
    let stats;
    try{stats=await lstat(current);}catch(error){if(missing&&error.code==='ENOENT')return false;throw error;}
    if(stats.isSymbolicLink()||(!stats.isDirectory()&&!stats.isFile()))fail(`unsafe file path ${relative}.`);
    if(current!==path.join(root,relative)&&!stats.isDirectory())fail(`unsafe parent directory for ${relative}.`);
  }
  return true;
}

export async function prepareReviewedEditions(root=siteRoot,{editionId='review-20260930'}={}){
  root=path.resolve(root);
  if(!safeId(editionId))fail('invalid edition ID.');
  const lockName='content/published-papers.json';
  await regularPath(root,lockName);
  const lockBytes=await readFile(path.join(root,lockName));
  const lock=JSON.parse(lockBytes);
  if(lock.version!==1||!Array.isArray(lock.papers)||!lock.papers.length)fail('published paper lock is required.');
  const {catalog}=await discoverPapers(root);
  if(catalog.papers.length!==lock.papers.length)fail('every published paper needs an original protection entry.');
  const [bank,preview,studiedLessons,questionAudits,catalogue]=await Promise.all(['content/official-question-bank.json','content/jz-mock-d-p1-preview.json','content/studied-lessons.json','content/question-audits.json','assets/studied-concepts.json'].map(name=>jsonFile(root,name)));
  const protectedFiles=new Map([[lockName,lockBytes]]),entries=[],seen=new Set();
  for(const paper of lock.papers){
    if(!paper||seen.has(paper.id)||!/^papers\/paper-[12]\/[a-z0-9][a-z0-9_-]*\.html$/.test(paper.href)||!/^[a-f0-9]{64}$/.test(paper.sha256))fail('invalid published protection entry.');
    seen.add(paper.id);
    await regularPath(root,paper.href);
    const bytes=await readFile(path.join(root,paper.href));
    if(sha256(bytes)!==paper.sha256)fail(`frozen original changed: ${paper.id}.`);
    protectedFiles.set(paper.href,bytes);
    const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes),metadata=parseMetadata(html);
    if(metadata.id!==paper.id)fail(`frozen ID disagrees with its lock: ${paper.id}.`);
    let plan;
    if(paper.id!==preview.metadata.id)plan=await jsonFile(root,`content/${paper.id}-plan.json`);
    const reviewed=compileReviewedPaper({html,bank,plan,preview:plan?undefined:preview,studiedLessons,catalogue,questionAudits});
    const content=Buffer.from(reviewed,'utf8');
    if(content.length>15*1024*1024)fail(`${paper.id} exceeds the supported 15 MB edition size.`);
    entries.push({editionId,paperId:paper.id,href:`assets/editions/${editionId}/${paper.id}.html`,sha256:sha256(content),content});
  }
  return {root,editionId,entries,protectedFiles};
}

export async function buildReviewedEditions(root=siteRoot,options={}){
  root=path.resolve(root);
  await validateContentAudit(root);
  await validateFollowupAudit(root);
  const prepared=await prepareReviewedEditions(root,options);
  const {editionId,entries,protectedFiles}=prepared;
  const manifestName='content/paper-editions.json';
  await regularPath(root,manifestName,{missing:true});
  let manifest;
  try{manifest=await jsonFile(root,manifestName);}catch(error){if(error.code!=='ENOENT')throw error;manifest={version:1,editions:[]};}
  // discoverPapers has validated every existing manifest entry and file.
  const manifestRows=entries.map(({content,...entry})=>entry);
  for(const entry of manifestRows){
    const previous=manifest.editions.find(item=>item.paperId===entry.paperId&&item.editionId===editionId);
    if(previous&&canonicalJson(previous)!==canonicalJson(entry))fail(`immutable edition ${editionId}/${entry.paperId} already exists with different teaching; use a new edition ID.`);
  }
  const directory=`assets/editions/${editionId}`;
  const exists=await regularPath(root,directory,{missing:true});
  if(exists){
    const files=await readdir(path.join(root,directory));
    if(canonicalJson(files.sort())!==canonicalJson(entries.map(entry=>`${entry.paperId}.html`).sort()))fail(`existing edition directory ${editionId} is incomplete or contains unexpected files.`);
    for(const entry of entries){
      await regularPath(root,entry.href);
      if(!(await readFile(path.join(root,entry.href))).equals(entry.content))fail(`immutable edition ${editionId}/${entry.paperId} differs; use a new edition ID.`);
    }
  }
  const checkOriginals=async()=>{for(const [name,bytes] of protectedFiles)if(!(await readFile(path.join(root,name))).equals(bytes))fail(`original changed during preparation: ${name}.`);};
  await checkOriginals();
  if(!exists){
    const parent=path.join(root,'assets/editions');
    await mkdir(parent,{recursive:true});
    const temporary=await mkdtemp(path.join(parent,'.review-build-'));
    try{
      for(const entry of entries)await writeFile(path.join(temporary,`${entry.paperId}.html`),entry.content,{flag:'wx'});
      await rename(temporary,path.join(root,directory));
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
  const appended=manifestRows.filter(entry=>!manifest.editions.some(item=>item.paperId===entry.paperId&&item.editionId===editionId));
  if(appended.length){
    const temporary=path.join(root,'content',`.paper-editions-${randomUUID()}.json`);
    try{await writeFile(temporary,JSON.stringify({...manifest,editions:[...manifest.editions,...appended]},null,2)+'\n',{flag:'wx'});await rename(temporary,path.join(root,manifestName));}
    finally{await rm(temporary,{force:true});}
  }
  await checkOriginals();
  return {editionId,papers:entries.length,created:!exists,manifest:manifestName};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);let root=siteRoot,editionId='review-20260930';
    for(let index=0;index<args.length;index++){
      if(args[index]==='--root'&&args[index+1])root=path.resolve(args[++index]);
      else if(args[index]==='--edition'&&args[index+1])editionId=args[++index];
      else fail('usage: node tools/build-reviewed-editions.mjs [--root DIRECTORY] [--edition ID]');
    }
    const result=await buildReviewedEditions(root,{editionId});
    console.log(`${result.created?'Created':'Verified'} ${result.papers} immutable ${result.editionId} teaching editions. Frozen originals and publication locks are unchanged.`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
