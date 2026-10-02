import path from "node:path";
import {
  loadCase,
  isMain,
  parseSource,
  resolveCaseDir,
  sha256File,
  writeJson,
  writeJsonLines,
} from "./lib.mjs";

export async function parseCase(caseDir) {
  const { manifest, sourcePath } = await loadCase(caseDir);
  const sourceHash = await sha256File(sourcePath);
  const units = await parseSource(sourcePath, manifest.source.format);
  if (!units.length) throw new Error("没有从来源文件解析出任何有效内容。");

  const workDir = path.join(caseDir, "work");
  await writeJsonLines(path.join(workDir, "source.normalized.jsonl"), units);
  await writeJson(path.join(workDir, "coverage.json"), {
    schemaVersion: "2.0.0",
    caseId: manifest.id,
    sourceHash,
    entries: units.map((unit) => ({
      sourceId: unit.id,
      status: "unmapped",
      segmentId: null,
      reason: null,
      exclusionKind: null,
    })),
  });
  return { manifest, sourceHash, units };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await parseCase(caseDir);
    console.log(`已解析 ${result.units.length} 个来源单元：${result.manifest.id}`);
    if (result.sourceHash !== result.manifest.source.sha256) {
      console.warn("警告：来源哈希与 case.json 不一致，现有产物应视为过期。");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
