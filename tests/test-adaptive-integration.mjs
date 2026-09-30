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
        classList:{toggle(name,on) {if(on)classes.add(name);else classes.delete(name);},contains(name) {return classes.has(name);}},
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

async function library({entry=paper,saved={}}={}) {
  const {document,node,nodes}=dom(), events=new Map(), replies=[], writes=[];
  const storage=new Map([['tmua-practice-library-v1:/tmua/',JSON.stringify(saved)]]);
  const frame=node('paper-frame');
  frame.contentWindow={postMessage(message) {replies.push(JSON.parse(JSON.stringify(message)));}};
  const window={location:new URL(`https://example.test/tmua/index.html#paper/${entry.id}`),scrollTo(){},addEventListener(name,fn){events.set(name,fn);}};
  vm.runInNewContext(appSource,{document,window,URL,Date,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},localStorage:{getItem(key){return storage.get(key)||null;},setItem(key,value){storage.set(key,value);writes.push(JSON.parse(value));}},fetch:async()=>({ok:true,json:async()=>({papers:[entry]})})});
  await new Promise(resolve=>setImmediate(resolve));
  function message(data,source=frame.contentWindow){events.get('message')({source,data:{paperId:entry.id,...data}});}
  return {node,nodes,writes,replies,window,message,storage,hashchange(){events.get('hashchange')();}};
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
  const opener=ui.node('palette-review');opener.focus();opener.trigger('click');
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
