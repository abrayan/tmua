import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {canonicalJson,questionFingerprint,conceptFingerprint,expectedSyllabusCodes,collectAuditQuestions,validateAuditData,validateContentAudit,validateTeachingMarkup} from '../tools/validate-content-audit.mjs';

const clone=value=>structuredClone(value);
const concept={id:'p1-b1-l01',paper:1,booklet:1,bookletTitle:'Methods',lesson:1,title:'Rearrange an equation',pdfPage:3,printedPage:3,knowledge:['Apply the same operation to both sides of an equation.']};
const question={sourceId:'2020-P1-Q01',lead:'Solve x + 1 = 2.',options:['0','1','2'],correct:'B',hints:[{title:'Undo the addition',body:'Subtract the same value from both sides.',recap:'Equivalent equations have the same solutions.',pitfall:'Apply the operation to both sides.',pause:'Find the value of x yourself.',recall:[{lessonId:concept.id,reminder:'Preserve equality with the same operation.'}]}],solution:'Subtract 1 from both sides: x = 1, so B is correct.',conceptIds:[concept.id]};
const options={counts:{bank:1,preview:0,lessons:1,additional:0}};
test('authored comparisons cannot silently swallow hint or solution text as HTML',()=>{
  for(const field of ['body','recap','pitfall','pause','reminder','solution']){
    assert.throws(()=>validateTeachingMarkup({[field]:'The condition x<y is required.'}),/unescaped comparison <y/);
  }
  assert.throws(()=>validateTeachingMarkup({hints:[{recall:[{reminder:'Check a<b first.'}]}]}),/recall\[0\].reminder/);
  assert.doesNotThrow(()=>validateTeachingMarkup({body:'<p>Use <math><mi>x</mi><mo>&lt;</mo><mi>y</mi></math>.</p>',solution:'<pre>T L T\nL T L</pre><figure><svg><path/><text>Label</text></svg></figure>'}));
});
function fixture(){
  return {questions:[clone(question)],catalogue:{version:1,lessons:[clone(concept)],additionalConcepts:[]},
    questionAudits:{version:1,reviews:[{sourceId:question.sourceId,verifiedAnswer:'B',verification:'Subtracting one from each side leaves exactly x = 1; substituting this value gives the required equality.',hintVerdict:'Each hint suggests a method without giving the final answer.',remainingWork:'The student must perform the subtraction and choose the corresponding option.',conceptIds:[concept.id],conceptReason:'The only required method is preserving equality while rearranging a linear equation.',issues:[],contentHash:questionFingerprint(question)}]},
    conceptAudits:{version:1,reviews:[{conceptId:concept.id,verification:'The equality rule is valid because applying the same reversible operation preserves both sides and the solution set.',contentHash:conceptFingerprint(concept)}]},
    coverage:{version:1,clauses:expectedSyllabusCodes.map(code=>({code,conceptIds:[concept.id],summary:'Fixture coverage reference for testing structural validation.'}))},
    conceptMap:{version:1,papers:[{id:'example-p1',questions:[{sourceId:question.sourceId,lessonIds:[concept.id]}]}]},
    studiedLessons:{version:1,booklets:[{paper:1,booklet:1,bookletTitle:'Methods',lessons:[{id:concept.id,number:1,title:concept.title,pdfPage:3,printedPage:3,knowledge:[...concept.knowledge]}]}]}};
}
function rejects(change,pattern){const data=fixture();change(data);assert.throws(()=>validateAuditData(data,options),pattern);}

test('eleven and twelve option questions accept K and L only when the option exists',()=>{
  for(const count of [11,12]){
    const data=fixture(),q=data.questions[0],review=data.questionAudits.reviews[0];
    q.options=Array.from({length:count},(_,i)=>String(i));
    q.correct=String.fromCharCode(64+count);
    review.verifiedAnswer=q.correct;review.contentHash=questionFingerprint(q);
    assert.equal(validateAuditData(data,options).questions,1);
  }
  for(const [count,answer] of [[13,'M'],[12,'M'],[11,'L'],[10,'K']]){
    rejects(data=>{
      const q=data.questions[0],review=data.questionAudits.reviews[0];
      q.options=Array.from({length:count},(_,i)=>String(i));q.correct=answer;
      review.verifiedAnswer=answer;review.contentHash=questionFingerprint(q);
    },/malformed question/);
  }
});

test('canonical hashes ignore object key order but cover every selected authored question field',()=>{
  const reordered=Object.fromEntries(Object.entries(question).reverse());
  assert.equal(questionFingerprint(reordered),questionFingerprint(question));
  assert.equal(questionFingerprint({...question,source:'A cosmetic citation'}),questionFingerprint(question));
  for(const field of ['sourceId','lead','options','correct','hints','solution','conceptIds']){
    const changed=clone(question);changed[field]=Array.isArray(changed[field])?[...changed[field],'changed']:String(changed[field])+' changed';
    assert.notEqual(questionFingerprint(changed),questionFingerprint(question),field);
  }
  const selected=Object.fromEntries(['sourceId','lead','options','correct','hints','solution','conceptIds'].map(key=>[key,question[key]]));
  assert.equal(questionFingerprint(question),createHash('sha256').update(canonicalJson(selected)).digest('hex'));
  assert.notEqual(canonicalJson([1,2]),canonicalJson([2,1]));
});

test('concept hashes protect all authored fields while allowing regenerated typesetting',()=>{
  assert.equal(conceptFingerprint({...concept,math:{version:1,expressions:{}}}),conceptFingerprint(concept));
  for(const field of ['title','knowledge','pdfPage','paper','id']){
    const changed=clone(concept);changed[field]=Array.isArray(changed[field])?['Changed reminder']:String(changed[field])+' changed';
    assert.notEqual(conceptFingerprint(changed),conceptFingerprint(concept),field);
  }
  assert.notEqual(conceptFingerprint({...concept,pitfall:'A new restriction changes the mathematical claim.'}),conceptFingerprint(concept));
});

test('valid fixture has complete review coverage without claiming a mathematical proof',()=>{
  assert.deepEqual(validateAuditData(fixture(),options),{questions:1,concepts:1,syllabusClauses:126});
  assert.equal(expectedSyllabusCodes.length,126);assert.equal(new Set(expectedSyllabusCodes).size,126);
  for(const code of ['MM1.7','MM8.7','M2.14','M5.19','Arg4','Prf5','Err2'])assert.ok(expectedSyllabusCodes.includes(code));
});

test('options match the paper compiler: finite numbers, text or rendered HTML with accessible text',()=>{
  const data=fixture();
  data.questions[0].options=[0,'one',{html:'<math><mn>2</mn></math>',text:'two'}];
  data.questionAudits.reviews[0].contentHash=questionFingerprint(data.questions[0]);
  assert.equal(validateAuditData(data,options).questions,1);
  for(const invalid of [null,true,Infinity,{}, {html:'<math/>',text:''},{html:'',text:'two'},{latex:'x',fallback:'x'}]){
    rejects(row=>{row.questions[0].options[0]=invalid;row.questionAudits.reviews[0].contentHash=questionFingerprint(row.questions[0]);},/malformed question/);
  }
});

test('missing, duplicate and unexpected question or concept review rows are rejected',()=>{
  for(const name of ['questionAudits','conceptAudits']){
    rejects(data=>{data[name].reviews=[];},/is missing/);
    rejects(data=>{data[name].reviews.push({...data[name].reviews[0]});},/duplicate/);
    rejects(data=>{data[name].reviews.push({...data[name].reviews[0],[name==='questionAudits'?'sourceId':'conceptId']:'extra-id'});},/unexpected/);
  }
});

test('changed answers, stale teaching and unsupported review claims cannot pass by retaining an old audit',()=>{
  rejects(data=>{data.questionAudits.reviews[0].verifiedAnswer='A';},/verified answer disagrees/);
  rejects(data=>{data.questions[0].solution+=' This wording was revised.';},/stale/);
  rejects(data=>{data.questions[0].hints[0].body+=' An additional hint.';},/stale/);
  rejects(data=>{data.catalogue.lessons[0].knowledge=['Changed'];delete data.studiedLessons;},/concept review is stale/);
  for(const field of ['verification','remainingWork','hintVerdict','conceptReason'])rejects(data=>{data.questionAudits.reviews[0][field]='ok';},/substantive/);
  rejects(data=>{data.conceptAudits.reviews[0].verification='Checked';},/substantive/);
  rejects(data=>{data.questionAudits.reviews[0].workedSolutionUrl='javascript:alert(1)';},/unsafe/);
  rejects(data=>{data.questionAudits.reviews[0].issues=[null];},/malformed issues/);
});

test('malformed hints, missing concepts and wrong public mappings fail even with matching regenerated hashes',()=>{
  for(const mutation of [q=>q.hints=[],q=>q.hints[0].pause='',q=>q.hints[0].recall=[],q=>q.hints[0].recall[0].lessonId='p1-extra-unknown',q=>q.conceptIds=[],q=>q.conceptIds=['p1-extra-unknown'],q=>q.conceptIds.push(concept.id),q=>q.correct='J']){
    rejects(data=>{mutation(data.questions[0]);data.questionAudits.reviews[0].contentHash=questionFingerprint(data.questions[0]);},/malformed|unknown|empty|duplicate/);
  }
  rejects(data=>{data.conceptMap.papers[0].questions[0].lessonIds=[];},/empty/);
  rejects(data=>{data.conceptMap.papers[0].questions[0].sourceId='unknown-question';},/unknown/);
  rejects(data=>{data.studiedLessons.booklets[0].lessons[0].pdfPage=4;},/booklet lesson IDs, references or knowledge/);
});

test('the exact syllabus ranges must appear once, with meaningful references for every clause',()=>{
  rejects(data=>{data.coverage.clauses.pop();},/exactly the 126/);
  rejects(data=>{data.coverage.clauses[0].code='MM1.99';},/exactly the 126/);
  rejects(data=>{data.coverage.clauses.push({...data.coverage.clauses[0]});},/duplicate/);
  rejects(data=>{data.coverage.clauses[0].conceptIds=[];},/empty/);
  rejects(data=>{data.coverage.clauses[0].conceptIds=['unknown'];},/unknown/);
  rejects(data=>{data.coverage.clauses[0].summary='';},/coverage summary/);
});

test('the real count requirements cannot silently shrink to a smaller catalogue or question bank',()=>{
  assert.throws(()=>validateAuditData(fixture()),/84 original booklet lessons and at least 23 additional/);
  assert.throws(()=>validateAuditData(fixture(),{counts:{lessons:1,additional:0}}),/280 bank questions and 6 preview/);
});

test('reviewed additions grow the inventory without weakening the minimum or exact audit coverage',()=>{
  const data=fixture();
  const extra={id:'p1-extra-functions',paper:1,title:'Function mappings',knowledge:['Each input has one output.'],example:{question:'Which output belongs to x = 2?',steps:['Apply the specified mapping to the input.'],answer:'The one specified output.'},pitfall:'Do not assign two outputs to one input.',references:[{type:'syllabus',label:'Function definition',url:'https://example.test/spec.pdf'}]};
  data.catalogue.additionalConcepts.push(extra);
  data.conceptAudits.reviews.push({conceptId:extra.id,verification:'The definition was checked to require one output for each input in the stated domain.',contentHash:conceptFingerprint(extra)});
  const added={...clone(question),sourceId:'2021-P1-Q01',conceptIds:[extra.id]};
  data.questions.push(added);
  data.questionAudits.reviews.push({...clone(data.questionAudits.reviews[0]),sourceId:added.sourceId,conceptIds:[extra.id],contentHash:questionFingerprint(added)});
  assert.deepEqual(validateAuditData(data,options),{questions:2,concepts:2,syllabusClauses:126});
  data.questionAudits.reviews.pop();assert.throws(()=>validateAuditData(data,options),/is missing 2021-P1-Q01/);
});

test('collection fingerprints all six preview formulas and accepts explicit or reviewed concept mappings',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tmua-audit-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(path.join(dir,'content'));
  await writeFile(path.join(dir,'content/official-question-bank.json'),JSON.stringify({version:1,questions:{[question.sourceId]:question}}));
  const preview={questions:[1,2].map(number=>({id:`q${number}`,original:{...clone(question),latex:'x+1',fallback:'<math><mi>x</mi></math>'},similar:[clone(question),clone(question)]}))};
  for(const group of preview.questions)for(const item of [group.original,...group.similar])delete item.conceptIds;
  await writeFile(path.join(dir,'content/jz-mock-d-p1-preview.json'),JSON.stringify(preview));
  const mappings=Object.fromEntries([1,2].flatMap(number=>['original','similar1','similar2'].map(kind=>[`preview-q${number}-${kind}`,[concept.id]])));
  const collected=await collectAuditQuestions(dir,{previewConceptIds:mappings});assert.equal(collected.length,7);
  assert.equal(collected[1].sourceId,'preview-q1-original');assert.deepEqual(collected[1].conceptIds,[concept.id]);
  const before=questionFingerprint(collected[1]);preview.questions[0].original.latex='x+2';
  await writeFile(path.join(dir,'content/jz-mock-d-p1-preview.json'),JSON.stringify(preview));
  await writeFile(path.join(dir,'content/question-audits.json'),JSON.stringify({version:1,reviews:Object.entries(mappings).map(([sourceId,conceptIds])=>({sourceId,conceptIds}))}));
  const changed=await collectAuditQuestions(dir);assert.notEqual(questionFingerprint(changed[1]),before);
  await assert.rejects(validateContentAudit(dir),/ENOENT/,'missing mandatory audit files never pass the real gate');
});

test('normal test and real build entry points invoke the mandatory audit gate',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.match(pkg.scripts.test,/^node tools\/validate-content-audit\.mjs && /);
  assert.match(pkg.scripts.test,/tests\/content-audit.test.mjs/);assert.match(pkg.scripts.test,/tests\/teaching-editions.test.mjs/);
  const build=await readFile(new URL('../tools/build-site.mjs',import.meta.url),'utf8');
  assert.match(build,/if \(root === siteRoot\) await validateContentAudit\(root\)/);
});


test('empty reminders require an independent question-specific omission review',()=>{
  const data=fixture(),q=data.questions[0],r=data.questionAudits.reviews[0];
  q.hints[0].recall=[];r.contentHash=questionFingerprint(q);
  const omission={hintNumber:1,reason:'The question supplies this definition directly; this hint applies it without claiming a studied booklet reference.',status:'pass',author:'/root/author',reviewer:'/root/reviewer',contentHash:r.contentHash};
  assert.throws(()=>validateAuditData(data,options),/unreviewed recall omissions/);
  r.recallOmissions=[omission];assert.equal(validateAuditData(data,options).questions,1);
  for(const patch of [{reason:'Checked'},{hintNumber:2},{status:'pending'},{reviewer:'author'},{reviewer:' author '},{author:'video_sources',reviewer:'video_sources '},{author:'root',reviewer:'/root'},{contentHash:'stale'}]){
    r.recallOmissions=[{...omission,...patch}];assert.throws(()=>validateAuditData(data,options),/recall omission/);
  }
  r.recallOmissions=[omission,omission];assert.throws(()=>validateAuditData(data,options),/recall omissions/);
  r.recallOmissions=[omission];q.hints[0].body+=' Apply the given definition.';r.contentHash=questionFingerprint(q);
  assert.throws(()=>validateAuditData(data,options),/stale.*recall omission/,'a new teaching hash alone does not renew omission approval');
});
test('an omission review cannot be attached to a displayed reminder',()=>{
  const data=fixture();data.questionAudits.reviews[0].recallOmissions=[{hintNumber:1}];
  assert.throws(()=>validateAuditData(data,options),/recall omissions/);
});
