import path from "node:path";

import {
  isMain,
  readJson,
  resolveCaseDir,
  sha256File,
  writeJson,
} from "./lib.mjs";

export async function renderReviewInputHashes(caseDir) {
  return {
    html: await sha256File(path.join(caseDir, "output", "quickread.html")),
    desktopPng: await sha256File(path.join(caseDir, "output", "quickread.png")),
    mobilePng: await sha256File(path.join(caseDir, "output", "quickread-mobile.png")),
    renderReport: await sha256File(path.join(caseDir, "work", "render-report.json")),
  };
}

export function renderReviewDraftErrors(draft) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft?.reviewedAt ?? "")) errors.push("reviewedAt 必须为日期。");
  if (!String(draft?.reviewerId ?? "").trim()) errors.push("缺少 reviewerId。");
  if (!["pass", "fail"].includes(draft?.status)) errors.push("status 非法。");
  if (!Array.isArray(draft?.hardErrors) || !Array.isArray(draft?.warnings)) errors.push("缺少 hardErrors/warnings 数组。");
  if (draft?.status === "pass" && draft?.hardErrors?.length) errors.push("存在 hardErrors 时 status 不能为 pass。");
  return errors;
}

export async function recordRenderReviewV24(caseDir) {
  const manifest = await readJson(path.join(caseDir, "case.json"));
  const reviewDir = path.join(caseDir, "work", "reviews", "2.4.0", "render");
  const draft = await readJson(path.join(reviewDir, "review-draft.json"));
  const errors = renderReviewDraftErrors(draft);
  if (errors.length) throw new Error(errors.join("\n"));
  const record = {
    $schema: "../../../../../../schemas/render-review-v24.schema.json",
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    reviewedAt: draft.reviewedAt,
    reviewerId: draft.reviewerId,
    inputHashes: await renderReviewInputHashes(caseDir),
    status: draft.status,
    hardErrors: draft.hardErrors,
    warnings: draft.warnings,
    ...(draft.summary ? { summary: draft.summary } : {}),
  };
  const outputPath = path.join(reviewDir, "review.json");
  await writeJson(outputPath, record);
  return { outputPath, record };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await recordRenderReviewV24(caseDir);
    console.log(JSON.stringify({ outputPath: path.relative(process.cwd(), result.outputPath), status: result.record.status }, null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
