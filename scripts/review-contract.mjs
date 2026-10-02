import crypto from "node:crypto";

export const REVIEW_ROLES = Object.freeze([
  "claim_auditor",
  "blind_recall",
  "alignment",
  "coverage_a",
  "coverage_b",
  "fidelity",
  "reader_advocate",
  "adjudicator",
  "repair_editor",
]);

export function repairRoundLimitForCase(config, caseIdentity) {
  const configuredDefault = config?.reviews?.maximumRepairRounds ?? 2;
  const identity = typeof caseIdentity === "string"
    ? { id: caseIdentity }
    : (caseIdentity ?? {});
  const caseNumber = identity.caseNumber
    ?? String(identity.id ?? identity.caseId ?? "").match(/^qr-(\d{4})-/u)?.[1]?.replace(/^/u, "QR-");
  const overrides = config?.reviews?.repairRoundOverrides ?? {};
  const configuredOverride = overrides[caseNumber]
    ?? overrides[identity.id]
    ?? overrides[identity.caseId];
  const limit = configuredOverride ?? configuredDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > 99) {
    throw new Error("reviews 修复轮次上限必须为 1–99 的整数。");
  }
  return limit;
}

export function supplementalClaimRepairContractErrors(log, {
  caseId,
  repairRound,
  reviewerId,
  claimAuditorId,
  claimReviewHash,
  inputHashes,
  outputHashes,
}) {
  const errors = [];
  if (log?.schemaVersion !== "1.0.0") errors.push("claim-repair-log.schemaVersion 必须为 1.0.0。");
  if (log?.caseId !== caseId) errors.push("claim-repair-log.caseId 与案例不一致。");
  if (log?.role !== "evidence_repair_editor") errors.push("claim-repair-log.role 必须为 evidence_repair_editor。");
  if (log?.reviewerId !== reviewerId) errors.push("claim-repair-log.reviewerId 与补充 Repair Editor 不一致。");
  if (log?.reviewRound !== repairRound) errors.push("claim-repair-log.reviewRound 与补充修复轮次不一致。");
  if (log?.authority !== "repair_only_no_approval") errors.push("claim-repair-log 必须明确 repair_only_no_approval 权限。");
  if (log?.requiresFreshClaimAuditor !== true) errors.push("claim-repair-log 必须要求新的 Claim Auditor。");
  if (!Array.isArray(log?.issues) || log.issues.length === 0) errors.push("claim-repair-log.issues 不能为空。");
  if (!Array.isArray(log?.unresolved) || log.unresolved.length !== 0) errors.push("补充 claim 修复不得保留 unresolved。");

  for (const name of ["claimAuditorPacket", "claimReview", "round02RepairLog"]) {
    if (!HASH_PATTERN.test(log?.inputHashes?.[name] ?? "")) errors.push(`claim-repair-log.inputHashes.${name} 不是 SHA-256。`);
  }
  for (const [name, expected] of Object.entries(inputHashes ?? {})) {
    const actual = log?.inputHashes?.[name];
    if (!HASH_PATTERN.test(actual ?? "")) errors.push(`claim-repair-log.inputHashes.${name} 不是 SHA-256。`);
    else if (expected && actual !== expected) errors.push(`claim-repair-log.inputHashes.${name} 与正式 repair log 不一致。`);
  }
  for (const [name, expected] of Object.entries(outputHashes ?? {})) {
    const actual = log?.outputHashes?.[name];
    if (!HASH_PATTERN.test(actual ?? "")) errors.push(`claim-repair-log.outputHashes.${name} 不是 SHA-256。`);
    else if (expected && actual !== expected) errors.push(`claim-repair-log.outputHashes.${name} 与正式 repair log 不一致。`);
  }

  const postReview = log?.postRepairClaimReview;
  if (!HASH_PATTERN.test(postReview?.hash ?? "")) errors.push("claim-repair-log.postRepairClaimReview.hash 不是 SHA-256。");
  else if (claimReviewHash && postReview.hash !== claimReviewHash) errors.push("claim-repair-log.postRepairClaimReview.hash 已过期。");
  if (postReview?.reviewerId !== claimAuditorId) errors.push("补充修复后的 Claim Auditor reviewerId 不一致。");
  if (!Number.isInteger(postReview?.entryCount) || postReview.entryCount < 1) errors.push("补充修复后的 Claim Auditor entryCount 非法。");
  if (postReview?.passCount !== postReview?.entryCount) errors.push("补充修复后的 Claim Auditor 尚未全部通过。");
  return errors;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COVERAGE_VERDICTS = new Set(["covered", "partial", "missing", "contradicted", "unreviewable"]);
const COVERAGE_ISSUE_TYPES = new Set(["none", "importance_misclassified", "theme_misclassified", "provenance_conflict", "semantic_conflict", "insufficient_context"]);
const FIDELITY_VERDICTS = new Set(["supported", "partial", "unsupported"]);
const FIDELITY_PROVENANCE_VERDICTS = new Set(["correct", "wrong"]);
const FIDELITY_SEVERITIES = new Set(["none", "warning", "hard"]);
const FIDELITY_WARNING_ISSUE_KINDS = new Set(["minor_paraphrase", "minor_context", "minor_bridge"]);
const FIDELITY_HARD_ISSUE_KINDS = new Set([
  "fabrication",
  "contradiction",
  "misattribution",
  "material_distortion",
  "invalid_external",
  "quote_integrity",
]);
const READER_REVIEW_VERDICTS = new Set(["pass", "revise"]);
const READER_ISSUE_SEVERITIES = new Set(["error", "warning"]);
const ELIGIBLE_SECTIONS = new Set(["overview", "themes"]);
const ELIGIBLE_TYPES = new Set(["prose_group", "structured_list", "quote"]);
const SOURCE_PROVENANCES = new Set(["source_fact", "speaker_view"]);

export function reviewWorkflowVersion(config) {
  const configured = config?.reviews?.version;
  if (configured === undefined || configured === null || configured === "") return "2.2.0";
  if (typeof configured !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(configured)) {
    throw new TypeError("reviews.version must be a semantic version path segment.");
  }
  return configured;
}


export function coverageClaimsForReview(claims, deepRead, workflowVersion = "2.2.0") {
  const [major = 0, minor = 0] = String(workflowVersion).split(".").map(Number);
  const readerFirst = major > 2 || (major === 2 && minor >= 3);
  if (!readerFirst) return claims.filter((claim) => ["high", "medium"].includes(claim.importance));
  const bodyRefs = new Set([...eligibleReaderLeaves(deepRead).values()]
    .flatMap((leaf) => leaf.evidenceRefs ?? []));
  return claims.filter((claim) => bodyRefs.has(claim.id));
}

export const LEGACY_MISSING_SUPPORT_QUOTE_ISSUE = "supportSpans.quote 为空；需逐字复制对应连续 sourceUnits 作为规范化引文。";

export function isLegacyMissingSupportQuoteEntry(entry) {
  return Boolean(entry)
    && entry.verdict === "revise"
    && entry.atomicity === "pass"
    && entry.support === "supported"
    && entry.importance?.verdict === "confirmed"
    && entry.importance?.proposed === null
    && entry.theme?.verdict === "confirmed"
    && entry.theme?.proposedThemeId === null
    && ["confirmed", "unknown_safe"].includes(entry.speaker)
    && Array.isArray(entry.issues)
    && entry.issues.length === 1
    && entry.issues[0] === LEGACY_MISSING_SUPPORT_QUOTE_ISSUE
    && (!Array.isArray(entry.mergeWithRefs) || entry.mergeWithRefs.length === 0)
    && (!Array.isArray(entry.replacementStatements) || entry.replacementStatements.length === 0);
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("不能哈希非有限数字。");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError(`不能哈希 ${typeof value} 值。`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Value(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function normalizeReviewText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function collectReaderLeaves(deepRead) {
  const index = new Map();
  const duplicates = new Set();
  const add = (node, block, section, module) => {
    if (!node?.id) return;
    if (index.has(node.id)) duplicates.add(node.id);
    index.set(node.id, {
      id: node.id,
      text: node.text ?? node.title ?? "",
      evidenceRefs: [...new Set(node.evidenceRefs ?? block.evidenceRefs ?? [])],
      citationRefs: [...new Set(node.citationRefs ?? block.citationRefs ?? [])],
      sectionId: section.id,
      moduleId: module.id,
      blockId: block.id,
      type: block.type,
      provenance: node.provenance ?? block.provenance,
    });
  };
  for (const section of deepRead?.sections ?? []) {
    for (const module of section.modules ?? []) {
      for (const block of module.blocks ?? []) {
        if (block.type === "prose_group") for (const paragraph of block.paragraphs ?? []) add(paragraph, block, section, module);
        else if (["structured_list", "timeline"].includes(block.type)) for (const item of block.items ?? []) add(item, block, section, module);
        else add(block, block, section, module);
      }
    }
  }
  return { index, duplicates };
}

export function readerLeafIndex(deepRead) {
  return collectReaderLeaves(deepRead).index;
}

export function isEligibleCoverageLeaf(leaf) {
  return Boolean(leaf && ELIGIBLE_SECTIONS.has(leaf.sectionId) && ELIGIBLE_TYPES.has(leaf.type) && SOURCE_PROVENANCES.has(leaf.provenance));
}

export function eligibleReaderLeaves(deepRead) {
  return new Map([...readerLeafIndex(deepRead)].filter(([, leaf]) => isEligibleCoverageLeaf(leaf)));
}

export function fidelityReaderLeaves(deepRead) {
  const auditableProvenance = new Set(["source_fact", "speaker_view", "external", "editorial"]);
  return new Map([...readerLeafIndex(deepRead)].filter(([, leaf]) =>
    auditableProvenance.has(leaf.provenance)
      || (leaf.provenance === "system" && (leaf.evidenceRefs?.length || leaf.citationRefs?.length))));
}

function baseArtifactErrors(artifact, { label, schemaVersion = "1.0.0", caseId, role, inputHashes = {}, requireReviewer = true }) {
  const errors = [];
  if (!artifact || typeof artifact !== "object") return [`${label} 缺失或不是对象。`];
  const serialized = JSON.stringify(artifact);
  if (/\uFFFD|\?{2,}/u.test(serialized)) errors.push(`${label} 含有损坏字符或问号占位文本。`);
  const acceptedSchemaVersions = Array.isArray(schemaVersion) ? schemaVersion : [schemaVersion];
  if (!acceptedSchemaVersions.includes(artifact.schemaVersion)) {
    errors.push(`${label}.schemaVersion 必须为 ${acceptedSchemaVersions.join(" 或 ")}。`);
  }
  if (caseId && artifact.caseId !== caseId) errors.push(`${label}.caseId 与案例不一致。`);
  if (role && artifact.role !== role && !(Array.isArray(role) && role.includes(artifact.role))) errors.push(`${label}.role 非法，应为 ${Array.isArray(role) ? role.join("/") : role}。`);
  if (requireReviewer && !artifact.reviewerId) errors.push(`${label}.reviewerId 缺失。`);
  for (const [name, expected] of Object.entries(inputHashes)) {
    const actual = artifact.inputHashes?.[name];
    if (!HASH_PATTERN.test(actual ?? "")) errors.push(`${label}.inputHashes.${name} 不是 SHA-256。`);
    else if (expected && actual !== expected) errors.push(`${label}.inputHashes.${name} 已过期。`);
  }
  return errors;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function entryIndex(entries, key, label, errors) {
  const map = new Map();
  for (const entry of entries ?? []) {
    const id = entry?.[key];
    if (!id) {
      errors.push(`${label} 存在缺少 ${key} 的条目。`);
      continue;
    }
    if (map.has(id)) errors.push(`${label} 重复条目：${id}`);
    map.set(id, entry);
  }
  return map;
}

function quoteErrors({ verifiedQuotes = [], blockRefs = [], leaves, claim = null, label }) {
  const errors = [];
  const refs = new Set(blockRefs);
  const quoted = new Set();
  for (const quote of verifiedQuotes) {
    const blockRef = quote?.readerBlockRef;
    const leaf = leaves.get(blockRef);
    quoted.add(blockRef);
    if (!refs.has(blockRef)) errors.push(`${label} 的 verifiedQuote 未列入 readerBlockRefs：${blockRef}`);
    if (!leaf) {
      errors.push(`${label} 指向未知 reader block：${blockRef}`);
      continue;
    }
    if (!isEligibleCoverageLeaf(leaf)) errors.push(`${label} 指向不可计覆盖的 ${leaf.sectionId}/${leaf.type}/${leaf.provenance}：${blockRef}`);
    const needle = normalizeReviewText(quote?.readerTextQuote);
    if (needle.length < 6 || !normalizeReviewText(leaf.text).includes(needle)) errors.push(`${label} 的 readerTextQuote 不是 ${blockRef} 的精确文本片段。`);
    if (claim) {
      const bothSourceDerived = SOURCE_PROVENANCES.has(leaf.provenance) && SOURCE_PROVENANCES.has(claim.provenance);
      if (!bothSourceDerived && leaf.provenance !== claim.provenance) {
        errors.push(`${label} 的来源类别与 ${claim.id} 不一致。`);
      }
    }
  }
  for (const blockRef of refs) if (!quoted.has(blockRef)) errors.push(`${label} 缺少 ${blockRef} 的 verifiedQuote。`);
  return errors;
}

export function reviewManifestContractErrors(manifest, {
  caseId,
  inputHashes = {},
  workflowVersion = "2.2.0",
  requireClaimReviewResolution = false,
} = {}) {
  const errors = baseArtifactErrors(manifest, { label: "review-manifest", caseId, inputHashes, requireReviewer: false });
  if (manifest?.workflowVersion !== workflowVersion) errors.push(`review-manifest.workflowVersion 必须为 ${workflowVersion}。`);
  const requiredHashes = ["segments", "evidence", "claimReview", "deepRead", "readerMap", "claimBundles", "research"];
  if (requireClaimReviewResolution) requiredHashes.push("claimReviewResolution");
  for (const name of requiredHashes) {
    if (!HASH_PATTERN.test(manifest?.inputHashes?.[name] ?? "")) errors.push(`review-manifest.inputHashes.${name} 不是 SHA-256。`);
  }
  if (requireClaimReviewResolution && !manifest?.artifacts?.claimReviewResolution) {
    errors.push("review-manifest.artifacts.claimReviewResolution 缺失。");
  }
  if (Object.hasOwn(manifest?.inputHashes ?? {}, "evidenceMigration") && !HASH_PATTERN.test(manifest.inputHashes.evidenceMigration ?? "")) {
    errors.push("review-manifest.inputHashes.evidenceMigration 不是 SHA-256。");
  }
  if (Object.hasOwn(manifest?.inputHashes ?? {}, "themeMap") && !HASH_PATTERN.test(manifest.inputHashes.themeMap ?? "")) {
    errors.push("review-manifest.inputHashes.themeMap is not SHA-256.");
  }
  const assignments = entryIndex(manifest?.assignments, "role", "review-manifest.assignments", errors);
  for (const role of REVIEW_ROLES) if (!assignments.has(role)) errors.push(`review-manifest 缺少角色：${role}`);
  for (const role of assignments.keys()) if (!REVIEW_ROLES.includes(role)) errors.push(`review-manifest 包含未知角色：${role}`);
  const id = (role) => assignments.get(role)?.reviewerId;
  if (id("coverage_a") && id("coverage_a") === id("coverage_b")) errors.push("coverage_a 与 coverage_b 必须由不同审核员承担。");
  if (id("blind_recall") && id("blind_recall") === id("alignment")) errors.push("blind_recall 与 alignment 必须由不同审核员承担。");
  if (id("adjudicator") && [id("coverage_a"), id("coverage_b"), id("repair_editor")].includes(id("adjudicator"))) errors.push("adjudicator 不得兼任 coverage_a、coverage_b 或 repair_editor。");
  if (id("repair_editor") && ["claim_auditor", "coverage_a", "coverage_b", "fidelity", "reader_advocate"].some((role) => id(role) === id("repair_editor"))) errors.push("repair_editor 不得兼任内容审核角色。");
  if (id("blind_recall") && ["claim_auditor", "alignment", "repair_editor"].some((role) => id(role) === id("blind_recall"))) errors.push("blind_recall 必须与接触 evidence 的角色隔离。");
  if (id("reader_advocate") && ["claim_auditor", "fidelity", "repair_editor"].some((role) => id(role) === id("reader_advocate"))) errors.push("reader_advocate 必须保持 evidence-blind。");
  const uniqueReviewers = new Set([...assignments.values()].map((item) => item.reviewerId).filter(Boolean));
  if (uniqueReviewers.size !== REVIEW_ROLES.length) errors.push("九个审核角色必须分别使用唯一 reviewerId 和独立上下文。");
  return errors;
}

function readerMapV21ContractErrors(readerMap, { caseId, claims, deepRead }) {
  const errors = [];
  if (!readerMap || typeof readerMap !== "object") return ["reader-map is missing or is not an object."];
  if (readerMap.caseId !== caseId) errors.push("reader-map.caseId does not match the case.");
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const { index: leaves, duplicates } = collectReaderLeaves(deepRead);
  for (const duplicate of duplicates) errors.push(`deep-read reader block ID is duplicated: ${duplicate}.`);
  const entries = entryIndex(readerMap?.entries, "evidenceRef", "reader-map.entries", errors);
  for (const [evidenceRef, entry] of entries) {
    const claim = claimById.get(evidenceRef);
    if (!claim) {
      errors.push(`reader-map references an unknown claim: ${evidenceRef}.`);
      continue;
    }
    if (entry.importance !== claim.importance) {
      errors.push(`reader-map importance does not match claim: ${evidenceRef}.`);
    }
    if (!["explicit", "synthesized"].includes(entry.presentation)) {
      errors.push(`reader-map 2.1 entries must be explicit or synthesized: ${evidenceRef}.`);
    }
    const spans = entry.coverageSpans ?? [];
    if (!spans.length || spans.length > 2) {
      errors.push(`reader-map ${evidenceRef} must contain one or two coverageSpans.`);
    }
    if (entry.presentation === "explicit" && spans.length !== 1) {
      errors.push(`reader-map explicit entry ${evidenceRef} must contain exactly one coverageSpan.`);
    }
    const spanKeys = spans.map((span) => `${span.readerBlockRef}\u0000${normalizeReviewText(span.readerTextQuote)}`);
    if (duplicateValues(spanKeys).size) errors.push(`reader-map ${evidenceRef} contains duplicate coverageSpans.`);
    for (const span of spans) {
      const leaf = leaves.get(span.readerBlockRef);
      const label = `reader-map ${evidenceRef}`;
      errors.push(...quoteErrors({ verifiedQuotes: [span], blockRefs: [span.readerBlockRef], leaves, claim, label }));
      if (leaf && !(leaf.evidenceRefs ?? []).includes(evidenceRef)) {
        errors.push(`${label} is not declared in ${span.readerBlockRef}.evidenceRefs.`);
      }
    }
  }
  return errors;
}

export function readerMapV2ContractErrors(readerMap, { caseId, claims, deepRead, maximumClaimsPerBlock = 10 }) {
  if (readerMap?.schemaVersion === "2.1.0") {
    return readerMapV21ContractErrors(readerMap, { caseId, claims, deepRead });
  }
  const errors = [];
  if (!readerMap || typeof readerMap !== "object") return ["reader-map 缺失或不是对象。"];
  if (readerMap.schemaVersion !== "2.0.0") errors.push("reader-map.schemaVersion 必须为 2.0.0。");
  if (readerMap.caseId !== caseId) errors.push("reader-map.caseId 与案例不一致。");
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const { index: leaves, duplicates } = collectReaderLeaves(deepRead);
  for (const duplicate of duplicates) errors.push(`deep-read reader block ID 重复：${duplicate}`);
  const entries = entryIndex(readerMap?.entries, "evidenceRef", "reader-map.entries", errors);
  for (const [evidenceRef, entry] of entries) {
    const claim = claimById.get(evidenceRef);
    if (!claim) {
      errors.push(`reader-map 引用未知 claim：${evidenceRef}`);
      continue;
    }
    if (entry.importance !== claim.importance) errors.push(`reader-map 重要度与 claim 不一致：${evidenceRef}`);
    if (!["explicit", "synthesized", "evidence_only", "unmapped"].includes(entry.presentation)) errors.push(`reader-map.presentation 非法：${evidenceRef}`);
    const spans = entry.coverageSpans ?? [];
    if (["evidence_only", "unmapped"].includes(entry.presentation)) {
      if (entry.presentation === "evidence_only" && claim.importance !== "low") errors.push(`高、中重要度 claim 不得 evidence_only：${evidenceRef}`);
      if (spans.length) errors.push(`${entry.presentation} 不得包含 coverageSpans：${evidenceRef}`);
      continue;
    }
    if (!spans.length || spans.length > 2) errors.push(`reader-map ${evidenceRef} 必须有 1–2 个 coverageSpans。`);
    if (entry.presentation === "explicit" && spans.length !== 1) errors.push(`explicit 映射必须恰有一个 coverageSpan：${evidenceRef}`);
    const spanKeys = spans.map((span) => `${span.readerBlockRef}\u0000${normalizeReviewText(span.readerTextQuote)}`);
    if (duplicateValues(spanKeys).size) errors.push(`reader-map ${evidenceRef} 包含重复 coverageSpan。`);
    for (const span of spans) {
      const leaf = leaves.get(span.readerBlockRef);
      const label = `reader-map ${evidenceRef}`;
      errors.push(...quoteErrors({ verifiedQuotes: [span], blockRefs: [span.readerBlockRef], leaves, claim, label }));
      if (leaf && !(leaf.evidenceRefs ?? []).includes(evidenceRef)) errors.push(`${label} 未在 ${span.readerBlockRef}.evidenceRefs 中直接登记。`);
    }
  }
  for (const claim of claims) if (!entries.has(claim.id)) errors.push(`reader-map 缺少 claim：${claim.id}`);
  const highMediumIds = new Set(claims.filter((claim) => ["high", "medium"].includes(claim.importance)).map((claim) => claim.id));
  const blockLoads = new Map();
  for (const [evidenceRef, entry] of entries) {
    if (!highMediumIds.has(evidenceRef) || !["explicit", "synthesized"].includes(entry.presentation)) continue;
    for (const span of entry.coverageSpans ?? []) {
      if (!blockLoads.has(span.readerBlockRef)) blockLoads.set(span.readerBlockRef, new Set());
      blockLoads.get(span.readerBlockRef).add(evidenceRef);
    }
  }
  for (const [blockRef, refs] of blockLoads) {
    if (refs.size > maximumClaimsPerBlock) errors.push(`reader block ${blockRef} 声明承接 ${refs.size} 条高、中 claim，超过 ${maximumClaimsPerBlock} 条硬上限。`);
  }
  return errors;
}

export function claimReviewContractErrors(review, { caseId, claims, segmentsHash, evidenceHash = sha256Value(claims) }) {
  const errors = baseArtifactErrors(review, {
    label: "claim-review",
    caseId,
    role: "claim_auditor",
    inputHashes: { segments: segmentsHash, evidence: evidenceHash },
  });
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const entries = entryIndex(review?.entries, "evidenceRef", "claim-review.entries", errors);
  for (const [ref, entry] of entries) {
    const claim = claimsById.get(ref);
    if (!claim) {
      errors.push(`claim-review 引用未知 claim：${ref}`);
      continue;
    }
    const mergeRefs = entry.mergeWithRefs ?? [];
    if (entry.verdict === "merge") {
      if (mergeRefs.length !== 1) errors.push(`claim-review ${ref} 的 merge 必须指定唯一 canonical claim。`);
      for (const targetRef of mergeRefs) {
        if (targetRef === ref) errors.push(`claim-review ${ref} 不得合并到自身。`);
        else if (!claimsById.has(targetRef)) errors.push(`claim-review ${ref} 合并到未知 claim：${targetRef}`);
      }
    } else if (mergeRefs.length) {
      errors.push(`claim-review ${ref} 非 merge verdict 不得携带 mergeWithRefs。`);
    }
    if (entry.verdict === "split" && (entry.replacementStatements?.length ?? 0) < 2) {
      errors.push(`claim-review ${ref} 的 split 必须提供至少两条原子 replacementStatements。`);
    }
    if (entry.verdict === "pass" && (entry.replacementStatements?.length ?? 0)) {
      errors.push(`claim-review ${ref} 已 pass，不得携带 replacementStatements。`);
    }
    if (entry.verdict !== "pass") errors.push(`claim-review 尚未修复 ${ref}：${entry.verdict}`);
    if (entry.atomicity !== "pass") errors.push(`claim ${ref} 不是原子命题。`);
    if (entry.support !== "supported") errors.push(`claim ${ref} 未获完整来源支持。`);
    if (entry.importance?.verdict !== "confirmed" || entry.importance?.proposed !== null) errors.push(`claim ${ref} 的重要度尚未确认。`);
    if (entry.theme?.verdict !== "confirmed" || entry.theme?.proposedThemeId !== null) errors.push(`claim ${ref} 的主题尚未确认。`);
    if (!entry.speaker || entry.speaker === "change") errors.push(`claim ${ref} 的说话人归属尚未确认。`);
    if (entry.issues?.length) errors.push(`claim ${ref} 仍有未解决问题。`);
  }
  for (const claim of claims) if (!entries.has(claim.id)) errors.push(`claim-review 缺少 claim：${claim.id}`);
  return errors;
}

// A machine disposition of an auditor's organization advice, never an auditor
// pass. Explicit finding codes are required: legacy prose is not policy input.
export function claimOrganizationWarningDispositions(primary, { workflowVersion, claims = [] } = {}) {
  if (workflowVersion !== "2.4.2" || primary?.schemaVersion !== "1.1.0" || primary.auditMode !== "full") return [];
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  return (primary.entries ?? []).filter((entry) =>
    ["split", "revise"].includes(entry?.verdict)
    && entry.atomicity === "fail"
    && entry.support === "supported"
    && entry.importance?.verdict === "confirmed" && entry.importance.proposed === null
    && entry.theme?.verdict === "confirmed" && entry.theme.proposedThemeId === null
    && ["confirmed", "unknown_safe"].includes(entry.speaker)
    && Array.isArray(entry.findingCodes) && entry.findingCodes.length === 1 && entry.findingCodes[0] === "compound_claim"
    && Array.isArray(entry.issues) && entry.issues.length > 0
    && entry.issues.every((issue) => typeof issue === "string" && issue.trim().length > 0)
    && typeof entry.rationale === "string" && entry.rationale.trim().length > 0
    && (entry.mergeWithRefs ?? []).length === 0
    && Array.isArray(entry.replacementStatements ?? [])
    && (entry.replacementStatements ?? []).every((statement) => typeof statement === "string" && statement.trim().length > 0)
    && (entry.verdict !== "split" || (entry.replacementStatements?.length ?? 0) >= 2)
    && claimsById.has(entry.evidenceRef)
  ).map((entry) => ({
    evidenceRef: entry.evidenceRef,
    decision: "warning",
    basis: "supported_compound_organization",
    reviewPolicyVersion: "2.4.2",
    entryHash: sha256Value(entry),
    claimHash: sha256Value(claimsById.get(entry.evidenceRef)),
  })).sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));
}

export function claimReviewResolutionContractErrors(resolution, {
  caseId,
  reviewRound,
  segmentsHash,
  evidenceHash,
  claims = [],
  primary,
  mechanicalFix = null,
  secondary = null,
  adjudication = null,
  workflowVersion,
} = {}) {
  const errors = [];
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
    return ["claim-review-resolution is missing or is not an object."];
  }
  const serialized = JSON.stringify(resolution);
  if (/\uFFFD|\?{2,}/u.test(serialized)) errors.push("claim-review-resolution contains corrupted or placeholder text.");
  if (resolution.schemaVersion !== "1.0.0") errors.push("claim-review-resolution.schemaVersion must be 1.0.0.");
  if (resolution.workflowVersion !== "2.2.1") errors.push("claim-review-resolution.workflowVersion must be 2.2.1.");
  if (resolution.caseId !== caseId) errors.push("claim-review-resolution.caseId does not match the case.");
  if (resolution.role !== "claim_gate") errors.push("claim-review-resolution.role must be claim_gate.");
  if (resolution.reviewRound !== reviewRound) errors.push("claim-review-resolution.reviewRound does not match the formal review round.");
  if (resolution.status !== "pass") errors.push("claim-review-resolution.status must be pass.");
  if (!Array.isArray(resolution.contractErrors) || resolution.contractErrors.length) {
    errors.push("passing claim-review-resolution must have no contractErrors.");
  }
  if (!Array.isArray(resolution.semanticFailures) || resolution.semanticFailures.length) {
    errors.push("passing claim-review-resolution must have no semanticFailures.");
  }

  const checkHash = (name, expected) => {
    const actual = resolution.inputHashes?.[name];
    if (!HASH_PATTERN.test(actual ?? "")) errors.push("claim-review-resolution.inputHashes." + name + " is not SHA-256.");
    else if (expected && actual !== expected) errors.push("claim-review-resolution.inputHashes." + name + " is stale.");
  };
  const sameRefs = (actual, expected) => Array.isArray(actual)
    && duplicateValues(actual).size === 0
    && actual.length === expected.length
    && actual.every((ref) => expected.includes(ref));
  const claimRefs = claims.map((claim) => claim.id);
  const targetRefs = Array.isArray(resolution.targetRefs) ? resolution.targetRefs : [];
  const mechanicalBound = Object.hasOwn(resolution.inputHashes ?? {}, "mechanicalFix");
  checkHash("segments", segmentsHash);
  checkHash("evidence", evidenceHash);
  checkHash("primaryClaimReview", primary ? sha256Value(primary) : null);
  if (!primary) errors.push("claim-review-resolution requires the bound primary claim-review.");
  else {
    if (primary.caseId !== caseId || primary.role !== "claim_auditor") errors.push("primary claim-review identity does not match the resolution.");
    if (primary.reviewRound !== reviewRound) errors.push("primary claim-review round does not match the resolution.");
    if (primary.inputHashes?.segments !== segmentsHash) errors.push("primary claim-review segments are stale.");
    const expectedPrimaryEvidence = mechanicalBound && mechanicalFix
      ? mechanicalFix.inputHashes?.beforeEvidence
      : evidenceHash;
    if (primary.inputHashes?.evidence !== expectedPrimaryEvidence) errors.push("primary claim-review evidence is stale.");
    if (primary.auditMode === "targeted") errors.push("primary claim-review must be a full audit.");
    if (claimRefs.length) {
      if (!sameRefs((primary.entries ?? []).map((entry) => entry?.evidenceRef), claimRefs)) {
        errors.push("primary claim-review entries do not exactly cover current evidence.");
      }
      if (primary.schemaVersion === "1.1.0" && !sameRefs(primary.scope?.evidenceRefs, claimRefs)) {
        errors.push("primary claim-review scope does not exactly cover current evidence.");
      }
    }
    if (resolution.reviewerIds?.primary !== primary.reviewerId) errors.push("claim-review-resolution primary reviewer does not match the bound report.");
  }

  const boundArtifact = (hashName, artifact, label) => {
    const bound = Object.hasOwn(resolution.inputHashes ?? {}, hashName);
    if (!bound) return false;
    checkHash(hashName, artifact ? sha256Value(artifact) : null);
    if (!artifact) errors.push("claim-review-resolution binds missing " + label + ".");
    return true;
  };
  const hasMechanicalFix = boundArtifact("mechanicalFix", mechanicalFix, "claim-mechanical-fix");
  const hasSecondary = boundArtifact("secondaryClaimReview", secondary, "secondary claim-review");
  const hasAdjudication = boundArtifact("adjudication", adjudication, "claim adjudication");

  const expectedWarnings = claimOrganizationWarningDispositions(primary, { workflowVersion, claims });
  const carriesWarnings = Object.hasOwn(resolution, "warningDispositions");
  if (carriesWarnings || expectedWarnings.length) {
    if (workflowVersion !== "2.4.2") errors.push("claim organization warnings require the current case workflow 2.4.2.");
    if (!Array.isArray(resolution.warningDispositions) || !resolution.warningDispositions.length
      || sha256Value(resolution.warningDispositions) !== sha256Value(expectedWarnings)) {
      errors.push("claim-review-resolution warningDispositions are missing, stale, or not supported compound-only findings.");
    }
  }
  if (workflowVersion === "2.4.2" || carriesWarnings) {
    const warningRefs = new Set(expectedWarnings.map((entry) => entry.evidenceRef));
    const mechanicallyResolved = new Set(hasMechanicalFix ? (mechanicalFix?.entries ?? [])
      .filter((entry) => entry?.status === "mechanically_resolved").map((entry) => entry.evidenceRef) : []);
    const requiredTargets = (primary?.entries ?? []).filter((entry) => {
      if (entry.verdict === "pass" || warningRefs.has(entry.evidenceRef)) return false;
      const quoteOnly = entry.findingCodes?.length === 1 && entry.findingCodes[0] === "missing_support_quote"
        || primary.schemaVersion === "1.0.0" && isLegacyMissingSupportQuoteEntry(entry);
      return !(quoteOnly && mechanicallyResolved.has(entry.evidenceRef));
    }).map((entry) => entry.evidenceRef);
    if (!sameRefs(targetRefs, requiredTargets)) errors.push("claim-review-resolution targetRefs omit or invent unresolved primary findings.");
  }

  if (hasMechanicalFix && mechanicalFix) {
    if (mechanicalFix.schemaVersion !== "1.0.0" || mechanicalFix.workflowVersion !== "2.2.1"
      || mechanicalFix.caseId !== caseId || mechanicalFix.role !== "claim_mechanical_fix" || mechanicalFix.reviewRound !== reviewRound) {
      errors.push("claim-mechanical-fix identity does not match the resolution.");
    }
    if (mechanicalFix.inputHashes?.primaryClaimReview !== resolution.inputHashes.primaryClaimReview) {
      errors.push("claim-mechanical-fix does not bind the current primary claim-review.");
    }
    if (mechanicalFix.inputHashes?.afterEvidence !== evidenceHash) {
      errors.push("claim-mechanical-fix afterEvidence is stale.");
    }
    if (mechanicalFix.inputHashes?.beforeEvidence !== primary?.inputHashes?.evidence) {
      errors.push("claim-mechanical-fix beforeEvidence does not match the primary claim-review.");
    }
    if (mechanicalFix.inputHashes?.beforeQuoteIgnoredEvidence !== mechanicalFix.inputHashes?.afterQuoteIgnoredEvidence) {
      errors.push("claim-mechanical-fix changed quote-ignored evidence semantics.");
    }
    if (!(mechanicalFix.entries ?? []).every((entry) => entry?.findingCode === "missing_support_quote"
      && entry?.status === "mechanically_resolved")) {
      errors.push("claim-mechanical-fix contains a non-mechanical resolution.");
    }
  }
  if (hasSecondary && secondary) {
    if (secondary.caseId !== caseId || secondary.role !== "claim_auditor" || secondary.reviewRound !== reviewRound || secondary.auditMode !== "targeted") {
      errors.push("secondary claim-review identity does not match the resolution.");
    }
    if (secondary.inputHashes?.primaryClaimReview !== resolution.inputHashes.primaryClaimReview) {
      errors.push("secondary claim-review does not bind the current primary claim-review.");
    }
    if (secondary.inputHashes?.evidence !== evidenceHash) errors.push("secondary claim-review evidence is stale.");
    if (secondary.inputHashes?.segments !== segmentsHash) errors.push("secondary claim-review segments are stale.");
    if (secondary.inputHashes?.targetSet !== sha256Value([...targetRefs].sort())) errors.push("secondary claim-review target-set hash is stale.");
    if (!sameRefs(secondary.scope?.evidenceRefs, targetRefs)
      || !sameRefs((secondary.entries ?? []).map((entry) => entry?.evidenceRef), targetRefs)) {
      errors.push("secondary claim-review scope does not match the resolution target set.");
    }
    if (resolution.reviewerIds?.secondary !== secondary.reviewerId) errors.push("claim-review-resolution secondary reviewer does not match the bound report.");
  }
  if (hasAdjudication && adjudication) {
    if (!hasSecondary) errors.push("claim adjudication cannot be bound without a secondary claim-review.");
    if (adjudication.caseId !== caseId || adjudication.role !== "claim_adjudicator" || adjudication.reviewRound !== reviewRound) {
      errors.push("claim adjudication identity does not match the resolution.");
    }
    if (adjudication.inputHashes?.primaryClaimReview !== resolution.inputHashes.primaryClaimReview
      || adjudication.inputHashes?.secondaryClaimReview !== resolution.inputHashes.secondaryClaimReview) {
      errors.push("claim adjudication does not bind the current claim reviews.");
    }
    if (adjudication.inputHashes?.evidence !== evidenceHash) errors.push("claim adjudication evidence is stale.");
    if (adjudication.inputHashes?.segments !== segmentsHash) errors.push("claim adjudication segments are stale.");
    if (adjudication.inputHashes?.targetSet !== sha256Value([...targetRefs].sort())) errors.push("claim adjudication target-set hash is stale.");
    const conflictRefs = (resolution.conflicts ?? []).map((conflict) => conflict?.evidenceRef);
    if (!sameRefs((adjudication.entries ?? []).map((entry) => entry?.evidenceRef), conflictRefs)) {
      errors.push("claim adjudication scope does not match the resolution conflicts.");
    }
    if (resolution.reviewerIds?.adjudicator !== adjudication.reviewerId) errors.push("claim-review-resolution adjudicator does not match the bound report.");
  }

  if (!Array.isArray(resolution.targetRefs) || duplicateValues(targetRefs).size) errors.push("claim-review-resolution.targetRefs must be a unique array.");
  if (targetRefs.length && !hasSecondary) errors.push("passing claim-review-resolution with targeted findings must bind a secondary claim-review.");
  const conflicts = Array.isArray(resolution.conflicts) ? resolution.conflicts : [];
  if (conflicts.length && !hasAdjudication) errors.push("passing claim-review-resolution with conflicts must bind adjudication.");
  const decisions = Array.isArray(resolution.decisions) ? resolution.decisions : [];
  if (decisions.some((decision) => decision?.verdict !== "pass")) errors.push("passing claim-review-resolution cannot retain a nonpass decision.");
  if (resolution.metrics?.targetCount !== targetRefs.length) errors.push("claim-review-resolution targetCount does not match targetRefs.");
  if (resolution.metrics?.resolvedNonpassCount !== 0) errors.push("passing claim-review-resolution resolvedNonpassCount must be zero.");
  if (!Number.isInteger(resolution.metrics?.mechanicalResolvedCount) || resolution.metrics.mechanicalResolvedCount < 0) {
    errors.push("claim-review-resolution mechanicalResolvedCount is invalid.");
  } else {
    const primaryMechanicalRefs = new Set((primary?.entries ?? [])
      .filter((entry) => entry?.findingCodes?.includes("missing_support_quote")
        || (primary?.schemaVersion === "1.0.0" && isLegacyMissingSupportQuoteEntry(entry)))
      .map((entry) => entry.evidenceRef));
    const reportRefs = new Set(hasMechanicalFix ? (mechanicalFix?.entries ?? []).map((entry) => entry?.evidenceRef) : []);
    const expectedMechanicalResolvedCount = [...primaryMechanicalRefs].filter((ref) => reportRefs.has(ref)).length;
    if (resolution.metrics.mechanicalResolvedCount !== expectedMechanicalResolvedCount) {
      errors.push("claim-review-resolution mechanicalResolvedCount must count only repaired explicit or bridge-proven legacy missing_support_quote findings.");
    }
  }
  const reviewers = Object.values(resolution.reviewerIds ?? {}).filter(Boolean);
  if (new Set(reviewers).size !== reviewers.length) errors.push("claim gate reviewers must be independent.");
  return errors;
}

export function blindCandidateContractErrors(candidates, { caseId, segmentsHash }) {
  const errors = baseArtifactErrors(candidates, {
    label: "blind-candidates",
    schemaVersion: ["1.0.0", "1.1.0"],
    caseId,
    role: "blind_recall",
    inputHashes: { segments: segmentsHash },
  });
  if (candidates?.blindToEvidence !== true) errors.push("blind_recall 必须在不可见 evidence 的条件下完成。");
  const entries = entryIndex(candidates?.entries, "id", "blind-candidates.entries", errors);
  for (const [id, entry] of entries) {
    if (!/^BC\d{4,}$/u.test(id)) errors.push(`blind candidate ID 非法：${id}`);
    if (!entry.statement?.trim()) errors.push(`blind candidate 缺少 statement：${id}`);
    if (!entry.supportSpans?.length) errors.push(`blind candidate 缺少 supportSpans：${id}`);
  }
  if (!entries.size) errors.push("blind-candidates 不得为空。");
  return errors;
}

export function blindAlignmentContractErrors(alignment, { caseId, candidates, claims, evidenceHash = sha256Value(claims) }) {
  const errors = baseArtifactErrors(alignment, {
    label: "blind-alignment",
    schemaVersion: ["1.0.0", "1.1.0"],
    caseId,
    role: "alignment",
    inputHashes: { blindCandidates: sha256Value(candidates), evidence: evidenceHash },
  });
  if (alignment?.reviewerId && alignment.reviewerId === candidates?.reviewerId) errors.push("alignment 不得由 blind_recall 审核员完成。");
  const candidateById = new Map((candidates?.entries ?? []).map((entry) => [entry.id, entry]));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const entries = entryIndex(alignment?.entries, "candidateRef", "blind-alignment.entries", errors);
  for (const [ref, entry] of entries) {
    if (!candidateById.has(ref)) errors.push(`blind-alignment 引用未知 candidate：${ref}`);
    for (const evidenceRef of entry.matchedEvidenceRefs ?? []) if (!claimIds.has(evidenceRef)) errors.push(`blind-alignment 引用未知 claim：${evidenceRef}`);
    if (["equivalent", "subsumed"].includes(entry.relation) && !entry.matchedEvidenceRefs?.length) errors.push(`${ref} 的 ${entry.relation} 对齐缺少 matchedEvidenceRefs。`);
    if (["equivalent", "subsumed"].includes(entry.relation) && entry.missingFacets?.length) errors.push(`${ref} 已完整对齐却仍有 missingFacets。`);
    if (entry.relation === "partial" && !entry.missingFacets?.length) errors.push(`${ref} 的 partial 对齐必须说明缺失语义。`);
    if (entry.relation === "unmatched" && entry.matchedEvidenceRefs?.length) errors.push(`${ref} 标为 unmatched 却包含 matchedEvidenceRefs。`);
  }
  for (const candidate of candidates?.entries ?? []) if (!entries.has(candidate.id)) errors.push(`blind-alignment 缺少 candidate：${candidate.id}`);
  return errors;
}

export function blindRecallMetrics(candidates, alignment) {
  const aligned = new Map((alignment?.entries ?? []).map((entry) => [entry.candidateRef, entry]));
  const entries = candidates?.entries ?? [];
  const matched = entries.filter((candidate) => ["equivalent", "subsumed"].includes(aligned.get(candidate.id)?.relation));
  const highMedium = entries.filter((candidate) => ["high", "medium"].includes(candidate.importance));
  const matchedHighMedium = highMedium.filter((candidate) => ["equivalent", "subsumed"].includes(aligned.get(candidate.id)?.relation));
  return {
    candidateCount: entries.length,
    matchedCount: matched.length,
    allRecall: entries.length ? matched.length / entries.length : 0,
    highMediumCandidateCount: highMedium.length,
    highMediumMatchedCount: matchedHighMedium.length,
    highMediumRecall: highMedium.length ? matchedHighMedium.length / highMedium.length : 0,
  };
}

export function coverageReviewContractErrors(review, {
  caseId,
  claims,
  deepRead,
  evidenceHash = sha256Value(claims),
  deepReadHash = sha256Value(deepRead),
  expectedRole,
  forbiddenReviewerIds = [],
}) {
  const errors = baseArtifactErrors(review, {
    label: expectedRole ?? "coverage-review",
    caseId,
    role: expectedRole ?? ["coverage_a", "coverage_b"],
    inputHashes: { evidence: evidenceHash, deepRead: deepReadHash },
  });
  if (review?.blindToReaderMap !== true || review?.blindToPeerReview !== true) errors.push(`${review?.role ?? "coverage-review"} 必须同时对 reader-map 和同伴结果双盲。`);
  if (forbiddenReviewerIds.includes(review?.reviewerId)) errors.push(`${review?.role ?? "coverage-review"} reviewerId 与受限角色重复。`);
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const bodyRefs = new Set([...eligibleReaderLeaves(deepRead).values()]
    .flatMap((leaf) => leaf.evidenceRefs ?? []));
  const required = claims.filter((claim) => bodyRefs.has(claim.id));
  const leaves = readerLeafIndex(deepRead);
  const entries = entryIndex(review?.entries, "evidenceRef", `${review?.role ?? "coverage-review"}.entries`, errors);
  for (const [ref, entry] of entries) {
    const claim = claimById.get(ref);
    if (!claim || !bodyRefs.has(ref)) {
      errors.push(`${review?.role ?? "coverage-review"} 引用未在正文使用的 claim：${ref}`);
      continue;
    }
    if (!COVERAGE_VERDICTS.has(entry.verdict)) errors.push(`${ref} coverage verdict 非法。`);
    if (typeof entry.confidence !== "number" || entry.confidence < 0 || entry.confidence > 1) errors.push(`${review.role} ${ref} confidence 必须为 0–1。`);
    if (!COVERAGE_ISSUE_TYPES.has(entry.issueType)) errors.push(`${review.role} ${ref} issueType 非法。`);
    errors.push(...quoteErrors({ verifiedQuotes: entry.verifiedQuotes, blockRefs: entry.readerBlockRefs, leaves, claim, label: `${review.role} ${ref}` }));
    if (entry.verdict === "covered") {
      if (!entry.readerBlockRefs?.length || !entry.materialFacets?.length) errors.push(`${review.role} ${ref} 判为 covered 但缺少 block 或 materialFacets。`);
      if (entry.missingFacets?.length) errors.push(`${review.role} ${ref} 判为 covered 但仍有 missingFacets。`);
    }
    if (["partial", "missing"].includes(entry.verdict) && !entry.missingFacets?.length) errors.push(`${review.role} ${ref} 必须列出 missingFacets。`);
    if (["missing", "unreviewable"].includes(entry.verdict) && entry.readerBlockRefs?.length) errors.push(`${review.role} ${ref} 的 ${entry.verdict} verdict 不得伪造 reader block。`);
  }
  for (const claim of required) if (!entries.has(claim.id)) errors.push(`${review?.role ?? "coverage-review"} 缺少正文实际引用的 claim：${claim.id}`);
  return errors;
}

export function fidelityEntryHardReasons(entry, {
  schemaVersion = "1.0.0",
  research = { citations: [], checks: [] },
} = {}) {
  const citationIds = new Set((research?.citations ?? []).map((citation) => citation.id));
  const checkedCitationIds = new Set((research?.checks ?? []).flatMap((check) => check.citationRefs ?? []));
  const reasons = [];
  if (schemaVersion === "1.1.0") {
    if (entry?.provenanceVerdict === "wrong") reasons.push("provenance");
    if (entry?.severity === "hard" || FIDELITY_HARD_ISSUE_KINDS.has(entry?.issueKind)) {
      reasons.push(`hard:${entry?.issueKind ?? "unspecified"}`);
    }
  } else {
    if (entry?.verdict !== "supported") reasons.push("support");
    if (entry?.provenanceVerdict !== "correct") reasons.push("provenance");
    if (entry?.unsupportedText?.length) reasons.push("unsupported_text");
  }
  if (entry?.provenance === "external") for (const ref of entry?.citationRefs ?? []) {
    if (citationIds.has(ref) && !checkedCitationIds.has(ref)) reasons.push(`missing_research_check:${ref}`);
  }
  return [...new Set(reasons)];
}

function fidelityFinding(entry, reasons) {
  return {
    readerBlockRef: entry?.readerBlockRef ?? null,
    verdict: entry?.verdict ?? null,
    provenance: entry?.provenance ?? null,
    provenanceVerdict: entry?.provenanceVerdict ?? null,
    severity: entry?.severity ?? null,
    issueKind: entry?.issueKind ?? null,
    evidenceRefs: entry?.evidenceRefs ?? [],
    citationRefs: entry?.citationRefs ?? [],
    unsupportedText: entry?.unsupportedText ?? [],
    rationale: entry?.rationale ?? "",
    reasons,
  };
}

export function fidelityReviewGateFailures(review, { research = { citations: [], checks: [] } } = {}) {
  const entries = Array.isArray(review?.entries) ? review.entries : [];
  return entries.flatMap((entry) => {
    const reasons = fidelityEntryHardReasons(entry, { schemaVersion: review?.schemaVersion, research });
    return reasons.length ? [fidelityFinding(entry, reasons)] : [];
  });
}

export function fidelityReviewWarnings(review) {
  if (review?.schemaVersion !== "1.1.0") return [];
  return (Array.isArray(review?.entries) ? review.entries : []).flatMap((entry) => {
    if (entry?.severity !== "warning") return [];
    return [fidelityFinding(entry, [`warning:${entry?.issueKind ?? "unspecified"}`])];
  });
}

export function fidelityReviewContractErrors(review, {
  caseId,
  claims,
  deepRead,
  research = { citations: [] },
  evidenceHash = sha256Value(claims),
  deepReadHash = sha256Value(deepRead),
  researchHash = sha256Value(research),
  forbiddenReviewerIds = [],
  requirePass = false,
}) {
  const errors = baseArtifactErrors(review, {
    label: "fidelity-review",
    schemaVersion: ["1.0.0", "1.1.0"],
    caseId,
    role: "fidelity",
    inputHashes: { evidence: evidenceHash, deepRead: deepReadHash, research: researchHash },
  });
  if (forbiddenReviewerIds.includes(review?.reviewerId)) errors.push("fidelity reviewerId 与受限角色重复。");
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const citationIds = new Set((research?.citations ?? []).map((citation) => citation.id));
  const leaves = fidelityReaderLeaves(deepRead);
  const entries = entryIndex(Array.isArray(review?.entries) ? review.entries : [], "readerBlockRef", "fidelity-review.entries", errors);
  if (!Array.isArray(review?.entries)) errors.push("fidelity-review.entries 必须为数组。");
  for (const [blockRef, entry] of entries) {
    const leaf = leaves.get(blockRef);
    if (!leaf) {
      errors.push(`fidelity-review 引用未知或不可审计的 reader block：${blockRef}`);
      continue;
    }
    if (!FIDELITY_VERDICTS.has(entry.verdict)) errors.push(`reader block ${blockRef} fidelity verdict 非法。`);
    if (!FIDELITY_PROVENANCE_VERDICTS.has(entry.provenanceVerdict)) errors.push(`reader block ${blockRef} provenanceVerdict 非法。`);
    if (review?.schemaVersion === "1.1.0") {
      if (!FIDELITY_SEVERITIES.has(entry.severity)) errors.push(`reader block ${blockRef} severity 非法。`);
      if (![...FIDELITY_WARNING_ISSUE_KINDS, ...FIDELITY_HARD_ISSUE_KINDS, "none"].includes(entry.issueKind)) {
        errors.push(`reader block ${blockRef} issueKind 非法。`);
      }
      if (entry.verdict === "supported" && (entry.severity !== "none" || entry.issueKind !== "none" || entry.provenanceVerdict !== "correct" || entry.unsupportedText?.length)) {
        errors.push(`reader block ${blockRef} supported 必须使用 none/none、正确 provenance 且无 unsupportedText。`);
      }
      if (entry.verdict === "partial" && (entry.severity !== "warning" || !FIDELITY_WARNING_ISSUE_KINDS.has(entry.issueKind) || entry.provenanceVerdict !== "correct")) {
        errors.push(`reader block ${blockRef} partial 必须是 warning，并使用轻微问题类型与正确 provenance。`);
      }
      if (entry.verdict === "partial" && !entry.unsupportedText?.length) {
        errors.push(`reader block ${blockRef} partial 必须列出具体 unsupportedText。`);
      }
      if (entry.verdict === "unsupported" && (!["warning", "hard"].includes(entry.severity) || entry.issueKind === "none" || !entry.unsupportedText?.length)) {
        errors.push(`reader block ${blockRef} unsupported 必须列出具体文本，并使用 warning 或 hard 问题类型。`);
      }
      if (entry.severity === "none" && (entry.verdict !== "supported" || entry.issueKind !== "none")) {
        errors.push(`reader block ${blockRef} none severity 只允许用于 supported/none。`);
      }
      if (entry.provenanceVerdict === "wrong" && (entry.severity !== "hard" || entry.issueKind !== "misattribution")) {
        errors.push(`reader block ${blockRef} wrong provenance 必须是 hard/misattribution。`);
      }
      if (entry.severity === "hard" && !FIDELITY_HARD_ISSUE_KINDS.has(entry.issueKind)) {
        errors.push(`reader block ${blockRef} hard severity 必须使用硬错误 issueKind。`);
      }
      if (entry.severity === "warning" && !FIDELITY_WARNING_ISSUE_KINDS.has(entry.issueKind)) {
        errors.push(`reader block ${blockRef} warning severity 必须使用轻微问题 issueKind。`);
      }
    }
    if (!["source_fact", "speaker_view", "external", "editorial", "system"].includes(entry.provenance)) errors.push(`reader block ${blockRef} provenance 非法。`);
    for (const name of ["evidenceRefs", "citationRefs", "unsupportedText"]) if (!Array.isArray(entry[name])) errors.push(`reader block ${blockRef}.${name} 必须为数组。`);
    const evidenceRefs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [];
    const citationRefs = Array.isArray(entry.citationRefs) ? entry.citationRefs : [];
    if (!entry.rationale?.trim()) errors.push(`reader block ${blockRef} 缺少 rationale。`);
    if (entry.provenance !== leaf.provenance) errors.push(`reader block ${blockRef} 审核来源类别与正文不一致。`);
    if (["source_fact", "speaker_view", "system"].includes(leaf.provenance) && !entry.evidenceRefs?.length) {
      errors.push(`reader block ${blockRef} 缺少 evidenceRefs。`);
    }
    if (leaf.provenance === "external" && !entry.citationRefs?.length) errors.push(`外部 reader block ${blockRef} 缺少 citationRefs。`);
    if (leaf.provenance === "editorial" && leaf.type !== "editor_note") errors.push(`编辑内容 ${blockRef} 必须使用 editor_note。`);
    for (const ref of evidenceRefs) {
      const claim = claimById.get(ref);
      if (!claim) errors.push(`fidelity-review 引用未知 claim：${ref}`);
      else if (["source_fact", "speaker_view"].includes(leaf.provenance)
        && !["source_fact", "speaker_view"].includes(claim.provenance)) {
        errors.push(`reader block ${blockRef} 的来源型正文不得引用 ${claim.provenance} claim：${ref}。`);
      }
      if (!leaf.evidenceRefs.includes(ref)) errors.push(`reader block ${blockRef} 未登记 fidelity 引用 ${ref}。`);
    }
    for (const ref of leaf.evidenceRefs) {
      if (!evidenceRefs.includes(ref)) errors.push(`fidelity-review 未核验 reader block ${blockRef} 声明的 claim：${ref}`);
    }
    for (const ref of citationRefs) {
      if (!citationIds.has(ref)) errors.push(`fidelity-review 引用未知外部资料：${ref}`);
      if (!leaf.citationRefs.includes(ref)) errors.push(`reader block ${blockRef} 未登记 fidelity 外部引用 ${ref}。`);
    }
    for (const ref of leaf.citationRefs) {
      if (!citationRefs.includes(ref)) errors.push(`fidelity-review 未核验 reader block ${blockRef} 声明的外部引用：${ref}`);
    }
  }
  for (const blockRef of leaves.keys()) if (!entries.has(blockRef)) errors.push(`fidelity-review 缺少 reader block：${blockRef}`);
  if (requirePass) for (const failure of fidelityReviewGateFailures(review, { research })) {
    if (failure.reasons.some((reason) => reason.startsWith("hard:"))) {
      errors.push(`reader block ${failure.readerBlockRef} 存在 Fidelity 硬错误：${failure.issueKind}。`);
    } else {
      if (failure.verdict !== "supported") errors.push(`reader block ${failure.readerBlockRef} 未获完整来源支持：${failure.verdict}`);
      if (failure.provenanceVerdict !== "correct") errors.push(`reader block ${failure.readerBlockRef} 来源类别错误。`);
      if (failure.unsupportedText.length) errors.push(`reader block ${failure.readerBlockRef} 仍含未支持文本。`);
    }
    for (const reason of failure.reasons) if (reason.startsWith("missing_research_check:")) {
      errors.push(`外部 reader block ${failure.readerBlockRef} 的引用缺少 research check：${reason.slice("missing_research_check:".length)}`);
    }
  }
  return errors;
}

export function adjudicationContractErrors(adjudication, {
  caseId,
  claims,
  deepRead,
  coverageA,
  coverageB,
  evidenceHash = sha256Value(claims),
  deepReadHash = sha256Value(deepRead),
  forbiddenReviewerIds = [],
  confidenceThreshold = 0.8,
}) {
  const errors = baseArtifactErrors(adjudication, {
    label: "adjudication",
    caseId,
    role: "adjudicator",
    inputHashes: {
      evidence: evidenceHash,
      deepRead: deepReadHash,
      coverageA: sha256Value(coverageA),
      coverageB: sha256Value(coverageB),
    },
  });
  if (forbiddenReviewerIds.includes(adjudication?.reviewerId)) errors.push("adjudicator reviewerId 与 coverage 或 repair_editor 重复。");
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const leaves = readerLeafIndex(deepRead);
  const bodyRefs = new Set([...eligibleReaderLeaves(deepRead).values()]
    .flatMap((leaf) => leaf.evidenceRefs ?? []));
  const entries = entryIndex(adjudication?.entries, "evidenceRef", "adjudication.entries", errors);
  for (const [ref, entry] of entries) {
    const claim = claimById.get(ref);
    if (!claim || !bodyRefs.has(ref)) {
      errors.push(`adjudication 引用未在正文使用的 claim：${ref}`);
      continue;
    }
    if (!entry.triggers?.length) errors.push(`adjudication ${ref} 缺少 trigger。`);
    if (!COVERAGE_VERDICTS.has(entry.verdict)) errors.push(`adjudication ${ref} verdict 非法。`);
    if (typeof entry.confidence !== "number" || entry.confidence < 0 || entry.confidence > 1) errors.push(`adjudication ${ref} confidence 必须为 0–1。`);
    if (!COVERAGE_ISSUE_TYPES.has(entry.issueType)) errors.push(`adjudication ${ref} issueType 非法。`);
    errors.push(...quoteErrors({ verifiedQuotes: entry.verifiedQuotes, blockRefs: entry.readerBlockRefs, leaves, claim, label: `adjudication ${ref}` }));
    if (entry.verdict === "covered" && !entry.readerBlockRefs?.length) errors.push(`adjudication ${ref} 判为 covered 但缺少 reader block。`);
    if (entry.verdict === "covered" && entry.confidence < confidenceThreshold) errors.push(`adjudication ${ref} confidence 低于 ${confidenceThreshold}，不得通过。`);
    if (["missing", "unreviewable"].includes(entry.verdict) && entry.readerBlockRefs?.length) errors.push(`adjudication ${ref} 未覆盖却仍登记 reader block。`);
  }
  return errors;
}

function commonValues(first = [], second = []) {
  const other = new Set(second);
  return [...new Set(first)].filter((value) => other.has(value));
}

function coverageConflictTriggers(first, second, sharedBlocks, confidenceThreshold) {
  const triggers = [];
  // The adjudicator resolves genuine A/B disagreement. When both blind
  // reviewers independently agree that a claim is not covered, that is a
  // repair finding, not a dispute to be voted away.
  if (first && second && first.verdict === second.verdict && first.verdict !== "covered") return triggers;
  if (!first || !second || first.verdict !== second.verdict) triggers.push("verdict_conflict");
  if (first?.verdict === "covered" && second?.verdict === "covered" && !sharedBlocks.length) triggers.push("block_conflict");
  if ((first?.confidence ?? 0) < confidenceThreshold || (second?.confidence ?? 0) < confidenceThreshold) triggers.push("low_confidence");
  if (first?.verdict === "contradicted" || second?.verdict === "contradicted") triggers.push("contradiction");
  if ((first?.issueType && first.issueType !== "none") || (second?.issueType && second.issueType !== "none")) triggers.push("issue_type");
  return [...new Set(triggers)];
}

function manifestReviewerId(manifest, role) {
  return (manifest?.assignments ?? []).find((assignment) => assignment.role === role)?.reviewerId;
}

export function resolveCoverageConsensus({
  caseId,
  claims,
  deepRead,
  research = { citations: [] },
  readerMap,
  reviewManifest,
  segmentsHash,
  coverageA,
  coverageB,
  adjudication,
  fidelityReview,
  evidenceHash = sha256Value(claims),
  deepReadHash = sha256Value(deepRead),
  researchHash = sha256Value(research),
  denseBlockThreshold = 10,
  confidenceThreshold = 0.8,
}) {
  const errors = [];
  const expectedManifestHashes = {
    ...(segmentsHash ? { segments: segmentsHash } : {}),
    evidence: evidenceHash,
    deepRead: deepReadHash,
    readerMap: sha256Value(readerMap),
    research: researchHash,
  };
  errors.push(...reviewManifestContractErrors(reviewManifest, {
    caseId,
    inputHashes: expectedManifestHashes,
    workflowVersion: reviewManifest?.workflowVersion ?? "2.2.0",
  }));
  const bodyRefs = new Set([...eligibleReaderLeaves(deepRead).values()]
    .flatMap((leaf) => leaf.evidenceRefs ?? []));
  const requiredForAdjudication = claims.filter((claim) => bodyRefs.has(claim.id));
  const preliminaryA = new Map((coverageA?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const preliminaryB = new Map((coverageB?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const mapEntries = new Map((readerMap?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const preliminaryBlockLoads = new Map();
  const denseClaimRefs = new Set();
  let adjudicationRequired = false;
  for (const claim of requiredForAdjudication) {
    const a = preliminaryA.get(claim.id);
    const b = preliminaryB.get(claim.id);
    const shared = a?.verdict === "covered" && b?.verdict === "covered"
      ? commonValues(a.readerBlockRefs, b.readerBlockRefs)
      : [];
    const conflictTriggers = coverageConflictTriggers(a, b, shared, confidenceThreshold);
    if (conflictTriggers.length) adjudicationRequired = true;
    for (const blockRef of (mapEntries.get(claim.id)?.coverageSpans ?? []).map((span) => span.readerBlockRef)) {
      preliminaryBlockLoads.set(blockRef, (preliminaryBlockLoads.get(blockRef) ?? 0) + 1);
    }
  }
  for (const [blockRef, count] of preliminaryBlockLoads) {
    if (count <= denseBlockThreshold) continue;
    adjudicationRequired = true;
    for (const claim of requiredForAdjudication) {
      if ((mapEntries.get(claim.id)?.coverageSpans ?? []).some((span) => span.readerBlockRef === blockRef)) denseClaimRefs.add(claim.id);
    }
  }
  const artifactRoles = [
    ["coverage_a", coverageA],
    ["coverage_b", coverageB],
    ["fidelity", fidelityReview],
    ...(adjudicationRequired ? [["adjudicator", adjudication]] : []),
  ];
  for (const [role, artifact] of artifactRoles) {
    const assigned = manifestReviewerId(reviewManifest, role);
    if (assigned && artifact?.reviewerId !== assigned) errors.push(`${role}.reviewerId 与 review-manifest 分工不一致。`);
  }
  const repairEditorId = manifestReviewerId(reviewManifest, "repair_editor");
  errors.push(...readerMapV2ContractErrors(readerMap, { caseId, claims, deepRead }));
  errors.push(...coverageReviewContractErrors(coverageA, { caseId, claims, deepRead, evidenceHash, deepReadHash, expectedRole: "coverage_a", forbiddenReviewerIds: [coverageB?.reviewerId, repairEditorId] }));
  errors.push(...coverageReviewContractErrors(coverageB, { caseId, claims, deepRead, evidenceHash, deepReadHash, expectedRole: "coverage_b", forbiddenReviewerIds: [coverageA?.reviewerId, repairEditorId] }));
  if (adjudicationRequired) {
    errors.push(...adjudicationContractErrors(adjudication, {
      caseId,
      claims,
      deepRead,
      coverageA,
      coverageB,
      evidenceHash,
      deepReadHash,
      forbiddenReviewerIds: [coverageA?.reviewerId, coverageB?.reviewerId, repairEditorId],
      confidenceThreshold,
    }));
  }
  if (!fidelityReview) errors.push("缺少 fidelity 独立硬门审核。");
  else errors.push(...fidelityReviewContractErrors(fidelityReview, {
    caseId,
    claims,
    deepRead,
    research,
    evidenceHash,
    deepReadHash,
    researchHash,
    forbiddenReviewerIds: [repairEditorId],
    requirePass: true,
  }));

  const required = claims.filter((claim) => bodyRefs.has(claim.id));
  const first = new Map((coverageA?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const second = new Map((coverageB?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const arbiter = new Map((adjudication?.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
  const fidelityByBlock = new Map((fidelityReview?.entries ?? []).map((entry) => [entry.readerBlockRef, entry]));
  const entries = [];
  for (const claim of required) {
    const a = first.get(claim.id);
    const b = second.get(claim.id);
    const sharedBlocks = a?.verdict === "covered" && b?.verdict === "covered"
      ? commonValues(a.readerBlockRefs, b.readerBlockRefs)
      : [];
    const conflictTriggers = coverageConflictTriggers(a, b, sharedBlocks, confidenceThreshold);
    if (denseClaimRefs.has(claim.id)) conflictTriggers.push("dense_block");
    let verdict;
    let readerBlockRefs;
    let decision;
    let confidence;
    const directAgreement = !conflictTriggers.length && a?.verdict === "covered";
    const agreedNotCovered = !conflictTriggers.length && a?.verdict === b?.verdict && a?.verdict !== "covered";
    if (directAgreement) {
      verdict = "covered";
      readerBlockRefs = sharedBlocks;
      decision = "agreement";
      confidence = Math.min(a.confidence, b.confidence);
    } else if (agreedNotCovered) {
      verdict = a.verdict;
      readerBlockRefs = [];
      decision = "agreement";
      confidence = Math.min(a.confidence, b.confidence);
    } else {
      const resolved = arbiter.get(claim.id);
      verdict = resolved?.verdict ?? "unresolved";
      readerBlockRefs = resolved?.readerBlockRefs ?? [];
      decision = resolved ? "arbiter" : "unresolved";
      confidence = resolved?.confidence ?? 0;
      if (!resolved) errors.push(`coverage 共识未解决：${claim.id}`);
      else {
        for (const trigger of conflictTriggers) if (!resolved.triggers?.includes(trigger)) errors.push(`adjudication ${claim.id} 缺少 ${trigger} trigger。`);
        if (resolved.verdict === "covered" && resolved.confidence < confidenceThreshold) errors.push(`adjudication ${claim.id} confidence 低于 ${confidenceThreshold}。`);
      }
    }
    const candidateBlocks = new Set((mapEntries.get(claim.id)?.coverageSpans ?? []).map((span) => span.readerBlockRef));
    if (verdict === "covered" && !readerBlockRefs.some((ref) => candidateBlocks.has(ref))) {
      errors.push(`coverage 共识与 reader-map 没有共同 block：${claim.id}`);
      verdict = "unreviewable";
      readerBlockRefs = [];
    }
    if (verdict === "covered") {
      const fidelityApproved = readerBlockRefs.filter((blockRef) => {
        const fidelity = fidelityByBlock.get(blockRef);
        return fidelity
          && fidelityEntryHardReasons(fidelity, {
            schemaVersion: fidelityReview?.schemaVersion,
            research,
          }).length === 0
          && fidelity.evidenceRefs?.includes(claim.id);
      });
      if (!fidelityApproved.length) {
        errors.push(`coverage 共识没有通过 fidelity 反查的共同 block：${claim.id}`);
        verdict = "unreviewable";
        readerBlockRefs = [];
      } else {
        readerBlockRefs = fidelityApproved;
      }
    }
    entries.push({ evidenceRef: claim.id, verdict, confidence, readerBlockRefs, decision });
  }

  const blockLoads = new Map();
  for (const entry of entries.filter((item) => item.verdict === "covered")) {
    for (const blockRef of entry.readerBlockRefs) {
      if (!blockLoads.has(blockRef)) blockLoads.set(blockRef, []);
      blockLoads.get(blockRef).push(entry.evidenceRef);
    }
  }
  for (const [blockRef, refs] of blockLoads) {
    if (refs.length <= denseBlockThreshold) continue;
    for (const ref of refs) {
      const resolved = arbiter.get(ref);
      if (!resolved?.triggers?.includes("dense_block") || resolved.verdict !== "covered" || resolved.confidence < confidenceThreshold || !resolved.readerBlockRefs.includes(blockRef)) {
        errors.push(`高密度 block ${blockRef} 承接 ${refs.length} 条 claim，${ref} 缺少 dense_block 仲裁。`);
      } else {
        const consensus = entries.find((entry) => entry.evidenceRef === ref);
        consensus.decision = "arbiter";
        consensus.readerBlockRefs = resolved.readerBlockRefs;
        consensus.confidence = resolved.confidence;
      }
    }
  }

  const counts = Object.fromEntries(["covered", "partial", "missing", "contradicted", "unreviewable", "unresolved"].map((verdict) => [verdict, entries.filter((entry) => entry.verdict === verdict).length]));
  if (counts.contradicted) errors.push(`正文与来源命题存在 ${counts.contradicted} 处矛盾。`);
  if (counts.partial || counts.missing || counts.unreviewable || counts.unresolved) errors.push(`coverage 共识诊断：partial=${counts.partial}, missing=${counts.missing}, unreviewable=${counts.unreviewable}, unresolved=${counts.unresolved}。`);
  return {
    entries,
    blockLoads: Object.fromEntries([...blockLoads].map(([blockRef, refs]) => [blockRef, refs.length])),
    metrics: {
      highMediumCount: required.length,
      coveredCount: counts.covered,
      partialCount: counts.partial,
      missingCount: counts.missing,
      contradictedCount: counts.contradicted,
      unreviewableCount: counts.unreviewable,
      unresolvedCount: counts.unresolved,
      adjudicatedSemanticCoverage: required.length ? counts.covered / required.length : 1,
      adjudicationRequired,
    },
    errors: [...new Set(errors)],
  };
}

export function readerReviewGateFailures(review) {
  const scoreNames = ["coherence", "terminology", "repetition", "hierarchy", "profileFit", "informationLoad"];
  const failingScores = Object.fromEntries(scoreNames
    .filter((name) => Number.isInteger(review?.scores?.[name]) && review.scores[name] < 4)
    .map((name) => [name, review.scores[name]]));
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const errorIssues = issues.filter((issue) => issue?.severity === "error");
  if (review?.verdict === "pass" && !Object.keys(failingScores).length && !errorIssues.length) return [];
  return [{
    verdict: review?.verdict ?? null,
    scores: review?.scores ?? null,
    failingScores,
    issues,
    errorIssues,
    summary: review?.summary ?? "",
  }];
}

export function readerReviewContractErrors(review, { caseId, deepRead, readerMarkdownHash, deepReadHash = sha256Value(deepRead), requirePass = false }) {
  const errors = baseArtifactErrors(review, {
    label: "reader-review",
    caseId,
    role: "reader_advocate",
    inputHashes: { deepRead: deepReadHash, readerMarkdown: readerMarkdownHash },
  });
  if (review?.evidenceBlind !== true) errors.push("reader_advocate 必须在 evidence-blind 条件下审核。");
  const scoreNames = ["coherence", "terminology", "repetition", "hierarchy", "profileFit", "informationLoad"];
  for (const name of scoreNames) if (!Number.isInteger(review?.scores?.[name]) || review.scores[name] < 1 || review.scores[name] > 5) errors.push(`reader-review ${name} 必须为 1–5。`);
  if (!READER_REVIEW_VERDICTS.has(review?.verdict)) errors.push("reader-review verdict 非法。");
  if (!Array.isArray(review?.issues)) errors.push("reader-review issues 必须为数组。");
  if (!review?.summary?.trim()) errors.push("reader-review 缺少 summary。");
  const leaves = readerLeafIndex(deepRead);
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  for (const issue of issues) {
    if (!READER_ISSUE_SEVERITIES.has(issue?.severity)) errors.push("reader-review issue severity 非法。");
    if (!Array.isArray(issue?.readerBlockRefs)) errors.push("reader-review issue.readerBlockRefs 必须为数组。");
    if (!issue?.description?.trim()) errors.push("reader-review issue 缺少 description。");
    if (!issue?.suggestion?.trim()) errors.push("reader-review issue 缺少 suggestion。");
    for (const ref of issue?.readerBlockRefs ?? []) if (!leaves.has(ref)) errors.push(`reader-review issue 指向未知 block：${ref}`);
  }
  if (requirePass) for (const failure of readerReviewGateFailures(review)) {
    for (const name of Object.keys(failure.failingScores)) errors.push(`reader-review ${name} 必须为 4–5。`);
    if (failure.verdict !== "pass") errors.push("reader-review 尚未通过。");
    if (failure.errorIssues.length) errors.push("reader-review 仍有 error 级问题。");
  }
  return errors;
}

function claimBundleV23ContractErrors(artifact, {
  caseId,
  claims,
  claimReviewHash,
  evidenceHash,
  deepRead,
  readerMap,
}) {
  const errors = baseArtifactErrors(artifact, {
    label: "claim-bundles",
    caseId,
    inputHashes: { evidence: evidenceHash, claimReview: claimReviewHash },
    requireReviewer: false,
  });
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const seen = new Map();
  const bundleIds = new Set();
  const orders = new Set();
  const eligibleLeaves = deepRead ? eligibleReaderLeaves(deepRead) : null;
  const readerEntries = readerMap
    ? new Map((readerMap.entries ?? []).map((entry) => [entry.evidenceRef, entry]))
    : null;

  for (const bundle of artifact?.bundles ?? []) {
    if (bundleIds.has(bundle.id)) errors.push(`claim bundle ID is duplicated: ${bundle.id}.`);
    if (orders.has(bundle.order)) errors.push(`claim bundle order is duplicated: ${bundle.order}.`);
    bundleIds.add(bundle.id);
    orders.add(bundle.order);
    if (!/^[a-z0-9-]+$/u.test(bundle.readerBlockRef ?? "")) {
      errors.push(`claim bundle ${bundle.id} has no valid readerBlockRef.`);
    }

    const groups = [
      ["requiredReaderRefs", bundle.requiredReaderRefs ?? []],
      ["optionalReaderRefs", bundle.optionalReaderRefs ?? []],
      ["evidenceOnlyRefs", bundle.evidenceOnlyRefs ?? []],
    ];
    const plannedReaderRefs = [
      ...(bundle.requiredReaderRefs ?? []),
      ...(bundle.optionalReaderRefs ?? []),
    ];
    if (!plannedReaderRefs.length) {
      errors.push(`claim bundle ${bundle.id} contains no reader claim.`);
    }
    for (const [group, refs] of groups) {
      for (const ref of refs) {
        const claim = claimById.get(ref);
        if (!claim) {
          errors.push(`claim bundle references an unknown claim: ${ref}.`);
          continue;
        }
        if (seen.has(ref)) {
          errors.push(`claim bundle assigns ${ref} more than once: ${seen.get(ref)} / ${group}.`);
        }
        seen.set(ref, group);
        if (claim.themeId !== bundle.themeId) {
          errors.push(`claim bundle ${bundle.id} assigns ${ref} to a different theme.`);
        }
      }
    }

    if (eligibleLeaves) {
      const leaf = eligibleLeaves.get(bundle.readerBlockRef);
      if (!leaf) {
        errors.push(`claim bundle ${bundle.id} points to an unknown or ineligible reader block: ${bundle.readerBlockRef}.`);
      } else {
        for (const ref of plannedReaderRefs) {
          if (!leaf.evidenceRefs.includes(ref)) {
            errors.push(`claim bundle ${bundle.id} claim ${ref} is not declared by ${bundle.readerBlockRef}.`);
          }
        }
      }
    }
    if (readerEntries) {
      for (const ref of plannedReaderRefs) {
        const entry = readerEntries.get(ref);
        if (!(entry?.coverageSpans ?? []).some((span) => span.readerBlockRef === bundle.readerBlockRef)) {
          errors.push(`claim bundle ${bundle.id} claim ${ref} is not mapped to ${bundle.readerBlockRef} in reader-map.`);
        }
      }
    }
  }
  return errors;
}

export function claimBundleContractErrors(artifact, {
  caseId,
  claims,
  claimReviewHash,
  evidenceHash = sha256Value(claims),
  maximumReaderClaims = 10,
  deepRead = null,
  readerMap = null,
}) {
  if (deepRead?.schemaVersion === "2.1.0" || readerMap?.schemaVersion === "2.1.0") {
    return claimBundleV23ContractErrors(artifact, {
      caseId,
      claims,
      claimReviewHash,
      evidenceHash,
      deepRead,
      readerMap,
    });
  }
  const errors = baseArtifactErrors(artifact, {
    label: "claim-bundles",
    caseId,
    inputHashes: { evidence: evidenceHash, claimReview: claimReviewHash },
    requireReviewer: false,
  });
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const seen = new Map();
  const bundleIds = new Set();
  const orders = new Set();
  const readerBlockRefs = new Set();
  const eligibleLeaves = deepRead ? eligibleReaderLeaves(deepRead) : null;
  const readerEntries = readerMap ? new Map((readerMap.entries ?? []).map((entry) => [entry.evidenceRef, entry])) : null;
  for (const bundle of artifact?.bundles ?? []) {
    if (bundleIds.has(bundle.id)) errors.push(`claim bundle ID 重复：${bundle.id}`);
    if (orders.has(bundle.order)) errors.push(`claim bundle order 重复：${bundle.order}`);
    bundleIds.add(bundle.id);
    orders.add(bundle.order);
    if (!/^[a-z0-9-]+$/u.test(bundle.readerBlockRef ?? "")) errors.push(`claim bundle ${bundle.id} 缺少合法 readerBlockRef。`);
    else if (readerBlockRefs.has(bundle.readerBlockRef)) errors.push(`多个 claim bundle 指向同一 reader block：${bundle.readerBlockRef}`);
    else readerBlockRefs.add(bundle.readerBlockRef);
    const groups = [
      ["requiredReaderRefs", bundle.requiredReaderRefs ?? []],
      ["optionalReaderRefs", bundle.optionalReaderRefs ?? []],
      ["evidenceOnlyRefs", bundle.evidenceOnlyRefs ?? []],
    ];
    const readerClaimCount = (bundle.requiredReaderRefs?.length ?? 0) + (bundle.optionalReaderRefs?.length ?? 0);
    if (!readerClaimCount) errors.push(`claim bundle ${bundle.id} 没有正文 claim，不能伪造空段落规划。`);
    if (readerClaimCount > maximumReaderClaims) errors.push(`claim bundle ${bundle.id} 承接 ${readerClaimCount} 条正文 claim，超过 ${maximumReaderClaims} 条硬上限。`);
    for (const [group, refs] of groups) {
      for (const ref of refs) {
        const claim = claimById.get(ref);
        if (!claim) {
          errors.push(`claim bundle 引用未知 claim：${ref}`);
          continue;
        }
        if (seen.has(ref)) errors.push(`claim bundle 重复分配 ${ref}：${seen.get(ref)} / ${group}`);
        seen.set(ref, group);
        if (claim.themeId !== bundle.themeId) errors.push(`claim bundle ${bundle.id} 的 ${ref} 主题不一致。`);
        if (group === "requiredReaderRefs" && !["high", "medium"].includes(claim.importance)) errors.push(`requiredReaderRefs 只能包含高/中 claim：${ref}`);
        if (group !== "requiredReaderRefs" && ["high", "medium"].includes(claim.importance)) errors.push(`高/中 claim 必须进入 requiredReaderRefs：${ref}`);
      }
    }
    if (eligibleLeaves) {
      const leaf = eligibleLeaves.get(bundle.readerBlockRef);
      if (!leaf) errors.push(`claim bundle ${bundle.id} 指向未知或不可计覆盖的 reader block：${bundle.readerBlockRef}`);
      else {
        const plannedRefs = new Set([...(bundle.requiredReaderRefs ?? []), ...(bundle.optionalReaderRefs ?? [])]);
        for (const ref of plannedRefs) if (!leaf.evidenceRefs.includes(ref)) errors.push(`claim bundle ${bundle.id} 的 ${ref} 未写入 ${bundle.readerBlockRef}。`);
        for (const ref of leaf.evidenceRefs) if (!plannedRefs.has(ref)) errors.push(`reader block ${bundle.readerBlockRef} 声明了 bundle 外 claim：${ref}`);
      }
    }
    if (readerEntries) {
      for (const ref of [...(bundle.requiredReaderRefs ?? []), ...(bundle.optionalReaderRefs ?? [])]) {
        const mapEntry = readerEntries.get(ref);
        if (!(mapEntry?.coverageSpans ?? []).some((span) => span.readerBlockRef === bundle.readerBlockRef)) {
          errors.push(`claim bundle ${bundle.id} 的 ${ref} 未在 reader-map 指向 ${bundle.readerBlockRef}。`);
        }
      }
    }
  }
  if (eligibleLeaves) {
    for (const blockRef of eligibleLeaves.keys()) {
      if (!readerBlockRefs.has(blockRef)) errors.push(`eligible reader block 缺少 claim bundle：${blockRef}`);
    }
  }
  for (const claim of claims) if (!seen.has(claim.id)) errors.push(`claim bundles 缺少 claim：${claim.id}`);
  return errors;
}

function semanticRepairEvidenceMigrationContractErrors(artifact, {
  caseId,
  oldClaims,
  newClaims,
  oldEvidenceHash,
  newEvidenceHash,
}) {
  const errors = baseArtifactErrors(artifact, {
    label: "evidence-migration",
    schemaVersion: "1.1.0",
    caseId,
    inputHashes: { oldEvidence: oldEvidenceHash, newEvidence: newEvidenceHash },
    requireReviewer: false,
  });
  if (artifact?.migrationKind !== "semantic_repair") errors.push("evidence-migration.migrationKind 必须为 semantic_repair。");
  if (artifact?.reviewPolicyVersion !== "2.3.2") errors.push("evidence-migration.reviewPolicyVersion 必须为 2.3.2。");
  if (!Number.isInteger(artifact?.repairRound) || artifact.repairRound < 1) {
    errors.push("evidence-migration.repairRound 必须为正整数。");
  }
  if (!String(artifact?.baselinePath ?? "").trim()) errors.push("evidence-migration.baselinePath 缺失。");

  const oldIds = new Set(oldClaims.map((claim) => claim.id));
  const newIds = new Set(newClaims.map((claim) => claim.id));
  const oldById = new Map(oldClaims.map((claim) => [claim.id, claim]));
  const newById = new Map(newClaims.map((claim) => [claim.id, claim]));
  const seenOld = new Set();
  const seenNew = new Set();
  const entries = entryIndex(artifact?.entries, "id", "evidence-migration.entries", errors);
  if (!entries.size) errors.push("evidence-migration.entries 至少需要一个局部迁移条目。");
  for (const entry of entries.values()) {
    if (!/^EM\d{4,}$/u.test(entry.id ?? "")) errors.push(`evidence-migration 条目 ID 非法：${entry.id}`);
    if (!String(entry.rationale ?? "").trim()) errors.push(`evidence-migration ${entry.id}.rationale 为空。`);
    const oldRefs = Array.isArray(entry.oldEvidenceRefs) ? entry.oldEvidenceRefs : [];
    const newRefs = Array.isArray(entry.newEvidenceRefs) ? entry.newEvidenceRefs : [];
    if (!Array.isArray(entry.oldEvidenceRefs)) errors.push(`evidence-migration ${entry.id}.oldEvidenceRefs 必须为数组。`);
    if (!Array.isArray(entry.newEvidenceRefs)) errors.push(`evidence-migration ${entry.id}.newEvidenceRefs 必须为数组。`);
    if (duplicateValues(oldRefs).size) errors.push(`evidence-migration ${entry.id}.oldEvidenceRefs 存在重复引用。`);
    if (duplicateValues(newRefs).size) errors.push(`evidence-migration ${entry.id}.newEvidenceRefs 存在重复引用。`);
    for (const ref of oldRefs) {
      if (!oldIds.has(ref)) errors.push(`evidence-migration 引用未知旧 claim：${ref}`);
      if (seenOld.has(ref)) errors.push(`evidence-migration 重复迁移旧 claim：${ref}`);
      seenOld.add(ref);
    }
    for (const ref of newRefs) {
      if (!newIds.has(ref)) errors.push(`evidence-migration 引用未知新 claim：${ref}`);
      if (seenNew.has(ref)) errors.push(`evidence-migration 重复迁移新 claim：${ref}`);
      seenNew.add(ref);
    }
    const cardinalityValid = {
      preserved: oldRefs.length === 1 && newRefs.length === 1,
      rewritten: oldRefs.length === 1 && newRefs.length === 1,
      split: oldRefs.length === 1 && newRefs.length >= 2,
      merged: oldRefs.length >= 2 && newRefs.length === 1,
      retired: oldRefs.length >= 1 && newRefs.length === 0,
      new_claim: oldRefs.length === 0 && newRefs.length >= 1,
    }[entry.status];
    if (!cardinalityValid) errors.push(`evidence-migration ${entry.id} 的 ${entry.status} 基数非法。`);
  }

  const allIds = new Set([...oldIds, ...newIds]);
  for (const ref of allIds) {
    const oldClaim = oldById.get(ref);
    const newClaim = newById.get(ref);
    if (!oldClaim && newClaim && !seenNew.has(ref)) {
      errors.push(`evidence-migration 存在未登记新增 claim：${ref}`);
    } else if (oldClaim && !newClaim && !seenOld.has(ref)) {
      errors.push(`evidence-migration 存在未登记删除 claim：${ref}`);
    } else if (oldClaim && newClaim && canonicalJson(oldClaim) !== canonicalJson(newClaim)
      && !(seenOld.has(ref) && seenNew.has(ref))) {
      errors.push(`evidence-migration 存在未登记内容变更 claim：${ref}`);
    }
  }
  return errors;
}

export function evidenceMigrationContractErrors(artifact, {
  caseId,
  oldClaims,
  newClaims,
  oldEvidenceHash = sha256Value(oldClaims),
  newEvidenceHash = sha256Value(newClaims),
}) {
  if (artifact?.schemaVersion === "1.1.0") {
    return semanticRepairEvidenceMigrationContractErrors(artifact, {
      caseId,
      oldClaims,
      newClaims,
      oldEvidenceHash,
      newEvidenceHash,
    });
  }
  const errors = baseArtifactErrors(artifact, {
    label: "evidence-migration",
    caseId,
    inputHashes: { oldEvidence: oldEvidenceHash, newEvidence: newEvidenceHash },
    requireReviewer: false,
  });
  if (artifact?.toWorkflow !== "2.2.0") errors.push("evidence-migration.toWorkflow 必须为 2.2.0。");
  const oldIds = new Set(oldClaims.map((claim) => claim.id));
  const newIds = new Set(newClaims.map((claim) => claim.id));
  const oldById = new Map(oldClaims.map((claim) => [claim.id, claim]));
  const newById = new Map(newClaims.map((claim) => [claim.id, claim]));
  const seenOld = new Set();
  const seenNew = new Set();
  const entries = entryIndex(artifact?.entries, "id", "evidence-migration.entries", errors);
  for (const entry of entries.values()) {
    const oldRefs = entry.oldEvidenceRefs ?? [];
    const newRefs = entry.newEvidenceRefs ?? [];
    for (const ref of oldRefs) {
      if (!oldIds.has(ref)) errors.push(`evidence-migration 引用未知旧 claim：${ref}`);
      if (seenOld.has(ref)) errors.push(`evidence-migration 重复迁移旧 claim：${ref}`);
      seenOld.add(ref);
    }
    for (const ref of newRefs) {
      if (!newIds.has(ref)) errors.push(`evidence-migration 引用未知新 claim：${ref}`);
      if (seenNew.has(ref)) errors.push(`evidence-migration 重复迁移新 claim：${ref}`);
      seenNew.add(ref);
    }
    const cardinalityValid = {
      preserved: oldRefs.length === 1 && newRefs.length === 1,
      rewritten: oldRefs.length === 1 && newRefs.length === 1,
      split: oldRefs.length === 1 && newRefs.length >= 2,
      merged: oldRefs.length >= 2 && newRefs.length === 1,
      retired: oldRefs.length >= 1 && newRefs.length === 0,
      new_claim: oldRefs.length === 0 && newRefs.length >= 1,
    }[entry.status];
    if (!cardinalityValid) errors.push(`evidence-migration ${entry.id} 的 ${entry.status} 基数非法。`);
    if (entry.status === "merged" && cardinalityValid) {
      const newSourceIds = new Set((newById.get(newRefs[0])?.supportSpans ?? [])
        .flatMap((span) => span.sourceIds ?? []));
      for (const oldRef of oldRefs) {
        const oldSourceIds = new Set((oldById.get(oldRef)?.supportSpans ?? [])
          .flatMap((span) => span.sourceIds ?? []));
        if (oldSourceIds.size && ![...oldSourceIds].some((sourceId) => newSourceIds.has(sourceId))) {
          errors.push(`evidence-migration ${entry.id} 的旧 claim ${oldRef} 与 canonical claim 缺少来源位置重叠。`);
        }
      }
    }
  }
  for (const ref of oldIds) if (!seenOld.has(ref)) errors.push(`evidence-migration 缺少旧 claim：${ref}`);
  for (const ref of newIds) if (!seenNew.has(ref)) errors.push(`evidence-migration 缺少新 claim：${ref}`);
  return errors;
}

export function repairLogContractErrors(log, {
  caseId,
  reviewRound,
  reviewerId,
  consensusHash,
  evidenceBeforeHash,
  evidenceMigrationBeforeHash,
  claimBundlesBeforeHash,
  themeMapBeforeHash,
  deepReadBeforeHash,
  readerMapBeforeHash,
  researchBeforeHash,
  evidenceAfterHash,
  evidenceMigrationAfterHash,
  claimBundlesAfterHash,
  themeMapAfterHash,
  deepReadAfterHash,
  readerMapAfterHash,
  researchAfterHash,
  maximumRepairRounds = 2,
}) {
  const tracksEvidenceMigration = evidenceMigrationBeforeHash !== undefined
    || evidenceMigrationAfterHash !== undefined
    || Object.hasOwn(log?.inputHashes ?? {}, "evidenceMigration")
    || Object.hasOwn(log?.outputHashes ?? {}, "evidenceMigration");
  const tracksClaimBundles = claimBundlesBeforeHash !== undefined
    || claimBundlesAfterHash !== undefined
    || Object.hasOwn(log?.inputHashes ?? {}, "claimBundles")
    || Object.hasOwn(log?.outputHashes ?? {}, "claimBundles");
  const tracksThemeMap = themeMapBeforeHash !== undefined
    || themeMapAfterHash !== undefined
    || Object.hasOwn(log?.inputHashes ?? {}, "themeMap")
    || Object.hasOwn(log?.outputHashes ?? {}, "themeMap");
  const errors = baseArtifactErrors(log, {
    label: "repair-log",
    caseId,
    role: "repair_editor",
    inputHashes: {
      consensus: consensusHash,
      evidence: evidenceBeforeHash,
      ...(tracksEvidenceMigration ? { evidenceMigration: evidenceMigrationBeforeHash } : {}),
      ...(tracksClaimBundles ? { claimBundles: claimBundlesBeforeHash } : {}),
      ...(tracksThemeMap ? { themeMap: themeMapBeforeHash } : {}),
      deepRead: deepReadBeforeHash,
      readerMap: readerMapBeforeHash,
      research: researchBeforeHash,
    },
  });
  if (reviewerId && log?.reviewerId !== reviewerId) errors.push("repair-log.reviewerId 与 manifest 分工不一致。");
  if (log?.reviewRound !== reviewRound) errors.push("repair-log.reviewRound 与审核轮次不一致。");
  if (!Number.isInteger(log?.repairRound) || log.repairRound < 1 || log.repairRound > maximumRepairRounds) {
    errors.push(`repair-log.repairRound 必须为 1–${maximumRepairRounds}。`);
  }
  for (const [name, expected] of Object.entries({
    evidence: evidenceAfterHash,
    ...(tracksEvidenceMigration ? { evidenceMigration: evidenceMigrationAfterHash } : {}),
    ...(tracksClaimBundles ? { claimBundles: claimBundlesAfterHash } : {}),
    ...(tracksThemeMap ? { themeMap: themeMapAfterHash } : {}),
    deepRead: deepReadAfterHash,
    readerMap: readerMapAfterHash,
    research: researchAfterHash,
  })) {
    const actual = log?.outputHashes?.[name];
    if (!HASH_PATTERN.test(actual ?? "")) errors.push(`repair-log.outputHashes.${name} 不是 SHA-256。`);
    else if (expected && actual !== expected) errors.push(`repair-log.outputHashes.${name} 与修复产物不一致。`);
  }
  if (log?.briefInvalidated !== true) errors.push("修复 deep-read 后必须将旧 brief 标记为失效。");
  const issueRefs = (log?.changes ?? []).map((change) => change.issueRef);
  if (duplicateValues(issueRefs).size) errors.push("repair-log 重复登记同一 issueRef。");
  return errors;
}
