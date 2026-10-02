import { sha256Value } from "./review-contract.mjs";

export const READER_FIRST_REVIEW_SCHEMA_VERSION = "1.0.0";
export const READER_FIRST_REVIEW_POLICY_VERSION = "2.3.2";
export const READER_FIRST_REQUIRED_ROLES = ["source_scout", "fidelity", "reader_advocate"];

export function readerFirstInputHashes({
  segments,
  claims,
  deepRead,
  readerMap,
  research,
  brief,
  readerMarkdown,
}) {
  return {
    segments: sha256Value(segments),
    evidence: sha256Value(claims),
    deepRead: sha256Value(deepRead),
    readerMap: sha256Value(readerMap),
    research: sha256Value(research),
    brief: sha256Value(brief),
    readerMarkdown: sha256Value(readerMarkdown),
  };
}

export function readerFirstReviewContractErrors(record, {
  caseId,
  reviewRound,
  inputHashes,
} = {}) {
  const errors = [];
  if (record?.schemaVersion !== READER_FIRST_REVIEW_SCHEMA_VERSION) {
    errors.push(`reader-first-review.schemaVersion 必须为 ${READER_FIRST_REVIEW_SCHEMA_VERSION}。`);
  }
  if (record?.reviewPolicyVersion !== READER_FIRST_REVIEW_POLICY_VERSION) {
    errors.push(`reader-first-review.reviewPolicyVersion 必须为 ${READER_FIRST_REVIEW_POLICY_VERSION}。`);
  }
  if (record?.gatePolicy !== "concrete_hard_errors") {
    errors.push("reader-first-review.gatePolicy 必须为 concrete_hard_errors。");
  }
  if (caseId && record?.caseId !== caseId) errors.push("reader-first-review.caseId 与案例不一致。");
  if (reviewRound && record?.reviewRound !== reviewRound) errors.push("reader-first-review.reviewRound 不一致。");
  if (record?.humanReviewRequired !== true) errors.push("reader-first-review 必须保留最终人工审核。");

  for (const [key, expected] of Object.entries(inputHashes ?? {})) {
    if (record?.inputHashes?.[key] !== expected) {
      errors.push(`reader-first-review.inputHashes.${key} 已过期或不匹配。`);
    }
  }

  const reviewers = Array.isArray(record?.reviewers) ? record.reviewers : [];
  const ids = reviewers.map((reviewer) => reviewer.reviewerId).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push("reader-first-review reviewerId 必须唯一。");
  for (const role of READER_FIRST_REQUIRED_ROLES) {
    const matches = reviewers.filter((reviewer) => reviewer.role === role);
    if (matches.length !== 1) errors.push(`reader-first-review 必须且只能有一名 ${role}。`);
  }
  for (const reviewer of reviewers) {
    if (!reviewer.reviewerId) errors.push(`reader-first-review ${reviewer.role ?? "unknown"} 缺少 reviewerId。`);
    if (!["pass", "warning", "fail"].includes(reviewer.status)) {
      errors.push(`reader-first-review ${reviewer.reviewerId ?? reviewer.role} status 非法。`);
    }
    if (!Array.isArray(reviewer.hardErrors) || !Array.isArray(reviewer.warnings)) {
      errors.push(`reader-first-review ${reviewer.reviewerId ?? reviewer.role} 缺少 hardErrors/warnings 数组。`);
    }
  }
  if (!Array.isArray(record?.hardErrors) || !Array.isArray(record?.warnings)) {
    errors.push("reader-first-review 顶层缺少 hardErrors/warnings 数组。");
  }
  const nestedHardErrors = reviewers.flatMap((reviewer) => reviewer.hardErrors ?? []);
  if (nestedHardErrors.length !== (record?.hardErrors?.length ?? 0)) {
    errors.push("reader-first-review 顶层 hardErrors 必须汇总全部角色 hardErrors。");
  }
  if (!Array.isArray(record?.diagnostics)) errors.push("reader-first-review.diagnostics 必须为数组。");
  return [...new Set(errors)];
}
