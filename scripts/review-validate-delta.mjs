import { isMain, resolveCaseDir } from "./lib.mjs";
import { validateClaimsDelta } from "./claims-delta.mjs";

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await validateClaimsDelta(caseDir);
    for (const error of result.errors) console.error(`ERROR ${error}`);
    for (const warning of result.warnings ?? []) console.warn(`WARN  ${warning.evidenceRef}：非核心 ASR/支持边界歧义按用户批准降为 warning；新读者稿不得使用该 claim。`);
    if (!result.errors.length) console.log("PASS  evidence change-set 与 claims-delta 审核范围完整、哈希有效。");
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
