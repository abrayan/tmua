import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {captureEditionSource,packSourceSnapshot,resolveSourceSnapshot,compileSourceSnapshot,validateEditionSources,validateSnapshotRegistry,fileReader,gitReader,sourceHash} from '../tools/validate-edition-sources.mjs';
import {compileReviewedPaper,readPaperData as compilerReadPaperData} from '../tools/build-reviewed-editions.mjs';
import {readPaperData} from '../tools/read-paper-data.mjs';
import {questionFingerprint,conceptFingerprint,publishedMappingQuestions} from '../tools/validate-content-audit.mjs';
const clone=x=>structuredClone(x),cid='p1-b1-l01';
const metadata={format:'tmua-paper-v1',id:'tmua-fixture',title:'Test paper',paper:1,source:'Local fixture',description:'An isolated source snapshot test.',questionCount:1,version:1};
const question={sourceId:'2018-P1-Q01',lead:'Solve x+1=2.',options:['0','1','2'],correct:'B',hints:[{title:'Undo addition',body:'Subtract the same number from each side.',recap:'Keep both sides equal.',pitfall:'Change both sides.',pause:'Carry out the subtraction.',recall:[{lessonId:cid,reminder:'Use the same operation on both sides.'}]}],solution:'Subtract 1 from each side, giving x=1.',conceptIds:[cid]};
const lesson={id:cid,paper:1,title:'Rearranging equations',knowledge:['Apply the same operation to each side.']};
const source={bank:{version:1,questions:{[question.sourceId]:question}},plan:{metadata,groups:[{id:'q1',originalId:question.sourceId,candidates:[]}],matches:[]},preview:{metadata:{id:'preview'},questions:[]},studiedLessons:{version:1,booklets:[{paper:1,booklet:1,lessons:[{id:cid,title:lesson.title,number:1,pdfPage:3,knowledge:lesson.knowledge}]}]},catalogue:{version:1,lessons:[lesson],additionalConcepts:[]},questionAudits:{version:1,reviews:[{sourceId:question.sourceId,verifiedAnswer:'B',contentHash:questionFingerprint(question),conceptIds:[cid],verification:'Subtracting one from both sides gives the unique solution x=1.',remainingWork:'Carry out the subtraction and select the matching option.',hintVerdict:'The hint leaves the subtraction for the student to perform.',conceptReason:'The equation directly requires the equality-preserving operation.',issues:[]}]},conceptAudits:{version:1,reviews:[{conceptId:cid,contentHash:conceptFingerprint(lesson),verification:'Using the same operation on both sides preserves equality.'}]},followupAudits:{version:1,reviews:[]}};
const html=`<!doctype html><script type="application/json" id="tmua-paper-meta">${JSON.stringify(metadata)}</script><script type="application/json" id="tmua-paper-data">${JSON.stringify({metadata,questions:[{id:'q1',original:question,similar:[]}]})}</script>`;
const sourceFiles=s=>({'content/official-question-bank.json':s.bank,'content/tmua-fixture-plan.json':s.plan,'content/jz-mock-d-p1-preview.json':s.preview,'content/studied-lessons.json':s.studiedLessons,'assets/studied-concepts.json':s.catalogue,'content/question-audits.json':s.questionAudits,'content/concept-audits.json':s.conceptAudits,'content/followup-audits.json':s.followupAudits});
const missing=name=>Object.assign(Error(`ENOENT: ${name}`),{code:'ENOENT'});
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'tmua-source-snap-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original={id:metadata.id,href:'papers/paper-1/tmua-fixture.html',sha256:sourceHash(html)};
 const compiled=compileReviewedPaper({html,...source}),old={paperId:metadata.id,editionId:'old-review',href:'assets/editions/old-review/tmua-fixture.html',sha256:sourceHash(compiled)};
 const memory=new Map(Object.entries(sourceFiles(source)).map(([k,v])=>[k,Buffer.from(JSON.stringify(v))]));
 memory.set('tools/build-reviewed-editions.mjs',Buffer.from('Isolated fixture compiler provenance.'));
 memory.set(original.href,Buffer.from(html));memory.set(old.href,Buffer.from(compiled));memory.set('content/published-papers.json',Buffer.from(JSON.stringify({version:1,papers:[original]})));memory.set('content/paper-editions.json',Buffer.from(JSON.stringify({version:1,editions:[old]})));
 const priorRead=async name=>{if(!memory.has(name))throw missing(name);return Buffer.from(memory.get(name));};
 const write=async(name,bytes)=>{await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);};
 const put=async(name,value)=>write(name,JSON.stringify(value));
 for(const [name,bytes]of memory)await write(name,bytes);
 const registry={version:1,editions:[]};
 const freeze=async(entry,reader=fileReader(root))=>{
  const full=await captureEditionSource(reader,entry),{snapshot,files}=packSourceSnapshot(full);
  for(const [name,bytes]of files)await write(name,bytes);
  const bytes=JSON.stringify(snapshot,null,2)+'\n',hash=sourceHash(bytes),binding={...entry,sourceHref:`content/edition-sources/${hash}.json`,sourceSha256:hash};
  await write(binding.sourceHref,bytes);registry.editions.push(binding);await put('content/edition-source-snapshots.json',registry);return {full,snapshot,binding};
 };
 await freeze(old,priorRead);
 const advance=async()=>{
  const s=clone(source);s.bank.questions[question.sourceId].hints[0].body='Subtract the constant term from each side of the equation.';s.questionAudits.reviews[0].contentHash=questionFingerprint(s.bank.questions[question.sourceId]);
  for(const [name,value]of Object.entries(sourceFiles(s)))await put(name,value);
  return s;
 };
 const append=async(s=source)=>{
  const output=compileReviewedPaper({html,...s}),entry={...old,editionId:'new-review',href:'assets/editions/new-review/tmua-fixture.html',sha256:sourceHash(output)};
  await write(entry.href,output);await put('content/paper-editions.json',{version:1,editions:[old,entry]});return entry;
 };
 return {root,write,put,memory,priorRead,registry,freeze,advance,append,old,original};
}
test('bootstrap sources reproduce committed teaching; new reviewed editions freeze current inputs while old hints remain unchanged',async t=>{
 const f=await fixture(t);assert.equal((await validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}})).snapshots,1);
 const oldBytes=await readFile(path.join(f.root,f.old.href));const s=await f.advance();
 assert.equal((await validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}})).snapshots,1,'authoring bank can advance without republishing unrelated old editions');
 const next=await f.append(s);await f.freeze(next);
 const result=await validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}});assert.equal(result.snapshots,2);assert.equal(result.fresh,2);assert.deepEqual(await readFile(path.join(f.root,f.old.href)),oldBytes);
});
test('registry is append-only: no deletion, reordering or resetting an old source hash',()=>{
 const row={paperId:'tmua-fixture',editionId:'old-review',href:'assets/editions/old-review/tmua-fixture.html',sha256:'a'.repeat(64),sourceHref:`content/edition-sources/${'b'.repeat(64)}.json`,sourceSha256:'b'.repeat(64)},prior={version:1,editions:[row]};
 assert.equal(validateSnapshotRegistry(clone(prior),prior).size,1);
 for(const edited of [{version:1,editions:[]},{version:1,editions:[{...row,sha256:'c'.repeat(64)}]},{version:1,editions:[{...row,sourceHref:'../../escape',sourceSha256:'b'.repeat(64)}]}])assert.throws(()=>validateSnapshotRegistry(edited,prior));
});
test('changed frozen snapshot bytes and changed content-addressed question bytes are rejected',async t=>{
 const f=await fixture(t),binding=f.registry.editions[0],original=await readFile(path.join(f.root,binding.sourceHref));
 await f.write(binding.sourceHref,Buffer.concat([original,Buffer.from(' ')]));await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}}),/frozen source file changed/);await f.write(binding.sourceHref,original);
 const snapshot=JSON.parse(original),ref=Object.values(snapshot.bank.questions)[0];await f.write(`content/edition-sources/questions/${ref.questionSha256}.json`,'{}');await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}}),/frozen question source changed/);
});
test('a new edition cannot freeze stale authoring sources even if its file and declared hash agree',async t=>{
 const f=await fixture(t);await f.advance();const next=await f.append(source);await f.freeze(next,f.priorRead);
 await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}}),/differs from current reviewed inputs/);
});
test('new editions require a source binding; committed originals and older edition rows cannot be changed',async t=>{
 const f=await fixture(t);await f.append();await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}}),/new edition lacks frozen reviewed sources/);
 await f.put('content/paper-editions.json',{version:1,editions:[{...f.old,sha256:'f'.repeat(64)}]});await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}}),/previously published edition changed/);
 await f.put('content/paper-editions.json',{version:1,editions:[f.old]});await f.put('content/published-papers.json',{version:1,papers:[{...f.original,sha256:'f'.repeat(64)}]});await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{}}),/original lock changed/);
});
test('frozen question and concept audits must match the exact content being compiled',async t=>{
 const f=await fixture(t),snapshot=await captureEditionSource(f.priorRead,f.old);
 const stale=clone(snapshot);stale.bank.questions[question.sourceId].hints[0].body='A different mathematical instruction.';assert.throws(()=>compileSourceSnapshot(stale,html),/stale/);
 const bad=clone(snapshot);bad.catalogue.lessons[0].knowledge=['Different knowledge.'];assert.throws(()=>compileSourceSnapshot(bad,html),/stale frozen concept review/);
 const {snapshot:packed,files}=packSourceSnapshot(snapshot);assert.deepEqual(await resolveSourceSnapshot(async name=>Buffer.from(files.get(name)),packed),snapshot);
 const wrong=clone(packed);wrong.bank.questions[question.sourceId]={questionSha256:'../escape'};await assert.rejects(resolveSourceSnapshot(f.priorRead,wrong),/invalid frozen question reference/);
});
test('published concept mapping comes from verified latest immutable data, preserving unrelated old mappings',async t=>{
 const f=await fixture(t),map={papers:[{id:metadata.id,questions:[{sourceId:question.sourceId,lessonIds:[cid]}]}]};await f.advance();
 const questions=await publishedMappingQuestions(f.root,map);assert.deepEqual(questions.get(metadata.id).get(question.sourceId).conceptIds,[cid]);
 const bad=clone(map);bad.papers[0].questions[0].sourceId='2019-P1-Q01';await assert.rejects(publishedMappingQuestions(f.root,bad),/order disagrees/);
 await f.write(f.old.href,'tampered');await assert.rejects(publishedMappingQuestions(f.root,map),/published mapping source changed/);
});
test('a committed registry prevents replacing both a source file and its local hash',async t=>{
 const f=await fixture(t),baseline=new Map(f.memory);baseline.set('content/edition-source-snapshots.json',Buffer.from(JSON.stringify(f.registry)));
 const priorRead=async name=>{if(!baseline.has(name))throw missing(name);return Buffer.from(baseline.get(name));};
 const changed=clone(f.registry);changed.editions[0].sourceSha256='f'.repeat(64);changed.editions[0].sourceHref=`content/edition-sources/${'f'.repeat(64)}.json`;await f.put('content/edition-source-snapshots.json',changed);
 await assert.rejects(validateEditionSources(f.root,{priorRead}),/previously frozen source binding changed/);
});

test('new source snapshots also require the current full authoring gates',async t=>{
 const f=await fixture(t),next=await f.append();await f.freeze(next);
 let invoked=0;
 await assert.rejects(validateEditionSources(f.root,{priorRead:f.priorRead,auditCurrentSources:async()=>{invoked++;throw Error('current authoring audit is stale');}}),/current authoring audit is stale/);
 assert.equal(invoked,1);
});

test('old edition and original manifests remain exact prefixes: reorder, delete and prepend all fail',async t=>{
 const f=await fixture(t),next=await f.append();await f.freeze(next);
 const priorEditions={version:1,editions:[f.old,next]},secondOriginal={id:'tmua-other',href:'papers/paper-1/tmua-other.html',sha256:'b'.repeat(64)};
 const priorRead=async name=>name==='content/paper-editions.json'?Buffer.from(JSON.stringify(priorEditions)):f.priorRead(name);
 for(const entries of [[next,f.old],[f.old],[{...next,editionId:'prepended-review',href:'assets/editions/prepended-review/tmua-fixture.html'},f.old,next]]){
  await f.put('content/paper-editions.json',{version:1,editions:entries});
  await assert.rejects(validateEditionSources(f.root,{priorRead,auditCurrentSources:async()=>{}}),/previously published edition (changed|removed)/);
 }
 await f.put('content/paper-editions.json',priorEditions);
 const priorOriginals={version:1,papers:[f.original,secondOriginal]};
 const originalRead=async name=>name==='content/published-papers.json'?Buffer.from(JSON.stringify(priorOriginals)):priorRead(name);
 for(const entries of [[secondOriginal,f.original],[f.original],[{...secondOriginal,id:'tmua-prepended'},f.original,secondOriginal]]){
  await f.put('content/published-papers.json',{version:1,papers:entries});
  await assert.rejects(validateEditionSources(f.root,{priorRead:originalRead,auditCurrentSources:async()=>{}}),/original lock (changed|removed)/);
 }
});


test('Git reader treats only exact missing committed paths as ENOENT, including an uncommitted on-disk file',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'tmua-git-source-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=args=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']});
 git(['init','--quiet']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--quiet','-m','Isolated fixture']);
 const name='content/edition-source-snapshots.json',read=gitReader(root);
 await assert.rejects(read(name),error=>error.code==='ENOENT'&&error.cause.stderr.toString().includes('does not exist'));
 await mkdir(path.join(root,'content'));await writeFile(path.join(root,name),'{}');
 await assert.rejects(read(name),error=>error.code==='ENOENT'&&error.cause.stderr.toString().includes('exists on disk'));
 await assert.rejects(gitReader(root,'f'.repeat(40))(name),error=>error.code!=='ENOENT');
 const f=await fixture(t);
 await assert.rejects(validateEditionSources(f.root,{priorRead:async file=>{
   if(file===name)throw Error("fatal: some other Git failure does not exist ENOENT");return f.priorRead(file);
 },auditCurrentSources:async()=>{}}),/some other Git failure/);
});


test('inert paper-data parser matches the frozen compiler parser and rejects ambiguous or executable payloads',()=>{
 assert.deepEqual(readPaperData(html),compilerReadPaperData(html));
 const commented='<!-- <script id="tmua-paper-data" type="application/json">{}</script> -->'+html;
 assert.deepEqual(readPaperData(commented),compilerReadPaperData(html));
 for(const bad of [html.replace('type="application/json" id="tmua-paper-data"','type="text/javascript" id="tmua-paper-data"'),html+html,html.slice(0,-9)]){
  assert.throws(()=>readPaperData(bad));assert.throws(()=>compilerReadPaperData(bad));
 }
});
