import path from "node:path";
import { listCaseDirs, readJson } from "./lib.mjs";
import { PILOT_NUMBERS } from "./migrate-v2.mjs";
import { validateCase } from "./validate-case.mjs";

let failed = false;
for (const caseDir of await listCaseDirs()) {
  const manifest = await readJson(path.join(caseDir, "case.json"));
  if (!PILOT_NUMBERS.has(manifest.caseNumber)) continue;
  const result = await validateCase(caseDir);
  const humanError = (error) => /(?:用户集中六维校审|人工评分|人工审核)/u.test(error);
  const automatedErrors = result.errors.filter((error) => !humanError(error));
  const humanErrors = result.errors.filter(humanError);
  console.log(`[${manifest.caseNumber}] automated=${automatedErrors.length ? "FAIL" : "PASS"}; human=${humanErrors.length ? "PENDING" : "PASS"}`);
  for (const warning of result.warnings) console.warn(`WARN  ${warning}`);
  for (const error of automatedErrors) console.error(`ERROR ${error}`);
  if (automatedErrors.length) failed = true;
}
if (failed) process.exitCode = 1;
