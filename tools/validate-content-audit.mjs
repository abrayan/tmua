import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const siteRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const nonempty=value=>typeof value==='string' && Boolean(value.trim());
const substantive=(value,length=40,words=5)=>nonempty(value) && value.trim().length>=length && value.trim().split(/\s+/).length>=words;
const fail=message=>{throw Error(`Content audit: ${message}`);};
const readJson=async(root,name)=>JSON.parse(await readFile(path.join(root,name),'utf8'));
const safeUrl=value=>{try{const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password;}catch{return false;}};
const validOption=value=>nonempty(value)||(typeof value==='number'&&Number.isFinite(value))||(object(value)&&nonempty(value.html)&&nonempty(value.text));
const sameIds=(a,b)=>Array.isArray(a) && Array.isArray(b) && a.length===b.length && [...a].sort().every((id,index)=>id===[...b].sort()[index]);
export function canonicalJson(value){
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
  if(value===undefined)throw Error('Audit fingerprints cannot contain undefined values.');
  return JSON.stringify(value);
}
const fingerprint=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const teachingTags=new Set('h1 h2 h3 h4 h5 h6 p div span a img br strong b em i small ul ol li table thead tbody tr th td blockquote code pre sub sup figure figcaption svg path circle g text line rect polygon polyline ellipse math mrow mi mn mo mtext mspace msup msub msubsup mfrac msqrt mroot mfenced mover munder munderover mtable mtr mtd menclose mstyle mpadded mphantom mmultiscripts mprescripts none'.split(' '));
export function validateTeachingMarkup(value,label='teaching'){
  if(Array.isArray(value)){value.forEach((item,index)=>validateTeachingMarkup(item,`${label}[${index}]`));return;}
  if(object(value)){for(const [key,item] of Object.entries(value))validateTeachingMarkup(item,`${label}.${key}`);return;}
  if(typeof value!=='string')return;
  // A raw comparison such as x<y is parsed as an HTML element and can silently
  // swallow the remainder of a hint. Mathematical comparisons use MathML or
  // escaped entities; all actual authored HTML/SVG/MathML tags are explicit.
  for(const match of value.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/g)){
    const end=value.indexOf('>',match.index), next=value.indexOf('<',match.index+1);
    const attributes=end<0?'':value.slice(match.index+match[0].length,end);
    if(!teachingTags.has(match[1])||end<0||(next>=0&&next<end)||! /^(?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?$/.test(attributes))
      fail(`${label} has an unknown HTML tag or unescaped comparison <${match[1]}; typeset or escape the inequality.`);
  }
}
export function questionFingerprint(question){
  // Exact semantic teaching fields; preserve every array's authored order.
  return fingerprint(Object.fromEntries(['sourceId','lead','options','correct','hints','solution','conceptIds'].map(key=>[key,question[key]??null])));
}
export function conceptFingerprint(concept){
  // Math is generated presentation metadata. All authored fields and references
  // are fingerprinted, so wording/example changes require a renewed review.
  return fingerprint(Object.fromEntries(Object.entries(concept).filter(([key])=>key!=='math')));
}
export const expectedSyllabusCodes=Object.freeze([
  ...[7,4,3,6,3,3,6,7].flatMap((count,section)=>Array.from({length:count},(_,i)=>`MM${section+1}.${i+1}`)),
  ...[2,14,11,19,19,4,7].flatMap((count,section)=>Array.from({length:count},(_,i)=>`M${section+1}.${i+1}`)),
  ...Array.from({length:4},(_,i)=>`Arg${i+1}`),...Array.from({length:5},(_,i)=>`Prf${i+1}`),...Array.from({length:2},(_,i)=>`Err${i+1}`)
]);

export async function collectAuditQuestions(root=siteRoot,{previewConceptIds}={}){
  const bank=await readJson(root,'content/official-question-bank.json');
  if(bank.version!==1 || !object(bank.questions))fail('invalid question bank.');
  const questions=Object.entries(bank.questions).map(([id,question])=>{
    if(!object(question)||question.sourceId!==id)fail(`bank key ${id} disagrees with sourceId.`);
    return question;
  });
  const preview=await readJson(root,'content/jz-mock-d-p1-preview.json');
  if(!Array.isArray(preview.questions))fail('invalid preview questions.');
  let mappings=previewConceptIds;
  if(!mappings){
    try{const audit=await readJson(root,'content/question-audits.json');mappings=Object.fromEntries((audit.reviews||[]).map(row=>[row.sourceId,row.conceptIds]));}
    catch(error){if(error.code!=='ENOENT')throw error;mappings={};}
  }
  for(const group of preview.questions){
    if(!object(group)||!/^q[1-9]\d*$/.test(group.id)||!object(group.original)||!Array.isArray(group.similar))fail('invalid preview group.');
    for(const [suffix,exercise] of [['original',group.original],...group.similar.map((item,index)=>[`similar${index+1}`,item])]){
      if(!object(exercise))fail(`invalid preview exercise ${group.id}-${suffix}.`);
      const sourceId=`preview-${group.id}-${suffix}`;
      // The preview keeps its displayed question in several fields. Include all
      // of them in normalized lead so a formula-only edit also stales its audit.
      const lead=Object.fromEntries(['lead','tail','latex','fallback','formulaLabel'].map(key=>[key,exercise[key]??'']));
      questions.push({...exercise,sourceId,lead,conceptIds:exercise.conceptIds??mappings[sourceId]});
    }
  }
  return questions;
}

function uniqueRows(rows,key,label){
  if(!Array.isArray(rows))fail(`${label} must be an array.`);
  const found=new Map();
  for(const row of rows){if(!object(row)||!nonempty(row[key])||found.has(row[key]))fail(`${label} has a malformed or duplicate ${key}.`);found.set(row[key],row);}
  return found;
}
function requireConceptIds(ids,known,label){
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!known.has(id))||new Set(ids).size!==ids.length)fail(`${label} has empty, duplicate or unknown conceptIds.`);
}
function requireReviews(audit,key,expected,label){
  if(!object(audit)||audit.version!==1)fail(`${label} needs version 1.`);
  const reviews=uniqueRows(audit.reviews,key,label);
  for(const id of expected.keys())if(!reviews.has(id))fail(`${label} is missing ${id}.`);
  for(const id of reviews.keys())if(!expected.has(id))fail(`${label} contains unexpected ${id}.`);
  return reviews;
}
export function validateAuditData({questions,catalogue,questionAudits,conceptAudits,coverage,conceptMap,studiedLessons},options={}){
  const counts={bank:280,preview:6,lessons:84,additional:23,...options.counts};
  if(!object(catalogue)||catalogue.version!==1||!Array.isArray(catalogue.lessons)||!Array.isArray(catalogue.additionalConcepts))fail('invalid concept catalogue.');
  if(catalogue.lessons.length!==counts.lessons||catalogue.additionalConcepts.length<counts.additional)fail(`expected ${counts.lessons} original booklet lessons and at least ${counts.additional} additional concepts.`);
  const concepts=uniqueRows([...catalogue.lessons,...catalogue.additionalConcepts],'id','concept catalogue');
  const known=new Set(concepts.keys());
  for(const concept of concepts.values()){
    if(!/^p[12]-(?:b\d+-l\d+|extra-[a-z0-9-]+)$/.test(concept.id)||![1,2].includes(concept.paper)||!concept.id.startsWith(`p${concept.paper}-`)||!nonempty(concept.title)
      ||!Array.isArray(concept.knowledge)||!concept.knowledge.length||concept.knowledge.some(item=>!nonempty(item)))fail(`malformed concept ${concept.id}.`);
    if(concept.syllabusCodes!==undefined && (!Array.isArray(concept.syllabusCodes)||concept.syllabusCodes.some(code=>!expectedSyllabusCodes.includes(code))))fail(`${concept.id} has unknown syllabus codes.`);
  }
  for(const concept of catalogue.additionalConcepts){
    if(!Array.isArray(concept.references)||!concept.references.length||concept.references.some(ref=>!object(ref)||!['syllabus','question'].includes(ref.type)||!nonempty(ref.label)||!safeUrl(ref.url)))fail(`${concept.id} needs valid source references.`);
    if(!object(concept.example)||!nonempty(concept.example.question)||!Array.isArray(concept.example.steps)||!concept.example.steps.length||concept.example.steps.some(step=>!nonempty(step))||!nonempty(concept.example.answer)||!nonempty(concept.pitfall))fail(`${concept.id} needs reviewed learning details.`);
  }
  if(studiedLessons!==undefined){
    if(studiedLessons.version!==1||!Array.isArray(studiedLessons.booklets))fail('invalid studied-booklet reference catalogue.');
    const expected=studiedLessons.booklets.flatMap(booklet=>booklet.lessons.map(lesson=>({id:lesson.id,paper:booklet.paper,booklet:booklet.booklet,bookletTitle:booklet.bookletTitle,lesson:lesson.number,title:lesson.title,pdfPage:lesson.pdfPage,printedPage:lesson.printedPage||lesson.pdfPage,knowledge:lesson.knowledge})));
    if(canonicalJson(expected)!==canonicalJson(catalogue.lessons))fail('booklet lesson IDs, references or knowledge disagree with the studied source.');
  }
  const questionMap=uniqueRows(questions,'sourceId','audit questions');
  const previews=questions.filter(question=>question.sourceId.startsWith('preview-'));
  if(previews.length<counts.preview||questions.length-previews.length<counts.bank)fail(`expected at least ${counts.bank} bank questions and ${counts.preview} preview exercises.`);
  for(const question of questions){
    const id=question.sourceId;
    validateTeachingMarkup({hints:question.hints,solution:question.solution,options:question.options},id);
    if(!(nonempty(question.lead)||(id.startsWith('preview-')&&object(question.lead)&&nonempty(question.lead.lead)))||!Array.isArray(question.options)||question.options.length<2||question.options.length>10
      ||question.options.some(option=>!validOption(option))||!/^([A-J])$/.test(question.correct)||question.correct.charCodeAt(0)-65>=question.options.length||!nonempty(question.solution))fail(`malformed question or answer ${id}.`);
    requireConceptIds(question.conceptIds,known,`question ${id}`);
    if(!Array.isArray(question.hints)||!question.hints.length||question.hints.length>8)fail(`malformed hints for ${id}.`);
    for(const hint of question.hints){
      if(!object(hint)||['title','body','recap','pitfall','pause'].some(key=>!nonempty(hint[key]))||!Array.isArray(hint.recall)||!hint.recall.length)fail(`malformed hint in ${id}.`);
      for(const recall of hint.recall)if(!object(recall)||!known.has(recall.lessonId)||!nonempty(recall.reminder))fail(`unknown or malformed hint concept in ${id}.`);
    }
  }
  const reviewedQuestions=requireReviews(questionAudits,'sourceId',questionMap,'question reviews');
  for(const [id,question] of questionMap){
    const review=reviewedQuestions.get(id);
    if(review.verifiedAnswer!==question.correct)fail(`verified answer disagrees for ${id}.`);
    if(!substantive(review.verification)||!substantive(review.remainingWork,20,3)||!substantive(review.hintVerdict,12,2)||!substantive(review.conceptReason,20,3))fail(`review of ${id} needs substantive verification, hint verdict, remaining work and concept reasoning.`);
    if(!Array.isArray(review.issues)||review.issues.some(issue=>!nonempty(issue)))fail(`review of ${id} has malformed issues.`);
    if(review.workedSolutionUrl!==undefined&&!safeUrl(review.workedSolutionUrl))fail(`review of ${id} has an unsafe worked solution URL.`);
    requireConceptIds(review.conceptIds,known,`review ${id}`);
    if(!sameIds(review.conceptIds,question.conceptIds))fail(`review conceptIds disagree with question ${id}.`);
    if(review.contentHash!==questionFingerprint(question))fail(`question review is stale for ${id}.`);
  }
  const reviewedConcepts=requireReviews(conceptAudits,'conceptId',concepts,'concept reviews');
  for(const [id,concept] of concepts){const review=reviewedConcepts.get(id);if(!substantive(review.verification))fail(`concept review ${id} needs substantive verification.`);if(review.contentHash!==conceptFingerprint(concept))fail(`concept review is stale for ${id}.`);}
  if(!object(coverage)||coverage.version!==1)fail('invalid syllabus coverage file.');
  const clauses=uniqueRows(coverage.clauses,'code','syllabus clauses');
  if(!sameIds([...clauses.keys()],expectedSyllabusCodes))fail('syllabus coverage must contain exactly the 126 expected MM, M, Arg, Prf and Err clauses.');
  for(const [code,clause] of clauses){requireConceptIds(clause.conceptIds,known,`syllabus ${code}`);if(!nonempty(clause.summary))fail(`syllabus ${code} needs a coverage summary.`);}
  if(conceptMap!==undefined){
    if(![1,2].includes(conceptMap.version)||!Array.isArray(conceptMap.papers))fail('invalid public concept map.');
    const papers=new Set();
    for(const paper of conceptMap.papers){
      if(!object(paper)||!nonempty(paper.id)||papers.has(paper.id)||!Array.isArray(paper.questions))fail('duplicate or malformed mapped paper.');papers.add(paper.id);
      const seen=new Set();
      for(const mapped of paper.questions){
        const question=questionMap.get(mapped.sourceId);
        if(!question||seen.has(mapped.sourceId))fail(`unknown or duplicate mapped question in ${paper.id}.`);seen.add(mapped.sourceId);
        requireConceptIds(mapped.lessonIds,known,`public map ${mapped.sourceId}`);
        if(!sameIds(mapped.lessonIds,question.conceptIds))fail(`public concept map disagrees with audited question ${mapped.sourceId}.`);
      }
    }
  }
  return {questions:questionMap.size,concepts:concepts.size,syllabusClauses:clauses.size};
}
export async function validateContentAudit(root=siteRoot){
  const [questions,catalogue,questionAudits,conceptAudits,coverage,conceptMap,studiedLessons]=await Promise.all([
    collectAuditQuestions(root),...['assets/studied-concepts.json','content/question-audits.json','content/concept-audits.json','content/syllabus-coverage.json','assets/concept-map.json','content/studied-lessons.json'].map(name=>readJson(root,name))
  ]);
  return validateAuditData({questions,catalogue,questionAudits,conceptAudits,coverage,conceptMap,studiedLessons});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await validateContentAudit(process.argv[2]?path.resolve(process.argv[2]):siteRoot);console.log(`Content audit gate passed: ${result.questions} question reviews, ${result.concepts} concept reviews, ${result.syllabusClauses} syllabus clauses. This checks review coverage and freshness; mathematical correctness requires human verification.`);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
