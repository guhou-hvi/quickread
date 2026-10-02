import path from "node:path";

import {
  isMain,
  loadCase,
  readJson,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";
import {
  advanceMigrationLedger,
  currentDeliveryErrors,
  TARGET_VERSIONS,
} from "./migrate-v24.mjs";
import { participantGuideReviewRecordErrors } from "./participant-guide-review.mjs";
import { renderReviewInputHashes } from "./render-review-v24.mjs";
import {
  latestCompletedLiteReviewRound,
  liteReviewConsensusFromValidation,
  validateLiteReview,
} from "./reader-review-v240.mjs";
import { sha256Value } from "./review-contract.mjs";

const TARGET_CASE_SCHEMA_VERSION = "1.2.0";

async function currentParticipantReviewErrors(caseDir, manifest) {
  const reviewPath = path.join(caseDir, "work", "reviews", "2.4.0", "participant-guide", "review.json");
  const record = await readJson(reviewPath);
  const errors = [];
  if (record.caseId !== manifest.id || record.reviewPolicyVersion !== "2.4.0" || record.status !== "pass") {
    errors.push("人物导览增量审核未通过或案例不一致。");
  }
  errors.push(...await participantGuideReviewRecordErrors(caseDir, record));
  return errors;
}

async function currentRenderReviewErrors(caseDir, manifest) {
  const record = await readJson(path.join(caseDir, "work", "reviews", "2.4.0", "render", "review.json"));
  const errors = [];
  if (record.caseId !== manifest.id || record.reviewPolicyVersion !== "2.4.0" || record.status !== "pass" || record.hardErrors?.length) {
    errors.push("渲染审核未通过或案例不一致。");
  }
  const hashes = await renderReviewInputHashes(caseDir);
  for (const [key, value] of Object.entries(hashes)) if (record.inputHashes?.[key] !== value) errors.push(`渲染审核 ${key} 已过期。`);
  return errors;
}

async function currentReaderReviewErrors(caseDir, manifest) {
  const root = path.join(caseDir, "work", "reviews", "2.4.0", "reader-first");
  const reviewRound = await latestCompletedLiteReviewRound(caseDir);
  const validation = await validateLiteReview(caseDir, reviewRound, { requireReports: true });
  const errors = [...validation.errors];
  const consensusPath = path.join(root, `round-${String(reviewRound).padStart(2, "0")}`, "consensus.json");
  const consensus = await readJson(consensusPath);
  const expected = liteReviewConsensusFromValidation(validation);
  if (consensus.caseId !== manifest.id || consensus.reviewPolicyVersion !== "2.4.0") errors.push("2.4 读者审核案例或策略版本不一致。");
  if (sha256Value(consensus) !== sha256Value(expected)) errors.push("2.4 读者审核 consensus 已过期或与角色报告不一致。");
  if (consensus.status === "blocked" || consensus.status === "invalid" || consensus.hardErrors?.length) errors.push("2.4 读者审核仍有具体 hard error。");
  return errors;
}

export async function finalizeMigrationV24(caseDir) {
  const { manifest, manifestPath } = await loadCase(caseDir);
  const ledger = await readJson(path.join(caseDir, "work", "migration-v2.4.json"));
  if (ledger.stage === "reader_ready") {
    const reviewErrors = [
      ...await currentReaderReviewErrors(caseDir, manifest),
      ...await currentParticipantReviewErrors(caseDir, manifest),
    ];
    if (reviewErrors.length) throw new Error(reviewErrors.join("\n"));
    const reviewed = await advanceMigrationLedger(caseDir, "reader_reviewed", {
      pendingReviews: ["render"],
      nextAction: "切换案例版本并生成、校验最终 Markdown、HTML 与双 PNG。",
    });
    return { status: "reader_reviewed", ledger: reviewed };
  }
  if (ledger.stage === "reader_reviewed") {
    // A case may finish its reader-first 2.4.0 baseline and immediately continue
    // through the approved 2.4.2 context upgrade before this historical ledger
    // is sealed. In that situation, never downgrade current artifacts merely to
    // satisfy the intermediate version. The current-delivery contract already
    // proves the context ledger, schemas, quality report and final files.
    if (manifest.workflow?.version === "2.4.2") {
      const deliveryErrors = await currentDeliveryErrors(caseDir, manifest);
      if (deliveryErrors.length) throw new Error(`2.4.2 最终交付不完整：${deliveryErrors.join("；")}`);
      const delivered = await advanceMigrationLedger(caseDir, "delivered", {
        pendingReviews: [],
        nextAction: "2.4.2 交付完整，等待集中人工校审。",
      });
      return { status: "delivered", ledger: delivered };
    }
    if (manifest.workflow?.version !== TARGET_VERSIONS.workflow || manifest.schemaVersion !== TARGET_CASE_SCHEMA_VERSION) {
      manifest.schemaVersion = TARGET_CASE_SCHEMA_VERSION;
      manifest.workflow = {
        ...manifest.workflow,
        version: TARGET_VERSIONS.workflow,
        promptVersion: TARGET_VERSIONS.prompt,
        templateVersion: TARGET_VERSIONS.template,
      };
      await writeJson(manifestPath, manifest);
      return { status: "activated", nextAction: "运行 quality、validate、render 与 screenshot 后再次执行 finalize-migration-v24。" };
    }
    const deliveryErrors = await currentDeliveryErrors(caseDir, manifest);
    deliveryErrors.push(...await currentRenderReviewErrors(caseDir, manifest));
    if (deliveryErrors.length) throw new Error(`最终交付不完整：${deliveryErrors.join("；")}`);
    const delivered = await advanceMigrationLedger(caseDir, "delivered", {
      pendingReviews: [],
      nextAction: "等待五个可复用试点全部交付后进行集中校审；旧版案例继续冻结。",
    });
    return { status: "delivered", ledger: delivered };
  }
  if (ledger.stage === "delivered") return { status: "delivered", ledger };
  throw new Error(`当前迁移阶段 ${ledger.stage} 不能执行最终化。`);
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    console.log(JSON.stringify(await finalizeMigrationV24(caseDir), null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
