import path from "node:path";
import {
  isMain,
  loadCase,
  normalizeText,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  writeText,
} from "./lib.mjs";
import { EDITOR_NOTE_INTENT_LABELS, editorialBlockErrors } from "./brief-contract.mjs";
import {
  claimSimilarity,
  compactCharacters,
  densityErrors,
  PROFILES,
  roundRate,
} from "./workflow-contract.mjs";
import { readerMapV2ContractErrors } from "./review-contract.mjs";
import {
  participantGuideCitationRefs,
  renderParticipantGuideMarkdown,
} from "./participant-guide.mjs";
import {
  contextGuideCitationRefs,
  contextGuideEntryMap,
  contextGuideUsageErrors,
  renderContextGuideMarkdown,
  renderContextInlineMarkdown,
} from "./context-guide.mjs";

export const DEEP_SECTION_IDS = Object.freeze([
  "overview",
  "participants",
  "themes",
  "navigation",
  "verification",
]);

const PROVENANCE_LABELS = Object.freeze({
  source_fact: "原文事实",
  speaker_view: "说话人观点",
  external: "外部核验",
  editorial: "QR-Pilot",
  system: "编校说明",
});

const ASR_ARTIFACT_PATTERNS = Object.freeze([
  /(?:^|[，。！？；：\s])(?:呃|嗯嗯+|啊啊+)(?=$|[，。！？；：\s])/gu,
  /(?:就是){3,}|(?:然后){3,}|(?:我我我)|(?:他他他)|(?:这个这个这个)/gu,
  /(?:^|\s)(?:C|P)[0-9]{6}(?=$|\s)/gu,
  /-->/gu,
]);

function splitEvidenceRef(ref) {
  const match = String(ref).match(/^([A-Za-z]+)(\d+)$/);
  return match ? { prefix: match[1], number: Number(match[2]), width: match[2].length } : null;
}

export function compactReferenceRanges(refs) {
  const unique = [...new Set(refs ?? [])];
  const parsed = unique.map((ref) => ({ ref, parsed: splitEvidenceRef(ref) }));
  const ranges = [];
  for (const item of parsed) {
    const previous = ranges.at(-1);
    if (item.parsed && previous?.parsed && item.parsed.prefix === previous.parsed.prefix && item.parsed.number === previous.endNumber + 1) {
      previous.end = item.ref;
      previous.endNumber = item.parsed.number;
      continue;
    }
    ranges.push({ start: item.ref, end: item.ref, endNumber: item.parsed?.number, parsed: item.parsed });
  }
  return ranges.map((range) => range.start === range.end ? range.start : `${range.start}–${range.end}`);
}

function evidenceLinks(refs) {
  return compactReferenceRanges(refs).map((range) => {
    const first = range.split("–")[0];
    return `[${range}](evidence-book.md#${first.toLowerCase()})`;
  });
}

function refsSuffix(value) {
  const evidence = evidenceLinks(value.evidenceRefs);
  const citations = compactReferenceRanges(value.citationRefs).map((ref) => `[${ref}](#${ref.toLowerCase()})`);
  const refs = [...evidence, ...citations];
  return refs.length ? ` 〔${refs.join("、")}〕` : "";
}

function quoteSearchForm(value) {
  return normalizeText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function locatorTokens(value) {
  return String(value ?? "")
    .match(/\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/gu)
    ?.map((token) => token.replace(/\.\d+$/u, "")) ?? [];
}

export function quoteLocatorStart(value) {
  return locatorTokens(value)[0] ?? String(value ?? "").split(/[–—-]/u)[0].trim();
}

function locatorMatches(sourceLocator, supportLocator) {
  const expected = locatorTokens(sourceLocator);
  const actual = locatorTokens(supportLocator);
  if (expected.length && actual.length) {
    return expected[0] === actual[0] && expected.at(-1) === actual.at(-1);
  }
  return normalizeText(sourceLocator) === normalizeText(supportLocator);
}

function deletedSpeechIsMechanical(deleted, preceding, following) {
  if (!deleted) return true;
  if (/^(?:嗯+|呃+|额+|啊+|唉+|诶+|呐+|那个|这个|就是|然后|其实|怎么说|你知道)+$/u.test(deleted)) return true;
  if (preceding && (preceding.endsWith(deleted) || deleted.endsWith(preceding.slice(-Math.min(6, preceding.length))))) return true;
  if (following && (following.startsWith(deleted) || deleted.startsWith(following.slice(0, Math.min(6, following.length))))) return true;
  return false;
}

function deletionOnlySpeechCleanup(sourceText, publishedText) {
  const source = quoteSearchForm(sourceText);
  const published = quoteSearchForm(publishedText);
  if (!source || !published) return false;
  let sourceIndex = 0;
  let publishedIndex = 0;
  let preceding = "";
  while (publishedIndex < published.length) {
    const matchedAt = source.indexOf(published[publishedIndex], sourceIndex);
    if (matchedAt < 0) return false;
    const deleted = source.slice(sourceIndex, matchedAt);
    const following = source.slice(matchedAt);
    if (!deletedSpeechIsMechanical(deleted, preceding, following)) return false;
    preceding += published[publishedIndex];
    sourceIndex = matchedAt + 1;
    publishedIndex += 1;
  }
  return deletedSpeechIsMechanical(source.slice(sourceIndex), preceding, "");
}

export function controlledQuoteErrors(block, claimById) {
  const errors = [];
  const location = block?.id ?? "quote";
  if (!["verbatim", "spoken_cleanup"].includes(block?.quoteMode)) {
    errors.push(`${location} quoteMode must be verbatim or spoken_cleanup.`);
    return errors;
  }
  if (!String(block.attribution ?? "").trim()) errors.push(`${location} controlled quote requires attribution.`);
  const quote = quoteSearchForm(block.text);
  if (quote.length < 6) errors.push(`${location} controlled quote is too short.`);
  const spans = (block.evidenceRefs ?? [])
    .flatMap((ref) => claimById.get(ref)?.supportSpans ?? []);
  if (block.quoteMode === "verbatim") {
    if (!spans.some((span) => quoteSearchForm(span.quote ?? "").includes(quote))) {
      errors.push(`${location} verbatim quote does not match normalized support text.`);
    }
    return errors;
  }
  if (!String(block.sourceLocator ?? "").trim()) errors.push(`${location} spoken_cleanup requires sourceLocator.`);
  if (!String(block.sourceText ?? "").trim()) errors.push(`${location} spoken_cleanup requires sourceText.`);
  const sourceText = quoteSearchForm(block.sourceText);
  const matchedSpan = spans.some((span) => locatorMatches(block.sourceLocator, span.locator)
    && quoteSearchForm(span.quote ?? "").includes(sourceText));
  if (!matchedSpan) {
    errors.push(`${location} sourceText/sourceLocator does not match a continuous referenced support span.`);
  }
  if (!deletionOnlySpeechCleanup(block.sourceText, block.text)) {
    errors.push(`${location} spoken_cleanup may only delete speech disfluency or repetition and change punctuation; additions or reordering are forbidden.`);
  }
  return errors;
}

function renderQuoteAttribution(block) {
  if (!block.attribution) return "";
  if (block.quoteMode === "spoken_cleanup") {
    return `——${block.attribution}〔口语整理 · ${quoteLocatorStart(block.sourceLocator)}〕`;
  }
  return `——${block.attribution}`;
}

function contextInlineLines(node, config) {
  const entryMap = contextGuideEntryMap(config.__contextGuide);
  const detailed = config.__deepReadSchemaVersion === "2.5.0";
  return (node.contextRefs ?? [])
    .map((ref) => entryMap.get(ref))
    .filter(Boolean)
    .map((entry) => renderContextInlineMarkdown(entry, { detailed }));
}

function renderProseGroup(block, config) {
  const lines = [`**${PROVENANCE_LABELS[block.provenance]}｜**`];
  for (const paragraph of block.paragraphs ?? []) {
    lines.push("", `${paragraph.text}${refsSuffix(paragraph)}`);
    for (const note of contextInlineLines(paragraph, config)) lines.push("", note);
  }
  return lines.join("\n");
}

function renderStructuredList(block, config) {
  const lines = [`**${PROVENANCE_LABELS[block.provenance]}｜**`, ""];
  for (const item of block.items ?? []) {
    lines.push(`- ${item.text}${refsSuffix(item)}`);
    for (const note of contextInlineLines(item, config)) lines.push("", note, "");
  }
  return lines.join("\n");
}

function renderBlock(block, config, { showProvenance = true } = {}) {
  if (block.type === "prose_group") {
    const rendered = renderProseGroup(block, config);
    return showProvenance ? rendered : rendered.split("\n").slice(2).join("\n");
  }
  if (block.type === "structured_list") {
    const rendered = renderStructuredList(block, config);
    return showProvenance ? rendered : rendered.split("\n").slice(2).join("\n");
  }
  if (block.type === "quote") {
    const attribution = renderQuoteAttribution(block);
    return `> “${block.text}”${refsSuffix(block)}${attribution ? `\n>\n> ${attribution}` : ""}`;
  }
  if (block.type === "timeline") {
    return (block.items ?? []).map((item) => `- **${item.anchor}｜${item.title}**${refsSuffix(item)}`).join("\n");
  }
  if (block.type === "participant_guide") {
    if (!config.__participantGuide) throw new Error("participant_guide 缺少 work/participant-guide.json。");
    return renderParticipantGuideMarkdown(config.__participantGuide);
  }
  if (block.type === "context_guide") {
    if (!config.__contextGuide) throw new Error("context_guide 缺少 work/context-guide.json。");
    return renderContextGuideMarkdown(config.__contextGuide, block.entryRefs);
  }
  if (block.type === "editor_note") {
    const action = EDITOR_NOTE_INTENT_LABELS[block.intent];
    return `> **${config.editorPersona.name} ${action}：${block.title}**\n>\n> ${block.text}${refsSuffix(block)}`;
  }
  throw new Error(`不支持的 deep-read block：${block.type}`);
}

export function renderDeepReadMarkdown(deepRead, manifest, config) {
  if (deepRead.schemaVersion === "2.5.0" && !config.__contextGuide) {
    const errors = contextGuideUsageErrors(deepRead, null, { kind: "deep-read", enforceEarliest: true });
    if (errors.length) throw new Error(errors.join(" "));
  }
  const readerFirst = ["2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0"].includes(deepRead.schemaVersion);
  const showProvenance = !readerFirst;
  const renderConfig = { ...config, __deepReadSchemaVersion: deepRead.schemaVersion };
  const contentLabel = manifest.sourceType === "article" ? "文章" : manifest.tags?.includes("讲座") ? "讲座" : "访谈";
  const introduction = readerFirst
    ? `> 本文按主题整理${contentLabel}内容，出处见段末链接。`
    : "> 这是一份面向读者的深度版。正文采用忠实转述并按段落聚合证据；完整原子 claim、支持区段和低重要度枝节请查阅 [完整证据册](evidence-book.md)。";
  const lines = [
    `# ${deepRead.title}`,
    "",
    introduction,
    "",
  ];
  for (const section of deepRead.sections ?? []) {
    lines.push(`## ${section.number}. ${section.title}`, "");
    for (const module of section.modules ?? []) {
      if (module.title) lines.push(`### ${module.title}`, "");
      for (const block of module.blocks ?? []) lines.push(renderBlock(block, renderConfig, { showProvenance }), "");
    }
  }
  const citations = deepRead.sections
    .flatMap((section) => section.modules ?? [])
    .flatMap((module) => module.blocks ?? [])
    .flatMap((block) => [block, ...(block.paragraphs ?? []), ...(block.items ?? [])])
    .flatMap((node) => node.citationRefs ?? []);
  if (["2.3.0", "2.4.0", "2.5.0"].includes(deepRead.schemaVersion)) citations.push(...participantGuideCitationRefs(config.__participantGuide));
  if (["2.4.0", "2.5.0"].includes(deepRead.schemaVersion) && config.__contextGuide) citations.push(...contextGuideCitationRefs(config.__contextGuide));
  if (citations.length) {
    lines.push("### 参考资料", "");
    for (const citation of config.__citations ?? []) {
      if (!citations.includes(citation.id)) continue;
      lines.push(`<a id="${citation.id.toLowerCase()}"></a>`, `- **${citation.id}｜${citation.title}**，${citation.publisher}，访问日期 ${citation.accessedAt}：${citation.url}`, "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function provenanceLabel(value) {
  return PROVENANCE_LABELS[value] ?? value;
}

export function renderEvidenceBookMarkdown({ manifest, claims, themeMap, citations = [] }) {
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const lines = [
    `# ${manifest.title}｜完整证据册`,
    "",
    "> 本文件由原子 claim、连续支持区段和主题图谱确定性生成。它负责完整性与回查，不承担连续阅读体验。",
    "",
    `- 案例：${manifest.caseNumber} · ${manifest.id}`,
    `- 原子 claim：${claims.length}`,
    `- 深度读者版：[deep-read.md](deep-read.md)`,
    "",
    "## 主题目录",
    "",
  ];
  for (const theme of themeMap.themes ?? []) lines.push(`- [${theme.id}｜${theme.title}](#${theme.id.toLowerCase()})`);
  for (const theme of themeMap.themes ?? []) {
    lines.push("", `<a id="${theme.id.toLowerCase()}"></a>`, `## ${theme.id}｜${theme.title}`, "", theme.summary, "");
    for (const ref of theme.claimRefs ?? []) {
      const claim = claimsById.get(ref);
      if (!claim) continue;
      lines.push(
        `<a id="${claim.id.toLowerCase()}"></a>`,
        `### ${claim.id} · ${claim.importance} · ${provenanceLabel(claim.provenance)} · ${claim.claimRole}`,
        "",
        claim.statement,
        "",
      );
      if (claim.speaker?.name) lines.push(`- 说话人：${claim.speaker.name}（置信度 ${claim.speaker.confidence}）`);
      for (const span of claim.supportSpans ?? []) {
        lines.push(`- 支持区段：${span.locator} · ${span.segmentId} · ${span.sourceIds.join("、")}`);
      }
      if (claim.notes) lines.push(`- 记录：${claim.notes}`);
      lines.push("");
    }
  }
  if (citations.length) {
    lines.push("## 外部资料", "");
    for (const citation of citations) {
      lines.push(`<a id="${citation.id.toLowerCase()}"></a>`, `- **${citation.id}｜${citation.title}**，${citation.publisher}，访问日期 ${citation.accessedAt}：${citation.url}`, "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function visitReaderNodes(deepRead, visitor) {
  for (const section of deepRead.sections ?? []) {
    for (const module of section.modules ?? []) {
      for (const block of module.blocks ?? []) {
        visitor(block, block.provenance, section.id, module.id);
        for (const paragraph of block.paragraphs ?? []) visitor(paragraph, block.provenance, section.id, module.id);
        for (const item of block.items ?? []) visitor(item, block.provenance, section.id, module.id);
      }
    }
  }
}

function addRefs(target, refs) {
  for (const ref of refs ?? []) target.add(ref);
}

export function deepReadReferences(deepRead) {
  const evidenceRefs = new Set();
  const citationRefs = new Set();
  visitReaderNodes(deepRead, (node) => {
    addRefs(evidenceRefs, node.evidenceRefs);
    addRefs(citationRefs, node.citationRefs);
  });
  return { evidenceRefs, citationRefs };
}

export function readerLeafBlocks(deepRead) {
  const blocks = new Map();
  visitReaderNodes(deepRead, (node, provenance, sectionId, moduleId) => {
    if (!node.id || (!Object.hasOwn(node, "text") && !Object.hasOwn(node, "title"))) return;
    blocks.set(node.id, { ...node, text: node.text ?? node.title, provenance, sectionId, moduleId });
  });
  return blocks;
}

export function readerBodyCharacters(deepRead) {
  let total = 0;
  visitReaderNodes(deepRead, (node) => {
    if (typeof node.text === "string") total += compactCharacters(node.text);
    if (node.type === "timeline") for (const item of node.items ?? []) total += compactCharacters(item.title);
    if (node.type === "editor_note") total += compactCharacters(node.title);
  });
  return total;
}

export function sourceDerivedDeepCharacters(deepRead) {
  let total = 0;
  visitReaderNodes(deepRead, (node, provenance) => {
    if (["source_fact", "speaker_view"].includes(provenance) && typeof node.text === "string") total += compactCharacters(node.text);
  });
  return total;
}

function countAsrArtifacts(text) {
  let total = 0;
  for (const pattern of ASR_ARTIFACT_PATTERNS) total += [...text.matchAll(pattern)].length;
  return total;
}

export function readabilityMetrics(deepRead) {
  const paragraphs = [];
  const listTexts = [];
  const proseTexts = [];
  const timelineTitles = [];
  const editorTexts = [];
  let asrArtifactCount = 0;
  let maximumListItems = 0;
  visitReaderNodes(deepRead, (node, provenance) => {
    if (typeof node.text === "string" && node.type !== "quote") asrArtifactCount += countAsrArtifacts(node.text);
    if (node.role && typeof node.text === "string") {
      const characters = compactCharacters(node.text);
      paragraphs.push({ id: node.id, characters });
      proseTexts.push({ id: node.id, text: node.text });
    }
    if (node.type === "structured_list") maximumListItems = Math.max(maximumListItems, node.items?.length ?? 0);
    if (node.type === "timeline") for (const item of node.items ?? []) timelineTitles.push({ id: item.id, text: item.title });
    if (node.type === "editor_note") {
      editorTexts.push({ id: node.id, text: `${node.title} ${node.text}` });
    }
    if (!node.role && !node.type && typeof node.text === "string") listTexts.push(node.text);
    if (provenance !== "external" && node.type === "quote") {
      // Verified source quotes may intentionally preserve natural speech.
    }
  });
  const bodyCharacters = readerBodyCharacters(deepRead);
  const listCharacters = listTexts.reduce((total, text) => total + compactCharacters(text), 0);
  const duplicateIds = new Set();
  for (let left = 0; left < proseTexts.length; left += 1) {
    for (let right = left + 1; right < proseTexts.length; right += 1) {
      if (claimSimilarity(proseTexts[left].text, proseTexts[right].text) >= 0.9) duplicateIds.add(proseTexts[right].id);
    }
  }
  let timelineDuplicateCount = 0;
  for (const timeline of timelineTitles) {
    if (proseTexts.some((prose) => claimSimilarity(timeline.text, prose.text) >= 0.95)) timelineDuplicateCount += 1;
  }
  let editorDuplicateCount = 0;
  for (const editor of editorTexts) {
    if (proseTexts.some((prose) => claimSimilarity(editor.text, prose.text) >= 0.9)) editorDuplicateCount += 1;
  }
  return {
    bodyCharacters,
    paragraphCount: paragraphs.length,
    paragraphTargetShortCount: paragraphs.filter((item) => item.characters < 120).length,
    paragraphTargetLongCount: paragraphs.filter((item) => item.characters > 450).length,
    paragraphHardLimitCount: paragraphs.filter((item) => item.characters > 650).length,
    maximumParagraphCharacters: Math.max(0, ...paragraphs.map((item) => item.characters)),
    listCharacters,
    listCharacterShare: roundRate(bodyCharacters ? listCharacters / bodyCharacters : 0),
    maximumListItems,
    readerDuplicateCount: duplicateIds.size,
    readerDuplicateRate: roundRate(proseTexts.length ? duplicateIds.size / proseTexts.length : 0),
    timelineDuplicateCount,
    editorDuplicateCount,
    asrArtifactCount,
    editorNoteCount: editorTexts.length,
    timelineItemCount: timelineTitles.length,
  };
}

function nodeRefs(node) {
  return {
    evidence: new Set(node.evidenceRefs ?? []),
    citations: new Set(node.citationRefs ?? []),
  };
}

function deepReadV21ContractErrors(deepRead, manifest, profiles, claims = [], citationIds = new Set()) {
  const errors = [];
  const evidenceIds = new Set(claims.map((claim) => claim.id));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const readerVersion = deepRead.schemaVersion;
  const expectedWorkflow = readerVersion === "2.5.0" ? "2.4.2" : readerVersion === "2.4.0" ? "2.4.1" : readerVersion === "2.3.0" ? "2.4.0" : "2.3.0";
  if (deepRead.workflowVersion !== expectedWorkflow) errors.push(`deep-read ${readerVersion} requires workflowVersion ${expectedWorkflow}.`);
  if (deepRead.caseId !== manifest.id) errors.push("deep-read.caseId does not match the case.");
  if (deepRead.profile?.primary !== manifest.profile?.primary) errors.push("deep-read profile does not match case.json.");
  if (!PROFILES.includes(deepRead.profile?.primary)) errors.push("deep-read profile is invalid.");
  if (deepRead.profile?.version !== profiles.version) errors.push("deep-read profile version is stale.");

  const sections = deepRead.sections;
  const participantReader = ["2.3.0", "2.4.0", "2.5.0"].includes(readerVersion);
  const minimumSections = participantReader ? 3 : 2;
  const maximumSections = participantReader ? 5 : 4;
  if (!Array.isArray(sections) || sections.length < minimumSections || sections.length > maximumSections) {
    errors.push(`deep-read ${readerVersion} section count is invalid.`);
    return errors;
  }
  const requiredStart = participantReader ? ["overview", "participants", "themes"] : ["overview", "themes"];
  if (requiredStart.some((id, index) => sections[index]?.id !== id)) {
    errors.push(`deep-read ${readerVersion} must begin with ${requiredStart.join(", ")}.`);
  }

  const allowedProfileModules = new Set([
    ...(profiles.profiles?.[deepRead.profile?.primary]?.modules ?? []),
    "overview",
    "participants",
    "context",
    "navigation",
    "verification",
    "sources",
  ]);
  const ids = new Set();
  let previousSectionPosition = -1;
  for (const [sectionIndex, section] of sections.entries()) {
    const sectionPosition = DEEP_SECTION_IDS.indexOf(section.id);
    if (sectionPosition < 0 || sectionPosition <= previousSectionPosition || section.number !== sectionIndex + 1) {
      errors.push(`deep-read 2.1 section ${sectionIndex + 1} has an invalid ID, order, or number.`);
    }
    previousSectionPosition = sectionPosition;
    for (const module of section.modules ?? []) {
      // Workflow 2.4 lets the reader edition use descriptive chapter modules.
      // Profile fit is reviewed on the prose itself; internal module labels are
      // navigation metadata and must not invalidate otherwise reviewed content.
      if (!["2.3.0", "2.4.0", "2.5.0"].includes(readerVersion) && !allowedProfileModules.has(module.profileModule)) {
        errors.push(`deep-read module ${module.id} is not allowed by profile ${deepRead.profile?.primary}.`);
      }
      for (const block of module.blocks ?? []) {
        if (["claim_index", "coverage_summary", "paragraph", "bullets"].includes(block.type)) {
          errors.push(`${block.id ?? module.id} uses a reader-edition block type that is no longer supported: ${block.type}.`);
        }
        if (block.type === "editor_note" || block.provenance === "editorial") {
          errors.push(`${block.id ?? module.id} is editorial; deep-read 2.1 permits zero editor_note blocks.`);
        }
        if (block.type === "participant_guide" && !["2.3.0", "2.4.0", "2.5.0"].includes(readerVersion)) {
          errors.push(`${block.id ?? module.id} participant_guide requires deep-read 2.3.0.`);
        }
        if (block.type === "context_guide" && readerVersion !== "2.4.0") {
          errors.push(`${block.id ?? module.id} context_guide is legacy-only and requires deep-read 2.4.0; deep-read 2.5.0 uses inline contextRefs only.`);
        }
        const nodes = [block, ...(block.paragraphs ?? []), ...(block.items ?? [])];
        for (const node of nodes) {
          if (!node.id) continue;
          if (ids.has(node.id)) errors.push(`deep-read reader block ID is duplicated: ${node.id}.`);
          ids.add(node.id);
          const refs = nodeRefs(node);
          if (["source_fact", "speaker_view"].includes(block.provenance)
            && Object.hasOwn(node, "text") && !refs.evidence.size) {
            errors.push(`${node.id} is source-derived but has no evidenceRefs.`);
          }
          if (block.provenance === "external" && Object.hasOwn(node, "text") && !refs.citations.size) {
            errors.push(`${node.id} is external but has no citationRefs.`);
          }
          for (const ref of refs.evidence) {
            if (!evidenceIds.has(ref)) errors.push(`${node.id} references an unknown claim: ${ref}.`);
          }
          for (const ref of refs.citations) {
            if (!citationIds.has(ref)) errors.push(`${node.id} references an unknown citation: ${ref}.`);
          }
        }
        if (block.type === "quote") {
          if (["2.2.0", "2.3.0", "2.4.0", "2.5.0"].includes(readerVersion)) {
            errors.push(...controlledQuoteErrors(block, claimById));
          } else {
            const quote = quoteSearchForm(block.text);
            const matched = (block.evidenceRefs ?? []).some((ref) => (claimById.get(ref)?.supportSpans ?? [])
              .some((span) => quoteSearchForm(span.quote ?? "").includes(quote)));
            if (quote.length < 6 || !matched) {
              errors.push(`${block.id} quote does not match normalized support text for its evidenceRefs.`);
            }
          }
        }
      }
    }
  }
  return errors;
}

export function deepReadContractErrors(deepRead, manifest, profiles, claims = [], citationIds = new Set(), config = null) {
  if (["2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0"].includes(deepRead?.schemaVersion)) {
    return deepReadV21ContractErrors(deepRead, manifest, profiles, claims, citationIds);
  }
  const errors = [];
  const evidenceIds = new Set(claims.map((claim) => claim.id));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  if (deepRead.schemaVersion !== "2.0.0") errors.push("deep-read schemaVersion 必须为 2.0.0。");
  if (deepRead.caseId !== manifest.id) errors.push("deep-read.caseId 与案例不一致。");
  if (deepRead.workflowVersion !== "2.2.0") errors.push("deep-read.workflowVersion 必须为 2.2.0。");
  if (deepRead.profile?.primary !== manifest.profile?.primary) errors.push("deep-read profile 与 case.json 不一致。");
  if (!PROFILES.includes(deepRead.profile?.primary)) errors.push("deep-read profile 非法。");
  if (deepRead.profile?.version !== profiles.version) errors.push("deep-read profile 版本已过期。");
  errors.push(...densityErrors(deepRead.density?.scores, deepRead.density?.total, "deep-read.density"));
  if (!Array.isArray(deepRead.sections) || deepRead.sections.length !== 4) {
    errors.push("deep-read 必须具有四个读者版顶层章节。");
    return errors;
  }
  const allowedProfileModules = new Set([
    ...(profiles.profiles?.[deepRead.profile.primary]?.modules ?? []),
    "overview",
    "navigation",
    "verification",
    "sources",
  ]);
  const ids = new Set();
  let editorNotes = 0;
  for (const [sectionIndex, section] of deepRead.sections.entries()) {
    if (section.id !== DEEP_SECTION_IDS[sectionIndex] || section.number !== sectionIndex + 1) {
      errors.push(`deep-read 第 ${sectionIndex + 1} 节 ID 或编号不符合固定四节结构。`);
    }
    for (const module of section.modules ?? []) {
      if (!allowedProfileModules.has(module.profileModule)) errors.push(`deep-read 模块 ${module.id} 不属于 ${deepRead.profile.primary} profile：${module.profileModule}`);
      for (const block of module.blocks ?? []) {
        if (["claim_index", "coverage_summary", "paragraph", "bullets"].includes(block.type)) errors.push(`${block.id ?? module.id} 使用了禁止进入读者版的旧 block：${block.type}`);
        if (block.type === "editor_note") {
          editorNotes += 1;
          const { id: _readerBlockId, ...editorNote } = block;
          errors.push(...editorialBlockErrors(editorNote, `${section.id}/${module.id}/${block.id}`));
        }
        const nodes = [block, ...(block.paragraphs ?? []), ...(block.items ?? [])];
        for (const node of nodes) {
          if (!node.id) continue;
          if (ids.has(node.id)) errors.push(`deep-read reader block ID 重复：${node.id}`);
          ids.add(node.id);
          const refs = nodeRefs(node);
          if (["source_fact", "speaker_view"].includes(block.provenance) && Object.hasOwn(node, "text") && !refs.evidence.size) errors.push(`${node.id} 为来源内容但没有 evidenceRefs。`);
          if (block.provenance === "external" && Object.hasOwn(node, "text") && !refs.citations.size) errors.push(`${node.id} 为外部内容但没有 citationRefs。`);
          for (const ref of refs.evidence) if (!evidenceIds.has(ref)) errors.push(`${node.id} 引用未知 claim：${ref}`);
          for (const ref of refs.citations) if (!citationIds.has(ref)) errors.push(`${node.id} 引用未知外部资料：${ref}`);
        }
        if (block.type === "structured_list" && (block.items?.length ?? 0) > 7) errors.push(`${block.id} 列表超过 7 项。`);
        if (block.type === "timeline" && ((block.items?.length ?? 0) < 8 || block.items.length > 20)) errors.push(`${block.id} 时间线必须具有 8–20 个导航节点。`);
        if (block.type === "quote") {
          const quote = normalizeText(block.text).replace(/[\p{P}\p{S}\s]/gu, "");
          const matched = (block.evidenceRefs ?? []).some((ref) => (claimById.get(ref)?.supportSpans ?? []).some((span) => normalizeText(span.quote ?? "").replace(/[\p{P}\p{S}\s]/gu, "").includes(quote)));
          if (quote.length < 6 || !matched) errors.push(`${block.id} 引语无法在引用 claim 的规范化原文中匹配。`);
        }
      }
    }
  }
  const minimumNotes = config?.budgets?.deepRead?.editorNoteMinimum ?? 2;
  const maximumNotes = config?.budgets?.deepRead?.editorNoteMaximum ?? 4;
  if (editorNotes < minimumNotes || editorNotes > maximumNotes) errors.push(`deep-read QR-Pilot 数量必须为 ${minimumNotes}–${maximumNotes}，实际 ${editorNotes}。`);
  return errors;
}

export function readerMapContractErrors(readerMap, manifest, claims, deepRead) {
  return readerMapV2ContractErrors(readerMap, {
    caseId: manifest.id,
    claims,
    deepRead,
  });
}

export async function buildDeepRead(caseDir) {
  const { manifest } = await loadCase(caseDir);
  const [deepRead, claims, themeMap, research, config, participantGuide, contextGuide] = await Promise.all([
    readJson(path.join(caseDir, "output", "deep-read.json")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "work", "theme-map.json")),
    readJson(path.join(caseDir, "work", "research.json")),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    readJson(path.join(caseDir, "work", "participant-guide.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    readJson(path.join(caseDir, "work", "context-guide.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  const citations = research.citations ?? [];
  const renderConfig = { ...config, __citations: citations, __participantGuide: participantGuide, __contextGuide: contextGuide };
  const markdown = renderDeepReadMarkdown(deepRead, manifest, renderConfig);
  const evidenceBook = renderEvidenceBookMarkdown({ manifest, claims, themeMap, citations });
  const outputPath = path.join(caseDir, "output", "deep-read.md");
  const evidenceBookPath = path.join(caseDir, "output", "evidence-book.md");
  await Promise.all([writeText(outputPath, markdown), writeText(evidenceBookPath, evidenceBook)]);
  return {
    outputPath,
    evidenceBookPath,
    characters: readerBodyCharacters(deepRead),
    evidenceClaims: claims.length,
  };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await buildDeepRead(caseDir);
    console.log(`已生成 ${path.relative(REPO_ROOT, result.outputPath)} 和 ${path.relative(REPO_ROOT, result.evidenceBookPath)}（读者正文 ${result.characters} 字符，证据 ${result.evidenceClaims} 条）。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
