import fs from "node:fs/promises";
import path from "node:path";
import {
  isMain,
  listCaseDirs,
  loadCase,
  normalizeText,
  parseSource,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
  writeJson,
  writeJsonLines,
} from "./lib.mjs";
import { buildSegments } from "./segment-source.mjs";
import { buildDeepRead } from "./deep-read.mjs";
import { buildReaderEditionData } from "./reader-edition.mjs";
import { computeQualityReport } from "./quality-report.mjs";
import {
  adaptiveTargets,
  claimSimilarity,
  collectBlockCharacters,
  compactCharacters,
  expectedReadingMinutes,
  normalizedClaim,
} from "./workflow-contract.mjs";
import { SEEDED_PROFILES, inferLenses } from "./profile-case.mjs";

const PILOT_NUMBERS = new Set(["QR-0002", "QR-0011", "QR-0013", "QR-0017", "QR-0022", "QR-0023"]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function archiveBaseline(caseDir, manifest) {
  const archiveRoot = path.join(caseDir, "legacy", "workflow-1.5.0");
  if (await exists(path.join(archiveRoot, "manifest.json"))) return archiveRoot;
  await fs.mkdir(archiveRoot, { recursive: true });
  await writeJson(path.join(archiveRoot, "manifest.json"), manifest);
  const relativeFiles = [
    "work/coverage.json",
    "work/evidence.jsonl",
    "work/render-report.json",
    "output/deep-read.md",
    "output/brief.json",
    "output/quickread.html",
  ];
  for (const relative of relativeFiles) {
    const source = path.join(caseDir, ...relative.split("/"));
    if (!(await exists(source))) continue;
    const destination = path.join(archiveRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  return archiveRoot;
}

async function baselineJson(caseDir, relative, fallback) {
  const archived = path.join(caseDir, "legacy", "workflow-1.5.0", ...relative.split("/"));
  const current = path.join(caseDir, ...relative.split("/"));
  try {
    return await readJson((await exists(archived)) ? archived : current);
  } catch {
    return fallback;
  }
}

async function baselineJsonLines(caseDir, relative) {
  const archived = path.join(caseDir, "legacy", "workflow-1.5.0", ...relative.split("/"));
  const current = path.join(caseDir, ...relative.split("/"));
  try {
    return await readJsonLines((await exists(archived)) ? archived : current);
  } catch {
    return [];
  }
}

function unitGroups(segment, sourceById, sourceOrder, maximumCharacters = 150) {
  const groups = [];
  let current = [];
  let characters = 0;
  for (const sourceId of segment.sourceIds) {
    const unit = sourceById.get(sourceId);
    if (!unit) continue;
    const previousId = current.at(-1)?.id;
    const isAdjacent = !previousId || sourceOrder.get(sourceId) === sourceOrder.get(previousId) + 1;
    const nextCharacters = compactCharacters(unit.text);
    if (current.length && (!isAdjacent || characters + nextCharacters > maximumCharacters || (characters >= 65 && /[。！？!?]$/u.test(current.at(-1).text)))) {
      groups.push(current);
      current = [];
      characters = 0;
    }
    current.push(unit);
    characters += nextCharacters;
  }
  if (current.length) groups.push(current);
  return groups.filter((group) => compactCharacters(group.map((unit) => unit.text).join(" ")) >= 8);
}

function claimRole(statement) {
  if (/(?:不确定|不清楚|不知道|可能是|也许|大概)/u.test(statement)) return "uncertainty";
  if (/(?:限制|前提|条件|风险|代价|不能|无法|瓶颈)/u.test(statement)) return "limitation";
  if (/(?:反驳|并不是|并非|但是|不过|相反)/u.test(statement)) return "rebuttal";
  if (/(?:未来|预测|会不会|将会|我觉得.*会|可能会)/u.test(statement)) return "prediction";
  if (/(?:当时|后来|曾经|记得|回忆|那一年)/u.test(statement)) return "recollection";
  if (/(?:比如|例如|举个例子|案例)/u.test(statement)) return "example";
  if (/(?:我觉得|我认为|我相信|在我看来|我们判断)/u.test(statement)) return "opinion";
  return "fact";
}

function importanceFor(statement, index, tags) {
  let score = 0;
  if (/\d/u.test(statement)) score += 2;
  if (tags.some((tag) => tag.length >= 2 && statement.toLocaleLowerCase("zh-CN").includes(tag.toLocaleLowerCase("zh-CN")))) score += 2;
  if (/(?:因为|所以|意味着|关键|核心|结论|风险|限制|但是|未来)/u.test(statement)) score += 1;
  if (compactCharacters(statement) >= 70) score += 1;
  if (score >= 4 && index % 2 === 0) return "high";
  if (score >= 2 && index % 3 === 0) return "medium";
  return "low";
}

function oldThemeLookup(brief, oldEvidence) {
  const evidenceTheme = new Map();
  for (const [sectionIndex, section] of (brief.sections ?? []).entries()) {
    const refs = new Set();
    for (const anchor of section.timeAnchors ?? []) for (const ref of anchor.evidenceRefs ?? []) refs.add(ref);
    for (const block of section.blocks ?? []) {
      for (const ref of block.evidenceRefs ?? []) refs.add(ref);
      for (const item of block.items ?? []) for (const ref of item.evidenceRefs ?? []) refs.add(ref);
    }
    for (const ref of refs) if (!evidenceTheme.has(ref)) evidenceTheme.set(ref, sectionIndex);
  }
  const sourceTheme = new Map();
  for (const evidence of oldEvidence) {
    const theme = evidenceTheme.get(evidence.id);
    if (theme === undefined) continue;
    for (const sourceId of evidence.sourceIds ?? []) if (!sourceTheme.has(sourceId)) sourceTheme.set(sourceId, theme);
  }
  return sourceTheme;
}

function buildClaims({ manifest, units, segments, brief, oldEvidence }) {
  const sourceById = new Map(units.map((unit) => [unit.id, unit]));
  const sourceOrder = new Map(units.map((unit, index) => [unit.id, index]));
  const sourceTheme = oldThemeLookup(brief, oldEvidence);
  const themeCount = Math.max(1, brief.sections?.length ?? 1);
  const candidates = [];
  for (const segment of segments) {
    for (const group of unitGroups(segment, sourceById, sourceOrder)) {
      const statement = normalizeText(group.map((unit) => unit.text).join(" "));
      const role = claimRole(statement);
      const themed = group.map((unit) => sourceTheme.get(unit.id)).find((value) => value !== undefined);
      const fallbackTheme = Math.min(themeCount - 1, Math.floor(sourceOrder.get(group[0].id) / Math.max(1, units.length) * themeCount));
      candidates.push({
        statement,
        role,
        segment,
        group,
        themeIndex: themed ?? fallbackTheme,
      });
    }
  }
  const deduplicated = [];
  const exact = new Map();
  for (const candidate of candidates) {
    const key = normalizedClaim(candidate.statement);
    const existing = exact.get(key) ?? deduplicated.find((item) => claimSimilarity(item.statement, candidate.statement) >= 0.93);
    if (existing) {
      existing.occurrences.push({ segment: candidate.segment, group: candidate.group });
      continue;
    }
    candidate.occurrences = [{ segment: candidate.segment, group: candidate.group }];
    exact.set(key, candidate);
    deduplicated.push(candidate);
  }
  return deduplicated.map((candidate, index) => {
    const speaker = candidate.segment.speaker;
    const role = candidate.role;
    return {
      schemaVersion: "2.0.0",
      id: `E${String(index + 1).padStart(4, "0")}`,
      caseId: manifest.id,
      statement: candidate.statement,
      provenance: ["opinion", "prediction", "recollection", "rebuttal", "limitation", "uncertainty"].includes(role) ? "speaker_view" : "source_fact",
      importance: importanceFor(candidate.statement, index, manifest.tags ?? []),
      claimRole: role,
      speaker: speaker.name && speaker.confidence >= 0.85
        ? speaker
        : { name: null, status: "unknown", confidence: speaker.confidence ?? 0 },
      themeId: `T${String(candidate.themeIndex + 1).padStart(3, "0")}`,
      supportSpans: candidate.occurrences.map(({ segment, group }) => ({
        segmentId: segment.id,
        sourceIds: group.map((unit) => unit.id),
        locator: group.length === 1
          ? group[0].locator.label
          : `${group[0].locator.label}–${group.at(-1).locator.label}`,
        quote: normalizeText(group.map((unit) => unit.text).join(" ")),
      })),
      notes: "由 1.5.0 基线迁移时按连续来源区段原子化；需在试点人工校准中复核语义边界。",
    };
  });
}

function densityAssessment(units, claims, profile) {
  const text = units.map((unit) => unit.text).join(" ");
  const effective = Math.max(1, compactCharacters(text));
  const meanCue = effective / Math.max(1, units.length);
  const numericRate = (text.match(/[\d%％]/gu) ?? []).length / effective;
  const controversyRate = (text.match(/(?:但是|不过|争议|风险|限制|不确定|反对|问题)/gu) ?? []).length / Math.max(1, units.length);
  const uniqueClaims = new Set(claims.map((claim) => normalizedClaim(claim.statement))).size / Math.max(1, claims.length);
  const clamp = (value) => Math.max(0, Math.min(4, Math.round(value)));
  const scores = {
    atomicInformation: clamp(meanCue / 4),
    themeDependency: { knowledge: 4, strategy: 3, narrative: 2, debate: 4, general: 2 }[profile] ?? 2,
    evidenceRichness: clamp(numericRate * 280 + (claims.length / Math.max(1, units.length)) * 3),
    controversy: clamp(controversyRate * 22),
    uniqueness: clamp(uniqueClaims * 4),
  };
  return {
    scores,
    total: Object.values(scores).reduce((total, value) => total + value, 0),
    assessmentMode: "deterministic-migration-seed",
    rationale: {
      atomicInformation: `平均每个来源单元 ${meanCue.toFixed(1)} 个有效字符。`,
      themeDependency: `按 ${profile} profile 的跨主题依赖基线评分。`,
      evidenceRichness: `数字标记率 ${(numericRate * 100).toFixed(2)}%，claim/source 比 ${(claims.length / Math.max(1, units.length)).toFixed(2)}。`,
      controversy: `限制、风险与转折标记率 ${(controversyRate * 100).toFixed(2)}%。`,
      uniqueness: `去重后 claim 唯一率 ${(uniqueClaims * 100).toFixed(1)}%。`,
    },
  };
}

function buildThemes(brief, claims, profileConfig, profile) {
  const sections = brief.sections?.length ? brief.sections : [{ title: "主要内容", lead: "来源的主要语义线索。" }];
  const modules = profileConfig.profiles[profile].modules;
  const themes = sections.map((section, index) => {
    const id = `T${String(index + 1).padStart(3, "0")}`;
    const themeClaims = claims.filter((claim) => claim.themeId === id);
    return {
      id,
      order: index + 1,
      title: section.title,
      summary: section.lead || "本主题按来源时间与既有语义锚点归并。",
      profileModules: [modules[index % modules.length]],
      claimRefs: themeClaims.map((claim) => claim.id),
      importanceCoverage: Object.fromEntries(["high", "medium", "low"].map((importance) => [importance, themeClaims.filter((claim) => claim.importance === importance).length])),
    };
  }).filter((theme) => theme.claimRefs.length);
  for (const [index, theme] of themes.entries()) {
    const previousId = theme.id;
    const nextId = `T${String(index + 1).padStart(3, "0")}`;
    theme.id = nextId;
    theme.order = index + 1;
    for (const claim of claims) if (claim.themeId === previousId) claim.themeId = nextId;
  }
  return themes;
}

function overlappingClaims(oldRef, oldEvidenceById, claims) {
  const sourceIds = new Set(oldEvidenceById.get(oldRef)?.sourceIds ?? []);
  if (!sourceIds.size) return [];
  return claims.filter((claim) => claim.supportSpans.some((span) => span.sourceIds.some((id) => sourceIds.has(id)))).map((claim) => claim.id);
}

function updateBriefRefs(brief, claims, oldEvidence) {
  const oldEvidenceById = new Map(oldEvidence.map((item) => [item.id, item]));
  const themeClaims = new Map();
  for (const claim of claims) {
    if (!themeClaims.has(claim.themeId)) themeClaims.set(claim.themeId, []);
    themeClaims.get(claim.themeId).push(claim.id);
  }
  const resolve = (refs, fallback) => {
    const mapped = [...new Set((refs ?? []).flatMap((ref) => overlappingClaims(ref, oldEvidenceById, claims)))];
    return (mapped.length ? mapped : fallback).slice(0, 4);
  };
  for (const [sectionIndex, section] of brief.sections.entries()) {
    const fallback = (themeClaims.get(`T${String(sectionIndex + 1).padStart(3, "0")}`) ?? claims.map((claim) => claim.id)).slice(0, 4);
    for (const anchor of section.timeAnchors ?? []) anchor.evidenceRefs = resolve(anchor.evidenceRefs, fallback);
    for (const block of section.blocks ?? []) {
      if (["source_fact", "speaker_view"].includes(block.provenance) || block.intent === "summary" || block.evidenceRefs?.length) {
        block.evidenceRefs = resolve(block.evidenceRefs, fallback);
      }
      for (const item of block.items ?? []) if (item.evidenceRefs?.length || ["source_fact", "speaker_view"].includes(block.provenance)) item.evidenceRefs = resolve(item.evidenceRefs, fallback);
    }
  }
  return brief;
}

function buildAuditClaims(units, segments, claims, manifest) {
  const sourceById = new Map(units.map((unit) => [unit.id, unit]));
  const sourceOrder = new Map(units.map((unit, index) => [unit.id, index]));
  const candidates = [];
  for (const segment of segments) {
    for (const group of unitGroups(segment, sourceById, sourceOrder, 220)) {
      candidates.push({
        statement: normalizeText(group.map((unit) => unit.text).join(" ")),
        segment,
        group,
      });
    }
  }
  return candidates.map((candidate, index) => {
    const candidateIds = new Set(candidate.group.map((unit) => unit.id));
    const matches = claims.filter((claim) => claim.supportSpans.some((span) =>
      span.sourceIds.some((sourceId) => candidateIds.has(sourceId))));
    const covered = new Set(matches.flatMap((claim) => claim.supportSpans.flatMap((span) =>
      span.sourceIds.filter((sourceId) => candidateIds.has(sourceId)))));
    const coverage = covered.size / candidateIds.size;
    return {
      schemaVersion: "1.0.0",
      id: `A${String(index + 1).padStart(4, "0")}`,
      method: "independent-segment-reextract",
      statement: candidate.statement,
      importance: importanceFor(candidate.statement, index + 1, manifest.tags ?? []),
      supportSpans: [{
        segmentId: candidate.segment.id,
        sourceIds: candidate.group.map((unit) => unit.id),
        locator: candidate.group.length === 1
          ? candidate.group[0].locator.label
          : `${candidate.group[0].locator.label}–${candidate.group.at(-1).locator.label}`,
        quote: candidate.statement,
      }],
      matchedEvidenceRefs: matches.map((claim) => claim.id),
      status: coverage >= 0.95 ? "matched" : "missing",
      notes: `先以独立 220 字符边界重提，再按 support span 对齐；来源单元覆盖率 ${(coverage * 100).toFixed(1)}%。`,
    };
  });
}

function repairClaimsFromAudit(claims, auditClaims, segments) {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const repaired = [...claims];
  for (const candidate of auditClaims.filter((item) => item.status !== "matched")) {
    const segmentId = candidate.supportSpans[0].segmentId;
    const nearby = repaired.find((claim) => claim.supportSpans.some((span) => span.segmentId === segmentId));
    const segment = segmentById.get(segmentId);
    const role = claimRole(candidate.statement);
    repaired.push({
      schemaVersion: "2.0.0",
      id: `E${String(repaired.length + 1).padStart(4, "0")}`,
      caseId: claims[0]?.caseId,
      statement: candidate.statement,
      provenance: ["opinion", "prediction", "recollection", "rebuttal", "limitation", "uncertainty"].includes(role) ? "speaker_view" : "source_fact",
      importance: candidate.importance,
      claimRole: role,
      speaker: segment?.speaker?.name && segment.speaker.confidence >= 0.85
        ? segment.speaker
        : { name: null, status: "unknown", confidence: segment?.speaker?.confidence ?? 0 },
      themeId: nearby?.themeId ?? "T001",
      supportSpans: candidate.supportSpans,
      notes: `由独立审计候选 ${candidate.id} 发现遗漏后自动补入；需在试点人工校准中复核。`,
    });
  }
  return repaired;
}

function updateResearch(research, oldEvidence, claims) {
  const oldEvidenceById = new Map(oldEvidence.map((item) => [item.id, item]));
  for (const check of research.checks ?? []) {
    const mapped = [...new Set((check.evidenceIds ?? []).flatMap((ref) => overlappingClaims(ref, oldEvidenceById, claims)))];
    check.evidenceIds = mapped.slice(0, 6);
  }
  return research;
}

export async function migrateCaseV2(caseDir) {
  const { manifest, manifestPath, sourcePath } = await loadCase(caseDir);
  const archiveRoot = await archiveBaseline(caseDir, manifest);
  const [config, profileConfig, oldBrief, oldEvidence, research] = await Promise.all([
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    readJson(path.join(REPO_ROOT, "config", "profiles.json")),
    baselineJson(caseDir, "output/brief.json", null),
    baselineJsonLines(caseDir, "work/evidence.jsonl"),
    baselineJson(caseDir, "work/research.json", { schemaVersion: "1.0.0", caseId: manifest.id, citations: [], checks: [], background: [] }),
  ]);
  if (!oldBrief) throw new Error(`${manifest.id} 缺少可迁移的 1.5.0 brief。`);
  const normalizedPath = path.join(caseDir, "work", "source.normalized.jsonl");
  const units = (await exists(normalizedPath))
    ? await readJsonLines(normalizedPath)
    : await parseSource(sourcePath, manifest.source.format);
  const profile = SEEDED_PROFILES.get(manifest.caseNumber);
  if (!profile) throw new Error(`${manifest.id} 没有已确认的迁移 profile seed。`);
  manifest.schemaVersion = "1.2.0";
  manifest.profile = {
    primary: profile,
    lenses: inferLenses(manifest, units),
    selection: "seeded",
    confidence: 1,
    version: profileConfig.version,
  };
  manifest.workflow = { version: config.workflowVersion, promptVersion: config.promptVersion, templateVersion: config.templateVersion };
  const sourceHash = await sha256File(sourcePath);
  const { segments, entries } = buildSegments(units, { caseId: manifest.id, participants: manifest.participants });
  const coverage = { schemaVersion: "2.0.0", caseId: manifest.id, sourceHash, entries };
  let claims = buildClaims({ manifest, units, segments, brief: oldBrief, oldEvidence });
  const preliminaryAudit = buildAuditClaims(units, segments, claims, manifest);
  claims = repairClaimsFromAudit(claims, preliminaryAudit, segments);
  const mappedSourceIds = new Set(entries.filter((entry) => entry.status === "mapped").map((entry) => entry.sourceId));
  const density = densityAssessment(units.filter((unit) => mappedSourceIds.has(unit.id)), claims, profile);
  const effectiveCharacters = entries.filter((entry) => entry.status === "mapped")
    .reduce((total, entry) => total + compactCharacters(units.find((unit) => unit.id === entry.sourceId)?.text), 0);
  const targets = adaptiveTargets(density.total, effectiveCharacters, config);
  const themes = buildThemes(oldBrief, claims, profileConfig, profile);
  const themeMap = { schemaVersion: "1.0.0", caseId: manifest.id, profile, themes, unassignedClaimRefs: [] };
  const updatedResearch = updateResearch(structuredClone(research), oldEvidence, claims);
  const updatedBrief = updateBriefRefs(structuredClone(oldBrief), claims, oldEvidence);
  updatedBrief.schemaVersion = "1.3.0";
  updatedBrief.workflowVersion = config.workflowVersion;
  updatedBrief.templateVersion = config.templateVersion;
  updatedBrief.profile = { primary: profile, lenses: manifest.profile.lenses, version: profileConfig.version };
  updatedBrief.density = { scores: density.scores, total: density.total, targetCharacters: targets.targetBriefCharacters };
  const citations = new Map((updatedBrief.citations ?? []).map((citation) => [citation.id, citation]));
  for (const citation of updatedResearch.citations ?? []) citations.set(citation.id, citation);
  updatedBrief.citations = [...citations.values()].sort((first, second) =>
    Number(first.id.slice(1)) - Number(second.id.slice(1)));
  updatedBrief.readingMinutes = expectedReadingMinutes(collectBlockCharacters(updatedBrief), config);
  const legacyMarkdown = await fs.readFile(path.join(archiveRoot, "output", "deep-read.md"), "utf8");
  const { deepRead, readerMap } = buildReaderEditionData({
    manifest,
    brief: updatedBrief,
    claims,
    themeMap,
    density,
    targets,
    research: updatedResearch,
    legacyMarkdown,
    config,
  });
  const auditClaims = buildAuditClaims(units, segments, claims, manifest);
  await writeJson(manifestPath, manifest);
  await writeJsonLines(normalizedPath, units);
  await writeJsonLines(path.join(caseDir, "work", "segments.jsonl"), segments);
  await writeJson(path.join(caseDir, "work", "coverage.json"), coverage);
  await writeJsonLines(path.join(caseDir, "work", "evidence.jsonl"), claims);
  await writeJson(path.join(caseDir, "work", "theme-map.json"), themeMap);
  await writeJson(path.join(caseDir, "work", "reader-map.json"), readerMap);
  await writeJsonLines(path.join(caseDir, "work", "audit-claims.jsonl"), auditClaims);
  await writeJson(path.join(caseDir, "work", "research.json"), updatedResearch);
  await writeJson(path.join(caseDir, "work", "density-assessment.json"), { schemaVersion: "1.0.0", caseId: manifest.id, ...density, targets });
  await writeJson(path.join(caseDir, "work", "profile-selection.json"), {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    selectedAt: new Date().toISOString(),
    selection: "seeded",
    selectedProfile: profile,
    confidence: 1,
    requiresConfirmation: false,
    sampleSourceIds: units.filter((_, index) => index % Math.max(1, Math.floor(units.length / 32)) === 0).slice(0, 32).map((unit) => unit.id),
    lenses: manifest.profile.lenses,
  });
  await writeJson(path.join(caseDir, "output", "brief.json"), updatedBrief);
  await writeJson(path.join(caseDir, "output", "deep-read.json"), deepRead);
  await buildDeepRead(caseDir);
  const quality = await computeQualityReport(caseDir);
  return { manifest, segments: segments.length, claims: claims.length, density: density.total, quality };
}

async function selectedCaseDirs(argument) {
  if (argument === "--all") return listCaseDirs();
  if (argument === "--pilot" || !argument) {
    const selected = [];
    for (const dir of await listCaseDirs()) {
      const manifest = await readJson(path.join(dir, "case.json"));
      if (PILOT_NUMBERS.has(manifest.caseNumber)) selected.push(dir);
    }
    return selected;
  }
  return [resolveCaseDir(argument)];
}

if (isMain(import.meta.url)) {
  const argument = process.argv[2] ?? "--pilot";
  let failed = false;
  for (const caseDir of await selectedCaseDirs(argument)) {
    try {
      const result = await migrateCaseV2(caseDir);
      console.log(`${result.manifest.id}: ${result.segments} segments, ${result.claims} claims, density ${result.density}, quality ${result.quality.status}`);
      if (result.quality.status !== "pass") failed = true;
    } catch (error) {
      failed = true;
      console.error(`${path.basename(caseDir)}: ${error.stack ?? error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

export { PILOT_NUMBERS };
