import fs from "node:fs/promises";
import path from "node:path";

import {
  loadCase,
  readJson,
  readJsonLines,
  REPO_ROOT,
  sha256File,
  writeJson,
} from "./lib.mjs";
import {
  evidenceChangeSetContractErrors,
  INCREMENTAL_REVIEW_POLICY_VERSION,
  loadEvidenceSnapshot,
} from "./evidence-diff.mjs";
import { sha256Value } from "./review-contract.mjs";

function sortedUnique(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

const POLICY_DISPOSITION_VERSION = "1.0.0";
const POLICY_DISPOSITION_AUTHORITY = "user_approved_nonblocking_warning";
const POLICY_DISPOSITION_BASIS = "non_core_asr_ambiguity";
const POLICY_DISPOSITION_DECISION = "warning";
const POLICY_DISPOSITION_CONSTRAINT = "exclude_from_new_reader";
const NEVER_DOWNGRADE_ISSUE = /fabricat|hallucin|invent|misattribut|wrong[_-]?speaker|contradict|invalid[_-]?citation|citation[_-]?invalid|wrong[_-]?provenance|material[_-]?(?:semantic|meaning|causal|numeric)|changed[_-]?(?:meaning|causality)|false[_-]?quote/iu;
const ASR_BOUNDARY_ISSUE = new Set(["asr_ambiguity", "minor_support_boundary", "unsupported_semantic_extension"]);

function normalizedDeltaEntries(report) {
  if (Array.isArray(report?.entries)) return report.entries;
  return (report?.refVerdicts ?? []).map((entry) => {
    const hardFinding = (report?.hardErrors ?? []).find((finding) => finding.evidenceRef === entry.evidenceRef);
    const issueKinds = hardFinding?.code ? [hardFinding.code] : [];
    return {
      evidenceRef: entry.evidenceRef,
      changeType: entry.changeType,
      verdict: entry.verdict === "pass" ? "pass" : "hard_error",
      issueKinds,
      rationale: entry.rationale,
    };
  });
}

function normalizedDeltaReviewerId(report) {
  return String(report?.reviewerId ?? report?.assignedReviewerId ?? "").trim();
}

function normalizedDeltaScope(report) {
  if (report?.scope) return report.scope;
  const entries = normalizedDeltaEntries(report);
  return {
    addedRefs: entries.filter((entry) => entry.changeType === "added").map((entry) => entry.evidenceRef),
    removedRefs: entries.filter((entry) => entry.changeType === "removed").map((entry) => entry.evidenceRef),
    modifiedRefs: entries.filter((entry) => entry.changeType === "modified").map((entry) => entry.evidenceRef),
  };
}

export function blockingDeltaEntries(report) {
  const explicitHardRefs = new Set((report?.hardErrors ?? []).map((finding) => finding?.evidenceRef).filter(Boolean));
  return normalizedDeltaEntries(report).filter((entry) => (
    entry.verdict === "hard_error" || explicitHardRefs.has(entry.evidenceRef)
  ));
}

export function advisoryDeltaEntries(report) {
  const blockingRefs = new Set(blockingDeltaEntries(report).map((entry) => entry.evidenceRef));
  return normalizedDeltaEntries(report).filter((entry) => (
    entry.verdict === "revise" && !blockingRefs.has(entry.evidenceRef)
  ));
}

function findingForEntry(report, entry) {
  return (report?.hardErrors ?? []).find((finding) => finding.evidenceRef === entry.evidenceRef) ?? entry;
}

export function claimPolicyDispositionContractErrors(disposition, {
  manifest,
  changeSet,
  currentEvidence,
  segments,
  report,
}) {
  const errors = [];
  if (disposition?.schemaVersion !== POLICY_DISPOSITION_VERSION) errors.push("claim policy disposition.schemaVersion 必须为 1.0.0。");
  if (disposition?.caseId !== manifest.id) errors.push("claim policy disposition.caseId 与案例不一致。");
  if (disposition?.reviewPolicyVersion !== INCREMENTAL_REVIEW_POLICY_VERSION) errors.push("claim policy disposition.reviewPolicyVersion 必须为 2.4.0。");
  if (disposition?.authority !== POLICY_DISPOSITION_AUTHORITY) errors.push("claim policy disposition 缺少明确的用户批准授权。");
  const expectedHashes = {
    changeSet: sha256Value(changeSet),
    report: sha256Value(report),
    currentEvidence: sha256Value(currentEvidence),
    segments: sha256Value(segments),
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (disposition?.inputHashes?.[name] !== expected) errors.push(`claim policy disposition.inputHashes.${name} 已过期。`);
  }
  const reportEntries = blockingDeltaEntries(report);
  const blockingByRef = new Map(reportEntries.map((entry) => [entry.evidenceRef, entry]));
  const claimsByRef = new Map(currentEvidence.map((claim) => [claim.id, claim]));
  const entries = disposition?.entries ?? [];
  if (!Array.isArray(entries) || entries.length === 0) errors.push("claim policy disposition.entries 不能为空。");
  if (new Set(entries.map((entry) => entry.evidenceRef)).size !== entries.length) errors.push("claim policy disposition 存在重复 evidenceRef。");
  for (const entry of entries) {
    const blocking = blockingByRef.get(entry.evidenceRef);
    if (!blocking) {
      errors.push(`claim policy disposition 越界处置：${entry.evidenceRef} 不是报告中的 nonpass。`);
      continue;
    }
    const finding = findingForEntry(report, blocking);
    const issueKinds = sortedUnique([...(blocking.issueKinds ?? []), finding?.code, finding?.issueKind]);
    if (entry.findingHash !== sha256Value(finding)) errors.push(`${entry.evidenceRef} 的 disposition findingHash 已过期。`);
    if (entry.decision !== POLICY_DISPOSITION_DECISION) errors.push(`${entry.evidenceRef} 只能降为 warning。`);
    if (entry.basis !== POLICY_DISPOSITION_BASIS) errors.push(`${entry.evidenceRef} 只能使用 non_core_asr_ambiguity 依据。`);
    if (entry.deliveryConstraint !== POLICY_DISPOSITION_CONSTRAINT) errors.push(`${entry.evidenceRef} 必须从新读者稿排除。`);
    if (!claimsByRef.has(entry.evidenceRef)) errors.push(`${entry.evidenceRef} 不存在于当前 evidence，不能按 evidence-only 处置。`);
    if (!issueKinds.length || issueKinds.some((kind) => !ASR_BOUNDARY_ISSUE.has(kind))) {
      errors.push(`${entry.evidenceRef} 的 issueKind 不属于可降级的 ASR/轻微支持边界。`);
    }
    if (issueKinds.some((kind) => NEVER_DOWNGRADE_ISSUE.test(kind))) {
      errors.push(`${entry.evidenceRef} 涉及不可降级的编造、矛盾、错归属、无效引用或实质改义。`);
    }
    const safeguards = entry.safeguards ?? {};
    for (const name of ["noFabrication", "noMisattribution", "noContradiction", "noInvalidCitation", "noMaterialSemanticChange", "coreUnderstandingUnaffected"]) {
      if (safeguards[name] !== true) errors.push(`${entry.evidenceRef} 缺少 disposition safeguard：${name}。`);
    }
    if (!String(entry.rationale ?? "").trim()) errors.push(`${entry.evidenceRef} 缺少 disposition rationale。`);
  }
  return errors;
}

export function applyClaimPolicyDisposition(report, disposition) {
  const disposed = new Set((disposition?.entries ?? []).map((entry) => entry.evidenceRef));
  const hardErrors = blockingDeltaEntries(report)
    .filter((entry) => !disposed.has(entry.evidenceRef))
    .map((entry) => ({ evidenceRef: entry.evidenceRef, finding: findingForEntry(report, entry) }));
  const warnings = blockingDeltaEntries(report)
    .filter((entry) => disposed.has(entry.evidenceRef))
    .map((entry) => ({
      evidenceRef: entry.evidenceRef,
      code: "user_approved_non_core_asr_ambiguity",
      deliveryConstraint: POLICY_DISPOSITION_CONSTRAINT,
      finding: findingForEntry(report, entry),
    }));
  return { hardErrors, warnings };
}

function sourceUnitsForClaim(claim, sourceById) {
  if (!claim) return null;
  return {
    ...claim,
    supportSpans: (claim.supportSpans ?? []).map((span) => ({
      ...span,
      sourceUnits: (span.sourceIds ?? []).map((sourceId) => sourceById.get(sourceId)).filter(Boolean),
    })),
  };
}

export function claimsDeltaReviewContractErrors(report, { manifest, changeSet, baselineEvidence, currentEvidence, segments }) {
  const errors = [];
  if (report?.schemaVersion !== "1.0.0") errors.push("claims-delta-review.schemaVersion 必须为 1.0.0。");
  if (report?.caseId !== manifest.id) errors.push("claims-delta-review.caseId 与案例不一致。");
  if (report?.reviewPolicyVersion !== "2.4.0") errors.push("claims-delta-review.reviewPolicyVersion 必须为 2.4.0。");
  if (report?.role !== "claim_delta_auditor") errors.push("claims-delta-review.role 必须为 claim_delta_auditor。");
  if (!normalizedDeltaReviewerId(report)) errors.push("claims-delta-review 缺少 reviewerId。");
  const expectedHashes = {
    changeSet: sha256Value(changeSet),
    baselineEvidence: sha256Value(baselineEvidence),
    currentEvidence: sha256Value(currentEvidence),
    segments: sha256Value(segments),
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (report?.inputHashes?.[name] !== expected) errors.push(`claims-delta-review.inputHashes.${name} 已过期。`);
  }
  const expectedScope = {
    addedRefs: sortedUnique(changeSet.changes.addedRefs),
    removedRefs: sortedUnique(changeSet.changes.removedRefs),
    modifiedRefs: sortedUnique(changeSet.changes.modifiedRefs),
  };
  const reportScope = normalizedDeltaScope(report);
  for (const [name, expected] of Object.entries(expectedScope)) {
    if (JSON.stringify(sortedUnique(reportScope?.[name])) !== JSON.stringify(expected)) {
      errors.push(`claims-delta-review.scope.${name} 与 evidence-change-set 不一致。`);
    }
  }
  const expectedByRef = new Map([
    ...expectedScope.addedRefs.map((ref) => [ref, "added"]),
    ...expectedScope.removedRefs.map((ref) => [ref, "removed"]),
    ...expectedScope.modifiedRefs.map((ref) => [ref, "modified"]),
  ]);
  const entries = normalizedDeltaEntries(report);
  if (new Set(entries.map((entry) => entry.evidenceRef)).size !== entries.length) errors.push("claims-delta-review 存在重复 evidenceRef。");
  for (const [ref, changeType] of expectedByRef) {
    const entry = entries.find((item) => item.evidenceRef === ref);
    if (!entry) errors.push(`claims-delta-review 未审核变化 claim：${ref}`);
    else if (entry.changeType !== changeType) errors.push(`${ref} 的 changeType 应为 ${changeType}。`);
  }
  for (const entry of entries) if (!expectedByRef.has(entry.evidenceRef)) errors.push(`claims-delta-review 越界审核：${entry.evidenceRef}`);
  return errors;
}

export async function prepareClaimsDeltaPacket(caseDir, { reviewRound = 1, reviewerId } = {}) {
  if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new Error("reviewRound 必须为正整数。");
  if (String(reviewerId ?? "").trim().length < 2) throw new Error("--claims-delta 必须指定 claim_auditor reviewerId。");
  const [{ manifest }, changeSet, baseline, baselineEvidence, currentEvidence, segments, normalized, migration, repairLineage] = await Promise.all([
    loadCase(caseDir),
    readJson(path.join(caseDir, "work", "evidence-change-set.json")),
    readJson(path.join(caseDir, "work", "evidence-baseline.json")),
    readJsonLines(path.join(caseDir, "work", "evidence-baseline.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJson(path.join(caseDir, "work", "evidence-migration.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    readJson(path.join(caseDir, "work", "evidence-repair-lineage.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  const currentSnapshot = (await loadEvidenceSnapshot(caseDir)).baseline;
  const changeErrors = evidenceChangeSetContractErrors(changeSet, { manifest, baseline, current: currentSnapshot, migration, repairLineage });
  if (changeErrors.length) throw new Error(changeErrors.join("\n"));
  if (changeSet.mode !== "semantic_delta") throw new Error(`--claims-delta 只接受 semantic_delta，当前为 ${changeSet.mode}。`);
  const baselineById = new Map(baselineEvidence.map((claim) => [claim.id, claim]));
  const currentById = new Map(currentEvidence.map((claim) => [claim.id, claim]));
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const scope = {
    addedRefs: sortedUnique(changeSet.changes.addedRefs),
    removedRefs: sortedUnique(changeSet.changes.removedRefs),
    modifiedRefs: sortedUnique(changeSet.changes.modifiedRefs),
  };
  const changedRefs = new Set([...scope.addedRefs, ...scope.removedRefs, ...scope.modifiedRefs]);
  const affectedThemes = new Set(changeSet.affected.themeRefs ?? []);
  const sameThemeDuplicateCandidates = currentEvidence
    .filter((claim) => !changedRefs.has(claim.id) && affectedThemes.has(claim.themeId))
    .map((claim) => ({
      id: claim.id,
      themeId: claim.themeId,
      statement: claim.statement,
      provenance: claim.provenance,
      speaker: claim.speaker,
    }));
  const changeSetHash = sha256Value(changeSet);
  const reviewRoot = path.join(caseDir, "work", "reviews", "2.4.0", "delta", changeSetHash.slice(0, 12));
  const outputPath = path.join(reviewRoot, "claim-delta-review.json");
  const packet = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    reviewRound,
    role: "claim_delta_auditor",
    assignedReviewerId: String(reviewerId).trim(),
    inputHashes: {
      changeSet: changeSetHash,
      baselineEvidence: sha256Value(baselineEvidence),
      currentEvidence: sha256Value(currentEvidence),
      segments: sha256Value(segments),
    },
    inputPolicy: {
      isolation: "packet-only",
      allowed: ["changed claims, their before/after values, and exact support source units"],
      forbidden: ["unchanged claims except same-theme duplicate candidates", "deep-read outside affected reader blocks", "other reviewer verdicts"],
    },
    output: {
      path: path.relative(caseDir, outputPath).split(path.sep).join("/"),
      schema: "schemas/claims-delta-review.schema.json",
      contract: {
        schemaVersion: "1.0.0",
        caseId: manifest.id,
        reviewPolicyVersion: "2.4.0",
        role: "claim_delta_auditor",
        reviewerId: String(reviewerId).trim(),
        reviewRound,
        inputHashes: "copy packet.inputHashes exactly",
        scope: "copy payload.changeSet.changes addedRefs/removedRefs/modifiedRefs exactly",
        entries: [{
          evidenceRef: "one changed ref",
          changeType: "added | removed | modified",
          verdict: "pass | revise | hard_error",
          issueKinds: ["empty when pass; concrete issue codes otherwise"],
          rationale: "brief evidence-based rationale",
        }],
        forbiddenFields: ["assignedReviewerId", "reviewedRefs", "refVerdicts", "overall verdict", "hidden reasoning"],
      },
    },
    payload: {
      changeSet,
      changes: [
        ...scope.addedRefs.map((ref) => ({
          evidenceRef: ref,
          changeType: "added",
          before: null,
          after: sourceUnitsForClaim(currentById.get(ref), sourceById),
        })),
        ...scope.removedRefs.map((ref) => ({
          evidenceRef: ref,
          changeType: "removed",
          before: sourceUnitsForClaim(baselineById.get(ref), sourceById),
          after: null,
        })),
        ...scope.modifiedRefs.map((ref) => ({
          evidenceRef: ref,
          changeType: "modified",
          before: sourceUnitsForClaim(baselineById.get(ref), sourceById),
          after: sourceUnitsForClaim(currentById.get(ref), sourceById),
        })),
      ],
      sameThemeDuplicateCandidates,
      requiredFollowups: changeSet.requiredReviews,
    },
  };
  const packetPath = path.join(reviewRoot, "packets", "claim_delta_auditor.json");
  await writeJson(packetPath, packet);
  return { packetPath, outputPath, packet };
}

export async function validateClaimsDelta(caseDir) {
  const [{ manifest }, changeSet, baseline, baselineEvidence, currentEvidence, segments, migration, repairLineage] = await Promise.all([
    loadCase(caseDir),
    readJson(path.join(caseDir, "work", "evidence-change-set.json")),
    readJson(path.join(caseDir, "work", "evidence-baseline.json")),
    readJsonLines(path.join(caseDir, "work", "evidence-baseline.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJson(path.join(caseDir, "work", "evidence-migration.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    readJson(path.join(caseDir, "work", "evidence-repair-lineage.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  const currentSnapshot = (await loadEvidenceSnapshot(caseDir)).baseline;
  const errors = evidenceChangeSetContractErrors(changeSet, { manifest, baseline, current: currentSnapshot, migration, repairLineage });
  if (changeSet.mode !== "semantic_delta") return { errors, report: null };
  const root = path.join(caseDir, "work", "reviews", "2.4.0", "delta", sha256Value(changeSet).slice(0, 12));
  let report;
  try {
    report = await readJson(path.join(root, "claim-delta-review.json"));
  } catch (error) {
    errors.push(`缺少 claim delta report：${error.message}`);
    return { errors, report: null };
  }
  errors.push(...claimsDeltaReviewContractErrors(report, {
    manifest,
    changeSet,
    baselineEvidence,
    currentEvidence,
    segments,
  }));
  let disposition = null;
  try {
    disposition = await readJson(path.join(root, "policy-disposition.json"));
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(`无法读取 claim policy disposition：${error.message}`);
  }
  let warnings = advisoryDeltaEntries(report).map((entry) => ({
    evidenceRef: entry.evidenceRef,
    code: "reviewer_advisory_revision",
    finding: findingForEntry(report, entry),
  }));
  let unresolved = blockingDeltaEntries(report);
  if (disposition) {
    const dispositionErrors = claimPolicyDispositionContractErrors(disposition, {
      manifest,
      changeSet,
      currentEvidence,
      segments,
      report,
    });
    errors.push(...dispositionErrors);
    if (!dispositionErrors.length) {
      const applied = applyClaimPolicyDisposition(report, disposition);
      unresolved = applied.hardErrors.map((entry) => blockingDeltaEntries(report).find((item) => item.evidenceRef === entry.evidenceRef));
      warnings = [...warnings, ...applied.warnings];
    }
  }
  for (const entry of unresolved) {
    errors.push(`claim delta report 仍有 nonpass：${entry.evidenceRef}（${(entry.issueKinds ?? []).join("、") || "未分类问题"}）。`);
  }
  return { errors, warnings, report, disposition };
}
