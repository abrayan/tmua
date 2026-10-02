import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {buildSite, parseMetadata} from '../tools/build-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = await readFile(path.join(root, 'assets/app.js'), 'utf8');
const viewSource = await readFile(path.join(root, 'templates/view-modes.js'), 'utf8');
const paper = {format:'tmua-paper-v1',id:'tmua-2020-p2',title:'TMUA 2020 · Paper 2',paper:2,source:'Official TMUA',description:'Test fixture',questionCount:20,version:1,practicePolicy:'after-miss-up-to-3',href:'papers/paper-2/tmua-2020-p2.html'};
const baseProgress = {questionIndex:19,completed:20,total:20,firstCorrect:0,firstAttempted:20,practiceCorrect:0,practiceAttempted:60,finished:true};

function dom() {
  const nodes = new Map(), listeners = new Map();
  let serial = 0;
  const document = {title:'',activeElement:null};
  function node(id = `node-${serial++}`) {
    if (!nodes.has(id)) {
      const events = new Map(), classes = new Set();
      const item = {id,hidden:false,value:'',textContent:'',innerHTML:'',children:[],style:{},dataset:{},open:false,isConnected:true,
        setAttribute(name,value) {this[name]=value;},removeAttribute(name) {delete this[name];},
        append(...children) {this.children.push(...children);},prepend(...children) {this.children.unshift(...children);},replaceChildren(...children) {this.children=children;},
        focus() {document.activeElement=this;},showModal() {this.open=true;},close() {this.open=false;},
        addEventListener(name,fn) {events.set(name,[...(events.get(name)||[]),fn]);},
        trigger(name,event={}) {for(const fn of events.get(name)||[]) fn({target:this,...event});},
        classList:{add(...names) {for(const name of names)classes.add(name);},remove(...names) {for(const name of names)classes.delete(name);},toggle(name,on) {if(on)classes.add(name);else classes.delete(name);},contains(name) {return classes.has(name);}},
        closest() {return null;}
      };
      nodes.set(id,item);
    }
    return nodes.get(id);
  }
  Object.assign(document,{body:node('body'),getElementById:node,createElement:tag=>node(`${tag}-${serial++}`),querySelector:selector=>selector==='main'?node('main'):null,
    addEventListener(name,fn) {listeners.set(name,[...(listeners.get(name)||[]),fn]);},
    dispatchEvent(event) {for(const fn of listeners.get(event.type)||[]) fn(event);}
  });
  return {document,node,nodes};
}

async function library({entry=paper,saved={},blockedWrites=false}={}) {
  const {document,node,nodes}=dom(), events=new Map(), replies=[], writes=[];
  const storage=new Map([['tmua-practice-library-v1:/tmua/',JSON.stringify(saved)]]);
  const frame=node('paper-frame');
  frame.contentWindow={postMessage(message) {replies.push(JSON.parse(JSON.stringify(message)));}};
  const window={location:new URL(`https://example.test/tmua/index.html#paper/${entry.id}`),scrollTo(){},addEventListener(name,fn){events.set(name,fn);}};
  vm.runInNewContext(appSource,{document,window,URL,Date,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},localStorage:{getItem(key){return storage.get(key)||null;},setItem(key,value){if(blockedWrites)throw Error('Storage unavailable');storage.set(key,value);writes.push(JSON.parse(value));}},fetch:async()=>({ok:true,json:async()=>({papers:[entry]})})});
  await new Promise(resolve=>setImmediate(resolve));
  function message(data,source=frame.contentWindow){events.get('message')({source,data:{paperId:entry.id,...data}});}
  return {node,nodes,writes,replies,window,message,storage,document,blockWrites(value){blockedWrites=value;},
    storageEvent(key){events.get('storage')({key});},hashchange(){events.get('hashchange')();}};
}

function view() {
  const {document,node,nodes}=dom(), events=new Map(), messages=[];
  node('tmua-paper-meta').textContent=JSON.stringify(paper);
  const window={parent:{postMessage(message){messages.push(message);}},addEventListener(name,fn){events.set(name,fn);}};
  vm.runInNewContext(viewSource,{document,window,localStorage:{getItem(){return null;}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}}});
  const render=detail=>document.dispatchEvent({type:'tmua-render',detail:{questionIndex:0,total:20,records:Array.from({length:20},(_,i)=>({first:i===0?1:null,completed:i===0})),...detail}});
  const resume=view=>events.get('message')({source:window.parent,data:{type:'tmua-view-resume',paperId:paper.id,view}});
  return {document,node,nodes,window,messages,render,resume};
}

test('adaptive metadata survives static discovery and publication', async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'tmua-policy-build-'));
  try{
    await mkdir(path.join(directory,'papers/paper-2'),{recursive:true});
    await writeFile(path.join(directory,'index.html'),'<!doctype html><title>Test</title>');
    const html=`<!doctype html><script id="tmua-paper-meta" type="application/json">${JSON.stringify(paper)}</script>`;
    assert.equal(parseMetadata(html).practicePolicy,paper.practicePolicy);
    await writeFile(path.join(directory,paper.href),html);
    await buildSite(directory);
    const catalog=JSON.parse(await readFile(path.join(directory,'dist/papers/catalog.json'),'utf8'));
    assert.equal(catalog.papers[0].practicePolicy,paper.practicePolicy);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('parent accepts sixty actual followups for twenty adaptive originals', async()=>{
  const app=await library();
  app.message({type:'tmua-progress',progress:{...baseProgress,practiceCorrect:20},state:{version:1}});
  assert.equal(app.writes.at(-1)[paper.id].progress.practiceAttempted,60);
  assert.equal(app.writes.at(-1)[paper.id].progress.practiceCorrect,20);
});

test('updated paper URLs restore the same saved attempt and leave history untouched', async()=>{
  const saved = {[paper.id]:{version:1,state:{version:1,questionIndex:2},progress:{...baseProgress,finished:false}}};
  const app = await library({entry:{...paper,contentHash:'abcdef1234567890'},saved});
  assert.equal(app.node('paper-frame').src, 'https://example.test/tmua/papers/paper-2/tmua-2020-p2.html?v=abcdef1234567890');
  app.message({type:'tmua-ready'});
  const resume = app.replies.find(message=>message.type==='tmua-resume');
  assert.deepEqual(resume.state, saved[paper.id].state);
  assert.equal(app.writes.length,0);
  const legacy = await library();
  assert.equal(legacy.node('paper-frame').src, 'https://example.test/tmua/papers/paper-2/tmua-2020-p2.html');
});

test('paper cache fingerprints do not relax URL validation', async()=>{
  for (const contentHash of ['../elsewhere','abcdef1234567890&x=1','123',42]) {
    const app = await library({entry:{...paper,contentHash}});
    assert.equal(app.node('paper-frame').src,undefined);
  }
  const app = await library({entry:{...paper,href:paper.href+'?unexpected=1',contentHash:'abcdef1234567890'}});
  assert.equal(app.node('paper-frame').src,undefined);
});

test('refreshing an active paper updates its HTML while resuming the existing attempt', async()=>{
  const entry = {...paper,contentHash:'1111111111111111'};
  const saved = {[paper.id]:{version:1,state:{version:1,questionIndex:4}}};
  const app = await library({entry,saved});
  entry.contentHash = '2222222222222222';
  app.node('refresh-library').trigger('click');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.node('paper-frame').src, 'https://example.test/tmua/papers/paper-2/tmua-2020-p2.html?v=2222222222222222');
  app.message({type:'tmua-ready'});
  assert.deepEqual(app.replies.find(message=>message.type==='tmua-resume').state,saved[paper.id].state);
  assert.equal(app.writes.length,0);
});

test('all originals correct first time can finish without forced followups', async()=>{
  const app=await library();
  app.message({type:'tmua-progress',progress:{...baseProgress,firstCorrect:20,practiceAttempted:0},state:{version:1}});
  assert.equal(app.writes.at(-1)[paper.id].progress.finished,true);
  assert.equal(app.writes.at(-1)[paper.id].progress.practiceAttempted,0);
});

test('ordinary papers can finish after checked originals without inventing similar-question scores', async()=>{
  const entry = {...paper};
  delete entry.practicePolicy;
  const app = await library({entry});
  app.message({type:'tmua-progress',progress:{...baseProgress,firstCorrect:8,practiceAttempted:0,practiceCorrect:0},state:{version:1}});
  assert.equal(app.writes.at(-1)[paper.id].progress.finished,true);
  assert.equal(app.writes.at(-1)[paper.id].progress.firstCorrect,8);
  assert.equal(app.writes.at(-1)[paper.id].progress.practiceAttempted,0);
});

test('parent rejects overflow, inconsistent counts and foreign frames', async()=>{
  const app=await library();
  for(const change of [{practiceAttempted:61},{practiceCorrect:61},{practiceAttempted:1,practiceCorrect:2},{firstAttempted:19},{questionIndex:20}]) app.message({type:'tmua-progress',progress:{...baseProgress,...change},state:{version:1}});
  app.message({type:'tmua-progress',progress:baseProgress,state:{version:1}},{});
  assert.equal(app.writes.length,0);
  const legacy=await library({entry:{...paper,practicePolicy:undefined}});
  legacy.message({type:'tmua-progress',progress:baseProgress,state:{version:1}});
  assert.equal(legacy.writes.length,0,'legacy paper retains its one-followup-per-original bound');
});

test('view and progress messages preserve each other in browser storage', async()=>{
  const app=await library();
  app.message({type:'tmua-view',view:{mode:'pearson',flags:[0,19,20,-1]}});
  app.message({type:'tmua-progress',progress:baseProgress,state:{version:1,marker:'retained'}});
  assert.deepEqual(app.writes.at(-1)[paper.id].view,{mode:'pearson',flags:[0,19]});
  app.message({type:'tmua-view',view:{mode:'normal',flags:[1]}});
  assert.equal(app.writes.at(-1)[paper.id].state.marker,'retained');
  app.message({type:'tmua-ready'});
  assert.equal(app.replies.at(-1).state.summaryVisible,true,'completed-card reopening shows results');
});

test('zero-followup misses are labelled as none attempted, not none needed', async()=>{
  const app=await library({saved:{[paper.id]:{version:1,state:{version:1},progress:{...baseProgress,practiceAttempted:0}}}});
  app.window.location.hash='#library/2';app.hashchange();
  assert.ok([...app.nodes.values()].some(node=>node.textContent==='None attempted'));
});

test('Normal/Pearson view and flags do not mutate exercise state',()=>{
  const ui=view();ui.render();
  ui.node('view-mode').trigger('change',{target:{value:'pearson'}});
  assert.equal(ui.document.body.dataset.view,'pearson');
  ui.node('flag-question').trigger('change',{target:{checked:true}});
  assert.equal(ui.messages.at(-1).type,'tmua-view');
  assert.deepEqual(Array.from(ui.messages.at(-1).view.flags),[0]);
  assert.ok(ui.messages.every(message=>message.type!=='tmua-progress'));
  assert.match(ui.node('palette-buttons').innerHTML,/Question 2, not yet reached/);
});

test('a late view restore cannot overwrite a newly changed flag',()=>{
  const ui=view();ui.render();
  ui.node('flag-question').trigger('change',{target:{checked:true}});
  ui.resume({mode:'normal',flags:[]});
  assert.equal(ui.node('flag-question').checked,true);
});

test('nested review content closes back to the original external control',()=>{
  const ui=view();ui.render();
  const modal=[...ui.nodes.values()].find(node=>node.id==='question-review-dialog');
  modal.classList.add('source-zoom');
  const opener=ui.node('palette-review');opener.focus();opener.trigger('click');
  assert.equal(modal.classList.contains('source-zoom'),false,'ordinary review clears the previous source-zoom presentation');
  const internal=ui.node('temporary-review-button');internal.focus();
  ui.document.dispatchEvent({type:'tmua-review-content',detail:{index:0,source:'TMUA 2020 · Paper 2 · Question 1',questionHTML:'Question',solutionHTML:'Solution',sourceHTML:''}});
  ui.node('close-review').trigger('click');
  assert.equal(ui.document.activeElement,opener);
});

const withAfter = { ...baseProgress, firstCorrect:12, practiceAttempted:8, practiceCorrect:5, attemptId:'attempt-0001',startedAt:'2026-09-30T15:00:00.000Z',afterKnown:true,afterCorrect:18};
test('completion history deduplicates reloads and preserves separate repeat attempts', async()=>{
 const app=await library();
 const send=p=>app.message({type:'tmua-progress',progress:p,state:{version:1,attemptId:p.attemptId}});
 send({...withAfter,finished:false});
 assert.equal(app.storage.has('tmua-attempt-history-v1:/tmua/'),false);
 send(withAfter);send(withAfter);
 let entries=JSON.parse(app.storage.get('tmua-attempt-history-v1:/tmua/')).attempts;
 assert.equal(entries.length,1);assert.equal(entries[0].firstCorrect,12);assert.equal(entries[0].afterCorrect,18);
 send({...withAfter,firstCorrect:13,afterCorrect:19});
 entries=JSON.parse(app.storage.get('tmua-attempt-history-v1:/tmua/')).attempts;
 assert.equal(entries.length,1);assert.equal(entries[0].firstCorrect,12);assert.equal(entries[0].afterCorrect,19);
 send({...withAfter,attemptId:'attempt-0002',firstCorrect:16,afterCorrect:20});
 entries=JSON.parse(app.storage.get('tmua-attempt-history-v1:/tmua/')).attempts;
 assert.equal(entries.length,2);assert.equal(entries[1].attemptContext,'practised');assert.equal(entries[0].afterCorrect,19);
});
test('unknown legacy retry results stay unrecorded and invalid after scores are rejected', async()=>{
 const app=await library();
 for(const change of [{afterCorrect:21},{afterCorrect:11},{afterKnown:false,afterCorrect:12},{attemptId:'bad'},{startedAt:'not-a-date'}]) app.message({type:'tmua-progress',progress:{...withAfter,...change},state:{version:1,attemptId:change.attemptId||withAfter.attemptId}});
 assert.equal(app.writes.length,0);
 app.message({type:'tmua-progress',progress:{...withAfter,afterKnown:false,afterCorrect:null},state:{version:1,attemptId:withAfter.attemptId}});
 const entries=JSON.parse(app.storage.get('tmua-attempt-history-v1:/tmua/')).attempts;
 assert.equal(entries[0].afterCorrect,null);
});

test('cloud-only progress and finished history survive stale storage events until local writes recover',async()=>{
  const app=await library({blockedWrites:true});
  const historyKey='tmua-attempt-history-v1:/tmua/',libraryKey='tmua-practice-library-v1:/tmua/';
  const previous={id:'guided:older-paper:attempt-0000',paperId:'older-paper',title:'Earlier paper',paper:1,total:20,
    firstCorrect:15,afterCorrect:17,completedAt:'2026-09-29T12:00:00Z',source:'guided',attemptContext:'first'};
  const remoteState={version:1,questionIndex:4,marker:'remote-work'};
  const emitted=[];
  app.document.addEventListener('tmua-history-updated',event=>emitted.push(JSON.parse(JSON.stringify(event.detail))));
  app.document.dispatchEvent({type:'tmua-cloud-applied',detail:{payload:{library:{[paper.id]:{version:1,state:remoteState}},
    history:{version:1,attempts:[previous]}},persistence:{library:false,history:false}}});
  app.storage.set(historyKey,JSON.stringify({version:1,attempts:[]}));
  app.storage.set(libraryKey,JSON.stringify({}));
  for(const key of [historyKey,libraryKey,null])app.storageEvent(key);
  app.message({type:'tmua-ready'});
  assert.deepEqual(app.replies.at(-1).state,remoteState);
  app.message({type:'tmua-view',view:{mode:'pearson',flags:[2]}});
  app.storageEvent(libraryKey);
  app.message({type:'tmua-ready'});
  assert.equal(app.replies.at(-1).state.marker,'remote-work','a failed view write also protects memory');
  const send=progress=>app.message({type:'tmua-progress',progress,state:{version:1,attemptId:progress.attemptId}});
  send(withAfter);
  assert.equal(emitted.at(-1).persisted,false);
  assert.deepEqual(emitted.at(-1).attempts[0],previous);
  assert.equal(emitted.at(-1).attempts.length,2);
  app.blockWrites(false);send(withAfter);
  assert.equal(emitted.at(-1).persisted,true);
  assert.equal(JSON.parse(app.storage.get(historyKey)).attempts.length,2);
  const fresh={...previous,id:'guided:another-paper:attempt-0000',paperId:'another-paper'};
  app.storage.set(historyKey,JSON.stringify({version:1,attempts:[...emitted.at(-1).attempts,fresh]}));
  app.storage.set(libraryKey,JSON.stringify({[paper.id]:{version:1,state:{version:1,marker:'fresh-local-work'}}}));
  app.storageEvent(null);
  app.message({type:'tmua-ready'});
  assert.equal(app.replies.at(-1).state.marker,'fresh-local-work','successful local writes restore storage updates');
  send({...withAfter,attemptId:'attempt-0002'});
  assert.equal(JSON.parse(app.storage.get(historyKey)).attempts.length,4,'fresh local history merges after persistence recovers');
});

const historyStorageKey='tmua-attempt-history-v1:/tmua/';
const libraryStorageKey='tmua-practice-library-v1:/tmua/';
const trackedState = (id='attempt-0001') => ({version:1,attemptId:id,startedAt:withAfter.startedAt,
  questionIndex:0,mode:'original',similarIndex:0,piecesShown:0,helpVisible:false,solutionVisible:false,
  selected:null,lastOutcome:null,finished:false,records:Array.from({length:20},()=>({first:null,firstKind:null,
    practice:null,practiceKind:null,everSolved:false,originalReviewed:false,practiceReviewed:false,completed:false,followups:[]}))});
function sendTracked(app,state) {
  const progress={...withAfter,attemptId:state.attemptId,questionIndex:state.questionIndex,
    completed:state.records.filter(record=>record.completed).length,
    firstAttempted:state.records.filter(record=>record.first!==null).length,
    firstCorrect:state.records.reduce((sum,record)=>sum+(record.first||0),0),
    afterCorrect:state.records.filter(record=>record.everSolved).length,practiceCorrect:0,practiceAttempted:0,
    finished:state.finished};
  app.message({type:'tmua-progress',state,progress});
}
const storedAttempt=app=>JSON.parse(app.storage.get(libraryStorageKey))[paper.id];

test('parent records K then L without replacing first answers or changing marks',async()=>{
  const app=await library(),state=trackedState();sendTracked(app,state);
  Object.assign(state,{selected:'K',lastOutcome:'incorrect',solutionVisible:true});
  Object.assign(state.records[0],{first:0,firstKind:'answer',originalReviewed:true});
  sendTracked(app,state);
  Object.assign(state,{selected:null,lastOutcome:null,solutionVisible:false});sendTracked(app,state);
  Object.assign(state,{selected:'L',lastOutcome:'correct',solutionVisible:true});
  Object.assign(state.records[0],{everSolved:true,completed:true});sendTracked(app,state);
  const saved=storedAttempt(app);
  assert.equal(saved.answerLog[0].firstAnswer,'K');assert.equal(saved.answerLog[0].latestAnswer,'L');
  assert.equal(saved.progress.firstCorrect,0);assert.equal(saved.progress.afterCorrect,1);
});

test('parent retains first and latest original choices and the help used before solving',async()=>{
  const app=await library(),state=trackedState();
  sendTracked(app,state);
  Object.assign(state,{selected:'A',lastOutcome:'incorrect',solutionVisible:true});
  Object.assign(state.records[0],{first:0,firstKind:'answer',originalReviewed:true});
  sendTracked(app,state);
  Object.assign(state,{selected:null,lastOutcome:null,solutionVisible:false});
  sendTracked(app,state);
  Object.assign(state,{selected:'B',lastOutcome:'correct',solutionVisible:true});
  Object.assign(state.records[0],{everSolved:true,completed:true});
  sendTracked(app,state);
  let answer=storedAttempt(app).answerLog[0];
  assert.equal(answer.firstAnswer,'A');assert.equal(answer.latestAnswer,'B');
  assert.equal(answer.solutionSeenBeforeSolve,true);assert.equal(answer.solvedWithHints,false);
  Object.assign(state,{questionIndex:1,selected:null,lastOutcome:null,solutionVisible:false});
  sendTracked(app,state);
  Object.assign(state,{piecesShown:2,helpVisible:true});
  Object.assign(state.records[1],{first:0,firstKind:'hint'});
  sendTracked(app,state);
  Object.assign(state,{selected:'C',lastOutcome:'correct',solutionVisible:true,helpVisible:false});
  Object.assign(state.records[1],{everSolved:true,originalReviewed:true,completed:true});
  sendTracked(app,state);
  answer=storedAttempt(app).answerLog[1];
  assert.equal(answer.firstAnswer,null);assert.equal(answer.latestAnswer,'C');
  assert.equal(answer.hintCount,2);assert.equal(answer.helpUsedBeforeSolve,true);
  assert.equal(answer.solutionSeenBeforeSolve,false);assert.equal(answer.solvedWithHints,true);
  Object.assign(state,{questionIndex:2,selected:null,lastOutcome:null,solutionVisible:false,piecesShown:0});
  sendTracked(app,state);
  Object.assign(state,{selected:'D',lastOutcome:'correct',solutionVisible:true});
  Object.assign(state.records[2],{first:1,firstKind:'answer',everSolved:true,originalReviewed:true,completed:true});
  sendTracked(app,state);sendTracked(app,state);
  answer=storedAttempt(app).answerLog[2];
  assert.equal(answer.firstAnswer,'D');assert.equal(answer.assisted,false,'saving the correct-answer recap is not a retry');
  Object.assign(state,{piecesShown:2,helpVisible:true,solutionVisible:false,lastOutcome:null});
  sendTracked(app,state);
  assert.equal(storedAttempt(app).answerLog[2].helpUsedBeforeSolve,false,'later recap cannot reduce independently earned credit');
  for(const record of state.records)Object.assign(record,{first:record.first??1,firstKind:record.firstKind||'answer',everSolved:true,originalReviewed:true,completed:true});
  Object.assign(state,{questionIndex:19,finished:true,selected:null});
  sendTracked(app,state);sendTracked(app,state);
  const history=JSON.parse(app.storage.get(historyStorageKey)).attempts;
  assert.equal(history.length,1);assert.equal(history[0].attemptNumber,1);
  assert.equal(history[0].state.records[0].first,0);assert.equal(history[0].answerLog[0].firstAnswer,'A');
  assert.equal(history[0].answerLog[1].solvedWithHints,true);
});

test('explicit repeat archives unfinished answers, keeps manual records and gives the next active attempt a new number',async()=>{
  const app=await library(),state=trackedState();
  const manual={id:'manual:old',paperId:paper.id,title:paper.title,paper:2,total:20,firstCorrect:8,afterCorrect:12,
    completedAt:'2026-09-01T12:00:00Z',source:'manual',attemptContext:'first'};
  app.storage.set(historyStorageKey,JSON.stringify({version:1,attempts:[manual]}));app.storageEvent(historyStorageKey);
  sendTracked(app,state);
  assert.equal(storedAttempt(app).attemptNumber,undefined,'opening an untouched paper does not consume an attempt number');
  Object.assign(state,{selected:'A',lastOutcome:'incorrect',solutionVisible:true});
  Object.assign(state.records[0],{first:0,firstKind:'answer',originalReviewed:true});
  sendTracked(app,state);
  assert.equal(storedAttempt(app).attemptNumber,2);
  app.window.location.hash='#library/2';app.hashchange();
  const repeat=[...app.nodes.values()].find(node=>node.textContent==='Start another attempt');
  assert.ok(repeat);repeat.trigger('click');
  const entries=JSON.parse(app.storage.get(historyStorageKey)).attempts;
  assert.deepEqual(entries[0],manual,'manual records are retained without mutation');
  assert.equal(entries[1].attemptNumber,2);assert.equal(entries[1].finished,false);assert.equal(entries[1].completedAt,null);
  assert.equal(entries[1].answerLog[0].firstAnswer,'A');
  sendTracked(app,state);
  assert.equal(JSON.parse(app.storage.get(libraryStorageKey))[paper.id],undefined,'queued messages from the retired frame cannot restore the old attempt');
  const next=trackedState('attempt-0002');sendTracked(app,next);
  Object.assign(next,{selected:'B',lastOutcome:'correct',solutionVisible:true});
  Object.assign(next.records[0],{first:1,firstKind:'answer',everSolved:true,originalReviewed:true,completed:true});
  sendTracked(app,next);
  assert.equal(storedAttempt(app).attemptNumber,3);
  assert.deepEqual(JSON.parse(app.storage.get(historyStorageKey)).attempts,entries,'new answers never replace an archived snapshot');
  app.message({type:'tmua-ready'});assert.equal(app.replies.at(-1).state.attemptId,'attempt-0002');
});

test('a rejected restore cannot silently replace unfinished work with a fresh attempt',async()=>{
  const app=await library(),state=trackedState();sendTracked(app,state);
  Object.assign(state,{selected:'A',lastOutcome:'correct',solutionVisible:true});
  Object.assign(state.records[0],{first:1,firstKind:'answer',everSolved:true,originalReviewed:true,completed:true});
  sendTracked(app,state);
  const before=storedAttempt(app);
  sendTracked(app,trackedState('attempt-0002'));
  assert.deepEqual(storedAttempt(app),before);
  assert.match(app.node('storage-note').textContent,/earlier attempt is safe/);
});

test('unchanged published player completes and repeats papers without losing previous answer letters',async()=>{
  const published=await readFile(path.join(root,paper.href),'utf8');
  const frozenPlayer=published.match(/<script>(\(\(\) => \{[\s\S]*?)<\/script>/)[1];
  const app=await library(),ui=dom(),listeners=new Map();
  const question={label:'Fixture question',lead:'Choose B.',options:['A','B'],correct:'B',solution:'The answer is B.',
    hints:[{title:'Fixture hint',body:'Think about B.',recap:'Use B.',pitfall:'Do not choose A.',pause:''}]};
  const data={metadata:{...paper,practicePolicy:undefined},questions:Array.from({length:20},()=>({original:question,similar:[question]}))};
  ui.node('tmua-paper-data').textContent=JSON.stringify(data);
  let selected=null;
  const originalNode=ui.document.getElementById;
  ui.document.getElementById=id=>{
    const node=originalNode(id);node.scrollIntoView=()=>{};
    if(id==='answer-form')node.querySelector=()=>selected ? {value:selected} : null;
    return node;
  };
  const playerWindow={parent:{postMessage(message){app.message(JSON.parse(JSON.stringify(message)));}},
    addEventListener(type,listener){listeners.set(type,listener);},matchMedia(){return {matches:true};}};
  vm.runInNewContext(frozenPlayer,{document:ui.document,window:playerWindow,requestAnimationFrame:fn=>fn(),
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}}});
  listeners.get('message')({source:playerWindow.parent,data:{type:'tmua-resume',paperId:paper.id,state:null}});
  const answer=letter=>{
    selected=letter;ui.node('answer-form').trigger('change',{target:{name:'answer',value:letter}});
    ui.node('answer-form').trigger('submit',{preventDefault(){}});selected=null;
  };
  answer('A');ui.node('redo-button').trigger('click');answer('B');ui.node('next-exercise-button').trigger('click');
  for(let i=1;i<20;i++){answer('B');ui.node('next-exercise-button').trigger('click');}
  let history=JSON.parse(app.storage.get(historyStorageKey)).attempts;
  assert.equal(history.length,1);assert.equal(history[0].firstCorrect,19);assert.equal(history[0].afterCorrect,20);
  assert.equal(history[0].answerLog[0].firstAnswer,'A');assert.equal(history[0].answerLog[0].latestAnswer,'B');
  const first=structuredClone(history[0]);
  ui.node('start-new-attempt').trigger('click');
  for(let i=0;i<20;i++){answer('A');ui.node('next-exercise-button').trigger('click');}
  history=JSON.parse(app.storage.get(historyStorageKey)).attempts;
  assert.equal(history.length,2);assert.deepEqual(history[0],first);
  assert.deepEqual(history.map(attempt=>attempt.attemptNumber),[1,2]);
  assert.equal(history[1].firstCorrect,0);assert.equal(history[1].answerLog[0].firstAnswer,'A');
  assert.notEqual(history[0].state.attemptId,history[1].state.attemptId);
});
