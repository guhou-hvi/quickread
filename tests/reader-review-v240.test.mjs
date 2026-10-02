import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadReviewState } from "../scripts/quality-report.mjs";

import {
  computeLiteReviewConsensus,
  liteReviewRoot,
  parseLiteReviewCli,
  prepareLiteReview,
  validateLiteReview,
} from "../scripts/reader-review-v240.mjs";

const assignments = {
  source_scout: "source-v24",
  fidelity: "fidelity-v24",
  reader_advocate: "reader-v24",
};

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)));

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-reader-v240-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const caseDir = path.join(tempRoot, "cases", "qr-test-reader-v240");
  await fs.mkdir(path.join(caseDir, "work"), { recursive: true });
  await fs.mkdir(path.join(caseDir, "output"), { recursive: true });
  await writeJson(path.join(caseDir, "case.json"), { id: "qr-test-reader-v240" });
  await fs.writeFile(path.join(caseDir, "work", "segments.jsonl"), `${JSON.stringify({ id: "S0001", text: "嘉宾提出核心判断。" })}\n`, "utf8");
  await fs.writeFile(path.join(caseDir, "work", "evidence.jsonl"), `${JSON.stringify({ id: "E0001", importance: "high", statement: "嘉宾提出核心判断。", supportSpans: [{ segmentId: "S0001" }] })}\n`, "utf8");
  await writeJson(path.join(caseDir, "work", "reader-map.json"), { schemaVersion: "2.1.0", caseId: "qr-test-reader-v240", entries: [] });
  await writeJson(path.join(caseDir, "work", "research.json"), { schemaVersion: "1.0.0", caseId: "qr-test-reader-v240", citations: [] });
  await writeJson(path.join(caseDir, "output", "deep-read.json"), {
    schemaVersion: "2.3.0",
    caseId: "qr-test-reader-v240",
    sections: [{
      id: "themes",
      modules: [{
        id: "theme-1",
        blocks: [{
          id: "theme-1-block",
          type: "prose_group",
          provenance: "speaker_view",
          paragraphs: [{ id: "theme-1-p1", text: "嘉宾提出核心判断。", evidenceRefs: ["E0001"] }],
        }],
      }],
    }],
  });
  await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), "# 深度阅读\n\n嘉宾提出核心判断。[E0001]\n", "utf8");
  await writeJson(path.join(caseDir, "output", "brief.json"), { caseId: "qr-test-reader-v240", generated: "before-review" });
  return caseDir;
}

async function packetAndManifest(caseDir, role, reviewRound = 1) {
  const root = liteReviewRoot(caseDir, reviewRound);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = manifest.packets.find((item) => item.role === role);
  const packet = JSON.parse(await fs.readFile(path.join(root, entry.packetPath), "utf8"));
  return { root, manifest, entry, packet };
}

async function writeReport(caseDir, role, { hardErrors = [], warnings = [], diagnostics = [], reviewerId, reviewRound = 1 } = {}) {
  const { root, manifest, entry, packet } = await packetAndManifest(caseDir, role, reviewRound);
  const report = {
    $schema: "reader-review-v240-report.schema.json",
    schemaVersion: "1.0.0",
    caseId: manifest.caseId,
    reviewPolicyVersion: "2.4.0",
    reviewRound,
    role,
    reviewerId: reviewerId ?? entry.reviewerId,
    packetId: entry.packetId,
    packetHash: entry.packetHash,
    inputHashes: manifest.inputHashes,
    hardErrors,
    warnings,
    diagnostics,
    summary: `${role} 完成审核。`,
  };
  await writeJson(path.join(root, packet.outputPath), report);
  return report;
}

async function writeCleanReports(caseDir) {
  for (const role of Object.keys(assignments)) await writeReport(caseDir, role);
}

test("2.4 prepare creates exactly three isolated packets and never binds brief", async (t) => {
  const caseDir = await fixture(t);
  const result = await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  assert.deepEqual(result.packets.map((packet) => packet.role).sort(), Object.keys(assignments).sort());
  assert.deepEqual(Object.keys(result.manifest.inputHashes).sort(), ["deepRead", "evidence", "readerMap", "readerMarkdown", "research", "segments"]);
  assert.equal("brief" in result.manifest.inputHashes, false);

  const sourcePacket = (await packetAndManifest(caseDir, "source_scout")).packet;
  const fidelityPacket = (await packetAndManifest(caseDir, "fidelity")).packet;
  const readerPacket = (await packetAndManifest(caseDir, "reader_advocate")).packet;
  assert.deepEqual(Object.keys(sourcePacket.payload).sort(), ["readerLeaves", "readerMarkdown", "segments"]);
  assert.deepEqual(Object.keys(fidelityPacket.payload).sort(), ["claims", "readerLeaves", "research", "segments"]);
  assert.deepEqual(Object.keys(readerPacket.payload).sort(), ["readerLeaves", "readerMarkdown"]);
});

test("article without optional guides still requires complete current reader reviews", async (t) => {
  const caseDir = await fixture(t);
  const manifest = { id: "qr-test-reader-v240", sourceType: "article", workflow: { version: "2.4.2" } };
  await writeJson(path.join(caseDir, "case.json"), manifest);
  const jsonLines = async name => (await fs.readFile(path.join(caseDir, "work", name), "utf8")).trim().split("\n").map(JSON.parse);
  const state = { manifest, claims: await jsonLines("evidence.jsonl"), segments: await jsonLines("segments.jsonl"), config: { reviews: { version: "2.4.2" } } };
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  assert.notEqual((await loadReviewState(caseDir, state)).status, "pass");
  await writeCleanReports(caseDir);
  await computeLiteReviewConsensus(caseDir, 1);
  assert.equal((await loadReviewState(caseDir, state)).status, "pass");
  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  deep.sections[0].modules[0].blocks[0].paragraphs[0].text = "审核之后改变了主张。";
  await writeJson(deepPath, deep);
  assert.notEqual((await loadReviewState(caseDir, state)).status, "pass");
});

test("targeted reader-review delta schema is valid JSON and exposes only bounded change kinds", async () => {
  const [schema, mechanicalSchema] = await Promise.all([
    fs.readFile(path.join(REPO_ROOT, "schemas", "reader-review-v240-delta-manifest.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "reader-review-v240-reader-map-mechanical.schema.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(schema.properties.reviewMode.const, "targeted_delta");
  assert.deepEqual(
    schema.properties.changeSet.properties.changedReaderBlocks.items.properties.kinds.items.enum,
    ["text", "evidence_refs", "citation_refs", "provenance"],
  );
  assert.equal(mechanicalSchema.properties.reviewMode.const, "reader_map_mechanical");
  assert.equal(mechanicalSchema.properties.rerunRoles.maxItems, 0);
});

test("brief changes do not stale 2.4 reader review, but deep-read changes do", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeJson(path.join(caseDir, "output", "brief.json"), { caseId: "qr-test-reader-v240", generated: "after-review" });
  assert.deepEqual((await validateLiteReview(caseDir, 1, { requireReports: false })).errors, []);

  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  deep.sections[0].modules[0].blocks[0].paragraphs[0].text = "正文已经变化。";
  await writeJson(deepPath, deep);
  assert.match((await validateLiteReview(caseDir, 1, { requireReports: false })).errors.join("\n"), /inputHashes\.deepRead 已过期/u);
});

test("prepare rejects duplicate reviewers and validate rejects packet path escape", async (t) => {
  const caseDir = await fixture(t);
  await assert.rejects(
    prepareLiteReview(caseDir, { reviewRound: 1, assignments: { ...assignments, reader_advocate: assignments.fidelity } }),
    /reviewerId 必须唯一/u,
  );
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  const root = liteReviewRoot(caseDir, 1);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.packets[0].outputPath = "../../escaped-report.json";
  await writeJson(manifestPath, manifest);
  assert.match((await validateLiteReview(caseDir, 1, { requireReports: false })).errors.join("\n"), /outputPath 越过 review root/u);
});

test("reports must use the packet-assigned reviewer and packet-local references", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeCleanReports(caseDir);
  await writeReport(caseDir, "reader_advocate", {
    reviewerId: "wrong-reviewer",
    warnings: [{ code: "readability", message: "越界 block", readerBlockRef: "not-in-packet" }],
  });
  const errors = (await validateLiteReview(caseDir, 1)).errors.join("\n");
  assert.match(errors, /不是 packet 指定 reviewer/u);
  assert.match(errors, /readerBlockRef 越过 packet 边界/u);
});

test("single Source Scout omission is warning; two-role confirmation becomes hard error", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeReport(caseDir, "source_scout", {
    hardErrors: [{ code: "core_omission", findingKey: "missing-core-mechanism", message: "遗漏核心机制。" }],
  });
  await writeReport(caseDir, "fidelity");
  await writeReport(caseDir, "reader_advocate", {
    hardErrors: [{ code: "score", message: "可读性评分较低。", value: 2 }],
  });
  let result = await computeLiteReviewConsensus(caseDir, 1, { write: false });
  assert.equal(result.consensus.hardErrors.length, 0);
  assert.equal(result.consensus.status, "pass_with_warnings");
  assert.ok(result.consensus.warnings.some((finding) => finding.code === "core_omission_candidate"));
  assert.ok(result.consensus.diagnostics.some((finding) => finding.code === "score"));

  await writeReport(caseDir, "fidelity", {
    hardErrors: [{ code: "core_omission", findingKey: "missing-core-mechanism", message: "来源与正文对照确认遗漏核心机制。", evidenceRefs: ["E0001"] }],
  });
  result = await computeLiteReviewConsensus(caseDir, 1, { write: false });
  assert.equal(result.consensus.status, "blocked");
  assert.deepEqual(result.consensus.hardErrors[0].confirmedByRoles.sort(), ["fidelity", "source_scout"]);
});

test("concrete Fidelity fabrication blocks while ordinary readability remains warning", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeReport(caseDir, "source_scout");
  await writeReport(caseDir, "fidelity", {
    hardErrors: [{ code: "fabricated", message: "正文新增来源不存在的数字。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] }],
  });
  await writeReport(caseDir, "reader_advocate", {
    hardErrors: [{ code: "readability", message: "段落略密。", readerBlockRef: "theme-1-p1" }],
  });
  const { consensus } = await computeLiteReviewConsensus(caseDir, 1, { write: false });
  assert.equal(consensus.status, "blocked");
  assert.equal(consensus.hardErrors.length, 1);
  assert.equal(consensus.hardErrors[0].code, "fabricated");
  assert.ok(consensus.warnings.some((finding) => finding.code === "readability"));
});

test("Fidelity hard aliases are case-normalized and unknown hard codes fail closed", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeReport(caseDir, "source_scout");
  await writeReport(caseDir, "fidelity", {
    hardErrors: [
      { code: "INVALID_EVIDENCE_MAPPING", message: "证据映射无效。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] },
      { code: "WRONG_PROVENANCE", message: "来源类型错误。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] },
      { code: "MISATTRIBUTED_DETAIL", message: "细节归属错误。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] },
      { code: "UNSUPPORTED_SPEAKER_VIEW", message: "说话人观点无支持。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] },
      { code: "UNRECOGNIZED_FATAL", message: "未知 Fidelity 硬错误。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] },
    ],
  });
  await writeReport(caseDir, "reader_advocate");
  const { consensus } = await computeLiteReviewConsensus(caseDir, 1, { write: false });
  assert.equal(consensus.status, "blocked");
  assert.deepEqual(consensus.hardErrors.map((finding) => finding.code), [
    "unsupported",
    "wrong_provenance",
    "misattributed",
    "unsupported",
    "unknown_hard_error",
  ]);
  assert.equal(consensus.hardErrors.at(-1).reportedCode, "UNRECOGNIZED_FATAL");
});

test("targeted text and reference delta reruns Fidelity and Reader while inheriting Source Scout", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeReport(caseDir, "source_scout", { warnings: [{ code: "ordinary_omission", message: "保留基础轮次提示。" }] });
  await writeReport(caseDir, "fidelity", { hardErrors: [{ code: "unsupported", message: "旧措辞缺少支持。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] }] });
  await writeReport(caseDir, "reader_advocate");
  await computeLiteReviewConsensus(caseDir, 1);

  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  const paragraph = deep.sections[0].modules[0].blocks[0].paragraphs[0];
  paragraph.text = "嘉宾提出经过收紧的核心判断。";
  paragraph.evidenceRefs = [];
  await writeJson(deepPath, deep);
  await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), "# 深度阅读\n\n嘉宾提出经过收紧的核心判断。\n", "utf8");

  const deltaAssignments = { fidelity: "fidelity-v24-delta", reader_advocate: "reader-v24-delta" };
  const prepared = await prepareLiteReview(caseDir, {
    reviewRound: 2,
    baseRound: 1,
    assignments: deltaAssignments,
    declaredChanges: [{ id: "theme-1-p1", kinds: ["text", "evidence_refs"] }],
  });
  assert.deepEqual(prepared.manifest.rerunRoles, ["fidelity", "reader_advocate"]);
  assert.deepEqual(prepared.manifest.inheritedRoles, ["source_scout"]);
  assert.deepEqual(prepared.packets.map((packet) => packet.role).sort(), Object.keys(deltaAssignments).sort());
  await writeReport(caseDir, "fidelity", { reviewRound: 2 });
  await writeReport(caseDir, "reader_advocate", { reviewRound: 2 });
  const result = await computeLiteReviewConsensus(caseDir, 2);
  assert.equal(result.consensus.status, "pass_with_warnings");
  assert.ok(result.consensus.warnings.some((finding) => finding.message === "保留基础轮次提示。"));
  assert.equal(result.consensus.hardErrors.length, 0);
  assert.deepEqual((await validateLiteReview(caseDir, 2)).errors, []);
});

test("provenance-only delta with identical Markdown reruns Fidelity only", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeCleanReports(caseDir);
  await computeLiteReviewConsensus(caseDir, 1);

  const markdownPath = path.join(caseDir, "output", "deep-read.md");
  const beforeMarkdown = await fs.readFile(markdownPath, "utf8");
  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  deep.sections[0].modules[0].blocks[0].provenance = "source_fact";
  await writeJson(deepPath, deep);
  assert.equal(await fs.readFile(markdownPath, "utf8"), beforeMarkdown);

  const prepared = await prepareLiteReview(caseDir, {
    reviewRound: 2,
    baseRound: 1,
    assignments: { fidelity: "fidelity-v24-provenance" },
    declaredChanges: [{ id: "theme-1-p1", kinds: ["provenance"] }],
  });
  assert.deepEqual(prepared.manifest.rerunRoles, ["fidelity"]);
  assert.deepEqual(prepared.manifest.inheritedRoles.sort(), ["reader_advocate", "source_scout"]);
  assert.equal(prepared.manifest.changeSet.readerMarkdownChanged, false);
  await writeReport(caseDir, "fidelity", { reviewRound: 2 });
  const { consensus } = await computeLiteReviewConsensus(caseDir, 2);
  assert.equal(consensus.status, "pass");
  assert.deepEqual((await validateLiteReview(caseDir, 2)).errors, []);
});

test("targeted delta rejects undeclared reader changes and preserves concrete Fidelity hard gates", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeCleanReports(caseDir);
  await computeLiteReviewConsensus(caseDir, 1);

  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  deep.sections[0].modules[0].blocks[0].paragraphs[0].text = "经核对后的判断。";
  await writeJson(deepPath, deep);
  await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), "# 深度阅读\n\n经核对后的判断。[E0001]\n", "utf8");
  await prepareLiteReview(caseDir, {
    reviewRound: 2,
    baseRound: 1,
    assignments: { fidelity: "fidelity-v24-hard", reader_advocate: "reader-v24-hard" },
    declaredChanges: [{ id: "theme-1-p1", kinds: ["text"] }],
  });
  await writeReport(caseDir, "fidelity", {
    reviewRound: 2,
    hardErrors: [{ code: "fabricated", message: "变化块新增来源不存在的事实。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] }],
  });
  await writeReport(caseDir, "reader_advocate", { reviewRound: 2 });
  let result = await computeLiteReviewConsensus(caseDir, 2, { write: false });
  assert.equal(result.consensus.status, "blocked");

  deep.sections[0].modules[0].blocks[0].paragraphs.push({ id: "theme-1-p2", text: "未申报新增块。", evidenceRefs: ["E0001"] });
  await writeJson(deepPath, deep);
  result = { validation: await validateLiteReview(caseDir, 2) };
  assert.match(result.validation.errors.join("\n"), /reader snapshot 与当前读者稿不一致|inputHashes\.deepRead 已过期/u);
});

async function makeDuplicateReaderMapBaseline(caseDir) {
  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  const block = deep.sections[0].modules[0].blocks[0];
  block.paragraphs.push({ id: "theme-1-p2", text: "第二段再次使用同一判断。", evidenceRefs: ["E0001"] });
  await writeJson(deepPath, deep);
  await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), "# 深度阅读\n\n嘉宾提出核心判断。[E0001]\n\n第二段再次使用同一判断。[E0001]\n", "utf8");
  const entries = block.paragraphs.map((paragraph) => ({
    evidenceRef: "E0001",
    importance: "high",
    presentation: "synthesized",
    coverageSpans: [{ readerBlockRef: paragraph.id, readerTextQuote: paragraph.text }],
  }));
  await writeJson(path.join(caseDir, "work", "reader-map.json"), {
    schemaVersion: "2.1.0",
    caseId: "qr-test-reader-v240",
    entries,
  });
  return entries;
}

test("reader-map canonicalization creates a zero-Agent completed round with semantic equivalence proof", async (t) => {
  const caseDir = await fixture(t);
  const duplicateEntries = await makeDuplicateReaderMapBaseline(caseDir);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeCleanReports(caseDir);
  await computeLiteReviewConsensus(caseDir, 1);
  await writeJson(path.join(caseDir, "work", "reader-map.json"), {
    schemaVersion: "2.1.0",
    caseId: "qr-test-reader-v240",
    entries: [{
      evidenceRef: "E0001",
      importance: "high",
      presentation: "synthesized",
      coverageSpans: duplicateEntries.flatMap((entry) => entry.coverageSpans),
    }],
  });
  const prepared = await prepareLiteReview(caseDir, {
    reviewRound: 2,
    baseRound: 1,
    readerMapMechanical: true,
    assignments: {},
  });
  assert.deepEqual(prepared.manifest.rerunRoles, []);
  assert.deepEqual(prepared.manifest.packets, []);
  assert.equal(prepared.manifest.mechanicalProof.duplicateEntriesRemoved, 1);
  assert.equal(prepared.manifest.repairAttemptConsumed, false);
  assert.deepEqual((await validateLiteReview(caseDir, 2)).errors, []);
  const { consensus } = await computeLiteReviewConsensus(caseDir, 2);
  assert.equal(consensus.status, "pass");
  assert.deepEqual(Object.keys(consensus.reviewerIds).sort(), Object.keys(assignments).sort());
});

test("reader-map mechanical round rejects semantic mapping changes and any non-readerMap change", async (t) => {
  const caseDir = await fixture(t);
  const duplicateEntries = await makeDuplicateReaderMapBaseline(caseDir);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeCleanReports(caseDir);
  await computeLiteReviewConsensus(caseDir, 1);
  await writeJson(path.join(caseDir, "work", "reader-map.json"), {
    schemaVersion: "2.1.0",
    caseId: "qr-test-reader-v240",
    entries: [{ ...duplicateEntries[0], presentation: "explicit" }],
  });
  await assert.rejects(
    prepareLiteReview(caseDir, { reviewRound: 2, baseRound: 1, readerMapMechanical: true, assignments: {} }),
    /canonicalization 改变/u,
  );

  await writeJson(path.join(caseDir, "work", "reader-map.json"), {
    schemaVersion: "2.1.0",
    caseId: "qr-test-reader-v240",
    entries: [{
      ...duplicateEntries[0],
      coverageSpans: duplicateEntries.flatMap((entry) => entry.coverageSpans),
    }],
  });
  await fs.appendFile(path.join(caseDir, "output", "deep-read.md"), "\n正文外变化。\n", "utf8");
  await assert.rejects(
    prepareLiteReview(caseDir, { reviewRound: 2, baseRound: 1, readerMapMechanical: true, assignments: {} }),
    /readerMarkdown 变化/u,
  );
});

test("historical flag can seal an immutable stale round while default validation stays current-bound", async (t) => {
  const caseDir = await fixture(t);
  await prepareLiteReview(caseDir, { reviewRound: 1, assignments });
  await writeReport(caseDir, "source_scout");
  await writeReport(caseDir, "fidelity", {
    hardErrors: [{ code: "unsupported", message: "旧稿存在具体失实。", readerBlockRef: "theme-1-p1", evidenceRefs: ["E0001"] }],
  });
  await writeReport(caseDir, "reader_advocate");
  const deepPath = path.join(caseDir, "output", "deep-read.json");
  const deep = JSON.parse(await fs.readFile(deepPath, "utf8"));
  deep.sections[0].modules[0].blocks[0].paragraphs[0].text = "修复后的正文。";
  await writeJson(deepPath, deep);
  const currentBound = await computeLiteReviewConsensus(caseDir, 1, { write: false });
  assert.equal(currentBound.consensus.status, "invalid");
  const historical = await computeLiteReviewConsensus(caseDir, 1, { bindCurrent: false });
  assert.equal(historical.consensus.status, "blocked");
  assert.deepEqual(historical.validation.errors, []);
  assert.equal(parseLiteReviewCli([caseDir, "--round", "1", "--historical"]).historical, true);
  assert.deepEqual((await validateLiteReview(caseDir, 1, { bindCurrent: false })).errors, []);
  assert.match((await validateLiteReview(caseDir, 1)).errors.join("\n"), /inputHashes\.deepRead 已过期/u);
});
