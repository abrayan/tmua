import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildReviewedEditions,compileReviewedPaper,readPaperData,replacePaperData} from '../tools/build-reviewed-editions.mjs';
import {questionFingerprint,conceptFingerprint,expectedSyllabusCodes} from '../tools/validate-content-audit.mjs';
import {parseMetadata} from '../tools/build-site.mjs';
import {followupFingerprint} from '../tools/validate-followup-audit.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const lessonId='p1-b1-l01';
const hint={title:'Choose the applicable rule',body:'Reviewed hint with </script> as literal teaching text.',recap:'Review the relevant coefficient rule.',pitfall:'Keep every signed coefficient.',pause:'Apply the rule before revealing another step.',recall:[{lessonId,reminder:'Compare corresponding coefficients.'}]};
const exercise=id=>({sourceId:id,label:'A reviewed exercise',lead:'Find the required coefficient.',options:['A','B'],correct:'B',hints:[structuredClone(hint)],solution:'The fully reviewed calculation gives option B.',conceptIds:[lessonId]});
const metadata=(id,count=1)=>({format:'tmua-paper-v1',id,title:'Test paper',paper:1,source:'Test source',description:'Edition fixture',questionCount:count,version:1});
const shell=data=>`<!doctype html>\n<!-- frozen comment -->\n<script type="application/json" id="tmua-paper-meta">${JSON.stringify(data.metadata)}</script>\n<script id='tmua-paper-data' data-label='x > y' type='application/json'>${JSON.stringify(data).replaceAll('<','\\u003c')}</script>\n<style>body {color: blue}</style>\n<script>window.frozenPlayer = 'byte identical';</script>\n`;
const audit=q=>({sourceId:q.sourceId,verifiedAnswer:q.correct,verification:'Verified the algebraic calculation independently and checked every available option.',hintVerdict:'Knowledge cues retain independent student work.',remainingWork:'The student must finish the calculation and select the matching answer.',conceptIds:q.conceptIds,conceptReason:'This exercise directly uses the stated coefficient comparison concept.',issues:[],contentHash:questionFingerprint(q)});
const normalizedPreview=(q,id)=>({...q,sourceId:id,conceptIds:q.conceptIds||[lessonId],lead:Object.fromEntries(['lead','tail','latex','fallback','formulaLabel'].map(key=>[key,q[key]??'']))});
function dataFixture(){
  const bank={version:1,questions:Object.fromEntries(Array.from({length:280},(_,i)=>{const id=`BANK-Q${String(i+1).padStart(3,'0')}`;return [id,exercise(id)];}))};
  const sourceLessons=Array.from({length:84},(_,i)=>({id:`p1-b1-l${String(i+1).padStart(2,'0')}`,number:i+1,title:`Booklet lesson ${i+1}`,pdfPage:i+2,knowledge:['Use the coefficient rule with all of its conditions.'],sourceLabel:`METHOD ${i+1}`}));
  const studiedLessons={version:1,booklets:[{paper:1,booklet:1,bookletTitle:'Original booklet',lessons:sourceLessons}]};
  const lessons=sourceLessons.map(q=>({id:q.id,paper:1,booklet:1,bookletTitle:'Original booklet',lesson:q.number,title:q.title,pdfPage:q.pdfPage,printedPage:q.pdfPage,knowledge:q.knowledge}));
  const additionalConcepts=Array.from({length:23},(_,i)=>({id:`p2-extra-fixture-${i+1}`,paper:2,title:`Additional concept ${i+1}`,knowledge:['Check that the stated implication holds in every case.'],references:[{type:'syllabus',label:'Syllabus',url:'https://example.test/syllabus'}],example:{question:'Does this follow?',steps:['Apply the stated implication.'],answer:'It follows under the assumptions.'},pitfall:'Check every stated assumption.'}));
  const catalogue={version:1,lessons,additionalConcepts};
  const previewExercise=()=>{const q=exercise('unused');delete q.sourceId;delete q.conceptIds;return {...q,latex:'x^2',tail:'After expanding.',fallback:'<math><msup><mi>x</mi><mn>2</mn></msup></math>',formulaLabel:'x squared'};};
  const preview={metadata:metadata('preview',2),questions:[1,2].map(n=>({id:`q${n}`,original:previewExercise(),similar:[previewExercise(),previewExercise()]}))};
  const previewQuestions=preview.questions.flatMap(group=>[normalizedPreview(group.original,`preview-${group.id}-original`),...group.similar.map((q,i)=>normalizedPreview(q,`preview-${group.id}-similar${i+1}`))]);
  const questionAudits={version:1,reviews:[...Object.values(bank.questions),...previewQuestions].map(audit)};
  const conceptAudits={version:1,reviews:[...lessons,...additionalConcepts].map(q=>({conceptId:q.id,verification:'Verified the mathematical statement and all necessary conditions for this concept.',contentHash:conceptFingerprint(q)}))};
  const coverage={version:1,clauses:expectedSyllabusCodes.map(code=>({code,conceptIds:[lessonId],summary:'Mapped and checked against the relevant mathematical concept.'}))};
  const frozen=structuredClone(bank.questions['BANK-Q001']);frozen.correct='A';frozen.hints[0].body='Old hint.';frozen.solution='Old answer A.';
  const paper={metadata:{...metadata('tmua-fixture'),practicePolicy:'after-miss-up-to-3',contentRevision:2},questions:[{id:'q1',original:frozen,similar:[structuredClone(bank.questions['BANK-Q002'])],legacySimilar:[structuredClone(bank.questions['BANK-Q004'])]}]};
  const plan={metadata:paper.metadata,groups:[{id:'q1',originalId:'BANK-Q001',candidates:['BANK-Q003'],legacyCandidates:['BANK-Q005']}]};
  plan.matches=[{originalId:'BANK-Q001',candidateId:'BANK-Q003',strength:'strong',rationale:'Both exercises require the same coefficient comparison while retaining all signed factors.',sharedKnowledge:['Match corresponding coefficients.']}];
  const followupAudits={version:1,reviews:plan.matches.map(match=>({paperId:plan.metadata.id,originalId:match.originalId,candidateId:match.candidateId,verdict:'direct',reason:'The student applies the same coefficient comparison method to a fresh expression.',sharedConceptIds:[lessonId],contentHash:followupFingerprint(bank.questions[match.originalId],bank.questions[match.candidateId],match)}))};
  const conceptMap={version:1,papers:[{id:'tmua-fixture',questions:[{sourceId:'BANK-Q001',lessonIds:[lessonId]}]}]};
  return {bank,studiedLessons,catalogue,preview,questionAudits,conceptAudits,coverage,paper,plan,conceptMap,followupAudits};
}
async function diskFixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'tmua-reviewed-editions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await Promise.all(['content','assets','papers/paper-1'].map(name=>mkdir(path.join(root,name),{recursive:true})));
  const source=dataFixture();
  const files={
    'content/official-question-bank.json':source.bank,'content/studied-lessons.json':source.studiedLessons,'assets/studied-concepts.json':source.catalogue,
    'content/jz-mock-d-p1-preview.json':source.preview,'content/question-audits.json':source.questionAudits,'content/concept-audits.json':source.conceptAudits,
    'content/followup-audits.json':source.followupAudits,
    'content/syllabus-coverage.json':source.coverage,'content/tmua-fixture-plan.json':source.plan,'assets/concept-map.json':source.conceptMap
  };
  const originals={'papers/paper-1/tmua-fixture.html':shell(source.paper),'papers/paper-1/preview.html':shell(source.preview)};
  const lock={version:1,papers:Object.entries(originals).map(([href,html])=>({id:readPaperData(html).metadata.id,href,sha256:hash(html)}))};
  files['content/published-papers.json']=lock;
  for(const [name,data] of Object.entries(files))await writeFile(path.join(root,name),JSON.stringify(data));
  for(const [name,html] of Object.entries(originals))await writeFile(path.join(root,name),html);
  const lockBytes=await readFile(path.join(root,'content/published-papers.json'));
  return {root,source,originals,lockBytes};
}
function unresolved(q){const copy=structuredClone(q);copy.hints.forEach(step=>step.recall=step.recall.map(({lessonId,reminder})=>({lessonId,reminder})));return copy;}

test('only embedded teaching changes; the frozen page, metadata, original identities and legacy membership remain intact',()=>{
  const s=dataFixture(),html=shell(s.paper);
  const result=compileReviewedPaper({html,...s}),data=readPaperData(result);
  assert.equal(replacePaperData(result,null),replacePaperData(html,null));
  assert.deepEqual(data.metadata,s.paper.metadata);
  assert.deepEqual(data.questions.map(q=>q.id),['q1']);
  assert.equal(data.questions[0].original.sourceId,'BANK-Q001');
  assert.equal(data.questions[0].original.correct,'B');
  assert.deepEqual(data.questions[0].similar.map(q=>q.sourceId),['BANK-Q003']);
  assert.deepEqual(data.questions[0].legacySimilar.map(q=>q.sourceId),['BANK-Q004']);
  for(const q of [data.questions[0].original,...data.questions[0].similar,...data.questions[0].legacySimilar]){
    assert.deepEqual(unresolved(q),s.bank.questions[q.sourceId]);
    assert.deepEqual(q.hints[0].recall[0],{lessonId,reminder:'Compare corresponding coefficients.',title:'Booklet lesson 1',paper:1,booklet:1,number:1,pdfPage:2,sourceLabel:'METHOD 1'});
  }
  assert.equal((result.match(/<\/script>/g)||[]).length,3);
});

test('every preview exercise receives its reviewed hints, solution, source ID and authoritative concepts',()=>{
  const s=dataFixture(),html=shell(s.preview);
  const result=compileReviewedPaper({html,...s,plan:undefined}),data=readPaperData(result);
  assert.equal(replacePaperData(result,null),replacePaperData(html,null));
  for(const [i,group] of data.questions.entries())for(const [suffix,q] of [['original',group.original],...group.similar.map((q,n)=>[`similar${n+1}`,q])]){
    const id=`preview-q${i+1}-${suffix}`,review=s.questionAudits.reviews.find(r=>r.sourceId===id);
    assert.equal(q.sourceId,id);assert.deepEqual(q.conceptIds,[lessonId]);
    assert.equal(questionFingerprint(normalizedPreview(unresolved(q),id)),review.contentHash);
  }
});

test('a reviewed plan can remove weak follow-ups without changing frozen metadata or legacy exercises',()=>{
  const s=dataFixture();s.paper.metadata.requiresThreeFollowups=true;
  s.plan.metadata={...s.plan.metadata,requiresThreeFollowups:false};s.plan.groups[0].candidates=[];
  const html=shell(s.paper),result=compileReviewedPaper({html,...s}),data=readPaperData(result);
  assert.equal(data.questions[0].similar.length,0);
  assert.equal(data.questions[0].legacySimilar[0].sourceId,'BANK-Q004');
  assert.equal(data.metadata.requiresThreeFollowups,true);
  assert.equal(replacePaperData(result,null),replacePaperData(html,null));
  s.plan.metadata.requiresThreeFollowups=true;
  assert.throws(()=>compileReviewedPaper({html,...s}),/requires three follow-ups/);
});

test('reviewed description changes only the two description values while preserving all attempt metadata and player bytes',()=>{
  const s=dataFixture(),html=shell(s.paper);
  const description='Worked steps, progressive hints and up to three matching follow-up questions.';
  s.plan.metadata={...s.plan.metadata,description,version:99,paper:2,questionCount:99,practicePolicy:'another-policy'};
  const result=compileReviewedPaper({html,...s}),data=readPaperData(result);
  assert.deepEqual(data.metadata,{...s.paper.metadata,description});
  assert.deepEqual(parseMetadata(result),{...parseMetadata(html),description});
  const strip=value=>replacePaperData(value,null).replace(/(<script[^>]*id="tmua-paper-meta"[^>]*>)[\s\S]*?(<\/script>)/,'$1null$2');
  assert.equal(strip(result),strip(html));
});

test('missing or stale audits, changed original membership and unresolved booklet reminders block compilation',()=>{
  for(const mutate of [
    s=>s.questionAudits.reviews=s.questionAudits.reviews.filter(r=>r.sourceId!=='BANK-Q003'),
    s=>s.bank.questions['BANK-Q003'].hints[0].body='Unaudited change',
    s=>s.plan.groups[0].originalId='BANK-Q005',
    s=>s.plan.groups[0].id='changed',
    s=>s.plan.groups[0].candidates=['BANK-Q001'],
    s=>s.studiedLessons.booklets[0].lessons.shift()
  ]){const s=dataFixture();mutate(s);assert.throws(()=>compileReviewedPaper({html:shell(s.paper),...s}),/Reviewed editions:/);}
});

test('builder emits audited editions and exact hashes without mutating originals or locks, and reruns preserve bytes',async t=>{
  const f=await diskFixture(t),result=await buildReviewedEditions(f.root);
  assert.deepEqual(result,{editionId:'review-20260930',papers:2,created:true,manifest:'content/paper-editions.json'});
  const manifestBytes=await readFile(path.join(f.root,result.manifest)),manifest=JSON.parse(manifestBytes);
  for(const entry of manifest.editions){
    const bytes=await readFile(path.join(f.root,entry.href));assert.equal(hash(bytes),entry.sha256);
    const original=f.originals[`papers/paper-1/${entry.paperId}.html`];
    assert.equal(replacePaperData(bytes.toString(),null),replacePaperData(original,null));
  }
  for(const [name,html] of Object.entries(f.originals))assert.equal(await readFile(path.join(f.root,name),'utf8'),html);
  assert.deepEqual(await readFile(path.join(f.root,'content/published-papers.json')),f.lockBytes);
  assert.equal((await buildReviewedEditions(f.root)).created,false);
  assert.deepEqual(await readFile(path.join(f.root,result.manifest)),manifestBytes);
});

test('changed reviewed teaching cannot overwrite an immutable edition; a new ID appends without changing old bytes',async t=>{
  const f=await diskFixture(t);await buildReviewedEditions(f.root);
  const oldPath=path.join(f.root,'assets/editions/review-20260930/tmua-fixture.html'),oldBytes=await readFile(oldPath);
  f.source.bank.questions['BANK-Q003'].solution='A revised and independently verified complete calculation gives B.';
  f.source.questionAudits.reviews.find(r=>r.sourceId==='BANK-Q003').contentHash=questionFingerprint(f.source.bank.questions['BANK-Q003']);
  await writeFile(path.join(f.root,'content/official-question-bank.json'),JSON.stringify(f.source.bank));
  await writeFile(path.join(f.root,'content/question-audits.json'),JSON.stringify(f.source.questionAudits));
  for(const row of f.source.followupAudits.reviews)row.contentHash=followupFingerprint(f.source.bank.questions[row.originalId],f.source.bank.questions[row.candidateId],f.source.plan.matches.find(match=>match.originalId===row.originalId&&match.candidateId===row.candidateId));
  await writeFile(path.join(f.root,'content/followup-audits.json'),JSON.stringify(f.source.followupAudits));
  await assert.rejects(buildReviewedEditions(f.root),/immutable edition .* different teaching/);
  assert.deepEqual(await readFile(oldPath),oldBytes);
  await buildReviewedEditions(f.root,{editionId:'review-next'});
  assert.deepEqual(await readFile(oldPath),oldBytes);
  const manifest=JSON.parse(await readFile(path.join(f.root,'content/paper-editions.json')));
  assert.deepEqual(manifest.editions.map(e=>e.editionId),['review-20260930','review-20260930','review-next','review-next']);
});

test('audit failures, frozen changes and symlinked output paths fail before publishing any edition',async t=>{
  for(const kind of ['audit','followup-audit','original','symlink']){
    const f=await diskFixture(t);
    if(kind==='audit')await rm(path.join(f.root,'content/question-audits.json'));
    if(kind==='followup-audit')await rm(path.join(f.root,'content/followup-audits.json'));
    if(kind==='original')await writeFile(path.join(f.root,'papers/paper-1/tmua-fixture.html'),f.originals['papers/paper-1/tmua-fixture.html']+'changed');
    if(kind==='symlink')await symlink(path.join(f.root,'content'),path.join(f.root,'assets/editions'));
    await assert.rejects(buildReviewedEditions(f.root));
    await assert.rejects(readFile(path.join(f.root,'content/paper-editions.json')),/ENOENT/);
    assert.deepEqual(await readFile(path.join(f.root,'content/published-papers.json')),f.lockBytes);
  }
});
