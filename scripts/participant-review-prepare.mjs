import { isMain, resolveCaseDir } from "./lib.mjs";
import { prepareParticipantGuideReview } from "./participant-guide-review.mjs";

function assignments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--assign") throw new Error(`未知参数：${argv[index]}`);
    const [role, ...id] = String(argv[++index] ?? "").split("=");
    result[role] = id.join("=");
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await prepareParticipantGuideReview(caseDir, assignments(process.argv.slice(3)));
    console.log(`人物导览审核 packets 已准备：${result.root}`);
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
