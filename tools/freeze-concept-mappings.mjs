// Freeze reviewed current mappings and bind only previously unbound editions.
// Usage: node tools/freeze-concept-mappings.mjs VERSION_ID
// First rollout only: append --baseline-repo REPO --baseline-ref COMMIT
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mappingHash} from './validate-concept-mappings.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), id=args[0];
if(!id||!/^[a-z0-9-]{1,80}$/.test(id)) throw Error('Supply a fresh mapping version ID.');
const flag=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const read=async name=>JSON.parse(await readFile(path.join(root,name),'utf8'));
// Read current papers only immediately before writing: no old staging map copy.
const map=await read('assets/concept-map.json');
const published=await read('content/published-papers.json'), editions=await read('content/paper-editions.json');
let locks;
const key=row=>`${row.paperId}:${row.teachingEdition}`;
function addVersion(versionId,papers){
  if(map.assessmentMappings.versions.some(row=>row.id===versionId)) throw Error(`Version ${versionId} already exists; choose a fresh ID.`);
  const row={id:versionId,sha256:mappingHash(papers),papers:structuredClone(papers)};
  map.assessmentMappings.versions.push(row);locks.versions.push({id:row.id,sha256:row.sha256});
}
function bind(paperId,teachingEdition,mappingVersion){
  const row={paperId,teachingEdition,mappingVersion};
  if(map.assessmentMappings.editionBindings.some(old=>key(old)===key(row))) return;
  map.assessmentMappings.editionBindings.push(row);locks.editionBindings.push({...row});
}
if(map.version===1){
  const repo=flag('--baseline-repo'), ref=flag('--baseline-ref');
  if(!repo||!ref||!/^[a-f0-9]{7,40}$/.test(ref)) throw Error('Initialization requires the exact published baseline repository and commit.');
  const gitRead=name=>JSON.parse(execFileSync('git',['show',`${ref}:${name}`],{cwd:repo,encoding:'utf8',maxBuffer:20*1024*1024}));
  const old=gitRead('assets/concept-map.json'), original=gitRead('content/published-papers.json'), oldEditions=gitRead('content/paper-editions.json');
  if(old.version!==1) throw Error('Use the existing v2 mapping history, not a fresh baseline.');
  map.version=2;map.assessmentMappings={version:1,versions:[],editionBindings:[]};
  locks={version:1,baselineCommit:ref,versions:[],editionBindings:[]};
  const legacyId=`published-${ref.slice(0,7)}`;
  addVersion(legacyId,old.papers);
  const oldIds=new Set(old.papers.map(p=>p.id));
  for(const paper of original.papers) if(oldIds.has(paper.id)) bind(paper.id,'original',legacyId);
  for(const edition of oldEditions.editions) if(oldIds.has(edition.paperId)) bind(edition.paperId,edition.editionId,legacyId);
}else{
  if(map.version!==2) throw Error('Unsupported map.');
  locks=await read('content/concept-mapping-locks.json');
  if(mappingHash(locks.editionBindings)!==mappingHash(map.assessmentMappings.editionBindings)) throw Error('Existing bindings changed.');
  for(const version of map.assessmentMappings.versions) if(mappingHash(version.papers)!==version.sha256 || !locks.versions.some(row=>row.id===version.id&&row.sha256===version.sha256)) throw Error('Existing mapping changed.');
}
addVersion(id,map.papers);
const ids=new Set(map.papers.map(p=>p.id));
for(const paper of published.papers) if(ids.has(paper.id)) bind(paper.id,'original',id);
for(const edition of editions.editions) if(ids.has(edition.paperId)) bind(edition.paperId,edition.editionId,id);
map.basis='Each original question is mapped to directly assessed knowledge. Every teaching edition keeps its frozen concept mapping, so earlier attempts retain their evidence. Manual totals and similar-question exercises are excluded; weighted evidence is not a diagnosis of each individual step.';
await writeFile(path.join(root,'assets/concept-map.json'),JSON.stringify(map,null,2)+'\n');
await writeFile(path.join(root,'content/concept-mapping-locks.json'),JSON.stringify(locks,null,2)+'\n');
console.log(`Froze ${id}; ${map.papers.length} current papers. Existing mapping versions and edition bindings were preserved.`);
