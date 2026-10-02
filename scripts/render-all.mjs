import path from "node:path";
import { listCaseDirs, readJson, REPO_ROOT } from "./lib.mjs";
import { renderCase } from "./render.mjs";
import { screenshotCase } from "./screenshot.mjs";
import { writeCatalog } from "./catalog.mjs";
import { computeQualityReport } from "./quality-report.mjs";

let failed = false;
const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
for (const caseDir of await listCaseDirs()) {
  try {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    if (manifest.workflow?.version !== config.workflowVersion) {
      console.log(`RETAINED ${path.basename(caseDir)} at workflow ${manifest.workflow?.version ?? "legacy"}`);
      continue;
    }
    if (config.migration?.frozenCases?.includes(manifest.caseNumber)) {
      console.log(`FROZEN ${path.basename(caseDir)} at workflow ${manifest.workflow?.version ?? "legacy"}`);
      continue;
    }
    const quality = await computeQualityReport(caseDir);
    if (quality.errors.length) {
      failed = true;
      for (const error of quality.errors) console.error(`ERROR ${path.basename(caseDir)}: ${error}`);
    }
    const rendered = await renderCase(caseDir);
    const { report } = await screenshotCase(caseDir);
    console.log(
      `${path.relative(REPO_ROOT, rendered.outputPath)} -> `
      + `desktop ${report.png.width}×${report.png.height}; `
      + `mobile ${report.mobilePng.width}×${report.mobilePng.height}`,
    );
    for (const warning of report.warnings) console.warn(`WARN  ${warning}`);
    if (report.errors.length) {
      failed = true;
      for (const error of report.errors) console.error(`ERROR ${error}`);
    }
  } catch (error) {
    failed = true;
    console.error(`${path.basename(caseDir)}: ${error.message}`);
  }
}
try {
  await writeCatalog();
  console.log("cases/README.md + cases/index.html -> refreshed");
} catch (error) {
  failed = true;
  console.error(`catalog: ${error.message}`);
}
if (failed) process.exitCode = 1;
