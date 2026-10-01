import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {publicMockUrl,publicMockMarked,isPublicMockMetadata,isPublicMockQuestion,assertPublicMockPaper,assertPublicMockPlan,publicPlanFilename} from '../tools/public-mock-sources.mjs';
import {parseMetadata,assertPublicPayload,assertPublicFile,discoverPapers} from '../tools/build-site.mjs';
import {validateFollowupAudit,followupFingerprint} from '../tools/validate-followup-audit.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(letter='A',paper=1){
 const metadata={format:'tmua-paper-v1',id:`jz-mock-${letter.toLowerCase()}-p${paper}`,pairId:`jz-${letter.toLowerCase()}`,paper,title:`JZ Mock ${letter} · Paper ${paper}`,version:1,questionCount:20,provider:'jzmaths-mock',visibility:'public',source:`JZ Maths · Mock ${letter}`,sourceUrl:publicMockUrl(letter,paper),description:'Synthetic identity test fixture.',practicePolicy:'after-miss-up-to-3'};
 const questions=Array.from({length:20},(_,i)=>({id:`q${i+1}`,original:{sourceId:`JZ-MOCK-${letter}-P${paper}-Q${String(i+1).padStart(2,'0')}`,provider:'jzmaths-mock',source:`JZ Maths · Mock ${letter} · Q${i+1}`,sourceUrl:metadata.sourceUrl,lead:'Synthetic fixture only',conceptIds:['p1-b1-l01']},similar:[]}));
 return {metadata,questions};
}
const html=data=>`<script type="application/json" id="tmua-paper-meta">${JSON.stringify(data.metadata)}</script><script id="tmua-paper-data" type="application/json">${JSON.stringify(data)}</script>`;
async function dir(t){const d=await mkdtemp(path.join(os.tmpdir(),'tmua-mock-sources-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}

test('only public Mock A–E pairs retain exact provider and attribution in catalogue metadata',()=>{
 for(const letter of 'ABCDE')for(const paper of [1,2]){
  const data=fixture(letter,paper);assert.ok(isPublicMockMetadata(data.metadata));assert.ok(data.questions.every(g=>isPublicMockQuestion(g.original,data.metadata)));assertPublicMockPaper(data);assertPublicPayload(data);
  const meta=parseMetadata(html(data));assert.equal(meta.provider,'jzmaths-mock');assert.equal(meta.visibility,'public');assert.equal(meta.sourceUrl,publicMockUrl(letter,paper));assert.equal(meta.pairId,`jz-${letter.toLowerCase()}`);
 }
 assert.equal(publicMockMarked({id:'jz-mock-d-p1-preview'}),false,'The frozen historical preview remains separate.');
});

test('wrong set, paper, URL, provider, attribution and private identities fail closed in metadata and questions',()=>{
 const changes=[['id','jz-exam-a-p1'],['id','jz-mock-f-p1'],['id','jz-mock-a-p2'],['pairId','jz-exam-a'],['pairId','jz-b'],['provider','official-tmua'],['provider','jzmaths-exam'],['provider','jzmaths-tyler'],['visibility','private'],['visibility',undefined],['paper',true],['paper',2],['questionCount',19],['source','Official TMUA'],['source','JZ Maths Mock B'],['sourceUrl','https://jzmaths.com/simulator/jz_exam_a_p1'],['sourceUrl',publicMockUrl('B',1)],['sourceUrl',publicMockUrl('A',2)],['sourceUrl',publicMockUrl('A',1)+'?paid=true'],['sourceUrl',publicMockUrl('A',1)+'#page=2'],['sourceUrl',publicMockUrl('A',1).replace('https:','http:')],['sourceUrl',publicMockUrl('A',1).replace('jzmaths.com','u:p@jzmaths.com')],['sourceUrl',publicMockUrl('A',1).replace('jzmaths.com','jzmaths.com:443')]];
 for(const [key,value] of changes){const d=fixture();d.metadata[key]=value;assert.equal(isPublicMockMetadata(d.metadata),false,`${key}=${value}`);assert.throws(()=>parseMetadata(html(d)),undefined,`${key}=${value}`);assert.throws(()=>assertPublicMockPaper(d));}
 for(const [key,value] of [['sourceId','JZ-EXAM-A-P1-Q01'],['sourceId','JZ-MOCK-F-P1-Q01'],['sourceId','JZ-MOCK-A-P2-Q01'],['sourceId','JZ-MOCK-A-P1-Q00'],['sourceId','JZ-MOCK-A-P1-Q21'],['provider','official-tmua'],['sourceUrl','https://jzmaths.com/simulator/jz_mock_a_p1'],['source','Official TMUA'],['visibility','private']]){const d=fixture();d.questions[0].original[key]=value;assert.throws(()=>assertPublicMockPaper(d),undefined,`${key}=${value}`);assert.throws(()=>assertPublicPayload(d));}
});

test('mock originals cannot enter follow-ups, official assessments, private paths or unordered papers',()=>{
 const data=fixture();data.questions[0].similar=[structuredClone(data.questions[1].original)];assert.throws(()=>assertPublicMockPaper(data),/not follow-up/);
 data.questions[0].similar=[];data.questions.reverse();assert.throws(()=>assertPublicMockPaper(data),/source order/);
 data.questions.reverse();data.questions.pop();assert.throws(()=>assertPublicMockPaper(data),/twenty/);
 const official=fixture();official.metadata={...official.metadata,id:'tmua-2020-p1',provider:'official-tmua'};assert.throws(()=>assertPublicMockPaper(official),/twenty exact/);
 for(const provider of ['jzmaths-exam','jzmaths-tyler']){const d=fixture();d.questions[0].original.provider=provider;assert.throws(()=>assertPublicPayload(d));}
 const mapping={papers:[{id:'jz-mock-a-p1',questions:[{sourceId:'JZ-MOCK-A-P1-Q01',lessonIds:['p1-b1-l01']}]}]};assert.doesNotThrow(()=>assertPublicPayload(mapping),'References are not mistaken for original payloads.');
});

test('public HTML scanning rejects hidden paid source substitutions while allowing the exact mock',async t=>{
 const d=await dir(t),file=path.join(d,'mock.html'),data=fixture();await writeFile(file,html(data));await assertPublicFile(file);
 data.questions[0].original.sourceUrl='https://jzmaths.com/simulator/jz_exam_a_p1';await writeFile(file,html(data));await assert.rejects(assertPublicFile(file),/Public JZ mock/);
});

test('discovery accepts complete mock identity and keeps the frozen preview path independent',async t=>{
 const d=await dir(t);await mkdir(path.join(d,'papers/paper-1'),{recursive:true});await writeFile(path.join(d,'papers/paper-1/jz-mock-a-p1.html'),html(fixture()));
 const {catalog}=await discoverPapers(d);assert.equal(catalog.papers[0].id,'jz-mock-a-p1');assert.equal(catalog.papers[0].provider,'jzmaths-mock');
 const bad=fixture();bad.metadata.pairId='jz-exam-a';await writeFile(path.join(d,'papers/paper-1/jz-mock-a-p1.html'),html(bad));await assert.rejects(discoverPapers(d),/Public JZ mock/);
});

test('follow-up filesystem gate includes mock plans and enforces their original-only source identity',async t=>{
 const d=await dir(t);await mkdir(path.join(d,'content'),{recursive:true});await mkdir(path.join(d,'assets'),{recursive:true});const data=fixture(),original=data.questions[0].original,candidate={...original,provider:'official-tmua',sourceId:'2020-P1-Q01'};
 const bank={version:1,questions:Object.fromEntries([...data.questions.map(g=>[g.original.sourceId,g.original]),[candidate.sourceId,candidate]])};
 const match={originalId:original.sourceId,candidateId:candidate.sourceId,reason:'Synthetic relation for source identity validation only.'};
 const plan={metadata:data.metadata,groups:data.questions.map((g,i)=>({id:g.id,originalId:g.original.sourceId,candidates:i?[]:[candidate.sourceId]})),matches:[match]};
 const review={paperId:data.metadata.id,originalId:original.sourceId,candidateId:candidate.sourceId,verdict:'direct',reason:'Synthetic relation exercises a source identity check in isolation.',sharedConceptIds:['p1-b1-l01'],contentHash:followupFingerprint(original,candidate,match)};
 const docs={'content/official-question-bank.json':bank,'assets/studied-concepts.json':{version:1,lessons:[{id:'p1-b1-l01'}],additionalConcepts:[]},'content/followup-audits.json':{version:1,reviews:[review]},'content/jz-mock-a-p1-plan.json':plan};
 for(const [n,j] of Object.entries(docs))await writeFile(path.join(d,n),JSON.stringify(j));
 assert.deepEqual(await validateFollowupAudit(d),{papers:1,groups:20,followups:1});
 await writeFile(path.join(d,'content/followup-audits.json'),JSON.stringify({version:1,reviews:[]}));await assert.rejects(validateFollowupAudit(d),/missing review/);
 plan.groups[0].candidates=[data.questions[1].original.sourceId];assert.throws(()=>assertPublicMockPlan(plan,bank.questions),/not follow-up/);
 assert.ok(publicPlanFilename('jz-mock-e-p2-plan.json'));assert.equal(publicPlanFilename('jz-exam-a-p1-plan.json'),false);assert.equal(publicPlanFilename('tyler-exam-a-p1-plan.json'),false);assert.equal(publicPlanFilename('jz-mock-f-p1-plan.json'),false);
});

test('Python and JavaScript public source boundary agree on exact valid and rejected metadata',()=>{
 const items=[];for(const letter of 'ABCDE')for(const paper of [1,2])items.push(fixture(letter,paper).metadata);
 for(const patch of [{id:'jz-exam-a-p1'},{provider:'official-tmua'},{sourceUrl:'https://jzmaths.com/simulator/jz_exam_a_p1'},{source:'TMUA'},{visibility:'private'},{paper:true},{pairId:'jz-b'},{questionCount:19}])items.push({...fixture().metadata,...patch});
 const code='import sys,json;sys.path.insert(0,"tools");from public_mock_sources import is_public_mock_metadata;print(json.dumps([is_public_mock_metadata(x) for x in json.load(sys.stdin)]))';
 const result=spawnSync('python3',['-c',code],{cwd:root,input:JSON.stringify(items),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),items.map(isPublicMockMetadata));
});
