import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {canonicalJson,questionFingerprint} from '../tools/validate-content-audit.mjs';
import {followupFingerprint,validateFollowupAuditData,validateFollowupAudit} from '../tools/validate-followup-audit.mjs';

const conceptId='p1-b1-l01',otherConceptId='p1-b1-l02';
const clone=value=>structuredClone(value);
function question(sourceId){return {sourceId,lead:'Solve x + 1 = 2.',options:['0','1'],correct:'B',hints:[{body:'Subtract the same value from both sides.'}],solution:'Subtracting one leaves x = 1.',conceptIds:[conceptId]};}
function fixture(){
  const originalId='2020-P1-Q01',candidates=['2017-P1-Q01','2018-P1-Q01','2019-P1-Q01'];
  const questions=Object.fromEntries([originalId,...candidates].map(id=>[id,question(id)]));
  const plan={metadata:{id:'tmua-fixture-p1',requiresThreeFollowups:true},groups:[{id:'q1',originalId,candidates}],
    matches:candidates.map(candidateId=>({originalId,candidateId,strength:'strong',rationale:'Both questions require the same reversible operation on a linear equation.',sharedKnowledge:['Preserve equality while subtracting.']}))};
  return {bank:{version:1,questions},catalogue:{version:1,lessons:[{id:conceptId},{id:otherConceptId}],additionalConcepts:[]},plans:[plan],
    followupAudits:{version:1,reviews:plan.matches.map(match=>({paperId:plan.metadata.id,originalId,candidateId:match.candidateId,verdict:'direct',reason:'The candidate asks the student to preserve equality while undoing the same addition.',sharedConceptIds:[conceptId],contentHash:followupFingerprint(questions[originalId],questions[match.candidateId],match)}))}};
}
function rejects(change,pattern){const data=fixture();change(data);assert.throws(()=>validateFollowupAuditData(data),pattern);}
function removeLastCandidate(data){data.plans[0].groups[0].candidates.pop();data.plans[0].matches.pop();data.followupAudits.reviews.pop();}

test('fingerprint binds both authored questions and every field of the actual match',()=>{
  const data=fixture(),match=data.plans[0].matches[0],original=data.bank.questions[match.originalId],candidate=data.bank.questions[match.candidateId];
  const hash=followupFingerprint(original,candidate,match);
  const expected=createHash('sha256').update(canonicalJson({original:questionFingerprint(original),candidate:questionFingerprint(candidate),match})).digest('hex');
  assert.equal(hash,expected);
  assert.equal(hash,followupFingerprint(original,candidate,Object.fromEntries(Object.entries(match).reverse())));
  assert.notEqual(hash,followupFingerprint({...original,solution:'A changed explanation.'},candidate,match));
  assert.notEqual(hash,followupFingerprint(original,{...candidate,hints:[{body:'A different hint.'}]},match));
  for(const field of ['rationale','strength','sharedKnowledge']){
    const changed={...match,[field]:field==='sharedKnowledge'?['A changed skill.']:'changed'};
    assert.notEqual(hash,followupFingerprint(original,candidate,changed),field);
  }
});

test('valid data requires one reviewed record for each current candidate edge',()=>{
  assert.deepEqual(validateFollowupAuditData(fixture()),{papers:1,groups:1,followups:3});
  rejects(data=>data.followupAudits.reviews.pop(),/missing review/);
  rejects(data=>data.followupAudits.reviews.push(clone(data.followupAudits.reviews[0])),/duplicate review/);
  rejects(data=>data.followupAudits.reviews.push({...data.followupAudits.reviews[0],paperId:'tmua-other-p1'}),/unexpected review/);
  rejects(data=>{data.followupAudits.version=2;},/version 1/);
});

test('question edits and rationale edits stale an otherwise unchanged edge',()=>{
  rejects(data=>{data.bank.questions['2020-P1-Q01'].correct='A';},/stale/);
  rejects(data=>{data.bank.questions['2017-P1-Q01'].solution+=' Added reasoning.';},/stale/);
  rejects(data=>{data.plans[0].matches[0].rationale+=' A further transfer claim.';},/stale/);
  rejects(data=>{data.plans[0].matches[0].sharedKnowledge.push('An added prerequisite.');},/stale/);
  rejects(data=>{delete data.followupAudits.reviews[0].contentHash;},/stale/);
});

test('unsupported verdicts, reasons and shared-concept claims cannot pass',()=>{
  rejects(data=>{data.followupAudits.reviews[0].verdict='automatic';},/unsupported verdict/);
  rejects(data=>{data.followupAudits.reviews[0].reason='Checked';},/substantive reason/);
  rejects(data=>{data.followupAudits.reviews[0].sharedConceptIds=['p1-extra-unknown'];},/unknown concept/);
  rejects(data=>{data.followupAudits.reviews[0].sharedConceptIds=[conceptId,conceptId];},/duplicate/);
  rejects(data=>{data.followupAudits.reviews[0].sharedConceptIds=[otherConceptId];},/unsupported shared concept/);
  rejects(data=>{data.bank.questions['2020-P1-Q01'].conceptIds.push(otherConceptId);data.followupAudits.reviews[0].sharedConceptIds=[otherConceptId];},/unsupported shared concept/);
  const data=fixture();data.followupAudits.reviews[0].sharedConceptIds=[];data.followupAudits.reviews[0].verdict='transfer';
  assert.equal(validateFollowupAuditData(data).followups,3,'a reviewed transfer need not have a shared catalogue mapping');
});

test('two, one or zero follow-ups are allowed when three are not required',()=>{
  const data=fixture();data.plans[0].metadata.requiresThreeFollowups=false;
  for(const count of [2,1,0]){removeLastCandidate(data);assert.equal(validateFollowupAuditData(data).followups,count);}
  const omitted=fixture();delete omitted.plans[0].metadata.requiresThreeFollowups;removeLastCandidate(omitted);
  assert.equal(validateFollowupAuditData(omitted).followups,2);
  rejects(removeLastCandidate,/requiresThreeFollowups needs exactly three/);
  rejects(data=>{data.plans[0].metadata.requiresThreeFollowups='false';},/must be a boolean/);
  rejects(data=>{data.plans[0].metadata.requiresThreeFollowups=null;},/must be a boolean/);
});

test('candidate limits and uniqueness are enforced independently of the three-follow-up flag',()=>{
  for(const required of [true,false]){
    rejects(data=>{data.plans[0].metadata.requiresThreeFollowups=required;data.bank.questions['2021-P1-Q01']=question('2021-P1-Q01');data.plans[0].groups[0].candidates.push('2021-P1-Q01');},/at most three distinct/);
    rejects(data=>{data.plans[0].metadata.requiresThreeFollowups=required;data.plans[0].groups[0].candidates[1]='2017-P1-Q01';},/at most three distinct/);
  }
  rejects(data=>{
    data.plans[0].metadata.requiresThreeFollowups=false;
    data.bank.questions['2020-P1-Q02']=question('2020-P1-Q02');
    data.plans[0].groups.push({id:'q2',originalId:'2020-P1-Q02',candidates:['2017-P1-Q01']});
  },/repeats candidate.*across groups/);
});

test('assessment originals cannot reappear as practice, including another group original',()=>{
  rejects(data=>{data.plans[0].groups[0].candidates[0]='2020-P1-Q01';},/reuses an assessment original/);
  rejects(data=>{
    data.plans[0].metadata.requiresThreeFollowups=false;
    data.plans[0].groups.push({id:'q2',originalId:'2017-P1-Q01',candidates:[]});
  },/reuses an assessment original/);
  rejects(data=>{data.plans[0].groups.push({...data.plans[0].groups[0],id:'q2'});},/repeats original question/);
  rejects(data=>{data.plans.push(clone(data.plans[0]));},/duplicate paperId/);
});

test('every plan edge has exactly one authored match and refers to known questions',()=>{
  rejects(data=>data.plans[0].matches.pop(),/missing match/);
  rejects(data=>data.plans[0].matches.push(clone(data.plans[0].matches[0])),/duplicate match/);
  rejects(data=>data.plans[0].matches.push({...data.plans[0].matches[0],candidateId:'unselected'}),/unexpected match/);
  rejects(data=>{data.plans[0].groups[0].originalId='unknown';},/unknown original question/);
  rejects(data=>{data.plans[0].groups[0].candidates[0]='unknown';},/unknown candidate question/);
  rejects(data=>{data.bank.questions['2017-P1-Q01'].sourceId='wrong-key';},/disagrees with sourceId/);
  rejects(data=>{data.bank.questions['2017-P1-Q01'].conceptIds=['unknown'];},/unknown concept/);
});

test('a candidate may be reused by a different assessment when both edges are independently reviewed',()=>{
  const data=fixture(),plan=clone(data.plans[0]);plan.metadata.id='tmua-second-p1';data.plans.push(plan);
  data.followupAudits.reviews.push(...data.followupAudits.reviews.map(row=>({...row,paperId:plan.metadata.id})));
  assert.deepEqual(validateFollowupAuditData(data),{papers:2,groups:2,followups:6});
});

async function writeFixture(dir,data){
  await Promise.all(['content','assets'].map(name=>mkdir(path.join(dir,name),{recursive:true})));
  await Promise.all([
    ['content/official-question-bank.json',data.bank],['assets/studied-concepts.json',data.catalogue],['content/followup-audits.json',data.followupAudits],
    ...data.plans.map(plan=>[`content/${plan.metadata.id}-plan.json`,plan])
  ].map(([name,value])=>writeFile(path.join(dir,name),JSON.stringify(value))));
}

test('filesystem gate discovers every TMUA plan and requires the audit file',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tmua-followup-audit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const data=fixture();await writeFixture(dir,data);
  await writeFile(path.join(dir,'content/unrelated-plan.json'),'not a TMUA plan');
  assert.deepEqual(await validateFollowupAudit(dir),{papers:1,groups:1,followups:3});
  const extra=clone(data.plans[0]);extra.metadata.id='tmua-new-p1';
  await writeFile(path.join(dir,'content/tmua-new-p1-plan.json'),JSON.stringify(extra));
  await assert.rejects(validateFollowupAudit(dir),/missing review/,'a newly added plan cannot escape the audit gate');
  await rm(path.join(dir,'content/tmua-new-p1-plan.json'));
  await rm(path.join(dir,'content/followup-audits.json'));
  await assert.rejects(validateFollowupAudit(dir),{code:'ENOENT'});
});

test('filesystem gate rejects mislabeled plan identities instead of attaching reviews to the wrong file',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tmua-followup-identity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const data=fixture();await writeFixture(dir,data);
  const plan=clone(data.plans[0]);plan.metadata.id='tmua-different-p1';
  await writeFile(path.join(dir,'content/tmua-fixture-p1-plan.json'),JSON.stringify(plan));
  await assert.rejects(validateFollowupAudit(dir),/filename.*disagrees/);
});
