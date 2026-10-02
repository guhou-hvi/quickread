import path from "node:path";
import {
  isMain,
  readJson,
  readJsonLines,
  resolveCaseDir,
  writeJson,
  writeJsonLines,
} from "./lib.mjs";
import { canonicalJson, sha256Value } from "./review-contract.mjs";

const REPORT_SCHEMA_VERSION = "1.0.0";
const WORKFLOW_VERSION = "2.2.1";
const REPORT_ROLE = "claim_mechanical_fix";
const SHA256 = /^[a-f0-9]{64}$/u;

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} 必须为数组。`);
}

function normalizedSourceIndex(normalizedUnits) {
  assertArray(normalizedUnits, "normalizedUnits");
  const byId = new Map();
  for (const [position, unit] of normalizedUnits.entries()) {
    const id = unit?.id;
    if (typeof id !== "string" || !id) throw new Error(`normalizedUnits[${position}].id 为空。`);
    if (byId.has(id)) throw new Error(`normalized source unit ID 重复：${id}`);
    byId.set(id, { position, unit });
  }
  return byId;
}

function evidenceCaseId(evidence) {
  const ids = new Set(evidence.map((claim) => claim?.caseId).filter((value) => typeof value === "string" && value));
  if (ids.size !== 1) throw new Error("evidence 必须且只能包含一个非空 caseId。");
  return [...ids][0];
}

function expectedQuote(span, sourceIndex, label) {
  if (!span || typeof span !== "object" || Array.isArray(span)) throw new Error(`${label} 不是对象。`);
  if (!Array.isArray(span.sourceIds) || span.sourceIds.length === 0) throw new Error(`${label}.sourceIds 为空。`);
  if (new Set(span.sourceIds).size !== span.sourceIds.length) throw new Error(`${label}.sourceIds 重复。`);

  const indexedUnits = span.sourceIds.map((sourceId) => {
    const indexed = sourceIndex.get(sourceId);
    if (!indexed) throw new Error(`${label} 引用未知 normalized source unit：${sourceId}`);
    const text = indexed.unit?.text;
    if (typeof text !== "string" || !text.trim()) throw new Error(`${label} 引用空文本 normalized source unit：${sourceId}`);
    return indexed;
  });
  for (let index = 1; index < indexedUnits.length; index += 1) {
    if (indexedUnits[index].position !== indexedUnits[index - 1].position + 1) {
      throw new Error(`${label}.sourceIds 在 normalized source 中不连续。`);
    }
  }
  return indexedUnits.map(({ unit }) => unit.text).join(" ");
}

function missingQuotePlans(evidence, normalizedUnits) {
  assertArray(evidence, "evidence");
  if (evidence.length === 0) throw new Error("evidence 不能为空。");
  const sourceIndex = normalizedSourceIndex(normalizedUnits);
  const claimIds = new Set();
  const plans = [];

  for (const [claimIndex, claim] of evidence.entries()) {
    const evidenceRef = claim?.id;
    if (typeof evidenceRef !== "string" || !evidenceRef) throw new Error(`evidence[${claimIndex}].id 为空。`);
    if (claimIds.has(evidenceRef)) throw new Error(`evidence claim ID 重复：${evidenceRef}`);
    claimIds.add(evidenceRef);
    if (!Array.isArray(claim.supportSpans) || claim.supportSpans.length === 0) {
      throw new Error(`${evidenceRef}.supportSpans 为空。`);
    }

    for (const [supportSpanIndex, span] of claim.supportSpans.entries()) {
      const label = `${evidenceRef}.supportSpans[${supportSpanIndex}]`;
      const quote = expectedQuote(span, sourceIndex, label);
      if (Object.hasOwn(span, "quote")) {
        if (typeof span.quote !== "string" || !span.quote) {
          throw new Error(`${label}.quote 已存在但不是非空字符串；机械模块只补缺失字段。`);
        }
        continue;
      }
      plans.push({ claimIndex, evidenceRef, supportSpanIndex, sourceIds: [...span.sourceIds], quote });
    }
  }
  return plans;
}

export function evidenceWithoutSupportQuotes(evidence) {
  assertArray(evidence, "evidence");
  return evidence.map((claim) => {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) return claim;
    const copy = { ...claim };
    if (Array.isArray(claim.supportSpans)) {
      copy.supportSpans = claim.supportSpans.map((span) => {
        if (!span || typeof span !== "object" || Array.isArray(span)) return span;
        const copySpan = { ...span };
        delete copySpan.quote;
        return copySpan;
      });
    }
    return copy;
  });
}

export function quoteIgnoredEvidenceHash(evidence) {
  return sha256Value(evidenceWithoutSupportQuotes(evidence));
}

export function synchronizeEvidenceMigration(evidenceMigration, beforeEvidenceHash, afterEvidenceHash) {
  if (evidenceMigration === null || evidenceMigration === undefined) {
    return { evidenceMigration: null, hashes: null };
  }
  if (!evidenceMigration || typeof evidenceMigration !== "object" || Array.isArray(evidenceMigration)) {
    throw new TypeError("evidence-migration 必须为对象。");
  }
  const boundEvidenceHash = evidenceMigration.inputHashes?.newEvidence;
  if (boundEvidenceHash !== beforeEvidenceHash) {
    throw new Error("evidence-migration.inputHashes.newEvidence 不等于修复前 evidence hash，拒绝写入。");
  }
  const repairedMigration = structuredClone(evidenceMigration);
  repairedMigration.inputHashes.newEvidence = afterEvidenceHash;
  return {
    evidenceMigration: repairedMigration,
    hashes: {
      beforeEvidenceMigration: sha256Value(evidenceMigration),
      afterEvidenceMigration: sha256Value(repairedMigration),
    },
  };
}

export function assertQuoteOnlyEvidenceChange(beforeEvidence, afterEvidence, normalizedUnits) {
  assertArray(beforeEvidence, "beforeEvidence");
  assertArray(afterEvidence, "afterEvidence");
  const beforeSemantic = canonicalJson(evidenceWithoutSupportQuotes(beforeEvidence));
  const afterSemantic = canonicalJson(evidenceWithoutSupportQuotes(afterEvidence));
  if (beforeSemantic !== afterSemantic) {
    throw new Error("检测到 supportSpans.quote 之外的语义字段变化，拒绝执行机械修复。");
  }

  const plans = missingQuotePlans(beforeEvidence, normalizedUnits);
  const planByLocation = new Map(plans.map((plan) => [`${plan.claimIndex}:${plan.supportSpanIndex}`, plan]));
  const changes = [];
  for (const [claimIndex, beforeClaim] of beforeEvidence.entries()) {
    const afterClaim = afterEvidence[claimIndex];
    for (const [supportSpanIndex, beforeSpan] of beforeClaim.supportSpans.entries()) {
      const afterSpan = afterClaim.supportSpans[supportSpanIndex];
      const key = `${claimIndex}:${supportSpanIndex}`;
      if (Object.hasOwn(beforeSpan, "quote")) {
        if (!Object.hasOwn(afterSpan, "quote") || afterSpan.quote !== beforeSpan.quote) {
          throw new Error(`${beforeClaim.id}.supportSpans[${supportSpanIndex}].quote 已存在，拒绝改写。`);
        }
        continue;
      }
      const plan = planByLocation.get(key);
      if (!Object.hasOwn(afterSpan, "quote") || afterSpan.quote !== plan.quote) {
        throw new Error(`${beforeClaim.id}.supportSpans[${supportSpanIndex}].quote 未严格按 normalized source 补全。`);
      }
      changes.push({
        evidenceRef: plan.evidenceRef,
        supportSpanIndex,
        sourceIds: [...plan.sourceIds],
        before: "missing",
        after: plan.quote,
      });
    }
  }
  return changes;
}

export function repairMissingSupportQuotes(evidence, normalizedUnits, {
  evidenceMigration = null,
  primaryClaimReviewHash,
  reviewRound,
} = {}) {
  assertArray(evidence, "evidence");
  evidenceCaseId(evidence);
  if (!SHA256.test(primaryClaimReviewHash ?? "")) throw new Error("primaryClaimReviewHash 不是 SHA-256。");
  if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new Error("reviewRound 必须为正整数。");
  const plans = missingQuotePlans(evidence, normalizedUnits);
  const repairedEvidence = structuredClone(evidence);
  for (const plan of plans) {
    repairedEvidence[plan.claimIndex].supportSpans[plan.supportSpanIndex].quote = plan.quote;
  }

  const changes = assertQuoteOnlyEvidenceChange(evidence, repairedEvidence, normalizedUnits);
  const beforeSemantic = quoteIgnoredEvidenceHash(evidence);
  const afterSemantic = quoteIgnoredEvidenceHash(repairedEvidence);
  if (beforeSemantic !== afterSemantic) throw new Error("quote-ignored semantic hash 发生变化，拒绝机械修复。");

  const beforeFullEvidence = sha256Value(evidence);
  const afterFullEvidence = sha256Value(repairedEvidence);
  const migration = synchronizeEvidenceMigration(evidenceMigration, beforeFullEvidence, afterFullEvidence);
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    workflowVersion: WORKFLOW_VERSION,
    caseId: evidenceCaseId(evidence),
    role: REPORT_ROLE,
    reviewRound,
    inputHashes: {
      primaryClaimReview: primaryClaimReviewHash,
      beforeEvidence: beforeFullEvidence,
      afterEvidence: afterFullEvidence,
      beforeQuoteIgnoredEvidence: beforeSemantic,
      afterQuoteIgnoredEvidence: afterSemantic,
      ...(migration.hashes ?? {}),
    },
    entries: [...Map.groupBy(changes, (change) => change.evidenceRef)].map(([evidenceRef, claimChanges]) => ({
      evidenceRef,
      findingCode: "missing_support_quote",
      status: "mechanically_resolved",
      supportSpanIndexes: claimChanges.map((change) => change.supportSpanIndex),
    })),
  };
  return { evidence: repairedEvidence, evidenceMigration: migration.evidenceMigration, changes, report };
}

async function optionalReadJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function fixClaimMechanicalQuotes(caseDir, { dryRun = false } = {}) {
  const resolvedCaseDir = path.resolve(caseDir);
  const workDir = path.join(resolvedCaseDir, "work");
  const normalizedPath = path.join(workDir, "source.normalized.jsonl");
  const evidencePath = path.join(workDir, "evidence.jsonl");
  const migrationPath = path.join(workDir, "evidence-migration.json");
  const claimReviewPath = path.join(workDir, "claim-review.json");
  const reportPath = path.join(workDir, "claim-mechanical-fix.json");
  const [normalizedUnits, evidence, evidenceMigration, claimReview] = await Promise.all([
    readJsonLines(normalizedPath),
    readJsonLines(evidencePath),
    optionalReadJson(migrationPath),
    readJson(claimReviewPath),
  ]);
  if (claimReview.caseId !== evidenceCaseId(evidence) || claimReview.role !== "claim_auditor") {
    throw new Error("claim-review 与 evidence 案例不一致或角色非法。");
  }
  const result = repairMissingSupportQuotes(evidence, normalizedUnits, {
    evidenceMigration,
    primaryClaimReviewHash: sha256Value(claimReview),
    reviewRound: claimReview.reviewRound,
  });
  if (result.report.caseId !== path.basename(resolvedCaseDir)) {
    throw new Error(`evidence caseId 与案例目录不一致：${result.report.caseId}`);
  }
  if (dryRun) return {
    ...result,
    evidencePath,
    migrationPath,
    claimReviewPath,
    reportPath,
    written: false,
  };

  const [currentNormalized, currentEvidence, currentMigration, currentClaimReview] = await Promise.all([
    readJsonLines(normalizedPath),
    readJsonLines(evidencePath),
    optionalReadJson(migrationPath),
    readJson(claimReviewPath),
  ]);
  if (sha256Value(currentNormalized) !== sha256Value(normalizedUnits)) {
    throw new Error("normalized source 在修复计划后发生变化，拒绝写入。");
  }
  if (sha256Value(currentEvidence) !== result.report.inputHashes.beforeEvidence) {
    throw new Error("evidence 在修复计划后发生变化，拒绝写入。");
  }
  if (sha256Value(currentClaimReview) !== result.report.inputHashes.primaryClaimReview) {
    throw new Error("claim-review 在修复计划后发生变化，拒绝写入。");
  }
  if (result.evidenceMigration) {
    if (currentMigration === null
      || sha256Value(currentMigration) !== result.report.inputHashes.beforeEvidenceMigration) {
      throw new Error("evidence-migration 在修复计划后发生变化或消失，拒绝写入。");
    }
  } else if (currentMigration !== null) {
    throw new Error("修复计划后出现了 evidence-migration，拒绝写入。");
  }
  assertQuoteOnlyEvidenceChange(currentEvidence, result.evidence, currentNormalized);

  if (result.changes.length > 0) {
    await writeJsonLines(evidencePath, result.evidence);
    if (result.evidenceMigration) await writeJson(migrationPath, result.evidenceMigration);
  }
  const writtenEvidence = await readJsonLines(evidencePath);
  if (sha256Value(writtenEvidence) !== result.report.inputHashes.afterEvidence) {
    throw new Error("写入后的 evidence hash 与机械修复计划不一致。");
  }
  const writtenMigration = await optionalReadJson(migrationPath);
  if (result.evidenceMigration) {
    if (writtenMigration === null
      || sha256Value(writtenMigration) !== result.report.inputHashes.afterEvidenceMigration
      || writtenMigration.inputHashes?.newEvidence !== result.report.inputHashes.afterEvidence) {
      throw new Error("写入后的 evidence-migration 与机械修复计划不一致。");
    }
  } else if (writtenMigration !== null) {
    throw new Error("机械修复不得创建此前不存在的 evidence-migration。");
  }
  await writeJson(reportPath, result.report);
  return { ...result, evidencePath, migrationPath, claimReviewPath, reportPath, written: true };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const unknownOptions = args.filter((argument) => argument.startsWith("--") && argument !== "--dry-run");
    const positionals = args.filter((argument) => !argument.startsWith("--"));
    if (unknownOptions.length || positionals.length !== 1) {
      throw new Error("用法：node scripts/claim-mechanical-fix.mjs cases/<slug> [--dry-run]");
    }
    const result = await fixClaimMechanicalQuotes(resolveCaseDir(positionals[0]), { dryRun });
    if (dryRun) console.log(JSON.stringify(result.report, null, 2));
    else console.log(`机械 quote 修复完成：${result.report.caseId}；补全 ${result.changes.length} 个 support span。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
