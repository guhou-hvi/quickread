import path from "node:path";

import { buildDeepRead } from "./deep-read.mjs";
import {
  isMain,
  loadCase,
  readJson,
  readJsonLines,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";
import {
  advanceMigrationLedger,
  migrationSnapshotHashes,
  TARGET_VERSIONS,
} from "./migrate-v24.mjs";
import {
  participantGuideCharacters,
  participantGuideContractErrors,
} from "./participant-guide.mjs";
import { sha256Value } from "./review-contract.mjs";
import {
  collectBlockCharacters,
  expectedReadingMinutes,
} from "./workflow-contract.mjs";

export async function upgradeLightReaderV240(caseDir) {
  const workDir = path.join(caseDir, "work");
  const outputDir = path.join(caseDir, "output");
  const [{ manifest }, ledger, deepRead, brief, research, participantGuide, baseline, claims, config] = await Promise.all([
    loadCase(caseDir),
    readJson(path.join(workDir, "migration-v2.4.json")),
    readJson(path.join(outputDir, "deep-read.json")),
    readJson(path.join(outputDir, "brief.json")),
    readJson(path.join(workDir, "research.json")),
    readJson(path.join(workDir, "participant-guide.json")),
    readJson(path.join(workDir, "evidence-baseline.json")),
    readJsonLines(path.join(workDir, "evidence.jsonl")),
    readJson(new URL("../config/pipeline.json", import.meta.url)),
  ]);

  if (ledger.migrationClass !== "light_reader_upgrade" || ledger.stage !== "evidence_reviewed") {
    throw new Error("轻量读者版升级要求 migration-v2.4 处于 evidence_reviewed。 ");
  }
  if (manifest.workflow?.version !== "2.3.0" || deepRead.schemaVersion !== "2.2.0" || brief.schemaVersion !== "1.4.0") {
    throw new Error("案例不在已批准的 2.3 读者版基线。 ");
  }
  if (baseline.acceptance !== "migrated_reviewed_history" || baseline.hashes.evidence !== sha256Value(claims)) {
    throw new Error("保留审核 evidence baseline 缺失或与当前 evidence 不一致。 ");
  }
  if (config.workflowVersion !== TARGET_VERSIONS.workflow
    || config.promptVersion !== TARGET_VERSIONS.prompt
    || config.templateVersion !== TARGET_VERSIONS.template) {
    throw new Error("全局 2.4 版本配置不完整。 ");
  }
  const citationIds = new Set((research.citations ?? []).map((citation) => citation.id));
  const guideErrors = participantGuideContractErrors(participantGuide, { manifest, citationIds });
  if (guideErrors.length) throw new Error(`人物导览非法：\n${guideErrors.join("\n")}`);

  const immutableBefore = await migrationSnapshotHashes(caseDir);
  const overview = deepRead.sections.find((section) => section.id === "overview");
  const themes = deepRead.sections.find((section) => section.id === "themes");
  if (!overview || !themes || deepRead.sections.length !== 2) throw new Error("轻量升级要求 overview/themes 两节 2.3 基线。 ");
  overview.number = 1;
  themes.number = 3;
  const participantSection = {
    id: "participants",
    number: 2,
    title: "人物导览",
    modules: [{
      id: "participant-guide",
      title: null,
      profileModule: "participants",
      blocks: [{
        id: "participant-guide-main",
        type: "participant_guide",
        provenance: "external",
        guideRef: "work/participant-guide.json",
      }],
    }],
  };
  deepRead.schemaVersion = TARGET_VERSIONS.deepReadSchema;
  deepRead.workflowVersion = TARGET_VERSIONS.workflow;
  deepRead.sections = [overview, participantSection, themes];

  brief.schemaVersion = TARGET_VERSIONS.briefSchema;
  brief.workflowVersion = TARGET_VERSIONS.workflow;
  brief.templateVersion = TARGET_VERSIONS.template;
  brief.generatedAt = "2026-09-01";
  brief.participantGuide = {
    type: "participant_guide",
    provenance: "external",
    guideRef: "work/participant-guide.json",
  };
  brief.citations = research.citations;
  brief.readingMinutes = expectedReadingMinutes(
    collectBlockCharacters(brief) + participantGuideCharacters(participantGuide, { compact: true }),
    config,
  );

  await Promise.all([
    writeJson(path.join(outputDir, "deep-read.json"), deepRead),
    writeJson(path.join(outputDir, "brief.json"), brief),
  ]);
  await buildDeepRead(caseDir);
  const immutableAfter = await migrationSnapshotHashes(caseDir);
  for (const key of ["source", "normalizedSource", "segments", "evidence"]) {
    if (immutableBefore[key] !== immutableAfter[key]) throw new Error(`轻量升级修改了不可变输入：${key}`);
  }
  const nextLedger = await advanceMigrationLedger(caseDir, "reader_ready", {
    pendingReviews: ["external_citation", "reader_advocate", "render"],
    nextAction: "由独立 External Citation Reviewer 与 Reader Advocate 复核人物导览和阅读节奏。",
  });
  return {
    caseId: manifest.id,
    deepReadSchemaVersion: deepRead.schemaVersion,
    briefSchemaVersion: brief.schemaVersion,
    principalCount: participantGuide.principals.length,
    stage: nextLedger.stage,
    immutableInputsUnchanged: true,
  };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    console.log(JSON.stringify(await upgradeLightReaderV240(caseDir), null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
