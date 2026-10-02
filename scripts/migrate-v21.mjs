import path from "node:path";
import { isMain, listCaseDirs, readJson, resolveCaseDir } from "./lib.mjs";
import { migrateReaderEdition } from "./reader-edition.mjs";
import { PILOT_NUMBERS } from "./migrate-v2.mjs";

async function selectedCaseDirs(argument) {
  if (argument && !["--pilot", "--all"].includes(argument)) return [resolveCaseDir(argument)];
  const selected = [];
  for (const caseDir of await listCaseDirs()) {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    if (argument === "--all" || PILOT_NUMBERS.has(manifest.caseNumber)) selected.push(caseDir);
  }
  return selected;
}

if (isMain(import.meta.url)) {
  let failed = false;
  for (const caseDir of await selectedCaseDirs(process.argv[2] ?? "--pilot")) {
    try {
      const result = await migrateReaderEdition(caseDir);
      console.log(`${result.manifest.id}: reader ${result.built.characters} chars; evidence ${result.built.evidenceClaims} claims`);
    } catch (error) {
      failed = true;
      console.error(`${path.basename(caseDir)}: ${error.stack ?? error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

