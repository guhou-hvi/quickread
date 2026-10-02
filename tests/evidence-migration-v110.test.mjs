import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEvidenceMigrationBaseline } from "../scripts/evidence-check.mjs";
import { evidenceMigrationContractErrors, sha256Value } from "../scripts/review-contract.mjs";

const caseId = "qr-0099-migration-fixture";

function claim(id, statement) {
  return { id, statement, supportSpans: [{ sourceIds: ["C000001"] }] };
}

function fullMigration(oldClaims, newClaims) {
  return {
    schemaVersion: "1.0.0",
    caseId,
    fromWorkflow: "2.1.0",
    toWorkflow: "2.2.0",
    inputHashes: {
      oldEvidence: sha256Value(oldClaims),
      newEvidence: sha256Value(newClaims),
    },
    entries: oldClaims.map((oldClaim, index) => ({
      id: `EM${String(index + 1).padStart(4, "0")}`,
      status: "preserved",
      oldEvidenceRefs: [oldClaim.id],
      newEvidenceRefs: [oldClaim.id],
      rationale: "Preserved by the full workflow migration.",
    })),
  };
}

function repairFixture() {
  const oldClaims = [claim("E0001", "old claim"), claim("E0002", "untouched")];
  const newClaims = [claim("E0001", "rewritten claim"), claim("E0002", "untouched"), claim("E0003", "split claim")];
  const migration = {
    schemaVersion: "1.1.0",
    migrationKind: "semantic_repair",
    caseId,
    reviewPolicyVersion: "2.3.2",
    repairRound: 3,
    baselinePath: "work/reviews/2.3.2/evidence-repair/round-03/evidence-before.jsonl",
    inputHashes: {
      oldEvidence: sha256Value(oldClaims),
      newEvidence: sha256Value(newClaims),
    },
    entries: [{
      id: "EM0001",
      status: "split",
      oldEvidenceRefs: ["E0001"],
      newEvidenceRefs: ["E0001", "E0003"],
      rationale: "Split one compound claim during a semantic repair.",
    }],
  };
  return { oldClaims, newClaims, migration };
}

test("legacy evidence migration 1.0 retains full-coverage behavior", () => {
  const oldClaims = [claim("E0001", "unchanged")];
  const newClaims = structuredClone(oldClaims);
  assert.deepEqual(evidenceMigrationContractErrors(fullMigration(oldClaims, newClaims), {
    caseId,
    oldClaims,
    newClaims,
  }), []);
});

test("semantic repair migration 1.1 accepts a registered local split", () => {
  const value = repairFixture();
  assert.deepEqual(evidenceMigrationContractErrors(value.migration, {
    caseId,
    oldClaims: value.oldClaims,
    newClaims: value.newClaims,
  }), []);
});

test("semantic repair migration 1.1 rejects a stale evidence hash", () => {
  const value = repairFixture();
  value.migration.inputHashes.oldEvidence = "0".repeat(64);
  const errors = evidenceMigrationContractErrors(value.migration, {
    caseId,
    oldClaims: value.oldClaims,
    newClaims: value.newClaims,
  });
  assert(errors.some((error) => error.includes("inputHashes.oldEvidence 已过期")));
});

test("semantic repair migration 1.1 rejects an unregistered claim change", () => {
  const value = repairFixture();
  value.newClaims[1].statement = "silently changed";
  value.migration.inputHashes.newEvidence = sha256Value(value.newClaims);
  const errors = evidenceMigrationContractErrors(value.migration, {
    caseId,
    oldClaims: value.oldClaims,
    newClaims: value.newClaims,
  });
  assert(errors.some((error) => error.includes("未登记内容变更 claim：E0002")));
});

test("semantic repair baseline loader accepts an existing case-local baseline", async (t) => {
  const caseDir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-migration-"));
  t.after(() => fs.rm(caseDir, { recursive: true, force: true }));
  const baselinePath = "work/reviews/2.3.2/evidence-repair/round-03/evidence-before.jsonl";
  const baselineFile = path.join(caseDir, ...baselinePath.split("/"));
  await fs.mkdir(path.dirname(baselineFile), { recursive: true });
  await fs.writeFile(baselineFile, `${JSON.stringify(claim("E0001", "before"))}\n`, "utf8");
  const result = await loadEvidenceMigrationBaseline(caseDir, { schemaVersion: "1.1.0", baselinePath });
  assert.deepEqual(result.errors, []);
  assert.equal(result.oldClaims[0].id, "E0001");
});

test("semantic repair baseline loader rejects missing and escaping paths", async (t) => {
  const caseDir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-migration-"));
  t.after(() => fs.rm(caseDir, { recursive: true, force: true }));
  const missing = await loadEvidenceMigrationBaseline(caseDir, {
    schemaVersion: "1.1.0",
    baselinePath: "work/reviews/missing.jsonl",
  });
  assert(missing.errors.some((error) => error.includes("不存在")));
  const escaping = await loadEvidenceMigrationBaseline(caseDir, {
    schemaVersion: "1.1.0",
    baselinePath: "../outside.jsonl",
  });
  assert(escaping.errors.some((error) => error.includes("不含 ..")));
});
