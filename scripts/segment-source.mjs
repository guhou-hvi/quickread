import path from "node:path";
import {
  isMain,
  loadCase,
  normalizeText,
  readJsonLines,
  resolveCaseDir,
  sha256File,
  writeJson,
  writeJsonLines,
} from "./lib.mjs";
import { compactCharacters } from "./workflow-contract.mjs";

const NOISE_PATTERN = /^(?:\[[^\]]{1,24}\]|【[^】]{1,24}】|\([^)]{1,24}\)|（[^）]{1,24}）)$/u;
const GREETING_PATTERN = /^(?:hello|hi|hey|ok(?:ay)?|大家好|你好|您好|谢谢|感谢|嗯+|啊+|哦+|好+|对+)[!！。,.， ]*$/iu;
// Advertisement exclusion must be high precision. Generic words such as
// “广告” and “赞助” often carry substantive claims about business models,
// research funding, or partnerships and must remain in the semantic source.
const AD_PATTERN = /(?:一键三连|点赞.{0,6}投币|订阅.{0,6}(?:频道|节目)|(?:优惠|兑换|专属)码|(?:复制|输入|使用).{0,8}口令|(?:本期|本节目).{0,24}(?:由|感谢).{0,24}(?:赞助|支持)|(?:感谢|鸣谢).{1,24}(?:对)?(?:本期|本节目).{0,12}(?:赞助|支持)|(?:进入|插播).{0,4}广告)/u;

export function isHighConfidenceAdvertisement(value) {
  const text = normalizeText(String(value ?? ""));
  return compactCharacters(text) <= 80 && AD_PATTERN.test(text);
}

export function coverageLedgerFindings(units, segments, coverage, { caseId = null, sourceHash = null } = {}) {
  const hardErrors = [];
  const diagnostics = [];
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const unitIds = new Set(unitById.keys());
  const segmentById = new Map((segments ?? []).map((segment) => [segment.id, segment]));
  const entries = coverage?.entries ?? [];
  const entryBySource = new Map(entries.map((entry) => [entry.sourceId, entry]));
  if (coverage?.schemaVersion !== "2.0.0") hardErrors.push("coverage schemaVersion 必须为 2.0.0。");
  if (caseId && coverage?.caseId !== caseId) hardErrors.push("coverage.caseId 与案例不一致。");
  if (sourceHash && coverage?.sourceHash !== sourceHash) hardErrors.push("coverage.sourceHash 与只读来源不一致。");
  if (entries.length !== entryBySource.size) hardErrors.push("coverage sourceId 必须唯一。");
  for (const entry of entries) {
    const unit = unitById.get(entry.sourceId);
    if (!unit) {
      hardErrors.push(`coverage 引用未知来源单元：${entry.sourceId}`);
      continue;
    }
    if (entry.status === "mapped") {
      const segment = segmentById.get(entry.segmentId);
      if (!segment?.sourceIds?.includes(entry.sourceId)) hardErrors.push(`coverage 的 ${entry.sourceId} 未由 ${entry.segmentId} 唯一拥有。`);
    } else if (entry.status === "excluded") {
      if (!entry.reason || !entry.exclusionKind || entry.segmentId !== null) hardErrors.push(`排除项 ${entry.sourceId} 缺少原因或仍指向 segment。`);
      if (entry.exclusionKind === "advertisement" && !isHighConfidenceAdvertisement(unit.text)) {
        hardErrors.push(`广告排除项 ${entry.sourceId} 不符合高精度推广口播规则；不得仅因出现“广告”或“赞助”而排除。`);
      }
    } else if (entry.status === "unmapped") {
      diagnostics.push(`coverage 的 ${entry.sourceId} 尚未完成映射或排除。`);
    } else {
      hardErrors.push(`coverage 的 ${entry.sourceId} status 非法：${entry.status}`);
    }
  }
  for (const sourceId of unitIds) {
    if (!entryBySource.has(sourceId)) diagnostics.push(`coverage 缺少来源单元：${sourceId}`);
  }
  const ownership = new Map();
  for (const segment of segments ?? []) {
    if (caseId && segment.caseId !== caseId) hardErrors.push(`segment caseId 不一致：${segment.id}`);
    const expectedText = normalizeText((segment.sourceIds ?? []).map((sourceId) => unitById.get(sourceId)?.text ?? "").join(" "));
    if (normalizeText(segment.text ?? "") !== expectedText) hardErrors.push(`segment ${segment.id} 的 text 与其来源单元不一致。`);
    for (const sourceId of segment.sourceIds ?? []) {
      if (!unitIds.has(sourceId)) hardErrors.push(`segment ${segment.id} 引用未知来源单元：${sourceId}`);
      if (ownership.has(sourceId)) hardErrors.push(`多个 segment 重复拥有来源单元：${sourceId}`);
      ownership.set(sourceId, segment.id);
      const entry = entryBySource.get(sourceId);
      if (!entry || entry.status === "unmapped") continue;
      if (entry.status !== "mapped" || entry.segmentId !== segment.id) {
        hardErrors.push(`segment ${segment.id} 与 coverage 对 ${sourceId} 的所有权不一致。`);
      }
    }
  }
  return {
    hardErrors: [...new Set(hardErrors)],
    diagnostics: [...new Set(diagnostics)],
  };
}

export function coverageLedgerErrors(units, segments, coverage, options = {}) {
  return coverageLedgerFindings(units, segments, coverage, options).hardErrors;
}

function exclusionFor(unit, previousIncludedText) {
  const text = normalizeText(unit.text);
  if (!text) return { kind: "noise", reason: "空白或无法识别的字幕噪声" };
  if (NOISE_PATTERN.test(text) && /音乐|笑|掌声|噪声|music|applause/i.test(text)) {
    return { kind: "noise", reason: "非语义音效或舞台提示" };
  }
  if (compactCharacters(text) <= 12 && GREETING_PATTERN.test(text)) {
    return { kind: "greeting", reason: "不承载实质信息的寒暄或附和" };
  }
  if (isHighConfidenceAdvertisement(text)) {
    return { kind: "advertisement", reason: "节目广告、订阅或平台引导" };
  }
  if (previousIncludedText && normalizeText(previousIncludedText) === text) {
    return { kind: "duplicate", reason: "与上一有效来源单元完全重复" };
  }
  return null;
}

function locatorFor(units) {
  const first = units[0];
  const last = units.at(-1);
  if (first.locator.type === "time") {
    return {
      type: "time",
      label: `${first.locator.start?.slice(0, 8)}–${last.locator.end?.slice(0, 8)}`,
      start: first.locator.start,
      end: last.locator.end,
      heading: null,
    };
  }
  return {
    type: first.locator.type,
    label: units.length === 1 ? first.locator.label : `${first.locator.label}–${last.locator.label}`,
    start: null,
    end: null,
    heading: first.locator.heading ?? null,
  };
}

function speakerFor(units, participants, minimumConfidence) {
  const prefixes = units
    .map((unit) => unit.text.match(/^\s*([\p{L}\p{N}·・]{1,24})\s*[：:]/u)?.[1] ?? null)
    .filter(Boolean);
  if (!prefixes.length || new Set(prefixes).size !== 1) {
    return { name: null, status: "unknown", confidence: 0 };
  }
  const prefix = prefixes[0];
  const confirmed = participants.find((participant) => participant.includes(prefix));
  if (confirmed) return { name: confirmed, status: "confirmed", confidence: 1 };
  const confidence = prefixes.length >= Math.max(2, Math.ceil(units.length * 0.6)) ? 0.8 : 0.6;
  if (confidence < minimumConfidence) return { name: null, status: "unknown", confidence };
  return { name: prefix, status: "inferred", confidence };
}

function shouldBreak(current, next, options) {
  if (!current.length) return false;
  const characters = current.reduce((total, unit) => total + compactCharacters(unit.text), 0);
  if (current.length >= options.maximumUnits || characters >= options.maximumCharacters) return true;
  const last = current.at(-1);
  if (last.locator.type === "time" && next.locator.type === "time") {
    const gap = (next.locator.startMs ?? 0) - (last.locator.endMs ?? 0);
    if (gap > options.maximumGapMs) return true;
  }
  if (characters >= options.preferredCharacters && /[。！？!?]$/u.test(last.text)) return true;
  if (last.locator.heading && next.locator.heading && last.locator.heading !== next.locator.heading) return true;
  return false;
}

export function buildSegments(units, {
  caseId,
  participants = [],
  maximumCharacters = 1200,
  preferredCharacters = 650,
  maximumUnits = 48,
  maximumGapMs = 8000,
  contextUnits = 2,
  speakerMinimumConfidence = 0.85,
} = {}) {
  const exclusions = new Map();
  const included = [];
  let previousIncludedText = null;
  for (const unit of units) {
    const exclusion = exclusionFor(unit, previousIncludedText);
    if (exclusion) exclusions.set(unit.id, exclusion);
    else {
      included.push(unit);
      previousIncludedText = unit.text;
    }
  }

  const groups = [];
  let current = [];
  for (const unit of included) {
    if (shouldBreak(current, unit, { maximumCharacters, preferredCharacters, maximumUnits, maximumGapMs })) {
      groups.push(current);
      current = [];
    }
    current.push(unit);
  }
  if (current.length) groups.push(current);

  const includedIndex = new Map(included.map((unit, index) => [unit.id, index]));
  const segments = groups.map((group, index) => {
    const firstIndex = includedIndex.get(group[0].id);
    const lastIndex = includedIndex.get(group.at(-1).id);
    return {
      schemaVersion: "1.0.0",
      id: `S${String(index + 1).padStart(4, "0")}`,
      caseId,
      sourceIds: group.map((unit) => unit.id),
      contextBefore: included.slice(Math.max(0, firstIndex - contextUnits), firstIndex).map((unit) => unit.id),
      contextAfter: included.slice(lastIndex + 1, lastIndex + 1 + contextUnits).map((unit) => unit.id),
      locator: locatorFor(group),
      text: normalizeText(group.map((unit) => unit.text).join(" ")),
      speaker: speakerFor(group, participants, speakerMinimumConfidence),
    };
  });
  const sourceToSegment = new Map();
  for (const segment of segments) for (const sourceId of segment.sourceIds) sourceToSegment.set(sourceId, segment.id);
  const entries = units.map((unit) => {
    const exclusion = exclusions.get(unit.id);
    if (exclusion) {
      return { sourceId: unit.id, status: "excluded", segmentId: null, reason: exclusion.reason, exclusionKind: exclusion.kind };
    }
    return { sourceId: unit.id, status: "mapped", segmentId: sourceToSegment.get(unit.id), reason: null, exclusionKind: null };
  });
  return { segments, entries };
}

export async function segmentCase(caseDir) {
  const { manifest, sourcePath } = await loadCase(caseDir);
  if (!manifest.profile?.primary) throw new Error("请先选择 profile，再建立语义 segments。");
  const units = await readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl"));
  const sourceHash = await sha256File(sourcePath);
  const { segments, entries } = buildSegments(units, {
    caseId: manifest.id,
    participants: manifest.participants,
  });
  await writeJsonLines(path.join(caseDir, "work", "segments.jsonl"), segments);
  await writeJson(path.join(caseDir, "work", "coverage.json"), {
    schemaVersion: "2.0.0",
    caseId: manifest.id,
    sourceHash,
    entries,
  });
  return { manifest, segments, entries };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await segmentCase(caseDir);
    const excluded = result.entries.filter((entry) => entry.status === "excluded").length;
    console.log(`已建立 ${result.segments.length} 个语义片段；明确排除 ${excluded} 个来源单元。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}


