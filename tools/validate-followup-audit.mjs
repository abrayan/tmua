import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,questionFingerprint} from './validate-content-audit.mjs';
import {assertPublicMockPlan,publicPlanFilename} from './public-mock-sources.mjs';

const siteRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const nonempty=value=>typeof value==='string' && Boolean(value.trim());
const substantive=value=>nonempty(value) && value.trim().length>=40 && value.trim().split(/\s+/).length>=5;
const fail=message=>{throw Error(`Follow-up audit: ${message}`);};
const readJson=async(root,name)=>JSON.parse(await readFile(path.join(root,name),'utf8'));
const edgeKey=(paperId,originalId,candidateId)=>JSON.stringify([paperId,originalId,candidateId]);
const edgeLabel=(paperId,originalId,candidateId)=>`${paperId}: ${originalId} -> ${candidateId}`;

export function followupFingerprint(original,candidate,match){
  return createHash('sha256').update(canonicalJson({
    original:questionFingerprint(original),candidate:questionFingerprint(candidate),match
  })).digest('hex');
}

function conceptIds(ids,known,label){
  if(!Array.isArray(ids) || ids.some(id=>!nonempty(id)||!known.has(id)) || new Set(ids).size!==ids.length){
    fail(`${label} has malformed, duplicate or unknown concept IDs.`);
  }
}

export function validateFollowupAuditData({bank,catalogue,plans,followupAudits}){
  if(!object(bank)||bank.version!==1||!object(bank.questions))fail('invalid question bank.');
  if(!object(catalogue)||catalogue.version!==1||!Array.isArray(catalogue.lessons)||!Array.isArray(catalogue.additionalConcepts))fail('invalid concept catalogue.');
  const known=new Set();
  for(const concept of [...catalogue.lessons,...catalogue.additionalConcepts]){
    if(!object(concept)||!nonempty(concept.id)||known.has(concept.id))fail('malformed or duplicate concept catalogue ID.');
    known.add(concept.id);
  }
  const questions=new Map(Object.entries(bank.questions));
  for(const [id,question] of questions){
    if(!nonempty(id)||!object(question)||question.sourceId!==id)fail(`bank key ${id} disagrees with sourceId.`);
    conceptIds(question.conceptIds,known,`question ${id}`);
  }
  if(!Array.isArray(plans)||!plans.length)fail('at least one assessment plan is required.');
  const paperIds=new Set(),expected=new Map();
  let groupCount=0;
  for(const plan of plans){
    if(!object(plan)||!object(plan.metadata)||!nonempty(plan.metadata.id)||!Array.isArray(plan.groups)||!plan.groups.length||!Array.isArray(plan.matches))fail('malformed assessment plan.');
    assertPublicMockPlan(plan,bank.questions);
    const paperId=plan.metadata.id;
    if(paperIds.has(paperId))fail(`duplicate paperId ${paperId}.`);
    paperIds.add(paperId);
    const requiresThree=plan.metadata.requiresThreeFollowups===undefined?false:plan.metadata.requiresThreeFollowups;
    if(typeof requiresThree!=='boolean')fail(`${paperId} requiresThreeFollowups must be a boolean.`);
    const originalIds=new Set(),groupIds=new Set(),candidateIds=new Set(),paperEdges=new Map();
    for(const group of plan.groups){
      if(!object(group)||!nonempty(group.id)||groupIds.has(group.id))fail(`${paperId} has a malformed or duplicate group ID.`);
      groupIds.add(group.id);
      if(!nonempty(group.originalId)||!questions.has(group.originalId))fail(`${paperId} has unknown original question ${group.originalId}.`);
      if(originalIds.has(group.originalId))fail(`${paperId} repeats original question ${group.originalId}.`);
      originalIds.add(group.originalId);
    }
    for(const group of plan.groups){
      groupCount++;
      if(!Array.isArray(group.candidates)||group.candidates.some(id=>!nonempty(id)))fail(`${paperId}/${group.id} candidates must be question IDs.`);
      if(group.candidates.length>3||new Set(group.candidates).size!==group.candidates.length)fail(`${paperId}/${group.id} requires at most three distinct candidates.`);
      if(requiresThree&&group.candidates.length!==3)fail(`${paperId}/${group.id} requiresThreeFollowups needs exactly three candidates.`);
      for(const candidateId of group.candidates){
        if(!questions.has(candidateId))fail(`${paperId} has unknown candidate question ${candidateId}.`);
        if(originalIds.has(candidateId))fail(`${paperId} reuses an assessment original as a follow-up: ${candidateId}.`);
        if(candidateIds.has(candidateId))fail(`${paperId} repeats candidate ${candidateId} across groups.`);
        candidateIds.add(candidateId);
        paperEdges.set(edgeKey(paperId,group.originalId,candidateId),{paperId,originalId:group.originalId,candidateId});
      }
    }
    const matches=new Map();
    for(const match of plan.matches){
      if(!object(match)||!nonempty(match.originalId)||!nonempty(match.candidateId))fail(`${paperId} has a malformed match.`);
      const key=edgeKey(paperId,match.originalId,match.candidateId),label=edgeLabel(paperId,match.originalId,match.candidateId);
      if(matches.has(key))fail(`duplicate match for ${label}.`);
      if(!paperEdges.has(key))fail(`unexpected match for ${label}.`);
      matches.set(key,match);
    }
    for(const [key,edge] of paperEdges){
      if(!matches.has(key))fail(`missing match for ${edgeLabel(edge.paperId,edge.originalId,edge.candidateId)}.`);
      expected.set(key,{...edge,match:matches.get(key)});
    }
  }
  if(!object(followupAudits)||followupAudits.version!==1||!Array.isArray(followupAudits.reviews))fail('follow-up reviews need version 1 and a reviews array.');
  const reviewed=new Map();
  for(const review of followupAudits.reviews){
    if(!object(review)||!nonempty(review.paperId)||!nonempty(review.originalId)||!nonempty(review.candidateId))fail('malformed follow-up review identity.');
    const key=edgeKey(review.paperId,review.originalId,review.candidateId),label=edgeLabel(review.paperId,review.originalId,review.candidateId);
    if(reviewed.has(key))fail(`duplicate review for ${label}.`);
    if(!expected.has(key))fail(`unexpected review for ${label}.`);
    reviewed.set(key,review);
    if(!['direct','transfer'].includes(review.verdict))fail(`unsupported verdict for ${label}.`);
    if(!substantive(review.reason))fail(`review of ${label} needs a substantive reason.`);
    conceptIds(review.sharedConceptIds,known,`review of ${label}`);
    const original=questions.get(review.originalId),candidate=questions.get(review.candidateId);
    for(const id of review.sharedConceptIds){
      if(!original.conceptIds.includes(id)||!candidate.conceptIds.includes(id))fail(`unsupported shared concept ${id} for ${label}; it must be mapped to both questions.`);
    }
    if(review.contentHash!==followupFingerprint(original,candidate,expected.get(key).match))fail(`review is stale for ${label}.`);
  }
  for(const [key,edge] of expected){
    if(!reviewed.has(key))fail(`missing review for ${edgeLabel(edge.paperId,edge.originalId,edge.candidateId)}.`);
  }
  return {papers:paperIds.size,groups:groupCount,followups:expected.size};
}

export async function validateFollowupAudit(root=siteRoot){
  const files=(await readdir(path.join(root,'content'),{withFileTypes:true}))
    .filter(entry=>entry.isFile()&&publicPlanFilename(entry.name)).map(entry=>entry.name).sort();
  const [bank,catalogue,followupAudits,plans]=await Promise.all([
    readJson(root,'content/official-question-bank.json'),readJson(root,'assets/studied-concepts.json'),
    readJson(root,'content/followup-audits.json'),Promise.all(files.map(async filename=>{
      const plan=await readJson(root,`content/${filename}`);
      if(plan?.metadata?.id!==filename.slice(0,-'-plan.json'.length))fail(`plan filename ${filename} disagrees with its paper ID.`);
      return plan;
    }))
  ]);
  return validateFollowupAuditData({bank,catalogue,plans,followupAudits});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=await validateFollowupAudit(process.argv[2]?path.resolve(process.argv[2]):siteRoot);
    console.log(`Follow-up audit gate passed: ${result.followups} reviewed links across ${result.papers} papers. This checks coverage, references and freshness; it does not establish mathematical or pedagogical correctness.`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
