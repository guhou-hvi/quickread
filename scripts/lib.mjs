import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const CASES_ROOT = path.join(REPO_ROOT, "cases");

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, value, "utf8");
  await fs.rename(temporary, filePath);
}

export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function resolveCaseDir(argument) {
  if (!argument) {
    throw new Error("缺少案例目录。示例：cases/qr-0001-cage-ai-agent");
  }
  const resolved = path.resolve(REPO_ROOT, argument);
  const relative = path.relative(CASES_ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`案例目录必须位于 cases/ 下：${resolved}`);
  }
  return resolved;
}

export async function loadCase(caseDir) {
  const manifestPath = path.join(caseDir, "case.json");
  const manifest = await readJson(manifestPath);
  if (manifest.id !== path.basename(caseDir)) {
    throw new Error(`case.json id 与目录名不一致：${manifest.id}`);
  }
  const sourcePath = path.resolve(caseDir, manifest.source.path);
  const relative = path.relative(caseDir, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("source.path 不能指向案例目录之外。");
  }
  return { manifest, manifestPath, sourcePath };
}

export function parseTimestamp(value) {
  if (!value) return null;
  const cleaned = value.trim().replace(",", ".");
  const pieces = cleaned.split(":").map(Number);
  if (pieces.some(Number.isNaN)) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (pieces.length === 3) {
    [hours, minutes, seconds] = pieces;
  } else if (pieces.length === 2) {
    [minutes, seconds] = pieces;
  } else {
    return null;
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function formatTimestamp(milliseconds, includeMillis = true) {
  const total = Math.max(0, milliseconds);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return includeMillis ? `${base}.${String(millis).padStart(3, "0")}` : base;
}

export function normalizeText(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimedBlocks(text) {
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/^WEBVTT[^\n]*\n+/i, "")
    .split(/\r?\n\s*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0 || /^NOTE\b/i.test(lines[0] ?? "")) continue;
    const match = lines[timeIndex].match(
      /(?<start>\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})\s*-->\s*(?<end>\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})/,
    );
    if (!match?.groups) continue;
    const startMs = parseTimestamp(match.groups.start);
    const endMs = parseTimestamp(match.groups.end);
    const cueText = normalizeText(lines.slice(timeIndex + 1).join(" "));
    if (startMs === null || endMs === null || !cueText) continue;
    cues.push({ startMs, endMs, text: cueText });
  }
  return cues.map((cue, index) => ({
    id: `C${String(index + 1).padStart(6, "0")}`,
    locator: {
      type: "time",
      label: `${formatTimestamp(cue.startMs, false)}–${formatTimestamp(cue.endMs, false)}`,
      start: formatTimestamp(cue.startMs),
      end: formatTimestamp(cue.endMs),
      startMs: cue.startMs,
      endMs: cue.endMs,
    },
    text: cue.text,
  }));
}

function parseArticle(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const units = [];
  let heading = "正文";
  let paragraph = [];

  const flush = () => {
    const value = normalizeText(paragraph.join(" "));
    paragraph = [];
    if (!value) return;
    const index = units.length + 1;
    units.push({
      id: `P${String(index).padStart(6, "0")}`,
      locator: {
        type: "paragraph",
        label: `${heading} · 段落 ${index}`,
        heading,
        paragraph: index,
      },
      text: value,
    });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = normalizeText(headingMatch[1]);
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return units;
}

export async function parseSource(sourcePath, format) {
  const text = await fs.readFile(sourcePath, "utf8");
  if (format === "srt" || format === "vtt") return parseTimedBlocks(text);
  if (format === "txt" || format === "md") return parseArticle(text);
  throw new Error(`不支持的来源格式：${format}`);
}

export async function writeJsonLines(filePath, values) {
  await writeText(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

export async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath} 第 ${index + 1} 行不是有效 JSON：${error.message}`);
      }
    });
}

export function extractLegacySection(markdown, sectionNumber) {
  const startPattern = new RegExp(`【${sectionNumber}\\.[^】]+】`);
  const startMatch = startPattern.exec(markdown);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  const nextPattern = new RegExp(`【${sectionNumber + 1}\\.[^】]+】`, "g");
  nextPattern.lastIndex = start;
  const nextMatch = nextPattern.exec(markdown);
  return markdown.slice(start, nextMatch?.index ?? markdown.length).trim();
}

export function parseLegacyTimeline(markdown) {
  const section = extractLegacySection(markdown, 3);
  const lines = section.split(/\r?\n/);
  const rawEntries = [];
  let current = null;
  const headingPattern = /^\s*[*-]\s+(\d{1,2}:\d{2}(?::\d{2})?)[-–—](\d{1,2}:\d{2}(?::\d{2})?)：\s*(.+)$/;
  for (const line of lines) {
    const match = line.match(headingPattern);
    if (match) {
      if (current) rawEntries.push(current);
      current = {
        start: match[1],
        end: match[2],
        title: normalizeText(match[3]),
        bullets: [],
      };
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^\s*[*-]\s+(.+)$/);
    if (bullet) current.bullets.push(normalizeText(bullet[1].replace(/\*\*/g, "")));
  }
  if (current) rawEntries.push(current);
  const timestampValues = rawEntries.flatMap((entry) => [entry.start, entry.end]);
  const hasMixedPrecision = timestampValues.some((value) => value.split(":").length === 3) &&
    timestampValues.some((value) => value.split(":").length === 2);
  const timelineTimestamp = (value) => {
    const parts = value.split(":").map(Number);
    if (hasMixedPrecision && parts.length === 2) {
      return Math.round((parts[0] * 3600 + parts[1] * 60) * 1000);
    }
    return parseTimestamp(value);
  };
  const entries = rawEntries.map((entry) => ({
    ...entry,
    startMs: timelineTimestamp(entry.start),
    endMs: timelineTimestamp(entry.end),
  }));
  return entries.filter((entry) => entry.startMs !== null && entry.endMs !== null);
}

export function markdownWithoutRules(value) {
  return value
    .replace(/^---\s*$/gm, "")
    .replace(/^\s+|\s+$/g, "")
    .trim();
}

export async function listCaseDirs(casesRoot = CASES_ROOT) {
  const entries = await fs.readdir(casesRoot, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(casesRoot, entry.name))
    .sort();
}

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(fileURLToPath(metaUrl)) === path.resolve(process.argv[1]);
}
