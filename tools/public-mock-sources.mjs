// Only freely published Mock A–E originals cross this public identity boundary.
// Purchased Exam Sets use the separate private compiler and access controls.
export const publicMockProvider='jzmaths-mock';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sourcePattern=/^JZ-MOCK-([A-E])-P([12])-Q(0[1-9]|1[0-9]|20)$/;
const paperPattern=/^jz-mock-([a-e])-p([12])$/;
const fail=message=>{throw Error(`Public JZ mock: ${message}`);};
export const publicMockUrl=(letter,paper)=>`https://jzmaths.com/papers/jz_mocks/jz_mock_${letter.toLowerCase()}_p${paper}_question.pdf`;
const attributed=(text,letter)=>typeof text==='string'&&/\bJZ(?:\s*Maths)?\b/i.test(text)&&new RegExp('\\bMock[\\s·–—-]+'+letter+'\\b','i').test(text);
export function publicMockMarked(value){return object(value)&&(value.provider===publicMockProvider||typeof value.sourceId==='string'&&value.sourceId.startsWith('JZ-MOCK-')||typeof value.id==='string'&&/^jz-mock-[^-]+-p[0-9]+$/.test(value.id));}
export function isPublicMockMetadata(metadata){
  const match=object(metadata)&&typeof metadata.id==='string'&&metadata.id.match(paperPattern);
  return Boolean(match&&metadata.provider===publicMockProvider&&metadata.visibility==='public'&&metadata.paper===Number(match[2])&&metadata.pairId===`jz-${match[1]}`&&metadata.sourceUrl===publicMockUrl(match[1],match[2])&&attributed(metadata.source,match[1])&&metadata.practicePolicy==='after-miss-up-to-3'&&metadata.questionCount===20);
}
export function isPublicMockQuestion(question,metadata){
  const match=object(question)&&typeof question.sourceId==='string'&&question.sourceId.match(sourcePattern);
  return Boolean(match&&question.provider===publicMockProvider&&(question.visibility===undefined||question.visibility==='public')&&question.sourceUrl===publicMockUrl(match[1],match[2])&&attributed(question.source,match[1])&&(metadata===undefined||isPublicMockMetadata(metadata)&&metadata.id===`jz-mock-${match[1].toLowerCase()}-p${match[2]}`));
}
export function assertPublicMockRecord(question){if(publicMockMarked(question)&&!isPublicMockQuestion(question))fail('question needs exact Mock A–E provider, source identity, public PDF URL and attribution.');}
export function assertPublicMockMetadata(metadata){if(publicMockMarked(metadata)&&!isPublicMockMetadata(metadata))fail('metadata needs exact public Mock A–E paper, pair, provider, PDF URL and attribution.');}
function markedDocument(metadata,originals){return publicMockMarked(metadata)||originals.some(publicMockMarked);}
export function assertPublicMockOriginals(metadata,originals){
  if(!markedDocument(metadata,originals))return;
  if(!isPublicMockMetadata(metadata)||originals.length!==20||originals.some(q=>!isPublicMockQuestion(q,metadata)))fail('assessment needs twenty exact public Mock originals matching its metadata.');
  const match=metadata.id.match(paperPattern);
  const expected=Array.from({length:20},(_,i)=>`JZ-MOCK-${match[1].toUpperCase()}-P${match[2]}-Q${String(i+1).padStart(2,'0')}`);
  if(originals.some((q,i)=>q.sourceId!==expected[i]))fail('originals must be Q01–Q20 in source order.');
}
export function assertNoPublicMockFollowups(exercises){if(exercises.some(publicMockMarked))fail('public Mock questions are assessment originals, not follow-up candidates.');}
export function assertPublicMockPaper(data){
  if(!object(data)||!Array.isArray(data.questions))return;
  const originals=data.questions.map(group=>group?.original);
  assertPublicMockOriginals(data.metadata,originals);
  for(const group of data.questions)assertNoPublicMockFollowups([...(group?.similar||[]),...(group?.legacySimilar||[])]);
}
export function assertPublicMockPlan(plan,questions){
  if(!object(plan)||!Array.isArray(plan.groups))return;
  assertPublicMockOriginals(plan.metadata,plan.groups.map(group=>questions[group.originalId]));
  for(const group of plan.groups)assertNoPublicMockFollowups([...(group.candidates||[]),...(group.legacyCandidates||[])].map(id=>questions[id]));
}
export const publicPlanFilename=name=>/^(?:tmua-.+|jz-mock-[a-e]-p[12])-plan\.json$/.test(name);
