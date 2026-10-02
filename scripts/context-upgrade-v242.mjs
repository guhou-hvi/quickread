import fs from "node:fs/promises";
import path from "node:path";

import {
  isMain,
  listCaseDirs,
  loadCase,
  readJson,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
  writeJson,
} from "./lib.mjs";

export const CONTEXT_UPGRADE_BATCHES = Object.freeze({
  "batch-1": Object.freeze(["QR-0002", "QR-0011", "QR-0013", "QR-0022", "QR-0023"]),
  "batch-2": Object.freeze(["QR-0004", "QR-0005", "QR-0006", "QR-0008", "QR-0009"]),
  "batch-3": Object.freeze(["QR-0010", "QR-0012", "QR-0016", "QR-0017", "QR-0025"]),
  "batch-4": Object.freeze(["QR-0014", "QR-0019", "QR-0020", "QR-0021"]),
  "batch-5": Object.freeze(["QR-0001", "QR-0003", "QR-0007", "QR-0015", "QR-0018", "QR-0024"]),
});

export const CONTEXT_UPGRADE_CASES = Object.freeze(Object.values(CONTEXT_UPGRADE_BATCHES).flat());
export const CONTEXT_UPGRADE_STAGES = Object.freeze([
  "snapshotted",
  "researched",
  "context_ready",
  "reader_bound",
  "brief_bound",
  "reviewed",
  "rendered",
  "complete",
]);
export const CONTEXT_UPGRADE_TARGETS = Object.freeze({
  workflow: "2.4.2",
  prompt: "3.4.2",
  deepReadSchema: "2.5.0",
  briefSchema: "1.7.0",
  template: "1.4.4",
  reviewPolicy: "2.4.2",
});

const LEDGER_RELATIVE_PATH = "work/context-upgrade-v2.4.2.json";
const ELIGIBLE_SOURCE_WORKFLOWS = new Set(["2.4.0", "2.4.1", "2.4.2"]);
const SNAPSHOT_FILES = Object.freeze([
  "case.json",
  "work/research.json",
  "work/context-guide.json",
  "work/reader-map.json",
  "work/quality-report.json",
  "work/render-report.json",
  "output/deep-read.json",
  "output/deep-read.md",
  "output/evidence-book.md",
  "output/brief.json",
  "output/quickread.html",
]);
const IMMUTABLE_FILES = Object.freeze([
  "work/source.normalized.jsonl",
  "work/segments.jsonl",
  "work/evidence.jsonl",
  "work/reader-map.json",
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

function batchFor(caseNumber) {
  return Object.entries(CONTEXT_UPGRADE_BATCHES).find(([, cases]) => cases.includes(caseNumber))?.[0] ?? null;
}

function assertApproved(caseNumber) {
  if (!CONTEXT_UPGRADE_CASES.includes(caseNumber)) throw new Error(`${caseNumber} 不在 2.4.2 关键名词更新白名单中。`);
}

async function optionalHash(caseDir, relative) {
  const filePath = path.join(caseDir, ...relative.split("/"));
  return await exists(filePath) ? sha256File(filePath) : null;
}

async function snapshotHashes(caseDir, manifest) {
  const sourcePath = path.join(caseDir, ...manifest.source.path.split("/"));
  const source = await sha256File(sourcePath);
  if (source !== manifest.source.sha256) throw new Error(`${manifest.caseNumber} 原始来源哈希与 case.json 不一致。`);
  const artifacts = {};
  for (const relative of SNAPSHOT_FILES) artifacts[relative] = await optionalHash(caseDir, relative);
  const immutable = { source };
  for (const relative of IMMUTABLE_FILES) {
    immutable[relative] = await optionalHash(caseDir, relative);
    if (!immutable[relative]) throw new Error(`${manifest.caseNumber} 缺少不可变迁移输入 ${relative}。`);
  }
  return { immutable, artifacts };
}

function stagePrefixValid(ledger) {
  const index = CONTEXT_UPGRADE_STAGES.indexOf(ledger.lastCompletedStage);
  return index >= 0
    && JSON.stringify(ledger.completedStages ?? []) === JSON.stringify(CONTEXT_UPGRADE_STAGES.slice(0, index + 1));
}

export function contextUpgradeLedgerErrors(ledger) {
  const errors = [];
  if (ledger?.schemaVersion !== "1.0.0") errors.push("context-upgrade ledger schemaVersion 必须为 1.0.0。");
  if (!CONTEXT_UPGRADE_CASES.includes(ledger?.caseNumber)) errors.push("context-upgrade caseNumber 不在批准白名单中。");
  if (ledger?.batchId !== batchFor(ledger?.caseNumber)) errors.push("context-upgrade batchId 与案例不一致。");
  if (JSON.stringify(ledger?.targetVersions) !== JSON.stringify(CONTEXT_UPGRADE_TARGETS)) errors.push("context-upgrade 目标版本不一致。");
  if (!stagePrefixValid(ledger ?? {})) errors.push("context-upgrade completedStages 不是连续前缀。");
  for (const key of ["source", ...IMMUTABLE_FILES]) {
    if (!/^[a-f0-9]{64}$/u.test(ledger?.initialHashes?.immutable?.[key] ?? "")) errors.push(`context-upgrade 缺少不可变哈希：${key}。`);
  }
  return errors;
}

async function assertImmutable(caseDir, manifest, ledger) {
  const current = await snapshotHashes(caseDir, manifest);
  for (const [key, expected] of Object.entries(ledger.initialHashes.immutable ?? {})) {
    if (current.immutable[key] !== expected) throw new Error(`${manifest.caseNumber} 的 ${key} 在 Context Upgrade 期间发生变化。`);
  }
  return current;
}

export async function prepareContextUpgrade(caseDir) {
  const { manifest } = await loadCase(caseDir);
  assertApproved(manifest.caseNumber);
  if (!ELIGIBLE_SOURCE_WORKFLOWS.has(manifest.workflow?.version)) {
    throw new Error(`${manifest.caseNumber} 必须先完成 2.4 内容迁移与审核基线，当前 workflow 为 ${manifest.workflow?.version ?? "<missing>"}。`);
  }
  const ledgerPath = path.join(caseDir, ...LEDGER_RELATIVE_PATH.split("/"));
  if (await exists(ledgerPath)) {
    const ledger = await readJson(ledgerPath);
    const errors = contextUpgradeLedgerErrors(ledger);
    if (errors.length) throw new Error(errors.join("\n"));
    if (ledger.caseId !== manifest.id) throw new Error(`${manifest.caseNumber} 的 Context Upgrade 账本属于其他案例。`);
    await assertImmutable(caseDir, manifest, ledger);
    return { status: "resumable", ledgerPath, ledger };
  }
  const initialHashes = await snapshotHashes(caseDir, manifest);
  const ledger = {
    $schema: "../../../schemas/context-upgrade-v242.schema.json",
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    caseNumber: manifest.caseNumber,
    batchId: batchFor(manifest.caseNumber),
    targetVersions: CONTEXT_UPGRADE_TARGETS,
    initialHashes,
    completedStages: ["snapshotted"],
    lastCompletedStage: "snapshotted",
    nextAction: "补充 research 与 work/context-guide.json；不得修改原字幕、segments、evidence 或 reader-map。",
    preparedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(ledgerPath, ledger);
  return { status: "prepared", ledgerPath, ledger };
}

function nextActionFor(stage) {
  return {
    snapshotted: "补充 research 与 work/context-guide.json。",
    researched: "完成并校验 work/context-guide.json。",
    context_ready: "升级 deep-read 2.5.0，并把 contextRefs 放在首次实质出现处。",
    reader_bound: "升级 brief 1.7.0，声明 inline_first_use 绑定及必要子集。",
    brief_bound: "运行三角色 Context Guide 增量审核。",
    reviewed: "重新生成 Markdown、HTML、桌面与手机 PNG。",
    rendered: "运行 quality/validate 并检查原始分辨率图片。",
    complete: "等待集中人工校审。",
  }[stage];
}

async function deliveryErrors(caseDir, manifest) {
  const errors = [];
  if (manifest.workflow?.version !== CONTEXT_UPGRADE_TARGETS.workflow
    || manifest.workflow?.promptVersion !== CONTEXT_UPGRADE_TARGETS.prompt
    || manifest.workflow?.templateVersion !== CONTEXT_UPGRADE_TARGETS.template) errors.push("case.json 目标版本不完整");
  const [deepRead, brief, review] = await Promise.all([
    readJson(path.join(caseDir, "output", "deep-read.json")).catch(() => null),
    readJson(path.join(caseDir, "output", "brief.json")).catch(() => null),
    readJson(path.join(caseDir, "work", "reviews", "2.4.2", "context-guide", "review.json")).catch(() => null),
  ]);
  if (deepRead?.schemaVersion !== CONTEXT_UPGRADE_TARGETS.deepReadSchema || deepRead?.workflowVersion !== CONTEXT_UPGRADE_TARGETS.workflow) errors.push("deep-read 2.5.0 不完整");
  const contextBlocks = (deepRead?.sections ?? []).flatMap((section) => section.modules ?? []).flatMap((module) => module.blocks ?? []).filter((block) => block.type === "context_guide");
  if (contextBlocks.length) errors.push("deep-read 仍含独立 context_guide block");
  if (brief?.schemaVersion !== CONTEXT_UPGRADE_TARGETS.briefSchema || brief?.contextGuide?.placement !== "inline_first_use") errors.push("brief 1.7.0 inline_first_use 绑定不完整");
  if (review?.status !== "pass" || review?.reviewPolicyVersion !== CONTEXT_UPGRADE_TARGETS.reviewPolicy) errors.push("Context Guide 2.4.2 审核未通过");
  for (const relative of ["output/deep-read.md", "output/brief.json", "output/quickread.html", "output/quickread.png", "output/quickread-mobile.png", "work/quality-report.json", "work/render-report.json"]) {
    if (!(await exists(path.join(caseDir, ...relative.split("/"))))) errors.push(`缺少 ${relative}`);
  }
  return errors;
}

export async function advanceContextUpgrade(caseDir, stage) {
  const { manifest } = await loadCase(caseDir);
  assertApproved(manifest.caseNumber);
  if (!CONTEXT_UPGRADE_STAGES.includes(stage)) throw new Error(`未知 Context Upgrade 阶段：${stage}`);
  const ledgerPath = path.join(caseDir, ...LEDGER_RELATIVE_PATH.split("/"));
  if (!(await exists(ledgerPath))) throw new Error(`${manifest.caseNumber} 尚未 prepare。`);
  const ledger = await readJson(ledgerPath);
  const errors = contextUpgradeLedgerErrors(ledger);
  if (errors.length) throw new Error(errors.join("\n"));
  await assertImmutable(caseDir, manifest, ledger);
  const currentIndex = CONTEXT_UPGRADE_STAGES.indexOf(ledger.lastCompletedStage);
  const requestedIndex = CONTEXT_UPGRADE_STAGES.indexOf(stage);
  if (requestedIndex <= currentIndex) return { status: "unchanged", ledgerPath, ledger };
  if (requestedIndex !== currentIndex + 1) throw new Error(`必须先完成 ${CONTEXT_UPGRADE_STAGES[currentIndex + 1]}，不能跳到 ${stage}。`);
  if (stage === "complete") {
    const delivery = await deliveryErrors(caseDir, manifest);
    if (delivery.length) throw new Error(delivery.join("；"));
  }
  ledger.completedStages.push(stage);
  ledger.lastCompletedStage = stage;
  ledger.nextAction = nextActionFor(stage);
  ledger.updatedAt = new Date().toISOString();
  await writeJson(ledgerPath, ledger);
  return { status: "advanced", ledgerPath, ledger };
}

async function caseMap() {
  const pairs = await Promise.all((await listCaseDirs()).map(async (caseDir) => {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    return [manifest.caseNumber, { caseDir, manifest }];
  }));
  return new Map(pairs);
}

export async function contextUpgradeStatus() {
  const cases = await caseMap();
  const rows = [];
  for (const caseNumber of CONTEXT_UPGRADE_CASES) {
    const found = cases.get(caseNumber);
    if (!found) {
      rows.push({ caseNumber, batchId: batchFor(caseNumber), status: "missing", caseId: null, stage: null });
      continue;
    }
    const ledgerPath = path.join(found.caseDir, ...LEDGER_RELATIVE_PATH.split("/"));
    const ledger = await readJson(ledgerPath).catch(() => null);
    const ledgerErrors = ledger ? contextUpgradeLedgerErrors(ledger) : [];
    if (ledger && ledger.caseId !== found.manifest.id) ledgerErrors.push("账本 caseId 与目录不一致。");
    rows.push({
      caseNumber,
      batchId: batchFor(caseNumber),
      caseId: found.manifest.id,
      status: ledgerErrors.length ? "invalid" : ledger ? (ledger.lastCompletedStage === "complete" ? "complete" : "resumable") : "not_started",
      stage: ledger?.lastCompletedStage ?? null,
      workflowVersion: found.manifest.workflow?.version ?? null,
      errors: ledgerErrors,
    });
  }
  return rows;
}

async function selectedCases({ caseNumber, batchId }) {
  if (caseNumber && batchId) throw new Error("--case 与 --batch 不能同时使用。");
  const wanted = caseNumber ? [caseNumber] : CONTEXT_UPGRADE_BATCHES[batchId];
  if (!wanted) throw new Error("必须提供有效的 --case QR-NNNN 或 --batch batch-1|batch-2|batch-3|batch-4|batch-5。");
  wanted.forEach(assertApproved);
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  for (const number of wanted) {
    if (!config.contextUpgrade?.allowlist?.includes(number)) throw new Error(`${number} 未获得当前仓库的 Context Upgrade 授权。`);
  }
  const cases = await caseMap();
  return wanted.map((number) => {
    const found = cases.get(number);
    if (!found) throw new Error(`找不到 ${number} 对应案例目录。`);
    return found.caseDir;
  });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--status")) {
      console.log(JSON.stringify(await contextUpgradeStatus(), null, 2));
    } else if (args.includes("--prepare")) {
      const dirs = await selectedCases({ caseNumber: option(args, "--case"), batchId: option(args, "--batch") });
      const results = [];
      for (const caseDir of dirs) {
        try { results.push(await prepareContextUpgrade(caseDir)); }
        catch (error) { results.push({ status: "failed", caseDir, error: error.message }); }
      }
      console.log(JSON.stringify(results, null, 2));
      if (results.some((result) => result.status === "failed")) process.exitCode = 1;
    } else if (args.includes("--advance")) {
      const caseDir = resolveCaseDir(option(args, "--case"));
      const { manifest } = await loadCase(caseDir);
      const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
      if (!config.contextUpgrade?.allowlist?.includes(manifest.caseNumber)) throw new Error(`${manifest.caseNumber} 未获得当前仓库的 Context Upgrade 授权。`);
      console.log(JSON.stringify(await advanceContextUpgrade(caseDir, option(args, "--stage")), null, 2));
    } else {
      throw new Error("用法：context-upgrade-v242.mjs --status | --prepare (--case QR-NNNN | --batch batch-1|batch-2|batch-3|batch-4|batch-5) | --advance --case <case> --stage <stage>");
    }
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
