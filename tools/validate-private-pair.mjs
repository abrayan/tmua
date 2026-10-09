import {createHash} from 'node:crypto';
import {readFile,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,questionFingerprint,validateAuditData,validateTeachingMarkup} from './validate-content-audit.mjs';
import {followupFingerprint,validateFollowupAuditData} from './validate-followup-audit.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const fullHash=value=>sha(canonicalJson(value));
const substantive=value=>typeof value==='string'&&value.trim().length>=20&&value.trim().split(/\s+/).length>=3;
const fail=message=>{throw Error(`Private pair: ${message}`);};
// Private editions may repair teaching for a reused official exercise without
// changing or publishing any public file. All source/presentation fields remain
// byte-for-byte JSON-equivalent; only this explicit teaching allowlist can vary.
const PRIVATE_PROVIDERS = new Map([['jzmaths-tyler', /^tyler-exam-[a-z0-9]+$/], ['jzmaths-exam', /^jz-exam-[a-z0-9]+$/], ['miomath', /^miomath-tmua-2024$/]]);
// This is an immutable upload identity, never a signed download URL or token.
const PRIVATE_PDF_URL = /^https:\/\/[a-z0-9]{20}\.supabase\.co\/storage\/v1\/object\/authenticated\/tmua-pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const PRIVATE_TEACHING_FIELDS = new Set(['hints','solution','conceptIds','knowledgePattern','knowledgeTags']);
export function validateTeachingOverride(original,candidate){
  if(original.provider!=='official-tmua'||candidate?.provider!=='official-tmua'||candidate.sourceId!==original.sourceId)fail('private teaching overrides require the same official question identity.');
  const fixed=q=>Object.fromEntries(Object.entries(q).filter(([key])=>!PRIVATE_TEACHING_FIELDS.has(key)));
  if(canonicalJson(fixed(original))!==canonicalJson(fixed(candidate)))fail(`${original.sourceId}: private teaching override changed the mathematical question or source fields.`);
}
export async function validatePrivatePair(configFile){
  const inputs={};
  const read=async filename=>{const bytes=await readFile(filename);inputs[filename]=sha(bytes);return JSON.parse(bytes);};
  const privatePath=async filename=>{
    const resolved=await realpath(filename),relative=path.relative(root,resolved);
    if(relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))fail('private source files must be outside the public repository.');
    for(let parent=path.dirname(resolved);;parent=path.dirname(parent)){
      let git=false;try{await lstat(path.join(parent,'.git'));git=true;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(git)fail('private source files must remain outside Git repositories.');
      if(parent===path.dirname(parent))break;
    }
    return resolved;
  };
  configFile=await privatePath(configFile);
  const config=await read(configFile),base=path.dirname(configFile);
  if(config.version!==1||config.visibility!=='private'||!Array.isArray(config.plans)||config.plans.length!==2)fail('require private version 1 configuration with both plans.');
  for(const key of ['pairId','editionId','mappingVersionId'])if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(config[key]||'')||config[key]==='original')fail(`invalid ${key}.`);
  const fromPrivate=async name=>{
    if(typeof name!=='string'||!name)fail('missing private source filename.');
    return read(await privatePath(path.resolve(base,name)));
  };
  const [plans,privateBank,privateAudits,followupAudits,qa,publicBank,publicAudits,catalogue,conceptAudits,coverage,studiedLessons,publicMap]=await Promise.all([
    Promise.all(config.plans.map(fromPrivate)),fromPrivate(config.bank),fromPrivate(config.questionAudits),fromPrivate(config.followupAudits),fromPrivate(config.qa),
    ...['content/official-question-bank.json','content/question-audits.json','assets/studied-concepts.json','content/concept-audits.json','content/syllabus-coverage.json','content/studied-lessons.json','assets/concept-map.json'].map(name=>read(path.join(root,name)))
  ]);
  if(privateBank.version!==1||!privateBank.questions||Array.isArray(privateBank.questions))fail('private question bank is invalid.');
  if(privateAudits.version!==1||!Array.isArray(privateAudits.reviews))fail('private question audits are invalid.');
  const overrides=new Set();
  for(const [id,question] of Object.entries(privateBank.questions))if(publicBank.questions[id]){validateTeachingOverride(publicBank.questions[id],question);overrides.add(id);}
  const bank={version:1,questions:{...publicBank.questions,...privateBank.questions}};
  if(new Set(plans.map(p=>p.metadata?.paper)).size!==2||!plans.some(p=>p.metadata?.paper===1)||!plans.some(p=>p.metadata?.paper===2))fail('one plan for each paper is required.');
  const used=new Set(),originals=new Set(),uploadedSources=new Set();
  for(const plan of plans){
    const m=plan.metadata;
    if(m?.visibility!=='private'||!PRIVATE_PROVIDERS.has(m.provider)||m.pairId!==config.pairId||m.practicePolicy!=='after-miss-up-to-3'||m.questionCount!==20||plan.groups?.length!==20)fail('both private plans need 20 originals, shared pairId, exact provider and adaptive practice.');
    if(m.id!==`${config.pairId}-p${m.paper}`)fail('paper ID disagrees with pair and paper number.');
    const sourcePrefix = `${m.provider==='miomath'?'MIOMATH-2024':config.pairId.toUpperCase()}-P${m.paper}-Q`;
    if(!PRIVATE_PROVIDERS.get(m.provider).test(config.pairId))fail('private pair must identify the exact exam set and provider.');
    const sourceUrl = m.provider==='miomath'?m.sourceUrl:`https://jzmaths.com/simulator/${config.pairId.replaceAll('-','_')}_p${m.paper}`;
    if(m.provider==='miomath'){
      if(typeof sourceUrl!=='string'||!PRIVATE_PDF_URL.test(sourceUrl)||sourceUrl.trim()!==sourceUrl||uploadedSources.has(sourceUrl))fail('MioMath papers require distinct stable private PDF source URLs without credentials or tokens.');
      uploadedSources.add(sourceUrl);
    }
    for(const [index,group] of plan.groups.entries()){
      if(group.legacyCandidates !== undefined && (!Array.isArray(group.legacyCandidates)||group.legacyCandidates.length))fail('private releases cannot include unaudited legacyCandidates.');
      const expectedId = `${sourcePrefix}${String(index+1).padStart(2,'0')}`;
      if(group.originalId!==expectedId)fail('private originals must be questions 01–20 in source order from the exact pair and paper.');
      if(originals.has(group.originalId))fail('duplicate assessment original.');
      originals.add(group.originalId);
      const q=bank.questions[group.originalId];
      if(!q||q.provider!==m.provider||!substantive(q.knowledgePattern))fail(`${group.originalId} needs private provider identity and a precise knowledgePattern.`);
      if(q.sourceId!==expectedId||q.sourceUrl!==sourceUrl)fail('private original source identity or URL disagrees with its pair.');
      if(!Array.isArray(group.candidates))fail('candidates must be an array.');
      if(group.candidates.length<3&&!substantive(group.followupGap))fail(`${group.originalId}: document the gap when fewer than three defensible matches exist.`);
      for(const id of [group.originalId,...group.candidates])used.add(id);
    }
  }
  for(const plan of plans)for(const group of plan.groups)for(const id of group.candidates)if(originals.has(id))fail('assessment overlap in follow-ups.');
  if([...Object.keys(privateBank.questions)].some(id=>!used.has(id)))fail('private bank contains unused exercises.');
  const questions=[...used].map(id=>bank.questions[id]);
  if(questions.some(q=>!q))fail('unknown exercise ID.');
  for(const question of questions){
    validateTeachingMarkup({lead:question.lead,tail:question.tail,fallback:question.fallback,source:question.source},question.sourceId);
    const strings=JSON.stringify(question);
    if(/\bon[a-z]+\s*=|(?:javascript|vbscript):/i.test(strings))fail(`${question.sourceId}: active authored markup is not allowed.`);
  }
  const reviewed=new Map(publicAudits.reviews.map(row=>[row.sourceId,row]));
  const supplied=new Set();
  for(const row of privateAudits.reviews){
    if(supplied.has(row.sourceId)||!used.has(row.sourceId))fail('duplicate or unused private question review.');
    supplied.add(row.sourceId);reviewed.set(row.sourceId,row);
  }
  for(const id of overrides)if(!supplied.has(id))fail(`${id}: private teaching override requires a fresh private question review.`);
  const questionAudits={version:1,reviews:[...used].map(id=>reviewed.get(id))};
  for(const row of questionAudits.reviews)if(!row||(supplied.has(row.sourceId)&&row.issues?.length))fail('every exercise needs a resolved review.');
  const counts=validateAuditData({questions,catalogue,questionAudits,conceptAudits,coverage,studiedLessons},{counts:{bank:0,preview:0}});
  const links=validateFollowupAuditData({bank,catalogue,plans,followupAudits});
  if(qa.version!==1||qa.status!=='approved'||typeof qa.author!=='string'||!qa.author.trim()||typeof qa.reviewer!=='string'||!qa.reviewer.trim()||qa.author===qa.reviewer||!Array.isArray(qa.questions)||!Array.isArray(qa.relationships))fail('independent approval with distinct author and reviewer identities is required.');
  const checked=new Map();
  for(const row of qa.questions){
    const q=bank.questions[row.sourceId];
    if(!used.has(row.sourceId)||checked.has(row.sourceId)||!q)fail('independent QA has duplicate or unexpected question.');
    if(row.contentHash!==questionFingerprint(q)||row.fullHash!==fullHash(q))fail(`independent QA is stale for ${row.sourceId}.`);
    if(['verification','hintVerdict','remainingWork','conceptReason'].some(key=>!substantive(row[key]))||!Array.isArray(row.issues)||row.issues.length)fail(`independent QA needs resolved, specific review for ${row.sourceId}.`);
    checked.set(row.sourceId,row);
  }
  if(checked.size!==used.size)fail('independent QA must cover every original and follow-up.');
  const edgeKey=row=>JSON.stringify([row.paperId,row.originalId,row.candidateId]);
  const expected=new Map(followupAudits.reviews.map(row=>[edgeKey(row),row])),checkedEdges=new Set();
  for(const row of qa.relationships){
    const key=edgeKey(row),review=expected.get(key),plan=plans.find(p=>p.metadata.id===row.paperId),match=plan?.matches.find(m=>m.originalId===row.originalId&&m.candidateId===row.candidateId);
    if(!review||checkedEdges.has(key)||!match)fail('independent QA has duplicate or unexpected relationship.');
    if(row.contentHash!==followupFingerprint(bank.questions[row.originalId],bank.questions[row.candidateId],match)||!['direct','transfer'].includes(row.verdict)||!substantive(row.reason)||canonicalJson(row.sharedConceptIds)!==canonicalJson(review.sharedConceptIds)||row.verdict!==review.verdict)fail('independent relationship review is stale or disagrees.');
    checkedEdges.add(key);
  }
  if(checkedEdges.size!==expected.size)fail('independent QA must cover every relationship.');
  const publicCanonical=new Map(publicMap.papers.flatMap(p=>p.questions.map(q=>[q.sourceId,q.canonicalSourceId||q.sourceId])));
  const mappings=plans.map(plan=>{
    const paper={id:plan.metadata.id,paper:plan.metadata.paper,title:plan.metadata.title,version:1,contentRevisions:[plan.metadata.contentRevision||1],questions:plan.groups.map(g=>g.originalId).map(id=>{
      const q=bank.questions[id];return {sourceId:id,canonicalSourceId:publicCanonical.get(id)||q.canonicalSourceId||id,knowledgePattern:q.knowledgePattern||q.label,lessonIds:q.conceptIds};
    })};
    return {versionId:config.mappingVersionId,sha256:fullHash(paper),paper};
  });
  return {pairId:config.pairId,editionId:config.editionId,mappings,inputs,counts,links};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await validatePrivatePair(path.resolve(process.argv[2]))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
