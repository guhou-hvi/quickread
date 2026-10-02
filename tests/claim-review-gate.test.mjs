import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessClaimReview, resolveClaimReview } from "../scripts/claim-review-gate.mjs";
import { claimReviewResolutionContractErrors, sha256Value } from "../scripts/review-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASE_ID = "qr-9999-claim-gate";
const SEGMENTS_HASH = "a".repeat(64);
const CLAIMS = [
  { id: "E0001", statement: "Deployment requires a verified boundary." },
  { id: "E0002", statement: "The fallback remains available." },
];
const EVIDENCE_HASH = sha256Value(CLAIMS);
const CONTEXT = { caseId: CASE_ID, claims: CLAIMS, segmentsHash: SEGMENTS_HASH, evidenceHash: EVIDENCE_HASH };

function organizationReview() {
  return {
    ...fullReview([
      { ...passEntry("E0001"), verdict: "split", atomicity: "fail", findingCodes: ["compound_claim"],
        issues: ["These supported propositions could be organized separately."],
        replacementStatements: ["First supported proposition.", "Second supported proposition."] },
      { ...passEntry("E0002"), findingCodes: [] },
    ]),
    schemaVersion: "1.1.0", auditMode: "full", scope: { evidenceRefs: CLAIMS.map((claim) => claim.id) },
  };
}

test("2.4.2 supported compound-only findings retain hash-bound machine warnings, not invented auditor passes", () => {
  const primary = organizationReview();
  const original = structuredClone(primary);
  const context = { ...CONTEXT, workflowVersion: "2.4.2", reviewRound: 1, primary };
  const resolution = resolveClaimReview({ primary, context });
  assert.equal(resolution.status, "pass");
  assert.deepEqual(resolution.targetRefs, []);
  assert.deepEqual(resolution.decisions, []);
  assert.equal(resolution.warningDispositions[0].evidenceRef, "E0001");
  assert.equal(resolution.warningDispositions[0].entryHash, sha256Value(primary.entries[0]));
  assert.deepEqual(primary, original);
  assert.deepEqual(claimReviewResolutionContractErrors(resolution, context), []);
  for (const version of [undefined, "2.4.0", "2.3.2"]) {
    assert.equal(resolveClaimReview({ primary, context: { ...CONTEXT, workflowVersion: version } }).status, "needs_secondary");
    assert.notDeepEqual(claimReviewResolutionContractErrors(resolution, { ...context, workflowVersion: version }), []);
  }
  for (const mutate of [
    (value) => { value.warningDispositions[0].entryHash = "b".repeat(64); },
    (value) => { value.warningDispositions = []; },
    (value) => { delete value.warningDispositions; },
    (value) => { value.inputHashes.evidence = "b".repeat(64); },
  ]) {
    const forged = structuredClone(resolution);
    mutate(forged);
    assert.notDeepEqual(claimReviewResolutionContractErrors(forged, context), []);
  }
});

test("organization policy never demotes mixed findings, unsafe axes, legacy inference, or stale reports", () => {
  for (const mutate of [
    (entry) => { entry.findingCodes.push("overstatement"); },
    (entry) => { entry.findingCodes.push("support_gap"); },
    (entry) => { entry.findingCodes.push("other_semantic"); },
    (entry) => { entry.support = "partial"; },
    (entry) => { entry.speaker = "change"; },
    (entry) => { entry.importance = { verdict: "change", proposed: "low" }; },
    (entry) => { entry.theme = { verdict: "change", proposedThemeId: "T002" }; },
    (entry) => { entry.findingCodes.push("not_a_code"); },
  ]) {
    const primary = organizationReview();
    mutate(primary.entries[0]);
    const resolution = resolveClaimReview({ primary, context: { ...CONTEXT, workflowVersion: "2.4.2" } });
    assert.notEqual(resolution.status, "pass");
    assert.equal(resolution.warningDispositions?.length ?? 0, 0);
  }
  const primary = organizationReview();
  primary.inputHashes.segments = "b".repeat(64);
  assert.equal(resolveClaimReview({ primary, context: { ...CONTEXT, workflowVersion: "2.4.2" } }).status, "invalid");
  const legacy = organizationReview();
  legacy.schemaVersion = "1.0.0";
  delete legacy.auditMode;
  delete legacy.scope;
  assert.equal(resolveClaimReview({ primary: legacy, context: { ...CONTEXT, workflowVersion: "2.4.2" } }).status, "needs_secondary");
});

function passEntry(evidenceRef) {
  return {
    evidenceRef,
    verdict: "pass",
    atomicity: "pass",
    support: "supported",
    importance: { verdict: "confirmed", proposed: null },
    theme: { verdict: "confirmed", proposedThemeId: null },
    speaker: "unknown_safe",
    issues: [],
    rationale: "The contiguous source span fully supports this atomic claim.",
  };
}

function reviseEntry(evidenceRef = "E0001") {
  return {
    ...passEntry(evidenceRef),
    verdict: "revise",
    support: "partial",
    issues: ["The claim omits a material qualifier."],
    rationale: "The cited span supports only the qualified version.",
  };
}

function fullReview(entries, reviewerId = "agent-primary") {
  return {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId,
    reviewRound: 1,
    inputHashes: { segments: SEGMENTS_HASH, evidence: EVIDENCE_HASH },
    entries,
  };
}

function targetedReview(primary, entries, {
  reviewerId = "agent-secondary",
  scopeRefs = entries.map((entry) => entry.evidenceRef),
  targetHash = sha256Value([...scopeRefs].sort()),
} = {}) {
  return {
    schemaVersion: "1.1.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId,
    reviewRound: 1,
    auditMode: "targeted",
    scope: { evidenceRefs: scopeRefs },
    inputHashes: {
      segments: SEGMENTS_HASH,
      evidence: EVIDENCE_HASH,
      primaryClaimReview: sha256Value(primary),
      targetSet: targetHash,
    },
    entries,
  };
}

function adjudicationFor(primary, secondary, preliminary, entries, reviewerId = "agent-claim-adjudicator") {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_adjudicator",
    reviewerId,
    reviewRound: 1,
    inputHashes: {
      segments: SEGMENTS_HASH,
      evidence: EVIDENCE_HASH,
      primaryClaimReview: sha256Value(primary),
      secondaryClaimReview: sha256Value(secondary),
      targetSet: sha256Value(preliminary.conflicts.map((conflict) => conflict.evidenceRef).sort()),
    },
    entries,
  };
}

function evidenceForMechanicalFix({ firstQuote, secondQuote = "The fallback remains available." } = {}) {
  return CLAIMS.map((claim, index) => ({
    ...claim,
    supportSpans: [{
      segmentId: "S000" + (index + 1),
      sourceIds: ["C00000" + (index + 1)],
      locator: "00:00:0" + (index + 1),
      ...(index === 0
        ? (firstQuote === undefined ? {} : { quote: firstQuote })
        : (secondQuote === undefined ? {} : { quote: secondQuote })),
    }],
  }));
}

function quoteIgnoredHash(claims) {
  return sha256Value(claims.map((claim) => ({
    ...claim,
    supportSpans: claim.supportSpans.map((span) => Object.fromEntries(Object.entries(span).filter(([key]) => key !== "quote"))),
  })));
}

function mechanicalPrimary(beforeClaims, findingCodes = ["missing_support_quote"]) {
  return {
    schemaVersion: "1.1.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "agent-primary-mechanical",
    reviewRound: 1,
    auditMode: "full",
    scope: { evidenceRefs: beforeClaims.map((claim) => claim.id) },
    inputHashes: { segments: SEGMENTS_HASH, evidence: sha256Value(beforeClaims) },
    entries: [{
      ...passEntry("E0001"),
      verdict: "revise",
      findingCodes,
      issues: ["supportSpans.quote is missing."],
      rationale: "The support span is correct but lacks its exact quote.",
    }, {
      ...passEntry("E0002"),
      findingCodes: [],
    }],
  };
}

function mechanicalFixFor(primary, beforeClaims, afterClaims, {
  entries = [{
    evidenceRef: "E0001",
    findingCode: "missing_support_quote",
    status: "mechanically_resolved",
    supportSpanIndexes: [0],
  }],
} = {}) {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_mechanical_fix",
    reviewRound: 1,
    inputHashes: {
      primaryClaimReview: sha256Value(primary),
      beforeEvidence: sha256Value(beforeClaims),
      afterEvidence: sha256Value(afterClaims),
      beforeQuoteIgnoredEvidence: quoteIgnoredHash(beforeClaims),
      afterQuoteIgnoredEvidence: quoteIgnoredHash(afterClaims),
    },
    entries,
  };
}

test("legacy 1.0 nonpass is a semantic finding, not a contract error", () => {
  const review = fullReview([reviseEntry(), passEntry("E0002")]);
  const assessment = assessClaimReview(review, CONTEXT);
  assert.equal(assessment.valid, true, JSON.stringify(assessment.contractErrors));
  assert.deepEqual(assessment.reviewedRefs, ["E0001", "E0002"]);
  assert.deepEqual(assessment.semanticFindings.map((finding) => finding.evidenceRef), ["E0001"]);
  assert.deepEqual(assessment.semanticFindings[0].findingCodes, ["support_gap"]);
});

test("stale hashes and illegal merge targets remain mechanical contract errors", () => {
  const merge = {
    ...passEntry("E0001"),
    verdict: "merge",
    mergeWithRefs: ["E9999"],
    issues: ["Duplicate."],
  };
  const review = fullReview([merge, passEntry("E0002")]);
  review.inputHashes.evidence = "b".repeat(64);
  const assessment = assessClaimReview(review, CONTEXT);
  assert.equal(assessment.valid, false);
  assert.match(assessment.contractErrors.join("\n"), /evidence.*stale/u);
  assert.match(assessment.contractErrors.join("\n"), /unknown claim E9999/u);
});

test("an all-pass legacy primary review passes without a second auditor", () => {
  const primary = fullReview([passEntry("E0001"), passEntry("E0002")]);
  const resolution = resolveClaimReview({ primary, context: CONTEXT });
  assert.equal(resolution.status, "pass", JSON.stringify(resolution.contractErrors));
  assert.deepEqual(resolution.contractErrors, []);
  assert.deepEqual(resolution.targetRefs, []);
});

test("a primary semantic finding requests only a targeted second review", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const resolution = resolveClaimReview({ primary, context: CONTEXT });
  assert.equal(resolution.status, "needs_secondary");
  assert.deepEqual(resolution.targetRefs, ["E0001"]);
  assert.equal(resolution.inputHashes.targetSet, sha256Value(["E0001"]));
});

test("two auditors agreeing on a nonpass finding require repair without adjudication", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const secondaryEntry = { ...reviseEntry(), findingCodes: ["support_gap"] };
  const secondary = targetedReview(primary, [secondaryEntry]);
  const resolution = resolveClaimReview({ primary, secondary, context: CONTEXT });
  assert.equal(resolution.status, "repair_required", JSON.stringify(resolution.contractErrors));
  assert.equal(resolution.metrics.agreementCount, 1);
  assert.equal(resolution.metrics.conflictCount, 0);
  assert.deepEqual(resolution.semanticFailures.map((finding) => finding.evidenceRef), ["E0001"]);
});

test("split agreement ignores exact replacement wording but preserves structured remedy conflicts", () => {
  const primarySplit = {
    ...passEntry("E0001"),
    verdict: "split",
    atomicity: "fail",
    replacementStatements: ["Boundary is verified.", "Deployment follows verification."],
    issues: ["Compound claim."],
  };
  const secondarySplit = {
    ...primarySplit,
    findingCodes: ["compound_claim"],
    replacementStatements: ["Verify the boundary.", "Then deploy."],
  };
  const primary = fullReview([primarySplit, passEntry("E0002")]);
  const secondary = targetedReview(primary, [secondarySplit]);
  const resolution = resolveClaimReview({ primary, secondary, context: CONTEXT });
  assert.equal(resolution.status, "repair_required", JSON.stringify(resolution.contractErrors));
  assert.equal(resolution.conflicts.length, 0);
});

test("pass/nonpass disagreement requires adjudication and an adjudicator may select only one side", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const secondary = targetedReview(primary, [{ ...passEntry("E0001"), findingCodes: [] }]);
  const preliminary = resolveClaimReview({ primary, secondary, context: CONTEXT });
  assert.equal(preliminary.status, "needs_adjudication", JSON.stringify(preliminary.contractErrors));
  assert.deepEqual(preliminary.conflicts[0].triggers, ["verdict_conflict", "finding_conflict"]);

  const chooseSecondary = adjudicationFor(primary, secondary, preliminary, [{
    evidenceRef: "E0001",
    triggers: preliminary.conflicts[0].triggers,
    selection: "secondary",
    confidence: 0.9,
    rationale: "The complete span supports the original wording.",
  }]);
  const passed = resolveClaimReview({ primary, secondary, adjudication: chooseSecondary, context: CONTEXT });
  assert.equal(passed.status, "pass", JSON.stringify(passed.contractErrors));
  assert.equal(passed.metrics.resolvedPassCount, 1);

  const choosePrimary = structuredClone(chooseSecondary);
  choosePrimary.entries[0].selection = "primary";
  const repair = resolveClaimReview({ primary, secondary, adjudication: choosePrimary, context: CONTEXT });
  assert.equal(repair.status, "repair_required", JSON.stringify(repair.contractErrors));
  assert.equal(repair.metrics.resolvedNonpassCount, 1);

  const invented = structuredClone(chooseSecondary);
  invented.entries[0].selection = "third_decision";
  const invalid = resolveClaimReview({ primary, secondary, adjudication: invented, context: CONTEXT });
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.contractErrors.join("\n"), /invalid selection/u);
});

test("low-confidence or unreviewable adjudication escalates to a human", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const secondary = targetedReview(primary, [{ ...passEntry("E0001"), findingCodes: [] }]);
  const preliminary = resolveClaimReview({ primary, secondary, context: CONTEXT });
  const adjudication = adjudicationFor(primary, secondary, preliminary, [{
    evidenceRef: "E0001",
    triggers: preliminary.conflicts[0].triggers,
    selection: "secondary",
    confidence: 0.79,
    rationale: "The supplied span does not support a reliable distinction.",
  }]);
  const resolution = resolveClaimReview({ primary, secondary, adjudication, context: CONTEXT });
  assert.equal(resolution.status, "human_required", JSON.stringify(resolution.contractErrors));
});

test("an adjudicator may retain a supported original claim when both supplied remedies are wrong", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const secondaryEntry = reviseEntry();
  secondaryEntry.findingCodes = ["support_gap"];
  secondaryEntry.replacementStatements = ["A different but still unsupported rewrite."];
  const secondary = targetedReview(primary, [secondaryEntry]);
  const preliminary = resolveClaimReview({ primary, secondary, context: CONTEXT });
  assert.equal(preliminary.status, "needs_adjudication", JSON.stringify(preliminary.contractErrors));
  const keepOriginal = adjudicationFor(primary, secondary, preliminary, [{
    evidenceRef: "E0001",
    triggers: preliminary.conflicts[0].triggers,
    selection: "original",
    confidence: 0.95,
    rationale: "The complete source span supports the original claim; both proposed rewrites remove supported meaning.",
  }]);
  const resolution = resolveClaimReview({ primary, secondary, adjudication: keepOriginal, context: CONTEXT });
  assert.equal(resolution.status, "pass", JSON.stringify(resolution.contractErrors));
  assert.equal(resolution.semanticFailures.length, 0);
  assert.equal(resolution.decisions[0].verdict, "pass");
});

test("targeted scope, hashes, rounds, and reviewer independence are mechanical gates", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const secondary = targetedReview(primary, [{ ...reviseEntry(), findingCodes: ["support_gap"] }], {
    reviewerId: primary.reviewerId,
    scopeRefs: ["E0001", "E0002"],
    targetHash: "c".repeat(64),
  });
  secondary.reviewRound = 2;
  const resolution = resolveClaimReview({ primary, secondary, context: CONTEXT });
  assert.equal(resolution.status, "invalid");
  assert.match(resolution.contractErrors.join("\n"), /different reviewer IDs/u);
  assert.match(resolution.contractErrors.join("\n"), /expected target set/u);
  assert.match(resolution.contractErrors.join("\n"), /targetSet.*stale/u);
  assert.match(resolution.contractErrors.join("\n"), /same review round/u);
});

test("claim adjudication is hash-bound and independent from both auditors", () => {
  const primary = fullReview([reviseEntry(), passEntry("E0002")]);
  const secondary = targetedReview(primary, [{ ...passEntry("E0001"), findingCodes: [] }]);
  const preliminary = resolveClaimReview({ primary, secondary, context: CONTEXT });
  const adjudication = adjudicationFor(primary, secondary, preliminary, [{
    evidenceRef: "E0001",
    triggers: preliminary.conflicts[0].triggers,
    selection: "secondary",
    confidence: 0.9,
    rationale: "The source supports the secondary decision.",
  }], secondary.reviewerId);
  adjudication.inputHashes.secondaryClaimReview = "d".repeat(64);
  const resolution = resolveClaimReview({ primary, secondary, adjudication, context: CONTEXT });
  assert.equal(resolution.status, "invalid");
  assert.match(resolution.contractErrors.join("\n"), /independent from both claim auditors/u);
  assert.match(resolution.contractErrors.join("\n"), /secondaryClaimReview.*stale/u);
});

test("a missing support quote is mechanical and cannot pass without a validated bridge", () => {
  const beforeClaims = evidenceForMechanicalFix();
  const primary = mechanicalPrimary(beforeClaims);
  const context = { ...CONTEXT, claims: beforeClaims, evidenceHash: sha256Value(beforeClaims) };
  const assessment = assessClaimReview(primary, context);
  assert.equal(assessment.valid, true, JSON.stringify(assessment.contractErrors));
  assert.equal(assessment.semanticFindings.length, 0);
  assert.deepEqual(assessment.mechanicalFindings.map((finding) => finding.evidenceRef), ["E0001"]);
  const resolution = resolveClaimReview({ primary, context });
  assert.equal(resolution.status, "needs_mechanical_fix");
  assert.equal(resolution.metrics.mechanicalResolvedCount, 0);
});

test("a validated quote-only bridge binds current evidence and passes a mechanically repaired primary", () => {
  const beforeClaims = evidenceForMechanicalFix();
  const afterClaims = evidenceForMechanicalFix({ firstQuote: "Deployment requires a verified boundary." });
  const primary = mechanicalPrimary(beforeClaims);
  const mechanicalFix = mechanicalFixFor(primary, beforeClaims, afterClaims);
  const context = {
    ...CONTEXT,
    claims: afterClaims,
    evidenceHash: sha256Value(afterClaims),
    preRepairClaims: beforeClaims,
  };
  const resolution = resolveClaimReview({ primary, mechanicalFix, context });
  assert.equal(resolution.status, "pass", JSON.stringify(resolution.contractErrors));
  assert.equal(resolution.inputHashes.evidence, sha256Value(afterClaims));
  assert.equal(resolution.inputHashes.mechanicalFix, sha256Value(mechanicalFix));
  assert.equal(resolution.metrics.mechanicalResolvedCount, 1);
  assert.equal(primary.inputHashes.evidence, sha256Value(beforeClaims));
});

test("mechanical bridge rejects stale after hashes and quote-ignored semantic changes", () => {
  const beforeClaims = evidenceForMechanicalFix();
  const afterClaims = evidenceForMechanicalFix({ firstQuote: "Deployment requires a verified boundary." });
  afterClaims[0].statement = "Deployment always succeeds.";
  const primary = mechanicalPrimary(beforeClaims);
  const mechanicalFix = mechanicalFixFor(primary, beforeClaims, afterClaims);
  mechanicalFix.inputHashes.afterEvidence = "e".repeat(64);
  const context = {
    ...CONTEXT,
    claims: afterClaims,
    evidenceHash: sha256Value(afterClaims),
    preRepairClaims: beforeClaims,
  };
  const resolution = resolveClaimReview({ primary, mechanicalFix, context });
  assert.equal(resolution.status, "invalid");
  assert.match(resolution.contractErrors.join("\n"), /afterEvidence.*stale/u);
  assert.match(resolution.contractErrors.join("\n"), /changed quote-ignored evidence semantics/u);
});

test("mechanical bridge rejects rewrites of existing quotes and partial quote repair", () => {
  const beforeExisting = evidenceForMechanicalFix({ firstQuote: "Original exact quote." });
  const afterExisting = evidenceForMechanicalFix({ firstQuote: "Rewritten quote." });
  const primaryExisting = mechanicalPrimary(beforeExisting);
  const rewriteReport = mechanicalFixFor(primaryExisting, beforeExisting, afterExisting);
  const rewrite = resolveClaimReview({
    primary: primaryExisting,
    mechanicalFix: rewriteReport,
    context: {
      ...CONTEXT,
      claims: afterExisting,
      evidenceHash: sha256Value(afterExisting),
      preRepairClaims: beforeExisting,
    },
  });
  assert.equal(rewrite.status, "invalid");
  assert.match(rewrite.contractErrors.join("\n"), /changed an existing supportSpans.quote/u);

  const beforePartial = evidenceForMechanicalFix();
  beforePartial[0].supportSpans.push({ segmentId: "S0003", sourceIds: ["C000003"], locator: "00:00:03" });
  const afterPartial = structuredClone(beforePartial);
  afterPartial[0].supportSpans[0].quote = "Deployment requires a verified boundary.";
  const primaryPartial = mechanicalPrimary(beforePartial);
  const partialReport = mechanicalFixFor(primaryPartial, beforePartial, afterPartial);
  const partial = resolveClaimReview({
    primary: primaryPartial,
    mechanicalFix: partialReport,
    context: {
      ...CONTEXT,
      claims: afterPartial,
      evidenceHash: sha256Value(afterPartial),
      preRepairClaims: beforePartial,
    },
  });
  assert.equal(partial.status, "invalid");
  assert.match(partial.contractErrors.join("\n"), /leaves at least one supportSpans.quote missing/u);
});

test("mechanical resolution never exempts a semantic finding on the same claim", () => {
  const beforeClaims = evidenceForMechanicalFix();
  const afterClaims = evidenceForMechanicalFix({ firstQuote: "Deployment requires a verified boundary." });
  const primary = mechanicalPrimary(beforeClaims, ["missing_support_quote", "support_gap"]);
  primary.entries[0].support = "partial";
  primary.entries[0].issues.push("The statement also omits a qualifier.");
  const mechanicalFix = mechanicalFixFor(primary, beforeClaims, afterClaims);
  const context = {
    ...CONTEXT,
    claims: afterClaims,
    evidenceHash: sha256Value(afterClaims),
    preRepairClaims: beforeClaims,
  };
  const resolution = resolveClaimReview({ primary, mechanicalFix, context });
  assert.equal(resolution.status, "needs_secondary", JSON.stringify(resolution.contractErrors));
  assert.deepEqual(resolution.targetRefs, ["E0001"]);
  assert.equal(resolution.metrics.mechanicalResolvedCount, 1);
});

test("new schemas and the isolated claim-adjudicator prompt are present and parseable", async () => {
  const names = ["claim-review", "claim-mechanical-fix", "claim-adjudication", "claim-review-resolution"];
  const schemas = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    JSON.parse(await fs.readFile(path.join(REPO_ROOT, "schemas", name + ".schema.json"), "utf8")),
  ])));
  assert.deepEqual(schemas["claim-review"].properties.schemaVersion.enum, ["1.0.0", "1.1.0"]);
  assert.equal(schemas["claim-mechanical-fix"].properties.role.const, "claim_mechanical_fix");
  assert.match(schemas["claim-mechanical-fix"].properties.entries.description, /not primary.*mechanicalResolvedCount/u);
  assert.equal(schemas["claim-adjudication"].properties.role.const, "claim_adjudicator");
  assert.equal(schemas["claim-review-resolution"].properties.workflowVersion.const, "2.2.1");
  assert.match(schemas["claim-review-resolution"].properties.metrics.properties.mechanicalResolvedCount.description, /primary missing_support_quote.*not counted/u);
  const prompt = await fs.readFile(path.join(REPO_ROOT, "prompts", "reviews", "claim-adjudicator.md"), "utf8");
  assert.match(prompt, /只读取.*packet/u);
  assert.match(prompt, /不得发明第三种 verdict/u);
  const mechanicalPrompt = await fs.readFile(path.join(REPO_ROOT, "prompts", "reviews", "claim-mechanical-fix.md"), "utf8");
  assert.match(mechanicalPrompt, /beforeQuoteIgnoredEvidence/u);
  assert.match(mechanicalPrompt, /不能由本报告豁免/u);
});
