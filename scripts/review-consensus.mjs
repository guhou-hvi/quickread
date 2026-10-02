import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isMain,
  readJson,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
  writeJson,
} from "./lib.mjs";
import {
  adjudicationContractErrors,
  blindRecallMetrics,
  eligibleReaderLeaves,
  fidelityEntryHardReasons,
  readerLeafIndex,
  repairRoundLimitForCase,
  reviewWorkflowVersion,
  sha256Value,
} from "./review-contract.mjs";
import { validateReviewRound } from "./review-validate.mjs";
import { computeRepairDiagnosticConsensus } from "./review-diagnostic.mjs";

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

async function optionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function common(first = [], second = []) {
  const other = new Set(second);
  return [...new Set(first)].filter((value) => other.has(value));
}

function coverageMap(review) {
  return new Map((review?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
}

function fidelityMap(review) {
  return new Map((review?.entries ?? []).map((entry) => [entry.readerBlockRef, entry]));
}

function assignment(manifest, role) {
  return manifest.assignments.find((item) => item.role === role)?.reviewerId;
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

function claimWithSourceUnits(claim, sourceById) {
  return {
    ...claim,
    supportSpans: (claim.supportSpans ?? []).map((span) => ({
      ...span,
      sourceUnits: (span.sourceIds ?? []).map((sourceId) => sourceById.get(sourceId)).filter(Boolean),
    })),
  };
}

function collectRefs(value, { evidenceRefs, readerBlockRefs }) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, { evidenceRefs, readerBlockRefs });
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.evidenceRef === "string") evidenceRefs.add(value.evidenceRef);
  for (const ref of value.evidenceRefs ?? []) evidenceRefs.add(ref);
  for (const ref of value.matchedEvidenceRefs ?? []) evidenceRefs.add(ref);
  if (typeof value.readerBlockRef === "string") readerBlockRefs.add(value.readerBlockRef);
  for (const ref of value.readerBlockRefs ?? []) readerBlockRefs.add(ref);
  for (const child of Object.values(value)) collectRefs(child, { evidenceRefs, readerBlockRefs });
}

export function buildRepairPayload(validation, {
  reviewRound,
  repairAttempt = reviewRound,
  maximumRepairRounds,
  failures,
  agreedNotCovered,
  adjudicationReport,
  verified,
}) {
  const { manifest, artifacts, source, packets } = validation;
  const themeMapHash = manifest.inputHashes.themeMap ?? sha256Value(artifacts.themeMap);
  const evidenceRefs = new Set();
  const readerBlockRefs = new Set();
  collectRefs(failures, { evidenceRefs, readerBlockRefs });
  for (const evidenceRef of evidenceRefs) for (const span of (source.readerMap.entries ?? []).find((entry) => entry.evidenceRef === evidenceRef)?.coverageSpans ?? []) {
    readerBlockRefs.add(span.readerBlockRef);
  }
  const readerFailure = failures.find((failure) => failure.gate === "reader_advocate");
  const leaves = readerLeafIndex(source.deepRead);
  if (readerFailure?.issues?.some((issue) => !(issue.readerBlockRefs?.length))) for (const ref of leaves.keys()) readerBlockRefs.add(ref);
  const sourceById = new Map(source.normalized.map((unit) => [unit.id, unit]));
  const failedClaims = source.claims
    .filter((claim) => evidenceRefs.has(claim.id))
    .map((claim) => claimWithSourceUnits(claim, sourceById));
  const allowedOutputPaths = [
    "work/evidence.jsonl",
    ...(artifacts.evidenceMigration ? ["work/evidence-migration.json"] : []),
    ...(artifacts.claimBundles ? ["work/claim-bundles.json"] : []),
    ...(artifacts.themeMap ? ["work/theme-map.json"] : []),
    "output/deep-read.json",
    "work/reader-map.json",
    "work/research.json",
    manifest.artifacts.repairLog,
  ];
  return {
    sourceReviewRound: reviewRound,
    repairRound: repairAttempt,
    maximumRepairRounds,
    failures,
    agreedNotCovered,
    verifiedMappings: verified,
    failedClaims,
    readerLeaves: [...readerBlockRefs].map((ref) => leaves.get(ref)).filter(Boolean),
    reviews: {
      coverageA: artifacts.coverageA,
      coverageB: artifacts.coverageB,
      adjudication: adjudicationReport,
      fidelity: artifacts.fidelityReview,
      blindIssues: failures.find((failure) => failure.gate === "blind_recall")?.issues ?? [],
      readerIssues: readerFailure?.issues ?? [],
    },
    referenceFreeReaderEdition: packets.get("reader_advocate")?.payload?.readerMarkdown ?? null,
    editableSnapshots: {
      evidence: { path: "work/evidence.jsonl", sha256: manifest.inputHashes.evidence, format: "jsonl", value: source.claims },
      ...(artifacts.evidenceMigration ? {
        evidenceMigration: { path: "work/evidence-migration.json", sha256: manifest.inputHashes.evidenceMigration, format: "json", value: artifacts.evidenceMigration },
      } : {}),
      ...(artifacts.claimBundles ? {
        claimBundles: { path: "work/claim-bundles.json", sha256: manifest.inputHashes.claimBundles, format: "json", value: artifacts.claimBundles },
      } : {}),
      ...(artifacts.themeMap ? {
        themeMap: { path: "work/theme-map.json", sha256: themeMapHash, format: "json", value: artifacts.themeMap },
      } : {}),
      deepRead: { path: "output/deep-read.json", sha256: manifest.inputHashes.deepRead, format: "json", value: source.deepRead },
      readerMap: { path: "work/reader-map.json", sha256: manifest.inputHashes.readerMap, format: "json", value: source.readerMap },
      research: { path: "work/research.json", sha256: manifest.inputHashes.research, format: "json", value: source.research },
    },
    allowedOutputPaths,
    constraints: [
      "只使用本 packet 内嵌的审核发现、来源单元、reader leaves、读者版与可编辑快照。",
      "不得用主题 thesis 自动兜底未覆盖 claim，也不得把 evidence statement 或 ASR 口语逐条倾倒进 reader prose。",
      "只能写入 allowedOutputPaths；修复后必须创建下一 review round，本轮审核报告不得复用为放行依据。",
    ],
  };
}

function readerMapBlocks(readerMap, evidenceRef) {
  const entry = (readerMap.entries ?? []).find((item) => item.evidenceRef === evidenceRef);
  return new Set((entry?.coverageSpans ?? []).map((span) => span.readerBlockRef));
}

function fidelityApprovedBlocks(fidelityByBlock, evidenceRef, blockRefs, {
  schemaVersion = "1.0.0",
  research = { citations: [], checks: [] },
} = {}) {
  return blockRefs.filter((blockRef) => {
    const review = fidelityByBlock.get(blockRef);
    return review &&
      fidelityEntryHardReasons(review, { schemaVersion, research }).length === 0 &&
      review.evidenceRefs?.includes(evidenceRef);
  });
}

function conflictForClaim(claim, first, second, minimumConfidence) {
  const reasons = [];
  const triggers = [];
  const commonBlocks = first.verdict === "covered" && second.verdict === "covered"
    ? common(first.readerBlockRefs, second.readerBlockRefs)
    : [];
  if (first.verdict === second.verdict && first.verdict !== "covered") {
    return { evidenceRef: claim.id, claim, reasons, triggers, commonBlocks, coverageA: first, coverageB: second };
  }
  if (first.verdict !== second.verdict) {
    reasons.push("verdict_conflict");
    triggers.push("verdict_conflict");
  }
  if (first.verdict === "covered" && second.verdict === "covered" && !commonBlocks.length) {
    reasons.push("no_common_block");
    triggers.push("block_conflict");
  }
  if (first.confidence < minimumConfidence || second.confidence < minimumConfidence) {
    reasons.push("low_confidence");
    triggers.push("low_confidence");
  }
  if (first.verdict === "contradicted" || second.verdict === "contradicted") {
    reasons.push("contradiction");
    triggers.push("contradiction");
  }
  if (first.issueType !== "none" || second.issueType !== "none") {
    reasons.push("issue_type");
    triggers.push("issue_type");
  }
  return {
    evidenceRef: claim.id,
    claim,
    reasons: [...new Set(reasons)],
    triggers: [...new Set(triggers)],
    commonBlocks,
    coverageA: first,
    coverageB: second,
  };
}

export function dynamicPacketResources(role) {
  const schemaPath = {
    adjudicator: "schemas/adjudication.schema.json",
    repair_editor: "schemas/repair-log.schema.json",
  }[role];
  const promptPath = {
    adjudicator: "prompts/reviews/adjudicator.md",
    repair_editor: "prompts/reviews/repair-editor.md",
  }[role];
  if (!schemaPath || !promptPath) throw new Error(`不支持动态审核角色：${role}`);
  return {
    schemaPath,
    outputContract: JSON.parse(readFileSync(path.join(REPO_ROOT, schemaPath), "utf8")),
    reviewInstructions: readFileSync(path.join(REPO_ROOT, promptPath), "utf8"),
  };
}

async function installDynamicPacket(caseDir, validation, role, payload, { consensusHash = null } = {}) {
  const { reviewRoot, manifest, packetIndex } = validation;
  if (role === "repair_editor" && !/^[a-f0-9]{64}$/u.test(consensusHash ?? "")) {
    throw new Error("repair_editor packet 必须绑定当前 consensus 的 SHA-256。");
  }
  const outputPath = role === "adjudicator" ? manifest.artifacts.adjudication : manifest.artifacts.repairLog;
  const { schemaPath, outputContract, reviewInstructions } = dynamicPacketResources(role);
  if (role === "repair_editor") {
    outputContract.properties.repairRound.maximum = payload.maximumRepairRounds;
  }
  const packet = {
    schemaVersion: "1.0.0",
    caseId: manifest.caseId,
    workflowVersion: manifest.workflowVersion,
    reviewRound: manifest.reviewRound,
    role,
    assignedReviewerId: assignment(manifest, role),
    inputHashes: role === "adjudicator"
      ? {
          evidence: manifest.inputHashes.evidence,
          deepRead: manifest.inputHashes.deepRead,
          coverageA: sha256Value(validation.artifacts.coverageA),
          coverageB: sha256Value(validation.artifacts.coverageB),
        }
      : {
          consensus: consensusHash,
          evidence: manifest.inputHashes.evidence,
          ...(manifest.inputHashes.evidenceMigration ? { evidenceMigration: manifest.inputHashes.evidenceMigration } : {}),
          ...(manifest.inputHashes.claimBundles ? { claimBundles: manifest.inputHashes.claimBundles } : {}),
          ...(payload.editableSnapshots?.themeMap ? { themeMap: payload.editableSnapshots.themeMap.sha256 } : {}),
          deepRead: manifest.inputHashes.deepRead,
          readerMap: manifest.inputHashes.readerMap,
          research: manifest.inputHashes.research,
        },
    output: {
      path: outputPath,
      schema: schemaPath,
      contract: outputContract,
      dependencies: {},
      ...(role === "repair_editor" ? { allowedOutputPaths: payload.allowedOutputPaths } : {}),
    },
    reviewInstructions,
    inputPolicy: {
      isolation: "packet-only",
      instruction: role === "adjudicator"
        ? "只读取本 packet 的 payload、reviewInstructions 与 output.contract，并只裁决列出的覆盖分歧；不得读取作者讨论、无争议 claim 或其他内容审核材料，也不得覆盖 fidelity 硬门。"
        : "只读取本 packet 的 payload、reviewInstructions 与 output.contract；只使用内嵌快照修复列出的失败，只能写 allowedOutputPaths。不得读取案例中的旧稿、brief、quality report、其他 packet 或其他审核材料。",
      ...(role === "repair_editor" ? { forbidden: [
        "案例目录中的旧稿或旧版 deep read",
        "brief 与 quality report",
        "其他 review packet 或 packet 外审核报告",
        "packet 外来源与自行扩大的新任务",
      ] } : {}),
    },
    payload,
  };
  if (packetIndex.packets?.[role]) {
    const existingPath = resolveCasePath(caseDir, packetIndex.packets[role].path, `${role} packet`);
    const existing = await readJson(existingPath);
    if (sha256Value(existing) !== sha256Value(packet)) {
      throw new Error(`${role} packet 已绑定不同输入；不得在同一审核轮次内覆盖，请创建下一轮。`);
    }
    return existingPath;
  }
  const packetPath = path.join(reviewRoot, "packets", `${role}.json`);
  await writeJson(packetPath, packet);
  packetIndex.packets[role] = {
    path: caseRelative(caseDir, packetPath),
    sha256: await sha256File(packetPath),
    ready: true,
  };
  packetIndex.updatedAt = new Date().toISOString();
  await writeJson(path.join(reviewRoot, "packet-index.json"), packetIndex);
  return packetPath;
}

function adjudicationProblems(adjudication, conflicts, context) {
  const errors = adjudicationContractErrors(adjudication, context);
  const decisions = new Map((adjudication?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  for (const conflict of conflicts) {
    const decision = decisions.get(conflict.evidenceRef);
    if (!decision) {
      errors.push(`adjudication 缺少冲突 claim：${conflict.evidenceRef}`);
      continue;
    }
    for (const trigger of conflict.triggers) if (!decision.triggers?.includes(trigger)) errors.push(`adjudication ${conflict.evidenceRef} 缺少 trigger：${trigger}`);
  }
  for (const ref of decisions.keys()) if (!conflicts.some((conflict) => conflict.evidenceRef === ref)) errors.push(`adjudication 越界裁决无争议 claim：${ref}`);
  return [...new Set(errors)];
}

export function stableConsensusGeneratedAt(previousConsensus, caseId, reviewRound, now = new Date().toISOString()) {
  return previousConsensus?.caseId === caseId
    && previousConsensus?.reviewRound === reviewRound
    && typeof previousConsensus?.generatedAt === "string"
    && previousConsensus.generatedAt.length > 0
    ? previousConsensus.generatedAt
    : now;
}

export function consensusStatusForPolicy({ hardErrors = [], reviewRound, repairAttempt = reviewRound, maximumRepairRounds }) {
  if (!hardErrors.length) return "pass";
  return repairAttempt > maximumRepairRounds ? "human_required" : "repair_required";
}

export async function computeReviewConsensus(caseDir, reviewRound, { write = true, repairAttempt = reviewRound } = {}) {
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const reviewVersion = reviewWorkflowVersion(config);
  const stableConsensusPath = path.join(caseDir, "work", "reviews", reviewVersion, `round-${String(reviewRound).padStart(2, "0")}`, "consensus.json");
  const previousConsensus = await optionalJson(stableConsensusPath);
  const validation = await validateReviewRound(caseDir, reviewRound, {
    requireReports: true,
    requireAdjudication: false,
    includeAdjudication: false,
  });
  const generatedAt = stableConsensusGeneratedAt(previousConsensus, validation.manifest?.caseId, reviewRound);
  if (!validation.manifest) return {
    schemaVersion: "1.0.0",
    caseId: path.basename(caseDir),
    workflowVersion: reviewVersion,
    reviewRound,
    generatedAt,
    status: "invalid",
    errors: validation.errors,
  };
  const { manifest, artifacts, source, reviewRoot } = validation;
  const configuredRepairRounds = repairRoundLimitForCase(config, manifest.caseId);
  const retainedRepairRounds = validation.packets.get("repair_editor")?.payload?.maximumRepairRounds;
  const maximumRepairRounds = retainedRepairRounds ?? configuredRepairRounds;
  const minimumConfidence = config.reviews?.minimumCoverageConfidence ?? 0.8;
  const denseBlockThreshold = config.reviews?.claimBundleHardMaximum ?? 10;
  const allRecallTarget = config.qualityGates?.allClaimRecall ?? 0.95;
  const hardErrors = [...(validation.hardErrors ?? validation.reportFailures ?? [])];
  const diagnostics = [...(validation.diagnostics ?? [])];
  const warnings = [...(validation.warnings ?? [])];
  // Compatibility: downstream repair payloads still consume failures, but in
  // 2.3 this collection contains concrete hard errors only.
  const failures = hardErrors;

  const missingReports = [
    "claimReview",
    "claimReviewResolution",
    "blindCandidates",
    "blindAlignment",
    "coverageA",
    "coverageB",
    "fidelityReview",
    "readerReview",
  ].filter((key) => !artifacts[key]);
  if (missingReports.length) {
    const result = {
      schemaVersion: "1.0.0",
      caseId: manifest.caseId,
      workflowVersion: reviewVersion,
      reviewRound,
      generatedAt,
      status: "invalid",
      errors: [...validation.errors, `必需审核报告不完整：${missingReports.join(", ")}。`],
    };
    if (write) await writeJson(path.join(reviewRoot, "consensus.json"), result);
    return result;
  }
  // Strict contract failures (including a missing confidence field) stop the
  // semantic pass immediately. Invalid reports never enter voting or adjudication.
  if (validation.errors.length) {
    const result = {
      schemaVersion: "1.0.0",
      caseId: manifest.caseId,
      workflowVersion: reviewVersion,
      reviewRound,
      generatedAt,
      status: "invalid",
      failures: [],
      errors: validation.errors,
    };
    if (write) await writeJson(path.join(reviewRoot, "consensus.json"), result);
    return result;
  }

  const recall = blindRecallMetrics(artifacts.blindCandidates, artifacts.blindAlignment);

  const coverageA = coverageMap(artifacts.coverageA);
  const coverageB = coverageMap(artifacts.coverageB);
  const fidelityByBlock = fidelityMap(artifacts.fidelityReview);
  const bodyRefs = new Set([...eligibleReaderLeaves(source.deepRead).values()]
    .flatMap((leaf) => leaf.evidenceRefs ?? []));
  const requiredClaims = source.claims.filter((claim) => bodyRefs.has(claim.id));
  const conflicts = [];
  const agreedNotCovered = [];
  const preliminary = new Map();
  for (const claim of requiredClaims) {
    const first = coverageA.get(claim.id);
    const second = coverageB.get(claim.id);
    const conflict = conflictForClaim(claim, first, second, minimumConfidence);
    if (conflict.reasons.length) {
      conflicts.push(conflict);
      continue;
    }
    if (first.verdict !== "covered") {
      agreedNotCovered.push({ evidenceRef: claim.id, verdict: first.verdict });
      continue;
    }
    preliminary.set(claim.id, conflict.commonBlocks);
  }

  const blockLoads = new Map();
  for (const claim of requiredClaims) for (const blockRef of readerMapBlocks(source.readerMap, claim.id)) {
    if (!blockLoads.has(blockRef)) blockLoads.set(blockRef, []);
    blockLoads.get(blockRef).push(claim.id);
  }
  const denseBlocks = [...blockLoads]
    .filter(([, refs]) => refs.length > denseBlockThreshold)
    .map(([readerBlockRef, refs]) => ({ readerBlockRef, claimCount: refs.length }));
  if (denseBlocks.length) {
    diagnostics.push({
      gate: "dense_block",
      severity: "warning",
      enforced: false,
      threshold: denseBlockThreshold,
      entries: denseBlocks,
    });
    warnings.push(`${denseBlocks.length} reader blocks exceed the diagnostic claim-density target.`);
  }
  const contradictedAgreements = agreedNotCovered.filter((entry) => entry.verdict === "contradicted");
  const quantitativeCoverageGaps = agreedNotCovered.filter((entry) => entry.verdict !== "contradicted");
  if (contradictedAgreements.length) hardErrors.push({
    gate: "semantic_coverage",
    kind: "contradicted",
    entries: contradictedAgreements,
  });
  if (quantitativeCoverageGaps.length) diagnostics.push({
    gate: "semantic_coverage",
    kind: "not_covered",
    severity: "warning",
    enforced: false,
    entries: quantitativeCoverageGaps,
  });

  let adjudicationStatus = "not_needed";
  let adjudicationErrors = [];
  let adjudicationReport = null;
  if (conflicts.length) {
    const adjudicationPath = resolveCasePath(caseDir, manifest.artifacts.adjudication, "adjudication artifact");
    adjudicationReport = await optionalJson(adjudicationPath);
    const leaves = eligibleReaderLeaves(source.deepRead);
    const adjudicatorPayload = {
      conflicts: conflicts.map((conflict) => ({
        evidenceRef: conflict.evidenceRef,
        triggers: conflict.triggers,
        reasons: conflict.reasons,
        claim: coverageClaim(conflict.claim),
        coverageA: conflict.coverageA,
        coverageB: conflict.coverageB,
        candidateReaderLeaves: [...new Set([
          ...(conflict.coverageA?.readerBlockRefs ?? []),
          ...(conflict.coverageB?.readerBlockRefs ?? []),
        ])].map((ref) => leaves.get(ref)).filter(Boolean).map(({ evidenceRefs: _evidenceRefs, citationRefs: _citationRefs, blockId: _blockId, ...leaf }) => leaf),
      })),
    };
    if (!adjudicationReport) {
      adjudicationStatus = "pending";
      diagnostics.push({
        gate: "coverage_adjudication",
        severity: "warning",
        enforced: false,
        conflictCount: conflicts.length,
        payload: adjudicatorPayload,
      });
      warnings.push(`${conflicts.length} coverage conflicts remain available for optional adjudication.`);
    } else {
      adjudicationStatus = "complete";
      if (adjudicationReport.reviewerId !== assignment(manifest, "adjudicator")) adjudicationErrors.push("adjudicator.reviewerId 与 review manifest assignment 不一致。");
      if (adjudicationReport.reviewRound !== reviewRound) adjudicationErrors.push("adjudication.reviewRound 与当前轮次不一致。");
      adjudicationErrors.push(...adjudicationProblems(adjudicationReport, conflicts, {
        caseId: manifest.caseId,
        claims: source.claims,
        deepRead: source.deepRead,
        coverageA: artifacts.coverageA,
        coverageB: artifacts.coverageB,
        evidenceHash: manifest.inputHashes.evidence,
        deepReadHash: manifest.inputHashes.deepRead,
        forbiddenReviewerIds: [assignment(manifest, "coverage_a"), assignment(manifest, "coverage_b"), assignment(manifest, "repair_editor")],
        confidenceThreshold: minimumConfidence,
      }));
      if (adjudicationErrors.length) {
        failures.push({ gate: "adjudication", errors: adjudicationErrors });
      } else {
        const decisions = coverageMap(adjudicationReport);
        for (const conflict of conflicts) {
          const decision = decisions.get(conflict.evidenceRef);
          if (decision.verdict === "covered" && decision.confidence >= minimumConfidence && decision.issueType === "none") {
            preliminary.set(conflict.evidenceRef, decision.readerBlockRefs);
          } else if (decision.verdict === "contradicted") {
            hardErrors.push({
              gate: "semantic_coverage",
              kind: "contradicted",
              evidenceRef: conflict.evidenceRef,
              verdict: decision.verdict,
            });
          } else {
            diagnostics.push({
              gate: "semantic_coverage",
              kind: "adjudicated_not_covered",
              severity: "warning",
              enforced: false,
              evidenceRef: conflict.evidenceRef,
              verdict: decision.verdict,
            });
          }
        }
      }
    }
  }

  if (adjudicationErrors.length) {
    const result = {
      schemaVersion: "1.0.0",
      caseId: manifest.caseId,
      workflowVersion: reviewVersion,
      reviewRound,
      generatedAt,
      status: "invalid",
      failures: [],
      errors: adjudicationErrors,
    };
    if (write) await writeJson(path.join(reviewRoot, "consensus.json"), result);
    return result;
  }

  const verified = [];
  for (const [evidenceRef, blocks] of preliminary) {
    const declaredBlocks = readerMapBlocks(source.readerMap, evidenceRef);
    const candidateBlocks = blocks.filter((blockRef) => declaredBlocks.has(blockRef));
    const supportedBlocks = fidelityApprovedBlocks(fidelityByBlock, evidenceRef, candidateBlocks, {
      schemaVersion: artifacts.fidelityReview.schemaVersion,
      research: source.research,
    });
    if (!supportedBlocks.length) {
      diagnostics.push({
        gate: "fidelity_crosscheck",
        severity: "warning",
        enforced: false,
        evidenceRef,
        readerBlockRefs: blocks,
      });
      continue;
    }
    verified.push({ evidenceRef, readerBlockRefs: supportedBlocks });
  }
  const verifiedCoverage = requiredClaims.length ? verified.length / requiredClaims.length : 1;
  if (verifiedCoverage < 1) diagnostics.push({
    gate: "verified_semantic_coverage",
    severity: "warning",
    enforced: false,
    actual: verifiedCoverage,
    target: 1,
  });

  const status = consensusStatusForPolicy({ hardErrors, reviewRound, repairAttempt, maximumRepairRounds });

  const consensus = {
    schemaVersion: "1.0.0",
    caseId: manifest.caseId,
    workflowVersion: reviewVersion,
    reviewRound,
    repairAttempt,
    generatedAt,
    status,
    gates: {
      contracts: { pass: !validation.errors.length, errorCount: validation.errors.length },
      blindRecall: {
        ...recall,
        enforced: false,
        pass: true,
        meetsTarget: recall.allRecall >= allRecallTarget && recall.highMediumRecall === 1,
      },
      coverage: {
        highMediumCount: requiredClaims.length,
        verifiedCount: verified.length,
        adjudicatedSemanticCoverage: verifiedCoverage,
        agreementFailureCount: agreedNotCovered.length,
        conflictCount: conflicts.length,
        denseBlockCount: [...blockLoads.values()].filter((refs) => refs.length > denseBlockThreshold).length,
        adjudicationStatus,
        enforced: false,
        pass: true,
        meetsTarget: verifiedCoverage === 1 && adjudicationStatus !== "pending",
      },
      fidelity: {
        reviewedBlockCount: artifacts.fidelityReview.entries.length,
        pass: !hardErrors.some((failure) => failure.gate === "fidelity"),
      },
      readerAdvocate: {
        verdict: artifacts.readerReview?.verdict ?? null,
        scores: artifacts.readerReview?.scores ?? null,
        enforced: false,
        pass: true,
        meetsTarget: !diagnostics.some((entry) => entry.gate === "reader_advocate"),
      },
    },
    verifiedMappings: verified,
    conflicts: conflicts.map(({ claim: _claim, coverageA: _a, coverageB: _b, ...entry }) => entry),
    failures,
    hardErrors,
    diagnostics,
    warnings,
    errors: adjudicationErrors,
  };

  if (write && status === "repair_required") await installDynamicPacket(caseDir, validation, "repair_editor", buildRepairPayload(validation, {
    reviewRound,
    repairAttempt,
    maximumRepairRounds,
    failures,
    agreedNotCovered,
    adjudicationReport,
    verified,
  }), { consensusHash: sha256Value(consensus) });
  if (write) await writeJson(path.join(reviewRoot, "consensus.json"), consensus);
  return consensus;
}

function parseCli(argv) {
  const result = { caseArgument: argv[0], reviewRound: 1, repairAttempt: null, dryRun: false, repairDiagnostic: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--round") result.reviewRound = Number(argv[++index]);
    else if (argv[index] === "--repair-attempt") result.repairAttempt = Number(argv[++index]);
    else if (argv[index] === "--dry-run") result.dryRun = true;
    else if (argv[index] === "--repair-diagnostic") result.repairDiagnostic = true;
    else throw new Error(`未知参数：${argv[index]}`);
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const caseDir = resolveCaseDir(options.caseArgument);
    const result = options.repairDiagnostic
      ? await computeRepairDiagnosticConsensus(caseDir, options.reviewRound, { write: !options.dryRun })
      : await computeReviewConsensus(caseDir, options.reviewRound, {
          write: !options.dryRun,
          repairAttempt: options.repairAttempt ?? options.reviewRound,
        });
    for (const failure of result.failures ?? []) console.error(`FAIL  ${failure.gate}`);
    for (const error of result.errors ?? []) console.error(`ERROR ${error}`);
    console.log(`${result.status.toUpperCase()} ${toPosix(path.relative(REPO_ROOT, caseDir))} ${options.repairDiagnostic ? "repair diagnostic consensus" : "review consensus"}`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
