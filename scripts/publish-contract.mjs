import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PUBLISH_MANIFEST_SCHEMA_VERSION = "1.0.0";
export const PUBLISH_STATE_SCHEMA_VERSION = "1.0.0";
export const GENERATION_ID_LENGTH = 20;

export const REQUIRED_PUBLISH_ARTIFACTS = Object.freeze([
  "output/deep-read.json",
  "output/deep-read.md",
  "output/evidence-book.md",
  "output/brief.json",
  "output/quickread.html",
  "output/quickread.png",
  "output/quickread-mobile.png",
]);

export const REQUIRED_PUBLISH_REPORTS = Object.freeze([
  "quality",
  "render",
  "validate",
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GENERATION_PATTERN = new RegExp(`^[a-f0-9]{${GENERATION_ID_LENGTH}}$`, "u");
const PASS = "pass";

export class PublishContractError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "PublishContractError";
    this.errors = [...errors];
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("不能哈希非有限数字。");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError(`不能哈希 ${typeof value} 值。`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Value(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function normalizedRelativePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function isSafeRelativePath(value) {
  const normalized = normalizedRelativePath(value);
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) return false;
  const parts = normalized.split("/");
  return !parts.some((part) => !part || part === "." || part === "..");
}

function resolveInside(root, relativePath, label) {
  if (!isSafeRelativePath(relativePath)) {
    throw new PublishContractError(`${label} 不是安全的相对路径：${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalizedRelativePath(relativePath).split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new PublishContractError(`${label} 越出发布目录：${relativePath}`);
  }
  return resolved;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function generationMaterial(manifest) {
  if (!isPlainObject(manifest)) throw new TypeError("publish manifest 必须为对象。");
  return {
    schemaVersion: manifest.schemaVersion,
    caseId: manifest.caseId,
    versions: manifest.versions,
    inputHashes: manifest.inputHashes,
    artifacts: manifest.artifacts,
    reports: manifest.reports,
    gates: {
      requiredArtifacts: manifest.gates?.requiredArtifacts,
      quality: manifest.gates?.quality,
      render: manifest.gates?.render,
      validate: manifest.gates?.validate,
      hashes: manifest.gates?.hashes,
      status: manifest.gates?.status,
    },
  };
}

export function computeGenerationId(manifest) {
  return sha256Value(generationMaterial(manifest)).slice(0, GENERATION_ID_LENGTH);
}

function hashMapErrors(value, label, { allowEmpty = false } = {}) {
  const errors = [];
  if (!isPlainObject(value)) return [`${label} 必须为对象。`];
  const entries = Object.entries(value);
  if (!allowEmpty && !entries.length) errors.push(`${label} 不得为空。`);
  for (const [key, hash] of entries) {
    if (!key.trim()) errors.push(`${label} 含空键。`);
    if (!HASH_PATTERN.test(hash)) errors.push(`${label}.${key} 必须为 64 位小写 SHA-256。`);
  }
  return errors;
}

export function publishManifestErrors(manifest, {
  requiredArtifacts = REQUIRED_PUBLISH_ARTIFACTS,
  requiredReports = REQUIRED_PUBLISH_REPORTS,
} = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) return ["publish manifest 必须为对象。"]; 
  if (manifest.schemaVersion !== PUBLISH_MANIFEST_SCHEMA_VERSION) errors.push(`publish manifest schemaVersion 必须为 ${PUBLISH_MANIFEST_SCHEMA_VERSION}。`);
  if (typeof manifest.caseId !== "string" || !manifest.caseId.trim()) errors.push("publish manifest 缺少 caseId。");
  if (typeof manifest.stageId !== "string" || !manifest.stageId.trim()) errors.push("publish manifest 缺少 stageId。");
  if (manifest.status !== "gated") errors.push("只有 status=gated 的 staging manifest 可以发布。");
  if (!isPlainObject(manifest.versions)) errors.push("publish manifest 缺少 versions。");
  else for (const key of ["workflow", "prompt", "template", "public"]) {
    if (typeof manifest.versions[key] !== "string" || !manifest.versions[key].trim()) errors.push(`publish manifest versions.${key} 缺失。`);
  }
  errors.push(...hashMapErrors(manifest.inputHashes, "publish manifest inputHashes"));

  if (!isPlainObject(manifest.artifacts)) errors.push("publish manifest artifacts 必须为对象。");
  else {
    for (const required of requiredArtifacts) {
      if (!Object.hasOwn(manifest.artifacts, required)) errors.push(`publish manifest 缺少必需产物：${required}。`);
    }
    for (const [relativePath, artifact] of Object.entries(manifest.artifacts)) {
      if (!isSafeRelativePath(relativePath)) errors.push(`publish artifact 路径非法：${relativePath}。`);
      if (!isPlainObject(artifact)) {
        errors.push(`publish artifact ${relativePath} 必须为对象。`);
        continue;
      }
      if (!HASH_PATTERN.test(artifact.sha256)) errors.push(`publish artifact ${relativePath} sha256 非法。`);
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) errors.push(`publish artifact ${relativePath} bytes 非法。`);
      if (typeof artifact.mediaType !== "string" || !artifact.mediaType.trim()) errors.push(`publish artifact ${relativePath} mediaType 缺失。`);
    }
  }

  if (!isPlainObject(manifest.reports)) errors.push("publish manifest reports 必须为对象。");
  else {
    for (const required of requiredReports) {
      if (!Object.hasOwn(manifest.reports, required)) errors.push(`publish manifest 缺少必需报告：${required}。`);
    }
    for (const [name, report] of Object.entries(manifest.reports)) {
      if (!isPlainObject(report)) {
        errors.push(`publish report ${name} 必须为对象。`);
        continue;
      }
      if (!isSafeRelativePath(report.path)) errors.push(`publish report ${name} path 非法。`);
      if (!HASH_PATTERN.test(report.sha256)) errors.push(`publish report ${name} sha256 非法。`);
      if (report.status !== PASS) errors.push(`publish report ${name} 未通过。`);
      if (!Number.isSafeInteger(report.errorCount) || report.errorCount !== 0) errors.push(`publish report ${name} errorCount 必须为 0。`);
    }
  }

  if (!isPlainObject(manifest.gates)) errors.push("publish manifest 缺少 gates。");
  else {
    if (manifest.gates.status !== PASS) errors.push("publish gates.status 必须为 pass。");
    for (const key of ["quality", "render", "validate", "hashes"]) {
      if (manifest.gates[key] !== PASS) errors.push(`publish gates.${key} 必须为 pass。`);
    }
    if (!Array.isArray(manifest.gates.requiredArtifacts)) errors.push("publish gates.requiredArtifacts 必须为数组。");
    else for (const required of requiredArtifacts) {
      if (!manifest.gates.requiredArtifacts.includes(required)) errors.push(`publish gates.requiredArtifacts 缺少 ${required}。`);
    }
  }

  if (!GENERATION_PATTERN.test(manifest.generationId ?? "")) errors.push(`publish generationId 必须为 ${GENERATION_ID_LENGTH} 位小写十六进制。`);
  else {
    try {
      const expected = computeGenerationId(manifest);
      if (manifest.generationId !== expected) errors.push(`publish generationId 已过期：期望 ${expected}。`);
    } catch (error) {
      errors.push(`无法计算 publish generationId：${error.message}`);
    }
  }
  return [...new Set(errors)];
}

export function publishStateErrors(state) {
  const errors = [];
  if (!isPlainObject(state)) return ["publish current state 必须为对象。"]; 
  if (state.schemaVersion !== PUBLISH_STATE_SCHEMA_VERSION) errors.push(`publish current state schemaVersion 必须为 ${PUBLISH_STATE_SCHEMA_VERSION}。`);
  if (typeof state.caseId !== "string" || !state.caseId.trim()) errors.push("publish current state 缺少 caseId。");
  if (!GENERATION_PATTERN.test(state.generationId ?? "")) errors.push("publish current state generationId 非法。");
  if (state.releasePath !== `releases/${state.generationId}`) errors.push("publish current state releasePath 必须指向对应的不可变 release。");
  if (!HASH_PATTERN.test(state.manifestSha256 ?? "")) errors.push("publish current state manifestSha256 非法。");
  if (typeof state.promotedAt !== "string" || Number.isNaN(Date.parse(state.promotedAt))) errors.push("publish current state promotedAt 非法。");
  errors.push(...hashMapErrors(state.inputHashes, "publish current state inputHashes"));
  if (state.supersedes !== null && state.supersedes !== undefined && !GENERATION_PATTERN.test(state.supersedes)) errors.push("publish current state supersedes 非法。");
  return [...new Set(errors)];
}

async function validateManifestFiles(root, manifest) {
  const errors = [];
  for (const [relativePath, expected] of Object.entries(manifest.artifacts ?? {})) {
    try {
      const actual = await sha256File(resolveInside(root, relativePath, `artifact ${relativePath}`));
      if (actual.sha256 !== expected.sha256) errors.push(`publish artifact hash 不一致：${relativePath}。`);
      if (actual.bytes !== expected.bytes) errors.push(`publish artifact bytes 不一致：${relativePath}。`);
    } catch (error) {
      errors.push(`无法校验 publish artifact ${relativePath}：${error.message}`);
    }
  }
  for (const [name, report] of Object.entries(manifest.reports ?? {})) {
    try {
      const actual = await sha256File(resolveInside(root, report.path, `report ${name}`));
      if (actual.sha256 !== report.sha256) errors.push(`publish report hash 不一致：${name}。`);
    } catch (error) {
      errors.push(`无法校验 publish report ${name}：${error.message}`);
    }
  }
  return errors;
}

export async function validateStagingManifest(stagingDir, options = {}) {
  const manifestPath = path.join(path.resolve(stagingDir), "manifest.json");
  let manifest;
  let manifestText;
  try {
    manifestText = await fs.readFile(manifestPath, "utf8");
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return { ok: false, manifest: null, manifestPath, generationId: null, manifestSha256: null, errors: [`无法读取 staging manifest：${error.message}`] };
  }
  const errors = publishManifestErrors(manifest, options);
  errors.push(...await validateManifestFiles(stagingDir, manifest));
  const manifestSha256 = crypto.createHash("sha256").update(manifestText, "utf8").digest("hex");
  return {
    ok: errors.length === 0,
    manifest,
    manifestPath,
    generationId: manifest.generationId ?? null,
    manifestSha256,
    errors: [...new Set(errors)],
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertDirectStagingChild(caseDir, stagingDir) {
  const stagingRoot = path.resolve(caseDir, "work", "publish", "staging");
  const resolved = path.resolve(stagingDir);
  if (path.dirname(resolved) !== stagingRoot) {
    throw new PublishContractError(`stagingDir 必须是 ${stagingRoot} 的直接子目录。`);
  }
}

export async function promoteStaging(caseDir, stagingDir, options = {}) {
  const resolvedCaseDir = path.resolve(caseDir);
  const resolvedStagingDir = path.resolve(stagingDir);
  assertDirectStagingChild(resolvedCaseDir, resolvedStagingDir);
  const validation = await validateStagingManifest(resolvedStagingDir, options);
  if (!validation.ok) throw new PublishContractError("staging manifest 未通过发布门禁。", validation.errors);
  if (validation.manifest.caseId !== path.basename(resolvedCaseDir)) {
    throw new PublishContractError("staging manifest.caseId 与案例目录不一致。");
  }

  const outputRoot = path.resolve(resolvedCaseDir, "output");
  const releaseRoot = path.join(outputRoot, "releases");
  const currentPath = path.join(outputRoot, "current.json");
  await fs.mkdir(releaseRoot, { recursive: true });
  const [stagingStat, releaseRootStat] = await Promise.all([fs.stat(resolvedStagingDir), fs.stat(releaseRoot)]);
  if (stagingStat.dev !== releaseRootStat.dev) {
    throw new PublishContractError("staging 与 releases 不在同一文件系统，拒绝非原子 promote。");
  }

  const releaseDir = path.join(releaseRoot, validation.generationId);
  if (await pathExists(releaseDir)) throw new PublishContractError(`不可变 release 已存在：${validation.generationId}。`);

  let previous = null;
  if (await pathExists(currentPath)) {
    try {
      previous = JSON.parse(await fs.readFile(currentPath, "utf8"));
      const stateErrors = publishStateErrors(previous);
      if (stateErrors.length) throw new PublishContractError("现有 current.json 非法，拒绝覆盖。", stateErrors);
      if (previous.caseId !== validation.manifest.caseId) throw new PublishContractError("现有 current.json caseId 不一致，拒绝覆盖。");
    } catch (error) {
      if (error instanceof PublishContractError) throw error;
      throw new PublishContractError(`无法读取现有 current.json：${error.message}`);
    }
  }

  await fs.rename(resolvedStagingDir, releaseDir);
  const state = {
    schemaVersion: PUBLISH_STATE_SCHEMA_VERSION,
    caseId: validation.manifest.caseId,
    generationId: validation.generationId,
    releasePath: `releases/${validation.generationId}`,
    manifestSha256: validation.manifestSha256,
    promotedAt: new Date().toISOString(),
    inputHashes: validation.manifest.inputHashes,
    supersedes: previous?.generationId ?? null,
  };
  await atomicWriteJson(currentPath, state);
  return { state, manifest: validation.manifest, releaseDir, currentPath };
}

export function compareInputHashes(publishedInputHashes, liveInputHashes) {
  const published = isPlainObject(publishedInputHashes) ? publishedInputHashes : {};
  const live = isPlainObject(liveInputHashes) ? liveInputHashes : {};
  const staleInputKeys = [...new Set([...Object.keys(published), ...Object.keys(live)])]
    .sort()
    .filter((key) => published[key] !== live[key]);
  return {
    stale: staleInputKeys.length > 0,
    staleInputKeys,
    missingInputKeys: Object.keys(published).filter((key) => !Object.hasOwn(live, key)).sort(),
    addedInputKeys: Object.keys(live).filter((key) => !Object.hasOwn(published, key)).sort(),
  };
}

export async function publishedCase(caseDir, { liveInputHashes = null, ...options } = {}) {
  const resolvedCaseDir = path.resolve(caseDir);
  const outputRoot = path.join(resolvedCaseDir, "output");
  const currentPath = path.join(outputRoot, "current.json");
  const errors = [];
  let state;
  try {
    state = JSON.parse(await fs.readFile(currentPath, "utf8"));
  } catch (error) {
    return { ok: false, state: null, manifest: null, releaseDir: null, artifacts: {}, errors: [`无法读取 current.json：${error.message}`], stale: null };
  }
  errors.push(...publishStateErrors(state));
  if (state.caseId !== path.basename(resolvedCaseDir)) errors.push("current.json caseId 与案例目录不一致。");

  let releaseDir = null;
  let manifest = null;
  if (!errors.length) {
    try {
      releaseDir = resolveInside(outputRoot, state.releasePath, "current releasePath");
      const manifestText = await fs.readFile(path.join(releaseDir, "manifest.json"), "utf8");
      const actualManifestHash = crypto.createHash("sha256").update(manifestText, "utf8").digest("hex");
      if (actualManifestHash !== state.manifestSha256) errors.push("current.json manifestSha256 与 release manifest 不一致。");
      manifest = JSON.parse(manifestText);
      errors.push(...publishManifestErrors(manifest, options));
      if (manifest.caseId !== state.caseId) errors.push("release manifest.caseId 与 current.json 不一致。");
      if (manifest.generationId !== state.generationId) errors.push("release manifest.generationId 与 current.json 不一致。");
      if (canonicalJson(manifest.inputHashes) !== canonicalJson(state.inputHashes)) errors.push("release manifest.inputHashes 与 current.json 不一致。");
      errors.push(...await validateManifestFiles(releaseDir, manifest));
    } catch (error) {
      errors.push(`无法校验 current release：${error.message}`);
    }
  }

  const artifacts = {};
  if (releaseDir && manifest) {
    for (const relativePath of Object.keys(manifest.artifacts ?? {})) {
      try {
        artifacts[relativePath] = resolveInside(releaseDir, relativePath, `artifact ${relativePath}`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  const stale = liveInputHashes === null ? null : compareInputHashes(state.inputHashes, liveInputHashes);
  return { ok: errors.length === 0, state, manifest, releaseDir, artifacts, errors: [...new Set(errors)], stale };
}
