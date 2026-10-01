import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {canonicalJson,questionFingerprint} from '../tools/validate-content-audit.mjs';
import {followupFingerprint} from '../tools/validate-followup-audit.mjs';
import {validatePrivatePair,validateTeachingOverride} from '../tools/validate-private-pair.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
async function fixture(t,provider='jzmaths-tyler'){
  const pairId=provider==='jzmaths-exam'?'jz-exam-d':'tyler-exam-a';
  const dir=await mkdtemp(path.join(os.tmpdir(),'private-audit-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const publicBank=JSON.parse(await readFile(path.join(root,'content/official-question-bank.json')));
  const publicAudits=JSON.parse(await readFile(path.join(root,'content/question-audits.json')));
  const template=publicBank.questions['2020-P2-Q01'];
  const review=publicAudits.reviews.find(row=>row.sourceId===template.sourceId);
  const bank={version:1,questions:{}},audits={version:1,reviews:[]},links={version:1,reviews:[]};
  const qa={version:1,author:'fixture author',reviewer:'fixture independent reviewer',status:'approved',questions:[],relationships:[]};
  const plans=[];
  for(const paper of [1,2]){
    const plan={metadata:{format:'tmua-paper-v1',id:`${pairId}-p${paper}`,pairId,paper,version:1,contentRevision:2,questionCount:20,title:`Synthetic Paper ${paper}`,source:'Synthetic test data',description:'',visibility:'private',provider,practicePolicy:'after-miss-up-to-3'},groups:[],matches:[]};
    for(let i=1;i<=20;i++){
      const id=`${pairId.toUpperCase()}-P${paper}-Q${String(i).padStart(2,'0')}`;
      const q={...structuredClone(template),sourceId:id,source:'Synthetic fixture, not purchased content',sourceUrl:`https://jzmaths.com/simulator/${pairId.replaceAll('-','_')}_p${paper}`,provider,lead:`<p>Synthetic fixture question ${paper}/${i}.</p>`};
      bank.questions[id]=q;
      const row={...review,sourceId:id,contentHash:questionFingerprint(q),issues:[]};audits.reviews.push(row);
      qa.questions.push({...row,fullHash:hash(q)});
      const candidates=i===1?['2020-P2-Q01']:[];
      plan.groups.push({id:`q${i}`,originalId:id,candidates,legacyCandidates:[],followupGap:'Synthetic test gap; no pedagogical claim or real review is being made.'});
      if(candidates.length){
        const match={originalId:id,candidateId:'2020-P2-Q01',reason:'A synthetic fixture relationship for validating the private compiler pipeline.'};plan.matches.push(match);
        const edge={paperId:plan.metadata.id,...match,verdict:'direct',sharedConceptIds:q.conceptIds,contentHash:followupFingerprint(q,template,match)};
        links.reviews.push(edge);qa.relationships.push(edge);
      }
    }
    plans.push(plan);
  }
  qa.questions.push({...review,issues:[],fullHash:hash(template)});
  const config={version:1,visibility:'private',pairId,editionId:'private-tyler-a-test',mappingVersionId:'private-tyler-a-test',plans:['p1.json','p2.json'],bank:'bank.json',questionAudits:'audits.json',followupAudits:'links.json',qa:'qa.json'};
  const files={'config.json':config,'p1.json':plans[0],'p2.json':plans[1],'bank.json':bank,'audits.json':audits,'links.json':links,'qa.json':qa};
  const save=async()=>{for(const [name,data]of Object.entries(files))await writeFile(path.join(dir,name),JSON.stringify(data));};await save();
  return {dir,files,save,configFile:path.join(dir,'config.json')};
}

test('private pair audits use exact questions and independent review; mapping stays at 20 originals',async t=>{
  const f=await fixture(t);const result=await validatePrivatePair(f.configFile);
  assert.equal(result.counts.questions,41);assert.equal(result.links.followups,2);
  assert.equal(result.mappings.length,2);
  for(const mapping of result.mappings){assert.equal(mapping.paper.questions.length,20);assert.equal(mapping.sha256,hash(mapping.paper));assert.deepEqual(mapping.paper.contentRevisions,[2]);}
});

test('private gate rejects missing pair, missing gap, stale full teaching fields and self-review',async t=>{
  const f=await fixture(t);const pristine=structuredClone(f.files);
  const cases=[
    [()=>f.files['p1.json'].groups[0].legacyCandidates=['2018-P1-Q01'],/unaudited legacyCandidates/],
    [()=>f.files['p1.json'].groups[0].legacyCandidates='2018-P1-Q01',/unaudited legacyCandidates/],
    [()=>f.files['p1.json'].groups[0].legacyCandidates=null,/unaudited legacyCandidates/],
    [()=>f.files['p1.json'].groups[0].originalId='TYLER-EXAM-B-P1-Q01',/exact pair/],
    [()=>f.files['p1.json'].groups[0].originalId='TYLER-EXAM-A-P1-Q21',/exact pair/],
    [()=>f.files['p1.json'].groups.reverse(),/source order/],
    [()=>f.files['bank.json'].questions['TYLER-EXAM-A-P1-Q01'].sourceId='TYLER-EXAM-B-P1-Q01',/source identity/],
    [()=>f.files['bank.json'].questions['TYLER-EXAM-A-P1-Q01'].sourceUrl='https://jzmaths.com/simulator/tyler_exam_b_p1',/source identity/],
    [()=>f.files['config.json'].plans.pop(),/both plans/],
    [()=>delete f.files['p1.json'].groups[1].followupGap,/document the gap/],
    [()=>f.files['bank.json'].questions['TYLER-EXAM-A-P1-Q01'].tail='Changed condition outside legacy semantic fingerprint',/independent QA is stale/],
    [()=>f.files['qa.json'].reviewer=f.files['qa.json'].author,/independent approval/],
    [()=>f.files['qa.json'].relationships.pop(),/every relationship/],
    [()=>f.files['qa.json'].questions.pop(),/every original and follow-up/],
    [()=>f.files['audits.json'].reviews[0].issues.push('Unresolved mathematical result'),/resolved review/],
  ];
  for(const [change,error]of cases){for(const key of Object.keys(pristine))f.files[key]=structuredClone(pristine[key]);change();await f.save();await assert.rejects(validatePrivatePair(f.configFile),error);}
});

test('private compiler outputs both immutable HTMLs, exact hashes, and refuses overwriting an edition',async t=>{
  const f=await fixture(t),output=path.join(f.dir,'compiled');
  const run=()=>execFileSync(process.env.PYTHON||'python3',[path.join(root,'tools/build_private_pair.py'),f.configFile,output,'--node',process.execPath],{encoding:'utf8'});
  assert.match(run(),/2 papers/);
  const manifest=JSON.parse(await readFile(path.join(output,'manifest.json')));
  assert.deepEqual(manifest.papers.map(row=>row.paper_number),[1,2]);
  for(const row of manifest.papers){const bytes=await readFile(path.join(output,row.object_path));assert.equal(row.sha256,createHash('sha256').update(bytes).digest('hex'));assert.match(bytes.toString(),/after-miss-up-to-3/);assert.equal(row.metadata.visibility,'private');}
  assert.match(run(),/2 papers/);
  await writeFile(path.join(output,manifest.papers[0].object_path),'Immutable collision');
  assert.throws(run,/Immutable private edition/);
  assert.equal(await readFile(path.join(output,manifest.papers[0].object_path),'utf8'),'Immutable collision');
});

test('private official teaching copies preserve the exact assessment and require renewed independent reviews',async t=>{
  const f=await fixture(t),bankFile=path.join(root,'content/official-question-bank.json'),before=await readFile(bankFile);
  const original=JSON.parse(before).questions['2020-P2-Q01'],copy=structuredClone(original);
  copy.hints[0].pause += ' Recheck the condition yourself.';
  copy.knowledgePattern += ' Private teaching correction fixture.';
  assert.doesNotThrow(()=>validateTeachingOverride(original,copy));
  for(const field of ['lead','options','correct','sourceId','sourceImageSha256','source','provider','questionNumber','tail','unknownNewField']){
    const invalid=structuredClone(copy);invalid[field]=field==='options'?['Changed option']:'Changed question';
    assert.throws(()=>validateTeachingOverride(original,invalid),/same official|mathematical question or source/,field);
  }
  f.files['bank.json'].questions[copy.sourceId]=copy;await f.save();
  await assert.rejects(validatePrivatePair(f.configFile),/fresh private question review/);
  const review={...f.files['qa.json'].questions.find(r=>r.sourceId===copy.sourceId),contentHash:questionFingerprint(copy)};
  delete review.fullHash;f.files['audits.json'].reviews.push(review);await f.save();
  await assert.rejects(validatePrivatePair(f.configFile),/stale|review/i);
  const qaQuestion=f.files['qa.json'].questions.find(r=>r.sourceId===copy.sourceId);
  qaQuestion.contentHash=questionFingerprint(copy);qaQuestion.fullHash=hash(copy);
  for(const rows of [f.files['links.json'].reviews,f.files['qa.json'].relationships])for(const edge of rows){
    const plan=[f.files['p1.json'],f.files['p2.json']].find(p=>p.metadata.id===edge.paperId),match=plan.matches.find(m=>m.originalId===edge.originalId&&m.candidateId===edge.candidateId);
    edge.contentHash=followupFingerprint(f.files['bank.json'].questions[edge.originalId],copy,match);
  }
  await f.save();assert.equal((await validatePrivatePair(f.configFile)).counts.questions,41);
  const output=path.join(f.dir,'private-corrected');
  execFileSync(process.env.PYTHON||'python3',[path.join(root,'tools/build_private_pair.py'),f.configFile,output,'--node',process.execPath],{encoding:'utf8'});
  const manifest=JSON.parse(await readFile(path.join(output,'manifest.json')));
  for(const row of manifest.papers)assert.match(await readFile(path.join(output,row.object_path),'utf8'),/Recheck the condition yourself/);
  assert.deepEqual(await readFile(bankFile),before,'private corrections never mutate the public bank');
});


test('private JZ Exam pair retains provider identity, exact set and full independent audits', async t=>{
  const f=await fixture(t,'jzmaths-exam');
  const result=await validatePrivatePair(f.configFile);
  assert.equal(result.pairId,'jz-exam-d'); assert.equal(result.counts.questions,41);
  const original=f.files['bank.json'].questions['JZ-EXAM-D-P1-Q01'];
  original.provider='jzmaths-tyler'; await f.save();
  await assert.rejects(validatePrivatePair(f.configFile),/private provider identity/);
  original.provider='jzmaths-exam';
  f.files['p1.json'].metadata.provider='jzmaths-tyler';await f.save();
  await assert.rejects(validatePrivatePair(f.configFile),/exact exam set and provider/);
  f.files['p1.json'].metadata.provider='jzmaths-exam';
  original.sourceUrl='https://jzmaths.com/simulator/jz_mock_d_p1';await f.save();
  await assert.rejects(validatePrivatePair(f.configFile),/source identity/);
});
