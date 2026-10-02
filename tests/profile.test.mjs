import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {profileCase} from '../scripts/profile-case.mjs';

test('fresh QR-0001 has no inherited profile and semantic scores remain hash-bound and threshold-gated',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'quickread-profile-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const dir=path.join(temp,'qr-0001-fixture');
  await fs.mkdir(path.join(dir,'input'),{recursive:true});await fs.mkdir(path.join(dir,'work'));
  const text='今天记录一则日常见闻。'; const sourceSha256=crypto.createHash('sha256').update(text).digest('hex');
  await fs.writeFile(path.join(dir,'input/source.txt'),text);
  await fs.writeFile(path.join(dir,'case.json'),JSON.stringify({id:path.basename(dir),caseNumber:'QR-0001',title:'记录',tags:[],source:{path:'input/source.txt',sha256:sourceSha256}}));
  await fs.writeFile(path.join(dir,'work/source.normalized.jsonl'),JSON.stringify({id:'P000001',text})+'\n');
  const pending=await profileCase(dir);assert.equal(pending.selection,'pending');assert.equal(pending.requiresConfirmation,true);
  const assessmentPath=path.join(dir,'work/assessment.json');
  const assessment={assessedBy:'fixture-reviewer',sourceSha256,rationale:'Synthetic structured fixture',scores:{knowledge:.9,strategy:.2,narrative:.3,debate:.1,general:.2}};
  await fs.writeFile(assessmentPath,JSON.stringify(assessment));
  const auto=await profileCase(dir,{assessmentPath:'work/assessment.json'});assert.equal(auto.selection,'auto');assert.equal(auto.selectedProfile,'knowledge');
  assessment.scores.strategy=.85;await fs.writeFile(assessmentPath,JSON.stringify(assessment));
  assert.equal((await profileCase(dir,{assessmentPath})).requiresConfirmation,true);
  assessment.sourceSha256='0'.repeat(64);await fs.writeFile(assessmentPath,JSON.stringify(assessment));
  await assert.rejects(profileCase(dir,{assessmentPath}),/哈希/u);
});
