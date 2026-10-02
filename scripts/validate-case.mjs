import fs from "node:fs/promises";
import path from "node:path";
import {
  editorialBlockErrors,
  editorPersonaErrors,
  publicVersionErrors,
} from "./brief-contract.mjs";
import {
  controlledQuoteErrors,
  deepReadContractErrors,
  readerMapContractErrors,
  renderDeepReadMarkdown,
  renderEvidenceBookMarkdown,
} from "./deep-read.mjs";
import { computeQualityReport } from "./quality-report.mjs";
import {
  isMain,
  loadCase,
  normalizeText,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
} from "./lib.mjs";
import {
  collectBlockCharacters,
  densityErrors,
  expectedReadingMinutes,
  profileSelectionErrors,
} from "./workflow-contract.mjs";
import {
  participantGuideCharacters,
  participantGuideContractErrors,
} from "./participant-guide.mjs";
import {
  contextGuideCharacters,
  contextGuideContractErrors,
  contextGuideEntryMap,
  contextGuideUsageErrors,
  contextInlineCharacters,
} from "./context-guide.mjs";

function addReferences(target, value) {
  if (!Array.isArray(value)) return;
  for (const item of value) target.add(item);
}

function searchForm(value) {
  return normalizeText(value)
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .toLowerCase();
}

export function corruptedDerivedTextErrors(value, label = "derived artifact") {
  const errors = [];
  const visit = (current, location) => {
    if (errors.length >= 20) return;
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function compareComputedReport(stored, computed) {
  if (!stored) return ["缺少 quality-report.json。"];
  const normalized = (value) => {
    const clone = structuredClone(value);
    delete clone.generatedAt;
    return JSON.stringify(clone);
  };
  return normalized(stored) === normalized(computed) ? [] : ["quality-report.json 已过期；请重新运行 npm run quality。"];
}

function isFrozenMigrationCase(manifest, config) {
  return config.migration?.frozenCases?.includes(manifest.caseNumber)
    && !config.migration?.activeCases?.includes(manifest.caseNumber);
}

function isRetainedWorkflowCase(manifest, config) {
  return manifest.workflow?.version !== config.workflowVersion
    && (config.compatibility?.retainedWorkflowVersions ?? []).includes(manifest.workflow?.version);
}

function validateManifest(manifest, caseDir, config, profiles) {
  const errors = [];
  const frozen = isFrozenMigrationCase(manifest, config) || isRetainedWorkflowCase(manifest, config);
  const idMatch = manifest.id?.match(/^qr-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  if (!frozen && manifest.schemaVersion !== "1.2.0") errors.push("case schemaVersion 必须为 1.2.0。");
  if (!idMatch) errors.push("case id 必须使用 qr-四位编号-人物-主题格式。");
  if (!idMatch || manifest.caseNumber !== `QR-${idMatch?.[1] ?? ""}`) errors.push("caseNumber 与目录编号不一致。");
  if (manifest.id !== path.basename(caseDir)) errors.push("case id 与目录名不一致。");
  if (!manifest.shortTitle?.trim()) errors.push("案例缺少 shortTitle。");
  if (!Array.isArray(manifest.aliases)) errors.push("案例 aliases 必须是数组。");
  if (manifest.aliases?.includes(manifest.id)) errors.push("案例 aliases 不得包含当前 case id。");
  if (new Set(manifest.aliases ?? []).size !== (manifest.aliases ?? []).length) errors.push("案例 aliases 不得重复。");
  if (!Array.isArray(manifest.tags) || !manifest.tags.length) errors.push("案例至少需要一个检索标签。");
  if (manifest.sourceType === "video" && (!Array.isArray(manifest.participants) || !manifest.participants.length)) {
    errors.push("视频案例至少需要一名参与者。");
  }
  if ([manifest.title, manifest.shortTitle, ...(manifest.participants ?? []), manifest.source?.publisher]
    .filter(Boolean).some((value) => /\?{2,}/.test(value))) errors.push("案例元数据仍含有损坏的问号文本。");
  const urlStatuses = new Set(["verified", "pending", "missing", "not-applicable"]);
  if (!urlStatuses.has(manifest.source?.urlStatus)) errors.push("source.urlStatus 非法或缺失。");
  if (manifest.source?.urlStatus === "verified" && !manifest.source.url) errors.push("已核验来源必须具有 URL。");
  if (manifest.source?.urlStatus !== "verified" && manifest.source?.url) errors.push("未核验来源不得写入正式 URL。");
  if (manifest.source?.urlStatus === "missing") errors.push("来源尚未执行自动检索。");
  if (!frozen) {
    errors.push(...profileSelectionErrors(manifest.profile, profiles));
    if (manifest.workflow?.version !== config.workflowVersion) errors.push("case workflowVersion 已过期。");
    if (manifest.workflow?.promptVersion !== config.promptVersion) errors.push("case promptVersion 已过期。");
    if (manifest.workflow?.templateVersion !== config.templateVersion) errors.push("case templateVersion 已过期。");
  }
  return errors;
}

export function validateThemeMap(themeMap, manifest, evidenceIds, profiles) {
  const errors = [];
  if (themeMap.schemaVersion !== "1.0.0") errors.push("theme-map schemaVersion 必须为 1.0.0。");
  if (themeMap.caseId !== manifest.id) errors.push("theme-map.caseId 与案例不一致。");
  if (themeMap.profile !== manifest.profile.primary) errors.push("theme-map profile 与案例不一致。");
  const allowedModules = new Set(profiles.profiles?.[manifest.profile.primary]?.modules ?? []);
  const assigned = new Set();
  const unassigned = themeMap.unassignedClaimRefs ?? [];
  if (new Set(unassigned).size !== unassigned.length) errors.push("theme-map.unassignedClaimRefs 存在重复 claim。");
  for (const ref of unassigned) if (!evidenceIds.has(ref)) errors.push(`theme-map.unassignedClaimRefs 引用未知 claim：${ref}`);
  for (const [index, theme] of (themeMap.themes ?? []).entries()) {
    if (theme.order !== index + 1) errors.push(`主题顺序不连续：${theme.id}`);
    // Workflow 2.4 permits descriptive theme-module labels. They help authors
    // express the actual material; Profile fit is assessed by Reader Advocate.
    if (!["2.4.0", "2.4.1", "2.4.2"].includes(manifest.workflow?.version)) {
      for (const module of theme.profileModules ?? []) if (!allowedModules.has(module)) errors.push(`主题 ${theme.id} 使用未知 profile module：${module}`);
    }
    for (const ref of theme.claimRefs ?? []) {
      if (!evidenceIds.has(ref)) errors.push(`主题 ${theme.id} 引用未知 claim：${ref}`);
      if (assigned.has(ref)) errors.push(`claim 被多个主题重复拥有：${ref}`);
      assigned.add(ref);
    }
  }
  for (const ref of unassigned) if (assigned.has(ref)) errors.push(`claim 同时进入 theme-map 且声明未分配：${ref}`);
  if (!["2.4.0", "2.4.1", "2.4.2"].includes(manifest.workflow?.version)) {
    for (const ref of evidenceIds) if (!assigned.has(ref) && !unassigned.includes(ref)) errors.push(`claim 未进入主题或未声明未分配：${ref}`);
    if (unassigned.length) errors.push(`theme-map 仍有未分配 claim：${unassigned.join("、")}`);
  }
  return errors;
}

function validateBrief(brief, manifest, config, claims, sourceSearch, participantGuide = null, contextGuide = null) {
  const errors = [];
  const warnings = [];
  const evidenceIds = new Set(claims.map((item) => item.id));
  const claimById = new Map(claims.map((item) => [item.id, item]));
  if (!["1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"].includes(brief.schemaVersion)) errors.push("brief schemaVersion 必须为 1.3.0–1.7.0 的已知版本。");
  if (brief.caseId !== manifest.id) errors.push("brief.caseId 与案例不一致。");
  if (brief.workflowVersion !== manifest.workflow?.version) errors.push("brief workflowVersion 与 case.json 不一致。");
  if (brief.templateVersion !== manifest.workflow?.templateVersion) errors.push("brief templateVersion 与 case.json 不一致。");
  if (brief.brand !== config.brand) errors.push("brief.brand 与全局品牌配置不一致。");
  if (brief.profile?.primary !== manifest.profile.primary || brief.profile?.version !== manifest.profile.version) errors.push("brief profile 与 case.json 不一致。");
  if (JSON.stringify(brief.profile?.lenses ?? []) !== JSON.stringify(manifest.profile.lenses ?? [])) errors.push("brief lenses 与 case.json 不一致。");
  errors.push(...densityErrors(brief.density?.scores, brief.density?.total, "brief.density"));
  if (Object.hasOwn(brief, "footerNote")) errors.push("brief.footerNote 已废弃；页脚由全局角色配置生成。");
  if (/编辑分析|编辑综合/.test(JSON.stringify(brief))) errors.push("brief 仍包含旧编辑角色名称。");
  const sectionBudget = config.budgets.briefSections;
  if (!Array.isArray(brief.sections) || brief.sections.length < sectionBudget.min || brief.sections.length > sectionBudget.max) {
    errors.push(`速览章节数必须为 ${sectionBudget.min}–${sectionBudget.max}。`);
    return { errors, warnings };
  }
  const citationIds = new Set((brief.citations ?? []).map((item) => item.id));
  if (citationIds.size !== (brief.citations ?? []).length) errors.push("引用 ID 重复。");
  for (const [sectionIndex, section] of brief.sections.entries()) {
    if (section.number !== sectionIndex + 1) errors.push(`章节编号不连续：${section.id}`);
    for (const anchor of section.timeAnchors ?? []) {
      for (const ref of anchor.evidenceRefs ?? []) if (!evidenceIds.has(ref)) errors.push(`时间锚点引用未知 claim：${ref}`);
    }
    for (const [blockIndex, block] of (section.blocks ?? []).entries()) {
      const location = `${section.id}/block-${blockIndex + 1}`;
      errors.push(...editorialBlockErrors(block, location));
      const blockEvidence = new Set();
      const blockCitations = new Set();
      addReferences(blockEvidence, block.evidenceRefs);
      addReferences(blockCitations, block.citationRefs);
      for (const item of block.items ?? []) {
        addReferences(blockEvidence, item.evidenceRefs);
        addReferences(blockCitations, item.citationRefs);
      }
      if (["source_fact", "speaker_view"].includes(block.provenance) && !blockEvidence.size) errors.push(`${location} 为来源内容但没有 evidenceRefs。`);
      if (block.provenance === "external" && !blockCitations.size) errors.push(`${location} 为外部内容但没有 citationRefs。`);
      if (block.provenance === "external" && !block.label) errors.push(`${location} 必须显示来源类型标签。`);
      for (const ref of blockEvidence) if (!evidenceIds.has(ref)) errors.push(`${location} 引用未知 claim：${ref}`);
      for (const ref of blockCitations) if (!citationIds.has(ref)) errors.push(`${location} 引用未知资料：${ref}`);
      if (block.type === "quote" && block.provenance !== "external") {
        if (["1.4.0", "1.5.0", "1.6.0", "1.7.0"].includes(brief.schemaVersion)) {
          errors.push(...controlledQuoteErrors(block, claimById).map((message) => `${location} ${message}`));
        } else {
          const quote = searchForm(block.text ?? "");
          if (quote.length < 6 || !sourceSearch.includes(quote)) errors.push(`${location} 引语无法在来源中匹配。`);
        }
      }
    }
  }
  if (["1.5.0", "1.6.0", "1.7.0"].includes(brief.schemaVersion) && (manifest.sourceType !== "article" || participantGuide || brief.participantGuide)) {
    if (brief.participantGuide?.guideRef !== "work/participant-guide.json") errors.push("brief 1.5 缺少 participantGuide 引用。");
    if (!participantGuide) errors.push("brief 1.5 缺少 work/participant-guide.json。");
  }
  if (brief.schemaVersion === "1.7.0" && !brief.contextGuide) {
    if (contextGuide) errors.push("brief 1.7.0 缺少 contextGuide inline_first_use 绑定。");
    errors.push(...contextGuideUsageErrors(brief, null, { kind: "brief", enforceEarliest: true }));
  }
  if (brief.contextGuide) {
    if (brief.contextGuide.guideRef !== "work/context-guide.json") errors.push("brief.contextGuide.guideRef 必须指向 work/context-guide.json。");
    if (brief.contextGuide.type !== "context_guide" || brief.contextGuide.provenance !== "system") errors.push("brief.contextGuide 必须保持 type=context_guide、provenance=system。");
    if (!contextGuide) errors.push("brief 声明了 contextGuide，但缺少 work/context-guide.json。");
    else {
      const entryMap = contextGuideEntryMap(contextGuide);
      for (const ref of brief.contextGuide.entryRefs ?? []) if (!entryMap.has(ref)) errors.push(`brief.contextGuide 引用未知条目：${ref}`);
      errors.push(...contextGuideUsageErrors(brief, contextGuide, {
        kind: "brief",
        selectedRefs: brief.contextGuide.entryRefs,
        enforceEarliest: brief.schemaVersion === "1.7.0",
      }));
    }
    if (brief.schemaVersion === "1.7.0" && brief.contextGuide.placement !== "inline_first_use") errors.push("brief 1.7.0 contextGuide.placement 必须为 inline_first_use。");
  }
  const actualCharacters = collectBlockCharacters(brief)
    + participantGuideCharacters(participantGuide, { compact: true })
    + (brief.contextGuide
      ? brief.schemaVersion === "1.7.0"
        ? contextGuideCharacters({ entries: (contextGuide?.entries ?? []).filter((entry) => brief.contextGuide.entryRefs.includes(entry.id)) })
        : contextGuideCharacters(contextGuide, { compact: true }) + contextInlineCharacters(contextGuide)
      : 0);
  const minutes = expectedReadingMinutes(actualCharacters, config);
  if (brief.readingMinutes !== minutes) errors.push(`readingMinutes 必须按实际 ${actualCharacters} 字符计算为 ${minutes}。`);
  return { errors, warnings };
}

export async function validateCase(caseDir) {
  const errors = [];
  const warnings = [];
  let loaded;
  try {
    loaded = await loadCase(caseDir);
  } catch (error) {
    return { manifest: { id: path.basename(caseDir) }, errors: [error.message], warnings };
  }
  const { manifest, sourcePath } = loaded;
  const [config, profiles] = await Promise.all([
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    readJson(path.join(REPO_ROOT, "config", "profiles.json")),
  ]);
  errors.push(...editorPersonaErrors(config.editorPersona));
  errors.push(...publicVersionErrors(config.publicVersion));
  errors.push(...validateManifest(manifest, caseDir, config, profiles));

  if (manifest.source?.urlStatus === "pending") {
    try {
      const match = await readJson(path.join(caseDir, "work", "source-match.json"));
      if (match.caseId !== manifest.id || match.status !== "pending" || !Array.isArray(match.candidates) || !match.candidates.length) errors.push("待确认来源的 source-match.json 不完整。");
    } catch (error) {
      errors.push(`待确认来源缺少 source-match.json：${error.message}`);
    }
  }

  let currentHash;
  try {
    currentHash = await sha256File(sourcePath);
  } catch (error) {
    errors.push(`来源文件不存在或无法读取：${manifest.source?.path}（${error.message}）`);
    return { manifest, errors, warnings };
  }
  if (currentHash !== manifest.source.sha256) errors.push("来源 SHA-256 与 case.json 不一致；产物已过期。");
  if (isFrozenMigrationCase(manifest, config) || isRetainedWorkflowCase(manifest, config)) {
    warnings.push(`案例保留在 workflow ${manifest.workflow?.version ?? "legacy"}；默认版本升级不会令其过期，仅校验元数据与原始来源哈希。`);
    return { manifest, errors: [...new Set(errors)], warnings: [...new Set(warnings)], frozen: true };
  }

  let normalized;
  let segments;
  let claims;
  let coverage;
  let themeMap;
  let deepRead;
  let readerMap;
  let brief;
  let research;
  let participantGuide;
  let contextGuide;
  try {
    [normalized, segments, claims, coverage, themeMap, deepRead, readerMap, brief, research, participantGuide, contextGuide] = await Promise.all([
      readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
      readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
      readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
      readJson(path.join(caseDir, "work", "coverage.json")),
      readJson(path.join(caseDir, "work", "theme-map.json")),
      readJson(path.join(caseDir, "output", "deep-read.json")),
      readJson(path.join(caseDir, "work", "reader-map.json")),
      readJson(path.join(caseDir, "output", "brief.json")),
      readJson(path.join(caseDir, "work", "research.json")),
      readJson(path.join(caseDir, "work", "participant-guide.json")).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
      readJson(path.join(caseDir, "work", "context-guide.json")).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    ]);
  } catch (error) {
    errors.push(`缺少或无法读取 2.2 工作数据：${error.message}`);
    return { manifest, errors, warnings };
  }
  const sourceIds = new Set(normalized.map((item) => item.id));
  const segmentIds = new Set(segments.map((item) => item.id));
  const evidenceIds = new Set(claims.map((item) => item.id));
  if (sourceIds.size !== normalized.length) errors.push("规范化来源存在重复 ID。");
  if (segmentIds.size !== segments.length) errors.push("segment 存在重复 ID。");
  if (evidenceIds.size !== claims.length) errors.push("claim 存在重复 ID。");
  if (coverage.caseId !== manifest.id || coverage.sourceHash !== currentHash) errors.push("coverage 案例 ID 或来源哈希已过期。");
  for (const segment of segments) {
    if (segment.schemaVersion !== "1.0.0") errors.push(`segment schemaVersion 非法：${segment.id}`);
    if (segment.caseId !== manifest.id) errors.push(`segment caseId 不一致：${segment.id}`);
  }
  for (const claim of claims) {
    if (claim.schemaVersion !== "2.0.0") errors.push(`claim schemaVersion 非法：${claim.id}`);
    if (claim.caseId !== manifest.id) errors.push(`claim caseId 不一致：${claim.id}`);
    if (!claim.statement?.trim()) errors.push(`claim 内容为空：${claim.id}`);
  }
  for (const [label, artifact] of [
    ["case", manifest],
    ["evidence", claims],
    ["theme-map", themeMap],
    ["deep-read", deepRead],
    ["reader-map", readerMap],
    ["brief", brief],
    ["research", research],
    ["context-guide", contextGuide],
  ]) errors.push(...corruptedDerivedTextErrors(artifact, label));
  errors.push(...validateThemeMap(themeMap, manifest, evidenceIds, profiles));

  const researchCitations = research.citations ?? [];
  const citationIds = new Set(researchCitations.map((item) => item.id));
  if (citationIds.size !== researchCitations.length) errors.push("research 引用 ID 重复。");
  if ((["2.3.0", "2.4.0", "2.5.0"].includes(deepRead.schemaVersion) || ["1.5.0", "1.6.0", "1.7.0"].includes(brief.schemaVersion))
      && (manifest.sourceType !== "article" || participantGuide || brief.participantGuide)) {
    errors.push(...participantGuideContractErrors(participantGuide, { manifest, citationIds }));
  }
  if (contextGuide) {
    errors.push(...contextGuideContractErrors(contextGuide, { manifest, evidenceIds, citationIds }));
    errors.push(...contextGuideUsageErrors(deepRead, contextGuide, {
      kind: "deep-read",
      enforceEarliest: deepRead.schemaVersion === "2.5.0",
    }));
    const contextBlocks = deepRead.sections.flatMap((section) => section.modules ?? []).flatMap((module) => module.blocks ?? []).filter((block) => block.type === "context_guide");
    if (deepRead.schemaVersion === "2.4.0" && contextBlocks.length !== 1) errors.push("deep-read 2.4.0 使用 Context Guide 时必须恰好包含一个 context_guide block。");
    if (deepRead.schemaVersion === "2.5.0" && contextBlocks.length) errors.push("deep-read 2.5.0 禁止独立 context_guide block；只允许就地 contextRefs。");
    const entryMap = contextGuideEntryMap(contextGuide);
    for (const ref of contextBlocks[0]?.entryRefs ?? []) if (!entryMap.has(ref)) errors.push(`deep-read context_guide 引用未知条目：${ref}`);
    if (!brief.contextGuide) errors.push("deep-read 使用 Context Guide 时，brief 也必须引用同一数据源。");
    if (deepRead.schemaVersion === "2.5.0" && (contextGuide.entries?.length < 3 || contextGuide.entries?.length > 8)) warnings.push(`Context Guide 当前有 ${contextGuide.entries?.length ?? 0} 项；3–8 项仅为编辑建议，请确认没有遗漏主线名词或形成术语墙。`);
  }
  if (deepRead.schemaVersion === "2.5.0" && !contextGuide) errors.push(...contextGuideUsageErrors(deepRead, null, { kind: "deep-read", enforceEarliest: true }));
  errors.push(...deepReadContractErrors(deepRead, manifest, profiles, claims, citationIds, config));
  errors.push(...readerMapContractErrors(readerMap, manifest, claims, deepRead));
  const renderConfig = { ...config, __citations: researchCitations, __participantGuide: participantGuide, __contextGuide: contextGuide };
  const expectedMarkdown = renderDeepReadMarkdown(deepRead, manifest, renderConfig);
  const deepPath = path.join(caseDir, "output", "deep-read.md");
  if (!(await fileExists(deepPath))) errors.push("缺少由 deep-read.json 生成的 deep-read.md。");
  else if (await fs.readFile(deepPath, "utf8") !== expectedMarkdown) errors.push("deep-read.md 与 deep-read.json 不一致；请运行 npm run build-deep。");
  const expectedEvidenceBook = renderEvidenceBookMarkdown({ manifest, claims, themeMap, citations: researchCitations });
  const evidenceBookPath = path.join(caseDir, "output", "evidence-book.md");
  if (!(await fileExists(evidenceBookPath))) errors.push("缺少由 evidence.jsonl 生成的 evidence-book.md。");
  else if (await fs.readFile(evidenceBookPath, "utf8") !== expectedEvidenceBook) errors.push("evidence-book.md 与 evidence.jsonl/theme-map 不一致；请运行 npm run build-deep。");
  if (/编辑分析|编辑综合/.test(expectedMarkdown)) errors.push("深度版仍包含旧编辑角色名称。");

  const sourceSearch = searchForm(normalized.map((item) => item.text).join(" "));
  const briefResult = validateBrief(brief, manifest, config, claims, sourceSearch, participantGuide, contextGuide);
  errors.push(...briefResult.errors);
  warnings.push(...briefResult.warnings);

  try {
    const computed = await computeQualityReport(caseDir, { write: false });
    errors.push(...computed.errors);
    warnings.push(...computed.warnings);
    let stored = null;
    try {
      stored = await readJson(path.join(caseDir, "work", "quality-report.json"));
    } catch {
      // The comparison below emits a stable missing-report error.
    }
    errors.push(...compareComputedReport(stored, computed));
  } catch (error) {
    errors.push(`无法计算质量报告：${error.message}`);
  }

  try {
    const renderReport = await readJson(path.join(caseDir, "work", "render-report.json"));
    if (renderReport.schemaVersion !== "1.3.0") errors.push("render-report schemaVersion 必须为 1.3.0。");
    if (renderReport.errors?.length) errors.push(`渲染报告仍有 ${renderReport.errors.length} 个错误。`);
  } catch (error) {
    errors.push(`缺少或无法读取 render-report.json：${error.message}`);
  }
  return { manifest, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function printResult(result) {
  console.log(`\n[${result.manifest.id}]`);
  for (const warning of result.warnings) console.warn(`WARN  ${warning}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);
  if (!result.errors.length) console.log(result.frozen
    ? `FROZEN  workflow ${result.manifest.workflow?.version ?? "legacy"} 基线保持不变。`
    : `PASS  workflow ${result.manifest.workflow?.version ?? "current"} 内容、来源与多代理质量门校验通过。`);
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await validateCase(caseDir);
    printResult(result);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
