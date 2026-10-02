import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "../scripts/lib.mjs";
import {
  blindAlignmentContractErrors,
  blindCandidateContractErrors,
  blindRecallMetrics,
  canonicalJson,
  claimBundleContractErrors,
  claimReviewContractErrors,
  claimReviewResolutionContractErrors,
  coverageReviewContractErrors,
  eligibleReaderLeaves,
  evidenceMigrationContractErrors,
  fidelityReviewGateFailures,
  fidelityReaderLeaves,
  fidelityReviewContractErrors,
  isLegacyMissingSupportQuoteEntry,
  LEGACY_MISSING_SUPPORT_QUOTE_ISSUE,
  readerMapV2ContractErrors,
  readerReviewGateFailures,
  readerReviewContractErrors,
  repairRoundLimitForCase,
  repairLogContractErrors,
  resolveCoverageConsensus,
  reviewManifestContractErrors,
  reviewWorkflowVersion,
  sha256Text,
  sha256Value,
  supplementalClaimRepairContractErrors,
} from "../scripts/review-contract.mjs";

const CASE_ID = "qr-9999-review-fixture";

test("review version selection is config-driven with a 2.2.0 compatibility fallback", () => {
  assert.equal(reviewWorkflowVersion({ reviews: { version: "2.2.1" } }), "2.2.1");
  assert.equal(reviewWorkflowVersion({ reviews: {} }), "2.2.0");
  assert.equal(reviewWorkflowVersion({}), "2.2.0");
  assert.throws(() => reviewWorkflowVersion({ reviews: { version: "latest" } }), /semantic version/u);
});

test("a pass claim resolution binds the current primary evidence and exact full scope", () => {
  const data = fixture();
  const segmentsHash = "c".repeat(64);
  const primary = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "agent-primary-resolution",
    reviewRound: 1,
    inputHashes: { segments: segmentsHash, evidence: data.evidenceHash },
    entries: data.claims.map((claim) => ({
      evidenceRef: claim.id,
      verdict: "pass",
      atomicity: "pass",
      support: "supported",
      importance: { verdict: "confirmed", proposed: null },
      theme: { verdict: "confirmed", proposedThemeId: null },
      speaker: "unknown_safe",
      issues: [],
      rationale: "通过。",
    })),
  };
  const resolution = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_gate",
    reviewRound: 1,
    inputHashes: {
      segments: segmentsHash,
      evidence: data.evidenceHash,
      primaryClaimReview: sha256Value(primary),
    },
    reviewerIds: { primary: primary.reviewerId },
    status: "pass",
    targetRefs: [],
    contractErrors: [],
    semanticFailures: [],
    conflicts: [],
    decisions: [],
    metrics: {
      primaryEntryCount: primary.entries.length,
      targetCount: 0,
      agreementCount: 0,
      conflictCount: 0,
      resolvedPassCount: 0,
      resolvedNonpassCount: 0,
      mechanicalResolvedCount: 0,
    },
  };
  const context = {
    caseId: CASE_ID,
    reviewRound: 1,
    claims: data.claims,
    segmentsHash,
    evidenceHash: data.evidenceHash,
    primary,
  };
  assert.deepEqual(claimReviewResolutionContractErrors(resolution, context), []);
  const stale = structuredClone(resolution);
  stale.inputHashes.evidence = "d".repeat(64);
  assert.match(claimReviewResolutionContractErrors(stale, context).join("\n"), /evidence.*stale/u);
  const incompleteScope = structuredClone(primary);
  incompleteScope.entries.pop();
  assert.match(claimReviewResolutionContractErrors(resolution, { ...context, primary: incompleteScope }).join("\n"), /primary.*(stale|cover)/u);

  const primaryBeforeRepair = structuredClone(primary);
  primaryBeforeRepair.schemaVersion = "1.1.0";
  primaryBeforeRepair.auditMode = "full";
  primaryBeforeRepair.scope = { evidenceRefs: data.claims.map((claim) => claim.id) };
  primaryBeforeRepair.inputHashes.evidence = "e".repeat(64);
  primaryBeforeRepair.entries = primaryBeforeRepair.entries.map((entry, index) => ({
    ...entry,
    ...(index === 0 ? {
      verdict: "revise",
      findingCodes: ["missing_support_quote"],
      issues: ["supportSpans.quote 缺失。"],
      rationale: "仅缺少可机械补齐的 quote。",
    } : { findingCodes: [] }),
  }));
  const mechanicalFix = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_mechanical_fix",
    reviewRound: 1,
    inputHashes: {
      primaryClaimReview: sha256Value(primaryBeforeRepair),
      beforeEvidence: primaryBeforeRepair.inputHashes.evidence,
      afterEvidence: data.evidenceHash,
      beforeQuoteIgnoredEvidence: "f".repeat(64),
      afterQuoteIgnoredEvidence: "f".repeat(64),
    },
    entries: [{ evidenceRef: "E0001", findingCode: "missing_support_quote", status: "mechanically_resolved", supportSpanIndexes: [0] }],
  };
  const mechanicalResolution = {
    ...structuredClone(resolution),
    inputHashes: {
      ...resolution.inputHashes,
      primaryClaimReview: sha256Value(primaryBeforeRepair),
      mechanicalFix: sha256Value(mechanicalFix),
    },
    metrics: { ...resolution.metrics, mechanicalResolvedCount: 1 },
  };
  assert.deepEqual(claimReviewResolutionContractErrors(mechanicalResolution, {
    ...context,
    primary: primaryBeforeRepair,
    mechanicalFix,
  }), []);
  const primaryWithoutMechanicalFinding = structuredClone(primaryBeforeRepair);
  primaryWithoutMechanicalFinding.entries[0] = {
    ...primaryWithoutMechanicalFinding.entries[0],
    verdict: "pass",
    findingCodes: [],
    issues: [],
    rationale: "Primary audit did not record a missing quote finding.",
  };
  const extraOnlyMechanicalFix = structuredClone(mechanicalFix);
  extraOnlyMechanicalFix.inputHashes.primaryClaimReview = sha256Value(primaryWithoutMechanicalFinding);
  const extraOnlyResolution = {
    ...structuredClone(resolution),
    inputHashes: {
      ...resolution.inputHashes,
      primaryClaimReview: sha256Value(primaryWithoutMechanicalFinding),
      mechanicalFix: sha256Value(extraOnlyMechanicalFix),
    },
    metrics: { ...resolution.metrics, mechanicalResolvedCount: 0 },
  };
  assert.deepEqual(claimReviewResolutionContractErrors(extraOnlyResolution, {
    ...context,
    primary: primaryWithoutMechanicalFinding,
    mechanicalFix: extraOnlyMechanicalFix,
  }), []);
  const legacyPrimary = structuredClone(primaryWithoutMechanicalFinding);
  legacyPrimary.schemaVersion = "1.0.0";
  delete legacyPrimary.auditMode;
  delete legacyPrimary.scope;
  legacyPrimary.entries[0] = {
    ...legacyPrimary.entries[0],
    verdict: "revise",
    issues: [LEGACY_MISSING_SUPPORT_QUOTE_ISSUE],
    rationale: "One or more exact support quotes are missing.",
  };
  assert.equal(isLegacyMissingSupportQuoteEntry(legacyPrimary.entries[0]), true);
  assert.equal(isLegacyMissingSupportQuoteEntry({
    ...legacyPrimary.entries[0],
    issues: ["supportSpans.quote 缺失，请补齐。"],
  }), false);
  const legacyMechanicalFix = structuredClone(mechanicalFix);
  legacyMechanicalFix.inputHashes.primaryClaimReview = sha256Value(legacyPrimary);
  const legacyResolution = {
    ...structuredClone(resolution),
    inputHashes: {
      ...resolution.inputHashes,
      primaryClaimReview: sha256Value(legacyPrimary),
      mechanicalFix: sha256Value(legacyMechanicalFix),
    },
    metrics: { ...resolution.metrics, mechanicalResolvedCount: 1 },
  };
  assert.deepEqual(claimReviewResolutionContractErrors(legacyResolution, {
    ...context,
    primary: legacyPrimary,
    mechanicalFix: legacyMechanicalFix,
  }), []);
  const changedSemantics = structuredClone(mechanicalFix);
  changedSemantics.inputHashes.afterQuoteIgnoredEvidence = "a".repeat(64);
  const staleMechanicalResolution = structuredClone(mechanicalResolution);
  staleMechanicalResolution.inputHashes.mechanicalFix = sha256Value(changedSemantics);
  assert.match(claimReviewResolutionContractErrors(staleMechanicalResolution, {
    ...context,
    primary: primaryBeforeRepair,
    mechanicalFix: changedSemantics,
  }).join("\n"), /quote-ignored/u);
});

test("repair round override is case-scoped and leaves the global cap unchanged", () => {
  const config = {
    reviews: {
      maximumRepairRounds: 2,
      repairRoundOverrides: {
        "QR-0002": 4,
        "QR-0011": 5,
        "QR-0013": 5,
        "QR-0017": 5,
        "QR-0022": 6,
        "QR-0023": 5,
      },
    },
  };
  assert.equal(repairRoundLimitForCase(config, "qr-0002-hong-lide-spacex"), 4);
  assert.equal(repairRoundLimitForCase(config, "qr-0011-li-xiang-auto-strategy"), 5);
  assert.equal(repairRoundLimitForCase(config, "qr-0013-hong-letong-ai-math"), 5);
  assert.equal(repairRoundLimitForCase(config, "qr-0017-xie-saining-world-model"), 5);
  assert.equal(repairRoundLimitForCase(config, "qr-0022-chen-mian-lovart"), 6);
  assert.equal(repairRoundLimitForCase(config, "qr-0023-ji-yichao-manus"), 5);
  assert.equal(repairRoundLimitForCase(config, "qr-0024-xiao-hong-manus"), 2);
  assert.equal(
    repairRoundLimitForCase({ reviews: { maximumRepairRounds: 2, repairRoundOverrides: { "QR-0022": 6 } } }, "qr-0022-anything"),
    6,
  );
  assert.throws(
    () => repairRoundLimitForCase({ reviews: { maximumRepairRounds: 2, repairRoundOverrides: { "QR-0022": 100 } } }, "qr-0022-anything"),
    /1–99/u,
  );
});

test("supplemental claim repair is hash-bound to a fresh passing Claim Auditor", () => {
  const inputHashes = Object.fromEntries(["evidence", "evidenceMigration", "claimBundles", "themeMap", "deepRead", "readerMap"]
    .map((name, index) => [name, String(index + 1).padStart(64, "0")]));
  const outputHashes = Object.fromEntries(Object.entries(inputHashes)
    .map(([name, value]) => [name, `${value.slice(0, 63)}f`]));
  const claimReviewHash = "a".repeat(64);
  const log = {
    schemaVersion: "1.0.0",
    caseId: "qr-0022-chen-mian-lovart",
    role: "evidence_repair_editor",
    reviewerId: "agent-qr0022-claim-repair-r3",
    reviewRound: 3,
    authority: "repair_only_no_approval",
    inputHashes: {
      ...inputHashes,
      claimAuditorPacket: "b".repeat(64),
      claimReview: "c".repeat(64),
      round02RepairLog: "d".repeat(64),
    },
    outputHashes,
    issues: [{ evidenceRef: "E0001", verdict: "revise", action: "statement_restricted" }],
    unresolved: [],
    requiresFreshClaimAuditor: true,
    postRepairClaimReview: {
      hash: claimReviewHash,
      reviewerId: "agent-qr0022-claim-r3-c",
      entryCount: 10,
      passCount: 10,
    },
  };
  const options = {
    caseId: log.caseId,
    repairRound: 3,
    reviewerId: log.reviewerId,
    claimAuditorId: "agent-qr0022-claim-r3-c",
    claimReviewHash,
    inputHashes,
    outputHashes,
  };
  assert.deepEqual(supplementalClaimRepairContractErrors(log, options), []);
  const stale = structuredClone(log);
  stale.outputHashes.readerMap = "0".repeat(64);
  assert.match(supplementalClaimRepairContractErrors(stale, options).join("\n"), /readerMap/u);
  const reusedReviewer = structuredClone(log);
  reusedReviewer.postRepairClaimReview.reviewerId = reusedReviewer.reviewerId;
  assert.match(supplementalClaimRepairContractErrors(reusedReviewer, options).join("\n"), /Claim Auditor reviewerId/u);
});

function fixture() {
  const claims = [
    { id: "E0001", importance: "high", provenance: "source_fact", themeId: "T001", statement: "模型能力取决于数据、训练与验证。" },
    { id: "E0002", importance: "medium", provenance: "speaker_view", themeId: "T002", statement: "嘉宾认为部署之前必须验证边界条件。" },
    { id: "E0003", importance: "low", provenance: "source_fact", themeId: "T001", statement: "访谈还给出了一个次要例子。" },
  ];
  const deepRead = {
    caseId: CASE_ID,
    sections: [
      {
        id: "overview",
        modules: [{ id: "overview-main", blocks: [{
          id: "fact-group",
          type: "prose_group",
          provenance: "source_fact",
          paragraphs: [{ id: "p-fact", text: "模型能力取决于数据、训练与验证。", evidenceRefs: ["E0001"] }],
        }] }],
      },
      {
        id: "themes",
        modules: [{ id: "theme-main", blocks: [
          {
            id: "view-group",
            type: "prose_group",
            provenance: "speaker_view",
            paragraphs: [{ id: "p-view", text: "嘉宾认为部署之前必须验证边界条件。", evidenceRefs: ["E0002"] }],
          },
          {
            id: "external-group",
            type: "prose_group",
            provenance: "external",
            paragraphs: [{ id: "p-external", text: "外部背景不能满足来源 claim。", citationRefs: ["R1"] }],
          },
          {
            id: "pilot-note",
            type: "editor_note",
            provenance: "editorial",
            title: "边界",
            text: "QR-Pilot 判断不能满足来源 claim。",
          },
        ] }],
      },
      {
        id: "navigation",
        modules: [{ id: "navigation-main", blocks: [{
          id: "navigation-timeline",
          type: "timeline",
          provenance: "system",
          items: [{ id: "nav-01", title: "模型与验证", evidenceRefs: ["E0001"] }],
        }] }],
      },
      { id: "verification", modules: [{ id: "verification-main", blocks: [] }] },
    ],
  };
  const evidenceHash = sha256Value(claims);
  const deepReadHash = sha256Value(deepRead);
  const research = {
    citations: [{ id: "R1", title: "外部核验资料", publisher: "权威机构", url: "https://example.com/research", accessedAt: "2026-08-11" }],
    checks: [{ citationRefs: ["R1"], result: "supported", explanation: "外部背景有独立资料支持。" }],
  };
  const researchHash = sha256Value(research);
  const segmentsHash = "d".repeat(64);
  const readerMap = {
    schemaVersion: "2.0.0",
    caseId: CASE_ID,
    entries: [
      {
        evidenceRef: "E0001",
        importance: "high",
        presentation: "explicit",
        coverageSpans: [{ readerBlockRef: "p-fact", readerTextQuote: "取决于数据、训练与验证" }],
      },
      {
        evidenceRef: "E0002",
        importance: "medium",
        presentation: "synthesized",
        coverageSpans: [{ readerBlockRef: "p-view", readerTextQuote: "部署之前必须验证边界条件" }],
      },
      { evidenceRef: "E0003", importance: "low", presentation: "evidence_only", coverageSpans: [] },
    ],
  };
  const review = (role, reviewerId) => ({
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role,
    reviewerId,
    reviewRound: 1,
    inputHashes: { evidence: evidenceHash, deepRead: deepReadHash },
    blindToReaderMap: true,
    blindToPeerReview: true,
    entries: [
      {
        evidenceRef: "E0001",
        verdict: "covered",
        confidence: 0.95,
        issueType: "none",
        readerBlockRefs: ["p-fact"],
        verifiedQuotes: [{ readerBlockRef: "p-fact", readerTextQuote: "取决于数据、训练与验证" }],
        materialFacets: ["能力依赖数据、训练和验证"],
        missingFacets: [],
        rationale: "正文完整表达命题。",
      },
      {
        evidenceRef: "E0002",
        verdict: "covered",
        confidence: 0.95,
        issueType: "none",
        readerBlockRefs: ["p-view"],
        verifiedQuotes: [{ readerBlockRef: "p-view", readerTextQuote: "部署之前必须验证边界条件" }],
        materialFacets: ["部署前验证边界"],
        missingFacets: [],
        rationale: "正文完整表达命题。",
      },
    ],
  });
  const coverageA = review("coverage_a", "agent-coverage-a");
  const coverageB = review("coverage_b", "agent-coverage-b");
  const adjudication = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "adjudicator",
    reviewerId: "agent-adjudicator",
    reviewRound: 1,
    inputHashes: {
      evidence: evidenceHash,
      deepRead: deepReadHash,
      coverageA: sha256Value(coverageA),
      coverageB: sha256Value(coverageB),
    },
    entries: [],
  };
  const fidelityReview = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "fidelity",
    reviewerId: "agent-fidelity",
    reviewRound: 1,
    inputHashes: { evidence: evidenceHash, deepRead: deepReadHash, research: researchHash },
    entries: [
      { readerBlockRef: "p-fact", verdict: "supported", provenance: "source_fact", evidenceRefs: ["E0001"], citationRefs: [], unsupportedText: [], provenanceVerdict: "correct", rationale: "有直接支持。" },
      { readerBlockRef: "p-view", verdict: "supported", provenance: "speaker_view", evidenceRefs: ["E0002"], citationRefs: [], unsupportedText: [], provenanceVerdict: "correct", rationale: "有直接支持。" },
      { readerBlockRef: "p-external", verdict: "supported", provenance: "external", evidenceRefs: [], citationRefs: ["R1"], unsupportedText: [], provenanceVerdict: "correct", rationale: "有外部资料支持。" },
      { readerBlockRef: "pilot-note", verdict: "supported", provenance: "editorial", evidenceRefs: [], citationRefs: [], unsupportedText: [], provenanceVerdict: "correct", rationale: "明确标记为编辑判断。" },
      { readerBlockRef: "nav-01", verdict: "supported", provenance: "system", evidenceRefs: ["E0001"], citationRefs: [], unsupportedText: [], provenanceVerdict: "correct", rationale: "导航节点有来源支持。" },
    ],
  };
  const assignments = [
    ["claim_auditor", "agent-claim"],
    ["blind_recall", "agent-blind"],
    ["alignment", "agent-align"],
    ["coverage_a", "agent-coverage-a"],
    ["coverage_b", "agent-coverage-b"],
    ["fidelity", "agent-fidelity"],
    ["reader_advocate", "agent-reader"],
    ["adjudicator", "agent-adjudicator"],
    ["repair_editor", "agent-writer"],
  ].map(([role, reviewerId]) => ({ role, reviewerId }));
  const reviewManifest = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    workflowVersion: "2.2.0",
    reviewRound: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
    assignments,
    inputHashes: {
      segments: segmentsHash,
      evidence: evidenceHash,
      claimReview: "c".repeat(64),
      deepRead: deepReadHash,
      readerMap: sha256Value(readerMap),
      claimBundles: "b".repeat(64),
      research: researchHash,
    },
    artifacts: {
      claimReview: "work/reviews/claim-review.json",
      blindCandidates: "work/reviews/blind-candidates.json",
      blindAlignment: "work/reviews/blind-alignment.json",
      coverageA: "work/reviews/coverage-a.json",
      coverageB: "work/reviews/coverage-b.json",
      fidelityReview: "work/reviews/fidelity.json",
      readerReview: "work/reviews/reader.json",
      adjudication: "work/reviews/adjudication.json",
      claimBundles: "work/claim-bundles.json",
      evidenceMigration: null,
      repairLog: "work/reviews/repair-log.json",
    },
  };
  return { claims, deepRead, research, researchHash, evidenceHash, deepReadHash, segmentsHash, readerMap, reviewManifest, coverageA, coverageB, adjudication, fidelityReview };
}

test("canonical hashes are order-independent and raw text hashes remain distinct", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(sha256Value({ b: 2, a: 1 }), sha256Value({ a: 1, b: 2 }));
  assert.notEqual(sha256Value({ a: 1 }), sha256Value({ a: 2 }));
  assert.notEqual(sha256Text("正文"), sha256Value("正文"));
});

test("eligible coverage leaves exclude navigation, external and editorial content", () => {
  const { deepRead } = fixture();
  assert.deepEqual([...eligibleReaderLeaves(deepRead).keys()], ["p-fact", "p-view"]);
  assert.deepEqual([...fidelityReaderLeaves(deepRead).keys()], ["p-fact", "p-view", "p-external", "pilot-note", "nav-01"]);
});

test("2.3 coverage reviews only claims actually cited by eligible reader prose", () => {
  const data = fixture();
  const deepRead = structuredClone(data.deepRead);
  deepRead.sections[1].modules[0].blocks[0].paragraphs[0].evidenceRefs = [];
  const review = structuredClone(data.coverageA);
  review.inputHashes.deepRead = sha256Value(deepRead);
  review.entries = review.entries.filter((entry) => entry.evidenceRef === "E0001");

  assert.deepEqual(coverageReviewContractErrors(review, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead,
    expectedRole: "coverage_a",
  }), []);

  const stray = structuredClone(review);
  stray.entries.push(data.coverageA.entries.find((entry) => entry.evidenceRef === "E0002"));
  assert.match(coverageReviewContractErrors(stray, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead,
    expectedRole: "coverage_a",
  }).join("\n"), /未在正文使用的 claim/u);
});

test("2.3 source prose may combine source facts and speaker views without admitting external or editorial claims", () => {
  const data = fixture();
  const deepRead = structuredClone(data.deepRead);
  const viewParagraph = deepRead.sections[1].modules[0].blocks[0].paragraphs[0];
  viewParagraph.text = "嘉宾回顾了模型能力取决于数据、训练与验证。";
  viewParagraph.evidenceRefs = ["E0001"];

  const coverage = structuredClone(data.coverageA);
  coverage.inputHashes.deepRead = sha256Value(deepRead);
  coverage.entries = [{
    evidenceRef: "E0001",
    verdict: "covered",
    confidence: 0.95,
    issueType: "none",
    readerBlockRefs: ["p-view"],
    verifiedQuotes: [{ readerBlockRef: "p-view", readerTextQuote: "模型能力取决于数据、训练与验证" }],
    materialFacets: ["模型能力的条件"],
    missingFacets: [],
    rationale: "正文表达了来源事实。",
  }];
  assert.deepEqual(coverageReviewContractErrors(coverage, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead,
    expectedRole: "coverage_a",
  }), []);

  const fidelity = structuredClone(data.fidelityReview);
  fidelity.inputHashes.deepRead = sha256Value(deepRead);
  const viewEntry = fidelity.entries.find((entry) => entry.readerBlockRef === "p-view");
  viewEntry.evidenceRefs = ["E0001"];
  assert.deepEqual(fidelityReviewContractErrors(fidelity, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead,
    research: data.research,
  }), []);
});

test("reader-map 2.0 is a pure content interface with exact quotes, eligible source blocks and explicit evidence refs", () => {
  const data = fixture();
  assert.deepEqual(readerMapV2ContractErrors(data.readerMap, { caseId: CASE_ID, claims: data.claims, deepRead: data.deepRead }), []);

  const mismatch = structuredClone(data.readerMap);
  mismatch.entries[0].coverageSpans[0].readerTextQuote = "正文中不存在的语义";
  assert.match(readerMapV2ContractErrors(mismatch, { caseId: CASE_ID, claims: data.claims, deepRead: data.deepRead }).join("\n"), /不是 .*精确文本片段/);

  const navigation = structuredClone(data.readerMap);
  navigation.entries[0].coverageSpans = [{ readerBlockRef: "nav-01", readerTextQuote: "模型与验证" }];
  assert.match(readerMapV2ContractErrors(navigation, { caseId: CASE_ID, claims: data.claims, deepRead: data.deepRead }).join("\n"), /不可计覆盖/);

  const evidenceOnly = structuredClone(data.readerMap);
  evidenceOnly.entries[1] = { evidenceRef: "E0002", importance: "medium", presentation: "evidence_only", coverageSpans: [] };
  assert.match(readerMapV2ContractErrors(evidenceOnly, { caseId: CASE_ID, claims: data.claims, deepRead: data.deepRead }).join("\n"), /不得 evidence_only/);

  const gap = structuredClone(data.readerMap);
  gap.entries[1] = { evidenceRef: "E0002", importance: "medium", presentation: "unmapped", coverageSpans: [] };
  assert.deepEqual(readerMapV2ContractErrors(gap, { caseId: CASE_ID, claims: data.claims, deepRead: data.deepRead }), []);
});

test("double-blind agreement plus fidelity yields semantic coverage; conflict needs adjudication", () => {
  const data = fixture();
  const agreed = resolveCoverageConsensus({ caseId: CASE_ID, ...data });
  assert.deepEqual(agreed.errors, []);
  assert.equal(agreed.metrics.adjudicatedSemanticCoverage, 1);

  const lowConfidenceA = structuredClone(data.coverageA);
  lowConfidenceA.entries[0].confidence = 0.79;
  const lowConfidenceAdjudication = structuredClone(data.adjudication);
  lowConfidenceAdjudication.inputHashes.coverageA = sha256Value(lowConfidenceA);
  const lowConfidence = resolveCoverageConsensus({ caseId: CASE_ID, ...data, coverageA: lowConfidenceA, adjudication: lowConfidenceAdjudication });
  assert.equal(lowConfidence.entries.find((entry) => entry.evidenceRef === "E0001").verdict, "unresolved");
  assert.match(lowConfidence.errors.join("\n"), /共识未解决/);

  const missingA = structuredClone(data.coverageA);
  const missingB = structuredClone(data.coverageB);
  for (const review of [missingA, missingB]) {
    const entry = review.entries.find((item) => item.evidenceRef === "E0001");
    Object.assign(entry, {
      verdict: "missing",
      readerBlockRefs: [],
      verifiedQuotes: [],
      materialFacets: [],
      missingFacets: ["正文没有表达该命题"],
    });
  }
  const agreedMissing = resolveCoverageConsensus({ caseId: CASE_ID, ...data, coverageA: missingA, coverageB: missingB, adjudication: null });
  assert.equal(agreedMissing.metrics.adjudicationRequired, false);
  assert.equal(agreedMissing.metrics.adjudicatedSemanticCoverage, 0.5);
  assert.match(agreedMissing.errors.join("\n"), /missing=1/);

  const partialA = structuredClone(data.coverageA);
  const partialB = structuredClone(data.coverageB);
  for (const review of [partialA, partialB]) {
    const entry = review.entries.find((item) => item.evidenceRef === "E0001");
    Object.assign(entry, {
      verdict: "partial",
      confidence: 0.7,
      issueType: "semantic_conflict",
      readerBlockRefs: ["p-fact"],
      verifiedQuotes: [{ readerBlockRef: "p-fact", readerTextQuote: "模型能力取决于数据、训练与验证" }],
      materialFacets: ["模型能力"],
      missingFacets: ["数据、训练与验证的完整条件"],
    });
  }
  const agreedPartial = resolveCoverageConsensus({ caseId: CASE_ID, ...data, coverageA: partialA, coverageB: partialB, adjudication: null });
  assert.equal(agreedPartial.metrics.adjudicationRequired, false);
  assert.equal(agreedPartial.metrics.partialCount, 1);
  assert.match(agreedPartial.errors.join("\n"), /partial=1/);

  const coverageB = structuredClone(data.coverageB);
  coverageB.entries[1] = {
    evidenceRef: "E0002",
    verdict: "missing",
    confidence: 0.95,
    issueType: "none",
    readerBlockRefs: [],
    verifiedQuotes: [],
    materialFacets: ["部署前验证边界"],
    missingFacets: ["正文未表达该约束"],
    rationale: "没有找到表达。",
  };
  const noArbiter = structuredClone(data.adjudication);
  noArbiter.inputHashes.coverageB = sha256Value(coverageB);
  const unresolved = resolveCoverageConsensus({ caseId: CASE_ID, ...data, coverageB, adjudication: noArbiter });
  assert.equal(unresolved.metrics.unresolvedCount, 1);
  assert.match(unresolved.errors.join("\n"), /共识未解决/);

  const adjudication = structuredClone(noArbiter);
  adjudication.entries.push({
    evidenceRef: "E0002",
    triggers: ["verdict_conflict"],
    verdict: "covered",
    confidence: 0.95,
    issueType: "none",
    readerBlockRefs: ["p-view"],
    verifiedQuotes: [{ readerBlockRef: "p-view", readerTextQuote: "部署之前必须验证边界条件" }],
    rationale: "正文确实完整表达该命题。",
  });
  const resolved = resolveCoverageConsensus({ caseId: CASE_ID, ...data, coverageB, adjudication });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.entries.find((entry) => entry.evidenceRef === "E0002").decision, "arbiter");
});

test("fidelity is an independent hard gate", () => {
  const data = fixture();
  const fidelityReview = structuredClone(data.fidelityReview);
  fidelityReview.entries[1].verdict = "partial";
  fidelityReview.entries[1].unsupportedText = ["验证边界条件"];
  assert.deepEqual(fidelityReviewContractErrors(fidelityReview, { caseId: CASE_ID, claims: data.claims, deepRead: data.deepRead, research: data.research }), []);
  assert.equal(fidelityReviewGateFailures(fidelityReview).length, 1);
  assert.match(fidelityReviewContractErrors(fidelityReview, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
    research: data.research,
    requirePass: true,
  }).join("\n"), /未获完整来源支持/);
  const result = resolveCoverageConsensus({ caseId: CASE_ID, ...data, fidelityReview });
  assert.match(result.errors.join("\n"), /未获完整来源支持/);

  const undeclaredAudit = structuredClone(data);
  undeclaredAudit.deepRead.sections[0].modules[0].blocks[0].paragraphs[0].evidenceRefs.push("E0003");
  assert.match(fidelityReviewContractErrors(undeclaredAudit.fidelityReview, {
    caseId: CASE_ID,
    claims: undeclaredAudit.claims,
    deepRead: undeclaredAudit.deepRead,
    research: undeclaredAudit.research,
  }).join("\n"), /未核验 .*E0003/);

  const staleResearch = structuredClone(data.research);
  staleResearch.checks[0].explanation = "研究核验内容发生变化。";
  assert.match(fidelityReviewContractErrors(data.fidelityReview, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
    research: staleResearch,
  }).join("\n"), /inputHashes\.research 已过期/);

  const missingCitation = structuredClone(data.research);
  missingCitation.citations = [];
  const missingCitationReview = structuredClone(data.fidelityReview);
  missingCitationReview.inputHashes.research = sha256Value(missingCitation);
  assert.match(fidelityReviewContractErrors(missingCitationReview, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
    research: missingCitation,
  }).join("\n"), /未知外部资料：R1/);

  const uncheckedResearch = { ...structuredClone(data.research), checks: [] };
  const uncheckedReview = structuredClone(data.fidelityReview);
  uncheckedReview.inputHashes.research = sha256Value(uncheckedResearch);
  const uncheckedExternal = uncheckedReview.entries.find((entry) => entry.readerBlockRef === "p-external");
  uncheckedExternal.verdict = "partial";
  uncheckedExternal.unsupportedText = ["缺少可核验的研究检查"];
  assert.deepEqual(fidelityReviewContractErrors(uncheckedReview, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
    research: uncheckedResearch,
    requirePass: false,
  }), []);
  assert.ok(fidelityReviewGateFailures(uncheckedReview, { research: uncheckedResearch })
    .find((failure) => failure.readerBlockRef === "p-external")
    .reasons.includes("missing_research_check:R1"));
  assert.match(fidelityReviewContractErrors(uncheckedReview, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
    research: uncheckedResearch,
    requirePass: true,
  }).join("\n"), /引用缺少 research check：R1/);

  const disguisedEditorial = structuredClone(data.fidelityReview);
  disguisedEditorial.entries.find((entry) => entry.readerBlockRef === "pilot-note").provenance = "speaker_view";
  assert.match(fidelityReviewContractErrors(disguisedEditorial, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
    research: data.research,
  }).join("\n"), /审核来源类别与正文不一致/);
});

test("a single reader sentence cannot inherit more than ten high/medium claims", () => {
  const data = fixture();
  const paragraph = data.deepRead.sections[0].modules[0].blocks[0].paragraphs[0];
  const baseMap = data.readerMap.entries[0];
  const baseA = data.coverageA.entries[0];
  const baseB = data.coverageB.entries[0];
  for (let index = 4; index <= 13; index += 1) {
    const id = `E${String(index).padStart(4, "0")}`;
    data.claims.push({ id, importance: "high", provenance: "source_fact", themeId: "T001", statement: `模型条件命题 ${index}。` });
    paragraph.evidenceRefs.push(id);
    data.readerMap.entries.push({ ...structuredClone(baseMap), evidenceRef: id });
    data.coverageA.entries.push({ ...structuredClone(baseA), evidenceRef: id });
    data.coverageB.entries.push({ ...structuredClone(baseB), evidenceRef: id });
    data.fidelityReview.entries[0].evidenceRefs.push(id);
  }
  data.evidenceHash = sha256Value(data.claims);
  data.deepReadHash = sha256Value(data.deepRead);
  data.reviewManifest.inputHashes.evidence = data.evidenceHash;
  data.reviewManifest.inputHashes.deepRead = data.deepReadHash;
  data.reviewManifest.inputHashes.readerMap = sha256Value(data.readerMap);
  for (const review of [data.coverageA, data.coverageB, data.fidelityReview]) {
    review.inputHashes.evidence = data.evidenceHash;
    review.inputHashes.deepRead = data.deepReadHash;
  }
  assert.match(readerMapV2ContractErrors(data.readerMap, {
    caseId: CASE_ID,
    claims: data.claims,
    deepRead: data.deepRead,
  }).join("\n"), /超过 10 条硬上限/u);
  const result = resolveCoverageConsensus({ caseId: CASE_ID, ...data, adjudication: null, denseBlockThreshold: 10 });
  assert.equal(result.metrics.adjudicationRequired, true);
  assert.match(result.errors.join("\n"), /adjudication|共识未解决|dense_block/u);
  assert.ok(result.metrics.adjudicatedSemanticCoverage < 1);
});

test("review manifest locks the nine roles and reviewer independence", () => {
  const hash = "a".repeat(64);
  const assignments = [
    ["claim_auditor", "agent-claim"],
    ["blind_recall", "agent-blind"],
    ["alignment", "agent-align"],
    ["coverage_a", "agent-coverage-a"],
    ["coverage_b", "agent-coverage-b"],
    ["fidelity", "agent-fidelity"],
    ["reader_advocate", "agent-reader"],
    ["adjudicator", "agent-adjudicator"],
    ["repair_editor", "agent-writer"],
  ].map(([role, reviewerId]) => ({ role, reviewerId }));
  const manifest = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    workflowVersion: "2.2.0",
    reviewRound: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
    assignments,
    inputHashes: { segments: hash, evidence: hash, claimReview: hash, deepRead: hash, readerMap: hash, claimBundles: hash, research: hash },
    artifacts: {
      claimReview: "work/reviews/claim-review.json",
      blindCandidates: "work/reviews/blind-candidates.json",
      blindAlignment: "work/reviews/blind-alignment.json",
      coverageA: "work/reviews/coverage-a.json",
      coverageB: "work/reviews/coverage-b.json",
      fidelityReview: "work/reviews/fidelity.json",
      readerReview: "work/reviews/reader.json",
      adjudication: "work/reviews/adjudication.json",
      claimBundles: "work/claim-bundles.json",
      evidenceMigration: null,
      repairLog: "work/reviews/repair-log.json",
    },
  };
  assert.deepEqual(reviewManifestContractErrors(manifest, { caseId: CASE_ID }), []);
  const invalid = structuredClone(manifest);
  invalid.assignments.find((item) => item.role === "coverage_b").reviewerId = "agent-coverage-a";
  assert.match(reviewManifestContractErrors(invalid, { caseId: CASE_ID }).join("\n"), /必须由不同审核员/);
  const reused = structuredClone(manifest);
  reused.assignments.find((item) => item.role === "alignment").reviewerId = "agent-fidelity";
  assert.match(reviewManifestContractErrors(reused, { caseId: CASE_ID }).join("\n"), /唯一 reviewerId/);
});

test("blind recall is separated from semantic alignment and reports real recall", () => {
  const data = fixture();
  const segmentsHash = "b".repeat(64);
  const candidates = {
    schemaVersion: "1.1.0",
    caseId: CASE_ID,
    role: "blind_recall",
    reviewerId: "agent-blind",
    reviewRound: 1,
    inputHashes: { segments: segmentsHash },
    blindToEvidence: true,
    entries: [{ id: "BC0001", statement: data.claims[0].statement, importance: "high", importanceRationale: "它承载核心事实。", confidence: 0.95, claimRole: "fact", supportSpans: [{ segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01" }] }],
  };
  const alignment = {
    schemaVersion: "1.1.0",
    caseId: CASE_ID,
    role: "alignment",
    reviewerId: "agent-align",
    reviewRound: 1,
    inputHashes: { blindCandidates: sha256Value(candidates), evidence: data.evidenceHash },
    entries: [{ candidateRef: "BC0001", relation: "equivalent", candidateValidity: "valid", calibratedImportance: "high", materialFacet: false, themeId: "T001", matchedEvidenceRefs: ["E0001"], missingFacets: [], rationale: "命题等价。" }],
  };
  assert.deepEqual(blindCandidateContractErrors(candidates, { caseId: CASE_ID, segmentsHash }), []);
  assert.deepEqual(blindAlignmentContractErrors(alignment, { caseId: CASE_ID, candidates, claims: data.claims }), []);
  assert.equal(blindRecallMetrics(candidates, alignment).highMediumRecall, 1);
});

test("claim audit, claim bundles, reader review and evidence migration have deterministic gates", () => {
  const data = fixture();
  const segmentsHash = "c".repeat(64);
  const claimReview = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "agent-claim",
    reviewRound: 1,
    inputHashes: { segments: segmentsHash, evidence: data.evidenceHash },
    entries: data.claims.map((claim) => ({
      evidenceRef: claim.id,
      verdict: "pass",
      atomicity: "pass",
      support: "supported",
      importance: { verdict: "confirmed", proposed: null },
      theme: { verdict: "confirmed", proposedThemeId: null },
      speaker: "unknown_safe",
      issues: [],
      rationale: "原子性、重要度与主题均已复核。",
    })),
  };
  assert.deepEqual(claimReviewContractErrors(claimReview, { caseId: CASE_ID, claims: data.claims, segmentsHash }), []);
  const corruptedReview = structuredClone(claimReview);
  corruptedReview.entries[0].rationale = "????????";
  assert.match(claimReviewContractErrors(corruptedReview, {
    caseId: CASE_ID,
    claims: data.claims,
    segmentsHash,
  }).join("\n"), /损坏字符|问号占位/u);
  const ambiguousMerge = structuredClone(claimReview);
  ambiguousMerge.entries[0] = {
    ...ambiguousMerge.entries[0],
    verdict: "merge",
    mergeWithRefs: [],
    issues: ["与另一条 claim 重复。"],
  };
  assert.match(claimReviewContractErrors(ambiguousMerge, {
    caseId: CASE_ID,
    claims: data.claims,
    segmentsHash,
  }).join("\n"), /唯一 canonical claim/u);

  const underspecifiedSplit = structuredClone(claimReview);
  underspecifiedSplit.entries[0] = {
    ...underspecifiedSplit.entries[0],
    verdict: "split",
    atomicity: "fail",
    replacementStatements: ["只有一条替换命题。"],
    issues: ["复合命题。"],
  };
  assert.match(claimReviewContractErrors(underspecifiedSplit, {
    caseId: CASE_ID,
    claims: data.claims,
    segmentsHash,
  }).join("\n"), /至少两条原子 replacementStatements/u);

  const bundles = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    inputHashes: { evidence: data.evidenceHash, claimReview: sha256Value(claimReview) },
    bundles: [
      { id: "CB001", themeId: "T001", order: 1, title: "能力条件", narrativePurpose: "解释能力成立条件。", readerBlockRef: "p-fact", requiredReaderRefs: ["E0001"], optionalReaderRefs: [], evidenceOnlyRefs: ["E0003"] },
      { id: "CB002", themeId: "T002", order: 2, title: "部署边界", narrativePurpose: "说明嘉宾的部署判断。", readerBlockRef: "p-view", requiredReaderRefs: ["E0002"], optionalReaderRefs: [], evidenceOnlyRefs: [] },
    ],
  };
  assert.deepEqual(claimBundleContractErrors(bundles, { caseId: CASE_ID, claims: data.claims, claimReviewHash: sha256Value(claimReview) }), []);
  assert.deepEqual(claimBundleContractErrors(bundles, {
    caseId: CASE_ID,
    claims: data.claims,
    claimReviewHash: sha256Value(claimReview),
    deepRead: data.deepRead,
    readerMap: data.readerMap,
  }), []);
  const detached = structuredClone(bundles);
  detached.bundles[0].readerBlockRef = "p-view";
  assert.match(claimBundleContractErrors(detached, {
    caseId: CASE_ID,
    claims: data.claims,
    claimReviewHash: sha256Value(claimReview),
    deepRead: data.deepRead,
    readerMap: data.readerMap,
  }).join("\n"), /未写入|bundle 外|reader-map/u);

  const markdownHash = sha256Text("读者版");
  const readerReview = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "reader_advocate",
    reviewerId: "agent-reader",
    reviewRound: 1,
    inputHashes: { deepRead: data.deepReadHash, readerMarkdown: markdownHash },
    evidenceBlind: true,
    scores: { coherence: 4, terminology: 5, repetition: 4, hierarchy: 5, profileFit: 4, informationLoad: 5 },
    verdict: "pass",
    issues: [],
    summary: "可读性通过。",
  };
  assert.deepEqual(readerReviewContractErrors(readerReview, { caseId: CASE_ID, deepRead: data.deepRead, readerMarkdownHash: markdownHash }), []);
  const revision = structuredClone(readerReview);
  revision.scores.hierarchy = 3;
  revision.verdict = "revise";
  revision.issues = [{
    severity: "error",
    readerBlockRefs: ["p-view"],
    description: "层级跳转过快。",
    suggestion: "补充过渡句。",
  }];
  assert.deepEqual(readerReviewContractErrors(revision, { caseId: CASE_ID, deepRead: data.deepRead, readerMarkdownHash: markdownHash }), []);
  assert.equal(readerReviewGateFailures(revision).length, 1);
  assert.match(readerReviewContractErrors(revision, {
    caseId: CASE_ID,
    deepRead: data.deepRead,
    readerMarkdownHash: markdownHash,
    requirePass: true,
  }).join("\n"), /尚未通过|error 级问题|hierarchy/u);

  const oldClaims = [{ id: "E0001" }, { id: "E0002" }];
  const newClaims = [{ id: "E0001" }, { id: "E0002" }, { id: "E0003" }];
  const migration = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    fromWorkflow: "2.1.0",
    toWorkflow: "2.2.0",
    inputHashes: { oldEvidence: sha256Value(oldClaims), newEvidence: sha256Value(newClaims) },
    entries: [
      { id: "EM0001", status: "split", oldEvidenceRefs: ["E0001"], newEvidenceRefs: ["E0001", "E0002"], rationale: "复合切窗拆成两个原子命题。" },
      { id: "EM0002", status: "rewritten", oldEvidenceRefs: ["E0002"], newEvidenceRefs: ["E0003"], rationale: "清理 ASR 后重写。" },
    ],
  };
  assert.deepEqual(evidenceMigrationContractErrors(migration, { caseId: CASE_ID, oldClaims, newClaims }), []);
});

test("all QuickRead 2.2 review schemas are valid JSON", async () => {
  const names = [
    "review-manifest",
    "claim-review",
    "blind-candidate",
    "blind-alignment",
    "coverage-review",
    "fidelity-review",
    "reader-review",
    "adjudication",
    "claim-bundle",
    "evidence-migration",
    "repair-log",
  ];
  for (const name of names) JSON.parse(await fs.readFile(path.join(REPO_ROOT, "schemas", `${name}.schema.json`), "utf8"));
});

test("merged legacy claims keep a source anchor for every predecessor", () => {
  const oldClaims = [
    { id: "E0001", supportSpans: [{ sourceIds: ["C000001"] }] },
    { id: "E0002", supportSpans: [{ sourceIds: ["C000009"] }] },
  ];
  const newClaims = [{ id: "E0100", supportSpans: [{ sourceIds: ["C000001"] }] }];
  const migration = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    fromWorkflow: "2.1.0",
    toWorkflow: "2.2.0",
    inputHashes: { oldEvidence: sha256Value(oldClaims), newEvidence: sha256Value(newClaims) },
    entries: [{
      id: "EM0001",
      status: "merged",
      oldEvidenceRefs: ["E0001", "E0002"],
      newEvidenceRefs: ["E0100"],
      rationale: "合并语义重复 claim，并保留全部出现位置。",
    }],
  };
  assert.match(evidenceMigrationContractErrors(migration, {
    caseId: CASE_ID,
    oldClaims,
    newClaims,
  }).join("\n"), /E0002.*来源位置重叠/u);

  newClaims[0].supportSpans.push({ sourceIds: ["C000009"] });
  migration.inputHashes.newEvidence = sha256Value(newClaims);
  assert.deepEqual(evidenceMigrationContractErrors(migration, {
    caseId: CASE_ID,
    oldClaims,
    newClaims,
  }), []);
});

test("repair editor is capped at two rounds and cannot conceal stale outputs", () => {
  const before = {
    consensus: "a".repeat(64),
    evidence: "b".repeat(64),
    deepRead: "c".repeat(64),
    readerMap: "d".repeat(64),
    research: "2".repeat(64),
  };
  const after = { evidence: "e".repeat(64), deepRead: "f".repeat(64), readerMap: "1".repeat(64), research: "3".repeat(64) };
  const log = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "repair_editor",
    reviewerId: "agent-repair",
    reviewRound: 1,
    repairRound: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    inputHashes: before,
    outputHashes: after,
    changes: [{ issueRef: "coverage-e0002", action: "qualifier_patch", readerBlockRefs: ["p-view"], evidenceRefs: ["E0002"], summary: "补回部署成立条件。" }],
    unresolvedIssueRefs: [],
    briefInvalidated: true,
  };
  const options = {
    caseId: CASE_ID,
    reviewRound: 1,
    reviewerId: "agent-repair",
    consensusHash: before.consensus,
    evidenceBeforeHash: before.evidence,
    deepReadBeforeHash: before.deepRead,
    readerMapBeforeHash: before.readerMap,
    researchBeforeHash: before.research,
    evidenceAfterHash: after.evidence,
    deepReadAfterHash: after.deepRead,
    readerMapAfterHash: after.readerMap,
    researchAfterHash: after.research,
  };
  assert.deepEqual(repairLogContractErrors(log, options), []);
  const migrationAware = structuredClone(log);
  migrationAware.inputHashes.evidenceMigration = "4".repeat(64);
  migrationAware.outputHashes.evidenceMigration = "5".repeat(64);
  migrationAware.inputHashes.claimBundles = "7".repeat(64);
  migrationAware.outputHashes.claimBundles = "8".repeat(64);
  migrationAware.inputHashes.themeMap = "9".repeat(64);
  migrationAware.outputHashes.themeMap = "0".repeat(64);
  const migrationOptions = {
    ...options,
    evidenceMigrationBeforeHash: "4".repeat(64),
    evidenceMigrationAfterHash: "5".repeat(64),
    claimBundlesBeforeHash: "7".repeat(64),
    claimBundlesAfterHash: "8".repeat(64),
    themeMapBeforeHash: "9".repeat(64),
    themeMapAfterHash: "0".repeat(64),
  };
  assert.deepEqual(repairLogContractErrors(migrationAware, migrationOptions), []);
  migrationAware.outputHashes.evidenceMigration = "6".repeat(64);
  assert.match(repairLogContractErrors(migrationAware, migrationOptions).join("\n"), /evidenceMigration/u);
  migrationAware.outputHashes.evidenceMigration = "5".repeat(64);
  migrationAware.outputHashes.themeMap = "1".repeat(64);
  assert.match(repairLogContractErrors(migrationAware, migrationOptions).join("\n"), /themeMap/u);
  const invalid = structuredClone(log);
  invalid.repairRound = 3;
  invalid.briefInvalidated = false;
  assert.match(repairLogContractErrors(invalid, options).join("\n"), /1–2/);
  assert.match(repairLogContractErrors(invalid, options).join("\n"), /brief/);
});





