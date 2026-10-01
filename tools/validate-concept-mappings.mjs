import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const rootDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const mappingHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>{throw Error(`Concept mapping gate: ${message}`);};
const bindingKey=row=>`${row.paperId}:${row.teachingEdition}`;
export function validateMappingData({map,locks,published,editions,catalogue,analytics,priorLocks=null}) {
  if(map?.version!==2) fail('production requires version 2.');
  const window={}; vm.runInNewContext(analytics,{window,URL,Date});
  const api=window.TmuaProgressAnalytics, papers=api.validateMap(map);
  api.validateMappedLessons(papers,api.validateLessons(catalogue));
  if(locks?.version!==1 || !Array.isArray(locks.versions) || !Array.isArray(locks.editionBindings)) fail('missing immutable locks.');
  const mapping=map.assessmentMappings, versions=new Map(mapping.versions.map(row=>[row.id,row]));
  const locked=new Map(locks.versions.map(row=>[row.id,row.sha256]));
  if(locked.size!==locks.versions.length || locked.size!==versions.size) fail('duplicate or missing version locks.');
  for(const [id,version] of versions) if(mappingHash(version.papers)!==version.sha256 || locked.get(id)!==version.sha256) fail(`modified frozen mapping ${id}.`);
  if(mappingHash(mapping.editionBindings)!==mappingHash(locks.editionBindings)) fail('edition bindings disagree with immutable locks.');
  if(priorLocks){
    for(const row of priorLocks.versions||[]) if(locked.get(row.id)!==row.sha256) fail(`previously published mapping changed: ${row.id}.`);
    for(const row of priorLocks.editionBindings||[]) if(!mapping.editionBindings.some(now=>bindingKey(now)===bindingKey(row)&&now.mappingVersion===row.mappingVersion)) fail(`previously published binding changed: ${bindingKey(row)}.`);
  }
  const bindings=new Map(mapping.editionBindings.map(row=>[bindingKey(row),row.mappingVersion]));
  const mappedIds=new Set(papers.map(p=>p.id));
  const expected=new Set();
  for(const row of published.papers) if(mappedIds.has(row.id)) expected.add(`${row.id}:original`);
  for(const row of editions.editions) if(mappedIds.has(row.paperId)) expected.add(`${row.paperId}:${row.editionId}`);
  for(const key of expected) if(!bindings.has(key)) fail(`missing edition binding ${key}.`);
  for(const key of bindings.keys()) if(!expected.has(key)) fail(`binding has no corresponding paper edition: ${key}.`);
  for(const paper of papers){
    if(!expected.has(`${paper.id}:original`)) fail(`unpublished mapped paper ${paper.id}.`);
    const latest=editions.editions.filter(row=>row.paperId===paper.id).at(-1)?.editionId||'original';
    const version=versions.get(bindings.get(`${paper.id}:${latest}`));
    const frozen=version?.papers.find(row=>row.id===paper.id);
    if(mappingHash(frozen)!==mappingHash(paper)) fail(`latest ${paper.id} mapping differs from reviewed current map; append a new mapping version and teaching edition.`);
  }
  return {versions:versions.size,bindings:bindings.size,papers:papers.length};
}
export async function validateConceptMappings(root=rootDefault,{priorLocks}={}) {
  const read=name=>readFile(path.join(root,name),'utf8');
  const [map,locks,published,editions,catalogue]=await Promise.all(['assets/concept-map.json','content/concept-mapping-locks.json','content/published-papers.json','content/paper-editions.json','assets/studied-concepts.json'].map(async name=>JSON.parse(await read(name))));
  if(priorLocks===undefined){
    // If this is a Git checkout, released locks are append-only even if a future
    // author tries to refresh both a mapping hash and its local lock together.
    let previous;
    try {previous=execFileSync('git',['show','HEAD:content/concept-mapping-locks.json'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});} catch {previous=null;}
    priorLocks=previous===null?null:JSON.parse(previous);
  }
  return validateMappingData({map,locks,published,editions,catalogue,analytics:await read('assets/progress-analytics.js'),priorLocks});
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const result=await validateConceptMappings(process.argv[2]||rootDefault);console.log(`Concept mapping gate passed: ${result.versions} frozen versions; ${result.bindings} edition bindings; ${result.papers} papers.`);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
