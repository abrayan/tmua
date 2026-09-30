// These are release checks against the real authored inventory and shipped HTML.
// Unit fixtures live separately in content-audit and reviewed-editions tests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {validateContentAudit} from '../tools/validate-content-audit.mjs';
import {validateFollowupAudit} from '../tools/validate-followup-audit.mjs';
import {prepareReviewedEditions} from '../tools/build-reviewed-editions.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('the complete authored question and concept inventory has fresh reviews and full syllabus coverage',async()=>{
  const result=await validateContentAudit(root);
  assert.ok(result.questions>=286);
  assert.ok(result.concepts>=107);
  assert.equal(result.syllabusClauses,126);
});

test('every currently selected follow-up has a fresh independent match review',async()=>{
  const result=await validateFollowupAudit(root);
  assert.ok(result.papers>=10);
  assert.ok(result.groups>=200);
});

test('every current shipped teaching edition exactly matches reviewed sources and plans while preserving originals',async()=>{
  const prepared=await prepareReviewedEditions(root);
  const manifest=JSON.parse(await readFile(path.join(root,'content/paper-editions.json'),'utf8'));
  const latest=new Map(manifest.editions.map(entry=>[entry.paperId,entry]));
  for(const expected of prepared.entries){
    const actual=latest.get(expected.paperId);
    assert.ok(actual,`${expected.paperId} needs a reviewed teaching edition.`);
    assert.equal(actual.sha256,expected.sha256,`${expected.paperId}: current reviewed teaching or follow-up plans changed; publish a new immutable edition.`);
    const bytes=await readFile(path.join(root,actual.href));
    assert.ok(bytes.equals(expected.content),`${expected.paperId}: shipped teaching must match the complete audited source, including all hints, solutions, concepts and legacy exercises.`);
  }
});
