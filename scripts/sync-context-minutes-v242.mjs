import fs from "node:fs/promises";
import path from "node:path";

import { contextGuideCharacters, contextGuideCitationRefs } from "./context-guide.mjs";
import { isMain, readJson, resolveCaseDir, writeJson } from "./lib.mjs";
import { participantGuideCharacters } from "./participant-guide.mjs";
import { collectBlockCharacters, expectedReadingMinutes } from "./workflow-contract.mjs";

export async function syncContextBriefMetadata(caseDir) {
  const [brief, guide, participantGuide, research, config] = await Promise.all([
    readJson(path.join(caseDir, "output", "brief.json")),
    readJson(path.join(caseDir, "work", "context-guide.json")),
    readJson(path.join(caseDir, "work", "participant-guide.json")),
    readJson(path.join(caseDir, "work", "research.json")),
    readJson(path.join(process.cwd(), "config", "pipeline.json")),
  ]);
  if (brief.schemaVersion !== "1.7.0" || brief.contextGuide?.placement !== "inline_first_use") {
    throw new Error(`${brief.caseId}: 只允许为 brief 1.7.0 inline_first_use 同步阅读时间。`);
  }
  const selected = new Set(brief.contextGuide.entryRefs ?? []);
  const contextEntries = (guide.entries ?? []).filter((entry) => selected.has(entry.id));
  const requiredCitationIds = new Set(contextGuideCitationRefs({ entries: contextEntries }));
  const researchById = new Map((research.citations ?? []).map((citation) => [citation.id, citation]));
  const missingResearch = [...requiredCitationIds].filter((id) => !researchById.has(id));
  if (missingResearch.length) {
    throw new Error(`${brief.caseId}: Context Guide 引用了 research 中不存在的资料：${missingResearch.join(", ")}`);
  }
  const existingIds = new Set((brief.citations ?? []).map((citation) => citation.id));
  const addedCitations = (research.citations ?? []).filter((citation) => requiredCitationIds.has(citation.id) && !existingIds.has(citation.id));
  brief.citations = [...(brief.citations ?? []), ...addedCitations];
  const characters = collectBlockCharacters(brief)
    + participantGuideCharacters(participantGuide, { compact: true })
    + contextGuideCharacters({ entries: contextEntries });
  brief.readingMinutes = expectedReadingMinutes(characters, config);
  await writeJson(path.join(caseDir, "output", "brief.json"), brief);
  return {
    caseId: brief.caseId,
    characters,
    readingMinutes: brief.readingMinutes,
    addedCitationIds: addedCitations.map((citation) => citation.id),
  };
}

export const syncContextReadingMinutes = syncContextBriefMetadata;

if (isMain(import.meta.url)) {
  try {
    const rawCases = process.argv.slice(2);
    if (!rawCases.length) throw new Error("用法：node scripts/sync-context-minutes-v242.mjs cases/<slug> [...]");
    const results = [];
    for (const rawCase of rawCases) results.push(await syncContextBriefMetadata(resolveCaseDir(rawCase)));
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
