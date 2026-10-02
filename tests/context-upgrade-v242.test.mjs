import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  advanceContextUpgrade,
  CONTEXT_UPGRADE_BATCHES,
  CONTEXT_UPGRADE_CASES,
  CONTEXT_UPGRADE_STAGES,
  contextUpgradeLedgerErrors,
  prepareContextUpgrade,
} from "../scripts/context-upgrade-v242.mjs";

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fixture(root, { caseNumber = "QR-0017", workflow = "2.4.0" } = {}) {
  const id = `${caseNumber.toLowerCase()}-context-fixture`;
  const caseDir = path.join(root, id);
  await fs.mkdir(path.join(caseDir, "input"), { recursive: true });
  await fs.mkdir(path.join(caseDir, "work"), { recursive: true });
  await fs.mkdir(path.join(caseDir, "output"), { recursive: true });
  const source = "fixture subtitle\n";
  await fs.writeFile(path.join(caseDir, "input", "source.txt"), source, "utf8");
  await fs.writeFile(path.join(caseDir, "work", "source.normalized.jsonl"), "{\"id\":\"C1\"}\n", "utf8");
  await fs.writeFile(path.join(caseDir, "work", "segments.jsonl"), "{\"id\":\"S1\"}\n", "utf8");
  await fs.writeFile(path.join(caseDir, "work", "evidence.jsonl"), "{\"id\":\"E1\"}\n", "utf8");
  await fs.writeFile(path.join(caseDir, "work", "reader-map.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(caseDir, "work", "human-review.json"), "{\"owner\":true}\n", "utf8");
  await fs.writeFile(path.join(caseDir, "case.json"), `${JSON.stringify({
    id,
    caseNumber,
    source: { path: "input/source.txt", sha256: sha(source) },
    workflow: { version: workflow, promptVersion: "3.4.0", templateVersion: "1.4.2" },
  }, null, 2)}\n`, "utf8");
  return caseDir;
}

test("2.4.2 context upgrade covers all 25 cases without changing the first three batches", async () => {
  assert.equal(CONTEXT_UPGRADE_CASES.length, 25);
  assert.equal(new Set(CONTEXT_UPGRADE_CASES).size, 25);
  assert.deepEqual(CONTEXT_UPGRADE_BATCHES["batch-1"], ["QR-0002", "QR-0011", "QR-0013", "QR-0022", "QR-0023"]);
  assert.deepEqual(CONTEXT_UPGRADE_BATCHES["batch-2"], ["QR-0004", "QR-0005", "QR-0006", "QR-0008", "QR-0009"]);
  assert.deepEqual(CONTEXT_UPGRADE_BATCHES["batch-3"], ["QR-0010", "QR-0012", "QR-0016", "QR-0017", "QR-0025"]);
  assert.deepEqual(CONTEXT_UPGRADE_BATCHES["batch-4"], ["QR-0014", "QR-0019", "QR-0020", "QR-0021"]);
  assert.deepEqual(CONTEXT_UPGRADE_BATCHES["batch-5"], ["QR-0001", "QR-0003", "QR-0007", "QR-0015", "QR-0018", "QR-0024"]);
  assert.deepEqual([...CONTEXT_UPGRADE_CASES].sort(), Array.from({ length: 25 }, (_, index) => `QR-${String(index + 1).padStart(4, "0")}`));

  const config = JSON.parse(await fs.readFile(new URL("../config/pipeline.json", import.meta.url), "utf8"));
  const schema = JSON.parse(await fs.readFile(new URL("../schemas/context-upgrade-v242.schema.json", import.meta.url), "utf8"));
  for (const [key, ids] of Object.entries(config.contextUpgrade.batches)) assert.deepEqual(ids, CONTEXT_UPGRADE_BATCHES[key]);
  assert.deepEqual([...config.contextUpgrade.allowlist].sort(), Object.values(config.contextUpgrade.batches).flat().sort());
  for (const id of config.contextUpgrade.allowlist) assert.ok(CONTEXT_UPGRADE_CASES.includes(id));
  assert.deepEqual([...schema.properties.caseNumber.enum].sort(), [...CONTEXT_UPGRADE_CASES].sort());
  assert.deepEqual(schema.properties.batchId.enum, Object.keys(CONTEXT_UPGRADE_BATCHES));
});

test("prepare is resumable, preserves human review and binds immutable hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-context-upgrade-"));
  try {
    const caseDir = await fixture(root);
    const beforeHuman = await fs.readFile(path.join(caseDir, "work", "human-review.json"), "utf8");
    const first = await prepareContextUpgrade(caseDir);
    assert.equal(first.status, "prepared");
    assert.equal(first.ledger.lastCompletedStage, "snapshotted");
    assert.deepEqual(first.ledger.completedStages, ["snapshotted"]);
    assert.deepEqual(contextUpgradeLedgerErrors(first.ledger), []);
    assert.equal(await fs.readFile(path.join(caseDir, "work", "human-review.json"), "utf8"), beforeHuman);

    const resumed = await prepareContextUpgrade(caseDir);
    assert.equal(resumed.status, "resumable");
    assert.equal(resumed.ledger.preparedAt, first.ledger.preparedAt);

    const advanced = await advanceContextUpgrade(caseDir, "researched");
    assert.equal(advanced.ledger.lastCompletedStage, "researched");
    await assert.rejects(advanceContextUpgrade(caseDir, "reader_bound"), /必须先完成 context_ready/u);

    await fs.writeFile(path.join(caseDir, "work", "evidence.jsonl"), "{\"id\":\"changed\"}\n", "utf8");
    await assert.rejects(prepareContextUpgrade(caseDir), /evidence\.jsonl.*发生变化/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("context upgrade rejects cases outside the approved set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-context-upgrade-outside-"));
  try {
    const caseDir = await fixture(root, { caseNumber: "QR-0026" });
    await assert.rejects(prepareContextUpgrade(caseDir), /不在.*白名单/u);
    assert.equal(CONTEXT_UPGRADE_STAGES.at(-1), "complete");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("newly approved cases require a completed 2.4 content baseline before context preparation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-context-upgrade-baseline-"));
  try {
    const caseDir = await fixture(root, { caseNumber: "QR-0024", workflow: "1.5.0" });
    await assert.rejects(prepareContextUpgrade(caseDir), /必须先完成 2\.4 内容迁移/u);
    const ledgerPath = path.join(caseDir, "work", "context-upgrade-v2.4.2.json");
    assert.equal(await fs.stat(ledgerPath).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
