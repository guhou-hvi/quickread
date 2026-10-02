import { isMain, resolveCaseDir } from "./lib.mjs";
import { advanceMigrationLedger } from "./migrate-v24.mjs";

const STAGE_DEFAULTS = Object.freeze({
  evidence_ready: {
    pendingReviews: ["claim_auditor"],
    nextAction: "完成首次隔离 Claim Auditor，接受证据基线后再生成读者层。",
  },
  evidence_reviewed: {
    pendingReviews: ["external_citation", "fidelity", "reader_advocate", "render", "source_scout"],
    nextAction: "按 2.4 reader-first 规则重写读者层并完成三角复核。",
  },
  reader_ready: {
    pendingReviews: ["external_citation", "fidelity", "reader_advocate", "render", "source_scout"],
    nextAction: "完成隔离的 Source Scout、Fidelity、Reader Advocate 与人物导览审核。",
  },
  reader_reviewed: {
    pendingReviews: ["render"],
    nextAction: "从已审核深度稿生成 brief、HTML 与双 PNG。",
  },
});

export async function advanceMigrationV24(caseDir, stage) {
  const defaults = STAGE_DEFAULTS[stage];
  if (!defaults) throw new Error(`不支持通过此入口推进到 ${stage ?? "unknown"}。`);
  return advanceMigrationLedger(caseDir, stage, defaults);
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const stage = process.argv[3];
    const ledger = await advanceMigrationV24(caseDir, stage);
    console.log(JSON.stringify({ caseId: ledger.caseId, stage: ledger.stage, nextAction: ledger.nextAction }, null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
