import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, sha256File } from "../scripts/lib.mjs";
import {
  computeRepairDiagnosticConsensus,
  prepareRepairDiagnostic,
  refreshRepairDiagnostic,
  validateRepairDiagnostic,
} from "../scripts/review-diagnostic.mjs";
import { sha256Value } from "../scripts/review-contract.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

async function writeJsonl(filePath, values) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

const assignments = {
  blind_recall: "diagnostic-blind-r4",
  alignment: "diagnostic-alignment-r4",
  fidelity: "diagnostic-fidelity-r4",
  repair_editor: "diagnostic-repair-r4",
};

function config(limit = 4) {
  return {
    reviews: { maximumRepairRounds: 2, repairRoundOverrides: { "QR-9999": limit } },
    qualityGates: { allClaimRecall: 0.95 },
  };
}

async function withFixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-diagnostic-"));
  const caseDir = path.join(root, "qr-9999-diagnostic");
  try {
    const caseId = path.basename(caseDir);
    const source = [{ id: "C000001", text: "嘉宾认为部署前必须验证边界。" }];
    const segments = [{ id: "S0001", caseId, sourceIds: ["C000001"], text: source[0].text }];
    const claims = [{
      id: "E0001",
      statement: "嘉宾认为部署前必须验证边界。",
      provenance: "speaker_view",
      importance: "high",
      claimRole: "opinion",
      themeId: "T001",
      supportSpans: [{ segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01–00:00:02" }],
    }];
    const deepRead = {
      schemaVersion: "2.0.0",
      caseId,
      sections: [{
        id: "overview",
        modules: [{ id: "overview-main", blocks: [{
          id: "overview-prose",
          type: "prose_group",
          provenance: "speaker_view",
          paragraphs: [{ id: "overview-p1", text: "嘉宾认为部署前必须验证边界。", evidenceRefs: ["E0001"] }],
        }] }],
      }],
    };
    const readerMap = { schemaVersion: "2.0.0", caseId, entries: [{ evidenceRef: "E0001", importance: "high", presentation: "explicit", coverageSpans: [{ readerBlockRef: "overview-p1", readerTextQuote: "部署前必须验证边界" }] }] };
    const research = { schemaVersion: "1.0.0", caseId, citations: [], checks: [], background: [] };
    const claimBundles = { schemaVersion: "1.0.0", caseId, bundles: [] };
    const themeMap = { schemaVersion: "1.0.0", caseId, themes: [], unassignedClaimRefs: [] };
    await writeJson(path.join(caseDir, "case.json"), { id: caseId, caseNumber: "QR-9999", source: { path: "input/source.srt" } });
    await writeJsonl(path.join(caseDir, "work/source.normalized.jsonl"), source);
    await writeJsonl(path.join(caseDir, "work/segments.jsonl"), segments);
    await writeJsonl(path.join(caseDir, "work/evidence.jsonl"), claims);
    await writeJson(path.join(caseDir, "work/reader-map.json"), readerMap);
    await writeJson(path.join(caseDir, "work/research.json"), research);
    await writeJson(path.join(caseDir, "work/claim-bundles.json"), claimBundles);
    await writeJson(path.join(caseDir, "work/theme-map.json"), themeMap);
    await writeJson(path.join(caseDir, "output/deep-read.json"), deepRead);
    const sourceRoot = path.join(caseDir, "work/reviews/2.2.0/round-03");
    await writeJson(path.join(sourceRoot, "manifest.json"), {
      schemaVersion: "1.0.0",
      caseId,
      reviewRound: 3,
      inputHashes: {
        segments: sha256Value(segments),
        evidence: "0".repeat(64),
        deepRead: sha256Value(deepRead),
        readerMap: sha256Value(readerMap),
        research: sha256Value(research),
      },
    });
    await writeJson(path.join(sourceRoot, "consensus.json"), { status: "invalid", errors: ["stale"] });
    await callback({ caseDir, caseId, sourceRoot, segments, claims, deepRead, readerMap, research });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function completeNegativeReports(caseDir, prepared, fixture) {
  const blindPacket = await readJson(path.join(prepared.root, "packets/blind_recall.json"));
  await writeJson(path.join(prepared.root, "blind-candidates.json"), {
    schemaVersion: "1.0.0",
    caseId: fixture.caseId,
    role: "blind_recall",
    reviewerId: assignments.blind_recall,
    reviewRound: 4,
    inputHashes: blindPacket.inputHashes,
    blindToEvidence: true,
    entries: [{ id: "BC0001", statement: "部署前必须验证边界并记录失败模式。", importance: "high", claimRole: "opinion", supportSpans: [{ segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01–00:00:02" }] }],
  });
  await refreshRepairDiagnostic(caseDir, 4);
  const alignmentPacket = await readJson(path.join(prepared.root, "packets/alignment.json"));
  await writeJson(path.join(prepared.root, "blind-alignment.json"), {
    schemaVersion: "1.0.0",
    caseId: fixture.caseId,
    role: "alignment",
    reviewerId: assignments.alignment,
    reviewRound: 4,
    inputHashes: alignmentPacket.inputHashes,
    entries: [{ candidateRef: "BC0001", relation: "partial", matchedEvidenceRefs: ["E0001"], missingFacets: ["记录失败模式"], rationale: "现有 evidence 缺少失败模式。" }],
  });
  const fidelityPacket = await readJson(path.join(prepared.root, "packets/fidelity.json"));
  await writeJson(path.join(prepared.root, "fidelity-review.json"), {
    schemaVersion: "1.0.0",
    caseId: fixture.caseId,
    role: "fidelity",
    reviewerId: assignments.fidelity,
    reviewRound: 4,
    inputHashes: fidelityPacket.inputHashes,
    entries: [{ readerBlockRef: "overview-p1", verdict: "partial", provenance: "speaker_view", evidenceRefs: ["E0001"], citationRefs: [], unsupportedText: ["必须"], provenanceVerdict: "correct", rationale: "强度需要核验。" }],
  });
}

test("repair diagnostic is append-only, authorized, hash-bound, and cannot masquerade as a formal round", async () => {
  await withFixture(async (fixture) => {
    const sourceManifestPath = path.join(fixture.sourceRoot, "manifest.json");
    const beforeHash = await sha256File(sourceManifestPath);
    const beforeStat = await fs.stat(sourceManifestPath);
    const prepared = await prepareRepairDiagnostic(fixture.caseDir, { repairRound: 4, sourceRound: 3, assignments, pipelineConfig: config() });
    assert.match(prepared.root, /preflight[\\/]round-04[\\/]repair-diagnostic-[a-f0-9]{12}$/u);
    assert.equal(prepared.manifest.kind, "repair_diagnostic");
    assert.equal(prepared.manifest.cannotReplaceFormalRound, true);
    assert.equal(await sha256File(sourceManifestPath), beforeHash);
    assert.equal((await fs.stat(sourceManifestPath)).mtimeMs, beforeStat.mtimeMs);
    await assert.rejects(fs.access(path.join(fixture.caseDir, "work/reviews/2.2.0/round-04/manifest.json")));
    await completeNegativeReports(fixture.caseDir, prepared, fixture);
    const validation = await validateRepairDiagnostic(fixture.caseDir, 4, { pipelineConfig: config() });
    assert.deepEqual(validation.errors, []);
    assert.deepEqual(validation.failures.map((failure) => failure.gate).sort(), ["blind_recall", "fidelity"]);
    const consensus = await computeRepairDiagnosticConsensus(fixture.caseDir, 4, { pipelineConfig: config() });
    assert.equal(consensus.status, "repair_required");
    assert.equal(consensus.cannotReplaceFormalConsensus, true);
    assert.equal(await sha256File(sourceManifestPath), beforeHash);
    const repairPacket = await readJson(path.join(prepared.root, "packets/repair_editor.json"));
    assert.equal(repairPacket.payload.requiresFreshClaimAuditor, true);
    assert.equal(repairPacket.payload.repairRound, 4);
    assert.equal(repairPacket.output.contract.properties.repairRound.maximum, 4);
    assert.match(repairPacket.output.path, /preflight\/round-04\/repair-diagnostic-[a-f0-9]{12}\/repair-log\.json$/u);
    assert.equal(await fs.access(path.join(prepared.root, "repair-diagnostic-consensus.json")).then(() => true), true);
    await assert.rejects(fs.access(path.join(fixture.caseDir, "work/reviews/2.2.0/round-04/consensus.json")));
  });
});

test("repair diagnostic rejects an unauthorized round and stale reports", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      prepareRepairDiagnostic(fixture.caseDir, { repairRound: 4, sourceRound: 3, assignments, pipelineConfig: config(3) }),
      /未授权第 4 轮/u,
    );
    const prepared = await prepareRepairDiagnostic(fixture.caseDir, { repairRound: 4, sourceRound: 3, assignments, pipelineConfig: config() });
    await completeNegativeReports(fixture.caseDir, prepared, fixture);
    const readerMap = await readJson(path.join(fixture.caseDir, "work/reader-map.json"));
    readerMap.entries[0].coverageSpans[0].readerTextQuote = "输入已改变";
    await writeJson(path.join(fixture.caseDir, "work/reader-map.json"), readerMap);
    const validation = await validateRepairDiagnostic(fixture.caseDir, 4, { pipelineConfig: config() });
    assert.match(validation.errors.join("\n"), /inputHashes\.readerMap 已过期/u);
    const consensus = await computeRepairDiagnosticConsensus(fixture.caseDir, 4, { pipelineConfig: config() });
    assert.equal(consensus.status, "invalid");
    await assert.rejects(fs.access(path.join(prepared.root, "packets/repair_editor.json")));
  });
});
