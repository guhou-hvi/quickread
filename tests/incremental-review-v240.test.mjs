import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildEvidenceChangeSet,
  createEvidenceBaseline,
  evidenceChangeSetContractErrors,
  findInitialAuditClaims,
  findRepairLogs,
  initialAuditRepairLineageErrors,
  loadEvidenceSnapshot,
  repairLineageEntries,
} from "../scripts/evidence-diff.mjs";
import {
  advisoryDeltaEntries,
  applyClaimPolicyDisposition,
  blockingDeltaEntries,
  claimPolicyDispositionContractErrors,
  claimsDeltaReviewContractErrors,
} from "../scripts/claims-delta.mjs";
import { sha256Value } from "../scripts/review-contract.mjs";
import {
  participantGuideContractErrors,
  renderParticipantGuideMarkdown,
} from "../scripts/participant-guide.mjs";
import { renderParticipantGuide } from "../scripts/render.mjs";
import {
  participantGuideReviewDraftErrors,
  participantGuideReviewInputHashes,
  participantGuideReviewRecordErrors,
  participantGuideReviewRoleInputHashes,
  participantGuideReviewerReportErrors,
  prepareParticipantGuideReview,
} from "../scripts/participant-guide-review.mjs";
import { renderReviewDraftErrors } from "../scripts/render-review-v24.mjs";

const manifest = {
  id: "qr-9999-test",
  source: { sha256: "a".repeat(64) },
  participants: ["Guest", "Host"],
};
const normalized = [{ id: "C0001", text: "source" }];
const segments = [{ id: "S0001", sourceIds: ["C0001"] }];
const claim = {
  id: "E0001",
  statement: "A supported statement",
  provenance: "speaker_view",
  importance: "high",
  claimRole: "position",
  speaker: "Guest",
  speakerConfidence: 1,
  themeId: "T01",
  uncertainty: null,
  supportSpans: [{ segmentId: "S0001", sourceIds: ["C0001"], quote: "source" }],
};
const deepRead = {
  sections: [{ id: "themes", modules: [{ id: "m", blocks: [{
    id: "b",
    type: "prose_group",
    provenance: "speaker_view",
    paragraphs: [{ id: "p", text: "A supported statement", evidenceRefs: ["E0001"] }],
  }] }] }],
};

function snapshot(claims = [claim], deep = deepRead) {
  return createEvidenceBaseline({ manifest, normalized, segments, claims, deepRead: deep });
}

test("2.4 evidence snapshot can be created before reader synthesis", async () => {
  const caseDir = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-evidence-before-reader-"));
  try {
    const source = "1\n00:00:00,000 --> 00:00:01,000\nsource\n";
    const caseId = path.basename(caseDir);
    await fs.mkdir(path.join(caseDir, "input"), { recursive: true });
    await fs.mkdir(path.join(caseDir, "work"), { recursive: true });
    await fs.writeFile(path.join(caseDir, "input", "source.srt"), source, "utf8");
    await fs.writeFile(path.join(caseDir, "case.json"), `${JSON.stringify({
      id: caseId,
      source: {
        path: "input/source.srt",
        sha256: crypto.createHash("sha256").update(source).digest("hex"),
      },
    })}\n`, "utf8");
    await fs.writeFile(path.join(caseDir, "work", "source.normalized.jsonl"), `${JSON.stringify(normalized[0])}\n`, "utf8");
    await fs.writeFile(path.join(caseDir, "work", "segments.jsonl"), `${JSON.stringify(segments[0])}\n`, "utf8");
    await fs.writeFile(path.join(caseDir, "work", "evidence.jsonl"), `${JSON.stringify({ ...claim, caseId })}\n`, "utf8");

    const result = await loadEvidenceSnapshot(caseDir);
    assert.equal(result.manifest.id, caseId);
    assert.equal(result.deepRead.sections.length, 0);
    assert.equal(result.baseline.claims.length, 1);
  } finally {
    await fs.rm(caseDir, { recursive: true, force: true });
  }
});

test("2.4 baseline recovery discovers current-policy audit artifacts without changing the baseline protocol", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-cross-policy-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packetRoot = path.join(root, "work", "reviews", "2.4.2", "preflight", "round-01", "claim-audit-test", "packets");
  const repairRoot = path.join(root, "work", "reviews", "2.4.2", "repairs", "round-01");
  await fs.mkdir(packetRoot, { recursive: true });
  await fs.mkdir(repairRoot, { recursive: true });
  const packetClaim = { ...claim, caseId: manifest.id };
  const expectedEvidenceHash = sha256Value([packetClaim]);
  const packet = {
    caseId: manifest.id,
    inputHashes: { evidence: expectedEvidenceHash },
    payload: { claims: [{ ...packetClaim, supportSpans: packetClaim.supportSpans.map((span) => ({ ...span, sourceUnits: normalized })) }] },
  };
  await fs.writeFile(path.join(packetRoot, "claim_auditor.json"), `${JSON.stringify(packet)}\n`, "utf8");
  const repairLog = { caseId: manifest.id, inputHashes: { evidence: expectedEvidenceHash } };
  await fs.writeFile(path.join(repairRoot, "claim-repair-log.json"), `${JSON.stringify(repairLog)}\n`, "utf8");

  const recovered = await findInitialAuditClaims(root, {
    manifest,
    resolution: { inputHashes: { evidence: expectedEvidenceHash } },
  });
  assert.deepEqual(recovered, [packetClaim]);
  const repairLogs = await findRepairLogs(root);
  assert.equal(repairLogs.length, 1);
  assert.match(repairLogs[0].replaceAll("\\", "/"), /reviews\/2\.4\.2\/repairs\/round-01\/claim-repair-log\.json$/u);
});

test("2.4 evidence diff keeps unchanged and quote-only changes mechanical", () => {
  const baseline = snapshot();
  const unchanged = buildEvidenceChangeSet({ manifest, baseline, current: snapshot() });
  assert.equal(unchanged.mode, "mechanical");
  assert.equal(unchanged.requiredReviews.claimAudit, false);
  assert.equal(unchanged.requiredReviews.blindRecall, false);
  assert.equal(unchanged.requiredReviews.coverageAB, false);

  const quoteOnly = structuredClone(claim);
  quoteOnly.supportSpans[0].quote = "source with exact punctuation";
  const changed = buildEvidenceChangeSet({ manifest, baseline, current: snapshot([quoteOnly]) });
  assert.equal(changed.mode, "mechanical");
  assert.deepEqual(changed.changes.mechanicalRefs, ["E0001"]);
  assert.equal(changed.requiredReviews.claimAudit, false);
});

test("2.4 initial-audit repair lineage accepts repair logs that use changes", () => {
  const entries = repairLineageEntries({
    changes: [
      { evidenceRef: "E0001", action: "merge_into_canonical_claim", replacementEvidenceRefs: ["E0002"] },
      { evidenceRef: "E0003", action: "replace_statement" },
    ],
  });
  assert.deepEqual(entries, [
    { oldEvidenceRefs: ["E0001"], newEvidenceRefs: ["E0002"], action: "merge_into_canonical_claim" },
    { oldEvidenceRefs: ["E0003"], newEvidenceRefs: ["E0003"], action: "replace_statement" },
  ]);
});

test("2.4 evidence diff limits a traceable semantic change to the affected scope", () => {
  const baseline = snapshot();
  const edited = structuredClone(claim);
  edited.statement = "A materially revised statement";
  const current = snapshot([edited], {
    ...deepRead,
    sections: structuredClone(deepRead.sections),
  });
  const changeSet = buildEvidenceChangeSet({ manifest, baseline, current });
  assert.equal(changeSet.mode, "semantic_delta");
  assert.deepEqual(changeSet.changes.modifiedRefs, ["E0001"]);
  assert.deepEqual(changeSet.affected.readerBlockRefs, ["p"]);
  assert.equal(changeSet.requiredReviews.claimAudit, true);
  assert.equal(changeSet.requiredReviews.fullClaimAudit, false);
  assert.equal(changeSet.requiredReviews.fidelity, true);
  assert.equal(changeSet.requiredReviews.sourceScout, true);
  assert.equal(changeSet.requiredReviews.blindRecall, false);
  assert.equal(changeSet.requiredReviews.coverageAB, false);
});

test("2.4 delta review preserves a legacy report and allows only a hash-bound non-core ASR warning disposition", () => {
  const baseline = snapshot();
  const edited = structuredClone(claim);
  edited.statement = "A possibly ASR-ambiguous, non-core statement";
  const current = snapshot([edited]);
  const changeSet = buildEvidenceChangeSet({ manifest, baseline, current });
  const finding = {
    evidenceRef: "E0001",
    code: "unsupported_semantic_extension",
    message: "A colloquial ASR token has more than one plausible reading.",
    sourceRefs: ["C0001"],
  };
  const legacyReport = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    reviewRound: 1,
    role: "claim_delta_auditor",
    assignedReviewerId: "legacy-reviewer",
    inputHashes: {
      changeSet: sha256Value(changeSet),
      baselineEvidence: sha256Value([claim]),
      currentEvidence: sha256Value([edited]),
      segments: sha256Value(segments),
    },
    reviewedRefs: ["E0001"],
    refVerdicts: [{ evidenceRef: "E0001", changeType: "modified", verdict: "nonpass", rationale: "ASR ambiguity." }],
    hardErrors: [finding],
  };
  assert.deepEqual(claimsDeltaReviewContractErrors(legacyReport, {
    manifest,
    changeSet,
    baselineEvidence: [claim],
    currentEvidence: [edited],
    segments,
  }), []);
  assert.equal(applyClaimPolicyDisposition(legacyReport, null).hardErrors.length, 1);

  const disposition = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    authority: "user_approved_nonblocking_warning",
    approvedAt: "2026-09-01",
    inputHashes: {
      changeSet: sha256Value(changeSet),
      report: sha256Value(legacyReport),
      currentEvidence: sha256Value([edited]),
      segments: sha256Value(segments),
    },
    entries: [{
      evidenceRef: "E0001",
      findingHash: sha256Value(finding),
      decision: "warning",
      basis: "non_core_asr_ambiguity",
      deliveryConstraint: "exclude_from_new_reader",
      safeguards: {
        noFabrication: true,
        noMisattribution: true,
        noContradiction: true,
        noInvalidCitation: true,
        noMaterialSemanticChange: true,
        coreUnderstandingUnaffected: true,
      },
      rationale: "The user approved keeping this non-core ASR ambiguity in evidence only.",
    }],
  };
  assert.deepEqual(claimPolicyDispositionContractErrors(disposition, {
    manifest,
    changeSet,
    currentEvidence: [edited],
    segments,
    report: legacyReport,
  }), []);
  const applied = applyClaimPolicyDisposition(legacyReport, disposition);
  assert.deepEqual(applied.hardErrors, []);
  assert.equal(applied.warnings[0].deliveryConstraint, "exclude_from_new_reader");

  const stale = structuredClone(disposition);
  stale.inputHashes.report = "f".repeat(64);
  assert.match(claimPolicyDispositionContractErrors(stale, {
    manifest,
    changeSet,
    currentEvidence: [edited],
    segments,
    report: legacyReport,
  }).join(" "), /report 已过期/u);
});

test("2.4 policy disposition cannot downgrade fabrication, misattribution, contradiction, invalid citation, or material semantic change", () => {
  const edited = structuredClone(claim);
  edited.statement = "A fabricated statement";
  const changeSet = buildEvidenceChangeSet({ manifest, baseline: snapshot(), current: snapshot([edited]) });
  for (const protectedCode of ["fabricated", "misattributed", "contradicted", "invalid_citation", "material_semantic_change"]) {
    const finding = { evidenceRef: "E0001", code: protectedCode, message: protectedCode };
    const report = {
      schemaVersion: "1.0.0",
      caseId: manifest.id,
      reviewPolicyVersion: "2.4.0",
      reviewRound: 1,
      role: "claim_delta_auditor",
      reviewerId: "reviewer",
      inputHashes: {},
      scope: { addedRefs: [], removedRefs: [], modifiedRefs: ["E0001"] },
      entries: [{ evidenceRef: "E0001", changeType: "modified", verdict: "hard_error", issueKinds: [protectedCode], rationale: protectedCode }],
      hardErrors: [finding],
    };
    const disposition = {
      schemaVersion: "1.0.0",
      caseId: manifest.id,
      reviewPolicyVersion: "2.4.0",
      authority: "user_approved_nonblocking_warning",
      inputHashes: {
        changeSet: sha256Value(changeSet),
        report: sha256Value(report),
        currentEvidence: sha256Value([edited]),
        segments: sha256Value(segments),
      },
      entries: [{
        evidenceRef: "E0001",
        findingHash: sha256Value(finding),
        decision: "warning",
        basis: "non_core_asr_ambiguity",
        deliveryConstraint: "exclude_from_new_reader",
        safeguards: {
          noFabrication: true,
          noMisattribution: true,
          noContradiction: true,
          noInvalidCitation: true,
          noMaterialSemanticChange: true,
          coreUnderstandingUnaffected: true,
        },
        rationale: "Attempted downgrade.",
      }],
    };
    assert.match(claimPolicyDispositionContractErrors(disposition, {
      manifest,
      changeSet,
      currentEvidence: [edited],
      segments,
      report,
    }).join(" "), /不可降级|不属于可降级/u, protectedCode);
  }
});

test("2.4 delta review blocks explicit hard errors but keeps advisory revise findings as warnings", () => {
  const report = {
    entries: [
      { evidenceRef: "E0001", verdict: "pass", issueKinds: [] },
      { evidenceRef: "E0002", verdict: "revise", issueKinds: ["ambiguous_subject"] },
      { evidenceRef: "E0003", verdict: "hard_error", issueKinds: ["misattributed"] },
    ],
    hardErrors: [],
  };
  assert.deepEqual(advisoryDeltaEntries(report).map((entry) => entry.evidenceRef), ["E0002"]);
  assert.deepEqual(blockingDeltaEntries(report).map((entry) => entry.evidenceRef), ["E0003"]);

  const promoted = structuredClone(report);
  promoted.hardErrors = [{ evidenceRef: "E0002", code: "material_semantic_change" }];
  assert.deepEqual(advisoryDeltaEntries(promoted).map((entry) => entry.evidenceRef), []);
  assert.deepEqual(blockingDeltaEntries(promoted).map((entry) => entry.evidenceRef).sort(), ["E0002", "E0003"]);
});

test("2.4 evidence diff escalates untraceable removal and structural source changes", () => {
  const baseline = snapshot();
  const removed = buildEvidenceChangeSet({ manifest, baseline, current: snapshot([]) });
  assert.equal(removed.mode, "structural_full");
  assert.match(removed.reasons.join(" "), /removed_claim_lineage_missing/u);

  const repairedRemoval = buildEvidenceChangeSet({
    manifest,
    baseline,
    current: snapshot([]),
    repairLineage: { entries: [{ oldEvidenceRefs: ["E0001"], newEvidenceRefs: [] }] },
  });
  assert.equal(repairedRemoval.mode, "semantic_delta");
  assert.equal(repairedRemoval.requiredReviews.fullClaimAudit, false);

  const structural = snapshot();
  structural.hashes.segments = "b".repeat(64);
  const changed = buildEvidenceChangeSet({ manifest, baseline, current: structural });
  assert.equal(changed.mode, "structural_full");
  assert.equal(changed.requiredReviews.fullClaimAudit, true);
});

test("a first full-audit repair is rechecked as a bounded delta instead of a second full audit", () => {
  const provisional = snapshot();
  const edited = structuredClone(claim);
  edited.statement = "A narrower supported statement";
  const current = snapshot([edited]);
  const changeSet = buildEvidenceChangeSet({ manifest, baseline: provisional, current });
  const resolution = { status: "repair_required", inputHashes: { evidence: provisional.hashes.evidence, segments: provisional.hashes.segments } };
  const repairLog = {
    authority: "claim_gate_adjudicated_hard_error_repair",
    inputHashes: { evidence: provisional.hashes.evidence },
    outputHashes: { evidence: current.hashes.evidence },
    affectedEvidenceRefs: ["E0001"],
    unresolved: [],
  };
  assert.equal(changeSet.mode, "semantic_delta");
  assert.deepEqual(initialAuditRepairLineageErrors({ resolution, repairLog, provisional, current, changeSet }), []);
  const undeclared = { ...repairLog, affectedEvidenceRefs: [] };
  assert.match(initialAuditRepairLineageErrors({ resolution, repairLog: undeclared, provisional, current, changeSet }).join(" "), /未精确覆盖/u);

  const supplementalLog = {
    authority: "repair_only_no_approval",
    role: "evidence_repair_editor",
    sourceClaimResolution: { status: "repair_required", inputEvidenceHash: provisional.hashes.evidence },
    inputHashes: { evidence: provisional.hashes.evidence },
    outputHashes: { evidence: current.hashes.evidence },
    changedEvidenceRefs: { retired: [], canonical: ["E0001"] },
    unresolved: [],
  };
  assert.deepEqual(initialAuditRepairLineageErrors({ resolution, repairLog: supplementalLog, provisional, current, changeSet }), []);
});

test("2.4 change-set validation rejects an undeclared affected reader block", () => {
  const baseline = snapshot();
  const edited = structuredClone(claim);
  edited.statement = "A materially revised statement";
  const current = snapshot([edited]);
  const changeSet = buildEvidenceChangeSet({ manifest, baseline, current });
  changeSet.affected.readerBlockRefs = [];
  assert.match(
    evidenceChangeSetContractErrors(changeSet, { manifest, baseline, current }).join(" "),
    /affected 未完整申报实际影响范围/u,
  );
});

test("initial-audit repair lineage must follow a mechanical fix to the current evidence hash", () => {
  const baseline = snapshot();
  baseline.acceptance = "initial_full_audit_pre_repair";
  const edited = structuredClone(claim);
  edited.statement = "A materially revised statement";
  const current = snapshot([edited]);
  const repairLineage = {
    schemaVersion: "1.1.0",
    caseId: manifest.id,
    inputEvidenceHash: baseline.hashes.evidence,
    outputEvidenceHash: "f".repeat(64),
    entries: [],
  };
  const changeSet = buildEvidenceChangeSet({ manifest, baseline, current, repairLineage });
  assert.match(
    evidenceChangeSetContractErrors(changeSet, { manifest, baseline, current, repairLineage }).join(" "),
    /输出 evidence 哈希与当前 evidence 不一致/u,
  );
});

test("participant guide requires cited event-time identities and renders one shared source", async () => {
  const guide = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    eventDate: "2026-08-27",
    verifiedAt: "2026-09-01",
    mode: "single_guest",
    principals: [{
      id: "guest",
      name: "Guest",
      roleAtEvent: "Role",
      affiliationAtEvent: "Institution",
      relevantContext: "Relevant context.",
      briefContext: "Short context.",
      citationRefs: ["R1"],
    }],
    supportingRoles: [],
  };
  assert.deepEqual(participantGuideContractErrors(guide, { manifest, citationIds: new Set(["R1"]) }), []);
  assert.match(renderParticipantGuideMarkdown(guide), /以下身份以 2026-08-27/u);
  const publicationGuide = { ...guide, dateBasis: "publication" };
  assert.match(renderParticipantGuideMarkdown(publicationGuide), /本期资料发布时/u);
  assert.doesNotMatch(renderParticipantGuideMarkdown(publicationGuide), /本场活动发生时/u);
  assert.match(renderParticipantGuideMarkdown(guide), /Relevant context/u);
  assert.match(renderParticipantGuideMarkdown(guide), /\[R1\]\(#r1\)/u);
  const html = renderParticipantGuide(guide, new Map([["R1", 1]]));
  assert.match(html, /class="participant-guide"/u);
  assert.match(html, /Short context/u);
  assert.match(html, /href="#source-R1"/u);
  const publicationHtml = renderParticipantGuide(publicationGuide, new Map([["R1", 1]]));
  assert.match(publicationHtml, /本期资料发布时/u);
  assert.doesNotMatch(publicationHtml, /本场活动发生时/u);

  const guideWithCompactHost = {
    ...guide,
    supportingRoles: [{
      id: "host",
      name: "Host",
      roleAtEvent: "节目主持人",
      citationRefs: ["R1"],
    }],
  };
  const compactMarkdown = renderParticipantGuideMarkdown(guideWithCompactHost);
  const compactHtml = renderParticipantGuide(guideWithCompactHost, new Map([["R1", 1]]));
  assert.match(compactMarkdown, /Host.*节目主持人/u);
  assert.match(compactHtml, /Host/u);
  assert.doesNotMatch(compactMarkdown, /undefined/u);
  assert.doesNotMatch(compactHtml, /undefined/u);

  const invalid = structuredClone(guide);
  invalid.principals[0].citationRefs = [];
  assert.match(participantGuideContractErrors(invalid, { manifest, citationIds: new Set() }).join(" "), /缺少外部引用/u);

  const css = await fs.readFile(new URL("../templates/quickread.css", import.meta.url), "utf8");
  assert.match(css, /\.participant-grid[\s\S]*repeat\(2,/u);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.participant-grid[\s\S]*grid-template-columns: 1fr/u);
});

test("participant guide review requires two independent fixed roles", () => {
  const valid = {
    reviewedAt: "2026-09-01",
    baselineReview: "work/reviews/2.3.2/round-01/consensus.json",
    reviewers: [
      { role: "external_citation", reviewerId: "source-reviewer", status: "pass", hardErrors: [], warnings: [] },
      { role: "reader_advocate", reviewerId: "reader-reviewer", status: "pass", hardErrors: [], warnings: [] },
    ],
  };
  assert.deepEqual(participantGuideReviewDraftErrors(valid), []);
  const duplicate = structuredClone(valid);
  duplicate.reviewers[1].reviewerId = duplicate.reviewers[0].reviewerId;
  assert.match(participantGuideReviewDraftErrors(duplicate).join(" "), /reviewerId 必须相互独立/u);
  const missingRole = structuredClone(valid);
  missingRole.reviewers[1].role = "external_citation";
  assert.match(participantGuideReviewDraftErrors(missingRole).join(" "), /reader_advocate|审核角色重复/u);
});

test("2.4 participant-guide review runs before brief generation", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-participant-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await fs.writeFile(path.join(root, "work", "evidence.jsonl"), `${JSON.stringify(claim)}\n`);
  await fs.writeFile(path.join(root, "work", "participant-guide.json"), "{}\n");
  await fs.writeFile(path.join(root, "work", "research.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "reader\n");
  const hashes = await participantGuideReviewInputHashes(root);
  assert.equal(Object.hasOwn(hashes, "brief"), false);
  await assert.rejects(
    () => participantGuideReviewInputHashes(root, { includeBrief: true }),
    /ENOENT|brief\.json/u,
  );
});

test("participant-guide reviewers receive isolated hash-bound packets", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-participant-packets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await fs.writeFile(path.join(root, "case.json"), `${JSON.stringify({ id: manifest.id })}\n`);
  await fs.writeFile(path.join(root, "work", "evidence.jsonl"), `${JSON.stringify(claim)}\n`);
  await fs.writeFile(path.join(root, "work", "participant-guide.json"), `${JSON.stringify({ principals: [{ citationRefs: ["R1"] }], supportingRoles: [] })}\n`);
  await fs.writeFile(path.join(root, "work", "research.json"), `${JSON.stringify({ citations: [{ id: "R1", url: "https://example.test" }] })}\n`);
  await fs.writeFile(path.join(root, "output", "deep-read.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "reader\n");
  const prepared = await prepareParticipantGuideReview(root, {
    external_citation: "external-reviewer",
    reader_advocate: "reader-reviewer",
  });
  for (const entry of prepared.manifest.packets) {
    const report = {
      schemaVersion: "1.0.0",
      caseId: manifest.id,
      reviewPolicyVersion: "2.4.0",
      role: entry.role,
      reviewerId: entry.reviewerId,
      packetId: entry.packetId,
      packetHash: entry.packetHash,
      inputHashes: entry.inputHashes,
      status: "pass",
      hardErrors: [],
      warnings: [],
      summary: "pass",
    };
    const reportPath = path.join(prepared.root, entry.outputPath);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  assert.deepEqual((await participantGuideReviewerReportErrors(root)).errors, []);
  assert.equal(Object.hasOwn(prepared.manifest, "inputHashes"), false);
});

test("participant-guide role hashes ignore unrelated evidence, research and reader prose", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-participant-local-hashes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  const guide = {
    principals: [{ name: "Guest", roleAtEvent: "Founder", affiliationAtEvent: "Lab", relevantContext: "Context", citationRefs: ["R1"] }],
    supportingRoles: [],
  };
  const deepRead = {
    sections: [{ title: "内容概览", modules: [
      { title: null, profileModule: "participants", blocks: [{ id: "participant-guide-main", type: "participant_guide" }] },
      { title: "正文", blocks: [{ id: "p1", type: "prose_group", provenance: "source_fact", text: "old" }] },
    ] }],
  };
  await fs.writeFile(path.join(root, "work", "evidence.jsonl"), `${JSON.stringify(claim)}\n`);
  await fs.writeFile(path.join(root, "work", "participant-guide.json"), `${JSON.stringify(guide)}\n`);
  await fs.writeFile(path.join(root, "work", "research.json"), `${JSON.stringify({ citations: [{ id: "R1", note: "used" }, { id: "R2", note: "unused" }] })}\n`);
  await fs.writeFile(path.join(root, "output", "deep-read.json"), `${JSON.stringify(deepRead)}\n`);
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "old reader\n");
  const before = await participantGuideReviewRoleInputHashes(root);

  await fs.writeFile(path.join(root, "work", "evidence.jsonl"), `${JSON.stringify({ ...claim, statement: "unrelated evidence edit" })}\n`);
  deepRead.sections[0].modules[1].blocks[0].provenance = "speaker_view";
  deepRead.sections[0].modules[1].blocks[0].text = "new unrelated prose";
  await fs.writeFile(path.join(root, "output", "deep-read.json"), `${JSON.stringify(deepRead)}\n`);
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "new unrelated reader prose\n");
  await fs.writeFile(path.join(root, "work", "research.json"), `${JSON.stringify({ citations: [{ id: "R1", note: "used" }, { id: "R2", note: "unused changed" }] })}\n`);
  const unrelated = await participantGuideReviewRoleInputHashes(root);
  assert.deepEqual(unrelated, before);

  await fs.writeFile(path.join(root, "work", "research.json"), `${JSON.stringify({ citations: [{ id: "R1", note: "used changed" }, { id: "R2", note: "unused changed" }] })}\n`);
  const citedChange = await participantGuideReviewRoleInputHashes(root);
  assert.notDeepEqual(citedChange.external_citation, before.external_citation);
  assert.deepEqual(citedChange.reader_advocate, before.reader_advocate);
});

test("participant-guide prepare deterministically reuses unchanged role report", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-participant-role-reuse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await fs.writeFile(path.join(root, "case.json"), `${JSON.stringify({ id: manifest.id })}\n`);
  await fs.writeFile(path.join(root, "work", "evidence.jsonl"), `${JSON.stringify(claim)}\n`);
  await fs.writeFile(path.join(root, "work", "participant-guide.json"), `${JSON.stringify({ principals: [{ citationRefs: ["R1"] }], supportingRoles: [] })}\n`);
  await fs.writeFile(path.join(root, "work", "research.json"), `${JSON.stringify({ citations: [{ id: "R1", url: "https://example.test" }] })}\n`);
  await fs.writeFile(path.join(root, "output", "deep-read.json"), `${JSON.stringify({ sections: [] })}\n`);
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "reader\n");
  const first = await prepareParticipantGuideReview(root, {
    external_citation: "external-reviewer",
    reader_advocate: "reader-reviewer-old",
  });
  const external = first.manifest.packets.find((entry) => entry.role === "external_citation");
  const externalReport = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    role: external.role,
    reviewerId: external.reviewerId,
    packetId: external.packetId,
    packetHash: external.packetHash,
    inputHashes: external.inputHashes,
    status: "pass",
    hardErrors: [],
    warnings: [],
    summary: "external pass",
  };
  await fs.mkdir(path.dirname(path.join(first.root, external.outputPath)), { recursive: true });
  await fs.writeFile(path.join(first.root, external.outputPath), `${JSON.stringify(externalReport, null, 2)}\n`);

  const second = await prepareParticipantGuideReview(root, { reader_advocate: "reader-reviewer-new" });
  const reused = second.manifest.packets.find((entry) => entry.role === "external_citation");
  assert.equal(reused.packetId, external.packetId);
  assert.equal(reused.outputPath, external.outputPath);
  assert.equal(reused.retainedReport.mode, "verified_packet_payload");
  const reader = second.manifest.packets.find((entry) => entry.role === "reader_advocate");
  const readerReport = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    role: reader.role,
    reviewerId: reader.reviewerId,
    packetId: reader.packetId,
    packetHash: reader.packetHash,
    inputHashes: reader.inputHashes,
    status: "pass",
    hardErrors: [],
    warnings: [],
    summary: "reader pass",
  };
  await fs.mkdir(path.dirname(path.join(second.root, reader.outputPath)), { recursive: true });
  await fs.writeFile(path.join(second.root, reader.outputPath), `${JSON.stringify(readerReport, null, 2)}\n`);
  assert.deepEqual((await participantGuideReviewerReportErrors(root)).errors, []);
});

test("legacy participant-guide review records remain valid", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-participant-legacy-record-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await fs.writeFile(path.join(root, "work", "evidence.jsonl"), `${JSON.stringify(claim)}\n`);
  await fs.writeFile(path.join(root, "work", "participant-guide.json"), "{}\n");
  await fs.writeFile(path.join(root, "work", "research.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "reader\n");
  const inputHashes = await participantGuideReviewInputHashes(root);
  assert.deepEqual(await participantGuideReviewRecordErrors(root, { schemaVersion: "1.1.0", inputHashes }), []);
});

test("render review cannot pass while retaining a hard error", () => {
  const valid = {
    reviewedAt: "2026-09-01",
    reviewerId: "render-reviewer",
    status: "pass",
    hardErrors: [],
    warnings: [],
  };
  assert.deepEqual(renderReviewDraftErrors(valid), []);
  assert.match(
    renderReviewDraftErrors({ ...valid, hardErrors: ["overflow"] }).join(" "),
    /存在 hardErrors 时 status 不能为 pass/u,
  );
});
