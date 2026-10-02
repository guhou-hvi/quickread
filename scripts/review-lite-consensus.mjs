import { pathToFileURL } from "node:url";

import { computeLiteReviewConsensus, parseLiteReviewCli } from "./reader-review-v240.mjs";

export async function main(argv = process.argv.slice(2)) {
  const options = parseLiteReviewCli(argv);
  const { validation, consensus } = await computeLiteReviewConsensus(options.caseDir, options.reviewRound, { bindCurrent: !options.historical });
  if (validation.errors.length) {
    for (const error of validation.errors) console.error(`ERROR ${error}`);
    process.exitCode = 1;
  } else console.log(`2.4 轻量审核共识${options.historical ? "（historical）" : ""}：${consensus.status}；hard=${consensus.hardErrors.length} warning=${consensus.warnings.length}`);
  return { validation, consensus };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
