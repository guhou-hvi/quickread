import path from "node:path";
import { createCaseFromSource, resolveInboxSource } from "./case-intake.mjs";
import { REPO_ROOT } from "./lib.mjs";

const descriptor = process.argv[2];
const sourceArgument = process.argv[3];
try {
  const inboxRoot = path.join(REPO_ROOT, "inbox");
  const sourcePath = await resolveInboxSource(inboxRoot, sourceArgument);
  const result = await createCaseFromSource({ slug: descriptor, sourcePath, removeSource: true });
  for (const warning of result.warnings) console.warn(`WARN  ${warning}`);
  console.log(`已创建：${result.caseNumber} · ${result.id}`);
  console.log(`已归档：${path.relative(REPO_ROOT, result.sourcePath)}`);
  console.log(`下一步：npm run parse -- ${path.relative(REPO_ROOT, result.caseDir)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
