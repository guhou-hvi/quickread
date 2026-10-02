import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, REPO_ROOT, sha256File } from "../scripts/lib.mjs";
import { freshClaimAuditorError, mayStartInitialFormalRound, prepareClaimAuditPacket, prepareReviewRound, rebuildReviewPackets, refreshAlignmentPacket } from "../scripts/review-prepare.mjs";
import { sha256Value } from "../scripts/review-contract.mjs";
import { validateReviewRound } from "../scripts/review-validate.mjs";
import { loadReviewState } from "../scripts/quality-report.mjs";
import { buildRepairPayload, computeReviewConsensus, dynamicPacketResources, stableConsensusGeneratedAt } from "../scripts/review-consensus.mjs";
import { resolveClaimReview } from "../scripts/claim-review-gate.mjs";

async function writeJsonLines(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function passingClaimResolution({ caseId, segments, claims, primary }) {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId,
    role: "claim_gate",
    reviewRound: primary.reviewRound,
    inputHashes: {
      segments: sha256Value(segments),
      evidence: sha256Value(claims),
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
}

async function withClaimFixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-review-"));
  const caseDir = path.join(root, "qr-9999-review-preflight");
  try {
    await fs.mkdir(path.join(caseDir, "input"), { recursive: true });
    await fs.writeFile(path.join(caseDir, "input", "source.srt"), "fixture", "utf8");
    await fs.writeFile(path.join(caseDir, "case.json"), JSON.stringify({
      id: path.basename(caseDir),
      title: "审核夹具",
      source: { path: "input/source.srt" },
      profile: { primary: "knowledge", lenses: [], selection: "seeded", confidence: 1, version: "1.1.0" },
    }), "utf8");
    const source = [{ id: "C000001", text: "嘉宾说模型部署前必须验证边界。" }];
    const segments = [{ id: "S0001", caseId: path.basename(caseDir), sourceIds: ["C000001"], text: source[0].text }];
    const claims = [{
      id: "E0001",
      statement: "嘉宾认为模型部署前必须验证边界。",
      provenance: "speaker_view",
      importance: "high",
      claimRole: "opinion",
      themeId: "T001",
      supportSpans: [{ segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01–00:00:02" }],
    }];
    await writeJsonLines(path.join(caseDir, "work", "source.normalized.jsonl"), source);
    await writeJsonLines(path.join(caseDir, "work", "segments.jsonl"), segments);
    await writeJsonLines(path.join(caseDir, "work", "evidence.jsonl"), claims);
    await fs.writeFile(path.join(caseDir, "work", "research.json"), JSON.stringify({
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      citations: [],
      checks: [],
      background: [],
    }), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "coverage.json"), JSON.stringify({
      schemaVersion: "2.0.0",
      caseId: path.basename(caseDir),
      sourceHash: "a".repeat(64),
      entries: [{ sourceId: "C000001", status: "mapped", segmentId: "S0001", reason: null, exclusionKind: null }],
    }), "utf8");
    await callback({ caseDir, segments, claims });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("claim-audit preflight creates an evidence-only isolated packet and locks a passing result", async () => {
  await withClaimFixture(async ({ caseDir, segments, claims }) => {
    await assert.rejects(prepareClaimAuditPacket(caseDir, { reviewRound: 1 }), /claim_auditor/);
    const first = await prepareClaimAuditPacket(caseDir, { reviewRound: 1, reviewerId: "agent-claim-preflight" });
    const packet = await readJson(first.packetPath);
    assert.equal(packet.role, "claim_auditor");
    assert.equal(packet.assignedReviewerId, "agent-claim-preflight");
    assert.equal(packet.output.path, "work/claim-review.json");
    assert.equal(packet.output.contract.title, "QuickRead atomic claim audit");
    assert.match(packet.reviewInstructions, /Claim Auditor/u);
    assert.doesNotMatch(packet.reviewInstructions, /\uFFFD|\?{2,}/u);
    assert.equal(packet.inputPolicy.isolation, "packet-only");
    assert.match(packet.inputPolicy.instruction, /output\.contract/u);
    assert.match(packet.inputPolicy.forbidden.join(" "), /deep-read/);
    assert.deepEqual(packet.inputHashes, {
      segments: sha256Value(segments),
      evidence: sha256Value(claims),
    });
    assert.equal(packet.payload.claims[0].supportSpans[0].sourceUnits[0].id, "C000001");
    assert.equal(packet.existingOutput, undefined);

    const passing = {
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "claim_auditor",
      reviewerId: "agent-claim-preflight",
      reviewRound: 1,
      inputHashes: packet.inputHashes,
      entries: [{
        evidenceRef: "E0001",
        verdict: "pass",
        atomicity: "pass",
        support: "supported",
        importance: { verdict: "confirmed", proposed: null },
        theme: { verdict: "confirmed", proposedThemeId: null },
        speaker: "unknown_safe",
        issues: [],
        rationale: "命题原子、来源连续且归属保持保守。",
      }],
    };
    await fs.writeFile(path.join(caseDir, "work", "claim-review.json"), JSON.stringify(passing), "utf8");
    const rawOnly = await prepareClaimAuditPacket(caseDir, { reviewRound: 1, reviewerId: "agent-claim-preflight" });
    assert.equal(rawOnly.packet.existingOutput, undefined);
    assert.match(rawOnly.existingOutputErrors.join("\n"), /claim-review-resolution/u);
    const resolution = passingClaimResolution({
      caseId: path.basename(caseDir),
      segments,
      claims,
      primary: passing,
    });
    await fs.writeFile(path.join(caseDir, "work", "claim-review-resolution.json"), JSON.stringify(resolution), "utf8");
    const second = await prepareClaimAuditPacket(caseDir, { reviewRound: 1, reviewerId: "agent-claim-preflight" });
    assert.deepEqual(second.packet.existingOutput, { immutable: true, sha256: sha256Value(passing) });
    assert.deepEqual(await readJson(second.reportSnapshotPath), passing);

    const nextRound = await prepareClaimAuditPacket(caseDir, { reviewRound: 2, reviewerId: "agent-claim-next-round" });
    assert.notEqual(nextRound.packetPath, first.packetPath);
    assert.match(nextRound.packetPath, /preflight[\\/]round-02[\\/]claim-audit-/u);
    assert.equal(nextRound.packet.existingOutput, undefined);

    const invalidCoverage = await readJson(path.join(caseDir, "work", "coverage.json"));
    invalidCoverage.entries[0] = { sourceId: "C000001", status: "excluded", segmentId: null, reason: "包含广告关键词", exclusionKind: "advertisement" };
    await fs.writeFile(path.join(caseDir, "work", "coverage.json"), JSON.stringify(invalidCoverage), "utf8");
    await assert.rejects(
      prepareClaimAuditPacket(caseDir, { reviewRound: 3, reviewerId: "agent-claim-invalid-coverage" }),
      /不得仅因出现“广告”或“赞助”而排除/u,
    );
  });
});

test("consensus timestamps remain stable when an unchanged review round is recomputed", () => {
  const previous = { caseId: "qr-9999-fixture", reviewRound: 1, generatedAt: "2026-08-11T00:00:00.000Z" };
  assert.equal(stableConsensusGeneratedAt(previous, "qr-9999-fixture", 1, "later"), previous.generatedAt);
  assert.equal(stableConsensusGeneratedAt(previous, "qr-9999-fixture", 2, "later"), "later");
  assert.equal(stableConsensusGeneratedAt(previous, "qr-other", 1, "later"), "later");
});

test("dynamic adjudication and repair packets have self-contained contracts", () => {
  const adjudicator = dynamicPacketResources("adjudicator");
  assert.equal(adjudicator.outputContract.properties.role.const, "adjudicator");
  assert.match(adjudicator.reviewInstructions, /adjudicator/u);
  const repair = dynamicPacketResources("repair_editor");
  assert.equal(repair.outputContract.properties.role.const, "repair_editor");
  assert.match(repair.reviewInstructions, /repair_editor/u);
  assert.throws(() => dynamicPacketResources("coverage_a"), /不支持动态审核角色/u);
});

test("repair packets bind evidence migration when the reviewed case has one", () => {
  const evidenceMigration = { schemaVersion: "1.0.0", entries: [] };
  const claimBundles = { schemaVersion: "1.0.0", bundles: [] };
  const themeMap = { schemaVersion: "1.0.0", themes: [] };
  const payload = buildRepairPayload({
    manifest: {
      inputHashes: {
        evidence: "1".repeat(64),
        evidenceMigration: "2".repeat(64),
        claimBundles: "6".repeat(64),
        themeMap: "7".repeat(64),
        deepRead: "3".repeat(64),
        readerMap: "4".repeat(64),
        research: "5".repeat(64),
      },
      artifacts: { repairLog: "work/reviews/2.2.0/round-01/repair-log.json" },
    },
    artifacts: { evidenceMigration, claimBundles, themeMap },
    source: {
      claims: [],
      normalized: [],
      readerMap: { entries: [] },
      deepRead: { sections: [] },
      research: { checks: [], citations: [] },
    },
    packets: new Map(),
  }, {
    reviewRound: 1,
    maximumRepairRounds: 2,
    failures: [],
    agreedNotCovered: [],
    adjudicationReport: null,
    verified: [],
  });
  assert(payload.allowedOutputPaths.includes("work/evidence-migration.json"));
  assert(payload.allowedOutputPaths.includes("work/claim-bundles.json"));
  assert(payload.allowedOutputPaths.includes("work/theme-map.json"));
  assert.deepEqual(payload.editableSnapshots.evidenceMigration, {
    path: "work/evidence-migration.json",
    sha256: "2".repeat(64),
    format: "json",
    value: evidenceMigration,
  });
  assert.deepEqual(payload.editableSnapshots.claimBundles, {
    path: "work/claim-bundles.json",
    sha256: "6".repeat(64),
    format: "json",
    value: claimBundles,
  });
  assert.deepEqual(payload.editableSnapshots.themeMap, {
    path: "work/theme-map.json",
    sha256: "7".repeat(64),
    format: "json",
    value: themeMap,
  });
});

test("every repaired review round requires a fresh Claim Auditor identity", () => {
  const previous = { assignments: [{ role: "claim_auditor", reviewerId: "agent-claim-round-1" }] };
  assert.match(freshClaimAuditorError(previous, "agent-claim-round-1"), /必须更换独立 Claim Auditor/u);
  assert.equal(freshClaimAuditorError(previous, "agent-claim-round-2"), null);
});

test("an active review version may start at only its fresh passing claim-gate round", () => {
  const base = {
    resolutionReviewRound: 16,
    resolutionStatus: "pass",
    resolutionValid: true,
    hasFormalManifest: false,
  };
  assert.equal(mayStartInitialFormalRound({ ...base, reviewRound: 16 }), true);
  assert.equal(mayStartInitialFormalRound({ ...base, reviewRound: 15 }), false);
  assert.equal(mayStartInitialFormalRound({ ...base, reviewRound: 17 }), false);
  assert.equal(mayStartInitialFormalRound({ ...base, reviewRound: 16, resolutionValid: false }), false);
  assert.equal(mayStartInitialFormalRound({ ...base, reviewRound: 16, hasFormalManifest: true }), false);
  assert.equal(mayStartInitialFormalRound({ ...base, reviewRound: 18, resolutionReviewRound: 18, hasFormalManifest: true }), false);
});

test("full review preparation accepts a nonpass primary only through a fresh pass resolution", async () => {
  await withClaimFixture(async ({ caseDir, segments, claims }) => {
    const caseId = path.basename(caseDir);
    const claimReview = {
      schemaVersion: "1.0.0",
      caseId,
      role: "claim_auditor",
      reviewerId: "agent-claim-round",
      reviewRound: 1,
      inputHashes: { segments: sha256Value(segments), evidence: sha256Value(claims) },
      entries: [{
        evidenceRef: "E0001",
        verdict: "revise",
        atomicity: "pass",
        support: "partial",
        importance: { verdict: "confirmed", proposed: null },
        theme: { verdict: "confirmed", proposedThemeId: null },
        speaker: "unknown_safe",
        issues: ["表述强度需要独立复核。"],
        rationale: "需要定向第二审核。",
      }],
    };
    const deepRead = {
      workflowVersion: "2.2.0",
      caseId,
      sections: [
        { id: "overview", modules: [{ id: "overview-main", blocks: [{ id: "overview-prose", type: "prose_group", provenance: "speaker_view", paragraphs: [{ id: "overview-p1", text: "嘉宾认为模型部署前必须验证边界。", evidenceRefs: ["E0001"] }] }] }] },
        { id: "themes", modules: [] },
        { id: "navigation", modules: [] },
        { id: "verification", modules: [] },
      ],
    };
    const readerMap = {
      schemaVersion: "2.0.0",
      caseId,
      entries: [{ evidenceRef: "E0001", importance: "high", presentation: "explicit", coverageSpans: [{ readerBlockRef: "overview-p1", readerTextQuote: "部署前必须验证边界" }] }],
    };
    const bundles = {
      schemaVersion: "1.0.0",
      caseId,
      inputHashes: { evidence: sha256Value(claims), claimReview: sha256Value(claimReview) },
      bundles: [{ id: "CB001", themeId: "T001", order: 1, title: "验证边界", narrativePurpose: "解释部署成立条件。", readerBlockRef: "overview-p1", requiredReaderRefs: ["E0001"], optionalReaderRefs: [], evidenceOnlyRefs: [] }],
    };
    await fs.mkdir(path.join(caseDir, "output"), { recursive: true });
    await fs.writeFile(path.join(caseDir, "work", "claim-review.json"), JSON.stringify(claimReview), "utf8");
    const targetRefs = ["E0001"];
    const targetSet = sha256Value(targetRefs);
    const secondaryClaimReview = {
      schemaVersion: "1.1.0",
      caseId,
      role: "claim_auditor",
      reviewerId: "agent-claim-secondary",
      reviewRound: 1,
      auditMode: "targeted",
      scope: { evidenceRefs: targetRefs },
      inputHashes: {
        segments: sha256Value(segments),
        evidence: sha256Value(claims),
        primaryClaimReview: sha256Value(claimReview),
        targetSet,
      },
      entries: [{
        evidenceRef: "E0001",
        verdict: "pass",
        atomicity: "pass",
        support: "supported",
        importance: { verdict: "confirmed", proposed: null },
        theme: { verdict: "confirmed", proposedThemeId: null },
        speaker: "unknown_safe",
        findingCodes: [],
        issues: [],
        rationale: "定向复核确认原表述受支持。",
      }],
    };
    const gateContext = {
      caseId,
      claims,
      segmentsHash: sha256Value(segments),
      evidenceHash: sha256Value(claims),
      reviewRound: 1,
    };
    const preliminary = resolveClaimReview({ primary: claimReview, secondary: secondaryClaimReview, context: gateContext });
    assert.equal(preliminary.status, "needs_adjudication");
    const claimAdjudication = {
      schemaVersion: "1.0.0",
      workflowVersion: "2.2.1",
      caseId,
      role: "claim_adjudicator",
      reviewerId: "agent-claim-adjudicator",
      reviewRound: 1,
      inputHashes: {
        segments: sha256Value(segments),
        evidence: sha256Value(claims),
        primaryClaimReview: sha256Value(claimReview),
        secondaryClaimReview: sha256Value(secondaryClaimReview),
        targetSet,
      },
      entries: [{
        evidenceRef: "E0001",
        triggers: preliminary.conflicts[0].triggers,
        selection: "secondary",
        confidence: 0.95,
        rationale: "第二审核的支持判断更符合证据。",
      }],
    };
    const claimReviewResolution = resolveClaimReview({
      primary: claimReview,
      secondary: secondaryClaimReview,
      adjudication: claimAdjudication,
      context: gateContext,
    });
    assert.equal(claimReviewResolution.status, "pass");
    await fs.writeFile(path.join(caseDir, "work", "claim-review-secondary.json"), JSON.stringify(secondaryClaimReview), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "claim-adjudication.json"), JSON.stringify(claimAdjudication), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "claim-review-resolution.json"), JSON.stringify(claimReviewResolution), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "claim-bundles.json"), JSON.stringify(bundles), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "theme-map.json"), JSON.stringify({ schemaVersion: "1.0.0", caseId, profile: "knowledge", themes: [], unassignedClaimRefs: [] }), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "reader-map.json"), JSON.stringify(readerMap), "utf8");
    await fs.writeFile(path.join(caseDir, "output", "deep-read.json"), JSON.stringify(deepRead), "utf8");
    await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), "# 审核夹具\n\n嘉宾认为模型部署前必须验证边界。\n", "utf8");
    const assignments = Object.fromEntries([
      ["claim_auditor", "agent-claim-round"],
      ["blind_recall", "agent-blind-round"],
      ["alignment", "agent-align-round"],
      ["coverage_a", "agent-coverage-a-round"],
      ["coverage_b", "agent-coverage-b-round"],
      ["fidelity", "agent-fidelity-round"],
      ["reader_advocate", "agent-reader-round"],
      ["adjudicator", "agent-adjudicator-round"],
      ["repair_editor", "agent-repair-round"],
    ]);
    const result = await prepareReviewRound(caseDir, { reviewRound: 1, assignments });
    const researchPath = path.join(caseDir, "work", "research.json");
    const research = await readJson(researchPath);
    assert.equal(result.manifest.inputHashes.claimReview, sha256Value(claimReview));
    assert.equal(result.manifest.inputHashes.claimReviewResolution, sha256Value(claimReviewResolution));
    assert.equal(result.manifest.inputHashes.claimBundles, sha256Value(bundles));
    assert.match(result.manifest.inputHashes.themeMap, /^[a-f0-9]{64}$/u);
    assert.equal(result.manifest.artifacts.themeMap, "work/theme-map.json");
    assert.equal(result.manifest.inputHashes.research, sha256Value(research));
    assert.equal(
      result.manifest.artifacts.claimReview,
      `work/reviews/${result.manifest.workflowVersion}/round-01/claim-review.json`,
    );
    const snapshot = await readJson(path.join(result.reviewRoot, "claim-review.json"));
    assert.deepEqual(snapshot, claimReview);
    assert.deepEqual(await readJson(path.join(result.reviewRoot, "claim-review-resolution.json")), claimReviewResolution);
    const claimPacket = await readJson(path.join(result.reviewRoot, "packets", "claim_auditor.json"));
    assert.deepEqual(claimPacket.existingOutput, { immutable: true, sha256: sha256Value(claimReview) });
    assert.equal(claimPacket.output.contract.properties.role.const, "claim_auditor");
    const coveragePacketBeforeRebuild = await readJson(path.join(result.reviewRoot, "packets", "coverage_a.json"));
    assert.ok(coveragePacketBeforeRebuild.output.contract.properties.role.enum.includes("coverage_a"));
    assert.match(coveragePacketBeforeRebuild.reviewInstructions, /Coverage A/u);
    assert.match(coveragePacketBeforeRebuild.reviewInstructions, /readerLeaves\[\]\.id/u);
    assert.doesNotMatch(coveragePacketBeforeRebuild.reviewInstructions, /\uFFFD|\?{2,}/u);
    assert.ok(coveragePacketBeforeRebuild.payload.readerLeaves.every((leaf) => leaf.id && !("blockId" in leaf)));
    const fidelityPacketBeforeRebuild = await readJson(path.join(result.reviewRoot, "packets", "fidelity.json"));
    assert.ok(fidelityPacketBeforeRebuild.payload.readerLeaves.every((leaf) => leaf.id && !("blockId" in leaf)));
    const readerPacketBeforeRebuild = await readJson(path.join(result.reviewRoot, "packets", "reader_advocate.json"));
    assert.ok(readerPacketBeforeRebuild.payload.readerLeaves.every((leaf) => leaf.id && !("blockId" in leaf)));
    const blindPacket = await readJson(path.join(result.reviewRoot, "packets", "blind_recall.json"));
    assert.equal(blindPacket.output.dependencies["evidence.schema.json"].title, "QuickRead atomic source claim");

    await fs.rm(path.join(result.reviewRoot, "packets"), { recursive: true, force: true });
    await fs.rm(path.join(result.reviewRoot, "packet-index.json"), { force: true });
    const rebuilt = await rebuildReviewPackets(caseDir, 1);
    assert.equal(rebuilt.packetIndex.alignmentReady, false);
    const rebuiltClaimPacket = await readJson(path.join(result.reviewRoot, "packets", "claim_auditor.json"));
    assert.deepEqual(rebuiltClaimPacket, claimPacket);
    assert.deepEqual(await readJson(path.join(result.reviewRoot, "claim-review.json")), claimReview);
    const rebuiltValidation = await validateReviewRound(caseDir, 1, { requireReports: false });
    assert.doesNotMatch(rebuiltValidation.errors.join("\n"), /改写.*reader leaves|改写或遗漏了可审计 reader leaves/u);

    const changedResearch = { ...research, checks: [{ citationRefs: [], result: "updated", explanation: "研究记录发生变化。" }] };
    await fs.writeFile(researchPath, JSON.stringify(changedResearch), "utf8");
    await assert.rejects(rebuildReviewPackets(caseDir, 1), /过期审核轮次/u);
    await fs.writeFile(researchPath, JSON.stringify(research), "utf8");

    const coveragePacketPath = path.join(result.reviewRoot, "packets", "coverage_a.json");
    const coveragePacket = await readJson(coveragePacketPath);
    coveragePacket.payload.claims.push({
      id: "E9999",
      statement: "This claim is outside the frozen review packet.",
      provenance: "source_fact",
      importance: "high",
      claimRole: "fact",
      themeId: "T999",
    });
    await fs.writeFile(coveragePacketPath, JSON.stringify(coveragePacket), "utf8");
    const packetIndexPath = path.join(result.reviewRoot, "packet-index.json");
    const packetIndex = await readJson(packetIndexPath);
    packetIndex.packets.coverage_a.sha256 = await sha256File(coveragePacketPath);
    await fs.writeFile(packetIndexPath, JSON.stringify(packetIndex), "utf8");

    const validation = await validateReviewRound(caseDir, 1, { requireReports: false });
    assert.match(validation.errors.join("\n"), /coverage_a packet .*E9999|coverage_a packet .*claim/u);
  });
});

async function withConsensusFixture(callback, options = {}) {
  await withClaimFixture(async ({ caseDir, segments, claims }) => {
    const caseId = path.basename(caseDir);
    const claimReview = {
      schemaVersion: "1.0.0",
      caseId,
      role: "claim_auditor",
      reviewerId: "agent-claim-round",
      reviewRound: 1,
      inputHashes: { segments: sha256Value(segments), evidence: sha256Value(claims) },
      entries: [{
        evidenceRef: "E0001",
        verdict: "pass",
        atomicity: "pass",
        support: "supported",
        importance: { verdict: "confirmed", proposed: null },
        theme: { verdict: "confirmed", proposedThemeId: null },
        speaker: "unknown_safe",
        issues: [],
        rationale: "通过。",
      }],
    };
    const deepRead = {
      workflowVersion: "2.2.0",
      caseId,
      sections: [
        { id: "overview", modules: [{ id: "overview-main", blocks: [{ id: "overview-prose", type: "prose_group", provenance: "speaker_view", paragraphs: [{ id: "overview-p1", text: "嘉宾认为模型部署前必须验证边界。", evidenceRefs: ["E0001"] }] }] }] },
        { id: "themes", modules: [] },
        { id: "navigation", modules: [] },
        { id: "verification", modules: [] },
      ],
    };
    const readerMap = {
      schemaVersion: "2.0.0",
      caseId,
      entries: [{ evidenceRef: "E0001", importance: "high", presentation: "explicit", coverageSpans: [{ readerBlockRef: "overview-p1", readerTextQuote: "部署前必须验证边界" }] }],
    };
    const bundles = {
      schemaVersion: "1.0.0",
      caseId,
      inputHashes: { evidence: sha256Value(claims), claimReview: sha256Value(claimReview) },
      bundles: [{ id: "CB001", themeId: "T001", order: 1, title: "验证边界", narrativePurpose: "解释部署成立条件。", readerBlockRef: "overview-p1", requiredReaderRefs: ["E0001"], optionalReaderRefs: [], evidenceOnlyRefs: [] }],
    };
    await fs.mkdir(path.join(caseDir, "output"), { recursive: true });
    await fs.writeFile(path.join(caseDir, "work", "claim-review.json"), JSON.stringify(claimReview), "utf8");
    const claimReviewResolution = passingClaimResolution({ caseId, segments, claims, primary: claimReview });
    await fs.writeFile(path.join(caseDir, "work", "claim-review-resolution.json"), JSON.stringify(claimReviewResolution), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "claim-bundles.json"), JSON.stringify(bundles), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "theme-map.json"), JSON.stringify({ schemaVersion: "1.0.0", caseId, profile: "knowledge", themes: [], unassignedClaimRefs: [] }), "utf8");
    await fs.writeFile(path.join(caseDir, "work", "reader-map.json"), JSON.stringify(readerMap), "utf8");
    await fs.writeFile(path.join(caseDir, "output", "deep-read.json"), JSON.stringify(deepRead), "utf8");
    const readerMarkdown = options.withReaderReference
      ? "# 审核夹具\n\nThe guest says deployment needs boundary validation. 〔[E0001](evidence-book.md#e0001)〕\n"
      : "# 审核夹具\n\nThe guest says deployment needs boundary validation.\n";
    await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), readerMarkdown, "utf8");
    const assignments = Object.fromEntries([
      ["claim_auditor", "agent-claim-round"],
      ["blind_recall", "agent-blind-round"],
      ["alignment", "agent-align-round"],
      ["coverage_a", "agent-coverage-a-round"],
      ["coverage_b", "agent-coverage-b-round"],
      ["fidelity", "agent-fidelity-round"],
      ["reader_advocate", "agent-reader-round"],
      ["adjudicator", "agent-adjudicator-round"],
      ["repair_editor", "agent-repair-round"],
    ]);
    const prepared = await prepareReviewRound(caseDir, { reviewRound: 1, assignments });
    const writeArtifact = async (key, value) => fs.writeFile(path.join(caseDir, ...prepared.manifest.artifacts[key].split("/")), JSON.stringify(value), "utf8");
    const packet = async (role) => readJson(path.join(prepared.reviewRoot, "packets", `${role}.json`));
    const blindPacket = await packet("blind_recall");
    const blindCandidates = {
      schemaVersion: "1.0.0",
      caseId,
      role: "blind_recall",
      reviewerId: assignments.blind_recall,
      reviewRound: 1,
      inputHashes: blindPacket.inputHashes,
      blindToEvidence: true,
      entries: [{ id: "BC0001", statement: "部署前必须验证边界。", importance: "high", claimRole: "opinion", supportSpans: [{ segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01–00:00:02" }] }],
    };
    await writeArtifact("blindCandidates", blindCandidates);
    await refreshAlignmentPacket(caseDir, 1);
    const alignmentPacket = await packet("alignment");
    await writeArtifact("blindAlignment", {
      schemaVersion: "1.0.0",
      caseId,
      role: "alignment",
      reviewerId: assignments.alignment,
      reviewRound: 1,
      inputHashes: alignmentPacket.inputHashes,
      entries: [{ candidateRef: "BC0001", relation: "partial", matchedEvidenceRefs: ["E0001"], missingFacets: ["强制程度"], rationale: "核心语义存在，但限定不足。" }],
    });
    const coverageEntry = {
      evidenceRef: "E0001",
      confidence: 0.95,
      issueType: "none",
      materialFacets: ["部署前验证边界"],
      missingFacets: [],
      readerBlockRefs: ["overview-p1"],
      verifiedQuotes: [{ readerBlockRef: "overview-p1", readerTextQuote: "部署前必须验证边界" }],
      rationale: "正文完整承接。",
    };
    const coverageAPacket = await packet("coverage_a");
    const coverageBPacket = await packet("coverage_b");
    const coverageA = { schemaVersion: "1.0.0", caseId, role: "coverage_a", reviewerId: assignments.coverage_a, reviewRound: 1, inputHashes: coverageAPacket.inputHashes, blindToReaderMap: true, blindToPeerReview: true, entries: [{ ...coverageEntry, verdict: "covered" }] };
    const coverageB = { schemaVersion: "1.0.0", caseId, role: "coverage_b", reviewerId: assignments.coverage_b, reviewRound: 1, inputHashes: coverageBPacket.inputHashes, blindToReaderMap: true, blindToPeerReview: true, entries: [{ ...coverageEntry, verdict: "partial", materialFacets: [], missingFacets: ["强制程度"], readerBlockRefs: [], verifiedQuotes: [], rationale: "缺少强制程度。" }] };
    await writeArtifact("coverageA", coverageA);
    await writeArtifact("coverageB", coverageB);
    const fidelityPacket = await packet("fidelity");
    await writeArtifact("fidelityReview", {
      schemaVersion: "1.0.0",
      caseId,
      role: "fidelity",
      reviewerId: assignments.fidelity,
      reviewRound: 1,
      inputHashes: fidelityPacket.inputHashes,
      entries: [{ readerBlockRef: "overview-p1", verdict: "partial", provenance: "speaker_view", evidenceRefs: ["E0001"], citationRefs: [], unsupportedText: ["必须"], provenanceVerdict: "correct", rationale: "强制程度超出来源。" }],
    });
    const readerPacket = await packet("reader_advocate");
    await writeArtifact("readerReview", {
      schemaVersion: "1.0.0",
      caseId,
      role: "reader_advocate",
      reviewerId: assignments.reader_advocate,
      reviewRound: 1,
      inputHashes: readerPacket.inputHashes,
      evidenceBlind: true,
      scores: { coherence: 5, terminology: 5, repetition: 5, hierarchy: 3, profileFit: 5, informationLoad: 4 },
      verdict: "revise",
      issues: [{ severity: "error", readerBlockRefs: ["overview-p1"], description: "结论层级过强。", suggestion: "降低断言强度并补过渡。" }],
      summary: "需调整层级和强度。",
    });
    await callback({ caseDir, prepared, assignments, segments, claims, deepRead, readerMap, coverageA, coverageB, readerMarkdown });
  });
}


test("quality review state reuses 2.3 formal consensus and reference-free Reader hash", async () => {
  await withConsensusFixture(async ({ caseDir, prepared, assignments, segments, claims, deepRead, readerMap, readerMarkdown }) => {
    const fidelityPacket = await readJson(path.join(prepared.reviewRoot, "packets", "fidelity.json"));
    await fs.writeFile(path.join(caseDir, ...prepared.manifest.artifacts.fidelityReview.split("/")), JSON.stringify({
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "fidelity",
      reviewerId: assignments.fidelity,
      reviewRound: 1,
      inputHashes: fidelityPacket.inputHashes,
      entries: [{
        readerBlockRef: "overview-p1",
        verdict: "supported",
        provenance: "speaker_view",
        evidenceRefs: ["E0001"],
        citationRefs: [],
        unsupportedText: [],
        provenanceVerdict: "correct",
        rationale: "The source supports the retained statement.",
      }],
    }), "utf8");
    const readerPacket = await readJson(path.join(prepared.reviewRoot, "packets", "reader_advocate.json"));
    await fs.writeFile(path.join(caseDir, ...prepared.manifest.artifacts.readerReview.split("/")), JSON.stringify({
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "reader_advocate",
      reviewerId: assignments.reader_advocate,
      reviewRound: 1,
      inputHashes: readerPacket.inputHashes,
      evidenceBlind: true,
      scores: { coherence: 5, terminology: 5, repetition: 5, hierarchy: 5, profileFit: 5, informationLoad: 5 },
      verdict: "pass",
      issues: [],
      summary: "The reader edition is clear and coherent.",
    }), "utf8");

    const consensus = await computeReviewConsensus(caseDir, 1);
    assert.equal(consensus.status, "pass");
    assert.equal(consensus.gates.coverage.adjudicationStatus, "pending");

    const state = await loadReviewState(caseDir, {
      manifest: await readJson(path.join(caseDir, "case.json")),
      segments,
      claims,
      deepRead,
      readerMap,
      readerMarkdown,
      config: await readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    });
    assert.equal(state.status, "pass", JSON.stringify(state.hardErrors));
    assert.equal(state.declaredConsensus.status, "pass");
    assert.doesNotMatch(state.hardErrors.join("\n"), /readerMarkdown|adjudicat/u);
  }, { withReaderReference: true });
});

test("2.3 keeps recall and reader metrics diagnostic while Fidelity remains hard", async () => {
  await withConsensusFixture(async ({ caseDir, prepared }) => {
    const validation = await validateReviewRound(caseDir, 1);
    assert.deepEqual(validation.errors, []);
    assert.deepEqual(validation.reportFailures.map((failure) => failure.gate), ["fidelity"]);
    assert.deepEqual(validation.diagnostics.map((entry) => entry.gate).sort(), ["blind_recall", "reader_advocate"]);
    const consensus = await computeReviewConsensus(caseDir, 1);
    assert.equal(consensus.status, "repair_required");
    const packetIndex = await readJson(path.join(prepared.reviewRoot, "packet-index.json"));
    assert.equal(packetIndex.packets.adjudicator, undefined);
    assert.equal(packetIndex.packets.repair_editor.ready, true);
  });
});

test("2.3 emits a repair packet for concrete Fidelity errors only", async () => {
  await withConsensusFixture(async ({ caseDir, prepared, assignments }) => {
    const pending = await computeReviewConsensus(caseDir, 1);
    assert.equal(pending.status, "repair_required");
    if (false) {
    const adjudicatorPacket = await readJson(path.join(prepared.reviewRoot, "packets", "adjudicator.json"));
    await fs.writeFile(path.join(caseDir, ...prepared.manifest.artifacts.adjudication.split("/")), JSON.stringify({
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "adjudicator",
      reviewerId: assignments.adjudicator,
      reviewRound: 1,
      inputHashes: adjudicatorPacket.inputHashes,
      entries: [{ evidenceRef: "E0001", triggers: ["verdict_conflict"], verdict: "partial", confidence: 0.9, issueType: "none", readerBlockRefs: [], verifiedQuotes: [], rationale: "正文没有保留强制程度。" }],
    }), "utf8");
    }
    const consensus = await computeReviewConsensus(caseDir, 1);
    assert.equal(consensus.status, "repair_required", JSON.stringify(consensus));
    assert.deepEqual(consensus.failures.map((failure) => failure.gate), ["fidelity"]);
    const repairPacket = await readJson(path.join(prepared.reviewRoot, "packets", "repair_editor.json"));
    assert.equal(repairPacket.inputPolicy.isolation, "packet-only");
    assert.deepEqual(repairPacket.payload.failedClaims.map((claim) => claim.id), ["E0001"]);
    assert.equal(repairPacket.payload.failedClaims[0].supportSpans[0].sourceUnits[0].id, "C000001");
    assert.equal(repairPacket.payload.readerLeaves[0].id, "overview-p1");
    assert.ok(repairPacket.payload.reviews.coverageA);
    assert.ok(repairPacket.payload.reviews.coverageB);
    assert.equal(repairPacket.payload.reviews.adjudication, null);
    assert.ok(repairPacket.payload.reviews.fidelity);
    assert.equal(repairPacket.payload.reviews.blindIssues.length, 0);
    assert.equal(repairPacket.payload.reviews.readerIssues.length, 0);
    assert.match(repairPacket.payload.referenceFreeReaderEdition, /审核夹具/u);
    assert.deepEqual(repairPacket.payload.allowedOutputPaths, [
      "work/evidence.jsonl",
      "work/claim-bundles.json",
      "work/theme-map.json",
      "output/deep-read.json",
      "work/reader-map.json",
      "work/research.json",
      prepared.manifest.artifacts.repairLog,
    ]);
    for (const [name, snapshot] of Object.entries(repairPacket.payload.editableSnapshots)) {
      assert.equal(snapshot.sha256, repairPacket.inputHashes[name]);
      assert.ok(snapshot.value);
    }
    assert.match(`${repairPacket.inputPolicy.instruction} ${(repairPacket.inputPolicy.forbidden ?? []).join(" ")}`, /旧稿|brief|quality|其他 packet/u);
    const postValidation = await validateReviewRound(caseDir, 1);
    assert.deepEqual(postValidation.errors, []);
  });
});

test("an incomplete legacy repair packet reports validation errors instead of crashing", async () => {
  await withConsensusFixture(async ({ caseDir, prepared, assignments }) => {
    await computeReviewConsensus(caseDir, 1);
    if (false) {
    const adjudicatorPacket = await readJson(path.join(prepared.reviewRoot, "packets", "adjudicator.json"));
    await fs.writeFile(path.join(caseDir, ...prepared.manifest.artifacts.adjudication.split("/")), JSON.stringify({
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "adjudicator",
      reviewerId: assignments.adjudicator,
      reviewRound: 1,
      inputHashes: adjudicatorPacket.inputHashes,
      entries: [{ evidenceRef: "E0001", triggers: ["verdict_conflict"], verdict: "partial", confidence: 0.9, issueType: "none", readerBlockRefs: [], verifiedQuotes: [], rationale: "The reader text omits the required strength." }],
    }), "utf8");
    }
    await computeReviewConsensus(caseDir, 1);

    const repairPacketPath = path.join(prepared.reviewRoot, "packets", "repair_editor.json");
    const repairPacket = await readJson(repairPacketPath);
    delete repairPacket.payload.editableSnapshots;
    delete repairPacket.payload.reviews;
    await fs.writeFile(repairPacketPath, JSON.stringify(repairPacket), "utf8");

    const validation = await validateReviewRound(caseDir, 1);
    assert.match(validation.errors.join("\n"), /editableSnapshots|snapshot/u);
  });
});

+test("repair-log validation binds the repaired claim-bundles hash end to end", async () => {
  await withConsensusFixture(async ({ caseDir, prepared, assignments }) => {
    await computeReviewConsensus(caseDir, 1);
    if (false) {
    const adjudicatorPacket = await readJson(path.join(prepared.reviewRoot, "packets", "adjudicator.json"));
    await fs.writeFile(path.join(caseDir, ...prepared.manifest.artifacts.adjudication.split("/")), JSON.stringify({
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "adjudicator",
      reviewerId: assignments.adjudicator,
      reviewRound: 1,
      inputHashes: adjudicatorPacket.inputHashes,
      entries: [{ evidenceRef: "E0001", triggers: ["verdict_conflict"], verdict: "partial", confidence: 0.9, issueType: "none", readerBlockRefs: [], verifiedQuotes: [], rationale: "The reader text omits the required strength." }],
    }), "utf8");
    }
    const consensus = await computeReviewConsensus(caseDir, 1);
    const repairPacket = await readJson(path.join(prepared.reviewRoot, "packets", "repair_editor.json"));
    const outputHashes = {
      evidence: prepared.manifest.inputHashes.evidence,
      claimBundles: prepared.manifest.inputHashes.claimBundles,
      themeMap: prepared.manifest.inputHashes.themeMap,
      deepRead: prepared.manifest.inputHashes.deepRead,
      readerMap: prepared.manifest.inputHashes.readerMap,
      research: prepared.manifest.inputHashes.research,
    };
    const repairLogPath = path.join(caseDir, ...prepared.manifest.artifacts.repairLog.split("/"));
    const repairLog = {
      schemaVersion: "1.0.0",
      caseId: path.basename(caseDir),
      role: "repair_editor",
      reviewerId: assignments.repair_editor,
      reviewRound: 1,
      repairRound: 1,
      generatedAt: "2026-08-25T00:00:00.000Z",
      inputHashes: repairPacket.inputHashes,
      outputHashes,
      changes: [],
      unresolvedIssueRefs: [],
      briefInvalidated: true,
    };
    await fs.writeFile(repairLogPath, JSON.stringify(repairLog), "utf8");
    const valid = await validateReviewRound(caseDir, 1);
    assert.deepEqual(valid.errors, [], JSON.stringify(valid.errors));

    repairLog.outputHashes.claimBundles = "0".repeat(64);
    await fs.writeFile(repairLogPath, JSON.stringify(repairLog), "utf8");
    const stale = await validateReviewRound(caseDir, 1);
    assert.match(stale.errors.join("\n"), /claimBundles/u);
    repairLog.outputHashes.claimBundles = prepared.manifest.inputHashes.claimBundles;
    repairLog.outputHashes.themeMap = "0".repeat(64);
    await fs.writeFile(repairLogPath, JSON.stringify(repairLog), "utf8");
    const staleThemeMap = await validateReviewRound(caseDir, 1);
    assert.match(staleThemeMap.errors.join("\n"), /themeMap/u);
    assert.equal(sha256Value(consensus), repairPacket.inputHashes.consensus);
  });
});


test("a structurally invalid coverage report is invalid and never enters voting", async () => {
  await withConsensusFixture(async ({ caseDir, prepared }) => {
    const coveragePath = path.join(caseDir, ...prepared.manifest.artifacts.coverageA.split("/"));
    const coverage = await readJson(coveragePath);
    delete coverage.entries[0].confidence;
    await fs.writeFile(coveragePath, JSON.stringify(coverage), "utf8");
    const consensus = await computeReviewConsensus(caseDir, 1);
    assert.equal(consensus.status, "invalid");
    assert.match(consensus.errors.join("\n"), /confidence/u);
    const packetIndex = await readJson(path.join(prepared.reviewRoot, "packet-index.json"));
    assert.equal(packetIndex.packets.adjudicator, undefined);
    assert.equal(packetIndex.packets.repair_editor, undefined);
  });
});






