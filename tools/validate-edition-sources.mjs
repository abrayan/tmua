import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,conceptFingerprint,questionFingerprint,validateTeachingMarkup,validateContentAudit} from './validate-content-audit.mjs';
import {compileReviewedPaper,readPaperData} from './build-reviewed-editions.mjs';
import {validateFollowupAuditData,validateFollowupAudit} from './validate-followup-audit.mjs';

const siteRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const sourceHash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonicalJson(value)).digest('hex');
const fail=message=>{throw Error(`Edition source gate: ${message}`);};
const key=row=>`${row.paperId}:${row.editionId}`;
const json=bytes=>JSON.parse(bytes.toString());
const loaded=new WeakMap();
const loadJson=async(read,name)=>{let cache=loaded.get(read);if(!cache){cache=new Map();loaded.set(read,cache);}if(!cache.has(name))cache.set(name,json(await read(name)));return cache.get(name);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hashPattern=/^[a-f0-9]{64}$/;
export function gitReader(root,revision='HEAD'){
  if(!/^(?:HEAD|[a-f0-9]{40})$/.test(revision))fail('unsafe Git revision.');
  let revisionChecked=false;
  return async name=>{
    if(!revisionChecked){execFileSync('git',['cat-file','-e',`${revision}^{commit}`],{cwd:root,stdio:['ignore','pipe','pipe']});revisionChecked=true;}
    try{return execFileSync('git',['show',`${revision}:${name}`],{cwd:root,stdio:['ignore','pipe','pipe'],maxBuffer:128*1024*1024});}
    catch(error){
      const diagnostic=error.stderr?.toString().trim();
      if(error.status===128&&[
        `fatal: path '${name}' does not exist in '${revision}'`,
        `fatal: path '${name}' exists on disk, but not in '${revision}'`
      ].includes(diagnostic))throw Object.assign(Error(`ENOENT: no committed file ${revision}:${name}`,{cause:error}),{code:'ENOENT'});
      throw error;
    }
  };
}
export const fileReader=root=>name=>readFile(path.join(root,name));

// Keep precisely the inputs consumed by this paper, not a mutable pointer into
// the authoring bank. Source snapshots are review evidence, never runtime data.
export async function captureEditionSource(read,edition){
  const originals=await loadJson(read,'content/published-papers.json');
  const original=originals.papers.find(p=>p.id===edition.paperId);
  if(!original)fail(`missing original lock for ${key(edition)}.`);
  const html=(await read(original.href)).toString();
  if(sourceHash(html)!==original.sha256)fail(`original bytes changed for ${edition.paperId}.`);
  const load=name=>loadJson(read,name);
  const [bank,preview,studiedLessons,catalogue,questionAudits,conceptAudits,followupAudits]=await Promise.all([
    'content/official-question-bank.json','content/jz-mock-d-p1-preview.json','content/studied-lessons.json','assets/studied-concepts.json','content/question-audits.json','content/concept-audits.json','content/followup-audits.json'
  ].map(load));
  const plan=edition.paperId===preview.metadata.id?null:await load(`content/${edition.paperId}-plan.json`);
  const full={html,bank,plan:plan||undefined,preview:plan?undefined:preview,studiedLessons,catalogue,questionAudits};
  const output=compileReviewedPaper(full),data=readPaperData(output);
  const ids=new Set(data.questions.flatMap(g=>[g.original,...g.similar,...(g.legacySimilar||[])].map(q=>q.sourceId)));
  const questions=Object.fromEntries(Object.entries(bank.questions).filter(([id])=>ids.has(id)));
  const reviews=questionAudits.reviews.filter(r=>ids.has(r.sourceId));
  // Historical audit trails are retained in the global audit file. The frozen
  // source needs the exact review that approved this particular teaching only.
  const stripHistory=rows=>rows.map(({historicalAuditEvidence,...row})=>row);
  const concepts=new Set(data.questions.flatMap(g=>[g.original,...g.similar,...(g.legacySimilar||[])].flatMap(q=>[...q.conceptIds,...q.hints.flatMap(h=>h.recall.map(r=>r.lessonId))])));
  const compiler={path:'tools/build-reviewed-editions.mjs',sha256:sourceHash(await read('tools/build-reviewed-editions.mjs'))};
  const snapshot={version:1,paperId:edition.paperId,editionId:edition.editionId,compiler,original:{href:original.href,sha256:original.sha256},
    bank:{version:1,questions},plan,preview:plan?null:preview,
    studiedLessons:{...studiedLessons,booklets:studiedLessons.booklets.map(b=>({...b,lessons:b.lessons.filter(l=>concepts.has(l.id))})).filter(b=>b.lessons.length)},
    catalogue:{...catalogue,lessons:catalogue.lessons.filter(c=>concepts.has(c.id)),additionalConcepts:catalogue.additionalConcepts.filter(c=>concepts.has(c.id))},
    questionAudits:{version:1,reviews:stripHistory(reviews)},conceptAudits:{version:1,reviews:stripHistory(conceptAudits.reviews.filter(r=>concepts.has(r.conceptId)))},
    followupAudits:{version:1,reviews:stripHistory(followupAudits.reviews.filter(r=>r.paperId===edition.paperId))}
  };
  const compiled=compileSourceSnapshot(snapshot,html);
  if(compiled!==output)fail(`source subset changed compilation for ${key(edition)}.`);
  return snapshot;
}

export function packSourceSnapshot(snapshot){
  const files=new Map();
  const questions=Object.fromEntries(Object.entries(snapshot.bank.questions).map(([id,question])=>{
    const bytes=JSON.stringify(question,null,2)+'\n',hash=sourceHash(bytes);
    files.set(`content/edition-sources/questions/${hash}.json`,bytes);
    return [id,{questionSha256:hash}];
  }));
  return {snapshot:{...snapshot,bank:{version:1,questions}},files};
}
export async function resolveSourceSnapshot(read,snapshot){
  const questions={};
  for(const [id,reference] of Object.entries(snapshot.bank?.questions||{})){
    if(!reference||Object.keys(reference).length!==1||!hashPattern.test(reference.questionSha256))fail(`invalid frozen question reference ${id}.`);
    const bytes=await read(`content/edition-sources/questions/${reference.questionSha256}.json`);
    if(sourceHash(bytes)!==reference.questionSha256)fail(`frozen question source changed: ${id}.`);
    const question=json(bytes);
    if(question.sourceId!==id)fail(`frozen question source identity changed: ${id}.`);
    questions[id]=question;
  }
  return {...snapshot,bank:{version:1,questions}};
}

export function compileSourceSnapshot(snapshot,html){
  if(snapshot?.compiler?.path!=='tools/build-reviewed-editions.mjs'||!hashPattern.test(snapshot.compiler.sha256))fail('missing compiler provenance.');
  if(snapshot?.version!==1||!snapshot.paperId||!snapshot.editionId||!snapshot.original||!hashPattern.test(snapshot.original.sha256))fail('malformed source snapshot.');
  if(sourceHash(html)!==snapshot.original.sha256)fail(`original does not match snapshot ${key(snapshot)}.`);
  const {bank,plan,preview,studiedLessons,catalogue,questionAudits,conceptAudits,followupAudits}=snapshot;
  const concepts=[...(catalogue?.lessons||[]),...(catalogue?.additionalConcepts||[])];
  const reviews=new Map((conceptAudits?.reviews||[]).map(r=>[r.conceptId,r]));
  if(reviews.size!==concepts.length)fail(`missing or extra concept review in ${key(snapshot)}.`);
  for(const concept of concepts)if(reviews.get(concept.id)?.contentHash!==conceptFingerprint(concept))fail(`stale frozen concept review ${concept.id}.`);
  for(const q of Object.values(bank?.questions||{}))validateTeachingMarkup({hints:q.hints,solution:q.solution,options:q.options},q.sourceId);
  if(plan)validateFollowupAuditData({bank,catalogue,plans:[plan],followupAudits});
  else if(!preview||followupAudits.reviews.length)fail(`invalid preview snapshot ${key(snapshot)}.`);
  const result=compileReviewedPaper({html,bank,plan:plan||undefined,preview:preview||undefined,studiedLessons,catalogue,questionAudits});
  const data=readPaperData(result);
  if(data.metadata.id!==snapshot.paperId)fail('snapshot paper ID disagrees with compilation.');
  const used=new Set(data.questions.flatMap(g=>[g.original,...g.similar,...(g.legacySimilar||[])].map(q=>q.sourceId)));
  const actualReviews=questionAudits.reviews;
  if(actualReviews.length!==used.size||actualReviews.some(r=>!used.has(r.sourceId)))fail(`missing or extra frozen question review in ${key(snapshot)}.`);
  return result;
}

export function validateSnapshotRegistry(registry,priorRegistry=null){
  if(registry?.version!==1||!Array.isArray(registry.editions))fail('missing immutable snapshot registry.');
  const found=new Map();
  for(const row of registry.editions){
    if(!/^[a-z0-9-]+$/.test(row.paperId||'')||! /^[a-z0-9-]+$/.test(row.editionId||'')||found.has(key(row))||!hashPattern.test(row.sha256)||!hashPattern.test(row.sourceSha256)
      ||row.href!==`assets/editions/${row.editionId}/${row.paperId}.html`||row.sourceHref!==`content/edition-sources/${row.sourceSha256}.json`)fail('malformed or duplicate snapshot binding.');
    found.set(key(row),row);
  }
  if(priorRegistry){
    if(priorRegistry.version!==1||!Array.isArray(priorRegistry.editions)||priorRegistry.editions.length>registry.editions.length)fail('invalid prior registry.');
    priorRegistry.editions.forEach((row,index)=>{if(!same(row,registry.editions[index]))fail(`previously frozen source binding changed: ${key(row)}.`);});
  }
  return found;
}

export async function readFrozenEditionSource(root,paperId,editionId){
  const read=fileReader(root),registry=json(await read('content/edition-source-snapshots.json'));
  const bindings=validateSnapshotRegistry(registry),binding=bindings.get(`${paperId}:${editionId}`);
  if(!binding)fail(`missing frozen source for ${paperId}:${editionId}.`);
  const sourceBytes=await read(binding.sourceHref);
  if(sourceHash(sourceBytes)!==binding.sourceSha256)fail(`frozen source file changed: ${paperId}:${editionId}.`);
  const snapshot=await resolveSourceSnapshot(read,json(sourceBytes));
  if(snapshot.paperId!==paperId||snapshot.editionId!==editionId)fail('frozen source identity disagrees.');
  const original=json(await read('content/published-papers.json')).papers.find(p=>p.id===paperId);
  if(!original||!same(snapshot.original,{href:original.href,sha256:original.sha256}))fail('frozen original lock disagrees.');
  const compiled=compileSourceSnapshot(snapshot,(await read(original.href)).toString());
  if(sourceHash(compiled)!==binding.sha256||!(await read(binding.href)).equals(Buffer.from(compiled)))fail('frozen reviewed sources do not reproduce published bytes.');
  return snapshot;
}

const auditCurrentAuthoring=async root=>{await validateContentAudit(root);await validateFollowupAudit(root);};
export async function validateEditionSources(root=siteRoot,{priorRead,auditCurrentSources=auditCurrentAuthoring}={}){
  const read=fileReader(root),registry=json(await read('content/edition-source-snapshots.json'));
  // A real checkout always uses committed evidence. Non-Git fixture directories
  // must explicitly provide their trusted baseline reader; no self-authored hash
  // is treated as proof that a changed release was previously reviewed.
  if(!priorRead){
    try{execFileSync('git',['rev-parse','--verify','HEAD'],{cwd:root,stdio:'ignore'});priorRead=gitReader(root);}
    catch{fail('non-Git release validation needs an explicit priorRead baseline.');}
  }
  let priorRegistry=null;
  try{priorRegistry=json(await priorRead('content/edition-source-snapshots.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const priorEditions=json(await priorRead('content/paper-editions.json'));
  const priorKeys=new Set(priorEditions.editions.map(key)),priorBindings=new Set((priorRegistry?.editions||[]).map(key));
  const bindings=validateSnapshotRegistry(registry,priorRegistry);
  const manifest=json(await read('content/paper-editions.json')),originals=json(await read('content/published-papers.json'));
  const manifestKeys=new Map(manifest.editions.map(row=>[key(row),row])),latest=new Map(manifest.editions.map(row=>[row.paperId,row]));
  if(manifest.editions.some(row=>!priorKeys.has(key(row))))await auditCurrentSources(root);
  if(manifestKeys.size!==manifest.editions.length)fail('duplicate published edition identity.');
  if(priorEditions.editions.length>manifest.editions.length)fail('previously published edition removed.');
  priorEditions.editions.forEach((row,index)=>{if(!same(row,manifest.editions[index]))fail(`previously published edition changed or reordered: ${key(row)}.`);});
  const priorOriginals=json(await priorRead('content/published-papers.json'));
  if(new Set(originals.papers.map(row=>row.id)).size!==originals.papers.length)fail('duplicate original paper identity.');
  if(priorOriginals.papers.length>originals.papers.length)fail('original lock removed.');
  priorOriginals.papers.forEach((row,index)=>{if(!same(row,originals.papers[index]))fail(`original lock changed or reordered: ${row.id}.`);});
  for(const row of originals.papers)if(sourceHash(await read(row.href))!==row.sha256)fail(`original file changed: ${row.id}.`);
  for(const row of manifest.editions){
    if(sourceHash(await read(row.href))!==row.sha256)fail(`published edition file changed: ${key(row)}.`);
    if(!priorKeys.has(key(row))&&!bindings.has(key(row)))fail(`new edition lacks frozen reviewed sources: ${key(row)}.`);
  }
  for(const row of latest.values())if(!bindings.has(key(row)))fail(`latest edition lacks frozen reviewed sources: ${key(row)}.`);
  let fresh=0;
  for(const row of registry.editions){
    const edition=manifestKeys.get(key(row));
    if(!edition||edition.href!==row.href||edition.sha256!==row.sha256)fail(`source binding disagrees with immutable edition: ${key(row)}.`);
    const bytes=await read(row.sourceHref);
    if(sourceHash(bytes)!==row.sourceSha256)fail(`frozen source file changed: ${key(row)}.`);
    const snapshot=await resolveSourceSnapshot(read,json(bytes));
    if(snapshot.paperId!==row.paperId||snapshot.editionId!==row.editionId)fail('source identity disagrees with binding.');
    const original=originals.papers.find(p=>p.id===row.paperId);
    if(!original||!same(snapshot.original,{href:original.href,sha256:original.sha256}))fail(`source original lock disagrees: ${key(row)}.`);
    const compiled=compileSourceSnapshot(snapshot,(await read(original.href)).toString());
    if(sourceHash(compiled)!==row.sha256||!(await read(row.href)).equals(Buffer.from(compiled)))fail(`edition does not reproduce its frozen audited sources: ${key(row)}.`);
    if(!priorBindings.has(key(row))){
      // Bootstrap only from the committed source baseline; all genuinely new
      // editions must freeze the presently reviewed source and audit records.
      const expected=await captureEditionSource(priorKeys.has(key(row))?priorRead:read,edition);
      if(!same(snapshot,expected))fail(`new source snapshot differs from ${priorKeys.has(key(row))?'committed baseline':'current reviewed inputs'}: ${key(row)}.`);
      fresh++;
    }
  }
  return {snapshots:registry.editions.length,fresh,latest:latest.size,historicalEditions:manifest.editions.length-latest.size};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log('Edition source gate passed:',await validateEditionSources(process.argv[2]||siteRoot));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
