import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertQuoteOnlyEvidenceChange,
  fixClaimMechanicalQuotes,
  quoteIgnoredEvidenceHash,
  repairMissingSupportQuotes,
  synchronizeEvidenceMigration,
} from "../scripts/claim-mechanical-fix.mjs";
import { readJson, readJsonLines } from "../scripts/lib.mjs";
import { sha256Value } from "../scripts/review-contract.mjs";

const CASE_ID = "qr-0017-fixture";
const REVIEW_ROUND = 16;
const PRIMARY_CLAIM_REVIEW_HASH = "b".repeat(64);

function repair(evidence, normalizedUnits, options = {}) {
  return repairMissingSupportQuotes(evidence, normalizedUnits, {
    primaryClaimReviewHash: PRIMARY_CLAIM_REVIEW_HASH,
    reviewRound: REVIEW_ROUND,
    ...options,
  });
}

function claimReviewFixture() {
  return {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    role: "claim_auditor",
    reviewerId: "fixture-auditor",
    reviewRound: REVIEW_ROUND,
    inputHashes: { segments: "a".repeat(64), evidence: "b".repeat(64) },
    entries: [],
  };
}

function fixture() {
  const normalizedUnits = [
    { id: "C000001", text: "第一段已有引文" },
    { id: "C000002", text: "第二段第一句" },
    { id: "C000003", text: "第二段第二句" },
    { id: "C000004", text: "第三段第一句" },
    { id: "C000005", text: "第三段第二句" },
  ];
  const evidence = [
    {
      schemaVersion: "2.0.0",
      id: "E0007",
      caseId: CASE_ID,
      statement: "第一条语义保持不变。",
      provenance: "source_fact",
      importance: "high",
      claimRole: "fact",
      speaker: { name: null, status: "unknown", confidence: 0 },
      themeId: "T001",
      supportSpans: [
        { segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01–00:00:02", quote: "第一段已有引文" },
        { segmentId: "S0002", sourceIds: ["C000002", "C000003"], locator: "00:00:03–00:00:05" },
      ],
    },
    {
      schemaVersion: "2.0.0",
      id: "E0008",
      caseId: CASE_ID,
      statement: "第二条包含多个支持区段。",
      provenance: "speaker_view",
      importance: "medium",
      claimRole: "opinion",
      speaker: { name: null, status: "unknown", confidence: 0 },
      themeId: "T002",
      supportSpans: [
        { segmentId: "S0001", sourceIds: ["C000001"], locator: "00:00:01–00:00:02", quote: "第一段已有引文" },
        { segmentId: "S0002", sourceIds: ["C000002"], locator: "00:00:03–00:00:04" },
        { segmentId: "S0003", sourceIds: ["C000004", "C000005"], locator: "00:00:06–00:00:08" },
      ],
    },
  ];
  return { normalizedUnits, evidence };
}

test("fills QR0017-style missing quotes across multiple support spans and preserves existing quotes", () => {
  const { normalizedUnits, evidence } = fixture();
  const before = structuredClone(evidence);
  const result = repair(evidence, normalizedUnits);

  assert.deepEqual(evidence, before, "pure function must not mutate input evidence");
  assert.equal(result.evidence[0].supportSpans[0].quote, "第一段已有引文");
  assert.equal(result.evidence[0].supportSpans[1].quote, "第二段第一句 第二段第二句");
  assert.equal(result.evidence[1].supportSpans[1].quote, "第二段第一句");
  assert.equal(result.evidence[1].supportSpans[2].quote, "第三段第一句 第三段第二句");
  assert.deepEqual(result.report.entries, [
    {
      evidenceRef: "E0007",
      findingCode: "missing_support_quote",
      status: "mechanically_resolved",
      supportSpanIndexes: [1],
    },
    {
      evidenceRef: "E0008",
      findingCode: "missing_support_quote",
      status: "mechanically_resolved",
      supportSpanIndexes: [1, 2],
    },
  ]);
  assert.equal(result.changes.length, 3);
  assert.equal(result.report.workflowVersion, "2.2.1");
  assert.equal(result.report.role, "claim_mechanical_fix");
  assert.equal(result.report.reviewRound, REVIEW_ROUND);
  assert.equal(result.report.inputHashes.primaryClaimReview, PRIMARY_CLAIM_REVIEW_HASH);
  assert.notEqual(result.report.inputHashes.beforeEvidence, result.report.inputHashes.afterEvidence);
  assert.equal(result.report.inputHashes.beforeQuoteIgnoredEvidence, result.report.inputHashes.afterQuoteIgnoredEvidence);
  assert.equal(Object.hasOwn(result.report.inputHashes, "beforeEvidenceMigration"), false);
  assert.equal(quoteIgnoredEvidenceHash(evidence), quoteIgnoredEvidenceHash(result.evidence));
});

test("is idempotent after every missing quote has been filled", () => {
  const { normalizedUnits, evidence } = fixture();
  const first = repair(evidence, normalizedUnits);
  const second = repair(first.evidence, normalizedUnits);

  assert.deepEqual(second.evidence, first.evidence);
  assert.equal(second.changes.length, 0);
  assert.deepEqual(second.report.entries, []);
  assert.equal(second.report.inputHashes.beforeEvidence, second.report.inputHashes.afterEvidence);
  assert.equal(second.report.inputHashes.beforeQuoteIgnoredEvidence, second.report.inputHashes.afterQuoteIgnoredEvidence);
});

test("rejects non-contiguous, unknown, and empty normalized source support without partial repair", () => {
  const nonContiguous = fixture();
  nonContiguous.evidence[0].supportSpans[1].sourceIds = ["C000002", "C000004"];
  assert.throws(
    () => repair(nonContiguous.evidence, nonContiguous.normalizedUnits),
    /不连续/u,
  );
  assert.equal(Object.hasOwn(nonContiguous.evidence[0].supportSpans[1], "quote"), false);

  const unknown = fixture();
  unknown.evidence[0].supportSpans[1].sourceIds = ["C999999"];
  assert.throws(() => repair(unknown.evidence, unknown.normalizedUnits), /未知 normalized source unit/u);
  assert.equal(Object.hasOwn(unknown.evidence[0].supportSpans[1], "quote"), false);

  const empty = fixture();
  empty.normalizedUnits[2].text = "   ";
  assert.throws(() => repair(empty.evidence, empty.normalizedUnits), /空文本 normalized source unit/u);
  assert.equal(Object.hasOwn(empty.evidence[0].supportSpans[1], "quote"), false);
});

test("quote-only guard rejects semantic changes and rewrites of existing quotes", () => {
  const { normalizedUnits, evidence } = fixture();
  const result = repair(evidence, normalizedUnits);
  const semanticChange = structuredClone(result.evidence);
  semanticChange[0].statement = "被篡改的语义字段。";
  assert.throws(
    () => assertQuoteOnlyEvidenceChange(evidence, semanticChange, normalizedUnits),
    /quote 之外的语义字段变化/u,
  );

  const existingQuoteChange = structuredClone(result.evidence);
  existingQuoteChange[0].supportSpans[0].quote = "改写既有引文";
  assert.throws(
    () => assertQuoteOnlyEvidenceChange(evidence, existingQuoteChange, normalizedUnits),
    /已存在，拒绝改写/u,
  );
});

test("callable case API writes evidence and a hash-bound report without package registration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-claim-mechanical-fix-"));
  const caseDir = path.join(root, CASE_ID);
  const workDir = path.join(caseDir, "work");
  try {
    const { normalizedUnits, evidence } = fixture();
    const claimReview = claimReviewFixture();
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "source.normalized.jsonl"), `${normalizedUnits.map(JSON.stringify).join("\n")}\n`, "utf8");
    await fs.writeFile(path.join(workDir, "evidence.jsonl"), `${evidence.map(JSON.stringify).join("\n")}\n`, "utf8");
    await fs.writeFile(path.join(workDir, "claim-review.json"), JSON.stringify(claimReview), "utf8");

    const result = await fixClaimMechanicalQuotes(caseDir);
    const writtenEvidence = await readJsonLines(path.join(workDir, "evidence.jsonl"));
    const writtenReport = await readJson(path.join(workDir, "claim-mechanical-fix.json"));
    assert.deepEqual(writtenEvidence, result.evidence);
    assert.deepEqual(writtenReport, result.report);
    assert.equal(result.changes.length, 3);
    assert.equal(writtenReport.inputHashes.primaryClaimReview, sha256Value(claimReview));
    assert.equal(Object.hasOwn(writtenReport.inputHashes, "beforeEvidenceMigration"), false);

    const idempotent = await fixClaimMechanicalQuotes(caseDir, { dryRun: true });
    assert.deepEqual(idempotent.report.entries, []);
    assert.equal(idempotent.written, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("migration synchronization is pure, hash-bound, and records full before/after migration hashes", () => {
  const { normalizedUnits, evidence } = fixture();
  const migration = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    inputHashes: { oldEvidence: "a".repeat(64), newEvidence: sha256Value(evidence) },
    entries: [],
  };
  const beforeMigration = structuredClone(migration);
  const result = repair(evidence, normalizedUnits, { evidenceMigration: migration });

  assert.deepEqual(migration, beforeMigration);
  assert.equal(result.evidenceMigration.inputHashes.newEvidence, result.report.inputHashes.afterEvidence);
  assert.equal(result.report.inputHashes.beforeEvidenceMigration, sha256Value(migration));
  assert.equal(result.report.inputHashes.afterEvidenceMigration, sha256Value(result.evidenceMigration));
  assert.notEqual(result.report.inputHashes.beforeEvidenceMigration, result.report.inputHashes.afterEvidenceMigration);
  assert.throws(
    () => synchronizeEvidenceMigration(
      { ...migration, inputHashes: { ...migration.inputHashes, newEvidence: "0".repeat(64) } },
      sha256Value(evidence),
      "1".repeat(64),
    ),
    /不等于修复前 evidence hash/u,
  );
});

test("case API dry-run writes nothing, then synchronizes an existing evidence migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-claim-mechanical-migration-"));
  const caseDir = path.join(root, CASE_ID);
  const workDir = path.join(caseDir, "work");
  const normalizedPath = path.join(workDir, "source.normalized.jsonl");
  const evidencePath = path.join(workDir, "evidence.jsonl");
  const migrationPath = path.join(workDir, "evidence-migration.json");
  const claimReviewPath = path.join(workDir, "claim-review.json");
  const reportPath = path.join(workDir, "claim-mechanical-fix.json");
  try {
    const { normalizedUnits, evidence } = fixture();
    const claimReview = claimReviewFixture();
    const migration = {
      schemaVersion: "1.0.0",
      caseId: CASE_ID,
      inputHashes: { oldEvidence: "a".repeat(64), newEvidence: sha256Value(evidence) },
      entries: [],
    };
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(normalizedPath, `${normalizedUnits.map(JSON.stringify).join("\n")}\n`, "utf8");
    await fs.writeFile(evidencePath, `${evidence.map(JSON.stringify).join("\n")}\n`, "utf8");
    await fs.writeFile(migrationPath, `${JSON.stringify(migration, null, 2)}\n`, "utf8");
    await fs.writeFile(claimReviewPath, JSON.stringify(claimReview), "utf8");
    const beforeEvidenceBytes = await fs.readFile(evidencePath, "utf8");
    const beforeMigrationBytes = await fs.readFile(migrationPath, "utf8");

    const dryRun = await fixClaimMechanicalQuotes(caseDir, { dryRun: true });
    assert.equal(dryRun.written, false);
    assert.equal(dryRun.report.inputHashes.beforeEvidenceMigration, sha256Value(migration));
    assert.equal(await fs.readFile(evidencePath, "utf8"), beforeEvidenceBytes);
    assert.equal(await fs.readFile(migrationPath, "utf8"), beforeMigrationBytes);
    await assert.rejects(fs.access(reportPath));

    const applied = await fixClaimMechanicalQuotes(caseDir);
    const writtenEvidence = await readJsonLines(evidencePath);
    const writtenMigration = await readJson(migrationPath);
    const writtenReport = await readJson(reportPath);
    assert.equal(writtenMigration.inputHashes.newEvidence, sha256Value(writtenEvidence));
    assert.equal(writtenMigration.inputHashes.newEvidence, applied.report.inputHashes.afterEvidence);
    assert.equal(writtenReport.inputHashes.beforeEvidenceMigration, sha256Value(migration));
    assert.equal(writtenReport.inputHashes.afterEvidenceMigration, sha256Value(writtenMigration));
    assert.equal(writtenReport.inputHashes.primaryClaimReview, sha256Value(claimReview));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("case API rejects a stale migration binding before writing any file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-claim-mechanical-stale-"));
  const caseDir = path.join(root, CASE_ID);
  const workDir = path.join(caseDir, "work");
  const evidencePath = path.join(workDir, "evidence.jsonl");
  const migrationPath = path.join(workDir, "evidence-migration.json");
  const reportPath = path.join(workDir, "claim-mechanical-fix.json");
  try {
    const { normalizedUnits, evidence } = fixture();
    const staleMigration = {
      schemaVersion: "1.0.0",
      caseId: CASE_ID,
      inputHashes: { oldEvidence: "a".repeat(64), newEvidence: "0".repeat(64) },
      entries: [],
    };
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "source.normalized.jsonl"), `${normalizedUnits.map(JSON.stringify).join("\n")}\n`, "utf8");
    await fs.writeFile(evidencePath, `${evidence.map(JSON.stringify).join("\n")}\n`, "utf8");
    await fs.writeFile(migrationPath, `${JSON.stringify(staleMigration, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(workDir, "claim-review.json"), JSON.stringify(claimReviewFixture()), "utf8");
    const beforeEvidenceBytes = await fs.readFile(evidencePath, "utf8");
    const beforeMigrationBytes = await fs.readFile(migrationPath, "utf8");

    await assert.rejects(fixClaimMechanicalQuotes(caseDir), /不等于修复前 evidence hash/u);
    assert.equal(await fs.readFile(evidencePath, "utf8"), beforeEvidenceBytes);
    assert.equal(await fs.readFile(migrationPath, "utf8"), beforeMigrationBytes);
    await assert.rejects(fs.access(reportPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
