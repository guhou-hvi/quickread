import fs from "node:fs/promises";
import path from "node:path";
import {
  loadCase,
  normalizeText,
  readJson,
  readJsonLines,
  REPO_ROOT,
  writeJson,
} from "./lib.mjs";
import { adaptiveTargets, compactCharacters } from "./workflow-contract.mjs";
import { buildDeepRead } from "./deep-read.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function markdownSection(markdown, number) {
  const pattern = new RegExp(`^##\\s+${number}\\.\\s+.+$`, "m");
  const match = pattern.exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = new RegExp(`^##\\s+${number + 1}\\.\\s+.+$`, "m").exec(markdown.slice(start));
  return markdown.slice(start, next ? start + next.index : markdown.length).trim();
}

function plainMarkdown(value) {
  return normalizeText(String(value ?? "")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/[*_`>#]/gu, "")
    .replace(/^[-+]\s+/gu, ""));
}

function hasEvidenceDump(value) {
  return /(?:可追溯的原文线索|本时段围绕|证据展开|字幕单元|来源段落提要|完整覆盖|E\d{3,})/u.test(value);
}

function readableParagraphs(section) {
  return section
    .split(/\r?\n\s*\r?\n/)
    .map(plainMarkdown)
    .filter((value) => value.length >= 35 && !hasEvidenceDump(value) && !/^\d+\.\s/u.test(value) && !/^https?:/u.test(value));
}

function endSentence(value) {
  const text = plainMarkdown(value).replace(/[；;]+$/u, "");
  return text && !/[。！？!?]$/u.test(text) ? `${text}。` : text;
}

function itemReferences(item, block) {
  return {
    evidenceRefs: [...new Set([...(item?.evidenceRefs ?? []), ...(block.evidenceRefs ?? [])])],
    citationRefs: [...new Set([...(item?.citationRefs ?? []), ...(block.citationRefs ?? [])])],
  };
}

function briefSectionDetails(section) {
  const groups = new Map();
  const quotes = [];
  const add = (provenance, text, evidenceRefs = [], citationRefs = []) => {
    const cleaned = endSentence(text);
    if (!cleaned || cleaned.length < 12 || hasEvidenceDump(cleaned)) return;
    const key = provenance === "source_fact" ? provenance : "speaker_view";
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    if (!group.some((item) => item.text === cleaned)) {
      group.push({ text: cleaned, evidenceRefs: [...new Set(evidenceRefs)], citationRefs: [...new Set(citationRefs)] });
    }
  };
  for (const block of section?.blocks ?? []) {
    if (block.type === "editor_note" || block.provenance === "external") continue;
    if (block.type === "quote") {
      quotes.push({
        text: block.text,
        attribution: block.attribution,
        evidenceRefs: block.evidenceRefs ?? [],
        citationRefs: block.citationRefs ?? [],
        provenance: block.provenance,
      });
      continue;
    }
    if (block.text) add(block.provenance, block.text, block.evidenceRefs, block.citationRefs);
    if (block.columns?.length) {
      for (const column of block.columns) {
        const text = `${column.title}：${column.items.map((item) => plainMarkdown(item).replace(/[。！？]$/u, "")).join("；")}`;
        add(block.provenance, text, block.evidenceRefs, block.citationRefs);
      }
      continue;
    }
    if (block.items?.length) {
      const parts = block.items.map((item) => {
        const prefix = [item.value, item.label].filter(Boolean).join("（") + (item.value && item.label ? "）" : "");
        const body = plainMarkdown(item.text).replace(/[。！？]$/u, "");
        return prefix ? `${prefix}：${body}` : body;
      });
      const references = block.items.reduce((result, item) => {
        const refs = itemReferences(item, block);
        result.evidenceRefs.push(...refs.evidenceRefs);
        result.citationRefs.push(...refs.citationRefs);
        return result;
      }, { evidenceRefs: [], citationRefs: [] });
      add(block.provenance, parts.join("；"), references.evidenceRefs, references.citationRefs);
    }
  }
  return { groups, quotes };
}

function uniqueParagraphs(paragraphs) {
  const seen = new Set();
  return paragraphs.filter((paragraph) => {
    const key = plainMarkdown(paragraph.text).replace(/[\p{P}\p{S}\s]/gu, "").toLocaleLowerCase("zh-CN");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchingQuoteRefs(text, requestedRefs, claims) {
  const quote = normalizeText(text).replace(/[\p{P}\p{S}\s]/gu, "");
  if (quote.length < 6) return [];
  const requested = new Set(requestedRefs ?? []);
  return claims
    .filter((claim) => !requested.size || requested.has(claim.id))
    .filter((claim) => (claim.supportSpans ?? []).some((span) =>
      normalizeText(span.quote ?? "").replace(/[\p{P}\p{S}\s]/gu, "").includes(quote)))
    .map((claim) => claim.id);
}

function buildThemeModule({ theme, claims, themeClaims: suppliedThemeClaims = null, briefSection, profile, editorNote, order }) {
  const themeClaims = suppliedThemeClaims ?? claims.filter((claim) => claim.themeId === theme.id);
  const details = briefSectionDetails(briefSection);
  const blocks = [];
  // Atomic claim text intentionally never enters the reader edition here.
  // It is frequently ASR-shaped and belongs in evidence-book.md. Any extra
  // reader paragraph must be authored during synthesis and supplied through
  // the structured brief or legacy reader baseline.
  // A theme summary has no claim-level semantic declaration. Never attach
  // representative refs merely to make it look covered.
  const provenances = [...details.groups.keys()];
  for (const provenance of provenances) {
    const paragraphs = [];
    for (const [index, detail] of (details.groups.get(provenance) ?? []).entries()) {
      if (!detail.evidenceRefs.length) continue;
      paragraphs.push({
        id: `theme-${order}-${provenance}-detail-${index + 1}`,
        role: "explanation",
        text: detail.text,
        evidenceRefs: detail.evidenceRefs,
        ...(detail.citationRefs.length ? { citationRefs: detail.citationRefs } : {}),
      });
    }
    const selected = uniqueParagraphs(paragraphs).slice(0, 5);
    if (selected.length) blocks.push({ id: `theme-${order}-${provenance}-prose`, type: "prose_group", provenance, paragraphs: selected });
  }
  for (const [index, quote] of details.quotes.entries()) {
    let matchingRefs = matchingQuoteRefs(quote.text, quote.evidenceRefs, claims);
    if (!matchingRefs.length) matchingRefs = matchingQuoteRefs(quote.text, [], claims);
    if (!matchingRefs.length) continue;
    blocks.push({
      id: `theme-${order}-quote-${index + 1}`,
      type: "quote",
      provenance: quote.provenance,
      text: quote.text,
      ...(quote.attribution ? { attribution: quote.attribution } : {}),
      evidenceRefs: matchingRefs,
      ...(quote.citationRefs.length ? { citationRefs: quote.citationRefs } : {}),
    });
  }
  if (editorNote) blocks.push({ id: `theme-${order}-qr-pilot`, ...editorNote });
  if (!blocks.length) {
    blocks.push({
      id: `theme-${order}-unresolved`,
      type: "prose_group",
      provenance: "system",
      paragraphs: [{ id: `theme-${order}-unresolved-p1`, role: "transition", text: theme.summary }],
    });
  }
  return {
    module: {
      id: `theme-${order}`,
      title: theme.title,
      profileModule: theme.profileModules[0],
      blocks,
    },
  };
}

function parseLegacyTimeline(markdown) {
  const candidates = [];
  for (const line of markdownSection(markdown, 3).split(/\r?\n/)) {
    let match = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*[：:]\s*(.+)$/u);
    if (match) {
      const [anchorPart] = match[1].split("｜");
      const topic = match[2].match(/围绕[“"](.+?)[”"]推进/u)?.[1] ?? plainMarkdown(match[2]).split(/[。；]/u)[0];
      candidates.push({ anchor: plainMarkdown(anchorPart), title: topic });
      continue;
    }
    match = line.match(/^\s*[-*]\s+(\d{1,2}:\d{2}(?::\d{2})?[-–—]\d{1,2}:\d{2}(?::\d{2})?)[：:]\s*(.+)$/u);
    if (match) candidates.push({ anchor: match[1], title: plainMarkdown(match[2]).split(/[。；]/u)[0] });
  }
  return candidates.filter((item) => item.anchor && item.title);
}

function sampleEvenly(items, maximum) {
  if (items.length <= maximum) return items;
  return Array.from({ length: maximum }, (_, index) => items[Math.round(index * (items.length - 1) / (maximum - 1))]);
}

function buildTimeline(markdown, claims, themes, config) {
  const maximum = config.budgets.deepRead.timelineMaximumItems;
  const minimum = config.budgets.deepRead.timelineMinimumItems;
  let candidates = sampleEvenly(parseLegacyTimeline(markdown), maximum);
  if (!candidates.length) {
    candidates = themes.map((theme) => ({ anchor: `主题 ${theme.order}`, title: theme.title }));
  }
  while (candidates.length < minimum) {
    const theme = themes[candidates.length % themes.length];
    candidates.push({ anchor: `主题 ${theme.order} · 节点 ${candidates.length + 1}`, title: theme.title });
  }
  const orderedClaims = claims.filter((claim) => ["high", "medium"].includes(claim.importance));
  return candidates.slice(0, maximum).map((item, index) => {
    const claim = orderedClaims[Math.min(orderedClaims.length - 1, Math.floor(index * orderedClaims.length / candidates.length))] ?? claims[index % claims.length];
    return {
      id: `nav-${String(index + 1).padStart(2, "0")}`,
      anchor: item.anchor,
      title: item.title.slice(0, 90),
      evidenceRefs: claim ? [claim.id] : [],
    };
  });
}

function buildOverview(legacyMarkdown, brief) {
  const legacy = readableParagraphs(markdownSection(legacyMarkdown, 1))
    .filter((paragraph) => !/(?:本案归档|以下内容|内容标注规则)/u.test(paragraph));
  const texts = [brief.summary, ...legacy].filter(Boolean);
  const unique = [];
  for (const text of texts) {
    const cleaned = plainMarkdown(text);
    if (!cleaned || unique.some((item) => item === cleaned)) continue;
    unique.push(cleaned);
  }
  const paragraphs = unique.slice(0, 4).map((text, index) => ({
    id: `overview-${index + 1}`,
    role: index === 0 ? "thesis" : "explanation",
    text,
  }));
  if (paragraphs.length === 1) {
    paragraphs.push({
      id: "overview-2",
      role: "explanation",
      text: "下文按主题展开核心概念、关键选择与成立边界；时间线只保留回看所需的导航节点，完整细节则进入证据册。",
    });
  }
  return paragraphs;
}

function collectEditorNotes(brief, maximum) {
  return (brief.sections ?? [])
    .flatMap((section, sectionIndex) => (section.blocks ?? [])
      .filter((block) => block.type === "editor_note")
      .map((block) => ({ sectionIndex, sectionTitle: section.title, block })))
    .slice(0, maximum);
}

function sectionEvidenceRefs(section) {
  const refs = new Set();
  for (const anchor of section?.timeAnchors ?? []) for (const ref of anchor.evidenceRefs ?? []) refs.add(ref);
  for (const block of section?.blocks ?? []) {
    for (const ref of block.evidenceRefs ?? []) refs.add(ref);
    for (const item of block.items ?? []) for (const ref of item.evidenceRefs ?? []) refs.add(ref);
  }
  return [...refs];
}

export function buildReaderMap(claims, deepRead) {
  const direct = new Map();
  for (const section of deepRead.sections) {
    if (!["overview", "themes"].includes(section.id)) continue;
    for (const module of section.modules) {
      for (const block of module.blocks) {
        if (!["source_fact", "speaker_view"].includes(block.provenance)) continue;
        for (const node of [block, ...(block.paragraphs ?? []), ...(block.items ?? [])]) {
          if (!node.id || typeof node.text !== "string") continue;
          for (const ref of node.evidenceRefs ?? []) {
            if (!direct.has(ref)) direct.set(ref, []);
            direct.get(ref).push({ readerBlockRef: node.id, readerTextQuote: node.text });
          }
        }
      }
    }
  }
  return {
    schemaVersion: "2.0.0",
    caseId: deepRead.caseId,
    entries: claims.map((claim) => {
      const coverageSpans = [...new Map((direct.get(claim.id) ?? [])
        .map((span) => [`${span.readerBlockRef}\u0000${span.readerTextQuote}`, span])).values()];
      if (coverageSpans.length) {
        return { evidenceRef: claim.id, importance: claim.importance, presentation: "explicit", coverageSpans };
      }
      return {
        evidenceRef: claim.id,
        importance: claim.importance,
        presentation: ["high", "medium"].includes(claim.importance) ? "unmapped" : "evidence_only",
        coverageSpans: [],
      };
    }),
  };
}

export function buildReaderEditionData({ manifest, brief, claims, themeMap, density, targets, research, legacyMarkdown, config }) {
  const editorNotes = collectEditorNotes(brief, config.budgets.deepRead.editorNoteMaximum);
  const notesByTitle = new Map(editorNotes.map(({ sectionTitle, block }) => [sectionTitle, block]));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const readerSections = brief.sections?.length ? brief.sections : themeMap.themes;
  const themeModules = readerSections.map((briefSection, index) => {
    const mappedTheme = themeMap.themes.find((theme) => theme.title === briefSection.title);
    const fallbackTheme = themeMap.themes[Math.min(index, themeMap.themes.length - 1)];
    const theme = mappedTheme ?? {
      id: `reader-theme-${index + 1}`,
      order: index + 1,
      title: briefSection.title,
      summary: briefSection.lead,
      profileModules: fallbackTheme?.profileModules ?? ["topic"],
    };
    const explicitClaims = sectionEvidenceRefs(briefSection).map((ref) => claimById.get(ref)).filter(Boolean);
    const themeClaims = mappedTheme
      ? claims.filter((claim) => claim.themeId === mappedTheme.id)
      : explicitClaims.length ? explicitClaims : claims.filter((claim) => claim.themeId === fallbackTheme?.id).slice(0, 8);
    const editorNote = notesByTitle.get(briefSection.title);
    const { module } = buildThemeModule({ theme, claims, themeClaims, briefSection, profile: manifest.profile.primary, editorNote, order: index + 1 });
    return module;
  });
  const verificationBlocks = [{
    id: "verification-scope",
    type: "prose_group",
    provenance: "system",
    paragraphs: [{
      id: "verification-scope-1",
      role: "explanation",
      text: "技术判断、行业预测、公司策略和个人回忆均按其原始来源类别处理。自动转写中无法可靠确认的专名、数字和断句不作为直接引语；外部资料只用于背景核验，不替代访谈证据。",
    }],
  }];
  for (const [index, item] of (research.background ?? []).entries()) {
    verificationBlocks.push({
      id: `verification-external-${index + 1}`,
      type: "prose_group",
      provenance: "external",
      paragraphs: [{
        id: `verification-external-${index + 1}-p1`,
        role: "explanation",
        text: `${item.title}：${item.text}`,
        citationRefs: item.citationRefs,
      }],
    });
  }
  const deepRead = {
    $schema: "../../schemas/deep-read.schema.json",
    schemaVersion: "2.0.0",
    caseId: manifest.id,
    workflowVersion: config.workflowVersion,
    title: brief.title || manifest.title,
    profile: { primary: manifest.profile.primary, lenses: manifest.profile.lenses, version: manifest.profile.version },
    density: { scores: density.scores, total: density.total },
    readerBudget: {
      recommendedCharacters: targets.recommendedReaderCharacters,
      minimumGuideline: targets.readerMinimumGuideline,
      maximumGuideline: targets.readerMaximumGuideline,
      softCharacterCap: targets.readerSoftCharacterCap,
    },
    sections: [
      { id: "overview", number: 1, title: "内容概览", modules: [{ id: "overview-main", title: null, profileModule: "overview", blocks: [{ id: "overview-prose", type: "prose_group", provenance: "system", paragraphs: buildOverview(legacyMarkdown, brief) }] }] },
      { id: "themes", number: 2, title: "主题详解", modules: themeModules },
      { id: "navigation", number: 3, title: manifest.sourceType === "article" ? "文章路线图" : "导航时间线", modules: [{ id: "navigation-main", title: null, profileModule: "navigation", blocks: [{ id: "navigation-timeline", type: "timeline", provenance: "system", items: buildTimeline(legacyMarkdown, claims, themeMap.themes, config) }] }] },
      { id: "verification", number: 4, title: "争议、边界与外部核验", modules: [{ id: "verification-main", title: null, profileModule: "verification", blocks: verificationBlocks }] },
    ],
  };
  return { deepRead, readerMap: buildReaderMap(claims, deepRead) };
}

async function archiveWorkflow2(caseDir, manifest) {
  const archiveRoot = path.join(caseDir, "legacy", "workflow-2.0.0");
  if (await exists(path.join(archiveRoot, "manifest.json"))) return archiveRoot;
  await fs.mkdir(archiveRoot, { recursive: true });
  await writeJson(path.join(archiveRoot, "manifest.json"), manifest);
  for (const relative of [
    "output/deep-read.json",
    "output/deep-read.md",
    "output/brief.json",
    "output/quickread.html",
    "work/quality-report.json",
    "work/render-report.json",
    "work/migration-comparison.json",
  ]) {
    const source = path.join(caseDir, ...relative.split("/"));
    if (!(await exists(source))) continue;
    const destination = path.join(archiveRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  return archiveRoot;
}

export async function migrateReaderEdition(caseDir) {
  const { manifest, manifestPath } = await loadCase(caseDir);
  await archiveWorkflow2(caseDir, manifest);
  const [config, profiles, claims, themeMap, coverage, normalized, brief, research, density, legacyMarkdown] = await Promise.all([
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    readJson(path.join(REPO_ROOT, "config", "profiles.json")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "work", "theme-map.json")),
    readJson(path.join(caseDir, "work", "coverage.json")),
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJson(path.join(caseDir, "output", "brief.json")),
    readJson(path.join(caseDir, "work", "research.json")),
    readJson(path.join(caseDir, "work", "density-assessment.json")),
    fs.readFile(path.join(caseDir, "legacy", "workflow-1.5.0", "output", "deep-read.md"), "utf8"),
  ]);
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const effectiveSourceCharacters = coverage.entries
    .filter((entry) => entry.status === "mapped")
    .reduce((total, entry) => total + compactCharacters(sourceById.get(entry.sourceId)?.text), 0);
  const targets = adaptiveTargets(density.total, effectiveSourceCharacters, config);
  manifest.workflow = { version: config.workflowVersion, promptVersion: config.promptVersion, templateVersion: config.templateVersion };
  manifest.profile.version = profiles.version;
  brief.workflowVersion = config.workflowVersion;
  brief.profile.version = profiles.version;
  brief.density.targetCharacters = targets.targetBriefCharacters;
  const { deepRead, readerMap } = buildReaderEditionData({ manifest, brief, claims, themeMap, density, targets, research, legacyMarkdown, config });
  await Promise.all([
    writeJson(manifestPath, manifest),
    writeJson(path.join(caseDir, "output", "brief.json"), brief),
    writeJson(path.join(caseDir, "output", "deep-read.json"), deepRead),
    writeJson(path.join(caseDir, "work", "reader-map.json"), readerMap),
    writeJson(path.join(caseDir, "work", "density-assessment.json"), { ...density, targets }),
  ]);
  const built = await buildDeepRead(caseDir);
  return { manifest, deepRead, readerMap, built };
}
