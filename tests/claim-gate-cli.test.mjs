import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  adjudicatorReferenceContext,
  ClaimGateOrchestrationError,
  claimGatePaths,
  prepareClaimGate,
  reconstructPreRepairClaims,
  resolveClaimGate,
  validateClaimOrganizationWarningResolution,
} from "../scripts/claim-gate.mjs";
import { sha256Value } from "../scripts/review-contract.mjs";
import { loadReviewState } from "../scripts/quality-report.mjs";
import { acceptEvidenceBaseline } from "../scripts/evidence-diff.mjs";

const CASE_ID = "qr-9999-claim-gate-cli";

function segment(id, text) {
  return {
    schemaVersion: "1.0.0",
    id,
    caseId: CASE_ID,
    sourceIds: [`C${id.slice(1).padStart(6, "0")}`],
    contextBefore: [],
    contextAfter: [],
    locator: { type: "time", label: "00:00:01–00:00:02", start: "00:00:01", end: "00:00:02" },
    text,
    speaker: { name: null, status: "unknown", confidence: 0 },
  };
}

function claim(id, segmentId, statement) {
  return {
    schemaVersion: "2.0.0",
    id,
    caseId: CASE_ID,
    statement,
    provenance: "source_fact",
    importance: "high",
    claimRole: "fact",
    speaker: { name: null, status: "unknown", confidence: 0 },
    themeId: "T001",
    supportSpans: [{ segmentId, sourceIds: [`C${segmentId.slice(1).padStart(6, "0")}`], locator: "00:00:01–00:00:02" }],
  };
}

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
    rationale: "The exact source segment supports this atomic statement.",
  };
}

function reviseEntry(evidenceRef = "E0001") {
  return {
    ...passEntry(evidenceRef),
    verdict: "revise",
    support: "partial",
    issues: ["The primary reviewer found a material qualifier."],
    rationale: "The primary rationale must never enter the targeted packet.",
  };
}

function mechanicalEntry(evidenceRef = "E0001") {
  return {
    ...passEntry(evidenceRef),
    verdict: "revise",
    findingCodes: ["missing_support_quote"],
    issues: ["The support span needs its exact source quote."],
    rationale: "The claim semantics are supported; only the quote field is missing.",
  };
}

function mergeEntry(evidenceRef = "E0001", mergeWithRef = "E0002") {
  return {
    ...passEntry(evidenceRef),
    verdict: "merge",
    mergeWithRefs: [mergeWithRef],
    issues: ["This claim may duplicate the referenced claim."],
    rationale: "The duplicate decision requires comparison with the referenced claim.",
  };
}

function themeMap() {
  return {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    profile: "general",
    themes: [
      {
        id: "T001",
        order: 1,
        title: "Verified deployment",
        summary: "Claims about verification boundaries before deployment.",
        profileModules: ["constraint"],
        claimRefs: ["E0001"],
        importanceCoverage: { high: 1, medium: 0, low: 0 },
      },
      {
        id: "T002",
        order: 2,
        title: "Fallback resilience",
        summary: "Claims about maintaining fallback paths and operational resilience.",
        profileModules: ["risk"],
        claimRefs: ["E0002"],
        importanceCoverage: { high: 1, medium: 0, low: 0 },
      },
    ],
    unassignedClaimRefs: [],
  };
}

function quoteIgnoredHash(claims) {
  return sha256Value(claims.map((item) => ({
    ...item,
    supportSpans: item.supportSpans.map(({ quote: ignored, ...span }) => span),
  })));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, values) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

test("a passing first audit resolves before synthesis; repair still requires theme context", async (t) => {
  const value = await fixture(t, { entries: [passEntry("E0001"), passEntry("E0002")] });
  await fs.unlink(path.join(value.caseDir, "work", "theme-map.json"));
  const result = await resolveClaimGate(value.caseDir);
  assert.equal(result.resolution.status, "pass");
  value.primary.entries[0] = reviseEntry();
  await writeJson(path.join(value.caseDir, "work", "claim-review.json"), value.primary);
  await assert.rejects(resolveClaimGate(value.caseDir), /Theme definitions/u);
});

async function fixture(t, { entries = [reviseEntry(), passEntry("E0002")] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-claim-gate-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const caseDir = path.join(root, CASE_ID);
  const segments = [
    segment("S0001", "Deployment requires a verified boundary."),
    segment("S0002", "The fallback remains available."),
  ];
  const claims = [
    claim("E0001", "S0001", "Deployment requires a verified boundary."),
    claim("E0002", "S0002", "The fallback remains available."),
  ];
  const themes = themeMap();
  const primary = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "agent-primary",
    reviewRound: 3,
    inputHashes: { segments: sha256Value(segments), evidence: sha256Value(claims) },
    entries,
  };
  await Promise.all([
    writeJson(path.join(caseDir, "work", "claim-review.json"), primary),
    writeJsonl(path.join(caseDir, "work", "segments.jsonl"), segments),
    writeJsonl(path.join(caseDir, "work", "evidence.jsonl"), claims),
    writeJson(path.join(caseDir, "work", "theme-map.json"), themes),
  ]);
  return { caseDir, segments, claims, primary, themeMap: themes };
}

test("2.4.2 CLI organization warnings bind baseline acceptance and quality to immutable audit inputs", async (t) => {
  const built = await fixture(t);
  const primary = { ...built.primary, schemaVersion: "1.1.0", auditMode: "full",
    scope: { evidenceRefs: built.claims.map((entry) => entry.id) },
    entries: [
      { ...passEntry("E0001"), verdict: "split", atomicity: "fail", findingCodes: ["compound_claim"],
        issues: ["Organization advice only."], replacementStatements: ["First proposition.", "Second proposition."] },
      { ...passEntry("E0002"), findingCodes: [] },
    ] };
  const source = "Source fixture.";
  const manifest = { id: CASE_ID, workflow: { version: "2.4.2" },
    source: { path: "input/source.txt", sha256: crypto.createHash("sha256").update(source).digest("hex") } };
  await fs.mkdir(path.join(built.caseDir, "input"), { recursive: true });
  await fs.writeFile(path.join(built.caseDir, "input", "source.txt"), source, "utf8");
  await writeJson(path.join(built.caseDir, "case.json"), manifest);
  await writeJson(path.join(built.caseDir, "work", "claim-review.json"), primary);
  await writeJsonl(path.join(built.caseDir, "work", "source.normalized.jsonl"), [{ id: "C000001", text: source }]);
  const original = await fs.readFile(path.join(built.caseDir, "work", "claim-review.json"), "utf8");
  const prepared = await prepareClaimGate(built.caseDir);
  assert.equal(prepared.status, "pass");
  assert.equal(prepared.packetPath, null);
  assert.equal((await resolveClaimGate(built.caseDir)).resolution.status, "pass");
  const checked = await validateClaimOrganizationWarningResolution(built.caseDir, { ...built, manifest });
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.warnings.length, 1);
  await acceptEvidenceBaseline(built.caseDir);
  const baseline = JSON.parse(await fs.readFile(path.join(built.caseDir, "work", "evidence-baseline.json"), "utf8"));
  assert.equal(baseline.claimOrganizationWarningResolution, sha256Value(prepared.resolution));
  const forged = structuredClone(prepared.resolution);
  forged.warningDispositions[0].entryHash = "b".repeat(64);
  await writeJson(prepared.resolutionPath, forged);
  await assert.rejects(acceptEvidenceBaseline(built.caseDir), /warning|Claim Gate/u);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(built.caseDir, "work", "evidence-baseline.json"), "utf8")), baseline);
  const quality = await loadReviewState(built.caseDir, { ...built, manifest,
    config: { reviews: { version: "2.4.2" } } });
  assert.notEqual(quality.status, "pass");
  assert.match(quality.errors.join("\n"), /warning|Claim Gate/u);
  assert.equal(await fs.readFile(path.join(built.caseDir, "work", "claim-review.json"), "utf8"), original);
});

async function mechanicalFixture(t, {
  mixed = false,
  bridge = true,
  extraQuote = false,
  primaryMechanical = true,
  legacyQuoteIssue = false,
  legacyIssueText = "supportSpans.quote 为空；需逐字复制对应连续 sourceUnits 作为规范化引文。",
  legacyExtraIssue = false,
  legacySupportFailure = false,
  mutateReport = null,
} = {}) {
  const built = await fixture(t);
  const beforeClaims = structuredClone(built.claims);
  built.primary.schemaVersion = legacyQuoteIssue ? "1.0.0" : "1.1.0";
  if (!legacyQuoteIssue) {
    built.primary.auditMode = "full";
    built.primary.scope = { evidenceRefs: beforeClaims.map((item) => item.id) };
  }
  const legacyEntry = {
    ...passEntry("E0001"),
    verdict: "revise",
    support: legacySupportFailure ? "partial" : "supported",
    issues: [
      legacyIssueText,
      ...(legacyExtraIssue ? ["The statement also omits a material qualifier."] : []),
    ],
    rationale: "The claim is supported, but one or more exact support quotes are missing.",
  };
  built.primary.entries = [
    legacyQuoteIssue ? legacyEntry : (primaryMechanical ? mechanicalEntry() : { ...passEntry("E0001"), findingCodes: [] }),
    legacyQuoteIssue
      ? (mixed ? reviseEntry("E0002") : passEntry("E0002"))
      : (mixed ? { ...reviseEntry("E0002"), findingCodes: ["support_gap"] } : { ...passEntry("E0002"), findingCodes: [] }),
  ];
  built.primary.inputHashes.evidence = sha256Value(beforeClaims);
  await writeJson(path.join(built.caseDir, "work", "claim-review.json"), built.primary);
  if (!bridge) return { ...built, beforeClaims, currentClaims: beforeClaims, mechanicalFix: null };

  const currentClaims = structuredClone(beforeClaims);
  currentClaims[0].supportSpans[0].quote = built.segments[0].text;
  if (extraQuote) currentClaims[1].supportSpans[0].quote = built.segments[1].text;
  await writeJsonl(path.join(built.caseDir, "work", "evidence.jsonl"), currentClaims);
  const mechanicalFix = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_mechanical_fix",
    reviewRound: built.primary.reviewRound,
    inputHashes: {
      primaryClaimReview: sha256Value(built.primary),
      beforeEvidence: sha256Value(beforeClaims),
      afterEvidence: sha256Value(currentClaims),
      beforeQuoteIgnoredEvidence: quoteIgnoredHash(beforeClaims),
      afterQuoteIgnoredEvidence: quoteIgnoredHash(currentClaims),
    },
    entries: [
      {
        evidenceRef: "E0001",
        findingCode: "missing_support_quote",
        status: "mechanically_resolved",
        supportSpanIndexes: [0],
      },
      ...(extraQuote ? [{
        evidenceRef: "E0002",
        findingCode: "missing_support_quote",
        status: "mechanically_resolved",
        supportSpanIndexes: [0],
      }] : []),
    ],
  };
  mutateReport?.(mechanicalFix);
  await writeJson(path.join(built.caseDir, "work", "claim-mechanical-fix.json"), mechanicalFix);
  return { ...built, beforeClaims, currentClaims, mechanicalFix };
}

function targetedReport(packet, entry, reviewerId = packet.assignedReviewerId) {
  return {
    schemaVersion: "1.1.0",
    caseId: packet.caseId,
    role: "claim_auditor",
    reviewerId,
    reviewRound: packet.reviewRound,
    auditMode: "targeted",
    scope: { evidenceRefs: [...packet.payload.scope.evidenceRefs] },
    inputHashes: { ...packet.inputHashes },
    entries: [entry],
  };
}

test("prepare exposes only real primary semantic failures and hides the primary decision", async (t) => {
  const { caseDir, primary, themeMap: themes } = await fixture(t);
  const prepared = await prepareClaimGate(caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "needs_secondary");
  assert.deepEqual(prepared.targetRefs, ["E0001"]);
  assert.equal(prepared.packet.role, "claim_auditor");
  assert.equal(prepared.packet.gateStage, "targeted_secondary");
  assert.deepEqual(prepared.packet.payload.scope.evidenceRefs, ["E0001"]);
  assert.deepEqual(prepared.packet.payload.claims.map((item) => item.id), ["E0001"]);
  assert.deepEqual(prepared.packet.payload.claims[0].supportSegments.map((item) => item.id), ["S0001"]);
  assert.deepEqual(prepared.packet.payload.themeDefinitions, themes.themes.map((theme) => ({
    id: theme.id,
    title: theme.title,
    thesis: theme.summary,
  })));
  assert.equal(prepared.packet.packetContract.inputHashes.themeMap, sha256Value(themes));
  assert.equal(prepared.packet.packetContract.inputHashes.themeDefinitions, sha256Value(prepared.packet.payload.themeDefinitions));
  assert.match(prepared.packetPath, new RegExp(`themes-${sha256Value(themes).slice(0, 12)}`, "u"));
  assert.equal(Object.hasOwn(prepared.packet.payload.claims[0], "verdict"), false);
  const isolatedPayload = JSON.stringify(prepared.packet.payload);
  assert.doesNotMatch(isolatedPayload, /agent-primary|primary rationale|material qualifier/u);
  assert.equal(prepared.packet.inputHashes.primaryClaimReview, sha256Value(primary));
  assert.equal(prepared.packet.inputHashes.targetSet, sha256Value(["E0001"]));

  const repeated = await prepareClaimGate(caseDir, { reviewerId: "agent-secondary" });
  assert.equal(repeated.reused, true);
  await assert.rejects(
    prepareClaimGate(caseDir, { reviewerId: "agent-primary" }),
    (error) => error instanceof ClaimGateOrchestrationError && /independent/u.test(error.message),
  );
});

test("an invalid primary cannot produce a packet and an all-pass primary needs no secondary", async (t) => {
  const invalid = await fixture(t);
  invalid.primary.inputHashes.evidence = "f".repeat(64);
  await writeJson(path.join(invalid.caseDir, "work", "claim-review.json"), invalid.primary);
  await assert.rejects(
    prepareClaimGate(invalid.caseDir, { reviewerId: "agent-secondary" }),
    (error) => error instanceof ClaimGateOrchestrationError && error.errors.some((item) => /stale/u.test(item)),
  );
  const invalidPaths = claimGatePaths(invalid.caseDir, invalid.primary);
  await assert.rejects(fs.access(invalidPaths.secondaryPacket));

  const clean = await fixture(t, { entries: [passEntry("E0001"), passEntry("E0002")] });
  const result = await prepareClaimGate(clean.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(result.status, "pass");
  assert.equal(result.packetPath, null);
});

test("resolve accepts an isolated agreeing secondary and atomically writes repair resolution", async (t) => {
  const { caseDir } = await fixture(t);
  const prepared = await prepareClaimGate(caseDir, { reviewerId: "agent-secondary" });
  const secondaryEntry = { ...reviseEntry(), findingCodes: ["support_gap"] };
  const secondary = targetedReport(prepared.packet, secondaryEntry);
  const paths = claimGatePaths(caseDir, await fs.readFile(path.join(caseDir, "work", "claim-review.json"), "utf8").then(JSON.parse));
  await writeJson(paths.secondary, secondary);

  const result = await resolveClaimGate(caseDir);
  assert.equal(result.resolution.status, "repair_required", JSON.stringify(result.resolution.contractErrors));
  assert.deepEqual(result.resolution.targetRefs, ["E0001"]);
  assert.deepEqual(result.resolution.semanticFailures.map((item) => item.evidenceRef), ["E0001"]);
  assert.equal(result.adjudicatorPacketPath, null);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.resolution, "utf8")), result.resolution);
});

test("resolve creates an anonymous conflict-only adjudicator packet and consumes its result", async (t) => {
  const { caseDir, primary } = await fixture(t);
  const prepared = await prepareClaimGate(caseDir, { reviewerId: "agent-secondary" });
  const secondary = targetedReport(prepared.packet, { ...passEntry("E0001"), findingCodes: [] });
  const paths = claimGatePaths(caseDir, primary);
  await writeJson(paths.secondary, secondary);

  const pending = await resolveClaimGate(caseDir, { adjudicatorReviewerId: "agent-claim-arbiter" });
  assert.equal(pending.resolution.status, "needs_adjudication", JSON.stringify(pending.resolution.contractErrors));
  assert.equal(pending.packet.gateStage, "anonymous_adjudication");
  assert.equal(pending.packet.payload.reviewerIdentitiesHidden, true);
  assert.equal(pending.packet.payload.themeDefinitions.length, 2);
  assert.equal(pending.packet.packetContract.inputHashes.themeMap, sha256Value(themeMap()));
  assert.deepEqual(pending.packet.payload.scope.evidenceRefs, ["E0001"]);
  assert.equal(pending.packet.payload.conflicts.length, 1);
  assert.deepEqual(pending.packet.payload.conflicts[0].claim.supportSegments.map((item) => item.id), ["S0001"]);
  const anonymousPacket = JSON.stringify(pending.packet);
  assert.doesNotMatch(anonymousPacket, /agent-primary|agent-secondary|primary rationale|exact source segment supports/u);

  const conflict = pending.packet.payload.conflicts[0];
  const adjudication = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_adjudicator",
    reviewerId: pending.packet.assignedReviewerId,
    reviewRound: pending.packet.reviewRound,
    inputHashes: { ...pending.packet.inputHashes },
    entries: [{
      evidenceRef: conflict.evidenceRef,
      triggers: [...conflict.triggers],
      selection: "secondary",
      confidence: 0.94,
      rationale: "The supplied source segment supports the secondary option.",
    }],
  };
  await writeJson(paths.adjudication, adjudication);
  const resolved = await resolveClaimGate(caseDir);
  assert.equal(resolved.resolution.status, "pass", JSON.stringify(resolved.resolution.contractErrors));
  assert.equal(resolved.resolution.reviewerIds.adjudicator, "agent-claim-arbiter");
  assert.equal(resolved.resolution.metrics.resolvedPassCount, 1);
});

test("resolve ignores a retained adjudication bound to an older review and writes the current conflict packet", async (t) => {
  const { caseDir, primary } = await fixture(t);
  const prepared = await prepareClaimGate(caseDir, { reviewerId: "agent-secondary" });
  const secondary = targetedReport(prepared.packet, { ...passEntry("E0001"), findingCodes: [] });
  const paths = claimGatePaths(caseDir, primary);
  await writeJson(paths.secondary, secondary);
  const historical = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_adjudicator",
    reviewerId: "agent-old-arbiter",
    reviewRound: primary.reviewRound - 1,
    inputHashes: {
      segments: "a".repeat(64),
      evidence: "b".repeat(64),
      primaryClaimReview: "c".repeat(64),
      secondaryClaimReview: "d".repeat(64),
      targetSet: "e".repeat(64),
    },
    entries: [{
      evidenceRef: "E0001",
      triggers: ["verdict_conflict"],
      selection: "primary",
      confidence: 0.9,
      rationale: "This decision belongs to the retained older review lineage.",
    }],
  };
  await writeJson(paths.adjudication, historical);

  const pending = await resolveClaimGate(caseDir, { adjudicatorReviewerId: "agent-current-arbiter" });
  assert.equal(pending.resolution.status, "needs_adjudication", JSON.stringify(pending.resolution.contractErrors));
  assert.equal(pending.packet.assignedReviewerId, "agent-current-arbiter");
  assert.ok(pending.adjudicatorPacketPath);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.adjudication, "utf8")), historical);
});

test("resolve rejects malformed adjudication that claims the current round and hash lineage", async (t) => {
  const { caseDir, primary } = await fixture(t);
  const prepared = await prepareClaimGate(caseDir, { reviewerId: "agent-secondary" });
  const secondary = targetedReport(prepared.packet, { ...passEntry("E0001"), findingCodes: [] });
  const paths = claimGatePaths(caseDir, primary);
  await writeJson(paths.secondary, secondary);
  const pending = await resolveClaimGate(caseDir, { adjudicatorReviewerId: "agent-current-arbiter" });
  assert.equal(pending.resolution.status, "needs_adjudication", JSON.stringify(pending.resolution.contractErrors));

  const malformed = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: CASE_ID,
    role: "claim_adjudicator",
    reviewerId: pending.packet.assignedReviewerId,
    reviewRound: pending.packet.reviewRound,
    inputHashes: { ...pending.packet.inputHashes },
    entries: [],
  };
  await writeJson(paths.adjudication, malformed);
  const invalid = await resolveClaimGate(caseDir);
  assert.equal(invalid.resolution.status, "invalid");
  assert.match(invalid.resolution.contractErrors.join("\n"), /entries must be a non-empty array/u);
});

test("adjudicator packet includes only hash-bound claims referenced by anonymous merge choices", async (t) => {
  const built = await fixture(t, { entries: [mergeEntry(), passEntry("E0002")] });
  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  const secondary = targetedReport(prepared.packet, { ...passEntry("E0001"), findingCodes: [] });
  const paths = claimGatePaths(built.caseDir, built.primary);
  await writeJson(paths.secondary, secondary);

  const pending = await resolveClaimGate(built.caseDir, { adjudicatorReviewerId: "agent-claim-arbiter" });
  assert.equal(pending.resolution.status, "needs_adjudication", JSON.stringify(pending.resolution.contractErrors));
  assert.deepEqual(pending.packet.payload.referencedClaims.map((item) => item.id), ["E0002"]);
  assert.deepEqual(Object.keys(pending.packet.payload.referencedClaims[0]).sort(), [
    "id", "provenance", "statement", "supportSegments", "supportSpans", "themeId",
  ]);
  assert.deepEqual(pending.packet.payload.referencedClaims[0].supportSegments.map((item) => item.id), ["S0002"]);
  const contextHash = sha256Value(pending.packet.payload.referencedClaims);
  assert.equal(pending.packet.packetContract.inputHashes.referencedClaims, contextHash);
  assert.match(pending.adjudicatorPacketPath, new RegExp(`referenced-${contextHash.slice(0, 12)}`, "u"));
  const isolated = JSON.stringify(pending.packet);
  assert.doesNotMatch(isolated, /agent-primary|agent-secondary|duplicate decision requires comparison/u);
});

test("missing merge references fail the adjudicator context contract before packet delivery", () => {
  const claims = [claim("E0001", "S0001", "Deployment requires a verified boundary.")];
  const segments = [segment("S0001", "Deployment requires a verified boundary.")];
  const conflicts = [{
    evidenceRef: "E0001",
    primary: { remedy: { mergeWithRefs: ["E9999"] } },
    secondary: { remedy: { mergeWithRefs: [] } },
  }];
  assert.throws(
    () => adjudicatorReferenceContext(claims, segments, conflicts),
    (error) => error instanceof ClaimGateOrchestrationError
      && /incomplete/u.test(error.message)
      && error.errors.some((item) => /E9999.*missing/u.test(item)),
  );
});

test("resolve rejects unprepared, stale-scope, and non-independent secondary reports", async (t) => {
  const unprepared = await fixture(t);
  const primaryHash = sha256Value(unprepared.primary);
  const report = {
    schemaVersion: "1.1.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "agent-secondary",
    reviewRound: 3,
    auditMode: "targeted",
    scope: { evidenceRefs: ["E0001"] },
    inputHashes: {
      segments: sha256Value(unprepared.segments),
      evidence: sha256Value(unprepared.claims),
      primaryClaimReview: primaryHash,
      targetSet: sha256Value(["E0001"]),
    },
    entries: [{ ...reviseEntry(), findingCodes: ["support_gap"] }],
  };
  const unpreparedPaths = claimGatePaths(unprepared.caseDir, unprepared.primary);
  await writeJson(unpreparedPaths.secondary, report);
  const missingPacket = await resolveClaimGate(unprepared.caseDir);
  assert.equal(missingPacket.resolution.status, "invalid");
  assert.match(missingPacket.resolution.contractErrors.join("\n"), /Missing isolated targeted_secondary packet/u);

  const stale = await fixture(t);
  const prepared = await prepareClaimGate(stale.caseDir, { reviewerId: "agent-secondary" });
  const bad = targetedReport(prepared.packet, { ...reviseEntry(), findingCodes: ["support_gap"] }, "agent-primary");
  bad.scope.evidenceRefs.push("E0002");
  bad.inputHashes.targetSet = "d".repeat(64);
  const stalePaths = claimGatePaths(stale.caseDir, stale.primary);
  await writeJson(stalePaths.secondary, bad);
  const invalid = await resolveClaimGate(stale.caseDir);
  assert.equal(invalid.resolution.status, "invalid");
  const errors = invalid.resolution.contractErrors.join("\n");
  assert.match(errors, /different reviewer IDs/u);
  assert.match(errors, /expected target set/u);
  assert.match(errors, /targetSet.*stale/u);
  assert.match(errors, /reviewer assignment does not match/u);
});

test("resolve ignores a retained secondary bound to an older primary lineage", async (t) => {
  const built = await fixture(t);
  const historical = {
    schemaVersion: "1.1.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "agent-old-secondary",
    reviewRound: built.primary.reviewRound - 1,
    auditMode: "targeted",
    scope: { evidenceRefs: ["E0001"] },
    inputHashes: {
      segments: "a".repeat(64),
      evidence: "b".repeat(64),
      primaryClaimReview: "c".repeat(64),
      targetSet: "d".repeat(64),
    },
    entries: [{ ...reviseEntry("E0001"), findingCodes: ["support_gap"] }],
  };
  const paths = claimGatePaths(built.caseDir, built.primary);
  await writeJson(paths.secondary, historical);

  const result = await resolveClaimGate(built.caseDir);
  assert.equal(result.resolution.status, "needs_secondary", JSON.stringify(result.resolution.contractErrors));
  assert.deepEqual(result.resolution.targetRefs, ["E0001"]);
  assert.deepEqual(JSON.parse(await fs.readFile(paths.secondary, "utf8")), historical);
});

test("prepare validates a quote-only bridge, passes mechanical-only repair, and emits no secondary", async (t) => {
  const built = await mechanicalFixture(t);
  assert.deepEqual(reconstructPreRepairClaims(built.currentClaims, built.mechanicalFix), built.beforeClaims);

  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "pass", JSON.stringify(prepared.bridgeErrors));
  assert.equal(prepared.packetPath, null);
  assert.deepEqual(prepared.targetRefs, []);
  assert.equal(prepared.resolution.metrics.mechanicalResolvedCount, 1);
  assert.equal(prepared.resolution.inputHashes.mechanicalFix, sha256Value(built.mechanicalFix));
  assert.deepEqual(JSON.parse(await fs.readFile(prepared.resolutionPath, "utf8")), prepared.resolution);
});

test("prepare explicitly requires a mechanical fix when the bridge is absent or invalid", async (t) => {
  const absent = await mechanicalFixture(t, { bridge: false });
  const missing = await prepareClaimGate(absent.caseDir);
  assert.equal(missing.status, "needs_mechanical_fix");
  assert.equal(missing.packetPath, null);

  const invalid = await mechanicalFixture(t, {
    mutateReport(report) {
      report.entries[0].supportSpanIndexes = [9];
    },
  });
  await assert.rejects(
    Promise.resolve().then(() => reconstructPreRepairClaims(invalid.currentClaims, invalid.mechanicalFix)),
    (error) => error instanceof ClaimGateOrchestrationError && error.errors.some((item) => /does not exist|beforeEvidence/u.test(item)),
  );
  const blocked = await prepareClaimGate(invalid.caseDir);
  assert.equal(blocked.status, "needs_mechanical_fix");
  assert.equal(blocked.packetPath, null);
  assert.ok(blocked.bridgeErrors.length > 0);
  assert.equal(JSON.parse(await fs.readFile(blocked.resolutionPath, "utf8")).status, "needs_mechanical_fix");
});

test("a stale bridge from an older round, evidence, and primary does not block fresh semantic-only findings", async (t) => {
  const built = await mechanicalFixture(t);
  const freshClaims = structuredClone(built.currentClaims);
  freshClaims[1].statement = "The fallback remains available after the semantic evidence repair.";
  await writeJsonl(path.join(built.caseDir, "work", "evidence.jsonl"), freshClaims);
  const freshPrimary = {
    ...built.primary,
    reviewerId: "agent-primary-fresh",
    reviewRound: 17,
    inputHashes: { ...built.primary.inputHashes, evidence: sha256Value(freshClaims) },
    entries: [
      { ...reviseEntry("E0001"), findingCodes: ["support_gap"] },
      { ...passEntry("E0002"), findingCodes: [] },
    ],
  };
  await writeJson(path.join(built.caseDir, "work", "claim-review.json"), freshPrimary);

  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "needs_secondary", JSON.stringify(prepared.bridgeErrors));
  assert.deepEqual(prepared.targetRefs, ["E0001"]);
  assert.deepEqual(prepared.bridgeErrors, []);
});

test("prepare resolves the mechanical part before targeting only semantic findings", async (t) => {
  const built = await mechanicalFixture(t, { mixed: true });
  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "needs_secondary", JSON.stringify(prepared.bridgeErrors));
  assert.deepEqual(prepared.targetRefs, ["E0002"]);
  assert.deepEqual(prepared.packet.payload.scope.evidenceRefs, ["E0002"]);
  assert.deepEqual(prepared.packet.payload.claims.map((item) => item.id), ["E0002"]);
  assert.equal(prepared.resolution.metrics.mechanicalResolvedCount, 1);
});

test("theme-map changes create a new immutable packet root and invalidate an old targeted report", async (t) => {
  const built = await fixture(t);
  const original = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  const secondary = targetedReport(original.packet, { ...reviseEntry(), findingCodes: ["support_gap"] });
  const paths = claimGatePaths(built.caseDir, built.primary);
  await writeJson(paths.secondary, secondary);

  const changedThemes = structuredClone(built.themeMap);
  changedThemes.themes[0].summary = "A changed definition must invalidate the earlier packet binding.";
  await writeJson(path.join(built.caseDir, "work", "theme-map.json"), changedThemes);

  const stale = await resolveClaimGate(built.caseDir);
  assert.equal(stale.resolution.status, "invalid");
  assert.match(stale.resolution.contractErrors.join("\n"), /Missing isolated targeted_secondary packet/u);

  const refreshed = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.notEqual(refreshed.packetPath, original.packetPath);
  assert.equal(refreshed.reused, false);
  assert.equal(refreshed.packet.packetContract.inputHashes.themeMap, sha256Value(changedThemes));
  await fs.access(original.packetPath);
  await fs.access(refreshed.packetPath);
});

test("prepare allows complete quote repair entries outside primary findings without consuming semantic targets", async (t) => {
  const built = await mechanicalFixture(t, { mixed: true, extraQuote: true, primaryMechanical: false });
  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "needs_secondary", JSON.stringify(prepared.bridgeErrors));
  assert.deepEqual(prepared.targetRefs, ["E0002"]);
  assert.deepEqual(prepared.packet.payload.scope.evidenceRefs, ["E0002"]);
  assert.equal(prepared.resolution.metrics.mechanicalResolvedCount, 0);
  assert.equal(built.mechanicalFix.entries.length, 2);
});

test("prepare resolves an exact legacy quote-only issue only through its claim/span bridge", async (t) => {
  const built = await mechanicalFixture(t, { legacyQuoteIssue: true });
  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "pass", JSON.stringify(prepared.bridgeErrors));
  assert.deepEqual(prepared.targetRefs, []);
  assert.equal(prepared.packetPath, null);
  assert.equal(prepared.resolution.metrics.mechanicalResolvedCount, 1);
});

test("legacy quote text cannot hide another issue or a failed semantic axis", async (t) => {
  for (const options of [
    { legacyExtraIssue: true },
    { legacySupportFailure: true },
    { legacyIssueText: "supportSpans.quote 缺失，请补齐。" },
  ]) {
    const built = await mechanicalFixture(t, { legacyQuoteIssue: true, ...options });
    const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
    assert.equal(prepared.status, "needs_secondary", JSON.stringify(prepared.bridgeErrors));
    assert.deepEqual(prepared.targetRefs, ["E0001"]);
    assert.equal(prepared.resolution.metrics.mechanicalResolvedCount, 0);
  }
});

test("a legacy quote-only issue cannot pass on claim ref alone when span proof is stale", async (t) => {
  const built = await mechanicalFixture(t, {
    legacyQuoteIssue: true,
    mutateReport(report) {
      report.entries[0].supportSpanIndexes = [9];
    },
  });
  const prepared = await prepareClaimGate(built.caseDir, { reviewerId: "agent-secondary" });
  assert.equal(prepared.status, "needs_mechanical_fix");
  assert.equal(prepared.packetPath, null);
  assert.equal(prepared.resolution.metrics.mechanicalResolvedCount, 0);
  assert.ok(prepared.bridgeErrors.some((error) => /does not exist|beforeEvidence/u.test(error)));
});
