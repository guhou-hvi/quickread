import fs from 'node:fs/promises';
import path from 'node:path';
import { isMain, loadCase, parseSource, readJson, readJsonLines, resolveCaseDir, sha256File, writeJson } from './lib.mjs';
import { sha256Value } from './review-contract.mjs';

// A new case has no legacy migration archive. Freeze its still-unmodified,
// reviewed inputs before the first targeted repair; this is NOT an approval.
export async function captureInitialAuditInput(caseDir) {
  const target=path.join(caseDir,'work/initial-audit-input.json');
  const {manifest,sourcePath}=await loadCase(caseDir);
  const [normalized,segments,claims,primary,resolution]=await Promise.all([
    readJsonLines(path.join(caseDir,'work/source.normalized.jsonl')),
    readJsonLines(path.join(caseDir,'work/segments.jsonl')),
    readJsonLines(path.join(caseDir,'work/evidence.jsonl')),
    readJson(path.join(caseDir,'work/claim-review.json')),
    readJson(path.join(caseDir,'work/claim-review-resolution.json')),
  ]);
  if(resolution.caseId!==manifest.id || resolution.status!=='repair_required')throw new Error('需要本案已完成且明确要求修复的 Claim Gate。');
  if(resolution.contractErrors?.length)throw new Error('Claim Gate 存在合同错误。');
  if(resolution.inputHashes.primaryClaimReview!==sha256Value(primary))throw new Error('Claim Gate 与原审核报告不匹配。');
  for(const [key,value] of Object.entries({segments,evidence:claims})){
    if(resolution.inputHashes[key]!==sha256Value(value)||primary.inputHashes[key]!==sha256Value(value))throw new Error(`${key} 已偏离首次审核；不能追认输入。`);
  }
  if(manifest.speakerMap!=null)throw new Error('无旧快照的新案不能追认 speakerMap；需已有绑定。');
  if(await sha256File(sourcePath)!==manifest.source.sha256)throw new Error('原始字幕哈希不一致。');
  if(sha256Value(await parseSource(sourcePath,manifest.source.format))!==sha256Value(normalized))throw new Error('规范化来源与只读原件重新解析结果不一致。');
  const root=path.join(caseDir,'work/reviews');
  const files=await fs.readdir(root,{recursive:true});
  const sourceById=new Map(normalized.map(x=>[x.id,x]));
  const packets=[];
  for(const file of files){
    if(path.basename(file)!=='claim_auditor.json'||path.basename(path.dirname(file))!=='packets'||!file.split(path.sep).includes('preflight'))continue;
    const packet=await readJson(path.join(root,file));
    if(packet.caseId!==manifest.id||packet.assignedReviewerId!==primary.reviewerId||packet.inputHashes.evidence!==sha256Value(claims)||packet.inputHashes.segments!==sha256Value(segments))continue;
    const expected=claims.map(claim=>({...claim,supportSpans:claim.supportSpans.map(span=>({...span,sourceUnits:span.sourceIds.map(id=>sourceById.get(id))}))}));
    if(sha256Value(packet.payload.claims)!==sha256Value(expected))throw new Error('隔离 packet 的引用原文与当前原件不一致。');
    packets.push({path:path.relative(caseDir,path.join(root,file)).split(path.sep).join('/'),hash:sha256Value(packet)});
  }
  if(!packets.length)throw new Error('找不到绑定首次审核及原始支持区段的 packet。');
  const snapshot={schemaVersion:'1.0.0',caseId:manifest.id,purpose:'initial_full_audit_pre_repair_not_approval',
    evidenceHash:sha256Value(claims),primaryReviewHash:sha256Value(primary),resolutionHash:sha256Value(resolution),
    speakerMapHash:sha256Value(manifest.speakerMap??null),packets,
    snapshotHashes:{source:await sha256File(sourcePath),normalizedSource:await sha256File(path.join(caseDir,'work/source.normalized.jsonl')),segments:await sha256File(path.join(caseDir,'work/segments.jsonl'))}};
  try{const old=await readJson(target);if(sha256Value(old)!==sha256Value(snapshot))throw new Error('已存在不同的首次审核输入快照，不覆盖。');return old;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await writeJson(target,snapshot);
  return snapshot;
}
if(isMain(import.meta.url))captureInitialAuditInput(resolveCaseDir(process.argv[2])).then(()=>console.log('已冻结首次审核的修复前输入；未接受基线、未批准内容。')).catch(error=>{console.error(error.message);process.exitCode=1;});
