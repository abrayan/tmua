// These are release checks against the real authored inventory and shipped HTML.
// Unit fixtures live separately in content-audit and reviewed-editions tests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {validateContentAudit} from '../tools/validate-content-audit.mjs';
import {validateFollowupAudit} from '../tools/validate-followup-audit.mjs';
import {validateEditionSources,gitReader} from '../tools/validate-edition-sources.mjs';

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

test('every latest edition reproduces its immutable reviewed sources while earlier releases remain unchanged',async()=>{
  const options=process.env.TMUA_QA_BASELINE_ROOT?{priorRead:gitReader(process.env.TMUA_QA_BASELINE_ROOT)}:{};
  const result=await validateEditionSources(root,options);
  assert.ok(result.latest>=10);
  assert.ok(result.snapshots>=result.latest);
});
