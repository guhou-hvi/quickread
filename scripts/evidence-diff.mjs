import fs from "node:fs/promises";
import path from "node:path";

import {
  isMain,
  loadCase,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
  writeJson,
  writeJsonLines,
} from "./lib.mjs";
import { readerLeafIndex, sha256Value } from "./review-contract.mjs";
import { validateClaimOrganizationWarningResolution } from "./claim-gate.mjs";

export const EVIDENCE_BASELINE_VERSION = "1.0.0";
export const EVIDENCE_CHANGE_SET_VERSION = "1.0.0";
export const INCREMENTAL_REVIEW_POLICY_VERSION = "2.4.0";

const INITIAL_AUDIT_REPAIR_ACCEPTANCE = "initial_full_audit_pre_repair";

function sortedUnique(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

export function repairLineageEntries(repairLog) {
  const records = Array.isArray(repairLog?.issues) && repairLog.issues.length
    ? repairLog.issues
    : (repairLog?.changes ?? []);
  return records.map((record) => {
    const oldEvidenceRefs = sortedUnique(record.oldEvidenceRefs ?? [record.evidenceRef]);
    const explicitNewRefs = record.newEvidenceRefs ?? record.replacementEvidenceRefs;
    const newEvidenceRefs = sortedUnique(
      explicitNewRefs === undefined
        ? (record.action === "remove" ? [] : oldEvidenceRefs)
        : explicitNewRefs,
    );
    return {
      oldEvidenceRefs,
      newEvidenceRefs,
      action: record.action ?? record.verdict ?? "repair",
    };
  }).filter((entry) => entry.oldEvidenceRefs.length > 0);
}

async function optionalJson(filePath, fallback = null) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function optionalJsonLines(filePath, fallback = []) {
  try {
    return await readJsonLines(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function claimSemanticValue(claim) {
  return {
    statement: claim.statement,
    provenance: claim.provenance,
    importance: claim.importance,
    claimRole: claim.claimRole,
    speaker: claim.speaker,
    speakerConfidence: claim.speakerConfidence,
    themeId: claim.themeId,
    uncertainty: claim.uncertainty,
  };
}

export function claimSupportValue(claim) {
  return (claim.supportSpans ?? []).map((span) => ({
    segmentId: span.segmentId,
    sourceIds: sortedUnique(span.sourceIds),
  })).sort((left, right) => sha256Value(left).localeCompare(sha256Value(right)));
}

function claimSnapshot(claim, readerRefs = []) {
  return {
    id: claim.id,
    semanticHash: sha256Value(claimSemanticValue(claim)),
    supportHash: sha256Value(claimSupportValue(claim)),
    fullHash: sha256Value(claim),
    importance: claim.importance,
    themeId: claim.themeId,
    segmentRefs: sortedUnique((claim.supportSpans ?? []).map((span) => span.segmentId)),
    readerBlockRefs: sortedUnique(readerRefs),
  };
}

function readerRefsByEvidence(deepRead) {
  const refs = new Map();
  for (const leaf of readerLeafIndex(deepRead ?? { sections: [] }).values()) {
    for (const evidenceRef of leaf.evidenceRefs ?? []) {
      if (!refs.has(evidenceRef)) refs.set(evidenceRef, []);
      refs.get(evidenceRef).push(leaf.id);
    }
  }
  return refs;
}

export function createEvidenceBaseline({ manifest, normalized, segments, claims, deepRead, acceptance = "reviewed" }) {
  const readerRefs = readerRefsByEvidence(deepRead);
  return {
    $schema: "../../../schemas/evidence-baseline.schema.json",
    schemaVersion: EVIDENCE_BASELINE_VERSION,
    caseId: manifest.id,
    reviewPolicyVersion: INCREMENTAL_REVIEW_POLICY_VERSION,
    acceptance,
    evidencePath: "work/evidence-baseline.jsonl",
    hashes: {
      source: manifest.source.sha256,
      normalizedSource: sha256Value(normalized),
      segments: sha256Value(segments),
      speakerMap: sha256Value(manifest.speakerMap ?? null),
      evidence: sha256Value(claims),
      deepRead: sha256Value(deepRead),
    },
    claims: [...claims]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((claim) => claimSnapshot(claim, readerRefs.get(claim.id))),
  };
}

function migrationCoversRemovedRefs(migration, removedRefs, repairLineage = null) {
  if (!removedRefs.length) return true;
  const recorded = new Set([
    ...(migration?.entries ?? []).flatMap((entry) => entry.oldEvidenceRefs ?? []),
    ...(repairLineage?.entries ?? []).flatMap((entry) => entry.oldEvidenceRefs ?? []),
  ]);
  return removedRefs.every((ref) => recorded.has(ref));
}

export function buildEvidenceChangeSet({ manifest, baseline, current, migration = null, repairLineage = null }) {
  const baselineById = new Map((baseline?.claims ?? []).map((item) => [item.id, item]));
  const currentById = new Map((current?.claims ?? []).map((item) => [item.id, item]));
  const addedRefs = sortedUnique([...currentById.keys()].filter((id) => !baselineById.has(id)));
  const removedRefs = sortedUnique([...baselineById.keys()].filter((id) => !currentById.has(id)));
  const modifiedRefs = [];
  const mechanicalRefs = [];
  const unchangedRefs = [];
  for (const id of [...currentById.keys()].filter((ref) => baselineById.has(ref)).sort()) {
    const before = baselineById.get(id);
    const after = currentById.get(id);
    if (before.fullHash === after.fullHash) unchangedRefs.push(id);
    else if (before.semanticHash === after.semanticHash && before.supportHash === after.supportHash) mechanicalRefs.push(id);
    else modifiedRefs.push(id);
  }

  const reasons = [];
  let mode = "mechanical";
  const structuralPairs = [
    ["source", "source_changed"],
    ["normalizedSource", "normalized_source_changed"],
    ["segments", "segments_changed"],
    ["speakerMap", "speaker_map_changed"],
  ];
  for (const [key, reason] of structuralPairs) {
    if (baseline?.hashes?.[key] !== current.hashes[key]) reasons.push(reason);
  }
  if (!migrationCoversRemovedRefs(migration, removedRefs, repairLineage)) reasons.push("removed_claim_lineage_missing");
  if (reasons.length) mode = "structural_full";
  else if (addedRefs.length || removedRefs.length || modifiedRefs.length) {
    mode = "semantic_delta";
    reasons.push("claim_semantics_changed_with_stable_source_boundary");
  } else if (mechanicalRefs.length) reasons.push("only_nonsemantic_claim_fields_changed");
  else reasons.push("no_evidence_changes");

  const affectedClaimRefs = sortedUnique([...addedRefs, ...removedRefs, ...modifiedRefs]);
  const affectedSnapshots = affectedClaimRefs.flatMap((ref) => [baselineById.get(ref), currentById.get(ref)]).filter(Boolean);
  const importanceByRef = new Map(affectedClaimRefs.map((ref) => [ref, currentById.get(ref)?.importance ?? baselineById.get(ref)?.importance]));
  const changedDeepRead = baseline?.hashes?.deepRead !== current.hashes.deepRead;
  return {
    $schema: "../../../schemas/evidence-change-set.schema.json",
    schemaVersion: EVIDENCE_CHANGE_SET_VERSION,
    caseId: manifest.id,
    reviewPolicyVersion: INCREMENTAL_REVIEW_POLICY_VERSION,
    mode,
    baseline: baseline?.hashes ?? current.hashes,
    current: current.hashes,
    changes: { addedRefs, removedRefs, modifiedRefs, mechanicalRefs, unchangedRefs },
    affected: {
      segmentRefs: sortedUnique(affectedSnapshots.flatMap((item) => item.segmentRefs)),
      themeRefs: sortedUnique(affectedSnapshots.map((item) => item.themeId)),
      readerBlockRefs: sortedUnique(affectedSnapshots.flatMap((item) => item.readerBlockRefs)),
    },
    requiredReviews: {
      evidenceCheck: true,
      claimAudit: mode === "semantic_delta" || mode === "structural_full",
      fullClaimAudit: mode === "structural_full",
      fidelity: mode === "semantic_delta" && affectedSnapshots.some((item) => item.readerBlockRefs.length > 0),
      readerAdvocate: changedDeepRead,
      sourceScout: mode === "semantic_delta" && affectedClaimRefs.some((ref) => ["high", "medium"].includes(importanceByRef.get(ref))),
      blindRecall: false,
      coverageAB: false,
    },
    reasons: sortedUnique(reasons),
  };
}

export function initialAuditRepairLineageErrors({ resolution, repairLog, provisional, current, changeSet }) {
  const errors = [];
  if (resolution?.status !== "repair_required") errors.push("首次 Claim Gate 并非 repair_required，不能建立修复前临时基线。");
  if (resolution?.inputHashes?.evidence !== provisional?.hashes?.evidence) errors.push("Claim Gate evidence 哈希与归档修复前 evidence 不一致。");
  if (resolution?.inputHashes?.segments !== provisional?.hashes?.segments) errors.push("Claim Gate segments 哈希与当前稳定 segments 不一致。");
  const acceptedAuthorities = new Set(["claim_gate_adjudicated_hard_error_repair", "repair_only_no_approval"]);
  if (!acceptedAuthorities.has(repairLog?.authority)) errors.push("repair log 缺少受支持的 Claim Gate 定向修复授权。");
  if (repairLog?.authority === "repair_only_no_approval") {
    if (repairLog?.role !== "evidence_repair_editor") errors.push("repair_only_no_approval 必须由 evidence_repair_editor 执行。");
    if (repairLog?.sourceClaimResolution?.status !== "repair_required") errors.push("repair log 未绑定 repair_required Claim Gate resolution。");
    if (repairLog?.sourceClaimResolution?.inputEvidenceHash !== provisional?.hashes?.evidence) {
      errors.push("repair log 的 Claim Gate 输入 evidence 哈希与临时基线不一致。");
    }
  }
  if (repairLog?.inputHashes?.evidence !== provisional?.hashes?.evidence) errors.push("repair log 输入 evidence 哈希与临时基线不一致。");
  if (repairLog?.outputHashes?.evidence !== current?.hashes?.evidence) errors.push("repair log 输出 evidence 哈希与当前 evidence 不一致。");
  if ((repairLog?.unresolved ?? []).length) errors.push("repair log 仍有未解决项，不能进入增量复核。");
  if (changeSet?.mode !== "semantic_delta") errors.push(`首次全审后的修复应为 semantic_delta，当前为 ${changeSet?.mode ?? "unknown"}。`);
  const changedRefs = sortedUnique([
    ...(changeSet?.changes?.addedRefs ?? []),
    ...(changeSet?.changes?.removedRefs ?? []),
    ...(changeSet?.changes?.modifiedRefs ?? []),
  ]);
  const declaredRefs = sortedUnique(
    repairLog?.affectedEvidenceRefs
      ?? [
        ...(repairLog?.changedEvidenceRefs?.retired ?? []),
        ...(repairLog?.changedEvidenceRefs?.canonical ?? []),
      ],
  );
  if (JSON.stringify(changedRefs) !== JSON.stringify(declaredRefs)) {
    errors.push("repair log 未精确覆盖实际 evidence 变化范围。");
  }
  return errors;
}

export function evidenceChangeSetContractErrors(changeSet, { manifest, baseline, current, migration = null, repairLineage = null }) {
  const errors = [];
  if (changeSet?.schemaVersion !== EVIDENCE_CHANGE_SET_VERSION) errors.push("evidence-change-set.schemaVersion 必须为 1.0.0。");
  if (changeSet?.caseId !== manifest.id) errors.push("evidence-change-set.caseId 与案例不一致。");
  if (changeSet?.reviewPolicyVersion !== INCREMENTAL_REVIEW_POLICY_VERSION) errors.push("evidence-change-set.reviewPolicyVersion 必须为 2.4.0。");
  if (sha256Value(changeSet?.baseline) !== sha256Value(baseline.hashes)) errors.push("evidence-change-set baseline 已过期。");
  if (sha256Value(changeSet?.current) !== sha256Value(current.hashes)) errors.push("evidence-change-set current 已过期。");
  const groups = ["addedRefs", "removedRefs", "modifiedRefs", "mechanicalRefs", "unchangedRefs"];
  const allRefs = groups.flatMap((group) => changeSet?.changes?.[group] ?? []);
  if (new Set(allRefs).size !== allRefs.length) errors.push("evidence-change-set 的 claim 分类存在交叉。");
  const expected = new Set([...(baseline.claims ?? []).map((item) => item.id), ...(current.claims ?? []).map((item) => item.id)]);
  for (const ref of expected) if (!allRefs.includes(ref)) errors.push(`evidence-change-set 未分类 claim：${ref}`);
  if (changeSet?.requiredReviews?.blindRecall !== false || changeSet?.requiredReviews?.coverageAB !== false) {
    errors.push("2.4 增量证据变化不得自动触发 Blind Recall 或 Coverage A/B。");
  }
  if (baseline?.acceptance === INITIAL_AUDIT_REPAIR_ACCEPTANCE && repairLineage) {
    if (!["1.0.0", "1.1.0"].includes(repairLineage.schemaVersion)) errors.push("evidence-repair-lineage.schemaVersion 非法。");
    if (repairLineage.caseId !== manifest.id) errors.push("evidence-repair-lineage.caseId 与案例不一致。");
    if (repairLineage.inputEvidenceHash !== baseline.hashes.evidence) errors.push("evidence-repair-lineage 输入 evidence 哈希与临时基线不一致。");
    if (repairLineage.outputEvidenceHash !== current.hashes.evidence) errors.push("evidence-repair-lineage 输出 evidence 哈希与当前 evidence 不一致。");
  }
  const expectedChangeSet = buildEvidenceChangeSet({ manifest, baseline, current, migration, repairLineage });
  for (const key of ["mode", "changes", "affected", "requiredReviews", "reasons"]) {
    if (sha256Value(changeSet?.[key]) !== sha256Value(expectedChangeSet[key])) {
      errors.push(`evidence-change-set.${key} 未完整申报实际影响范围。`);
    }
  }
  return errors;
}

export async function loadEvidenceSnapshot(caseDir, acceptance = "reviewed") {
  const [{ manifest }, normalized, segments, claims, deepRead] = await Promise.all([
    loadCase(caseDir),
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    // The first evidence baseline is accepted before reader synthesis. Treat the
    // absent reader layer as an empty document instead of making evidence-diff
    // depend on an artifact that the workflow intentionally has not built yet.
    optionalJson(path.join(caseDir, "output", "deep-read.json"), { sections: [] }),
  ]);
  const actualSourceHash = await sha256File(path.resolve(caseDir, manifest.source.path));
  if (actualSourceHash !== manifest.source.sha256) throw new Error("原始来源哈希与 case.json 不一致，不能生成 evidence diff。");
  return { manifest, normalized, segments, claims, deepRead, baseline: createEvidenceBaseline({ manifest, normalized, segments, claims, deepRead, acceptance }) };
}

export async function computeEvidenceDiff(caseDir, { write = true } = {}) {
  const { manifest, baseline: current } = await loadEvidenceSnapshot(caseDir);
  const baselinePath = path.join(caseDir, "work", "evidence-baseline.json");
  const baseline = await optionalJson(baselinePath);
  let changeSet;
  if (!baseline) {
    changeSet = buildEvidenceChangeSet({ manifest, baseline: current, current });
    changeSet.mode = "structural_full";
    changeSet.requiredReviews.claimAudit = true;
    changeSet.requiredReviews.fullClaimAudit = true;
    changeSet.reasons = ["accepted_baseline_missing"];
  } else {
    const [migration, repairLineage] = await Promise.all([
      optionalJson(path.join(caseDir, "work", "evidence-migration.json")),
      optionalJson(path.join(caseDir, "work", "evidence-repair-lineage.json")),
    ]);
    changeSet = buildEvidenceChangeSet({ manifest, baseline, current, migration, repairLineage });
    const contractErrors = evidenceChangeSetContractErrors(changeSet, { manifest, baseline, current, migration, repairLineage });
    if (contractErrors.length) throw new Error(contractErrors.join("\n"));
  }
  if (write) await writeJson(path.join(caseDir, "work", "evidence-change-set.json"), changeSet);
  return { baseline, current, changeSet };
}

export async function findRepairLogs(caseDir) {
  // Evidence baselines deliberately keep the stable 2.4.0 protocol, while a
  // migrated case may create its first audit packet under the current review
  // policy (for example 2.4.2). Search the versioned review tree and let the
  // hash/lineage checks below identify the one applicable artifact.
  const reviewRoot = path.join(caseDir, "work", "reviews");
  let entries;
  try {
    entries = await fs.readdir(reviewRoot, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => path.basename(entry) === "claim-repair-log.json")
    .map((entry) => path.join(reviewRoot, entry));
}

export async function findInitialAuditClaims(caseDir, { manifest, resolution, archivedClaims = [] }) {
  const expectedEvidenceHash = resolution?.inputHashes?.evidence;
  if (!expectedEvidenceHash) throw new Error("Claim Gate resolution 缺少首次全审 evidence 哈希。");
  if (sha256Value(archivedClaims) === expectedEvidenceHash) return archivedClaims;

  const reviewsRoot = path.join(caseDir, "work", "reviews");
  let entries;
  try {
    entries = await fs.readdir(reviewsRoot, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") entries = [];
    else throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (path.basename(entry) !== "claim_auditor.json" || path.basename(path.dirname(entry)) !== "packets") continue;
    const normalizedEntry = entry.split(path.sep).join("/");
    if (!normalizedEntry.includes("/preflight/")) continue;
    const packet = await optionalJson(path.join(reviewsRoot, entry));
    if (packet?.caseId !== manifest.id || packet?.inputHashes?.evidence !== expectedEvidenceHash) continue;
    const claims = (packet?.payload?.claims ?? []).map((claim) => ({
      ...claim,
      supportSpans: (claim.supportSpans ?? []).map(({ sourceUnits: _sourceUnits, ...span }) => span),
    }));
    if (sha256Value(claims) === expectedEvidenceHash) candidates.push(claims);
  }
  const uniqueCandidates = new Map(candidates.map((claims) => [sha256Value(claims), claims]));
  if (uniqueCandidates.size !== 1) {
    throw new Error(`无法唯一恢复首次 Claim Audit 的修复前 evidence（找到 ${uniqueCandidates.size} 份不同的哈希匹配 packet）。`);
  }
  return [...uniqueCandidates.values()][0];
}

export async function seedInitialAuditRepairBaseline(caseDir) {
  const baselinePath = path.join(caseDir, "work", "evidence-baseline.json");
  if (await optionalJson(baselinePath)) throw new Error("案例已存在 evidence baseline，无需建立首次审计修复临时基线。");
  const [{ manifest, normalized, segments, baseline: current }, ledger, resolution, migration] = await Promise.all([
    loadEvidenceSnapshot(caseDir),
    optionalJson(path.join(caseDir, "work", "migration-v2.4.json")),
    readJson(path.join(caseDir, "work", "claim-review-resolution.json")),
    optionalJson(path.join(caseDir, "work", "evidence-migration.json")),
  ]);
  let archivedClaims = [];
  let initialInput = null;
  if (ledger) {
    if (!ledger.archive?.path) throw new Error("migration-v2.4 缺少可核验的归档快照。");
    const archiveDir = path.resolve(caseDir, ledger.archive.path);
    const archiveRelative = path.relative(path.resolve(caseDir), archiveDir);
    if (!archiveRelative || archiveRelative.startsWith("..") || path.isAbsolute(archiveRelative)) throw new Error("migration archive 越出案例目录。");
    archivedClaims = await readJsonLines(path.join(archiveDir, "work", "evidence.jsonl"));
  } else {
    initialInput = await readJson(path.join(caseDir, "work", "initial-audit-input.json"));
    if (initialInput.caseId !== manifest.id || initialInput.purpose !== "initial_full_audit_pre_repair_not_approval"
      || initialInput.resolutionHash !== sha256Value(resolution)
      || initialInput.primaryReviewHash !== resolution.inputHashes.primaryClaimReview
      || initialInput.evidenceHash !== resolution.inputHashes.evidence
      || initialInput.speakerMapHash !== current.hashes.speakerMap) throw new Error("新案首次审核输入快照绑定不完整。");
    if (!initialInput.packets?.length) throw new Error("新案缺少原始隔离 packet 绑定。");
    for (const entry of initialInput.packets) {
      const packetPath = path.resolve(caseDir, entry.path);
      const relative = path.relative(path.resolve(caseDir), packetPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("首次审核 packet 路径越界。");
      if (sha256Value(await readJson(packetPath)) !== entry.hash) throw new Error("首次审核 packet 已变化。");
    }
  }
  const preRepairClaims = await findInitialAuditClaims(caseDir, { manifest, resolution, archivedClaims });
  const provisional = createEvidenceBaseline({
    manifest,
    normalized,
    segments,
    claims: preRepairClaims,
    // Initial evidence review precedes reader synthesis. The legacy 1.5 reader
    // snapshot is not the audited 2.4 reader dependency and must not be reused.
    deepRead: { sections: [] },
    acceptance: INITIAL_AUDIT_REPAIR_ACCEPTANCE,
  });
  const currentFileHashes = {
    source: await sha256File(path.resolve(caseDir, manifest.source.path)),
    normalizedSource: await sha256File(path.join(caseDir, "work", "source.normalized.jsonl")),
    segments: await sha256File(path.join(caseDir, "work", "segments.jsonl")),
  };
  const evidenceReadySnapshot = initialInput?.snapshotHashes ?? [...(ledger.completedStages ?? [])]
    .reverse()
    .find((entry) => entry.stage === "evidence_ready")
    ?.snapshotHashes;
  if (!evidenceReadySnapshot) throw new Error("migration-v2.4 缺少 evidence_ready 输入快照。");
  for (const [name, actual] of Object.entries(currentFileHashes)) {
    if (evidenceReadySnapshot?.[name] !== actual) throw new Error(`首次全审后 ${name} 已变化，必须执行 structural_full。`);
  }
  if (resolution?.inputHashes?.segments !== sha256Value(segments)) {
    throw new Error("Claim Gate segments 哈希与 evidence_ready 输入不一致，必须执行 structural_full。");
  }
  const repairLogs = await findRepairLogs(caseDir);
  const candidates = [];
  for (const filePath of repairLogs) {
    const log = await readJson(filePath);
    if (log?.inputHashes?.evidence === provisional.hashes.evidence && log?.outputHashes?.evidence === current.hashes.evidence) candidates.push(log);
  }
  if (candidates.length !== 1) throw new Error(`无法唯一定位绑定首次全审输入与当前 evidence 的 repair log（找到 ${candidates.length} 个）。`);
  const repairLog = candidates[0];
  const repairLineage = {
    $schema: "../../../schemas/evidence-repair-lineage.schema.json",
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: INCREMENTAL_REVIEW_POLICY_VERSION,
    repairLogHash: sha256Value(repairLog),
    inputEvidenceHash: provisional.hashes.evidence,
    outputEvidenceHash: current.hashes.evidence,
    entries: repairLineageEntries(repairLog),
  };
  const changeSet = buildEvidenceChangeSet({ manifest, baseline: provisional, current, migration, repairLineage });
  const errors = initialAuditRepairLineageErrors({ resolution, repairLog, provisional, current, changeSet });
  if (errors.length) throw new Error(errors.join("\n"));
  await writeJsonLines(path.join(caseDir, "work", "evidence-baseline.jsonl"), preRepairClaims);
  await writeJson(baselinePath, provisional);
  await writeJson(path.join(caseDir, "work", "evidence-repair-lineage.json"), repairLineage);
  await writeJson(path.join(caseDir, "work", "evidence-change-set.json"), changeSet);
  return { baseline: provisional, current, changeSet, repairLog };
}

export async function acceptEvidenceBaseline(caseDir, { acceptance = "reviewed" } = {}) {
  const { baseline, claims, manifest, segments } = await loadEvidenceSnapshot(caseDir, acceptance);
  const existingBaseline = await optionalJson(path.join(caseDir, "work", "evidence-baseline.json"));
  const warningProof = await validateClaimOrganizationWarningResolution(caseDir, { manifest, claims, segments,
    baseline: existingBaseline?.hashes?.evidence === baseline.hashes.evidence ? existingBaseline : null });
  if (warningProof.errors.length) throw new Error(warningProof.errors.join("\n"));
  if (warningProof.resolutionHash) baseline.claimOrganizationWarningResolution = warningProof.resolutionHash;
  await writeJsonLines(path.join(caseDir, "work", "evidence-baseline.jsonl"), claims);
  await writeJson(path.join(caseDir, "work", "evidence-baseline.json"), baseline);
  return computeEvidenceDiff(caseDir);
}

function parseCli(argv) {
  const result = { caseArgument: argv[0], accept: false, migrated: false, seedInitialAuditRepair: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--accept") result.accept = true;
    else if (argv[index] === "--migrated-reviewed-history") result.migrated = true;
    else if (argv[index] === "--seed-initial-audit-repair") result.seedInitialAuditRepair = true;
    else throw new Error(`未知参数：${argv[index]}`);
  }
  if (result.accept && result.seedInitialAuditRepair) throw new Error("--accept 与 --seed-initial-audit-repair 不能同时使用。");
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const caseDir = resolveCaseDir(options.caseArgument);
    if (options.seedInitialAuditRepair) {
      const result = await seedInitialAuditRepairBaseline(caseDir);
      console.log(`已从首次全审输入建立修复前临时基线：${path.relative(REPO_ROOT, caseDir)}（${result.changeSet.mode}；${[...result.changeSet.changes.removedRefs, ...result.changeSet.changes.modifiedRefs, ...result.changeSet.changes.addedRefs].join("、")}）`);
    } else if (options.accept) {
      const acceptance = options.migrated ? "migrated_reviewed_history" : "reviewed";
      const result = await acceptEvidenceBaseline(caseDir, { acceptance });
      console.log(`已接受 evidence baseline：${path.relative(REPO_ROOT, caseDir)}（${result.changeSet.reasons.join("、")}）`);
    } else {
      const result = await computeEvidenceDiff(caseDir);
      console.log(`evidence 变化模式：${result.changeSet.mode}`);
      console.log(`变化 claim：${[...result.changeSet.changes.addedRefs, ...result.changeSet.changes.removedRefs, ...result.changeSet.changes.modifiedRefs].join("、") || "无"}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
