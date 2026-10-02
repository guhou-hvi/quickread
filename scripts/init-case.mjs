import path from "node:path";
import { createCaseFromSource } from "./case-intake.mjs";
import { REPO_ROOT } from "./lib.mjs";

const descriptor = process.argv[2];
const sourceArgument = process.argv[3];
if (!sourceArgument) {
  console.error("缺少来源文件路径。");
  process.exitCode = 1;
} else {
  try {
    const sourcePath = path.resolve(REPO_ROOT, sourceArgument);
    const result = await createCaseFromSource({ slug: descriptor, sourcePath, removeSource: false });
    console.log(`已创建案例：${result.caseNumber} · ${path.relative(REPO_ROOT, result.caseDir)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
