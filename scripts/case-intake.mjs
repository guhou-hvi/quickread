import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  REPO_ROOT,
  readJson,
  sha256File,
  writeJson,
} from "./lib.mjs";

export const SUPPORTED_SOURCE_FORMATS = new Set(["srt", "vtt", "txt", "md"]);
export const RESERVED_INBOX_FILES = new Set(["readme.md"]);
export const CASE_DESCRIPTOR_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CASE_ID_PATTERN = /^qr-(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function assertDescriptor(descriptor) {
  if (!descriptor || !CASE_DESCRIPTOR_PATTERN.test(descriptor)) {
    throw new Error("案例描述必须是短横线分隔的小写 ASCII slug。");
  }
  if (/^qr-[0-9]{4}(?:-|$)/.test(descriptor)) throw new Error("案例编号由系统自动分配，请不要手工指定。");
}

function sourceFormat(sourcePath) {
  const extension = path.extname(sourcePath).slice(1).toLowerCase();
  if (!SUPPORTED_SOURCE_FORMATS.has(extension)) {
    throw new Error(`不支持的来源格式：${extension || "无扩展名"}`);
  }
  return extension;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function findDuplicateSource(casesRoot, sourceHash) {
  if (!(await pathExists(casesRoot))) return null;
  const entries = await fs.readdir(casesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const manifest = await readJson(path.join(casesRoot, entry.name, "case.json"));
      if (manifest.source?.sha256 === sourceHash) return manifest.id ?? entry.name;
    } catch {
      // A malformed case is handled by repository validation, not intake deduplication.
    }
  }
  return null;
}

export async function allocateCaseIdentity(descriptor, casesRoot) {
  assertDescriptor(descriptor);
  let maximum = 0;
  if (await pathExists(casesRoot)) {
    const entries = await fs.readdir(casesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const match = entry.name.match(CASE_ID_PATTERN);
      if (!match) continue;
      maximum = Math.max(maximum, Number(match[1]));
      if (match[2] === descriptor) throw new Error(`案例描述已存在：${descriptor}`);
    }
  }
  const sequence = maximum + 1;
  if (sequence > 9999) throw new Error("案例编号已超过四位上限。");
  const digits = String(sequence).padStart(4, "0");
  return { id: `qr-${digits}-${descriptor}`, caseNumber: `QR-${digits}`, sequence };
}

export async function resolveInboxSource(inboxRoot, sourceArgument) {
  await fs.mkdir(inboxRoot, { recursive: true });
  if (!sourceArgument) {
    const candidates = (await fs.readdir(inboxRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile()
        && !RESERVED_INBOX_FILES.has(entry.name.toLowerCase())
        && SUPPORTED_SOURCE_FORMATS.has(path.extname(entry.name).slice(1).toLowerCase()))
      .map((entry) => entry.name)
      .sort((first, second) => first.localeCompare(second, "zh-CN"));
    if (!candidates.length) throw new Error("inbox 中没有可处理的 SRT、VTT、TXT 或 MD 文件。");
    if (candidates.length > 1) {
      throw new Error(`inbox 中有多个来源文件，请明确指定其中一个：${candidates.join("、")}`);
    }
    sourceArgument = candidates[0];
  }

  if (RESERVED_INBOX_FILES.has(path.basename(sourceArgument).toLowerCase())) {
    throw new Error(`inbox 保留文件不能作为来源：${path.basename(sourceArgument)}`);
  }

  const resolvedInbox = await fs.realpath(inboxRoot);
  const candidatePath = path.resolve(inboxRoot, sourceArgument);
  let resolvedSource;
  try {
    resolvedSource = await fs.realpath(candidatePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`inbox 来源文件不存在：${sourceArgument}`);
    throw error;
  }
  const relative = path.relative(resolvedInbox, resolvedSource);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("投件来源必须是 inbox 内的文件。");
  }
  const stats = await fs.stat(resolvedSource);
  if (!stats.isFile()) throw new Error("投件来源必须是普通文件。");
  sourceFormat(resolvedSource);
  return resolvedSource;
}

export async function createCaseFromSource({
  slug,
  sourcePath,
  removeSource = false,
  sourceUrl = null,
  repoRoot = REPO_ROOT,
  casesRoot = path.join(repoRoot, "cases"),
}) {
  const descriptor = slug;
  const { id, caseNumber } = await allocateCaseIdentity(descriptor, casesRoot);
  const resolvedSource = path.resolve(sourcePath);
  const stats = await fs.stat(resolvedSource);
  if (!stats.isFile()) throw new Error("来源必须是普通文件。");
  const format = sourceFormat(resolvedSource);
  const caseDir = path.join(casesRoot, id);
  if (await pathExists(caseDir)) throw new Error(`案例目录已存在：${caseDir}`);

  const sourceHash = await sha256File(resolvedSource);
  const duplicateCase = await findDuplicateSource(casesRoot, sourceHash);
  if (duplicateCase) throw new Error(`来源文件已归档到案例：${duplicateCase}`);

  const [config, profiles] = await Promise.all([
    readJson(path.join(repoRoot, "config", "pipeline.json")),
    readJson(path.join(repoRoot, "config", "profiles.json")),
  ]);
  const stagingRoot = path.join(casesRoot, ".staging");
  const stagingDir = path.join(stagingRoot, `${id}-${crypto.randomUUID()}`);
  const sourceName = path.basename(resolvedSource);
  const stagedSource = path.join(stagingDir, "input", sourceName);
  let committed = false;
  try {
    for (const name of ["input", "legacy", "work", "output"]) {
      await fs.mkdir(path.join(stagingDir, name), { recursive: true });
    }
    await fs.copyFile(resolvedSource, stagedSource);
    const copiedHash = await sha256File(stagedSource);
    if (copiedHash !== sourceHash) throw new Error("来源复制后的 SHA-256 不一致，已中止归档。");
    await writeJson(path.join(stagingDir, "case.json"), {
      $schema: "../../schemas/case.schema.json",
      schemaVersion: "1.2.0",
      id,
      caseNumber,
      title: path.basename(sourceName, path.extname(sourceName)),
      shortTitle: path.basename(sourceName, path.extname(sourceName)),
      sourceType: ["srt", "vtt"].includes(format) ? "video" : "article",
      sourceLanguage: "und",
      outputLanguage: "zh-CN",
      participants: [],
      aliases: [],
      tags: [],
      source: {
        path: path.posix.join("input", sourceName),
        format,
        url: sourceUrl,
        urlStatus: sourceUrl ? "verified" : "missing",
        publisher: null,
        publishedAt: null,
        duration: null,
        sha256: sourceHash,
      },
      profile: {
        primary: null,
        lenses: [],
        selection: "pending",
        confidence: 0,
        version: profiles.version,
      },
      workflow: {
        version: config.workflowVersion,
        promptVersion: config.promptVersion,
        templateVersion: config.templateVersion,
      },
    });
    await fs.rename(stagingDir, caseDir);
    committed = true;
  } finally {
    if (!committed) await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rmdir(stagingRoot).catch((error) => {
      if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error.code)) throw error;
    });
  }

  const warnings = [];
  if (removeSource) {
    try {
      await fs.unlink(resolvedSource);
    } catch (error) {
      warnings.push(`案例已创建，但无法从 inbox 移除原件：${error.message}`);
    }
  }
  return { id, caseNumber, caseDir, sourcePath: path.join(caseDir, "input", sourceName), sourceHash, warnings };
}
