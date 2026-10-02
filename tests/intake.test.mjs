import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allocateCaseIdentity, createCaseFromSource, resolveInboxSource } from "../scripts/case-intake.mjs";
import { readJson, sha256File } from "../scripts/lib.mjs";
import { validateCase } from "../scripts/validate-case.mjs";

async function withTempRepository(callback) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-intake-"));
  try {
    await fs.mkdir(path.join(repoRoot, "config"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "cases"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "inbox"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "config", "pipeline.json"), JSON.stringify({
      workflowVersion: "test-workflow",
      promptVersion: "test-prompt",
      templateVersion: "test-template",
    }), "utf8");
    await fs.writeFile(path.join(repoRoot, "config", "profiles.json"), JSON.stringify({ version: "1.1.0" }), "utf8");
    await callback({
      repoRoot,
      casesRoot: path.join(repoRoot, "cases"),
      inboxRoot: path.join(repoRoot, "inbox"),
    });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

test("inbox intake preserves bytes and filename, records current versions, then removes the drop", async () => {
  await withTempRepository(async ({ repoRoot, casesRoot, inboxRoot }) => {
    await fs.writeFile(path.join(inboxRoot, "README.md"), "# Inbox", "utf8");
    const sourceName = "原始 访谈.srt";
    const sourcePath = path.join(inboxRoot, sourceName);
    const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n原始字幕\n", "utf8");
    await fs.writeFile(sourcePath, bytes);
    const resolved = await resolveInboxSource(inboxRoot);
    assert.equal(resolved, sourcePath);
    await assert.rejects(resolveInboxSource(inboxRoot, "README.md"), /保留文件不能作为来源/);

    const result = await createCaseFromSource({
      slug: "new-interview",
      sourcePath: resolved,
      removeSource: true,
      repoRoot,
      casesRoot,
    });
    await assert.rejects(fs.access(sourcePath), /ENOENT/);
    assert.deepEqual(await fs.readFile(result.sourcePath), bytes);
    assert.equal(await sha256File(result.sourcePath), result.sourceHash);
    assert.deepEqual(result.warnings, []);

    const manifest = await readJson(path.join(result.caseDir, "case.json"));
    assert.equal(result.id, "qr-0001-new-interview");
    assert.equal(result.caseNumber, "QR-0001");
    assert.equal(manifest.id, result.id);
    assert.equal(manifest.caseNumber, result.caseNumber);
    assert.equal(manifest.schemaVersion, "1.2.0");
    assert.deepEqual(manifest.aliases, []);
    assert.deepEqual(manifest.tags, []);
    assert.equal(manifest.source.urlStatus, "missing");
    assert.equal(manifest.source.path, `input/${sourceName}`);
    assert.equal(manifest.source.sha256, result.sourceHash);
    assert.deepEqual(manifest.profile, {
      primary: null,
      lenses: [],
      selection: "pending",
      confidence: 0,
      version: "1.1.0",
    });
    assert.deepEqual(manifest.workflow, {
      version: "test-workflow",
      promptVersion: "test-prompt",
      templateVersion: "test-template",
    });
  });
});

test("inbox selection rejects ambiguity, unsupported files, and paths outside inbox", async () => {
  await withTempRepository(async ({ repoRoot, inboxRoot }) => {
    await fs.writeFile(path.join(inboxRoot, "first.srt"), "first", "utf8");
    await fs.writeFile(path.join(inboxRoot, "second.vtt"), "second", "utf8");
    await fs.writeFile(path.join(inboxRoot, "notes.pdf"), "pdf", "utf8");
    await assert.rejects(resolveInboxSource(inboxRoot), /多个来源文件/);
    await assert.rejects(resolveInboxSource(inboxRoot, "notes.pdf"), /不支持的来源格式/);

    const outside = path.join(repoRoot, "outside.srt");
    await fs.writeFile(outside, "outside", "utf8");
    await assert.rejects(resolveInboxSource(inboxRoot, outside), /必须是 inbox 内/);
  });
});

test("duplicate hashes and case conflicts leave inbox originals untouched", async () => {
  await withTempRepository(async ({ repoRoot, casesRoot, inboxRoot }) => {
    const first = path.join(inboxRoot, "first.srt");
    await fs.writeFile(first, "same source", "utf8");
    await createCaseFromSource({
      slug: "first-case",
      sourcePath: first,
      removeSource: true,
      repoRoot,
      casesRoot,
    });

    const duplicate = path.join(inboxRoot, "duplicate.srt");
    await fs.writeFile(duplicate, "same source", "utf8");
    await assert.rejects(
      createCaseFromSource({ slug: "duplicate-case", sourcePath: duplicate, removeSource: true, repoRoot, casesRoot }),
      /已归档到案例：qr-0001-first-case/,
    );
    assert.equal(await fs.readFile(duplicate, "utf8"), "same source");

    const conflict = path.join(inboxRoot, "conflict.srt");
    await fs.writeFile(conflict, "different source", "utf8");
    await assert.rejects(
      createCaseFromSource({ slug: "first-case", sourcePath: conflict, removeSource: true, repoRoot, casesRoot }),
      /案例描述已存在/,
    );
    assert.equal(await fs.readFile(conflict, "utf8"), "different source");
  });
});

test("case numbers are allocated sequentially and manual number prefixes are rejected", async () => {
  await withTempRepository(async ({ repoRoot, casesRoot, inboxRoot }) => {
    const first = path.join(inboxRoot, "first.srt");
    await fs.writeFile(first, "first", "utf8");
    await createCaseFromSource({ slug: "first-topic", sourcePath: first, repoRoot, casesRoot });
    assert.deepEqual(await allocateCaseIdentity("second-topic", casesRoot), {
      id: "qr-0002-second-topic",
      caseNumber: "QR-0002",
      sequence: 2,
    });
    await assert.rejects(allocateCaseIdentity("first-topic", casesRoot), /案例描述已存在/);
    await assert.rejects(allocateCaseIdentity("qr-0042-manual", casesRoot), /系统自动分配/);
  });
});

test("external-path initialization copies without deleting its source", async () => {
  await withTempRepository(async ({ repoRoot, casesRoot }) => {
    const external = path.join(repoRoot, "external.md");
    await fs.writeFile(external, "# Article\n\nBody", "utf8");
    const result = await createCaseFromSource({
      slug: "external-article",
      sourcePath: external,
      removeSource: false,
      repoRoot,
      casesRoot,
    });
    assert.equal(await fs.readFile(external, "utf8"), "# Article\n\nBody");
    assert.equal(await fs.readFile(result.sourcePath, "utf8"), "# Article\n\nBody");
  });
});

test("case validation reports a missing archived source instead of crashing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-missing-source-"));
  const caseDir = path.join(root, "missing-source");
  try {
    await fs.mkdir(caseDir, { recursive: true });
    await fs.writeFile(path.join(caseDir, "case.json"), JSON.stringify({
      id: "missing-source",
      sourceType: "video",
      source: {
        path: "input/missing.srt",
        format: "srt",
        sha256: "0".repeat(64),
      },
      workflow: {
        version: "1.4.0",
        promptVersion: "2.2.0",
        templateVersion: "1.4.0",
      },
    }), "utf8");
    const result = await validateCase(caseDir);
    assert.match(result.errors.join(" "), /来源文件不存在或无法读取/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
