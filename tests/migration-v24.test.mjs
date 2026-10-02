import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MIGRATION_BATCHES,
  TARGET_VERSIONS,
  advanceMigrationLedger,
  migrationClassFor,
  migrationV24ContractErrors,
  prepareMigrationCase,
  prepareMigrationCases,
  resolveMigrationCase,
  stageArtifactErrors,
} from "../scripts/migrate-v24.mjs";
import {
  CONTEXT_UPGRADE_BATCHES,
  CONTEXT_UPGRADE_STAGES,
  CONTEXT_UPGRADE_TARGETS,
} from "../scripts/context-upgrade-v242.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(root, { number, workflow, corruptHash = false }) {
  const id = `qr-${number.slice(3).toLowerCase()}-fixture`;
  const caseDir = path.join(root, id);
  await fs.mkdir(path.join(caseDir, "input"), { recursive: true });
  await fs.mkdir(path.join(caseDir, "work"), { recursive: true });
  await fs.mkdir(path.join(caseDir, "output"), { recursive: true });
  const source = Buffer.from(`source-${number}`);
  await fs.writeFile(path.join(caseDir, "input", "source.srt"), source);
  const manifest = {
    id,
    caseNumber: number,
    source: { path: "input/source.srt", sha256: corruptHash ? "0".repeat(64) : sha256(source) },
    workflow: { version: workflow, promptVersion: "old", templateVersion: "old" },
  };
  await fs.writeFile(path.join(caseDir, "case.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(caseDir, "work", "source.normalized.jsonl"), "{\"id\":\"C0001\"}\n");
  await fs.writeFile(path.join(caseDir, "work", "segments.jsonl"), "{\"id\":\"S0001\"}\n");
  await fs.writeFile(path.join(caseDir, "work", "evidence.jsonl"), "{\"id\":\"E0001\"}\n");
  await fs.writeFile(path.join(caseDir, "output", "deep-read.md"), "reader baseline\n");
  return { caseDir, manifest };
}

async function completeV242Delivery(caseDir) {
  const manifestPath = path.join(caseDir, "case.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.workflow = { version: "2.4.2", promptVersion: "3.4.2", templateVersion: "1.4.4" };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const contextBatch = Object.entries(CONTEXT_UPGRADE_BATCHES).find(([, cases]) => cases.includes(manifest.caseNumber))?.[0];
  assert.ok(contextBatch, `missing context batch for ${manifest.caseNumber}`);
  const hash = "a".repeat(64);
  const ledger = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    caseNumber: manifest.caseNumber,
    batchId: contextBatch,
    targetVersions: CONTEXT_UPGRADE_TARGETS,
    initialHashes: { immutable: { source: hash, "work/source.normalized.jsonl": hash, "work/segments.jsonl": hash, "work/evidence.jsonl": hash, "work/reader-map.json": hash } },
    completedStages: [...CONTEXT_UPGRADE_STAGES],
    lastCompletedStage: "complete",
    nextAction: "等待人工校审。",
    preparedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const files = new Map([
    ["output/deep-read.json", { schemaVersion: "2.5.0", workflowVersion: "2.4.2" }],
    ["output/brief.json", { schemaVersion: "1.7.0", workflowVersion: "2.4.2", templateVersion: "1.4.4" }],
    ["work/quality-report.json", { status: "pass" }],
    ["work/context-upgrade-v2.4.2.json", ledger],
    ["work/context-guide.json", { schemaVersion: "1.0.0", entries: [] }],
  ]);
  for (const [relative, value] of files) {
    const filePath = path.join(caseDir, ...relative.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  for (const relative of ["output/evidence-book.md", "output/quickread.html", "output/quickread.png", "output/quickread-mobile.png", "work/participant-guide.json", "work/render-report.json"]) {
    const filePath = path.join(caseDir, ...relative.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "fixture\n", "utf8");
  }
}

test("2.4 migration batches are fixed, complete, and non-overlapping", () => {
  assert.deepEqual(MIGRATION_BATCHES.pilots, ["QR-0002", "QR-0011", "QR-0013", "QR-0022", "QR-0023"]);
  assert.equal(MIGRATION_BATCHES["legacy-a"].length, 6);
  assert.equal(MIGRATION_BATCHES["legacy-b"].length, 6);
  assert.equal(MIGRATION_BATCHES["legacy-c"].length, 6);
  const all = Object.values(MIGRATION_BATCHES).flat();
  assert.equal(new Set(all).size, all.length);
});

test("the historical migration ledger contract remains pinned to the 2.4.0 content baseline", async () => {
  const schema = JSON.parse(await fs.readFile(new URL("../schemas/migration-v24.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.targetVersions.properties.workflow.const, TARGET_VERSIONS.workflow);
  assert.equal(schema.properties.targetVersions.properties.prompt.const, TARGET_VERSIONS.prompt);
  assert.equal(schema.properties.targetVersions.properties.template.const, TARGET_VERSIONS.template);
  assert.equal(schema.properties.targetVersions.properties.deepReadSchema.const, TARGET_VERSIONS.deepReadSchema);
  assert.equal(schema.properties.targetVersions.properties.briefSchema.const, TARGET_VERSIONS.briefSchema);
});

test("migration classification keeps the three approved paths distinct", () => {
  assert.equal(migrationClassFor({ caseNumber: "QR-0017", workflow: { version: "2.3.0" } }), "light_reader_upgrade");
  assert.equal(migrationClassFor({ caseNumber: "QR-0011", workflow: { version: "2.2.0" } }), "reusable_evidence");
  assert.equal(migrationClassFor({ caseNumber: "QR-0005", workflow: { version: "1.5.0" } }), "legacy_full");
  assert.equal(migrationClassFor({ caseNumber: "QR-0025", workflow: { version: "2.4.0" } }), "current");
  assert.equal(migrationClassFor({ caseNumber: "QR-0025", workflow: { version: "2.4.2" } }), "current");
});

test("reader-ready stage is review-before-brief and requires both deterministic reader files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-reader-ready-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await fs.writeFile(path.join(root, "work", "participant-guide.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.json"), "{}\n");
  await fs.writeFile(path.join(root, "output", "deep-read.md"), "reader\n");
  await fs.writeFile(path.join(root, "output", "evidence-book.md"), "archive\n");
  assert.deepEqual(await stageArtifactErrors(root, "reader_ready"), []);
  assert.equal(await fs.stat(path.join(root, "output", "brief.json")).then(() => true, () => false), false);
});

test("reader-reviewed stage accepts the latest completed review round instead of requiring round 1", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-reader-reviewed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "work", "reviews", "2.4.0", "reader-first", "round-02"), { recursive: true });
  await fs.mkdir(path.join(root, "work", "reviews", "2.4.0", "participant-guide"), { recursive: true });
  await fs.writeFile(path.join(root, "work", "reviews", "2.4.0", "reader-first", "round-02", "consensus.json"), "{}\n");
  await fs.writeFile(path.join(root, "work", "reviews", "2.4.0", "participant-guide", "review.json"), "{}\n");
  assert.deepEqual(await stageArtifactErrors(root, "reader_reviewed"), []);
});

test("case selector resolves the public QR-NNNN interface without private cases", async (t) => {
  const casesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-selector-"));
  t.after(() => fs.rm(casesRoot, { recursive: true, force: true }));
  const { caseDir } = await fixture(casesRoot, { number: "QR-0017", workflow: "2.3.0" });
  assert.equal(await resolveMigrationCase("QR-0017", { casesRoot }), caseDir);
  await assert.rejects(resolveMigrationCase("QR-0099", { casesRoot }), /找不到案例编号/u);
});

test("prepare archives once and resumes without rewriting the ledger", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.3.0" });
  const first = await prepareMigrationCase(caseDir, { enforceActive: false });
  const ledgerPath = path.join(caseDir, "work", "migration-v2.4.json");
  const before = await fs.readFile(ledgerPath, "utf8");
  const second = await prepareMigrationCase(caseDir, { enforceActive: false });
  const after = await fs.readFile(ledgerPath, "utf8");
  assert.equal(first.ledger.stage, "archived");
  assert.equal(second.ledger.stage, "archived");
  assert.equal(after, before);
  assert.deepEqual(migrationV24ContractErrors(second.ledger), []);
  assert.equal(await fs.readFile(path.join(caseDir, "legacy", "workflow-2.3.0", "migration-v24-snapshot", "output", "deep-read.md"), "utf8"), "reader baseline\n");
});

test("batch preparation isolates one failure and keeps the valid case", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const valid = await fixture(root, { number: "QR-0005", workflow: "1.5.0" });
  const invalid = await fixture(root, { number: "QR-0006", workflow: "1.5.0", corruptHash: true });
  const results = await prepareMigrationCases([invalid.caseDir, valid.caseDir], { enforceActive: false });
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.equal(await fs.stat(path.join(valid.caseDir, "work", "migration-v2.4.json")).then(() => true), true);
});

test("ledger stages cannot skip ahead and immutable changes prevent progress", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-stage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.3.0" });
  await prepareMigrationCase(caseDir, { enforceActive: false });
  await assert.rejects(() => advanceMigrationLedger(caseDir, "evidence_reviewed"), /不能从 archived 跳到 evidence_reviewed/u);
  await fs.appendFile(path.join(caseDir, "work", "evidence.jsonl"), "{\"id\":\"E0002\"}\n");
  await assert.rejects(() => advanceMigrationLedger(caseDir, "evidence_ready"), /复用 segments\/evidence.*发生变化/u);
});

test("migration activation never includes a frozen case", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../config/pipeline.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(config.migration.activeCases));
  assert.ok(Array.isArray(config.migration.frozenCases));
  assert.deepEqual(config.migration.activeCases.filter(id => config.migration.frozenCases.includes(id)), []);
});

test("legacy migration may replace derived evidence while source remains fixed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-legacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0005", workflow: "1.5.0" });
  await prepareMigrationCase(caseDir, { enforceActive: false });
  await fs.appendFile(path.join(caseDir, "work", "evidence.jsonl"), "{\"id\":\"E0002\"}\n");
  const ledger = await advanceMigrationLedger(caseDir, "evidence_ready");
  assert.equal(ledger.stage, "evidence_ready");
  await assert.rejects(() => advanceMigrationLedger(caseDir, "archived"), /回退/u);
  await fs.appendFile(path.join(caseDir, "input", "source.srt"), "changed");
  await assert.rejects(() => advanceMigrationLedger(caseDir, "evidence_reviewed"), /case.json 不一致/u);
});

test("reusable pilots may repair evidence but cannot rebuild segments", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-reusable-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0011", workflow: "2.2.0" });
  await prepareMigrationCase(caseDir, { enforceActive: false });
  await fs.appendFile(path.join(caseDir, "work", "evidence.jsonl"), "{\"id\":\"E0002\"}\n");
  const evidenceReady = await advanceMigrationLedger(caseDir, "evidence_ready");
  assert.equal(evidenceReady.stage, "evidence_ready");
  await fs.appendFile(path.join(caseDir, "work", "segments.jsonl"), "{\"id\":\"S0002\"}\n");
  await assert.rejects(() => advanceMigrationLedger(caseDir, "evidence_reviewed"), /复用 segments 在迁移期间发生变化/u);
});

test("archive tampering is detected and human review is never archived", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-archive-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.3.0" });
  const humanPath = path.join(caseDir, "work", "human-review.json");
  await fs.writeFile(humanPath, "{\"ownedBy\":\"user\"}\n");
  const prepared = await prepareMigrationCase(caseDir, { enforceActive: false });
  assert.equal(await fs.readFile(humanPath, "utf8"), "{\"ownedBy\":\"user\"}\n");
  assert.equal(await fs.stat(path.join(caseDir, ...prepared.ledger.archive.path.split("/"), "work", "human-review.json")).then(() => true, () => false), false);
  await fs.appendFile(path.join(caseDir, ...prepared.ledger.archive.path.split("/"), "output", "deep-read.md"), "tampered");
  await assert.rejects(() => prepareMigrationCase(caseDir, { enforceActive: false }), /已被篡改/u);
});

test("target version keys cannot be permuted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-target-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.3.0" });
  const { ledger } = await prepareMigrationCase(caseDir, { enforceActive: false });
  const invalid = structuredClone(ledger);
  [invalid.targetVersions.prompt, invalid.targetVersions.template] = [invalid.targetVersions.template, invalid.targetVersions.prompt];
  assert.match(migrationV24ContractErrors(invalid).join(" "), /目标版本/u);
});

test("stale partial archives are replaced deterministically", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-partial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.3.0" });
  const partial = path.join(caseDir, "legacy", "workflow-2.3.0", "migration-v24-snapshot.partial");
  await fs.mkdir(partial, { recursive: true });
  await fs.writeFile(path.join(partial, "stale.txt"), "stale");
  const prepared = await prepareMigrationCase(caseDir, { enforceActive: false });
  const archive = path.join(caseDir, ...prepared.ledger.archive.path.split("/"));
  assert.equal(await fs.stat(path.join(archive, "stale.txt")).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(archive, "archive-manifest.json")).then(() => true), true);
});

test("an existing legacy directory without a migration manifest is never overwritten", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-collision-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.3.0" });
  const collision = path.join(caseDir, "legacy", "workflow-2.3.0", "migration-v24-snapshot");
  await fs.mkdir(collision, { recursive: true });
  await fs.writeFile(path.join(collision, "user-owned.txt"), "keep");
  await assert.rejects(() => prepareMigrationCase(caseDir, { enforceActive: false }), /已存在但没有可验证清单/u);
  assert.equal(await fs.readFile(path.join(collision, "user-owned.txt"), "utf8"), "keep");
});

test("a case labelled current must contain a complete 2.4 delivery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-current-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0017", workflow: "2.4.0" });
  const manifestPath = path.join(caseDir, "case.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.workflow.promptVersion = "3.4.0";
  manifest.workflow.templateVersion = "1.4.2";
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(() => prepareMigrationCase(caseDir), /标记为当前版本但交付不完整/u);
  assert.equal(await fs.stat(path.join(caseDir, "work", "migration-v2.4.json")).then(() => true, () => false), false);
});

test("an incomplete 2.4.2 case is current-but-incomplete rather than a new migration candidate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v242-incomplete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0004", workflow: "2.4.2" });
  const manifestPath = path.join(caseDir, "case.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.workflow.promptVersion = "3.4.2";
  manifest.workflow.templateVersion = "1.4.4";
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assert.rejects(() => prepareMigrationCase(caseDir, { enforceActive: false }), /当前版本但交付不完整.*Context Upgrade/u);
  assert.equal(await fs.stat(path.join(caseDir, "work", "migration-v2.4.json")).then(() => true, () => false), false);
});

test("a complete 2.4.2 case is current while its historical 2.4.0 migration ledger remains valid", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v242-current-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { caseDir } = await fixture(root, { number: "QR-0004", workflow: "1.5.0" });
  const prepared = await prepareMigrationCase(caseDir, { enforceActive: false });
  assert.deepEqual(prepared.ledger.targetVersions, TARGET_VERSIONS);
  await completeV242Delivery(caseDir);
  const current = await prepareMigrationCase(caseDir, { enforceActive: false });
  assert.equal(current.status, "current");
  const historicalLedger = JSON.parse(await fs.readFile(path.join(caseDir, "work", "migration-v2.4.json"), "utf8"));
  assert.deepEqual(migrationV24ContractErrors(historicalLedger), []);
  assert.deepEqual(historicalLedger.targetVersions, TARGET_VERSIONS);
});

test("legacy-b preparation skips completed 2.4.2 cases and prepares only the four remaining cases", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-v24-legacy-b-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixtures = [];
  for (const caseNumber of MIGRATION_BATCHES["legacy-b"]) fixtures.push(await fixture(root, { number: caseNumber, workflow: "1.5.0" }));
  for (const caseNumber of ["QR-0004", "QR-0009"]) {
    const found = fixtures.find((entry) => entry.manifest.caseNumber === caseNumber);
    await completeV242Delivery(found.caseDir);
  }
  const results = await prepareMigrationCases(fixtures.map((entry) => entry.caseDir), { enforceActive: false });
  const statuses = new Map(results.map((result) => [result.manifest.caseNumber, result.status]));
  assert.equal(statuses.get("QR-0004"), "current");
  assert.equal(statuses.get("QR-0009"), "current");
  for (const caseNumber of ["QR-0014", "QR-0019", "QR-0020", "QR-0021"]) assert.equal(statuses.get(caseNumber), "prepared");
});
