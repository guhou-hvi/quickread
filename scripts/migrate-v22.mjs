import fs from "node:fs/promises";
import path from "node:path";
import {
  isMain,
  listCaseDirs,
  readJson,
  REPO_ROOT,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";

export const PILOT_NUMBERS_V22 = new Set([
  "QR-0002",
  "QR-0011",
  "QR-0013",
  "QR-0017",
  "QR-0022",
  "QR-0023",
]);

const ARCHIVE_FILES = Object.freeze([
  "case.json",
  "output/brief.json",
  "output/deep-read.json",
  "output/deep-read.md",
  "output/evidence-book.md",
  "output/quickread.html",
  "work/audit-claims.jsonl",
  "work/density-assessment.json",
  "work/evidence.jsonl",
  "work/human-review.json",
  "work/migration-comparison.json",
  "work/quality-report.json",
  "work/reader-map.json",
  "work/render-report.json",
  "work/theme-map.json",
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

export async function archiveWorkflow21(caseDir) {
  const archiveRoot = path.join(caseDir, "legacy", "workflow-2.1.0");
  const archiveManifest = path.join(archiveRoot, "archive-manifest.json");
  if (await exists(archiveManifest)) return { archiveRoot, reused: true };
  await fs.mkdir(archiveRoot, { recursive: true });
  const archived = [];
  for (const relative of ARCHIVE_FILES) {
    const source = path.join(caseDir, ...relative.split("/"));
    if (!(await exists(source))) continue;
    const destination = path.join(archiveRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    archived.push(relative);
  }
  await writeJson(archiveManifest, {
    schemaVersion: "1.0.0",
    workflowVersion: "2.1.0",
    archivedAt: new Date().toISOString(),
    files: archived,
  });
  return { archiveRoot, reused: false };
}

export async function prepareV22Migration(caseDir) {
  const manifestPath = path.join(caseDir, "case.json");
  const [manifest, config] = await Promise.all([
    readJson(manifestPath),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
  ]);
  if (!PILOT_NUMBERS_V22.has(manifest.caseNumber)) {
    throw new Error(`${manifest.caseNumber} 不在 2.2 六案试点内；其余案例保持冻结。`);
  }
  const archive = await archiveWorkflow21(caseDir);
  manifest.workflow = {
    version: config.workflowVersion,
    promptVersion: config.promptVersion,
    templateVersion: config.templateVersion,
  };
  await writeJson(manifestPath, manifest);
  await writeJson(path.join(caseDir, "work", "migration-v22.json"), {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    fromWorkflow: "2.1.0",
    toWorkflow: "2.2.0",
    state: "evidence-rebuild-required",
    archive: path.relative(caseDir, archive.archiveRoot).replaceAll("\\", "/"),
    requirements: [
      "rebuild-atomic-evidence",
      "write-evidence-migration",
      "write-claim-bundles",
      "author-reader-map-2.0",
      "complete-multi-agent-review",
      "complete-human-review",
    ],
  });
  return { manifest, archive };
}

async function selectedCaseDirs(argument) {
  if (argument && !["--pilot"].includes(argument)) return [resolveCaseDir(argument)];
  const selected = [];
  for (const caseDir of await listCaseDirs()) {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    if (PILOT_NUMBERS_V22.has(manifest.caseNumber)) selected.push(caseDir);
  }
  return selected;
}

if (isMain(import.meta.url)) {
  let failed = false;
  for (const caseDir of await selectedCaseDirs(process.argv[2] ?? "--pilot")) {
    try {
      const result = await prepareV22Migration(caseDir);
      console.log(`${result.manifest.caseNumber}: archived 2.1 and marked for atomic evidence rebuild`);
    } catch (error) {
      failed = true;
      console.error(`${path.basename(caseDir)}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}
