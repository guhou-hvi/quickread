import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLISH_MANIFEST_SCHEMA_VERSION,
  PUBLISH_STATE_SCHEMA_VERSION,
  PublishContractError,
  REQUIRED_PUBLISH_ARTIFACTS,
  compareInputHashes,
  computeGenerationId,
  promoteStaging,
  publishedCase,
  publishManifestErrors,
  publishStateErrors,
  validateStagingManifest,
} from "../scripts/publish-contract.mjs";

const CASE_ID = "qr-9999-publish-contract";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mediaType(relativePath) {
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".md")) return "text/markdown";
  if (relativePath.endsWith(".html")) return "text/html";
  return "image/png";
}

async function writeTrackedFile(root, relativePath, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const filePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return { sha256: sha256(bytes), bytes: bytes.length, mediaType: mediaType(relativePath) };
}

async function makeStage(caseDir, {
  stageId = "stage-001",
  inputHashes = { case: HASH_A, source: HASH_B },
  artifactSuffix = "one",
} = {}) {
  const stageDir = path.join(caseDir, "work", "publish", "staging", stageId);
  await fs.mkdir(stageDir, { recursive: true });
  const artifacts = {};
  for (const relativePath of REQUIRED_PUBLISH_ARTIFACTS) {
    const value = relativePath.endsWith(".png")
      ? Buffer.from(`png:${relativePath}:${artifactSuffix}`, "utf8")
      : `${relativePath}:${artifactSuffix}\n`;
    artifacts[relativePath] = await writeTrackedFile(stageDir, relativePath, value);
  }

  const reports = {};
  for (const name of ["quality", "render", "validate"]) {
    const relativePath = `reports/${name}-report.json`;
    const report = `${JSON.stringify({ schemaVersion: "fixture", caseId: CASE_ID, status: "pass", errors: [] })}\n`;
    const tracked = await writeTrackedFile(stageDir, relativePath, report);
    reports[name] = { path: relativePath, sha256: tracked.sha256, status: "pass", errorCount: 0 };
  }

  const manifest = {
    schemaVersion: PUBLISH_MANIFEST_SCHEMA_VERSION,
    caseId: CASE_ID,
    stageId,
    generationId: "0".repeat(20),
    status: "gated",
    createdAt: "2026-08-29T00:00:00.000Z",
    gatedAt: "2026-08-29T00:01:00.000Z",
    supersedes: null,
    versions: {
      workflow: "2.2.1",
      prompt: "3.2.0",
      template: "1.4.0",
      public: "v0.1",
      qualitySchema: "2.2.0",
      renderSchema: "1.4.0",
    },
    inputHashes,
    artifacts,
    reports,
    gates: {
      status: "pass",
      quality: "pass",
      render: "pass",
      validate: "pass",
      hashes: "pass",
      requiredArtifacts: [...REQUIRED_PUBLISH_ARTIFACTS],
    },
  };
  manifest.generationId = computeGenerationId(manifest);
  await fs.writeFile(path.join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { stageDir, manifest };
}

async function withCase(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-publish-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const caseDir = path.join(root, CASE_ID);
  await fs.mkdir(caseDir, { recursive: true });
  return caseDir;
}

test("generationId is deterministic and excludes staging identity and timestamps", async (t) => {
  const caseDir = await withCase(t);
  const { manifest } = await makeStage(caseDir);
  const reordered = {
    ...structuredClone(manifest),
    stageId: "another-stage",
    createdAt: "2030-01-01T00:00:00.000Z",
    gatedAt: "2030-01-01T00:01:00.000Z",
    inputHashes: Object.fromEntries(Object.entries(manifest.inputHashes).reverse()),
    artifacts: Object.fromEntries(Object.entries(manifest.artifacts).reverse()),
    reports: Object.fromEntries(Object.entries(manifest.reports).reverse()),
  };
  assert.equal(computeGenerationId(reordered), manifest.generationId);
  reordered.inputHashes.source = HASH_A;
  assert.notEqual(computeGenerationId(reordered), manifest.generationId);
});

test("staging validation checks required outputs, passing reports, and exact bytes", async (t) => {
  const caseDir = await withCase(t);
  const { stageDir, manifest } = await makeStage(caseDir);
  const valid = await validateStagingManifest(stageDir);
  assert.equal(valid.ok, true, valid.errors.join("\n"));
  assert.deepEqual(publishManifestErrors(manifest), []);

  await fs.appendFile(path.join(stageDir, "output", "brief.json"), "tampered", "utf8");
  const tampered = await validateStagingManifest(stageDir);
  assert.equal(tampered.ok, false);
  assert.match(tampered.errors.join("\n"), /artifact hash 不一致：output\/brief\.json/u);

  const broken = structuredClone(manifest);
  delete broken.artifacts["output/quickread-mobile.png"];
  broken.reports.quality.status = "fail";
  broken.reports.quality.errorCount = 1;
  const errors = publishManifestErrors(broken).join("\n");
  assert.match(errors, /缺少必需产物：output\/quickread-mobile\.png/u);
  assert.match(errors, /publish report quality 未通过/u);
});

test("promotion renames a complete stage, commits current last, and publishedCase rechecks hashes", async (t) => {
  const caseDir = await withCase(t);
  const { stageDir, manifest } = await makeStage(caseDir);
  const promoted = await promoteStaging(caseDir, stageDir);

  await assert.rejects(fs.access(stageDir));
  assert.equal(promoted.state.generationId, manifest.generationId);
  assert.equal(promoted.state.releasePath, `releases/${manifest.generationId}`);
  assert.equal(promoted.state.supersedes, null);
  assert.deepEqual(publishStateErrors(promoted.state), []);

  const published = await publishedCase(caseDir, { liveInputHashes: manifest.inputHashes });
  assert.equal(published.ok, true, published.errors.join("\n"));
  assert.equal(published.stale.stale, false);
  assert.equal(published.artifacts["output/quickread-mobile.png"], path.join(promoted.releaseDir, "output", "quickread-mobile.png"));

  await fs.appendFile(path.join(promoted.releaseDir, "output", "quickread.html"), "tampered", "utf8");
  const corrupted = await publishedCase(caseDir);
  assert.equal(corrupted.ok, false);
  assert.match(corrupted.errors.join("\n"), /artifact hash 不一致：output\/quickread\.html/u);
});

test("a failed candidate leaves current byte-for-byte unchanged and remains staged", async (t) => {
  const caseDir = await withCase(t);
  const first = await makeStage(caseDir, { stageId: "stage-first", artifactSuffix: "first" });
  await promoteStaging(caseDir, first.stageDir);
  const currentPath = path.join(caseDir, "output", "current.json");
  const before = await fs.readFile(currentPath, "utf8");

  const second = await makeStage(caseDir, {
    stageId: "stage-second",
    artifactSuffix: "second",
    inputHashes: { case: HASH_A, source: HASH_A },
  });
  await fs.appendFile(path.join(second.stageDir, "reports", "quality-report.json"), "tampered", "utf8");

  await assert.rejects(
    promoteStaging(caseDir, second.stageDir),
    (error) => error instanceof PublishContractError && /未通过发布门禁/u.test(error.message),
  );
  assert.equal(await fs.readFile(currentPath, "utf8"), before);
  await fs.access(second.stageDir);
  const published = await publishedCase(caseDir);
  assert.equal(published.ok, true, published.errors.join("\n"));
  assert.equal(published.state.generationId, first.manifest.generationId);
});

test("stale comparison is deterministic for changed, missing, and newly-added inputs", async (t) => {
  const comparison = compareInputHashes(
    { case: HASH_A, source: HASH_A, evidence: HASH_B },
    { case: HASH_A, source: HASH_B, research: HASH_A },
  );
  assert.deepEqual(comparison, {
    stale: true,
    staleInputKeys: ["evidence", "research", "source"],
    missingInputKeys: ["evidence"],
    addedInputKeys: ["research"],
  });

  const caseDir = await withCase(t);
  const { stageDir, manifest } = await makeStage(caseDir);
  await promoteStaging(caseDir, stageDir);
  const published = await publishedCase(caseDir, {
    liveInputHashes: { ...manifest.inputHashes, source: HASH_A },
  });
  assert.equal(published.ok, true, published.errors.join("\n"));
  assert.deepEqual(published.stale.staleInputKeys, ["source"]);
});

test("publish schemas are valid JSON and advertise the runtime versions", async () => {
  const manifestSchema = JSON.parse(await fs.readFile(new URL("../schemas/publish-manifest.schema.json", import.meta.url), "utf8"));
  const stateSchema = JSON.parse(await fs.readFile(new URL("../schemas/publish-state.schema.json", import.meta.url), "utf8"));
  assert.equal(manifestSchema.properties.schemaVersion.const, PUBLISH_MANIFEST_SCHEMA_VERSION);
  assert.equal(stateSchema.properties.schemaVersion.const, PUBLISH_STATE_SCHEMA_VERSION);
  assert.deepEqual(manifestSchema.properties.reports.required, ["quality", "render", "validate"]);
});
