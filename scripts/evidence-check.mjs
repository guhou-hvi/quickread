import fs from "node:fs/promises";
import path from "node:path";
import {
  isMain,
  loadCase,
  normalizeText,
  readJson,
  readJsonLines,
  resolveCaseDir,
} from "./lib.mjs";
import { evidenceMigrationContractErrors } from "./review-contract.mjs";
import { coverageLedgerErrors, coverageLedgerFindings } from "./segment-source.mjs";
import { CLAIM_IMPORTANCE, CLAIM_ROLES, nearDuplicateClaimIds } from "./workflow-contract.mjs";

const EVIDENCE_PROVENANCE = new Set(["source_fact", "speaker_view"]);
const SPEAKER_STATUS = new Set(["confirmed", "inferred", "unknown"]);
const SPEAKER_CONFIDENCE_THRESHOLD = 0.85;
const ATTRIBUTION_VERBS = [
  "认为", "回忆", "称", "表示", "指出", "提到", "预测", "强调", "主张", "判断",
  "解释", "承认", "否认", "反驳", "补充", "自述", "讲述", "形容", "推测", "猜测",
  "建议", "确认", "转述", "描述", "认可", "把", "将", "用", "以", "列举",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function participantAliases(participants = []) {
  const aliases = new Set();
  for (const participant of participants) {
    const value = String(participant ?? "").trim();
    if (!value) continue;
    aliases.add(value);
    const base = value.replace(/[（(].*$/u, "").trim();
    if (base) aliases.add(base);
    for (const match of value.matchAll(/[（(]([^）)]+)[）)]/gu)) {
      for (const alias of match[1].split(/[,，/|]/u).map((item) => item.trim()).filter(Boolean)) aliases.add(alias);
    }
  }
  return [...aliases].filter((alias) => alias.length >= 2).sort((a, b) => b.length - a.length);
}

function leadingParticipantAttribution(statement, participants) {
  const aliases = participantAliases(participants);
  if (!aliases.length) return null;
  const optionalAdverb = "(?:明确|进一步|同时|随后|当时|后来|现在|也|还|曾经|曾|多次|反复)?";
  const pattern = new RegExp(`^(?:据)?(${aliases.map(escapeRegExp).join("|")})${optionalAdverb}(?:${ATTRIBUTION_VERBS.join("|")})`, "u");
  return normalizeText(statement).match(pattern)?.[1] ?? null;
}

function leadingParticipantMention(statement, participants) {
  const aliases = participantAliases(participants);
  if (!aliases.length) return null;
  const pattern = new RegExp(`^(?:据)?(${aliases.map(escapeRegExp).join("|")})`, "u");
  return normalizeText(statement).match(pattern)?.[1] ?? null;
}

function normalizedSpeakerName(value) {
  return normalizeText(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]/gu, "");
}

function encodingErrors(value, label) {
  const errors = [];
  const visit = (current, location) => {
    if (typeof current === "string") {
      if (/\uFFFD|\?{2,}/u.test(current)) errors.push(`${label}.${location} 含有损坏字符或问号占位文本。`);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) visit(item, location ? `${location}.${key}` : key);
    }
  };
  visit(value, "");
  return errors;
}

function exactDuplicateGroups(claims) {
  const groups = new Map();
  for (const claim of claims) {
    const key = normalizeText(claim.statement).normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]/gu, "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim.id);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

function usesSelectiveThemeMap(manifest) {
  return ["2.4.0", "2.4.1", "2.4.2"].includes(manifest.workflow?.version);
}

export function selectiveThemeMapWarnings({ manifest, claims, themeMap }) {
  if (!usesSelectiveThemeMap(manifest)) return [];
  const assigned = new Set((themeMap.themes ?? []).flatMap((theme) => theme.claimRefs ?? []));
  const omitted = claims.filter((claim) => !assigned.has(claim.id));
  if (!omitted.length) return [];
  const declared = new Set(themeMap.unassignedClaimRefs ?? []);
  const undeclared = omitted.filter((claim) => !declared.has(claim.id));
  return [
    `workflow 2.4 选择性 theme-map 未纳入 ${omitted.length} 条 claim；该数字仅作诊断，不要求读者版全量分配。`,
    ...(undeclared.length
      ? [`其中 ${undeclared.length} 条未写入 unassignedClaimRefs；workflow 2.4 下仅作诊断。`]
      : []),
  ];
}

export function evidenceArtifactErrors({
  manifest,
  normalized,
  segments,
  coverage,
  claims,
  themeMap,
  extractionOnly = false,
  evidenceMigration = null,
  oldClaims = null,
}) {
  const errors = coverageLedgerErrors(normalized, segments, coverage, {
    caseId: manifest.id,
    sourceHash: manifest.source.sha256,
  });
  const claimById = new Map();
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const sourcePositionById = new Map(normalized.map((unit, index) => [unit.id, index]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

  for (const claim of claims) {
    const label = claim?.id ?? "unknown-claim";
    if (claimById.has(claim.id)) errors.push(`evidence claim ID 重复：${claim.id}`);
    claimById.set(claim.id, claim);
    if (claim.schemaVersion !== "2.0.0") errors.push(`${label}.schemaVersion 必须为 2.0.0。`);
    if (!/^E\d{4,}$/u.test(claim.id ?? "")) errors.push(`${label}.id 非法。`);
    if (claim.caseId !== manifest.id) errors.push(`${label}.caseId 与案例不一致。`);
    if (!String(claim.statement ?? "").trim()) errors.push(`${label}.statement 为空。`);
    if (!EVIDENCE_PROVENANCE.has(claim.provenance)) errors.push(`${label}.provenance 非法。`);
    if (!CLAIM_IMPORTANCE.includes(claim.importance)) errors.push(`${label}.importance 非法。`);
    if (!CLAIM_ROLES.includes(claim.claimRole)) errors.push(`${label}.claimRole 非法。`);
    if (!/^T\d{3,}$/u.test(claim.themeId ?? "")) errors.push(`${label}.themeId 非法。`);
    if (!SPEAKER_STATUS.has(claim.speaker?.status)) errors.push(`${label}.speaker.status 非法。`);
    if (typeof claim.speaker?.confidence !== "number" || claim.speaker.confidence < 0 || claim.speaker.confidence > 1) {
      errors.push(`${label}.speaker.confidence 必须为 0–1。`);
    }
    const speakerName = String(claim.speaker?.name ?? "").trim();
    const speakerReliable = claim.speaker?.status !== "unknown"
      && claim.speaker?.confidence >= SPEAKER_CONFIDENCE_THRESHOLD
      && Boolean(speakerName);
    if (speakerName && !speakerReliable) errors.push(`${label}.speaker.name 仅可在置信度不低于 0.85 时使用。`);
    const attributedParticipant = leadingParticipantAttribution(claim.statement, manifest.participants)
      ?? (claim.provenance === "speaker_view" ? leadingParticipantMention(claim.statement, manifest.participants) : null);
    if (attributedParticipant && !speakerReliable) {
      errors.push(`${label}.statement 存在低置信说话人实名归因：${attributedParticipant}。`);
    } else if (attributedParticipant && !normalizedSpeakerName(speakerName).includes(normalizedSpeakerName(attributedParticipant))) {
      errors.push(`${label}.statement 的实名归因与 speaker.name 不一致：${attributedParticipant}。`);
    }
    if (!claim.supportSpans?.length) errors.push(`${label} 缺少 supportSpans。`);
    for (const [spanIndex, span] of (claim.supportSpans ?? []).entries()) {
      const spanLabel = `${label}.supportSpans[${spanIndex}]`;
      const segment = segmentById.get(span.segmentId);
      if (!segment) {
        errors.push(`${spanLabel} 引用未知 segment：${span.segmentId}`);
        continue;
      }
      if (!span.sourceIds?.length) {
        errors.push(`${spanLabel}.sourceIds 为空。`);
        continue;
      }
      if (new Set(span.sourceIds).size !== span.sourceIds.length) errors.push(`${spanLabel}.sourceIds 重复。`);
      const positions = span.sourceIds.map((sourceId) => segment.sourceIds.indexOf(sourceId));
      if (positions.some((position) => position < 0)) errors.push(`${spanLabel} 超出 ${segment.id} 所有权范围。`);
      else if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) errors.push(`${spanLabel} 不是连续来源区间。`);
      const sourcePositions = span.sourceIds.map((sourceId) => sourcePositionById.get(sourceId));
      if (!sourcePositions.some((position) => position === undefined)
        && sourcePositions.some((position, index) => index > 0 && position !== sourcePositions[index - 1] + 1)) {
        errors.push(`${spanLabel} 在规范化原文中不是连续来源区间。`);
      }
      const units = span.sourceIds.map((sourceId) => sourceById.get(sourceId));
      if (units.some((unit) => !unit)) errors.push(`${spanLabel} 引用未知来源单元。`);
      else if (span.quote !== undefined && span.quote !== units.map((unit) => unit.text).join(" ")) errors.push(`${spanLabel}.quote 与规范化原文不匹配。`);
      if (!String(span.locator ?? "").trim()) errors.push(`${spanLabel}.locator 为空。`);
    }
  }

  if (!extractionOnly) {
    if (themeMap.schemaVersion !== "1.0.0") errors.push("theme-map.schemaVersion 必须为 1.0.0。");
    if (themeMap.caseId !== manifest.id) errors.push("theme-map.caseId 与案例不一致。");
    if (themeMap.profile !== manifest.profile.primary) errors.push("theme-map.profile 与案例不一致。");
    const themeOwners = new Map();
    const unassignedRefs = themeMap.unassignedClaimRefs ?? [];
    if (new Set(unassignedRefs).size !== unassignedRefs.length) errors.push("theme-map.unassignedClaimRefs 存在重复 claim。");
    for (const ref of unassignedRefs) if (!claimById.has(ref)) errors.push(`theme-map.unassignedClaimRefs 引用未知 claim：${ref}`);
    for (const [index, theme] of (themeMap.themes ?? []).entries()) {
      if (theme.order !== index + 1) errors.push(`theme-map 主题顺序不连续：${theme.id}`);
      for (const ref of theme.claimRefs ?? []) {
        if (!claimById.has(ref)) errors.push(`theme-map ${theme.id} 引用未知 claim：${ref}`);
        if (themeOwners.has(ref)) errors.push(`claim 被多个主题重复拥有：${ref}`);
        themeOwners.set(ref, theme.id);
      }
      const actual = Object.fromEntries(CLAIM_IMPORTANCE.map((importance) => [
        importance,
        (theme.claimRefs ?? []).filter((ref) => claimById.get(ref)?.importance === importance).length,
      ]));
      if (JSON.stringify(theme.importanceCoverage) !== JSON.stringify(actual)) errors.push(`theme-map ${theme.id}.importanceCoverage 已过期。`);
    }
    for (const ref of unassignedRefs) if (themeOwners.has(ref)) errors.push(`claim 同时进入 theme-map 且声明未分配：${ref}`);
    if (!usesSelectiveThemeMap(manifest) && unassignedRefs.length) errors.push(`theme-map 仍有未分配 claim：${unassignedRefs.join("、")}`);
    for (const claim of claims) {
      if (!themeOwners.has(claim.id)) {
        if (!usesSelectiveThemeMap(manifest)) errors.push(`claim 未进入 theme-map：${claim.id}`);
      } else if (themeOwners.get(claim.id) !== claim.themeId) {
        errors.push(`claim.themeId 与 theme-map 所有者不一致：${claim.id}`);
      }
    }
  }

  const exactDuplicates = exactDuplicateGroups(claims);
  if (exactDuplicates.length) errors.push(`evidence 存在完全重复 statement：${JSON.stringify(exactDuplicates)}`);
  const nearDuplicates = [...nearDuplicateClaimIds(claims, 0.9)];
  if (nearDuplicates.length) errors.push(`evidence 存在 Jaccard≥0.9 的近重复 claim：${nearDuplicates.join("、")}`);
  errors.push(...encodingErrors(claims, "evidence"), ...encodingErrors(themeMap, "theme-map"));

  if (evidenceMigration) {
    if (!oldClaims) {
      errors.push(evidenceMigration.schemaVersion === "1.1.0"
        ? "存在 semantic_repair evidence-migration.json，但缺少有效的 case-local 修复前证据基线。"
        : "存在 evidence-migration.json，但缺少 workflow-2.1.0 旧证据基线。");
    }
    else errors.push(...evidenceMigrationContractErrors(evidenceMigration, { caseId: manifest.id, oldClaims, newClaims: claims }));
    errors.push(...encodingErrors(evidenceMigration, "evidence-migration"));
  } else if (oldClaims) {
    errors.push("存在 workflow-2.1.0 旧证据基线，但缺少 evidence-migration.json。");
  }
  return [...new Set(errors)];
}

async function optionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function optionalJsonLines(file) {
  try {
    return await readJsonLines(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadEvidenceMigrationBaseline(caseDir, evidenceMigration) {
  if (evidenceMigration?.schemaVersion !== "1.1.0") {
    return {
      oldClaims: await optionalJsonLines(path.join(caseDir, "legacy", "workflow-2.1.0", "work", "evidence.jsonl")),
      errors: [],
    };
  }

  const baselinePath = String(evidenceMigration.baselinePath ?? "").trim();
  if (!baselinePath) return { oldClaims: null, errors: ["evidence-migration.baselinePath 缺失。"] };
  if (path.isAbsolute(baselinePath) || baselinePath.split(/[\\/]+/u).includes("..")) {
    return { oldClaims: null, errors: ["evidence-migration.baselinePath 必须是 case 内且不含 .. 的相对路径。"] };
  }
  const resolvedCaseDir = path.resolve(caseDir);
  const resolvedBaseline = path.resolve(resolvedCaseDir, baselinePath);
  const relative = path.relative(resolvedCaseDir, resolvedBaseline);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return { oldClaims: null, errors: ["evidence-migration.baselinePath 必须指向 case 内的文件。"] };
  }
  try {
    return { oldClaims: await readJsonLines(resolvedBaseline), errors: [] };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { oldClaims: null, errors: [`evidence-migration.baselinePath 不存在：${baselinePath}`] };
    }
    throw error;
  }
}

export async function checkEvidenceCase(caseDir, { extractionOnly = false } = {}) {
  const { manifest } = await loadCase(caseDir);
  const workDir = path.join(caseDir, "work");
  const evidenceMigration = await optionalJson(path.join(workDir, "evidence-migration.json"));
  const baseline = await loadEvidenceMigrationBaseline(caseDir, evidenceMigration);
  const [normalized, segments, coverage, claims, themeMap] = await Promise.all([
    readJsonLines(path.join(workDir, "source.normalized.jsonl")),
    readJsonLines(path.join(workDir, "segments.jsonl")),
    readJson(path.join(workDir, "coverage.json")),
    readJsonLines(path.join(workDir, "evidence.jsonl")),
    extractionOnly ? null : readJson(path.join(workDir, "theme-map.json")),
  ]);
  const errors = [
    ...baseline.errors,
    ...evidenceArtifactErrors({
      manifest,
      normalized,
      segments,
      coverage,
      claims,
      themeMap,
      extractionOnly,
      evidenceMigration,
      oldClaims: baseline.oldClaims,
    }),
  ];
  const coverageFindings = coverageLedgerFindings(normalized, segments, coverage, {
    caseId: manifest.id,
    sourceHash: manifest.source.sha256,
  });
  return {
    caseId: manifest.id,
    claims: claims.length,
    supportSpans: claims.reduce((sum, claim) => sum + (claim.supportSpans?.length ?? 0), 0),
    scope: extractionOnly ? "extraction" : "full",
    themes: themeMap?.themes?.length ?? 0,
    migrationEntries: evidenceMigration?.entries?.length ?? 0,
    warnings: [
      ...coverageFindings.diagnostics,
      ...(extractionOnly ? ["仅检查提取层；综合完成后须重新执行完整 evidence-check。"] : selectiveThemeMapWarnings({ manifest, claims, themeMap })),
    ],
    errors,
  };
}

if (isMain(import.meta.url)) {
  try {
    const flags = process.argv.slice(3);
    if (flags.some((flag) => flag !== "--extraction-only")) throw new Error("未知 evidence-check 参数。");
    const result = await checkEvidenceCase(resolveCaseDir(process.argv[2]), { extractionOnly: flags.includes("--extraction-only") });
    for (const warning of result.warnings ?? []) console.warn(`WARN  ${warning}`);
    if (result.errors.length) {
      for (const error of result.errors) console.error(`ERROR ${error}`);
      process.exitCode = 1;
    } else {
      console.log(`证据层检查通过：${result.caseId}；${result.claims} claims，${result.supportSpans} support spans，${result.themes} themes，${result.migrationEntries} migration entries。`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
