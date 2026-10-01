import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildSite,parseMetadata} from '../tools/build-site.mjs';

const metadata={format:'tmua-paper-v1',id:'fixture-p1',title:'Test fixture',paper:1,source:'Synthetic',description:'',questionCount:1,version:1};
const html=meta=>`<script type="application/json" id="tmua-paper-meta">${JSON.stringify(meta)}</script>`;
const paid={metadata:{...metadata,visibility:'private',provider:'jzmaths-tyler'},questions:[]};

test('public catalogue rejects private marker and paid provider independently',()=>{
  for(const marker of [{visibility:'private'},{provider:'jzmaths-tyler'},{provider:'jzmaths-exam'}])assert.throws(()=>parseMetadata(html({...metadata,...marker})),/private purchased/);
});

test('public build refuses marked payloads in every copied asset location and preserves last build',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'private-public-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'index.html'),'<title>Public fixture</title>');
  const {destination}=await buildSite(root);
  const previous=await readFile(path.join(destination,'papers/catalog.json'),'utf8');
  for(const [file,content] of [['assets/data.json',JSON.stringify(paid)],['assets/renamed.txt',JSON.stringify(paid)],['assets/paid-data.js',`const PRIVATE_DATA=${JSON.stringify(paid)};`],['assets/paid-data.mjs',`export default {visibility:'private', questions:[]};`],['assets/paid-data.txt',`const DATA={provider:'jzmaths-tyler',questions:[]};`],['assets/jz-exam.json',JSON.stringify({questions:[{provider:'jzmaths-exam',lead:'synthetic paid fixture'}]})],['assets/jz-exam.txt',`const DATA={provider:'jzmaths-exam',questions:[]};`],['assets/jz-exam.html',html({...metadata,provider:'jzmaths-exam'})],['assets/edition.html',html(paid.metadata)],['papers/paper-1/paid.html',html(paid.metadata)],['assets/obscured.html',html(metadata)+`<script>const DATA=${JSON.stringify(paid)};</script>`]]){
    const filename=path.join(root,file);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,content);
    await assert.rejects(buildSite(root),/private purchased/,file);
    assert.equal(await readFile(path.join(destination,'papers/catalog.json'),'utf8'),previous);
    await rm(filename);
  }
});

test('public roadmap may retain title and external purchased-paper link without embedding paid content',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'private-link-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'index.html'),'<title>Public fixture</title>');await mkdir(path.join(root,'assets'));
  const data={id:'tyler-exam-a',title:'Tyler Exam Set A',href:'https://jzmaths.com/simulator/tyler_exam_a_p1'};
  await writeFile(path.join(root,'assets/roadmap.json'),JSON.stringify(data));
  await writeFile(path.join(root,'assets/runtime.js'),`const privatePaper = item.visibility === 'private' || item.provider === 'jzmaths-tyler';`);
  const result=await buildSite(root);assert.deepEqual(JSON.parse(await readFile(path.join(result.destination,'assets/roadmap.json'))),data);
});
