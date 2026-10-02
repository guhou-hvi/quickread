import { pathToFileURL } from "node:url";

import { parseLiteReviewCli, prepareLiteReview } from "./reader-review-v240.mjs";

export async function main(argv = process.argv.slice(2)) {
  const options = parseLiteReviewCli(argv, { requireAssignments: true });
  const result = await prepareLiteReview(options.caseDir, options);
  const mode = result.manifest.reviewMode === "targeted_delta"
    ? "定向增量"
    : (result.manifest.reviewMode === "reader_map_mechanical" ? "reader-map 机械" : "完整轻量");
  console.log(`2.4 ${mode}审核 packets 已准备：${result.reviewRoot}`);
  if (result.manifest.reviewMode === "targeted_delta") {
    console.log(`继承 round ${result.manifest.baseRound}：${result.manifest.inheritedRoles.join(", ")}`);
  }
  if (result.manifest.reviewMode === "reader_map_mechanical") {
    console.log(`零 Agent 继承 round ${result.manifest.baseRound}；合并重复条目 ${result.manifest.mechanicalProof.duplicateEntriesRemoved} 个。`);
  }
  for (const packet of result.packets) console.log(`${packet.role}: ${packet.reviewerId} -> ${packet.outputPath}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
