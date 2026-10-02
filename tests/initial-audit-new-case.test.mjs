import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {parseSource,sha256File,writeJson,writeJsonLines} from '../scripts/lib.mjs';
import {sha256Value} from '../scripts/review-contract.mjs';
import {captureInitialAuditInput} from '../scripts/initial-audit-input.mjs';
import {seedInitialAuditRepairBaseline} from '../scripts/evidence-diff.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quickread-new-audit-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'input'));
  const sourcePath=path.join(dir,'input/source.srt');
  await fs.writeFile(sourcePath,'1\n00:00:00,000 --> 00:00:02,000\nA supported source statement.\n','utf8');
  const normalized=await parseSource(sourcePath,'srt');
  const manifest={id:path.basename(dir),source:{path:'input/source.srt',format:'srt',sha256:await sha256File(sourcePath)}};
  const segments=[{id:'S0001',caseId:manifest.id,sourceIds:[normalized[0].id],text:normalized[0].text}];
  const claims=[{id:'E0001',caseId:manifest.id,statement:'Too broad source statement.',provenance:'speaker_view',importance:'high',claimRole:'position',themeId:'T01',speaker:'Guest',speakerConfidence:1,supportSpans:[{segmentId:'S0001',sourceIds:[normalized[0].id],quote:normalized[0].text}]}];
  const inputHashes={segments:sha256Value(segments),evidence:sha256Value(claims)};
  const primary={caseId:manifest.id,reviewerId:'independent',inputHashes};
  const resolution={caseId:manifest.id,status:'repair_required',contractErrors:[],inputHashes:{...inputHashes,primaryClaimReview:sha256Value(primary)}};
  const packet={caseId:manifest.id,assignedReviewerId:primary.reviewerId,inputHashes,payload:{claims:claims.map(c=>({...c,supportSpans:c.supportSpans.map(s=>({...s,sourceUnits:normalized}))}))}};
  await writeJson(path.join(dir,'case.json'),manifest);
  await writeJsonLines(path.join(dir,'work/source.normalized.jsonl'),normalized);
  await writeJsonLines(path.join(dir,'work/segments.jsonl'),segments);
  await writeJsonLines(path.join(dir,'work/evidence.jsonl'),claims);
  await writeJson(path.join(dir,'work/claim-review.json'),primary);
  await writeJson(path.join(dir,'work/claim-review-resolution.json'),resolution);
  const packetPath=path.join(dir,'work/reviews/2.4.2/preflight/round-01/claims/packets/claim_auditor.json');
  await writeJson(packetPath,packet);
  return {dir,claims,normalized,segments,packet,packetPath,resolution};
}
test('new case first repair freezes authentic inputs, is idempotent, and seeds only a delta',async t=>{
  const f=await fixture(t);
  const proof=await captureInitialAuditInput(f.dir);
  assert.deepEqual(await captureInitialAuditInput(f.dir),proof);
  assert.equal(proof.purpose,'initial_full_audit_pre_repair_not_approval');
  const edited=structuredClone(f.claims);edited[0].statement='A supported source statement.';
  await writeJsonLines(path.join(f.dir,'work/evidence.jsonl'),edited);
  await writeJson(path.join(f.dir,'work/reviews/2.4.2/repairs/round-01/claim-repair-log.json'),{
    authority:'repair_only_no_approval',role:'evidence_repair_editor',
    sourceClaimResolution:{status:'repair_required',inputEvidenceHash:sha256Value(f.claims)},
    inputHashes:{evidence:sha256Value(f.claims)},outputHashes:{evidence:sha256Value(edited)},
    affectedEvidenceRefs:['E0001'],changes:[{evidenceRef:'E0001',action:'replace_statement'}],unresolved:[]
  });
  const seeded=await seedInitialAuditRepairBaseline(f.dir);
  assert.equal(seeded.baseline.acceptance,'initial_full_audit_pre_repair');
  assert.equal(seeded.changeSet.mode,'semantic_delta');
  assert.deepEqual(seeded.changeSet.changes.modifiedRefs,['E0001']);
  assert.equal(seeded.changeSet.requiredReviews.fullClaimAudit,false);
  await assert.rejects(fs.stat(path.join(f.dir,'work/migration-v2.4.json')),/ENOENT/);
});
test('new-case capture rejects evidence already changed before the snapshot',async t=>{
  const f=await fixture(t);f.claims[0].statement='Changed';
  await writeJsonLines(path.join(f.dir,'work/evidence.jsonl'),f.claims);
  await assert.rejects(captureInitialAuditInput(f.dir),/偏离首次审核/);
});
test('new-case capture rejects altered normalized text and altered packet source',async t=>{
  const f=await fixture(t);
  const altered=structuredClone(f.normalized);altered[0].text='Invented source';
  await writeJsonLines(path.join(f.dir,'work/source.normalized.jsonl'),altered);
  await assert.rejects(captureInitialAuditInput(f.dir),/重新解析/);
  await writeJsonLines(path.join(f.dir,'work/source.normalized.jsonl'),f.normalized);
  f.packet.payload.claims[0].supportSpans[0].sourceUnits=altered;
  await writeJson(f.packetPath,f.packet);
  await assert.rejects(captureInitialAuditInput(f.dir),/引用原文/);
});
