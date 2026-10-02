import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
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
} from "./lib.mjs";
import {
  blindCandidateContractErrors,
  claimBundleContractErrors,
  coverageClaimsForReview,
  claimReviewResolutionContractErrors,
  eligibleReaderLeaves,
  evidenceMigrationContractErrors,
  fidelityReaderLeaves,
  readerLeafIndex,
  repairRoundLimitForCase,
  repairLogContractErrors,
  supplementalClaimRepairContractErrors,
  REVIEW_ROLES,
  reviewManifestContractErrors,
  reviewWorkflowVersion,
  sha256Text,
  sha256Value,
} from "./review-contract.mjs";
import { coverageLedgerErrors } from "./segment-source.mjs";
import { prepareRepairDiagnostic, refreshRepairDiagnostic } from "./review-diagnostic.mjs";
import { prepareClaimsDeltaPacket } from "./claims-delta.mjs";

const INITIAL_PACKET_ROLES = Object.freeze([
  "claim_auditor",
  "blind_recall",
  "alignment",
  "coverage_a",
  "coverage_b",
  "fidelity",
  "reader_advocate",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function caseRelative(caseDir, filePath) {
  return toPosix(path.relative(caseDir, filePath));
}

function resolveCasePath(caseDir, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`${label} 必须为相对路径。`);
  const resolved = path.resolve(caseDir, relativePath);
  const relative = path.relative(caseDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出案例目录：${relativePath}`);
  return resolved;
}

function roundDirectory(reviewRound) {
  if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new Error("reviewRound 必须为正整数。");
  return `round-${String(reviewRound).padStart(2, "0")}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readResolutionDependency(caseDir, resolution, hashName, fileName) {
  if (!Object.hasOwn(resolution?.inputHashes ?? {}, hashName)) return null;
  const filePath = path.join(caseDir, "work", fileName);
  if (!(await exists(filePath))) throw new Error(`claim-review-resolution 绑定的 ${fileName} 不存在。`);
  return readJson(filePath);
}

function normalizedAssignments(value) {
  const pairs = Array.isArray(value)
    ? value.map((item) => [item.role, item.reviewerId])
    : Object.entries(value ?? {});
  const unknown = pairs.map(([role]) => role).filter((role) => !REVIEW_ROLES.includes(role));
  if (unknown.length) throw new Error(`未知审核角色：${[...new Set(unknown)].join("、")}`);
  if (new Set(pairs.map(([role]) => role)).size !== pairs.length) throw new Error("审核角色分配不得重复声明同一角色。");
  const byRole = new Map(pairs);
  const assignments = REVIEW_ROLES.map((role) => ({
    role,
    reviewerId: String(byRole.get(role) ?? "").trim(),
  }));
  const missing = assignments.filter((item) => item.reviewerId.length < 2).map((item) => item.role);
  if (missing.length) throw new Error(`缺少审核角色分配：${missing.join("、")}`);
  return assignments;
}

function assignmentMap(assignments) {
  return new Map(assignments.map((item) => [item.role, item.reviewerId]));
}

function stripReaderReferences(markdown) {
  return String(markdown)
    .replace(/\s*〔(?:\[[^\]]+\]\([^)]*\))(?:、\[[^\]]+\]\([^)]*\))*〕/gu, "")
    .replace(/\[完整证据册\]\([^)]*\)/gu, "完整证据册")
    .replace(/<a id="[^"]+"><\/a>\s*/gu, "");
}

function stripLeafReferences(leaf) {
  // Reviewer-facing refs always address the flattened reader leaf (`leaf.id`).
  // Exposing its parent as `blockId` made that interface ambiguous and led
  // reviewers to return IDs that readerLeafIndex cannot resolve.
  const {
    evidenceRefs: _evidenceRefs,
    citationRefs: _citationRefs,
    blockId: _parentBlockId,
    ...rest
  } = leaf;
  return rest;
}

function stripParentBlockId(leaf) {
  const { blockId: _parentBlockId, ...rest } = leaf;
  return rest;
}

function sourceUnitsForClaim(claim, sourceById) {
  return {
    ...claim,
    supportSpans: (claim.supportSpans ?? []).map((span) => ({
      ...span,
      sourceUnits: (span.sourceIds ?? []).map((sourceId) => sourceById.get(sourceId)).filter(Boolean),
    })),
  };
}

function coverageClaim(claim) {
  return {
    id: claim.id,
    statement: claim.statement,
    provenance: claim.provenance,
    importance: claim.importance,
    claimRole: claim.claimRole,
    themeId: claim.themeId,
  };
}

function packetBase({ manifest, workflowVersion = "2.2.0", reviewRound, role, reviewerId, inputHashes, outputPath, schemaPath, policy }) {
  const outputContract = JSON.parse(readFileSync(path.join(REPO_ROOT, schemaPath), "utf8"));
  const outputDependencies = Object.fromEntries(roleSchemaDependencies(role).map((dependencyPath) => [
    dependencyPath,
    JSON.parse(readFileSync(path.join(REPO_ROOT, "schemas", dependencyPath), "utf8")),
  ]));
  const reviewInstructions = readFileSync(path.join(REPO_ROOT, rolePrompt(role)), "utf8");
  return {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    workflowVersion,
    reviewRound,
    role,
    assignedReviewerId: reviewerId,
    inputHashes,
    output: { path: outputPath, schema: schemaPath, contract: outputContract, dependencies: outputDependencies },
    reviewInstructions,
    inputPolicy: {
      isolation: "packet-only",
      instruction: "只读取本 packet 明示的 payload、reviewInstructions 与 output.contract；不得读取禁止输入、作者讨论或其他角色结果。",
      ...policy,
    },
  };
}

function artifactPaths(caseDir, reviewRoot, { hasEvidenceMigration }) {
  const relative = (name) => caseRelative(caseDir, path.join(reviewRoot, name));
  return {
    claimReview: relative("claim-review.json"),
    claimReviewResolution: relative("claim-review-resolution.json"),
    blindCandidates: relative("blind-candidates.json"),
    blindAlignment: relative("blind-alignment.json"),
    coverageA: relative("coverage-a.json"),
    coverageB: relative("coverage-b.json"),
    fidelityReview: relative("fidelity-review.json"),
    readerReview: relative("reader-review.json"),
    adjudication: relative("adjudication.json"),
    claimBundles: "work/claim-bundles.json",
    themeMap: "work/theme-map.json",
    evidenceMigration: hasEvidenceMigration ? "work/evidence-migration.json" : null,
    repairLog: relative("repair-log.json"),
  };
}

function roleArtifact(manifest, role) {
  return {
    claim_auditor: manifest.artifacts.claimReview,
    blind_recall: manifest.artifacts.blindCandidates,
    alignment: manifest.artifacts.blindAlignment,
    coverage_a: manifest.artifacts.coverageA,
    coverage_b: manifest.artifacts.coverageB,
    fidelity: manifest.artifacts.fidelityReview,
    reader_advocate: manifest.artifacts.readerReview,
    adjudicator: manifest.artifacts.adjudication,
    repair_editor: manifest.artifacts.repairLog,
  }[role];
}

function roleSchema(role) {
  return {
    claim_auditor: "schemas/claim-review.schema.json",
    blind_recall: "schemas/blind-candidate.schema.json",
    alignment: "schemas/blind-alignment.schema.json",
    coverage_a: "schemas/coverage-review.schema.json",
    coverage_b: "schemas/coverage-review.schema.json",
    fidelity: "schemas/fidelity-review.schema.json",
    reader_advocate: "schemas/reader-review.schema.json",
    adjudicator: "schemas/adjudication.schema.json",
    repair_editor: "schemas/repair-log.schema.json",
  }[role];
}

function rolePrompt(role) {
  return {
    claim_auditor: "prompts/reviews/claim-auditor.md",
    blind_recall: "prompts/reviews/blind-recall.md",
    alignment: "prompts/reviews/alignment.md",
    coverage_a: "prompts/reviews/coverage-a.md",
    coverage_b: "prompts/reviews/coverage-b.md",
    fidelity: "prompts/reviews/fidelity.md",
    reader_advocate: "prompts/reviews/reader-advocate.md",
    adjudicator: "prompts/reviews/adjudicator.md",
    repair_editor: "prompts/reviews/repair-editor.md",
  }[role];
}

function roleSchemaDependencies(role) {
  return role === "blind_recall" ? ["evidence.schema.json"] : [];
}

async function writePacket(caseDir, reviewRoot, role, packet) {
  const filePath = path.join(reviewRoot, "packets", `${role}.json`);
  await writeJson(filePath, packet);
  return {
    path: caseRelative(caseDir, filePath),
    sha256: await sha256File(filePath),
    ready: role !== "alignment",
  };
}

export function freshClaimAuditorError(previousManifest, currentReviewerId) {
  const previousReviewerId = previousManifest?.assignments?.find((item) => item.role === "claim_auditor")?.reviewerId;
  return previousReviewerId && previousReviewerId === currentReviewerId
    ? "新审核轮次必须更换独立 Claim Auditor，不能沿用上一轮 reviewerId。"
    : null;
}

export function mayStartInitialFormalRound({
  reviewRound,
  resolutionReviewRound,
  resolutionStatus,
  resolutionValid,
  hasFormalManifest,
}) {
  return Number.isInteger(reviewRound)
    && reviewRound > 1
    && resolutionValid === true
    && resolutionStatus === "pass"
    && resolutionReviewRound === reviewRound
    && hasFormalManifest === false;
}

async function activeReviewVersionHasFormalManifest(caseDir, reviewVersion) {
  const versionRoot = path.join(caseDir, "work", "reviews", reviewVersion);
  let entries;
  try {
    entries = await fs.readdir(versionRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^round-\d+$/u.test(entry.name)) continue;
    if (await exists(path.join(versionRoot, entry.name, "manifest.json"))) return true;
  }
  return false;
}

async function verifyPreviousRepair(caseDir, reviewRound, currentHashes, currentClaimAuditorId, maximumRepairRounds, reviewVersion) {
  if (reviewRound === 1) return;
  const previousRound = reviewRound - 1;
  const previousRoot = path.join(caseDir, "work", "reviews", reviewVersion, roundDirectory(previousRound));
  const required = {
    manifest: path.join(previousRoot, "manifest.json"),
    consensus: path.join(previousRoot, "consensus.json"),
    repairLog: path.join(previousRoot, "repair-log.json"),
  };
  for (const [label, filePath] of Object.entries(required)) {
    if (!(await exists(filePath))) throw new Error(`创建 round-${String(reviewRound).padStart(2, "0")} 前缺少上一轮 ${label}。`);
  }
  const [previousManifest, consensus, repairLog] = await Promise.all([
    readJson(required.manifest),
    readJson(required.consensus),
    readJson(required.repairLog),
  ]);
  if (previousManifest.caseId !== path.basename(caseDir) || consensus.caseId !== previousManifest.caseId) {
    throw new Error("上一轮修复链的 caseId 与当前案例不一致。");
  }
  const freshAuditorError = freshClaimAuditorError(previousManifest, currentClaimAuditorId);
  if (freshAuditorError) throw new Error(freshAuditorError);
  if (consensus.status !== "repair_required") throw new Error("只有 repair_required 的上一轮才能进入新审核轮次。");
  const expectedRepairPath = caseRelative(caseDir, required.repairLog);
  if (previousManifest.artifacts?.repairLog !== expectedRepairPath) throw new Error("上一轮 repairLog 路径与 manifest 不一致。");
  const previousRepairer = previousManifest.assignments?.find((item) => item.role === "repair_editor")?.reviewerId;
  if (!Number.isInteger(repairLog.repairRound)
    || repairLog.repairRound < 1
    || repairLog.repairRound > maximumRepairRounds) {
    throw new Error("上一轮 repairLog.repairRound 未在案例级授权范围内。");
  }
  const supplementalRoot = path.join(
    caseDir,
    "work",
    "reviews",
    reviewVersion,
    "preflight",
    roundDirectory(repairLog.repairRound),
    `claim-audit-${repairLog.inputHashes?.evidence?.slice(0, 12)}`,
  );
  const supplementalPath = path.join(supplementalRoot, "claim-repair-log.json");
  const hasSupplementalClaimRepair = await exists(supplementalPath);
  const tracksEvidenceMigration = Object.hasOwn(repairLog.inputHashes ?? {}, "evidenceMigration")
    || Object.hasOwn(repairLog.outputHashes ?? {}, "evidenceMigration");
  const tracksClaimBundles = Object.hasOwn(repairLog.inputHashes ?? {}, "claimBundles")
    || Object.hasOwn(repairLog.outputHashes ?? {}, "claimBundles");
  const tracksThemeMap = Object.hasOwn(repairLog.inputHashes ?? {}, "themeMap")
    || Object.hasOwn(repairLog.outputHashes ?? {}, "themeMap");
  if (hasSupplementalClaimRepair) {
    const [supplementalLog, currentClaimReview] = await Promise.all([
      readJson(supplementalPath),
      readJson(path.join(caseDir, "work", "claim-review.json")),
    ]);
    const supplementalErrors = supplementalClaimRepairContractErrors(supplementalLog, {
      caseId: previousManifest.caseId,
      repairRound: repairLog.repairRound,
      reviewerId: repairLog.reviewerId,
      claimAuditorId: currentClaimAuditorId,
      claimReviewHash: sha256Value(currentClaimReview),
      inputHashes: {
        evidence: repairLog.inputHashes?.evidence,
        ...(tracksEvidenceMigration ? { evidenceMigration: repairLog.inputHashes?.evidenceMigration } : {}),
        ...(tracksClaimBundles ? { claimBundles: repairLog.inputHashes?.claimBundles } : {}),
        ...(tracksThemeMap ? { themeMap: repairLog.inputHashes?.themeMap } : {}),
        deepRead: repairLog.inputHashes?.deepRead,
        readerMap: repairLog.inputHashes?.readerMap,
      },
      outputHashes: {
        evidence: repairLog.outputHashes?.evidence,
        ...(tracksEvidenceMigration ? { evidenceMigration: repairLog.outputHashes?.evidenceMigration } : {}),
        ...(tracksClaimBundles ? { claimBundles: repairLog.outputHashes?.claimBundles } : {}),
        ...(tracksThemeMap ? { themeMap: repairLog.outputHashes?.themeMap } : {}),
        deepRead: repairLog.outputHashes?.deepRead,
        readerMap: repairLog.outputHashes?.readerMap,
      },
    });
    if (supplementalErrors.length) throw new Error(`补充 Repair Editor 日志非法：\n${supplementalErrors.join("\n")}`);
  }
  const repairErrors = repairLogContractErrors(repairLog, {
    caseId: previousManifest.caseId,
    reviewRound: previousRound,
    reviewerId: hasSupplementalClaimRepair ? repairLog.reviewerId : previousRepairer,
    consensusHash: sha256Value(consensus),
    evidenceBeforeHash: hasSupplementalClaimRepair ? repairLog.inputHashes?.evidence : previousManifest.inputHashes?.evidence,
    evidenceMigrationBeforeHash: tracksEvidenceMigration
      ? (hasSupplementalClaimRepair ? repairLog.inputHashes?.evidenceMigration : previousManifest.inputHashes?.evidenceMigration)
      : undefined,
    claimBundlesBeforeHash: tracksClaimBundles
      ? (hasSupplementalClaimRepair ? repairLog.inputHashes?.claimBundles : previousManifest.inputHashes?.claimBundles)
      : undefined,
    themeMapBeforeHash: tracksThemeMap
      ? (hasSupplementalClaimRepair ? repairLog.inputHashes?.themeMap : (previousManifest.inputHashes?.themeMap ?? repairLog.inputHashes?.themeMap))
      : undefined,
    deepReadBeforeHash: hasSupplementalClaimRepair ? repairLog.inputHashes?.deepRead : previousManifest.inputHashes?.deepRead,
    readerMapBeforeHash: hasSupplementalClaimRepair ? repairLog.inputHashes?.readerMap : previousManifest.inputHashes?.readerMap,
    researchBeforeHash: hasSupplementalClaimRepair ? repairLog.inputHashes?.research : previousManifest.inputHashes?.research,
    evidenceAfterHash: currentHashes.evidence,
    evidenceMigrationAfterHash: tracksEvidenceMigration ? currentHashes.evidenceMigration : undefined,
    claimBundlesAfterHash: tracksClaimBundles ? currentHashes.claimBundles : undefined,
    themeMapAfterHash: tracksThemeMap ? currentHashes.themeMap : undefined,
    deepReadAfterHash: currentHashes.deepRead,
    readerMapAfterHash: currentHashes.readerMap,
    researchAfterHash: currentHashes.research,
    maximumRepairRounds,
  });
  if (repairErrors.length) throw new Error(`上一轮 repair log 非法：\n${repairErrors.join("\n")}`);
}

export async function prepareClaimAuditPacket(caseDir, { reviewRound = 1, reviewerId } = {}) {
  if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new Error("reviewRound 必须为正整数。");
  if (String(reviewerId ?? "").trim().length < 2) throw new Error("--claims-only 必须用 --assign claim_auditor=<reviewerId> 指定独立审核员。");
  const [{ manifest }, pipeline] = await Promise.all([
    loadCase(caseDir),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
  ]);
  const reviewVersion = reviewWorkflowVersion(pipeline);
  const [normalized, segments, claims, coverage] = await Promise.all([
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "work", "coverage.json")),
  ]);
  const coverageErrors = coverageLedgerErrors(normalized, segments, coverage, {
    caseId: manifest.id,
    sourceHash: manifest.source.sha256,
  });
  if (coverageErrors.length) throw new Error(`claim audit 前 coverage 非法：\n${coverageErrors.join("\n")}`);
  const inputHashes = {
    segments: sha256Value(segments),
    evidence: sha256Value(claims),
  };
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const outputPath = "work/claim-review.json";
  const preflightRoot = path.join(
    caseDir,
    "work",
    "reviews",
    reviewVersion,
    "preflight",
    roundDirectory(reviewRound),
    `claim-audit-${inputHashes.evidence.slice(0, 12)}`,
  );
  const packet = {
    ...packetBase({
      manifest,
      workflowVersion: reviewVersion,
      reviewRound,
      role: "claim_auditor",
      reviewerId: String(reviewerId).trim(),
      inputHashes,
      outputPath,
      schemaPath: roleSchema("claim_auditor"),
      policy: {
        allowed: ["claims and their exact support source units"],
        forbidden: ["deep-read", "brief", "reader-map", "quality-report", "legacy evidence", "all other review reports"],
      },
    }),
    payload: { claims: claims.map((claim) => sourceUnitsForClaim(claim, sourceById)) },
  };
  const existingOutputPath = path.join(caseDir, outputPath);
  let existingOutput = null;
  let existingOutputErrors = null;
  let resolutionValid = false;
  if (await exists(existingOutputPath)) {
    existingOutput = await readJson(existingOutputPath);
    const resolutionPath = path.join(caseDir, "work", "claim-review-resolution.json");
    if (await exists(resolutionPath)) {
      const resolution = await readJson(resolutionPath);
      const [mechanicalFix, secondaryClaimReview, claimAdjudication] = await Promise.all([
        readResolutionDependency(caseDir, resolution, "mechanicalFix", "claim-mechanical-fix.json"),
        readResolutionDependency(caseDir, resolution, "secondaryClaimReview", "claim-review-secondary.json"),
        readResolutionDependency(caseDir, resolution, "adjudication", "claim-adjudication.json"),
      ]);
      existingOutputErrors = claimReviewResolutionContractErrors(resolution, {
        caseId: manifest.id,
        workflowVersion: manifest.workflow?.version,
        reviewRound,
        claims,
        segmentsHash: inputHashes.segments,
        evidenceHash: inputHashes.evidence,
        primary: existingOutput,
        mechanicalFix,
        secondary: secondaryClaimReview,
        adjudication: claimAdjudication,
      });
    } else {
      existingOutputErrors = ["缺少唯一通过凭证 work/claim-review-resolution.json。"];
    }
    resolutionValid = existingOutputErrors.length === 0;
    if (resolutionValid && existingOutput.reviewerId === String(reviewerId).trim() && existingOutput.reviewRound === reviewRound) {
      packet.existingOutput = { immutable: true, sha256: sha256Value(existingOutput) };
    }
  }
  const packetPath = path.join(preflightRoot, "packets", "claim_auditor.json");
  await writeJson(packetPath, packet);
  let reportSnapshotPath = null;
  if (existingOutput && (resolutionValid
    || (existingOutput.inputHashes?.segments === inputHashes.segments && existingOutput.inputHashes?.evidence === inputHashes.evidence))) {
    reportSnapshotPath = path.join(preflightRoot, "claim-review.json");
    await writeJson(reportSnapshotPath, existingOutput);
  }
  return { packetPath, packet, inputHashes, reportSnapshotPath, existingOutputErrors };
}

function buildInitialReviewPackets({
  caseManifest,
  reviewManifest,
  reviewRound,
  inputHashes,
  normalized,
  segments,
  claims,
  deepRead,
  deepMarkdown,
  claimReview,
  research,
  pipeline,
  profilePrompt,
}) {
  const assignedByRole = assignmentMap(reviewManifest.assignments);
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const eligibleLeaves = [...eligibleReaderLeaves(deepRead).values()];
  const fidelityLeaves = [...fidelityReaderLeaves(deepRead).values()];
  const readerLeaves = [...readerLeafIndex(deepRead).values()];
  const coverageClaims = coverageClaimsForReview(claims, deepRead, reviewManifest.workflowVersion);
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const citationById = new Map((research?.citations ?? []).map((citation) => [citation.id, citation]));
  const strippedMarkdown = stripReaderReferences(deepMarkdown);
  const base = (role, hashes, policy) => packetBase({
    manifest: caseManifest,
    workflowVersion: reviewManifest.workflowVersion,
    reviewRound,
    role,
    reviewerId: assignedByRole.get(role),
    inputHashes: hashes,
    outputPath: roleArtifact(reviewManifest, role),
    schemaPath: roleSchema(role),
    policy,
  });
  return {
    claim_auditor: {
      ...base("claim_auditor", { segments: inputHashes.segments, evidence: inputHashes.evidence }, {
        allowed: ["claims and their exact support source units"],
        forbidden: ["deep-read", "reader-map", "coverage reports", "quality-report", "overwriting the completed claim-review"],
      }),
      existingOutput: { immutable: true, sha256: sha256Value(claimReview) },
      payload: { claims: claims.map((claim) => sourceUnitsForClaim(claim, sourceById)) },
    },
    blind_recall: {
      ...base("blind_recall", { segments: inputHashes.segments }, {
        allowed: ["segments and normalized source units"],
        forbidden: ["evidence", "reader-map", "deep-read", "all review reports"],
      }),
      payload: {
        blindToEvidence: true,
        profile: caseManifest.profile,
        segments: segments.map((segment) => ({
          ...segment,
          sourceUnits: (segment.sourceIds ?? []).map((sourceId) => sourceById.get(sourceId)).filter(Boolean),
        })),
      },
    },
    alignment: {
      ...base("alignment", { evidence: inputHashes.evidence, blindCandidates: null }, {
        allowed: ["evidence now; blind-candidates only after refresh"],
        forbidden: ["deep-read", "reader-map", "coverage reports", "author notes"],
      }),
      needsBlindRecall: true,
      payload: { claims, blindCandidates: null },
    },
    coverage_a: {
      ...base("coverage_a", { evidence: inputHashes.evidence, deepRead: inputHashes.deepRead }, {
        allowed: ["claims selected by the active coverage scope", "eligible reader leaves without evidence references"],
        forbidden: ["reader-map", "coverage_b", "fidelity", "quality-report", "source transcript"],
      }),
      payload: { blindToReaderMap: true, blindToPeerReview: true, claims: coverageClaims.map(coverageClaim), readerLeaves: eligibleLeaves.map(stripLeafReferences) },
    },
    coverage_b: {
      ...base("coverage_b", { evidence: inputHashes.evidence, deepRead: inputHashes.deepRead }, {
        allowed: ["claims selected by the active coverage scope", "eligible reader leaves without evidence references"],
        forbidden: ["reader-map", "coverage_a", "fidelity", "quality-report", "source transcript"],
      }),
      payload: { blindToReaderMap: true, blindToPeerReview: true, claims: coverageClaims.map(coverageClaim), readerLeaves: eligibleLeaves.map(stripLeafReferences) },
    },
    fidelity: {
      ...base("fidelity", { evidence: inputHashes.evidence, deepRead: inputHashes.deepRead, research: inputHashes.research }, {
        allowed: ["all auditable reader leaves", "declared evidence", "exact support source units", "declared external citation records and research checks"],
        forbidden: ["coverage_a", "coverage_b", "reader-map", "reader review", "quality-report"],
      }),
      payload: {
        readerLeaves: fidelityLeaves.map((leaf) => ({
          ...stripParentBlockId(leaf),
          evidence: (leaf.evidenceRefs ?? []).map((ref) => claimById.get(ref)).filter(Boolean)
            .map((claim) => sourceUnitsForClaim(claim, sourceById)),
          citations: (leaf.citationRefs ?? []).map((ref) => citationById.get(ref)).filter(Boolean),
          researchChecks: (research?.checks ?? []).filter((check) =>
            (check.citationRefs ?? []).some((ref) => (leaf.citationRefs ?? []).includes(ref))),
        })),
      },
    },
    reader_advocate: {
      ...base("reader_advocate", { deepRead: inputHashes.deepRead, readerMarkdown: sha256Text(strippedMarkdown) }, {
        allowed: ["reader markdown without evidence links", "reader leaves without evidence references", "profile rules", "audience"],
        forbidden: ["evidence", "reader-map", "coverage metrics", "quality-report", "all other review reports"],
      }),
      payload: {
        evidenceBlind: true,
        title: caseManifest.title,
        audience: pipeline.audience,
        profile: caseManifest.profile,
        profileRules: profilePrompt,
        readerMarkdown: strippedMarkdown,
        readerLeaves: readerLeaves.map(stripLeafReferences),
      },
    },
  };
}

export async function prepareReviewRound(caseDir, { reviewRound = 1, assignments } = {}) {
  const [{ manifest: caseManifest }, pipeline] = await Promise.all([
    loadCase(caseDir),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
  ]);
  const reviewVersion = reviewWorkflowVersion(pipeline);
  const assigned = normalizedAssignments(assignments);
  const assignedByRole = assignmentMap(assigned);
  const reviewRoot = path.join(caseDir, "work", "reviews", reviewVersion, roundDirectory(reviewRound));
  if (await exists(reviewRoot)) throw new Error(`审核轮次已存在，拒绝覆盖：${caseRelative(caseDir, reviewRoot)}`);

  const files = {
    normalized: path.join(caseDir, "work", "source.normalized.jsonl"),
    segments: path.join(caseDir, "work", "segments.jsonl"),
    coverage: path.join(caseDir, "work", "coverage.json"),
    evidence: path.join(caseDir, "work", "evidence.jsonl"),
    deepRead: path.join(caseDir, "output", "deep-read.json"),
    deepMarkdown: path.join(caseDir, "output", "deep-read.md"),
    readerMap: path.join(caseDir, "work", "reader-map.json"),
    research: path.join(caseDir, "work", "research.json"),
    claimReview: path.join(caseDir, "work", "claim-review.json"),
    claimReviewResolution: path.join(caseDir, "work", "claim-review-resolution.json"),
    claimBundles: path.join(caseDir, "work", "claim-bundles.json"),
    themeMap: path.join(caseDir, "work", "theme-map.json"),
    evidenceMigration: path.join(caseDir, "work", "evidence-migration.json"),
    profilePrompt: path.join(REPO_ROOT, "prompts", "profiles", `${caseManifest.profile.primary}.md`),
  };
  if (!(await exists(files.claimReview))) {
    throw new Error("缺少独立预审产物 work/claim-review.json；必须先完成 claim audit，再创建完整审核轮次。");
  }
  if (!(await exists(files.claimReviewResolution))) {
    throw new Error("缺少 Claim Gate 通过凭证 work/claim-review-resolution.json；必须先完成 claim resolution。 ");
  }
  if (!(await exists(files.claimBundles))) {
    throw new Error("缺少预写作产物 work/claim-bundles.json；请先完成 claim bundle 编排，再创建审核轮次。");
  }
  const hasEvidenceMigration = await exists(files.evidenceMigration);
  const [normalized, segments, coverage, claims, deepRead, deepMarkdown, readerMap, claimReview, claimReviewResolution, claimBundles, themeMap, evidenceMigration, research, profilePrompt] = await Promise.all([
    readJsonLines(files.normalized),
    readJsonLines(files.segments),
    readJson(files.coverage),
    readJsonLines(files.evidence),
    readJson(files.deepRead),
    fs.readFile(files.deepMarkdown, "utf8"),
    readJson(files.readerMap),
    readJson(files.claimReview),
    readJson(files.claimReviewResolution),
    readJson(files.claimBundles),
    readJson(files.themeMap),
    hasEvidenceMigration ? readJson(files.evidenceMigration) : Promise.resolve(null),
    readJson(files.research),
    fs.readFile(files.profilePrompt, "utf8"),
  ]);
  const [mechanicalFix, secondaryClaimReview, claimAdjudication] = await Promise.all([
    readResolutionDependency(caseDir, claimReviewResolution, "mechanicalFix", "claim-mechanical-fix.json"),
    readResolutionDependency(caseDir, claimReviewResolution, "secondaryClaimReview", "claim-review-secondary.json"),
    readResolutionDependency(caseDir, claimReviewResolution, "adjudication", "claim-adjudication.json"),
  ]);
  const inputHashes = {
    segments: sha256Value(segments),
    evidence: sha256Value(claims),
    claimReview: sha256Value(claimReview),
    claimReviewResolution: sha256Value(claimReviewResolution),
    deepRead: sha256Value(deepRead),
    readerMap: sha256Value(readerMap),
    claimBundles: sha256Value(claimBundles),
    themeMap: sha256Value(themeMap),
    research: sha256Value(research),
    ...(evidenceMigration ? { evidenceMigration: sha256Value(evidenceMigration) } : {}),
  };
  const coverageErrors = coverageLedgerErrors(normalized, segments, coverage, {
    caseId: caseManifest.id,
    sourceHash: caseManifest.source.sha256,
  });
  if (coverageErrors.length) throw new Error(`完整审核前 coverage 非法：\n${coverageErrors.join("\n")}`);
  const claimBundleErrors = claimBundleContractErrors(claimBundles, {
    caseId: caseManifest.id,
    claims,
    claimReviewHash: sha256Value(claimReview),
    evidenceHash: inputHashes.evidence,
    deepRead,
    readerMap,
  });
  if (claimBundleErrors.length) throw new Error(`claim bundles 非法：\n${claimBundleErrors.join("\n")}`);
  const claimReviewErrors = claimReviewResolutionContractErrors(claimReviewResolution, {
    caseId: caseManifest.id,
    workflowVersion: caseManifest.workflow?.version,
    reviewRound,
    claims,
    segmentsHash: inputHashes.segments,
    evidenceHash: inputHashes.evidence,
    primary: claimReview,
    mechanicalFix,
    secondary: secondaryClaimReview,
    adjudication: claimAdjudication,
  });
  if (claimReview.reviewerId !== assignedByRole.get("claim_auditor")) claimReviewErrors.push("claim-review reviewerId 与本轮 assignment 不一致。");
  if (claimReview.reviewRound !== reviewRound) claimReviewErrors.push("claim-review reviewRound 与待创建轮次不一致。");
  if (claimReviewErrors.length) throw new Error(`claim review 非法：\n${claimReviewErrors.join("\n")}`);
  const oldEvidencePath = path.join(caseDir, "legacy", "workflow-2.1.0", "work", "evidence.jsonl");
  if (evidenceMigration) {
    if (!(await exists(oldEvidencePath))) throw new Error("存在 evidence-migration.json，但缺少 workflow-2.1.0 旧证据基线。");
    const oldClaims = await readJsonLines(oldEvidencePath);
    const migrationErrors = evidenceMigrationContractErrors(evidenceMigration, {
      caseId: caseManifest.id,
      oldClaims,
      newClaims: claims,
    });
    if (migrationErrors.length) throw new Error(`evidence migration 非法：\n${migrationErrors.join("\n")}`);
  } else if (await exists(oldEvidencePath)) {
    throw new Error("存在 workflow-2.1.0 证据基线，但缺少 work/evidence-migration.json。");
  }
  const hasFormalManifest = await activeReviewVersionHasFormalManifest(caseDir, reviewVersion);
  const startsInitialFormalRound = mayStartInitialFormalRound({
    reviewRound,
    resolutionReviewRound: claimReviewResolution.reviewRound,
    resolutionStatus: claimReviewResolution.status,
    resolutionValid: claimReviewErrors.length === 0,
    hasFormalManifest,
  });
  if (!startsInitialFormalRound) {
    await verifyPreviousRepair(
      caseDir,
      reviewRound,
      inputHashes,
      assignedByRole.get("claim_auditor"),
      repairRoundLimitForCase(pipeline, caseManifest),
      reviewVersion,
    );
  }
  const manifest = {
    schemaVersion: "1.0.0",
    caseId: caseManifest.id,
    workflowVersion: reviewVersion,
    reviewRound,
    createdAt: new Date().toISOString(),
    assignments: assigned,
    inputHashes,
    artifacts: artifactPaths(caseDir, reviewRoot, { hasEvidenceMigration }),
  };
  const manifestErrors = reviewManifestContractErrors(manifest, {
    caseId: caseManifest.id,
    inputHashes,
    workflowVersion: reviewVersion,
    requireClaimReviewResolution: true,
  });
  if (manifestErrors.length) throw new Error(`review manifest 非法：\n${manifestErrors.join("\n")}`);

  const packets = buildInitialReviewPackets({
    caseManifest,
    reviewManifest: manifest,
    reviewRound,
    inputHashes,
    normalized,
    segments,
    claims,
    deepRead,
    deepMarkdown,
    claimReview,
    research,
    pipeline,
    profilePrompt,
  });

  const packetRecords = {};
  for (const role of INITIAL_PACKET_ROLES) packetRecords[role] = await writePacket(caseDir, reviewRoot, role, packets[role]);
  const packetIndex = {
    schemaVersion: "1.0.0",
    caseId: caseManifest.id,
    workflowVersion: reviewVersion,
    reviewRound,
    createdAt: new Date().toISOString(),
    alignmentReady: false,
    packets: packetRecords,
  };
  await Promise.all([
    writeJson(path.join(reviewRoot, "claim-review.json"), claimReview),
    writeJson(path.join(reviewRoot, "claim-review-resolution.json"), claimReviewResolution),
    writeJson(path.join(reviewRoot, "manifest.json"), manifest),
    writeJson(path.join(reviewRoot, "packet-index.json"), packetIndex),
  ]);
  return { reviewRoot, manifest, packetIndex };
}

export async function rebuildReviewPackets(caseDir, reviewRound) {
  const pipeline = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const reviewVersion = reviewWorkflowVersion(pipeline);
  const reviewRoot = path.join(caseDir, "work", "reviews", reviewVersion, roundDirectory(reviewRound));
  const manifestPath = path.join(reviewRoot, "manifest.json");
  if (!(await exists(manifestPath))) throw new Error(`缺少待重建轮次的 manifest：${caseRelative(caseDir, manifestPath)}`);
  const [reviewManifest, { manifest: caseManifest }] = await Promise.all([
    readJson(manifestPath),
    loadCase(caseDir),
  ]);
  if (reviewManifest.reviewRound !== reviewRound || reviewManifest.caseId !== caseManifest.id) {
    throw new Error("review manifest 与待重建案例或轮次不一致。");
  }
  const claimReviewPath = resolveCasePath(caseDir, reviewManifest.artifacts.claimReview, "claimReview artifact");
  const claimReviewResolutionPath = resolveCasePath(caseDir, reviewManifest.artifacts.claimReviewResolution, "claimReviewResolution artifact");
  const claimBundlesPath = resolveCasePath(caseDir, reviewManifest.artifacts.claimBundles, "claimBundles artifact");
  const themeMapPath = reviewManifest.artifacts.themeMap
    ? resolveCasePath(caseDir, reviewManifest.artifacts.themeMap, "themeMap artifact")
    : path.join(caseDir, "work", "theme-map.json");
  const files = {
    normalized: path.join(caseDir, "work", "source.normalized.jsonl"),
    segments: path.join(caseDir, "work", "segments.jsonl"),
    coverage: path.join(caseDir, "work", "coverage.json"),
    evidence: path.join(caseDir, "work", "evidence.jsonl"),
    deepRead: path.join(caseDir, "output", "deep-read.json"),
    deepMarkdown: path.join(caseDir, "output", "deep-read.md"),
    readerMap: path.join(caseDir, "work", "reader-map.json"),
    research: path.join(caseDir, "work", "research.json"),
    profilePrompt: path.join(REPO_ROOT, "prompts", "profiles", `${caseManifest.profile.primary}.md`),
  };
  const [normalized, segments, coverage, claims, deepRead, deepMarkdown, readerMap, claimReview, claimReviewResolution, claimBundles, themeMap, research, profilePrompt] = await Promise.all([
    readJsonLines(files.normalized),
    readJsonLines(files.segments),
    readJson(files.coverage),
    readJsonLines(files.evidence),
    readJson(files.deepRead),
    fs.readFile(files.deepMarkdown, "utf8"),
    readJson(files.readerMap),
    readJson(claimReviewPath),
    readJson(claimReviewResolutionPath),
    readJson(claimBundlesPath),
    readJson(themeMapPath),
    readJson(files.research),
    fs.readFile(files.profilePrompt, "utf8"),
  ]);
  const [mechanicalFix, secondaryClaimReview, claimAdjudication] = await Promise.all([
    readResolutionDependency(caseDir, claimReviewResolution, "mechanicalFix", "claim-mechanical-fix.json"),
    readResolutionDependency(caseDir, claimReviewResolution, "secondaryClaimReview", "claim-review-secondary.json"),
    readResolutionDependency(caseDir, claimReviewResolution, "adjudication", "claim-adjudication.json"),
  ]);
  let evidenceMigration = null;
  if (reviewManifest.artifacts.evidenceMigration) {
    evidenceMigration = await readJson(resolveCasePath(caseDir, reviewManifest.artifacts.evidenceMigration, "evidenceMigration artifact"));
  }
  const currentHashes = {
    segments: sha256Value(segments),
    evidence: sha256Value(claims),
    claimReview: sha256Value(claimReview),
    claimReviewResolution: sha256Value(claimReviewResolution),
    deepRead: sha256Value(deepRead),
    readerMap: sha256Value(readerMap),
    claimBundles: sha256Value(claimBundles),
    ...(Object.hasOwn(reviewManifest.inputHashes ?? {}, "themeMap") ? { themeMap: sha256Value(themeMap) } : {}),
    research: sha256Value(research),
    ...(evidenceMigration ? { evidenceMigration: sha256Value(evidenceMigration) } : {}),
  };
  const coverageErrors = coverageLedgerErrors(normalized, segments, coverage, {
    caseId: caseManifest.id,
    sourceHash: caseManifest.source.sha256,
  });
  if (coverageErrors.length) throw new Error(`不能为 coverage 非法的审核轮次重建 packet：\n${coverageErrors.join("\n")}`);
  const manifestErrors = reviewManifestContractErrors(reviewManifest, {
    caseId: caseManifest.id,
    inputHashes: currentHashes,
    workflowVersion: reviewVersion,
    requireClaimReviewResolution: true,
  });
  manifestErrors.push(...claimReviewResolutionContractErrors(claimReviewResolution, {
    caseId: caseManifest.id,
    workflowVersion: caseManifest.workflow?.version,
    reviewRound,
    claims,
    segmentsHash: currentHashes.segments,
    evidenceHash: currentHashes.evidence,
    primary: claimReview,
    mechanicalFix,
    secondary: secondaryClaimReview,
    adjudication: claimAdjudication,
  }));
  if (manifestErrors.length) throw new Error(`不能为过期审核轮次重建 packet：\n${manifestErrors.join("\n")}`);
  const packets = buildInitialReviewPackets({
    caseManifest,
    reviewManifest,
    reviewRound,
    inputHashes: currentHashes,
    normalized,
    segments,
    claims,
    deepRead,
    deepMarkdown,
    claimReview,
    research,
    pipeline,
    profilePrompt,
  });
  const packetRecords = {};
  for (const role of INITIAL_PACKET_ROLES) packetRecords[role] = await writePacket(caseDir, reviewRoot, role, packets[role]);
  const packetIndex = {
    schemaVersion: "1.0.0",
    caseId: caseManifest.id,
    workflowVersion: reviewVersion,
    reviewRound,
    createdAt: reviewManifest.createdAt,
    alignmentReady: false,
    packets: packetRecords,
  };
  await writeJson(path.join(reviewRoot, "packet-index.json"), packetIndex);
  const blindPath = resolveCasePath(caseDir, reviewManifest.artifacts.blindCandidates, "blindCandidates artifact");
  if (await exists(blindPath)) await refreshAlignmentPacket(caseDir, reviewRound, { allowExistingReport: true });
  return { reviewRoot, packetIndex: await readJson(path.join(reviewRoot, "packet-index.json")) };
}

export async function refreshAlignmentPacket(caseDir, reviewRound, { allowExistingReport = false } = {}) {
  const pipeline = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const reviewRoot = path.join(caseDir, "work", "reviews", reviewWorkflowVersion(pipeline), roundDirectory(reviewRound));
  const [manifest, packetIndex] = await Promise.all([
    readJson(path.join(reviewRoot, "manifest.json")),
    readJson(path.join(reviewRoot, "packet-index.json")),
  ]);
  if (manifest.reviewRound !== reviewRound || packetIndex.reviewRound !== reviewRound) {
    throw new Error("manifest、packet index 与待刷新的审核轮次不一致。");
  }
  if (packetIndex.alignmentReady) throw new Error("alignment packet 已完成 refresh；拒绝重复刷新。");
  const blindPath = resolveCasePath(caseDir, manifest.artifacts.blindCandidates, "blindCandidates artifact");
  const alignmentPath = resolveCasePath(caseDir, manifest.artifacts.blindAlignment, "blindAlignment artifact");
  if (blindPath !== path.join(reviewRoot, "blind-candidates.json") || alignmentPath !== path.join(reviewRoot, "blind-alignment.json")) {
    throw new Error("blind/alignment artifact 必须位于当前固定审核轮次目录。");
  }
  if (!(await exists(blindPath))) throw new Error("blind_recall 尚未输出 blind-candidates.json。");
  if (!allowExistingReport && await exists(alignmentPath)) throw new Error("blind-alignment 已存在；拒绝在其输入完成后改写 packet。");
  const [candidates, claims, segments] = await Promise.all([
    readJson(blindPath),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
  ]);
  const candidateErrors = blindCandidateContractErrors(candidates, {
    caseId: manifest.caseId,
    segmentsHash: sha256Value(segments),
  });
  if (candidates.reviewerId !== manifest.assignments.find((item) => item.role === "blind_recall")?.reviewerId) candidateErrors.push("blind_recall reviewerId 与 manifest assignment 不一致。");
  if (candidates.reviewRound !== reviewRound) candidateErrors.push("blind_recall reviewRound 与当前轮次不一致。");
  if (candidateErrors.length) throw new Error(`blind candidates 非法：\n${candidateErrors.join("\n")}`);
  const alignmentRecord = packetIndex.packets?.alignment;
  if (!alignmentRecord) throw new Error("packet index 缺少 alignment 占位 packet。");
  const packetPath = resolveCasePath(caseDir, alignmentRecord.path, "alignment packet");
  if (await sha256File(packetPath) !== alignmentRecord.sha256) throw new Error("alignment 占位 packet hash 不一致。");
  const packet = await readJson(packetPath);
  if (packet.caseId !== manifest.caseId || packet.reviewRound !== reviewRound || packet.role !== "alignment") {
    throw new Error("alignment 占位 packet 身份不一致。");
  }
  if (packet.assignedReviewerId !== manifest.assignments.find((item) => item.role === "alignment")?.reviewerId) {
    throw new Error("alignment 占位 packet reviewer assignment 已过期。");
  }
  if (packet.needsBlindRecall !== true || packet.payload?.blindCandidates !== null || packet.inputHashes?.blindCandidates !== null) {
    throw new Error("alignment packet 不是合法的待刷新占位状态。");
  }
  if (packet.inputHashes?.evidence !== sha256Value(claims) || sha256Value(packet.payload?.claims ?? []) !== sha256Value(claims)) {
    throw new Error("alignment 占位 packet 的 evidence 已过期或被改写。");
  }
  packet.needsBlindRecall = false;
  packet.inputHashes.blindCandidates = sha256Value(candidates);
  packet.payload.blindCandidates = candidates;
  await writeJson(packetPath, packet);
  packetIndex.alignmentReady = true;
  packetIndex.packets.alignment = {
    path: caseRelative(caseDir, packetPath),
    sha256: await sha256File(packetPath),
    ready: true,
    dependencies: [{ path: manifest.artifacts.blindCandidates, sha256: await sha256File(blindPath) }],
  };
  packetIndex.updatedAt = new Date().toISOString();
  await writeJson(path.join(reviewRoot, "packet-index.json"), packetIndex);
  return { reviewRoot, candidateCount: candidates.entries.length };
}

function parseCli(argv) {
  const result = { caseArgument: argv[0], reviewRound: 1, sourceRound: null, refresh: false, claimsOnly: false, claimsDelta: false, rebuildPackets: false, repairDiagnostic: false, assignmentsFile: null, assignments: {} };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--round") result.reviewRound = Number(argv[++index]);
    else if (argument === "--source-round") result.sourceRound = Number(argv[++index]);
    else if (argument === "--refresh") result.refresh = true;
    else if (argument === "--claims-only") result.claimsOnly = true;
    else if (argument === "--claims-delta") result.claimsDelta = true;
    else if (argument === "--rebuild-packets") result.rebuildPackets = true;
    else if (argument === "--repair-diagnostic") result.repairDiagnostic = true;
    else if (argument === "--assignments") result.assignmentsFile = argv[++index];
    else if (argument === "--assign") {
      const [role, ...idParts] = String(argv[++index] ?? "").split("=");
      if (Object.hasOwn(result.assignments, role)) throw new Error(`重复 --assign：${role}`);
      result.assignments[role] = idParts.join("=");
    } else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const caseDir = resolveCaseDir(options.caseArgument);
    const selectedModes = [options.claimsOnly, options.claimsDelta, options.rebuildPackets, options.repairDiagnostic].filter(Boolean).length;
    if (selectedModes > 1) throw new Error("--refresh、--claims-only、--claims-delta 与 --rebuild-packets 只能选择一个。");
    if (options.repairDiagnostic) {
      if (options.assignmentsFile) throw new Error("--repair-diagnostic 只接受显式 --assign，不能使用 assignments 文件。");
      const allowed = new Set(["blind_recall", "alignment", "fidelity", "repair_editor"]);
      const unknown = Object.keys(options.assignments).filter((role) => !allowed.has(role));
      if (unknown.length) throw new Error(`--repair-diagnostic 不接受角色：${unknown.join("、")}`);
      if (options.refresh) {
        const result = await refreshRepairDiagnostic(caseDir, options.reviewRound);
        console.log(`repair diagnostic alignment 已刷新（${result.candidateCount} 个 blind candidates）。`);
      } else {
        const result = await prepareRepairDiagnostic(caseDir, {
          repairRound: options.reviewRound,
          sourceRound: options.sourceRound,
          assignments: options.assignments,
        });
        console.log(`已生成只追加 repair diagnostic：${caseRelative(caseDir, result.root)}`);
        console.log("Blind Recall 完成后使用相同参数并追加 --refresh。");
      }
    } else if (options.rebuildPackets) {
      if (options.assignmentsFile || Object.keys(options.assignments).length) throw new Error("--rebuild-packets 使用既有 manifest 分工，不接受 assignments。");
      const result = await rebuildReviewPackets(caseDir, options.reviewRound);
      console.log(`已从保留的 manifest 重建隔离 packets：${caseRelative(caseDir, result.reviewRoot)}`);
      console.log("若该轮包含动态 adjudicator/repair_editor packet，请重新运行 review-consensus 以按保留报告重建。");
    } else if (options.claimsDelta) {
      if (options.assignmentsFile) throw new Error("--claims-delta 不接受 --assignments；请只指定 claim_auditor。");
      const unknownRoles = Object.keys(options.assignments).filter((role) => role !== "claim_auditor");
      if (unknownRoles.length) throw new Error(`--claims-delta 不接受其他角色：${unknownRoles.join("、")}`);
      const result = await prepareClaimsDeltaPacket(caseDir, {
        reviewRound: options.reviewRound,
        reviewerId: options.assignments.claim_auditor,
      });
      console.log(`已生成增量 Claim Auditor packet：${caseRelative(caseDir, result.packetPath)}`);
    } else if (options.claimsOnly) {
      if (options.assignmentsFile) throw new Error("--claims-only 不接受 --assignments；请只指定 claim_auditor。");
      const unknownRoles = Object.keys(options.assignments).filter((role) => role !== "claim_auditor");
      if (unknownRoles.length) throw new Error(`--claims-only 不接受其他角色：${unknownRoles.join("、")}`);
      const result = await prepareClaimAuditPacket(caseDir, {
        reviewRound: options.reviewRound,
        reviewerId: options.assignments.claim_auditor,
      });
      console.log(`已生成 Claim Auditor 隔离 packet：${caseRelative(caseDir, result.packetPath)}`);
      if (result.reportSnapshotPath) {
        console.log(`已保留当前哈希的 Claim Auditor 报告：${caseRelative(caseDir, result.reportSnapshotPath)}（${result.existingOutputErrors.length ? "待修复" : "通过"}）`);
      }
    } else if (options.refresh) {
      const result = await refreshAlignmentPacket(caseDir, options.reviewRound);
      console.log(`alignment packet 已刷新（${result.candidateCount} 个 blind candidates）。`);
    } else {
      let assignments = options.assignments;
      if (options.assignmentsFile && Object.keys(options.assignments).length) throw new Error("--assignments 与 --assign 不得混用。");
      if (options.assignmentsFile) assignments = await readJson(path.resolve(REPO_ROOT, options.assignmentsFile));
      const result = await prepareReviewRound(caseDir, { reviewRound: options.reviewRound, assignments });
      console.log(`已生成 7 类隔离 packet：${caseRelative(caseDir, result.reviewRoot)}`);
      console.log(`blind_recall 完成后运行：node scripts/review-prepare.mjs ${toPosix(path.relative(REPO_ROOT, caseDir))} --round ${options.reviewRound} --refresh`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

