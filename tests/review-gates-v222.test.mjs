import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReaderReview,
  readerAdjudicationContractErrors,
  readerGatePolicyFromConfig,
  readerGatePolicyHash,
  resolveReaderPair,
  sha256ReviewValue,
} from "../scripts/reader-review-gate.mjs";
import {
  evaluateFidelityReview,
  fidelityVerdictContractErrors,
} from "../scripts/fidelity-review-gate.mjs";

const HASH = "a".repeat(64);

function config() {
  return {
    reviews: {
      readerDimensions: ["coherence", "terminology", "repetition", "hierarchy", "profileFit", "informationLoad"],
      readerGate: {
        coreDimensions: ["coherence", "profileFit", "informationLoad"],
        weights: {
          coherence: 2,
          terminology: 1,
          repetition: 1,
          hierarchy: 1,
          profileFit: 2,
          informationLoad: 2,
        },
        cleanPassMinimumScore: 4,
        borderlineMinimumScore: 3,
        borderlineMinimumWeightedAverage: 3.8,
        borderlineMaximumThreeScores: 2,
      },
    },
  };
}

function readerReview(scores, { role = "reader_advocate", verdict = null, issues = [] } = {}) {
  const policy = readerGatePolicyFromConfig(config());
  const draft = {
    schemaVersion: "1.1.0",
    caseId: "qr-9999-reader-gate",
    role,
    reviewerId: role === "reader_advocate" ? "reader-primary" : "reader-secondary",
    reviewRound: 2,
    inputHashes: { deepRead: HASH, readerMarkdown: HASH, readerGate: readerGatePolicyHash(policy) },
    evidenceBlind: true,
    scores,
    verdict: verdict ?? "revise",
    issues,
    summary: "读者审核。",
  };
  if (!verdict) draft.verdict = evaluateReaderReview(draft, policy, { ignoreDeclaredVerdict: true }).classification;
  return draft;
}

test("reader 2.2.2 policy is config-driven and hash-bound", () => {
  const policy = readerGatePolicyFromConfig(config());
  assert.deepEqual(policy.coreDimensions, ["coherence", "profileFit", "informationLoad"]);
  assert.equal(policy.weights.coherence, 2);
  assert.equal(policy.weights.terminology, 1);
  assert.equal(policy.borderlineMinimumWeightedAverage, 3.8);
  assert.equal(readerGatePolicyHash(policy).length, 64);

  const changed = config();
  changed.reviews.readerGate.borderlineMinimumWeightedAverage = 3.9;
  assert.notEqual(readerGatePolicyHash(policy), readerGatePolicyHash(readerGatePolicyFromConfig(changed)));
  assert.throws(() => readerGatePolicyFromConfig({ reviews: { readerDimensions: policy.dimensions } }), /readerGate/u);
});

test("reader gate distinguishes clean_pass, borderline, and revise", () => {
  const policy = readerGatePolicyFromConfig(config());
  const clean = readerReview({ coherence: 4, terminology: 4, repetition: 4, hierarchy: 4, profileFit: 4, informationLoad: 4 });
  assert.equal(evaluateReaderReview(clean, policy).classification, "clean_pass");

  const borderline = readerReview({ coherence: 4, terminology: 5, repetition: 3, hierarchy: 3, profileFit: 4, informationLoad: 4 });
  const borderlineResult = evaluateReaderReview(borderline, policy);
  assert.equal(borderlineResult.classification, "borderline");
  assert.equal(borderlineResult.needsSecondary, true);
  assert.equal(borderlineResult.weightedAverage, 35 / 9);

  const errorIssue = readerReview(
    { coherence: 5, terminology: 5, repetition: 5, hierarchy: 5, profileFit: 5, informationLoad: 5 },
    { issues: [{ severity: "error", readerBlockRefs: [], description: "阻断。", suggestion: "修复。" }] },
  );
  assert.equal(evaluateReaderReview(errorIssue, policy).classification, "revise");

  const scoreOne = readerReview({ coherence: 5, terminology: 1, repetition: 5, hierarchy: 5, profileFit: 5, informationLoad: 5 });
  assert.match(evaluateReaderReview(scoreOne, policy).reasons.join(" "), /score_1/u);

  const coreTwo = readerReview({ coherence: 2, terminology: 5, repetition: 5, hierarchy: 5, profileFit: 5, informationLoad: 5 });
  assert.match(evaluateReaderReview(coreTwo, policy).reasons.join(" "), /core_score_2/u);

  const threeThrees = readerReview({ coherence: 5, terminology: 3, repetition: 3, hierarchy: 3, profileFit: 5, informationLoad: 5 });
  assert.equal(evaluateReaderReview(threeThrees, policy).classification, "revise");
  assert.match(evaluateReaderReview(threeThrees, policy).reasons.join(" "), /too_many_score_3/u);
});

test("borderline reader gets an independent second review and only outcome disagreement is adjudicated", () => {
  const policy = readerGatePolicyFromConfig(config());
  const primary = readerReview({ coherence: 4, terminology: 5, repetition: 3, hierarchy: 3, profileFit: 4, informationLoad: 4 });
  const matching = readerReview(
    { coherence: 4, terminology: 5, repetition: 3, hierarchy: 3, profileFit: 4, informationLoad: 4 },
    { role: "reader_advocate_secondary" },
  );
  assert.deepEqual(resolveReaderPair(primary, matching, policy), {
    status: "pass",
    requiresAdjudication: false,
    primaryClassification: "borderline",
    secondaryClassification: "borderline",
    disputedDimensions: [],
  });

  const cleanSecondary = readerReview(
    { coherence: 4, terminology: 4, repetition: 4, hierarchy: 4, profileFit: 4, informationLoad: 4 },
    { role: "reader_advocate_secondary" },
  );
  const disagreement = resolveReaderPair(primary, cleanSecondary, policy);
  assert.equal(disagreement.status, "pending");
  assert.equal(disagreement.requiresAdjudication, true);
  assert.deepEqual(disagreement.disputedDimensions.sort(), ["hierarchy", "repetition", "terminology"]);
});

test("reader adjudication is reviewer-isolated and stale when either reader report changes", () => {
  const policy = readerGatePolicyFromConfig(config());
  const primary = readerReview({ coherence: 4, terminology: 5, repetition: 3, hierarchy: 3, profileFit: 4, informationLoad: 4 });
  const secondary = readerReview(
    { coherence: 4, terminology: 4, repetition: 4, hierarchy: 4, profileFit: 4, informationLoad: 4 },
    { role: "reader_advocate_secondary" },
  );
  const adjudication = {
    schemaVersion: "1.0.0",
    caseId: primary.caseId,
    role: "reader_adjudicator",
    reviewerId: "reader-adjudicator",
    reviewRound: primary.reviewRound,
    inputHashes: {
      deepRead: HASH,
      readerMarkdown: HASH,
      readerGate: readerGatePolicyHash(policy),
      primaryReaderReview: sha256ReviewValue(primary),
      secondaryReaderReview: sha256ReviewValue(secondary),
    },
    evidenceBlind: true,
    decision: "pass",
    disputedDimensions: ["terminology", "repetition", "hierarchy"],
    rationale: "两份报告均无 blocker，差异不改变整体可读性。",
  };
  const context = {
    caseId: primary.caseId,
    reviewRound: primary.reviewRound,
    deepReadHash: HASH,
    readerMarkdownHash: HASH,
    policy,
    primary,
    secondary,
    assignedReviewerId: "reader-adjudicator",
    forbiddenReviewerIds: [primary.reviewerId, secondary.reviewerId],
  };
  assert.deepEqual(readerAdjudicationContractErrors(adjudication, context), []);
  const stale = structuredClone(primary);
  stale.summary = "changed";
  assert.match(readerAdjudicationContractErrors(adjudication, { ...context, primary: stale }).join("\n"), /primaryReaderReview.*stale/u);
  assert.match(readerAdjudicationContractErrors({ ...adjudication, reviewerId: primary.reviewerId }, context).join("\n"), /reviewerId.*isolated/u);
});

function fidelityEntry(overrides = {}) {
  return {
    readerBlockRef: "theme-p1",
    verdict: "supported",
    provenance: "speaker_view",
    evidenceRefs: ["E0001"],
    citationRefs: [],
    unsupportedText: [],
    provenanceVerdict: "correct",
    impact: "none",
    rationale: "支持。",
    ...overrides,
  };
}

function fidelityReview(entries, verdicts) {
  return {
    schemaVersion: "1.1.0",
    caseId: "qr-9999-fidelity-gate",
    role: "fidelity",
    reviewerId: "fidelity-reviewer",
    reviewRound: 2,
    inputHashes: { evidence: HASH, deepRead: HASH, research: HASH },
    entries,
    ...verdicts,
  };
}

test("fidelity 2.2.2 keeps navigation warnings and blockers separate from content", () => {
  const warningEntries = [
    fidelityEntry(),
    fidelityEntry({
      readerBlockRef: "timeline-01",
      provenance: "system",
      verdict: "partial",
      evidenceRefs: ["E0002"],
      unsupportedText: ["语义标签略宽"],
      impact: "navigation_warning",
    }),
  ];
  const warning = fidelityReview(warningEntries, {
    contentVerdict: "pass",
    navigationVerdict: "warning",
    packageVerdict: "pass",
  });
  const result = evaluateFidelityReview(warning);
  assert.equal(result.contentVerdict, "pass");
  assert.equal(result.navigationVerdict, "warning");
  assert.equal(result.packageVerdict, "pass");
  assert.equal(result.navigationWarnings.length, 1);

  const blocked = structuredClone(warning);
  blocked.entries[1].impact = "navigation_blocker";
  blocked.navigationVerdict = "block";
  blocked.packageVerdict = "revise";
  const blockedResult = evaluateFidelityReview(blocked);
  assert.equal(blockedResult.contentVerdict, "pass");
  assert.equal(blockedResult.packageVerdict, "revise");
  assert.equal(blockedResult.navigationBlockers.length, 1);
});

test("fidelity content and external/provenance failures remain hard blockers", () => {
  const content = fidelityReview([
    fidelityEntry({ verdict: "partial", unsupportedText: ["扩大了因果"], impact: "content_blocker" }),
  ], { contentVerdict: "revise", navigationVerdict: "pass", packageVerdict: "revise" });
  assert.equal(evaluateFidelityReview(content).contentBlockers.length, 1);

  const external = fidelityReview([
    fidelityEntry({
      readerBlockRef: "external-p1",
      provenance: "external",
      evidenceRefs: [],
      citationRefs: ["R1"],
      impact: "external_provenance_blocker",
    }),
  ], { contentVerdict: "revise", navigationVerdict: "pass", packageVerdict: "revise" });
  const externalResult = evaluateFidelityReview(external, { research: { citations: [{ id: "R1" }], checks: [] } });
  assert.equal(externalResult.externalProvenanceBlockers.length, 1);
  assert.match(externalResult.externalProvenanceBlockers[0].reasons.join(" "), /missing_research_check:R1/u);
});

test("fidelity declared verdicts and entry impacts must match computed gate state", () => {
  const report = fidelityReview([
    fidelityEntry({
      readerBlockRef: "timeline-01",
      provenance: "system",
      verdict: "partial",
      evidenceRefs: ["E0002"],
      unsupportedText: ["时间点不支持"],
      impact: "navigation_blocker",
    }),
  ], { contentVerdict: "revise", navigationVerdict: "warning", packageVerdict: "pass" });
  const errors = fidelityVerdictContractErrors(report);
  assert.match(errors.join("\n"), /contentVerdict/u);
  assert.match(errors.join("\n"), /navigationVerdict/u);
  assert.match(errors.join("\n"), /packageVerdict/u);
});
