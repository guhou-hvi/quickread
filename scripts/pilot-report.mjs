import fs from "node:fs/promises";
import path from "node:path";
import {
  isMain,
  listCaseDirs,
  readJson,
  readJsonLines,
  REPO_ROOT,
  writeJson,
  writeText,
} from "./lib.mjs";
import { compactCharacters } from "./workflow-contract.mjs";
import { PILOT_NUMBERS } from "./migrate-v2.mjs";

async function optionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function optionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function optionalJsonLines(filePath) {
  try {
    return await readJsonLines(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function markdownSourceCharacters(markdown) {
  if (!markdown) return 0;
  const sourceOnly = markdown
    .split(/\r?\n/u)
    .filter((line) => !/(?:外部背景|背景资料|QR-Pilot|https?:\/\/)/u.test(line))
    .join("\n")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, "$1")
    .replace(/[`#>*_~-]/gu, "");
  return compactCharacters(sourceOnly);
}

function percentage(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "—";
}

function number(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN") : "—";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function editionMetrics({ workflowVersion, markdown, quality, deepRead, evidence }) {
  const reader = quality?.readerEdition ?? {};
  const reviews = quality?.reviews ?? {};
  return {
    workflowVersion,
    ready: Boolean(markdown),
    readerCharacters: markdown ? (reader.bodyCharacters ?? markdownSourceCharacters(markdown)) : null,
    recommendedCharacters: reader.recommendedCharacters ?? null,
    declaredReferenceCoverage: reader.declaredReferenceCoverage ?? null,
    adjudicatedSemanticCoverage: reader.adjudicatedSemanticCoverage ?? null,
    partialCount: reader.partialCount ?? null,
    missingCount: reader.missingCount ?? null,
    contradictedCount: reader.contradictedCount ?? null,
    staleCount: reader.staleCount ?? reviews.staleCount ?? null,
    evidenceCount: evidence?.length ?? quality?.claims?.count ?? null,
    claimAuditStatus: reviews.claimAudit?.status ?? null,
    blindHighMediumRecall: reviews.blindRecall?.highMediumRecall ?? null,
    blindAllRecall: reviews.blindRecall?.allRecall ?? null,
    fidelityStatus: reviews.fidelity?.status ?? null,
    readerAdvocateStatus: reviews.readerAdvocate?.status ?? null,
    agentReviewStatus: reviews.status ?? null,
    humanReviewStatus: quality?.humanReview?.status ?? null,
    deepReadWorkflow: deepRead?.workflowVersion ?? null,
  };
}

function metricSummary(metrics) {
  if (!metrics.ready) return `${metrics.workflowVersion} 尚未生成`;
  const parts = [`正文 ${number(metrics.readerCharacters)} 字符`];
  if (metrics.recommendedCharacters) parts.push(`建议 ${number(metrics.recommendedCharacters)}`);
  if (metrics.declaredReferenceCoverage !== null) parts.push(`声明引用 ${percentage(metrics.declaredReferenceCoverage)}`);
  if (metrics.adjudicatedSemanticCoverage !== null) parts.push(`裁决语义 ${percentage(metrics.adjudicatedSemanticCoverage)}`);
  if (metrics.agentReviewStatus) parts.push(`Agent ${metrics.agentReviewStatus}`);
  if (metrics.humanReviewStatus) parts.push(`人工 ${metrics.humanReviewStatus}`);
  return parts.join(" · ");
}

async function loadArchivedEdition(caseDir, workflowVersion) {
  const root = path.join(caseDir, "legacy", `workflow-${workflowVersion}`);
  const [markdown, quality, deepRead, evidence] = await Promise.all([
    optionalText(path.join(root, "output", "deep-read.md")),
    optionalJson(path.join(root, "work", "quality-report.json")),
    optionalJson(path.join(root, "output", "deep-read.json")),
    optionalJsonLines(path.join(root, "work", "evidence.jsonl")),
  ]);
  return { markdown, metrics: editionMetrics({ workflowVersion, markdown, quality, deepRead, evidence }) };
}

async function loadCurrentEdition(caseDir) {
  const [markdown, quality, deepRead, evidence] = await Promise.all([
    optionalText(path.join(caseDir, "output", "deep-read.md")),
    optionalJson(path.join(caseDir, "work", "quality-report.json")),
    optionalJson(path.join(caseDir, "output", "deep-read.json")),
    optionalJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
  ]);
  const isCurrent = deepRead?.workflowVersion === "2.2.0" && quality?.schemaVersion === "2.1.0";
  return {
    markdown: isCurrent ? markdown : null,
    metrics: editionMetrics({
      workflowVersion: "2.2.0",
      markdown: isCurrent ? markdown : null,
      quality: isCurrent ? quality : null,
      deepRead: isCurrent ? deepRead : null,
      evidence: isCurrent ? evidence : null,
    }),
  };
}

function editionLink(caseId, workflowVersion, ready) {
  if (!ready) return `${workflowVersion} 待生成`;
  if (workflowVersion === "2.2.0") return `[2.2](${caseId}/output/deep-read.md)`;
  return `[${workflowVersion.replace(/\.0$/u, "")}](${caseId}/legacy/workflow-${workflowVersion}/output/deep-read.md)`;
}

export async function buildPilotReport() {
  const records = [];
  for (const caseDir of await listCaseDirs()) {
    const manifest = await readJson(path.join(caseDir, "case.json"));
    if (!PILOT_NUMBERS.has(manifest.caseNumber)) continue;
    const [v15, v20, v21, v22] = await Promise.all([
      loadArchivedEdition(caseDir, "1.5.0"),
      loadArchivedEdition(caseDir, "2.0.0"),
      loadArchivedEdition(caseDir, "2.1.0"),
      loadCurrentEdition(caseDir),
    ]);
    const comparison = {
      schemaVersion: "2.2.0",
      caseId: manifest.id,
      profile: manifest.profile.primary,
      versions: {
        "1.5.0": v15.metrics,
        "2.0.0": v20.metrics,
        "2.1.0": v21.metrics,
        "2.2.0": v22.metrics,
      },
    };
    await writeJson(path.join(caseDir, "work", "migration-comparison.json"), comparison);
    records.push({ manifest, comparison, editions: { v15, v20, v21, v22 } });
  }
  records.sort((first, second) => first.manifest.caseNumber.localeCompare(second.manifest.caseNumber));

  const rows = records.map(({ manifest, comparison }) => {
    const versions = comparison.versions;
    const current = versions["2.2.0"];
    const links = ["1.5.0", "2.0.0", "2.1.0", "2.2.0"]
      .map((version) => editionLink(manifest.id, version, versions[version].ready))
      .join(" · ");
    const evidenceBook = current.ready ? ` · [证据册](${manifest.id}/output/evidence-book.md)` : "";
    return `| ${manifest.caseNumber} | ${manifest.shortTitle} | ${manifest.profile.primary} | ${number(versions["1.5.0"].readerCharacters)} | ${number(versions["2.0.0"].readerCharacters)} | ${number(versions["2.1.0"].readerCharacters)} | ${number(current.readerCharacters)} / ${number(current.recommendedCharacters)} | ${percentage(current.declaredReferenceCoverage)} / ${percentage(current.adjudicatedSemanticCoverage)} | ${current.partialCount ?? "—"} / ${current.missingCount ?? "—"} / ${current.contradictedCount ?? "—"} / ${current.staleCount ?? "—"} | ${current.agentReviewStatus ?? "pending"} / ${current.humanReviewStatus ?? "pending"} | ${links}${evidenceBook} |`;
  }).join("\n");
  const markdown = `# QuickRead 2.2 六案真实覆盖 A/B 校准

> 1.5 是旧读者稿，2.0 是原子 claim 直接侵入正文的膨胀版，2.1 是可读性修复版，2.2 是经过原子证据重建、双盲语义覆盖、Fidelity 反查与 Reader Advocate 审核的候选版。2.2 的“声明引用”只说明作者标了位置；“裁决语义”才表示独立审核确认正文真正表达了命题。

[打开四列并排校准页](PILOT-REVIEW.html)

| 案例 | 短标题 | Profile | 1.5 字符 | 2.0 字符 | 2.1 字符 | 2.2 实际 / 建议 | 声明 / 裁决 | partial / missing / contradicted / stale | Agent / 人工 | 快捷检查 |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
${rows}

## 集中人工校审

只有六案自动硬门全部通过后才进入本步骤。请分别检查完整性、忠实度、可追溯性、可读性、层级和 Profile 适配；每项至少 4/5 且 decision 为 pass，才解冻其余 18 案。将 [人工评分模板](../references/human-review-template.json) 复制到各案例的 \`work/human-review.json\`，填写后重新运行质量、案例校验和本报告。
`;
  const outputPath = path.join(REPO_ROOT, "cases", "PILOT-REVIEW.md");
  await writeText(outputPath, markdown);

  const navigation = records.map(({ manifest }) => `<a href="#${escapeHtml(manifest.caseNumber.toLowerCase())}">${escapeHtml(manifest.caseNumber)}</a>`).join("");
  const panels = records.map(({ manifest, comparison, editions }) => {
    const versionEntries = [
      ["1.5", editions.v15],
      ["2.0", editions.v20],
      ["2.1", editions.v21],
      ["2.2", editions.v22],
    ];
    const columns = versionEntries.map(([label, edition]) => {
      const body = edition.markdown ?? `QuickRead ${label} 尚未生成或尚未通过版本识别。`;
      return `<section class="edition version-${label.replace(".", "-")}"><h3>${label}</h3><p>${escapeHtml(metricSummary(edition.metrics))}</p><pre>${escapeHtml(body)}</pre></section>`;
    }).join("");
    return `<article class="case" id="${escapeHtml(manifest.caseNumber.toLowerCase())}"><header><div><span>${escapeHtml(manifest.caseNumber)}</span><h2>${escapeHtml(manifest.shortTitle)}</h2></div><p>${escapeHtml(metricSummary(comparison.versions["2.2.0"]))}</p></header><div class="columns">${columns}</div></article>`;
  }).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuickRead 2.2 六案 A/B 校准</title><style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#20252b;background:#f3f5f7}*{box-sizing:border-box}body{margin:0}nav{position:sticky;top:0;z-index:3;display:flex;gap:8px;padding:12px 20px;background:#20252bee;backdrop-filter:blur(8px)}nav a{color:#fff;text-decoration:none;border:1px solid #ffffff45;border-radius:999px;padding:4px 10px;font-size:13px}.intro{padding:28px 24px 8px;max-width:1800px;margin:auto}.intro h1{margin:0 0 8px}.intro p{color:#59636e}.case{max-width:1900px;margin:20px auto;padding:0 20px}.case>header{position:sticky;top:49px;z-index:2;background:#fff;border:1px solid #dde3e8;border-top:4px solid #d55e00;border-radius:10px 10px 0 0;padding:12px 16px}.case>header div{display:flex;align-items:baseline;gap:10px}.case h2{font-size:20px;margin:0}.case header span{font-weight:800;color:#934000}.case header p,.edition>p{font-size:12px;color:#59636e;margin:5px 0 0}.columns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;background:#e8ecef;padding:10px;border-radius:0 0 10px 10px}.edition{min-width:0;background:#fff;border-radius:8px;overflow:hidden}.edition h3{margin:0;padding:9px 12px 0;font-size:14px}.edition>p{min-height:48px;padding:0 12px 9px}.version-2-0 h3{color:#934000}.version-2-1 h3{color:#005a8d}.version-2-2 h3{color:#523b7a}.edition pre{height:72vh;overflow:auto;margin:0;padding:14px;border-top:1px solid #e3e7ea;white-space:pre-wrap;word-break:break-word;font:14px/1.75 system-ui,"Microsoft YaHei",sans-serif;color:#38424c}@media(max-width:1400px){.columns{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.columns{grid-template-columns:1fr}.edition pre{height:55vh}.case>header{top:97px}nav{flex-wrap:wrap}}
</style></head><body><nav>${navigation}</nav><main><section class="intro"><h1>QuickRead 2.2 六案真实覆盖 A/B 校准</h1><p>四列独立滚动。2.2 只在机器源和质量报告均属于当前版本时显示；尚未完成的案例明确标为待生成。</p></section>${panels}</main></body></html>`;
  const htmlPath = path.join(REPO_ROOT, "cases", "PILOT-REVIEW.html");
  await writeText(htmlPath, html);
  return { records, outputPath, htmlPath };
}

if (isMain(import.meta.url)) {
  const result = await buildPilotReport();
  console.log(`已生成 ${path.relative(REPO_ROOT, result.outputPath)} 与 ${path.relative(REPO_ROOT, result.htmlPath)}，共 ${result.records.length} 个试点。`);
}
