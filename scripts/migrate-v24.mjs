import fs from "node:fs/promises";
import path from "node:path";

import {
  isMain,
  listCaseDirs,
  loadCase,
  readJson,
  resolveCaseDir,
  sha256File,
  writeJson,
} from "./lib.mjs";
import {
  CONTEXT_UPGRADE_TARGETS,
  contextUpgradeLedgerErrors,
} from "./context-upgrade-v242.mjs";

export const TARGET_VERSIONS = Object.freeze({
  workflow: "2.4.0",
  prompt: "3.4.0",
  template: "1.4.2",
  deepReadSchema: "2.3.0",
  briefSchema: "1.5.0",
});

const CURRENT_DELIVERY_TARGETS = Object.freeze({
  [TARGET_VERSIONS.workflow]: TARGET_VERSIONS,
  [CONTEXT_UPGRADE_TARGETS.workflow]: CONTEXT_UPGRADE_TARGETS,
});

export const MIGRATION_BATCHES = Object.freeze({
  pilots: Object.freeze(["QR-0002", "QR-0011", "QR-0013", "QR-0022", "QR-0023"]),
  "legacy-a": Object.freeze(["QR-0005", "QR-0006", "QR-0008", "QR-0010", "QR-0012", "QR-0016"]),
  "legacy-b": Object.freeze(["QR-0004", "QR-0009", "QR-0014", "QR-0019", "QR-0020", "QR-0021"]),
  "legacy-c": Object.freeze(["QR-0001", "QR-0003", "QR-0007", "QR-0015", "QR-0018", "QR-0024"]),
});

export const MIGRATION_STAGES = Object.freeze([
  "archived",
  "evidence_ready",
  "evidence_reviewed",
  "reader_ready",
  "reader_reviewed",
  "delivered",
]);

const ARCHIVE_RELATIVE_FILES = Object.freeze([
  "case.json",
  "work/coverage.json",
  "work/segments.jsonl",
  "work/evidence.jsonl",
  "work/research.json",
  "work/theme-map.json",
  "work/claim-bundles.json",
  "work/reader-map.json",
  "work/quality-report.json",
  "work/render-report.json",
  "output/deep-read.json",
  "output/deep-read.md",
  "output/evidence-book.md",
  "output/brief.json",
  "output/quickread.html",
]);

const DELIVERY_FILES = Object.freeze([
  "output/deep-read.json",
  "output/deep-read.md",
  "output/evidence-book.md",
  "output/brief.json",
  "output/quickread.html",
  "output/quickread.png",
  "output/quickread-mobile.png",
  "work/participant-guide.json",
  "work/quality-report.json",
  "work/render-report.json",
]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertInside(parent, candidate, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出案例目录。`);
}

function batchForCase(caseNumber) {
  if (caseNumber === "QR-0017") return "qr0017";
  for (const [batchId, caseNumbers] of Object.entries(MIGRATION_BATCHES)) {
    if (caseNumbers.includes(caseNumber)) return batchId;
  }
  return null;
}

export function migrationClassFor(manifest) {
  if (Object.hasOwn(CURRENT_DELIVERY_TARGETS, manifest.workflow?.version)) return "current";
  if (manifest.caseNumber === "QR-0017" && manifest.workflow?.version === "2.3.0") return "light_reader_upgrade";
  if (MIGRATION_BATCHES.pilots.includes(manifest.caseNumber) && manifest.workflow?.version === "2.2.0") return "reusable_evidence";
  if (manifest.workflow?.version === "1.5.0" && batchForCase(manifest.caseNumber)?.startsWith("legacy-")) return "legacy_full";
  return "unsupported";
}

export async function migrationSnapshotHashes(caseDir) {
  const { manifest, sourcePath } = await loadCase(caseDir);
  const source = await sha256File(sourcePath);
  if (source !== manifest.source.sha256) throw new Error(`${manifest.id} 原始来源哈希与 case.json 不一致。`);
  const optionalHash = async (relative) => {
    const filePath = path.join(caseDir, ...relative.split("/"));
    return (await exists(filePath)) ? sha256File(filePath) : null;
  };
  return {
    source,
    normalizedSource: await optionalHash("work/source.normalized.jsonl"),
    segments: await optionalHash("work/segments.jsonl"),
    evidence: await optionalHash("work/evidence.jsonl"),
  };
}

export async function currentDeliveryErrors(caseDir, manifest) {
  const errors = [];
  const targets = CURRENT_DELIVERY_TARGETS[manifest.workflow?.version];
  if (!targets) return [`workflow 版本 ${manifest.workflow?.version ?? "<missing>"} 不是受支持的当前交付版本`];
  if (manifest.workflow?.promptVersion !== targets.prompt) errors.push(`prompt 版本不是 ${targets.prompt}`);
  if (manifest.workflow?.templateVersion !== targets.template) errors.push(`template 版本不是 ${targets.template}`);
  for (const relative of DELIVERY_FILES) {
    if (!(await exists(path.join(caseDir, ...relative.split("/"))))) errors.push(`缺少 ${relative}`);
  }
  if (targets.workflow === CONTEXT_UPGRADE_TARGETS.workflow) {
    if (!(await exists(path.join(caseDir, "work", "context-guide.json")))) errors.push("缺少 work/context-guide.json");
    try {
      const ledger = await readJson(path.join(caseDir, "work", "context-upgrade-v2.4.2.json"));
      const ledgerErrors = contextUpgradeLedgerErrors(ledger);
      if (ledger.caseId !== manifest.id) ledgerErrors.push("Context Upgrade 账本 caseId 与案例不一致");
      if (ledger.lastCompletedStage !== "complete") ledgerErrors.push("Context Upgrade 尚未完成");
      if (ledgerErrors.length) errors.push(...ledgerErrors);
    } catch {
      errors.push("缺少或无法读取完整的 Context Upgrade 2.4.2 账本");
    }
  }
  try {
    const deepRead = await readJson(path.join(caseDir, "output", "deep-read.json"));
    if (deepRead.schemaVersion !== targets.deepReadSchema || deepRead.workflowVersion !== targets.workflow) errors.push("deep-read 版本不完整");
  } catch { /* missing file already reported */ }
  try {
    const brief = await readJson(path.join(caseDir, "output", "brief.json"));
    if (brief.schemaVersion !== targets.briefSchema || brief.workflowVersion !== targets.workflow || brief.templateVersion !== targets.template) errors.push("brief 版本不完整");
  } catch { /* missing file already reported */ }
  try {
    const quality = await readJson(path.join(caseDir, "work", "quality-report.json"));
    if (quality.status !== "pass") errors.push("quality-report 未通过");
  } catch { /* missing file already reported */ }
  return errors;
}

async function verifyArchive(archiveDir, manifest) {
  const archiveManifestPath = path.join(archiveDir, "archive-manifest.json");
  const retained = await readJson(archiveManifestPath);
  if (retained.caseId !== manifest.id || retained.workflowVersion !== manifest.workflow.version) throw new Error(`${manifest.id} 的既有 2.4 迁移归档与当前案例不一致。`);
  for (const file of retained.files ?? []) {
    const archived = path.join(archiveDir, ...file.path.split("/"));
    assertInside(archiveDir, archived, "迁移归档校验文件");
    if (!(await exists(archived))) throw new Error(`迁移归档缺少 ${file.path}。`);
    if (await sha256File(archived) !== file.sha256) throw new Error(`迁移归档 ${file.path} 已被篡改。`);
    if (Number.isInteger(file.size) && (await fs.stat(archived)).size !== file.size) throw new Error(`迁移归档 ${file.path} 大小不一致。`);
  }
  return archiveManifestPath;
}

async function archiveExistingBaseline(caseDir, manifest) {
  const workflowRootRelative = `legacy/workflow-${manifest.workflow.version}`;
  const workflowRoot = path.join(caseDir, ...workflowRootRelative.split("/"));
  const legacyRootManifest = path.join(workflowRoot, "archive-manifest.json");
  if (await exists(legacyRootManifest)) {
    await verifyArchive(workflowRoot, manifest);
    return { archiveRelative: workflowRootRelative, archiveManifestPath: legacyRootManifest };
  }
  const archiveRelative = `${workflowRootRelative}/migration-v24-snapshot`;
  const archiveDir = path.join(caseDir, ...archiveRelative.split("/"));
  const archiveManifestPath = path.join(archiveDir, "archive-manifest.json");
  assertInside(caseDir, archiveDir, "迁移归档路径");
  if (await exists(archiveManifestPath)) {
    await verifyArchive(archiveDir, manifest);
    return { archiveRelative, archiveManifestPath };
  }
  const partialDir = `${archiveDir}.partial`;
  assertInside(caseDir, partialDir, "迁移临时归档路径");
  if (await exists(partialDir)) await fs.rm(partialDir, { recursive: true, force: true });
  await fs.mkdir(partialDir, { recursive: true });
  const files = [];
  for (const relative of ARCHIVE_RELATIVE_FILES) {
    const source = path.join(caseDir, ...relative.split("/"));
    if (!(await exists(source))) continue;
    const destination = path.join(partialDir, ...relative.split("/"));
    assertInside(partialDir, destination, "迁移归档文件");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    const [sourceHash, destinationHash, stat] = await Promise.all([sha256File(source), sha256File(destination), fs.stat(destination)]);
    if (sourceHash !== destinationHash) throw new Error(`归档复制校验失败：${relative}`);
    files.push({ path: relative, sha256: destinationHash, size: stat.size });
  }
  const archiveManifest = { schemaVersion: "1.0.0", caseId: manifest.id, caseNumber: manifest.caseNumber, workflowVersion: manifest.workflow.version, archivedAt: new Date().toISOString(), files };
  await writeJson(path.join(partialDir, "archive-manifest.json"), archiveManifest);
  if (await exists(archiveDir)) throw new Error(`${archiveRelative} 已存在但没有可验证清单，拒绝覆盖。`);
  await fs.rename(partialDir, archiveDir);
  await verifyArchive(archiveDir, manifest);
  return { archiveRelative, archiveManifestPath };
}

function targetVersionsValid(target = {}) {
  return Object.entries(TARGET_VERSIONS).every(([key, value]) => target[key] === value);
}

function completedPrefixValid(ledger) {
  const completed = (ledger.completedStages ?? []).map((entry) => entry.stage);
  const lastIndex = MIGRATION_STAGES.indexOf(ledger.lastCompletedStage);
  return JSON.stringify(completed) === JSON.stringify(MIGRATION_STAGES.slice(0, lastIndex + 1));
}

export function migrationV24ContractErrors(ledger) {
  const errors = [];
  if (ledger?.schemaVersion !== "1.0.0") errors.push("migration-v2.4 schemaVersion 必须为 1.0.0。");
  if (!/^qr-[0-9]{4}-/u.test(ledger?.caseId ?? "")) errors.push("migration-v2.4 caseId 非法。");
  if (!/^QR-[0-9]{4}$/u.test(ledger?.caseNumber ?? "")) errors.push("migration-v2.4 caseNumber 非法。");
  if (!targetVersionsValid(ledger?.targetVersions)) errors.push("migration-v2.4 目标版本不完整。");
  if (!["light_reader_upgrade", "reusable_evidence", "legacy_full"].includes(ledger?.migrationClass)) errors.push("migration-v2.4 migrationClass 非法。");
  if (!["qr0017", ...Object.keys(MIGRATION_BATCHES)].includes(ledger?.batchId)) errors.push("migration-v2.4 batchId 非法。");
  if (![...MIGRATION_STAGES, "failed"].includes(ledger?.stage)) errors.push("migration-v2.4 stage 非法。");
  if (!MIGRATION_STAGES.includes(ledger?.lastCompletedStage)) errors.push("migration-v2.4 lastCompletedStage 非法。");
  if (!/^[a-f0-9]{64}$/u.test(ledger?.initialHashes?.source ?? "")) errors.push("migration-v2.4 缺少来源哈希。");
  if (!completedPrefixValid(ledger ?? {})) errors.push("migration-v2.4 completedStages 必须是连续有序前缀。");
  if (!String(ledger?.nextAction ?? "").trim()) errors.push("migration-v2.4 缺少 nextAction。");
  return errors;
}

async function assertActive(manifest, enforceActive) {
  if (!enforceActive) return;
  const config = await readJson(new URL("../config/pipeline.json", import.meta.url));
  if (!(config.migration?.activeCases ?? []).includes(manifest.caseNumber)) throw new Error(`${manifest.caseNumber} 尚未在 config.pipeline.migration.activeCases 解冻。`);
}

function initialNextAction(migrationClass) {
  if (migrationClass === "light_reader_upgrade") return "验证保留审核并接受 migrated_reviewed_history evidence baseline。";
  if (migrationClass === "reusable_evidence") return "运行 evidence-check，并完成一次首次完整 Claim Auditor 后接受 baseline。";
  return "运行 profile/segment，并由 Agent 从来源重新抽取原子 evidence；旧 1.5 evidence 仅作参考。";
}

export async function prepareMigrationCase(caseDir, { enforceActive = true } = {}) {
  const { manifest } = await loadCase(caseDir);
  const migrationClass = migrationClassFor(manifest);
  if (migrationClass === "current") {
    const errors = await currentDeliveryErrors(caseDir, manifest);
    if (errors.length) throw new Error(`${manifest.id} 标记为当前版本但交付不完整：${errors.join("；")}`);
    return { status: "current", manifest, ledger: null };
  }
  if (migrationClass === "unsupported") throw new Error(`${manifest.id} 不属于已批准的 2.4 迁移集合或来源版本不符合预期。`);
  await assertActive(manifest, enforceActive);
  const ledgerPath = path.join(caseDir, "work", "migration-v2.4.json");
  const currentHashes = await migrationSnapshotHashes(caseDir);
  if (await exists(ledgerPath)) {
    const ledger = await readJson(ledgerPath);
    const errors = migrationV24ContractErrors(ledger);
    if (errors.length) throw new Error(errors.join("\n"));
    if (ledger.caseId !== manifest.id || ledger.initialHashes.source !== currentHashes.source) throw new Error(`${manifest.id} 的迁移账本与当前原始来源不一致。`);
    if (ledger.migrationClass === "light_reader_upgrade" && (ledger.initialHashes.segments !== currentHashes.segments || ledger.initialHashes.evidence !== currentHashes.evidence)) throw new Error(`${manifest.id} 的复用 segments/evidence 在迁移期间发生变化。`);
    if (ledger.migrationClass === "reusable_evidence" && ledger.initialHashes.segments !== currentHashes.segments) throw new Error(`${manifest.id} 的复用 segments 在迁移期间发生变化。`);
    const archiveDir = path.join(caseDir, ...ledger.archive.path.split("/"));
    const archiveManifestPath = await verifyArchive(archiveDir, manifest);
    if (await sha256File(archiveManifestPath) !== ledger.archive.manifestSha256) throw new Error(`${manifest.id} 归档清单哈希已变化。`);
    return { status: ledger.stage === "failed" ? "resumable" : "prepared", manifest, ledger };
  }
  const { archiveRelative, archiveManifestPath } = await archiveExistingBaseline(caseDir, manifest);
  const now = new Date().toISOString();
  const initialReviews = migrationClass === "light_reader_upgrade" ? ["external_citation", "reader_advocate", "render"] : ["claim_auditor", "source_scout", "fidelity", "reader_advocate", "external_citation", "render"];
  const ledger = {
    $schema: "../../../schemas/migration-v24.schema.json",
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    caseNumber: manifest.caseNumber,
    fromWorkflowVersion: manifest.workflow.version,
    targetVersions: { ...TARGET_VERSIONS },
    migrationClass,
    batchId: batchForCase(manifest.caseNumber),
    stage: "archived",
    lastCompletedStage: "archived",
    createdAt: now,
    updatedAt: now,
    initialHashes: currentHashes,
    archive: { path: archiveRelative, manifestSha256: await sha256File(archiveManifestPath) },
    completedStages: [{ stage: "archived", completedAt: now, snapshotHashes: currentHashes }],
    pendingReviews: initialReviews,
    nextAction: initialNextAction(migrationClass),
    errors: [],
  };
  const errors = migrationV24ContractErrors(ledger);
  if (errors.length) throw new Error(errors.join("\n"));
  await writeJson(ledgerPath, ledger);
  return { status: "prepared", manifest, ledger };
}

export async function stageArtifactErrors(caseDir, stage) {
  const required = {
    evidence_ready: ["work/source.normalized.jsonl", "work/segments.jsonl", "work/evidence.jsonl"],
    evidence_reviewed: ["work/evidence-baseline.json", "work/evidence-baseline.jsonl"],
    reader_ready: ["work/participant-guide.json", "output/deep-read.json", "output/deep-read.md", "output/evidence-book.md"],
    reader_reviewed: ["work/reviews/2.4.0/participant-guide/review.json"],
    delivered: DELIVERY_FILES,
  }[stage] ?? [];
  const errors = [];
  for (const relative of required) if (!(await exists(path.join(caseDir, ...relative.split("/"))))) errors.push(`缺少 ${relative}`);
  if (stage === "reader_reviewed") {
    const reviewRoot = path.join(caseDir, "work", "reviews", "2.4.0", "reader-first");
    let hasCompletedRound = false;
    try {
      const entries = await fs.readdir(reviewRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^round-\d+$/u.test(entry.name)) continue;
        if (await exists(path.join(reviewRoot, entry.name, "consensus.json"))) {
          hasCompletedRound = true;
          break;
        }
      }
    } catch {
      // The stable error below is more useful than the raw directory failure.
    }
    if (!hasCompletedRound) errors.push("缺少已完成的 work/reviews/2.4.0/reader-first/round-NN/consensus.json");
  }
  return errors;
}

export async function advanceMigrationLedger(caseDir, stage, { pendingReviews = [], errors = [], nextAction = "继续下一迁移阶段。" } = {}) {
  if (!MIGRATION_STAGES.includes(stage) && stage !== "failed") throw new Error(`未知迁移阶段：${stage}`);
  const ledgerPath = path.join(caseDir, "work", "migration-v2.4.json");
  const ledger = await readJson(ledgerPath);
  const currentHashes = await migrationSnapshotHashes(caseDir);
  if (ledger.initialHashes.source !== currentHashes.source) throw new Error(`${ledger.caseId} 原始来源在迁移期间发生变化。`);
  if (ledger.migrationClass === "light_reader_upgrade" && (ledger.initialHashes.segments !== currentHashes.segments || ledger.initialHashes.evidence !== currentHashes.evidence)) throw new Error(`${ledger.caseId} 的复用 segments/evidence 在迁移期间发生变化。`);
  if (ledger.migrationClass === "reusable_evidence" && ledger.initialHashes.segments !== currentHashes.segments) throw new Error(`${ledger.caseId} 的复用 segments 在迁移期间发生变化。`);
  const next = structuredClone(ledger);
  const now = new Date().toISOString();
  if (stage !== "failed") {
    const previousIndex = MIGRATION_STAGES.indexOf(next.lastCompletedStage);
    const nextIndex = MIGRATION_STAGES.indexOf(stage);
    if (nextIndex <= previousIndex) {
      if (nextIndex === previousIndex && next.stage === stage) return next;
      throw new Error(`不能从 ${next.lastCompletedStage} 回退到 ${stage}。`);
    }
    if (nextIndex !== previousIndex + 1) throw new Error(`不能从 ${next.lastCompletedStage} 跳到 ${stage}。`);
    const artifactErrors = await stageArtifactErrors(caseDir, stage);
    if (artifactErrors.length) throw new Error(`${stage} 阶段产物不完整：${artifactErrors.join("；")}`);
    next.completedStages.push({ stage, completedAt: now, snapshotHashes: currentHashes });
    next.lastCompletedStage = stage;
  }
  next.stage = stage;
  next.updatedAt = now;
  next.pendingReviews = [...new Set(pendingReviews)].sort();
  next.nextAction = nextAction;
  next.errors = errors;
  const contractErrors = migrationV24ContractErrors(next);
  if (contractErrors.length) throw new Error(contractErrors.join("\n"));
  await writeJson(ledgerPath, next);
  return next;
}

export async function prepareMigrationCases(caseDirs, options = {}) {
  const results = [];
  for (const caseDir of caseDirs) {
    try {
      const result = await prepareMigrationCase(caseDir, options);
      results.push({ caseDir, ok: true, ...result });
    } catch (error) {
      results.push({ caseDir, ok: false, error: error.message });
    }
  }
  return results;
}

export async function migrationStatusRows() {
  const rows = [];
  for (const caseDir of await listCaseDirs()) {
    const { manifest } = await loadCase(caseDir);
    let migrationClass = migrationClassFor(manifest);
    const ledgerPath = path.join(caseDir, "work", "migration-v2.4.json");
    const ledger = (await exists(ledgerPath)) ? await readJson(ledgerPath) : null;
    let stage = ledger?.stage ?? "not_started";
    let nextAction = ledger?.nextAction ?? "";
    if (migrationClass === "current") {
      const errors = await currentDeliveryErrors(caseDir, manifest);
      if (errors.length) {
        migrationClass = "incomplete_current";
        stage = "failed";
        nextAction = errors.join("；");
      } else {
        stage = "delivered";
        nextAction = manifest.workflow?.version === CONTEXT_UPGRADE_TARGETS.workflow
          ? "2.4.2 交付完整，无需运行 2.4 内容迁移。"
          : (nextAction || "2.4.0 内容基线已交付；可按需运行 2.4.2 Context Upgrade。");
      }
    }
    rows.push({ caseNumber: manifest.caseNumber, caseId: manifest.id, workflow: manifest.workflow?.version, migrationClass, batchId: batchForCase(manifest.caseNumber), stage, nextAction });
  }
  return rows.sort((a, b) => a.caseNumber.localeCompare(b.caseNumber));
}

function parseCli(argv) {
  const options = { status: false, caseArgument: null, batchId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--status") options.status = true;
    else if (value === "--case") options.caseArgument = argv[++index];
    else if (value === "--batch") options.batchId = argv[++index];
    else throw new Error(`未知参数：${value}`);
  }
  const modes = [options.status, Boolean(options.caseArgument), Boolean(options.batchId)].filter(Boolean).length;
  if (modes !== 1) throw new Error("必须且只能指定 --status、--case 或 --batch。");
  if (options.batchId && !Object.hasOwn(MIGRATION_BATCHES, options.batchId)) throw new Error(`未知批次：${options.batchId}`);
  return options;
}

async function dirsForBatch(batchId) {
  const wanted = new Set(MIGRATION_BATCHES[batchId]);
  const selected = [];
  for (const caseDir of await listCaseDirs()) {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    if (wanted.has(manifest.caseNumber)) selected.push({ caseDir, caseNumber: manifest.caseNumber });
  }
  if (selected.length !== wanted.size) throw new Error(`${batchId} 批次案例不完整。`);
  return selected.sort((a, b) => a.caseNumber.localeCompare(b.caseNumber)).map((entry) => entry.caseDir);
}

export async function resolveMigrationCase(argument, { casesRoot } = {}) {
  if (!/^QR-[0-9]{4}$/u.test(argument ?? "")) return resolveCaseDir(argument);
  for (const caseDir of await listCaseDirs(casesRoot)) {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    if (manifest.caseNumber === argument) return caseDir;
  }
  throw new Error(`找不到案例编号：${argument}`);
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.status) console.table(await migrationStatusRows());
    else {
      const caseDirs = options.caseArgument ? [await resolveMigrationCase(options.caseArgument)] : await dirsForBatch(options.batchId);
      const results = await prepareMigrationCases(caseDirs);
      for (const result of results) {
        const name = result.manifest?.id ?? path.basename(result.caseDir);
        if (result.ok) console.log(`${name}: ${result.status}${result.ledger ? ` / ${result.ledger.stage} / ${result.ledger.nextAction}` : ""}`);
        else console.error(`${name}: FAILED / ${result.error}`);
      }
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
