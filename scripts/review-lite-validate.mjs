import { pathToFileURL } from "node:url";

import { parseLiteReviewCli, validateLiteReview } from "./reader-review-v240.mjs";

export async function main(argv = process.argv.slice(2)) {
  const options = parseLiteReviewCli(argv);
  const validation = await validateLiteReview(options.caseDir, options.reviewRound, { requireReports: true, bindCurrent: !options.historical });
  if (validation.errors.length) {
    for (const error of validation.errors) console.error(`ERROR ${error}`);
    process.exitCode = 1;
  } else console.log(`2.4 轻量审核验证通过：${validation.caseId} round ${validation.reviewRound}${options.historical ? "（historical）" : ""}`);
  return validation;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
