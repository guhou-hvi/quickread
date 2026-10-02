import fs from "node:fs/promises";
import path from "node:path";
import {
  isMain,
  loadCase,
  normalizeText,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";
import {
  readabilityMetrics,
  readerMapContractErrors,
  sourceDerivedDeepCharacters,
} from "./deep-read.mjs";
import {
  adaptiveTargets,
  collectBlockCharacters,
  densityErrors,
  expectedReadingMinutes,
  isContiguousSourceSpan,
  nearDuplicateClaimIds,
  roundRate,
} from "./workflow-contract.mjs";
import {
  blindAlignmentContractErrors,
  blindCandidateContractErrors,
  blindRecallMetrics,
  claimBundleContractErrors,
  claimReviewResolutionContractErrors,
  evidenceMigrationContractErrors,
  fidelityReviewContractErrors,
  fidelityReviewGateFailures,
  readerReviewContractErrors,
  readerReviewGateFailures,
  reviewManifestContractErrors,
  reviewWorkflowVersion,
  sha256Value,
} from "./review-contract.mjs";
import { coverageLedgerFindings } from "./segment-source.mjs";
import { computeReviewConsensus } from "./review-consensus.mjs";
import {
  readerFirstInputHashes,
  readerFirstReviewContractErrors,
} from "./reader-first-review.mjs";
import { participantGuideCharacters } from "./participant-guide.mjs";
import { participantGuideReviewRecordErrors } from "./participant-guide-review.mjs";
import {
  contextGuideCharacters,
  contextGuideContractErrors,
  contextGuideUsageErrors,
  contextInlineCharacters,
  countContextReferences,
  selectContextGuideEntries,
} from "./context-guide.mjs";
import { validateContextGuideReview } from "./context-guide-review.mjs";
import { validateClaimOrganizationWarningResolution } from "./claim-gate.mjs";
import {
  latestCompletedLiteReviewRound,
  liteReviewConsensusFromValidation,
  validateLiteReview,
} from "./reader-review-v240.mjs";

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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function formalReviewHardErrorMessages(consensus) {
  return (consensus?.hardErrors ?? []).map((failure) => {
    if (typeof failure === "string") return failure;
    const gate = failure?.gate ?? "review";
    const kind = failure?.kind ? `/${failure.kind}` : "";
    return `Review hard error [${gate}${kind}]: ${JSON.stringify(failure)}`;
  });
}

function coverageDiagnosticMetrics(consensus, ...reviews) {
  const refsByVerdict = Object.fromEntries(
    ["partial", "missing", "contradicted", "unreviewable"].map((verdict) => [verdict, new Set()]),
  );
  for (const review of reviews) for (const entry of review?.entries ?? []) {
    refsByVerdict[entry.verdict]?.add(entry.evidenceRef);
  }
  return {
    adjudicatedSemanticCoverage: consensus?.gates?.coverage?.adjudicatedSemanticCoverage ?? 0,
    partialCount: refsByVerdict.partial.size,
    missingCount: refsByVerdict.missing.size,
    contradictedCount: refsByVerdict.contradicted.size,
    unreviewableCount: refsByVerdict.unreviewable.size,
    unresolvedCount: consensus?.gates?.coverage?.conflictCount ?? 0,
  };
}

/*
const QUANTITATIVE_REVIEW_ERROR_PATTERNS = [
  /requiredReaderRefs/u,
  /evidence_only/u,
  /claim bundle .kg� claim/u,
  /eligible reader block .*claim bundle/u,
  /claim bundles .*claim/u,
  /�w^~)�t\/�w^~)�u claim .*covered/u,
  /coverage .*�w^~)�w�/u,
  q�w^~)�t block/u,
  /dense_block/u,
  ��ƺw^~)�v block/u,
];
*/
const QUANTITATIVE_REVIEW_ERROR_PATTERNS = [
  /requiredReaderRefs/u,
  /evidence_only/u,
  /claim bundle .*\u6ca1\u6709\u6b63\u6587 claim/u,
  /claim bundle .*\u627f\u63a5.*\u6b63\u6587 claim/u,
  /eligible reader block .*\u7f3a\u5c11 claim bundle/u,
  /claim bundles .*\u7f3a\u5c11 claim/u,
  /coverage \u5171\u8bc6/u,
  /dense_block/u,
  /\u9ad8\u5bc6\u5ea6 block/u,
  /Blind Recall/u,
  /segment \u8986\u76d6\u7387/u,
  /claim \u652f\u6301\u7387/u,
  /\u8fd1\u91cd\u590d claim \u6bd4\u4f8b/u,
  /\u6b63\u6587\u5f15\u7528\u8986\u76d6\u7387/u,
  /\u8bed\u4e49\u8986\u76d6\u7387/u,
  /\u8bc1\u636e\u518c claim \u6536\u5f55\u7387/u,
  /\u666e\u901a\u6bb5\u843d/u,
  /\u5217\u8868/u,
  /\u8fd1\u91cd\u590d\u7387/u,
  /ASR/u,
  /\u5bfc\u822a\u65f6\u95f4\u7ebf/u,
  /\u5bfc\u822a\u8282\u70b9/u,
  /QR-Pilot.*\u76f8\u90bb/u,
  /QR-Pilot.*\u6570\u91cf/u,
];

export function partitionReviewErrors(values) {
  const hardErrors = [];
  const diagnostics = [];
  for (const value of values ?? []) {
    if (QUANTITATIVE_REVIEW_ERROR_PATTERNS.some((pattern) => pattern.test(value))) diagnostics.push(value);
    else hardErrors.push(value);
  }
  return { hardErrors, diagnostics };
}

function addBlockRefs(block, target) {
  for (const ref of block.evidenceRefs ?? []) target.add(ref);
  for (const paragraph of block.paragraphs ?? []) for (const ref of paragraph.evidenceRefs ?? []) target.add(ref);
  for (const item of block.items ?? []) for (const ref of item.evidenceRefs ?? []) target.add(ref);
}

function unlabelledAdditionCount(deepRead, brief) {
  let count = 0;
  for (const section of deepRead.sections ?? []) {
    for (const module of section.modules ?? []) {
      for (const block of module.blocks ?? []) {
        if (block.type !== "participant_guide" && block.provenance === "external"
          && !(block.citationRefs?.length
            || block.paragraphs?.some((item) => item.citationRefs?.length)
            || block.items?.some((item) => item.citationRefs?.length))) count += 1;
        if (block.provenance === "editorial" && block.type !== "editor_note") count += 1;
      }
    }
  }
  for (const section of brief.sections ?? []) {
    for (const block of section.blocks ?? []) {
      if (block.provenance === "external"
        && !(block.citationRefs?.length || block.items?.some((item) => item.citationRefs?.length))) count += 1;
      if (block.provenance === "editorial" && block.type !== "editor_note") count += 1;
    }
  }
  return count;
}

export function humanReviewResult(review, config, isPilot, caseId) {
  if (!isPilot) return { required: false, status: "not-required", scores: null, errors: [] };
  if (!review) return {
    required: true,
    status: "pending",
    scores: null,
    errors: ["试点案例尚未完成用户集中六维校审。"],
  };
  const errors = [];
  if (review.schemaVersion !== "1.1.0" || review.caseId !== caseId) errors.push("人工评分的 schemaVersion 或 caseId 不一致。");
  if (review.reviewerType !== "human") errors.push("最终校审必须明确由 human 完成，Agent 审核不能替代用户校审。");
  if (!review.reviewer?.trim() || !review.reviewedAt) errors.push("人工评分缺少审核者或时间。");
  if (/^(?:agent[-_]|qr-pilot|ai\b)/iu.test(review.reviewer?.trim() ?? "")) errors.push("人工评分 reviewer 不得使用 Agent 身份。");
  if (review.decision !== "pass") errors.push("人工审核 decision 尚未标记为 pass。");
  for (const dimension of config.migration.humanReviewDimensions) {
    const score = review.scores?.[dimension];
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      errors.push(`人工评分 ${dimension} 必须为 1–5；评分仅用于记录，不构成自动门槛。`);
    }
  }
  return { required: true, status: errors.length ? "fail" : "pass", scores: review.scores ?? null, errors };
}

function resolveInsideCase(caseDir, roundDir, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error(`${label} 必须是案例内的安全相对路径。`);
  }
  const fromCase = path.resolve(caseDir, relativePath);
  const fromRound = path.resolve(roundDir, relativePath);
  const candidate = relativePath.startsWith("work/") || relativePath.startsWith("output/") ? fromCase : fromRound;
  const relative = path.relative(caseDir, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出案例目录。`);
  return candidate;
}

async function latestReviewRound(caseDir, reviewVersion) {
  const root = path.join(caseDir, "work", "reviews", reviewVersion);
  if (!(await exists(root))) return null;
  const rounds = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^round-\d{2}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return rounds.length ? path.join(root, rounds.at(-1)) : null;
}

async function loadReviewArtifact(caseDir, roundDir, manifest, key, { required = true } = {}) {
  const relativePath = manifest?.artifacts?.[key];
  if (!relativePath) {
    if (required) throw new Error(`review manifest 缺少 artifacts.${key}。`);
    return null;
  }
  const artifactPath = resolveInsideCase(caseDir, roundDir, relativePath, `artifacts.${key}`);
  if (!(await exists(artifactPath))) {
    if (required) throw new Error(`review artifact 不存在：${relativePath}`);
    return null;
  }
  return readJson(artifactPath);
}

function emptyReviewState(error) {
  return {
    round: null,
    status: "missing",
    manifest: null,
    declaredConsensus: null,
    claimAudit: { reviewedCount: 0, errorCount: 0, status: "missing" },
    blindRecall: {
      candidateCount: 0,
      matchedCount: 0,
      allRecall: 0,
      highMediumCandidateCount: 0,
      highMediumMatchedCount: 0,
      highMediumRecall: 0,
    },
    fidelity: { status: "missing" },
    readerAdvocate: { status: "missing", scores: null },
    claimBundles: { count: 0, maximumReaderClaims: 0 },
    staleCount: 0,
    hardErrors: [error],
    diagnostics: [],
    warnings: [],
    errors: [error],
  };
}

export async function loadReviewState(caseDir, {
  manifest: caseManifest,
  segments,
  claims,
  deepRead,
  readerMap,
  readerMarkdown,
  config,
}) {
  const configuredReviewVersion = reviewWorkflowVersion(config);
  const warningProof = await validateClaimOrganizationWarningResolution(caseDir, {
    manifest: caseManifest, claims, segments,
    baseline: await optionalJson(path.join(caseDir, "work", "evidence-baseline.json")),
  });
  if (warningProof.errors.length) return emptyReviewState(warningProof.errors.join("\n"));
  let reviewVersion = configuredReviewVersion;
  if (["2.4.1", "2.4.2"].includes(configuredReviewVersion) && caseManifest.workflow?.version === "2.4.0") reviewVersion = "2.4.0";
  if (configuredReviewVersion === "2.4.2" && caseManifest.workflow?.version === "2.4.1") reviewVersion = "2.4.1";
  const hasContextGuide = await exists(path.join(caseDir, "work", "context-guide.json"));
  if (["2.4.1", "2.4.2"].includes(reviewVersion) && caseManifest.workflow?.version === reviewVersion && hasContextGuide) {
    const contextReviewPath = path.join(caseDir, "work", "reviews", reviewVersion, "context-guide", "review.json");
    if (!(await exists(contextReviewPath))) return emptyReviewState(`缺少 work/reviews/${reviewVersion}/context-guide/review.json 增量关键名词审核记录。`);
    try {
      const [record, checked, claimsBaseline, participantRecord] = await Promise.all([
        readJson(contextReviewPath),
        validateContextGuideReview(caseDir, { policyVersion: reviewVersion }),
        optionalJson(path.join(caseDir, "work", "evidence-baseline.json")),
        optionalJson(path.join(caseDir, "work", "reviews", "2.4.0", "participant-guide", "review.json")),
      ]);
      const errors = [...checked.errors];
      if (record.schemaVersion !== "1.0.0" || record.caseId !== caseManifest.id || record.reviewPolicyVersion !== reviewVersion) {
        errors.push("关键名词增量审核的 schema、caseId 或 reviewPolicyVersion 不一致。");
      }
      if (claimsBaseline?.hashes?.evidence && claimsBaseline.hashes.evidence !== sha256Value(claims)) {
        errors.push("当前 evidence 与已接受基线不一致，不能按 Context Guide 增量审核继承内容审核。");
      }
      if (participantRecord?.inputHashes?.participantGuide) {
        const currentGuide = await optionalJson(path.join(caseDir, "work", "participant-guide.json"));
        if (participantRecord.inputHashes.participantGuide !== sha256Value(currentGuide)) errors.push("人物导览已变化，不能沿用 2.4.0 人物审核。");
      }
      const baselinePath = path.resolve(caseDir, record.baselineReview ?? "");
      if (!baselinePath.startsWith(`${path.resolve(caseDir)}${path.sep}`) || !(await exists(baselinePath))) errors.push("Context Guide baselineReview 缺失或路径越界。");
      const nestedHardErrors = checked.reports.flatMap((report) => report.hardErrors ?? []);
      const hardErrors = unique([...errors, ...(record.hardErrors ?? []), ...nestedHardErrors]);
      const warnings = unique([...(record.warnings ?? []), ...checked.reports.flatMap((report) => report.warnings ?? []),
        ...warningProof.warnings.map((entry) => `${entry.evidenceRef}: supported compound-claim organization advice retained as a nonblocking warning (2.4.2).`)]);
      const fidelity = checked.reports.find((report) => report.role === "fidelity");
      const reader = checked.reports.find((report) => report.role === "reader_advocate");
      return {
        round: `retained accepted baseline + ${reviewVersion} inline context-guide`,
        status: hardErrors.length ? "fail" : "pass",
        manifest: { contextGuide: checked.manifest, retainedBaseline: record.baselineReview },
        declaredConsensus: { status: hardErrors.length ? "fail" : "pass", hardErrors, warnings, diagnostics: [], metrics: {} },
        claimAudit: { reviewedCount: 0, errorCount: 0, status: "inherited_unchanged_evidence" },
        blindRecall: { candidateCount: 0, matchedCount: 0, allRecall: 0, highMediumCandidateCount: 0, highMediumMatchedCount: 0, highMediumRecall: 0, status: "diagnostic_not_rerun" },
        fidelity: { status: fidelity?.status ?? "missing", errorCount: fidelity?.hardErrors?.length ?? 0, reviewedBlockCount: 0 },
        readerAdvocate: { status: reader?.status ?? "missing", scores: null },
        claimBundles: { count: 0, maximumReaderClaims: 0 },
        staleCount: errors.filter((error) => /过期|哈希|基线|变化/u.test(error)).length,
        hardErrors,
        diagnostics: [{ gate: "context_guide_incremental_review", evidenceUnchanged: true, repairAttemptContribution: 0 }],
        warnings,
        errors: hardErrors,
      };
    } catch (error) {
      return emptyReviewState(`无法读取或验证 ${reviewVersion} Context Guide 增量审核：${error.message}`);
    }
  }
  if (["2.4.0", "2.4.1", "2.4.2"].includes(reviewVersion) && caseManifest.workflow?.version === reviewVersion) {
    const incrementalPath = path.join(caseDir, "work", "reviews", "2.4.0", "participant-guide", "review.json");
    const requiresParticipants = caseManifest.sourceType !== "article" || await exists(path.join(caseDir, "work", "participant-guide.json"));
    if (requiresParticipants && !(await exists(incrementalPath))) {
      return emptyReviewState("缺少 work/reviews/2.4.0/participant-guide/review.json 增量人物导览审核记录。");
    }
    try {
      const [record, claimsBaseline] = await Promise.all([
        optionalJson(incrementalPath),
        optionalJson(path.join(caseDir, "work", "evidence-baseline.json")),
      ]);
      const errors = [];
      if (record && (!["1.0.0", "1.1.0", "1.2.0"].includes(record.schemaVersion) || record.caseId !== caseManifest.id || record.reviewPolicyVersion !== "2.4.0")) {
        errors.push("人物导览增量审核的 schema、caseId 或 reviewPolicyVersion 不一致。");
      }
      if (record) errors.push(...await participantGuideReviewRecordErrors(caseDir, record));
      const currentEvidenceHash = sha256Value(claims);
      if (claimsBaseline?.hashes?.evidence && claimsBaseline.hashes.evidence !== currentEvidenceHash) {
        errors.push("当前 evidence 与已接受基线不一致，不能复用历史内容审核。");
      }
      const roles = new Set((record?.reviewers ?? []).map((reviewer) => reviewer.role));
      if (requiresParticipants) for (const role of ["external_citation", "reader_advocate"]) if (!roles.has(role)) errors.push(`人物导览增量审核缺少 ${role}。`);
      const nestedHardErrors = (record?.reviewers ?? []).flatMap((reviewer) => reviewer.hardErrors ?? []);
      const liteRound = await latestCompletedLiteReviewRound(caseDir);
      const liteValidation = await validateLiteReview(caseDir, liteRound, { requireReports: true });
      const expectedLiteConsensus = liteReviewConsensusFromValidation(liteValidation);
      const liteRoundLabel = `round-${String(liteRound).padStart(2, "0")}`;
      const storedLiteConsensus = await readJson(path.join(caseDir, "work", "reviews", "2.4.0", "reader-first", liteRoundLabel, "consensus.json"));
      if (sha256Value(storedLiteConsensus) !== sha256Value(expectedLiteConsensus)) errors.push("2.4 读者审核 consensus 已过期或与角色报告不一致。");
      errors.push(...liteValidation.errors);
      const liteHardErrors = (storedLiteConsensus.hardErrors ?? []).map((entry) => entry.message ?? String(entry));
      const hardErrors = unique([...errors, ...(record?.hardErrors ?? []), ...nestedHardErrors, ...liteHardErrors]);
      const warnings = unique([
        ...(record?.warnings ?? []),
        ...(record?.reviewers ?? []).flatMap((reviewer) => reviewer.warnings ?? []),
        ...(storedLiteConsensus.warnings ?? []).map((entry) => entry.message ?? String(entry)),
      ]);
      const reader = liteValidation.reports.get("reader_advocate");
      const fidelity = liteValidation.reports.get("fidelity");
      return {
        round: `reader-first/${liteRoundLabel}${record ? " + participant-guide" : ""}`,
        status: hardErrors.length ? "fail" : "pass",
        manifest: { participantGuide: record, readerFirst: liteValidation.manifest },
        declaredConsensus: {
          status: hardErrors.length ? "fail" : storedLiteConsensus.status,
          hardErrors,
          warnings,
          diagnostics: storedLiteConsensus.diagnostics ?? [],
          metrics: {},
        },
        claimAudit: { reviewedCount: 0, errorCount: 0, status: "inherited_unchanged_evidence" },
        blindRecall: { candidateCount: 0, matchedCount: 0, allRecall: 0, highMediumCandidateCount: 0, highMediumMatchedCount: 0, highMediumRecall: 0, status: "diagnostic_not_rerun" },
        fidelity: { status: fidelity?.hardErrors?.length ? "fail" : "pass", errorCount: fidelity?.hardErrors?.length ?? 0, reviewedBlockCount: 0 },
        readerAdvocate: { status: reader?.hardErrors?.length ? "fail" : "pass", scores: null },
        claimBundles: { count: 0, maximumReaderClaims: 0 },
        staleCount: errors.filter((error) => /过期|哈希|基线/u.test(error)).length,
        hardErrors,
        diagnostics: [
          { gate: "reader_first_review", baselineReview: record?.baselineReview ?? null, evidenceUnchanged: true },
          ...(storedLiteConsensus.diagnostics ?? []),
        ],
        warnings,
        errors: hardErrors,
      };
    } catch (error) {
      return emptyReviewState(`无法读取或验证 2.4 人物导览增量审核：${error.message}`);
    }
  }
  const roundDir = await latestReviewRound(caseDir, reviewVersion);
  if (!roundDir) return emptyReviewState(`缺少 work/reviews/${reviewVersion}/round-NN 多代理审核记录。`);
  const readerFirstPath = path.join(roundDir, "reader-first-review.json");
  if (config.reviews?.gatePolicy === "concrete_hard_errors" && await exists(readerFirstPath)) {
    try {
      const [record, research, brief, claimBundles] = await Promise.all([
        readJson(readerFirstPath),
        readJson(path.join(caseDir, "work", "research.json")),
        readJson(path.join(caseDir, "output", "brief.json")),
        optionalJson(path.join(caseDir, "work", "claim-bundles.json"), { bundles: [] }),
      ]);
      const inputHashes = readerFirstInputHashes({
        segments,
        claims,
        deepRead,
        readerMap,
        research,
        brief,
        readerMarkdown,
      });
      const contractErrors = readerFirstReviewContractErrors(record, {
        caseId: caseManifest.id,
        reviewRound: record.reviewRound,
        inputHashes,
      });
      const nestedHardErrors = record.reviewers.flatMap((reviewer) => reviewer.hardErrors ?? []);
      const hardErrors = unique([...contractErrors, ...(record.hardErrors ?? []), ...nestedHardErrors]);
      const fidelity = record.reviewers.find((reviewer) => reviewer.role === "fidelity");
      const reader = record.reviewers.find((reviewer) => reviewer.role === "reader_advocate");
      const maximumReaderClaims = Math.max(0, ...(claimBundles?.bundles ?? []).map((bundle) =>
        (bundle.requiredReaderRefs?.length ?? 0) + (bundle.optionalReaderRefs?.length ?? 0)));
      return {
        round: path.basename(roundDir),
        status: hardErrors.length ? "fail" : "pass",
        manifest: record,
        declaredConsensus: {
          status: hardErrors.length ? "fail" : "pass",
          hardErrors,
          warnings: record.warnings ?? [],
          diagnostics: record.diagnostics ?? [],
          metrics: {},
        },
        claimAudit: { reviewedCount: 0, errorCount: 0, status: "diagnostic_not_required" },
        blindRecall: {
          candidateCount: 0,
          matchedCount: 0,
          allRecall: 0,
          highMediumCandidateCount: 0,
          highMediumMatchedCount: 0,
          highMediumRecall: 0,
          status: "diagnostic_not_required",
        },
        fidelity: {
          status: fidelity?.status ?? "missing",
          errorCount: fidelity?.hardErrors?.length ?? 0,
          reviewedBlockCount: 0,
        },
        readerAdvocate: {
          status: reader?.status ?? "missing",
          scores: null,
        },
        claimBundles: {
          count: claimBundles?.bundles?.length ?? 0,
          maximumReaderClaims,
        },
        staleCount: contractErrors.filter((error) => /过期|哈希|hash/u.test(error)).length,
        hardErrors,
        diagnostics: record.diagnostics ?? [],
        warnings: record.warnings ?? [],
        errors: hardErrors,
      };
    } catch (error) {
      return emptyReviewState(`无法读取或验证读者优先多代理审核：${error.message}`);
    }
  }
  try {
    const reviewManifest = await readJson(path.join(roundDir, "manifest.json"));
    const research = await readJson(path.join(caseDir, "work", "research.json"));
    const segmentsHash = sha256Value(segments);
    const evidenceHash = sha256Value(claims);
    const deepReadHash = sha256Value(deepRead);
    const readerMapHash = sha256Value(readerMap);
    const errors = [];
    const [
      claimReview,
      claimReviewResolution,
      blindCandidates,
      blindAlignment,
      coverageA,
      coverageB,
      fidelityReview,
      readerReview,
      adjudication,
      claimBundles,
      evidenceMigration,
    ] = await Promise.all([
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "claimReview"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "claimReviewResolution"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "blindCandidates"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "blindAlignment"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "coverageA"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "coverageB"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "fidelityReview"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "readerReview"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "adjudication", { required: false }),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "claimBundles"),
      loadReviewArtifact(caseDir, roundDir, reviewManifest, "evidenceMigration", { required: false }),
    ]);
    const [mechanicalFix, secondaryClaimReview, claimAdjudication] = await Promise.all([
      Object.hasOwn(claimReviewResolution.inputHashes ?? {}, "mechanicalFix")
        ? readJson(path.join(caseDir, "work", "claim-mechanical-fix.json")) : null,
      Object.hasOwn(claimReviewResolution.inputHashes ?? {}, "secondaryClaimReview")
        ? readJson(path.join(caseDir, "work", "claim-review-secondary.json")) : null,
      Object.hasOwn(claimReviewResolution.inputHashes ?? {}, "adjudication")
        ? readJson(path.join(caseDir, "work", "claim-adjudication.json")) : null,
    ]);
    errors.push(...reviewManifestContractErrors(reviewManifest, {
      caseId: caseManifest.id,
      workflowVersion: reviewVersion,
      requireClaimReviewResolution: true,
      inputHashes: {
        segments: segmentsHash,
        evidence: evidenceHash,
        claimReview: sha256Value(claimReview),
        claimReviewResolution: sha256Value(claimReviewResolution),
        deepRead: deepReadHash,
        readerMap: readerMapHash,
        claimBundles: sha256Value(claimBundles),
        research: sha256Value(research),
        ...(evidenceMigration ? { evidenceMigration: sha256Value(evidenceMigration) } : {}),
      },
    }));

    const claimReviewErrors = claimReviewResolutionContractErrors(claimReviewResolution, {
      caseId: caseManifest.id,
      workflowVersion: caseManifest.workflow?.version,
      reviewRound: reviewManifest.reviewRound,
      claims,
      segmentsHash,
      evidenceHash,
      primary: claimReview,
      mechanicalFix,
      secondary: secondaryClaimReview,
      adjudication: claimAdjudication,
    });
    const blindCandidateErrors = blindCandidateContractErrors(blindCandidates, {
      caseId: caseManifest.id,
      segmentsHash,
    });
    const blindAlignmentErrors = blindAlignmentContractErrors(blindAlignment, {
      caseId: caseManifest.id,
      candidates: blindCandidates,
      claims,
      evidenceHash,
    });
    const recall = blindRecallMetrics(blindCandidates, blindAlignment);
    const readerErrors = readerReviewContractErrors(readerReview, {
      caseId: caseManifest.id,
      deepRead,
      // The formal validator independently proves that this packet hash still
      // matches the current reference-free Markdown. Reusing it here avoids
      // hashing the reader-facing evidence links with a different algorithm.
      readerMarkdownHash: readerReview?.inputHashes?.readerMarkdown,
      deepReadHash,
      requirePass: false,
    });
    const bundleErrors = claimBundleContractErrors(claimBundles, {
      caseId: caseManifest.id,
      claims,
      claimReviewHash: sha256Value(claimReview),
      evidenceHash,
      deepRead,
      readerMap,
    });
    const fidelityErrors = fidelityReviewContractErrors(fidelityReview, {
      caseId: caseManifest.id,
      claims,
      deepRead,
      research,
      evidenceHash,
      deepReadHash,
      researchHash: sha256Value(research),
      requirePass: false,
    });
    let migrationErrors = [];
    if (config.migration.pilotCases.includes(caseManifest.caseNumber)) {
      const oldClaims = await optionalJsonLines(path.join(caseDir, "legacy", "workflow-2.1.0", "work", "evidence.jsonl"));
      if (!evidenceMigration) migrationErrors.push("试点案例缺少 evidence-migration.json。");
      else migrationErrors = evidenceMigrationContractErrors(evidenceMigration, {
        caseId: caseManifest.id,
        oldClaims,
        newClaims: claims,
      });
    }
    // Quality reporting consumes the same formal 2.3 consensus as the CLI.
    // It must not rerun the retired 2.2 all-claims adjudication algorithm.
    const consensus = await computeReviewConsensus(caseDir, reviewManifest.reviewRound, { write: false });
    const declaredConsensus = {
      ...consensus,
      metrics: coverageDiagnosticMetrics(consensus, coverageA, coverageB),
    };
    errors.push(...claimReviewErrors, ...blindCandidateErrors, ...blindAlignmentErrors, ...readerErrors, ...bundleErrors, ...fidelityErrors, ...migrationErrors, ...(consensus.errors ?? []));
    const maximumReaderClaims = Math.max(0, ...(claimBundles?.bundles ?? []).map((bundle) =>
      (bundle.requiredReaderRefs?.length ?? 0) + (bundle.optionalReaderRefs?.length ?? 0)));
    const reviewPartition = partitionReviewErrors(errors);
    const fidelityFindings = fidelityReviewGateFailures(fidelityReview, { research });
    const readerFindings = readerReviewGateFailures(readerReview);
    const hardErrors = unique([
      ...reviewPartition.hardErrors,
      ...formalReviewHardErrorMessages(consensus),
      ...fidelityFindings.map((finding) =>
        `Fidelity hard error at ${finding.readerBlockRef}: ${finding.reasons.join(", ")}.`),
    ]);
    const diagnostics = [
      ...(consensus.diagnostics ?? []),
      ...reviewPartition.diagnostics.map((message) => ({ gate: "quantitative_review", message })),
      ...readerFindings.map((finding) => ({ gate: "reader_advocate", ...finding })),
      {
        gate: "blind_recall",
        actual: recall,
        target: { highMediumRecall: 1, allRecall: config.qualityGates.allClaimRecall },
      },
    ];
    const reviewWarnings = unique([
      ...(consensus.warnings ?? []),
      ...reviewPartition.diagnostics,
      ...(readerFindings.length ? ["Reader Advocate scores or verdict are below the diagnostic target."] : []),
      ...((recall.highMediumRecall < 1 || recall.allRecall < config.qualityGates.allClaimRecall)
        ? ["Blind Recall is below the diagnostic target."] : []),
    ]);
    return {
      round: path.basename(roundDir),
      status: hardErrors.length ? "fail" : "pass",
      manifest: reviewManifest,
      declaredConsensus,
      claimAudit: {
        reviewedCount: claimReview?.entries?.length ?? 0,
        errorCount: claimReviewErrors.length,
        status: claimReviewErrors.length ? "fail" : "pass",
        resolutionHash: sha256Value(claimReviewResolution),
      },
      blindRecall: recall,
      fidelity: {
        status: fidelityErrors.length || fidelityFindings.length ? "fail" : "pass",
        errorCount: fidelityErrors.length + fidelityFindings.length,
        reviewedBlockCount: fidelityReview?.entries?.length ?? 0,
      },
      readerAdvocate: {
        status: readerErrors.length ? "fail" : (readerFindings.length ? "warning" : "pass"),
        scores: readerReview?.scores ?? null,
      },
      claimBundles: { count: claimBundles?.bundles?.length ?? 0, maximumReaderClaims },
      staleCount: errors.filter((error) => /过期|哈希|hash/u.test(error)).length,
      hardErrors,
      diagnostics,
      warnings: reviewWarnings,
      errors: hardErrors,
    };
  } catch (error) {
    return emptyReviewState(`无法读取或验证多代理审核：${error.message}`);
  }
}

export function evaluateQuality({
  manifest,
  normalized,
  coverage,
  segments,
  claims,
  themeMap,
  deepRead,
  readerMap,
  evidenceBookText,
  brief,
  participantGuide = null,
  contextGuide = null,
  config,
  reviewState,
  humanReview = null,
}) {
  const errors = [];
  const warnings = [];
  const evidenceIds = new Set(claims.map((claim) => claim.id));
  const citationIds = new Set((brief.citations ?? []).map((citation) => citation.id));
  if (contextGuide) {
    const briefContextGuide = selectContextGuideEntries(contextGuide, brief.contextGuide?.entryRefs ?? []);
    errors.push(...contextGuideContractErrors(briefContextGuide, { manifest, evidenceIds, citationIds }));
    errors.push(...contextGuideUsageErrors(deepRead, contextGuide, {
      kind: "deep-read",
      enforceEarliest: deepRead.schemaVersion === "2.5.0",
    }));
    errors.push(...contextGuideUsageErrors(brief, contextGuide, {
      kind: "brief",
      selectedRefs: brief.contextGuide?.entryRefs ?? [],
      enforceEarliest: brief.schemaVersion === "1.7.0",
    }));
    if (deepRead.schemaVersion === "2.5.0" && (contextGuide.entries?.length < 3 || contextGuide.entries?.length > 8)) warnings.push(`Context Guide 当前有 ${contextGuide.entries?.length ?? 0} 项；3–8 项仅为编辑建议。`);
  }
  const sourceOrder = new Map(normalized.map((unit, index) => [unit.id, index]));
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const coverageBySource = new Map(coverage.entries.map((entry) => [entry.sourceId, entry]));
  const mappedEntries = coverage.entries.filter((entry) => entry.status === "mapped");
  const excludedEntries = coverage.entries.filter((entry) => entry.status === "excluded");
  const completeEntries = coverage.entries.filter((entry) => ["mapped", "excluded"].includes(entry.status));
  const segmentCoverage = normalized.length ? completeEntries.length / normalized.length : 0;
  const effectiveSourceCharacters = mappedEntries.reduce(
    (total, entry) => total + String(sourceById.get(entry.sourceId)?.text ?? "").replace(/\s+/gu, "").length,
    0,
  );
  const excludedCharacters = excludedEntries.reduce(
    (total, entry) => total + String(sourceById.get(entry.sourceId)?.text ?? "").replace(/\s+/gu, "").length,
    0,
  );
  const coverageFindings = coverageLedgerFindings(normalized, segments, coverage, {
    caseId: manifest.id,
    sourceHash: manifest.source.sha256,
  });
  errors.push(...coverageFindings.hardErrors);
  warnings.push(...coverageFindings.diagnostics);
  for (const entry of mappedEntries) {
    const segment = segmentById.get(entry.segmentId);
    if (!segment || !segment.sourceIds.includes(entry.sourceId)) errors.push(`coverage 的 ${entry.sourceId} 未由 ${entry.segmentId} 唯一拥有。`);
  }
  for (const entry of excludedEntries) {
    if (!entry.reason || !entry.exclusionKind || entry.segmentId !== null) errors.push(`排除项 ${entry.sourceId} 缺少原因或仍指向 segment。`);
  }
  const ownedSourceIds = segments.flatMap((segment) => segment.sourceIds);
  if (new Set(ownedSourceIds).size !== ownedSourceIds.length) errors.push("多个 segment 重复拥有同一来源单元。");
  if (segmentCoverage < config.qualityGates.segmentCoverage) warnings.push(`字幕 segment 覆盖率为 ${roundRate(segmentCoverage)}；未映射区段已列入诊断。`);

  let supportedClaims = 0;
  let lowConfidenceMisattributions = 0;
  const unsupportedClaimIds = [];
  for (const claim of claims) {
    let supported = claim.schemaVersion === "2.0.0" && claim.caseId === manifest.id && claim.supportSpans?.length > 0;
    for (const span of claim.supportSpans ?? []) {
      const segment = segmentById.get(span.segmentId);
      if (!segment || !isContiguousSourceSpan(span.sourceIds, sourceOrder)) supported = false;
      if (segment && span.sourceIds.some((id) => !segment.sourceIds.includes(id))) supported = false;
      if (span.sourceIds.some((id) => coverageBySource.get(id)?.segmentId !== span.segmentId)) supported = false;
      if (span.quote) {
        const sourceText = normalizeText(span.sourceIds.map((id) => sourceById.get(id)?.text ?? "").join(" "));
        if (!sourceText.includes(normalizeText(span.quote))) supported = false;
      }
    }
    if (supported) supportedClaims += 1;
    else unsupportedClaimIds.push(claim.id);
    if (claim.speaker?.name && (claim.speaker.status === "unknown" || claim.speaker.confidence < 0.85)) lowConfidenceMisattributions += 1;
  }
  const claimSupportRate = claims.length ? supportedClaims / claims.length : 0;
  if (lowConfidenceMisattributions > config.qualityGates.maximumLowConfidenceMisattributions) {
    errors.push(`存在 ${lowConfidenceMisattributions} 条低置信说话人误归属。`);
  }
  const duplicateIds = nearDuplicateClaimIds(claims);
  const nearDuplicateRate = claims.length ? duplicateIds.size / claims.length : 0;
  if (nearDuplicateRate > config.qualityGates.maximumNearDuplicateRate) warnings.push(`近重复 claim 比例为 ${roundRate(nearDuplicateRate)}，建议人工抽查是否影响阅读。`);

  errors.push(...readerMapContractErrors(readerMap, manifest, claims, deepRead));
  const readerEntries = new Map((readerMap?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const highMedium = claims.filter((claim) => ["high", "medium"].includes(claim.importance));
  const declaredHighMedium = highMedium.filter((claim) => {
    const entry = readerEntries.get(claim.id);
    return ["explicit", "synthesized"].includes(entry?.presentation) && entry.coverageSpans?.length;
  });
  const declaredAll = claims.filter((claim) => {
    const entry = readerEntries.get(claim.id);
    return ["explicit", "synthesized"].includes(entry?.presentation) && entry.coverageSpans?.length;
  });
  const declaredReferenceCoverage = highMedium.length ? declaredHighMedium.length / highMedium.length : 1;
  const readerClaimCoverage = claims.length ? declaredAll.length / claims.length : 1;
  const consensusMetrics = reviewState?.declaredConsensus?.metrics ?? {};
  const adjudicatedSemanticCoverage = consensusMetrics.adjudicatedSemanticCoverage ?? 0;
  if (reviewState?.status !== "pass") errors.push(...(reviewState?.errors ?? ["多代理审核未通过。"]))

  const evidenceBookIds = new Set([...String(evidenceBookText ?? "").matchAll(/<a id="(e\d{4,})"><\/a>/giu)].map((match) => match[1].toUpperCase()));
  const evidenceBookCoverage = claims.length ? claims.filter((claim) => evidenceBookIds.has(claim.id)).length / claims.length : 1;
  const usedEvidenceIds = new Set((readerMap?.entries ?? []).map((entry) => entry.evidenceRef));
  const missingUsedEvidence = [...usedEvidenceIds].filter((ref) => !evidenceBookIds.has(ref));
  if (missingUsedEvidence.length) errors.push(`正文实际使用的证据未进入证据册：${missingUsedEvidence.join("、")}。`);

  errors.push(...densityErrors(deepRead.density?.scores, deepRead.density?.total, "deep-read.density"));
  const targets = adaptiveTargets(deepRead.density?.total ?? -1, effectiveSourceCharacters, config);
  const sourceDerivedCharacters = sourceDerivedDeepCharacters(deepRead);
  const actualRetention = effectiveSourceCharacters ? sourceDerivedCharacters / effectiveSourceCharacters : 0;
  const expectedBudget = {
    recommendedCharacters: targets.recommendedReaderCharacters,
    minimumGuideline: targets.readerMinimumGuideline,
    maximumGuideline: targets.readerMaximumGuideline,
    softCharacterCap: targets.readerSoftCharacterCap,
  };
  if (JSON.stringify(deepRead.readerBudget) !== JSON.stringify(expectedBudget)) warnings.push("deep-read readerBudget 与当前诊断公式不一致。");
  const readability = readabilityMetrics(deepRead);
  const deepBudget = config.budgets.deepRead;
  // There is intentionally no minimum-length warning or failure in 2.2.
  if (readability.bodyCharacters > targets.readerMaximumGuideline) warnings.push(`读者版正文 ${readability.bodyCharacters} 字符，超过 ${targets.readerMaximumGuideline} 字符建议上限。`);
  if (readability.bodyCharacters > targets.readerSoftCharacterCap) warnings.push(`读者版正文超过 ${targets.readerSoftCharacterCap} 字符软上限。`);
  if (readability.paragraphHardLimitCount) warnings.push(`存在 ${readability.paragraphHardLimitCount} 个超过 ${deepBudget.paragraphHardMax} 字符的普通段落。`);
  if (readability.maximumListItems > deepBudget.maximumListItems) warnings.push(`单个列表超过 ${deepBudget.maximumListItems} 项。`);
  if (readability.listCharacterShare > deepBudget.targetListCharacterShare) warnings.push(`列表文字占比 ${readability.listCharacterShare}，高于目标 ${deepBudget.targetListCharacterShare}。`);
  if (readability.readerDuplicateRate > deepBudget.maximumReaderDuplicateRate) warnings.push(`读者正文近重复率为 ${readability.readerDuplicateRate}，建议检查是否影响阅读。`);
  if (readability.asrArtifactCount) warnings.push(`非引语正文可能仍有 ${readability.asrArtifactCount} 处 ASR 残片。`);
  if (readability.timelineDuplicateCount) warnings.push(`导航时间线与主题正文存在 ${readability.timelineDuplicateCount} 处近重复。`);
  if (readability.editorDuplicateCount) warnings.push(`QR-Pilot 与相邻正文存在 ${readability.editorDuplicateCount} 处近重复。`);
  if (readability.timelineItemCount < deepBudget.timelineMinimumItems || readability.timelineItemCount > deepBudget.timelineMaximumItems) warnings.push(`导航节点数量为 ${readability.timelineItemCount}，建议范围为 ${deepBudget.timelineMinimumItems}–${deepBudget.timelineMaximumItems}。`);
  if (readability.editorNoteCount < deepBudget.editorNoteMinimum || readability.editorNoteCount > deepBudget.editorNoteMaximum) warnings.push(`深度稿 QR-Pilot 数量为 ${readability.editorNoteCount}，当前建议为 ${deepBudget.editorNoteMinimum}–${deepBudget.editorNoteMaximum}。`);
  if ((reviewState?.claimBundles?.maximumReaderClaims ?? 0) > config.reviews.claimBundleWarningMaximum) {
    warnings.push(`单个 claim bundle 最多承接 ${reviewState.claimBundles.maximumReaderClaims} 条正文 claim，高于 6 条目标。`);
  }
  if ((reviewState?.claimBundles?.maximumReaderClaims ?? 0) > config.reviews.claimBundleHardMaximum) {
    warnings.push(`单个 claim bundle 超过 ${config.reviews.claimBundleHardMaximum} 条诊断阈值。`);
  }

  const briefCharacters = collectBlockCharacters(brief)
    + participantGuideCharacters(participantGuide, { compact: true })
    + (brief.contextGuide
      ? brief.schemaVersion === "1.7.0"
        ? contextGuideCharacters({ entries: (contextGuide?.entries ?? []).filter((entry) => brief.contextGuide.entryRefs.includes(entry.id)) })
        : contextGuideCharacters(contextGuide, { compact: true }) + contextInlineCharacters(contextGuide)
      : 0);
  const expectedMinutes = expectedReadingMinutes(briefCharacters, config);
  if (brief.density?.total !== deepRead.density?.total || brief.density?.targetCharacters !== targets.targetBriefCharacters) warnings.push("brief 密度分或目标字符数与 deep-read 不一致。");
  if (brief.readingMinutes !== expectedMinutes) warnings.push(`brief.readingMinutes 建议按实际字符数计算为 ${expectedMinutes}。`);
  if (Math.abs(briefCharacters - targets.targetBriefCharacters) > Math.max(500, targets.targetBriefCharacters * 0.2)) warnings.push(`速览实际 ${briefCharacters} 字符，与自适应目标差异较大。`);

  const unlabelledAdditions = unlabelledAdditionCount(deepRead, brief);
  if (unlabelledAdditions > config.qualityGates.maximumUnlabelledAdditions) errors.push(`存在 ${unlabelledAdditions} 个未正确标注的外部或 QR-Pilot 模块。`);
  const mappedThemeClaims = new Set(themeMap.themes.flatMap((theme) => theme.claimRefs));
  const claimsOutsideThemeMap = claims.filter((claim) => !mappedThemeClaims.has(claim.id));
  if (["2.4.0", "2.4.1", "2.4.2"].includes(manifest.workflow?.version)) {
    if (claimsOutsideThemeMap.length) {
      warnings.push(`选择性 theme-map 未纳入 ${claimsOutsideThemeMap.length} 条 claim；仅作诊断，不要求读者版全量分配。`);
    }
  } else {
    if (themeMap.unassignedClaimRefs?.length) errors.push(`theme-map 尚有 ${themeMap.unassignedClaimRefs.length} 条未分配 claim。`);
    if (claimsOutsideThemeMap.length) {
      for (const claim of claimsOutsideThemeMap) errors.push(`claim 未进入 theme-map：${claim.id}`);
    }
  }

  const isPilot = config.migration.pilotCases.includes(manifest.caseNumber);
  const human = humanReviewResult(humanReview, config, isPilot, manifest.id);
  if (human.status === "pending") warnings.push(...human.errors);
  else errors.push(...human.errors);
  if (unsupportedClaimIds.length) {
    errors.push(`Unsupported claims: ${unsupportedClaimIds.join(", ")}.`);
  }
  const policyPartition = partitionReviewErrors(errors);
  const finalErrors = unique(policyPartition.hardErrors);
  const finalWarnings = unique([
    ...warnings,
    ...(reviewState?.warnings ?? []),
    ...policyPartition.diagnostics,
  ]);
  const diagnostics = [
    ...(reviewState?.diagnostics ?? []),
    ...policyPartition.diagnostics.map((message) => ({ gate: "quantitative_quality", message })),
    {
      gate: "quality_metrics",
      segmentCoverage: roundRate(segmentCoverage),
      claimSupportRate: roundRate(claimSupportRate),
      nearDuplicateRate: roundRate(nearDuplicateRate),
      declaredReferenceCoverage: roundRate(declaredReferenceCoverage),
      adjudicatedSemanticCoverage: roundRate(adjudicatedSemanticCoverage),
      evidenceBookCoverage: roundRate(evidenceBookCoverage),
      readerScores: reviewState?.readerAdvocate?.scores ?? null,
      bodyCharacters: readability.bodyCharacters,
      paragraphCount: readability.paragraphCount,
      listCharacterShare: readability.listCharacterShare,
      maximumListItems: readability.maximumListItems,
      timelineItemCount: readability.timelineItemCount,
      contextGuideEntries: contextGuide?.entries?.length ?? 0,
    },
  ];
  return {
    schemaVersion: "2.3.0",
    caseId: manifest.id,
    generatedAt: new Date().toISOString(),
    profile: {
      primary: manifest.profile?.primary ?? null,
      lenses: manifest.profile?.lenses ?? [],
      selection: manifest.profile?.selection ?? "pending",
      confidence: manifest.profile?.confidence ?? 0,
      version: manifest.profile?.version ?? null,
    },
    source: {
      totalUnits: normalized.length,
      mappedUnits: mappedEntries.length,
      excludedUnits: excludedEntries.length,
      effectiveCharacters: effectiveSourceCharacters,
      excludedCharacters,
      exclusionRate: roundRate(normalized.length ? excludedEntries.length / normalized.length : 0),
    },
    segments: {
      count: segments.length,
      coverageRate: roundRate(segmentCoverage),
      duplicateOwnershipCount: ownedSourceIds.length - new Set(ownedSourceIds).size,
    },
    claims: {
      count: claims.length,
      byImportance: Object.fromEntries(["high", "medium", "low"].map((importance) => [importance, claims.filter((claim) => claim.importance === importance).length])),
      supportedCount: supportedClaims,
      supportRate: roundRate(claimSupportRate),
      unsupportedClaimIds,
      nearDuplicateCount: duplicateIds.size,
      nearDuplicateRate: roundRate(nearDuplicateRate),
      lowConfidenceMisattributions,
    },
    readerEdition: {
      bodyCharacters: readability.bodyCharacters,
      recommendedCharacters: targets.recommendedReaderCharacters,
      maximumGuideline: targets.readerMaximumGuideline,
      softCharacterCap: targets.readerSoftCharacterCap,
      sourceDerivedCharacters,
      diagnosticRetention: roundRate(actualRetention),
      declaredReferenceCoverage: roundRate(declaredReferenceCoverage),
      adjudicatedSemanticCoverage: roundRate(adjudicatedSemanticCoverage),
      readerClaimCoverage: roundRate(readerClaimCoverage),
      partialCount: consensusMetrics.partialCount ?? 0,
      missingCount: consensusMetrics.missingCount ?? 0,
      contradictedCount: consensusMetrics.contradictedCount ?? 0,
      unreviewableCount: consensusMetrics.unreviewableCount ?? 0,
      unresolvedCount: consensusMetrics.unresolvedCount ?? 0,
      staleCount: reviewState?.staleCount ?? 0,
      paragraphCount: readability.paragraphCount,
      paragraphTargetShortCount: readability.paragraphTargetShortCount,
      paragraphTargetLongCount: readability.paragraphTargetLongCount,
      paragraphHardLimitCount: readability.paragraphHardLimitCount,
      maximumParagraphCharacters: readability.maximumParagraphCharacters,
      listCharacterShare: readability.listCharacterShare,
      maximumListItems: readability.maximumListItems,
      readerDuplicateCount: readability.readerDuplicateCount,
      readerDuplicateRate: readability.readerDuplicateRate,
      timelineDuplicateCount: readability.timelineDuplicateCount,
      editorDuplicateCount: readability.editorDuplicateCount,
      asrArtifactCount: readability.asrArtifactCount,
      editorNoteCount: readability.editorNoteCount,
      timelineItemCount: readability.timelineItemCount,
    },
    evidenceArchive: {
      claimCount: claims.length,
      indexedClaimCount: evidenceBookIds.size,
      coverage: roundRate(evidenceBookCoverage),
      machineSource: "work/evidence.jsonl",
      readerArtifact: "output/evidence-book.md",
    },
    contextGuide: {
      present: Boolean(contextGuide),
      entryCount: contextGuide?.entries?.length ?? 0,
      deepReadReferenceCount: countContextReferences(deepRead.sections),
      briefReferenceCount: countContextReferences(brief.sections),
      coverageContribution: 0,
      repairAttemptContribution: 0,
    },
    brief: {
      characters: briefCharacters,
      targetCharacters: targets.targetBriefCharacters,
      readingMinutes: brief.readingMinutes,
      expectedReadingMinutes: expectedMinutes,
    },
    reviews: {
      round: reviewState?.round ?? null,
      status: reviewState?.status ?? "missing",
      claimAudit: reviewState?.claimAudit ?? null,
      blindRecall: reviewState?.blindRecall ?? null,
      fidelity: reviewState?.fidelity ?? null,
      readerAdvocate: reviewState?.readerAdvocate ?? null,
      claimBundles: reviewState?.claimBundles ?? null,
      unresolvedConflictCount: consensusMetrics.unresolvedCount ?? 0,
      staleCount: reviewState?.staleCount ?? 0,
      unlabelledAdditions,
      errors: reviewState?.errors ?? [],
    },
    humanReview: human,
    metricPolicy: {
      quantitativeMetricsBlocking: false,
    },
    hardErrors: finalErrors,
    diagnostics,
    errors: finalErrors,
    warnings: finalWarnings,
    status: finalErrors.length ? "fail" : "pass",
  };
}

export async function computeQualityReport(caseDir, { write = true } = {}) {
  const [{ manifest }, config] = await Promise.all([
    loadCase(caseDir),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
  ]);
  if (write && config.migration?.frozenCases?.includes(manifest.caseNumber)) {
    throw new Error(`案例 ${manifest.caseNumber} 已冻结；拒绝重写 work/quality-report.json。`);
  }
  const [normalized, coverage, segments, claims, themeMap, deepRead, readerMap, brief, participantGuide, contextGuide, humanReview, evidenceBookText, readerMarkdown] = await Promise.all([
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJson(path.join(caseDir, "work", "coverage.json")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "work", "theme-map.json")),
    readJson(path.join(caseDir, "output", "deep-read.json")),
    readJson(path.join(caseDir, "work", "reader-map.json")),
    readJson(path.join(caseDir, "output", "brief.json")),
    optionalJson(path.join(caseDir, "work", "participant-guide.json")),
    optionalJson(path.join(caseDir, "work", "context-guide.json")),
    optionalJson(path.join(caseDir, "work", "human-review.json")),
    fs.readFile(path.join(caseDir, "output", "evidence-book.md"), "utf8"),
    fs.readFile(path.join(caseDir, "output", "deep-read.md"), "utf8"),
  ]);
  const reviewState = await loadReviewState(caseDir, { manifest, segments, claims, deepRead, readerMap, readerMarkdown, config });
  const report = evaluateQuality({ manifest, normalized, coverage, segments, claims, themeMap, deepRead, readerMap, evidenceBookText, brief, participantGuide, contextGuide, config, reviewState, humanReview });
  if (write) await writeJson(path.join(caseDir, "work", "quality-report.json"), report);
  return report;
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const report = await computeQualityReport(caseDir);
    for (const warning of report.warnings) console.warn(`WARN  ${warning}`);
    for (const error of report.errors) console.error(`ERROR ${error}`);
    console.log(`${report.status.toUpperCase()} ${path.relative(REPO_ROOT, caseDir)} 质量报告已生成。`);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
