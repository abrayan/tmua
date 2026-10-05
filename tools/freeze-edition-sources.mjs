#!/usr/bin/env node
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateContentAudit} from './validate-content-audit.mjs';
import {validateFollowupAudit} from './validate-followup-audit.mjs';
import {captureEditionSource,packSourceSnapshot,fileReader,gitReader,sourceHash,validateSnapshotRegistry,validateEditionSources} from './validate-edition-sources.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function freezeEditionSources(root=defaultRoot,{priorRead=gitReader(root)}={}){
  await validateContentAudit(root);await validateFollowupAudit(root);
  const read=fileReader(root),load=async(name,reader=read)=>JSON.parse(await reader(name));
  let registry;
  try{registry=await load('content/edition-source-snapshots.json');}catch(e){if(e.code!=='ENOENT')throw e;registry={version:1,editions:[]};}
  const [manifest,priorManifest]=await Promise.all([load('content/paper-editions.json'),load('content/paper-editions.json',priorRead)]);
  const priorKeys=new Set(priorManifest.editions.map(e=>`${e.paperId}:${e.editionId}`));
  const existing=validateSnapshotRegistry(registry);
  const selected=new Map(manifest.editions.map(e=>[e.paperId,e]));
  const targets=manifest.editions.filter(e=>(selected.get(e.paperId)===e||!priorKeys.has(`${e.paperId}:${e.editionId}`))&&!existing.has(`${e.paperId}:${e.editionId}`));
  const writeOnce=async(href,bytes)=>{await mkdir(path.dirname(path.join(root,href)),{recursive:true});try{await writeFile(path.join(root,href),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||!(await readFile(path.join(root,href))).equals(Buffer.from(bytes)))throw e;}};
  const additions=[];
  for(const entry of targets){
    const full=await captureEditionSource(priorKeys.has(`${entry.paperId}:${entry.editionId}`)?priorRead:read,entry);
    const {snapshot,files}=packSourceSnapshot(full);
    for(const [href,bytes] of files)await writeOnce(href,bytes);
    const bytes=JSON.stringify(snapshot,null,2)+'\n',hash=sourceHash(bytes),sourceHref=`content/edition-sources/${hash}.json`;
    await writeOnce(sourceHref,bytes);additions.push({...entry,sourceHref,sourceSha256:hash});
  }
  if(additions.length){
    const temporary=path.join(root,'content',`.edition-source-snapshots-${randomUUID()}.json`);
    try{await writeFile(temporary,JSON.stringify({...registry,editions:[...registry.editions,...additions]},null,2)+'\n',{flag:'wx'});await rename(temporary,path.join(root,'content/edition-source-snapshots.json'));}
    finally{await rm(temporary,{force:true});}
  }
  const result=await validateEditionSources(root,{priorRead});return {...result,appended:additions.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log('Frozen reviewed edition sources:',await freezeEditionSources(process.argv[2]||defaultRoot));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
