import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDeepRead,
  compactReferenceRanges,
  readabilityMetrics,
  readerMapContractErrors,
  renderDeepReadMarkdown,
  sourceDerivedDeepCharacters,
} from "../scripts/deep-read.mjs";
import { buildSegments } from "../scripts/segment-source.mjs";
import { coverageLedgerErrors, coverageLedgerFindings } from "../scripts/segment-source.mjs";
import { chooseSegmentBreaks } from "../scripts/screenshot.mjs";
import {
  adaptiveTargets,
  automaticProfileDecision,
  densityErrors,
  isContiguousSourceSpan,
  nearDuplicateClaimIds,
} from "../scripts/workflow-contract.mjs";
import { readJson, REPO_ROOT } from "../scripts/lib.mjs";
import { computeQualityReport, humanReviewResult } from "../scripts/quality-report.mjs";
import { corruptedDerivedTextErrors } from "../scripts/validate-case.mjs";

test("adaptive targets remain diagnostic and never create a minimum-length pass gate", async () => {
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  assert.deepEqual(adaptiveTargets(0, 40_000, config), {
    recommendedReaderCharacters: 12_000,
    readerMinimumGuideline: 12_000,
    readerMaximumGuideline: 18_000,
    readerSoftCharacterCap: 35_000,
    targetBriefCharacters: 3_000,
  });
  assert.deepEqual(adaptiveTargets(20, 100_000, config), {
    recommendedReaderCharacters: 18_000,
    readerMinimumGuideline: 12_000,
    readerMaximumGuideline: 18_000,
    readerSoftCharacterCap: 35_000,
    targetBriefCharacters: 8_000,
  });
  assert.equal(adaptiveTargets(10, 5_000, config).recommendedReaderCharacters, 5_000);
  assert.deepEqual(densityErrors({ atomicInformation: 4, themeDependency: 3, evidenceRichness: 2, controversy: 1, uniqueness: 4 }, 14), []);
  const qualitySource = await fs.readFile(path.join(REPO_ROOT, "scripts", "quality-report.mjs"), "utf8");
  const readerEditionSource = await fs.readFile(path.join(REPO_ROOT, "scripts", "reader-edition.mjs"), "utf8");
  const profilePrompt = await fs.readFile(path.join(REPO_ROOT, "prompts", "00-profile.md"), "utf8");
  const synthesisPrompt = await fs.readFile(path.join(REPO_ROOT, "prompts", "03-synthesize.md"), "utf8");
  assert.doesNotMatch(qualitySource, /bodyCharacters\s*<\s*targets\.readerMinimumGuideline/u);
  assert.doesNotMatch(qualitySource, /highMediumInBody|status\s*!==\s*["']evidence_only["']/u);
  assert.match(qualitySource, /adjudicatedSemanticCoverage/u);
  assert.doesNotMatch(readerEditionSource, /representativeRefs|while\s*\(false/u);
  assert.doesNotMatch(profilePrompt, /30%\s*\+\s*2%/u);
  assert.match(profilePrompt, /只作诊断/u);
  assert.match(synthesisPrompt, /Prompt 3\.4/u);
  assert.match(synthesisPrompt, /第三人称、克制的观察性叙述/u);
  assert.match(synthesisPrompt, /12,000–18,000.*只是写作目标/u);
  assert.match(synthesisPrompt, /QR-Pilot 数量必须为 0/u);
  assert.match(synthesisPrompt, /不要求覆盖全部 claim/u);
  assert.doesNotMatch(synthesisPrompt, /\uFFFD/u);
});

test("derived artifacts reject encoding damage and question-mark placeholders", () => {
  assert.deepEqual(corruptedDerivedTextErrors({ title: "正常标题", body: ["完整正文"] }, "deep-read"), []);
  assert.match(corruptedDerivedTextErrors({ title: "????" }, "deep-read").join("\n"), /deep-read\.title/u);
  assert.match(corruptedDerivedTextErrors({ body: "损坏\uFFFD文本" }, "brief").join("\n"), /brief\.body/u);
});

test("migration configuration has explicit, unique and disjoint authorization sets", async () => {
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const { activeCases, frozenCases, pilotCases } = config.migration;
  for (const list of [activeCases, frozenCases, pilotCases]) {
    assert.equal(new Set(list).size, list.length);
    for (const id of list) assert.match(id, /^QR-\d{4}$/u);
  }
  assert.deepEqual(activeCases.filter(id => frozenCases.includes(id)), []);
  const renderAllSource = await fs.readFile(path.join(REPO_ROOT, "scripts", "render-all.mjs"), "utf8");
  assert.match(renderAllSource, /frozenCases\?\.includes\(manifest\.caseNumber\)/u);
});

test("quality report failure leaves an existing report untouched when required inputs are absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-frozen-quality-"));
  const caseDir = path.join(root, "qr-0001-frozen-quality");
  try {
    await fs.mkdir(path.join(caseDir, "work"), { recursive: true });
    await fs.writeFile(path.join(caseDir, "case.json"), JSON.stringify({
      id: path.basename(caseDir),
      caseNumber: "QR-0001",
      source: { path: "input/source.srt" },
    }), "utf8");
    const retained = { marker: "must-not-change" };
    const reportPath = path.join(caseDir, "work", "quality-report.json");
    await fs.writeFile(reportPath, JSON.stringify(retained), "utf8");
    await assert.rejects(computeQualityReport(caseDir, { write: true }), /source\.normalized\.jsonl|ENOENT/u);
    assert.deepEqual(await readJson(reportPath), retained);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("2.4.2 incremental review policy is command-wired and keeps the human checkpoint", async () => {
  const [config, packageJson, readme, agents, workflow] = await Promise.all([
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    readJson(path.join(REPO_ROOT, "package.json")),
    fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8"),
    fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8"),
    fs.readFile(path.join(REPO_ROOT, "docs", "workflow.md"), "utf8"),
  ]);
  assert.equal(config.workflowVersion, "2.4.2");
  assert.equal(config.promptVersion, "3.4.2");
  assert.equal(config.reviews.version, "2.4.2");
  assert.equal(packageJson.scripts["context-upgrade-v242"], "node scripts/context-upgrade-v242.mjs");
  assert.equal(packageJson.scripts["claim-mechanical-fix"], "node scripts/claim-mechanical-fix.mjs");
  assert.equal(packageJson.scripts["claim-gate-prepare"], "node scripts/claim-gate.mjs prepare");
  assert.equal(packageJson.scripts["claim-gate-resolve"], "node scripts/claim-gate.mjs resolve");
  assert.match(readme, /\]\(docs\/workflow\.md\)/u);
  for (const document of [workflow, agents]) {
    assert.match(document, /does not consume.*repair attempt|do not consume a repair attempt|不增加.*repairAttempt/u);
    assert.match(document, /semantic_delta|semantic deltas/u);
    assert.match(document, /Blind Recall.*Coverage A\/B.*not automatically|Blind Recall and Coverage A\/B are not automatic|不因局部变化自动重跑/u);
    assert.match(document, /concentrated human/u);
  }
});

test("Agent approval cannot substitute for the concentrated human review", async () => {
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const base = {
    schemaVersion: "1.1.0",
    caseId: "qr-9999-fixture",
    reviewedAt: "2026-08-11T00:00:00.000Z",
    reviewerType: "human",
    reviewer: "项目所有者",
    scores: Object.fromEntries(config.migration.humanReviewDimensions.map((name) => [name, 4])),
    decision: "pass",
    notes: "集中校审通过。",
  };
  assert.equal(humanReviewResult(base, config, true, base.caseId).status, "pass");
  const diagnosticScores = {
    ...base,
    scores: Object.fromEntries(config.migration.humanReviewDimensions.map((name) => [name, 3])),
  };
  assert.equal(humanReviewResult(diagnosticScores, config, true, base.caseId).status, "pass");
  assert.equal(humanReviewResult({ ...base, reviewerType: "agent" }, config, true, base.caseId).status, "fail");
  assert.equal(humanReviewResult({ ...base, reviewer: "agent-reader" }, config, true, base.caseId).status, "fail");
  assert.equal(humanReviewResult(null, config, true, base.caseId).status, "pending");
});

test("automatic profile selection enforces both absolute score and lead", () => {
  const thresholds = { minimumTopScore: 0.75, minimumLead: 0.15 };
  assert.equal(automaticProfileDecision({ knowledge: 0.81, strategy: 0.6 }, thresholds).primary, "knowledge");
  assert.equal(automaticProfileDecision({ knowledge: 0.81, strategy: 0.7 }, thresholds).primary, null);
  assert.equal(automaticProfileDecision({ knowledge: 0.7, strategy: 0.4 }, thresholds).primary, null);
});

test("near-duplicate detection keeps exact Jaccard semantics with cached n-grams", () => {
  const claims = [
    { id: "E0001", statement: "模型能力取决于数据、训练与验证。" },
    { id: "E0002", statement: "模型能力取决于数据、训练与验证！" },
    { id: "E0003", statement: "组织选择取决于目标与约束。" },
  ];
  assert.deepEqual([...nearDuplicateClaimIds(claims)], ["E0002"]);
});

test("semantic segmentation separates exclusions from unique segment ownership", () => {
  const units = [
    { id: "C000001", locator: { type: "time", label: "00:00:00–00:00:01", start: "00:00:00.000", end: "00:00:01.000", startMs: 0, endMs: 1000 }, text: "大家好" },
    { id: "C000002", locator: { type: "time", label: "00:00:01–00:00:02", start: "00:00:01.000", end: "00:00:02.000", startMs: 1000, endMs: 2000 }, text: "模型能力取决于数据和验证。" },
    { id: "C000003", locator: { type: "time", label: "00:00:02–00:00:03", start: "00:00:02.000", end: "00:00:03.000", startMs: 2000, endMs: 3000 }, text: "模型能力取决于数据和验证。" },
    { id: "C000004", locator: { type: "time", label: "00:00:03–00:00:04", start: "00:00:03.000", end: "00:00:04.000", startMs: 3000, endMs: 4000 }, text: "但验证自动化不会自动解决知识治理。" },
  ];
  const { segments, entries } = buildSegments(units, { caseId: "qr-9999-fixture", maximumCharacters: 40 });
  assert.equal(entries[0].exclusionKind, "greeting");
  assert.equal(entries[2].exclusionKind, "duplicate");
  const owned = segments.flatMap((segment) => segment.sourceIds);
  assert.equal(new Set(owned).size, owned.length);
  assert.deepEqual(new Set(owned), new Set(["C000002", "C000004"]));
  const order = new Map(units.map((unit, index) => [unit.id, index]));
  assert.equal(isContiguousSourceSpan(["C000002"], order), true);
  assert.equal(isContiguousSourceSpan(["C000002", "C000004"], order), false);
});

test("advertisement exclusion keeps substantive funding and advertising claims", () => {
  const units = [
    { id: "C000001", locator: { type: "time", label: "00:00:00–00:00:01", start: "00:00:00.000", end: "00:00:01.000", startMs: 0, endMs: 1000 }, text: "我们给这个开源项目提供赞助。" },
    { id: "C000002", locator: { type: "time", label: "00:00:01–00:00:02", start: "00:00:01.000", end: "00:00:02.000", startMs: 1000, endMs: 2000 }, text: "广告品效合一是当时的产品目标。" },
    { id: "C000003", locator: { type: "time", label: "00:00:02–00:00:03", start: "00:00:02.000", end: "00:00:03.000", startMs: 2000, endMs: 3000 }, text: "感谢导师支持这个研究。" },
    { id: "C000004", locator: { type: "time", label: "00:00:03–00:00:04", start: "00:00:03.000", end: "00:00:04.000", startMs: 3000, endMs: 4000 }, text: "本期节目由某品牌赞助。" },
  ];
  const { segments, entries } = buildSegments(units, { caseId: "qr-9999-fixture" });
  assert.deepEqual(entries.map((entry) => entry.status), ["mapped", "mapped", "mapped", "excluded"]);
  assert.equal(entries[3].exclusionKind, "advertisement");
  assert.deepEqual(segments.flatMap((segment) => segment.sourceIds), ["C000001", "C000002", "C000003"]);
  const coverage = { schemaVersion: "2.0.0", caseId: "qr-9999-fixture", sourceHash: "a".repeat(64), entries };
  assert.deepEqual(coverageLedgerErrors(units, segments, coverage, { caseId: "qr-9999-fixture", sourceHash: "a".repeat(64) }), []);
  const invalid = structuredClone(entries);
  invalid[0] = { sourceId: "C000001", status: "excluded", segmentId: null, reason: "广告", exclusionKind: "advertisement" };
  assert.match(coverageLedgerErrors(units, segments, { ...coverage, entries: invalid }, { caseId: "qr-9999-fixture", sourceHash: "a".repeat(64) }).join("\n"), /不得仅因出现“广告”或“赞助”而排除/);
});

test("unmapped coverage is diagnostic while corrupted source binding remains hard", () => {
  const units = [{
    id: "C000001",
    locator: { type: "time", label: "00:00:00–00:00:01", start: "00:00:00.000", end: "00:00:01.000", startMs: 0, endMs: 1000 },
    text: "这是尚未整理的有效内容。",
  }];
  const coverage = {
    schemaVersion: "2.0.0",
    caseId: "qr-9999-fixture",
    sourceHash: "a".repeat(64),
    entries: [{ sourceId: "C000001", status: "unmapped", segmentId: null, reason: null, exclusionKind: null }],
  };
  const findings = coverageLedgerFindings(units, [], coverage, {
    caseId: "qr-9999-fixture",
    sourceHash: "a".repeat(64),
  });
  assert.deepEqual(findings.hardErrors, []);
  assert.match(findings.diagnostics.join("\n"), /尚未完成映射或排除/u);

  const corrupted = coverageLedgerFindings(units, [], coverage, {
    caseId: "qr-9999-fixture",
    sourceHash: "b".repeat(64),
  });
  assert.match(corrupted.hardErrors.join("\n"), /sourceHash/u);
});

test("deep-read Markdown is deterministic and counts only source-derived body text", async () => {
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const manifest = { sourceType: "video" };
  const sectionIds = ["overview", "themes", "navigation", "verification"];
  const titles = ["内容概览", "主题详解", "导航时间线", "争议、边界与外部核验"];
  const deep = {
    title: "测试",
    sections: sectionIds.map((id, index) => ({
      id,
      number: index + 1,
      title: titles[index],
      modules: [{ id: `m-${index}`, title: null, profileModule: "overview", blocks: [{
        id: `group-${index}`,
        type: "prose_group",
        provenance: index === 0 ? "source_fact" : "system",
        paragraphs: [{ id: `p-${index}`, role: index === 0 ? "thesis" : "explanation", text: index === 0 ? "来源正文" : "系统说明", ...(index === 0 ? { evidenceRefs: ["E0001", "E0002", "E0003"] } : {}) }],
      }] }],
    })),
  };
  const first = renderDeepReadMarkdown(deep, manifest, config);
  const second = renderDeepReadMarkdown(deep, manifest, config);
  assert.equal(first, second);
  assert.equal(sourceDerivedDeepCharacters(deep), 4);
  assert.match(first, /\*\*原文事实｜\*\*/);
  assert.match(first, /\[E0001–E0003\]\(evidence-book\.md#e0001\)/);
  assert.deepEqual(compactReferenceRanges(["E0001", "E0002", "E0003", "E0005"]), ["E0001–E0003", "E0005"]);
});

test("build-deep reads citations from research and does not depend on a pre-existing brief", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-build-deep-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const caseId = path.basename(root);
  await Promise.all([
    fs.mkdir(path.join(root, "input"), { recursive: true }),
    fs.mkdir(path.join(root, "work"), { recursive: true }),
    fs.mkdir(path.join(root, "output"), { recursive: true }),
  ]);
  const sections = ["overview", "themes", "navigation", "verification"].map((id, index) => ({
    id,
    number: index + 1,
    title: ["内容概览", "主题详解", "导航时间线", "争议、边界与外部核验"][index],
    modules: [{
      id: `module-${index + 1}`,
      title: null,
      profileModule: index === 3 ? "verification" : id,
      blocks: [{
        id: `group-${index + 1}`,
        type: "prose_group",
        provenance: index === 3 ? "external" : "system",
        paragraphs: [{
          id: `paragraph-${index + 1}`,
          role: "explanation",
          text: index === 3 ? "这条外部核验来自研究记录。" : "导航说明。",
          ...(index === 3 ? { citationRefs: ["R1"] } : {}),
        }],
      }],
    }],
  }));
  await Promise.all([
    fs.writeFile(path.join(root, "input", "source.srt"), "", "utf8"),
    fs.writeFile(path.join(root, "case.json"), `${JSON.stringify({ id: caseId, caseNumber: "QR-9999", title: "测试案例", source: { path: "input/source.srt" } })}\n`, "utf8"),
    fs.writeFile(path.join(root, "work", "evidence.jsonl"), "", "utf8"),
    fs.writeFile(path.join(root, "work", "theme-map.json"), `${JSON.stringify({ themes: [] })}\n`, "utf8"),
    fs.writeFile(path.join(root, "work", "research.json"), `${JSON.stringify({ citations: [{ id: "R1", title: "官方资料", publisher: "官方机构", accessedAt: "2026-08-11", url: "https://example.com/source" }] })}\n`, "utf8"),
    fs.writeFile(path.join(root, "output", "deep-read.json"), `${JSON.stringify({ title: "测试深度稿", sections })}\n`, "utf8"),
  ]);
  await assert.rejects(fs.access(path.join(root, "output", "brief.json")));
  await buildDeepRead(root);
  const markdown = await fs.readFile(path.join(root, "output", "deep-read.md"), "utf8");
  assert.match(markdown, /官方资料/);
  assert.match(markdown, /https:\/\/example\.com\/source/);
});

test("reader map separates semantic body coverage from evidence-only low claims", () => {
  const deep = {
    sections: [{ id: "themes", modules: [{ blocks: [{ id: "g1", type: "prose_group", provenance: "speaker_view", paragraphs: [{ id: "p1", role: "thesis", text: "核心判断包含必要限定。", evidenceRefs: ["E0001", "E0002"] }] }] }] }],
  };
  const claims = [
    { id: "E0001", importance: "high", provenance: "speaker_view" },
    { id: "E0002", importance: "medium", provenance: "speaker_view" },
    { id: "E0003", importance: "low", provenance: "speaker_view" },
  ];
  const map = {
    schemaVersion: "2.0.0",
    caseId: "qr-9999-fixture",
    entries: [
      { evidenceRef: "E0001", importance: "high", presentation: "explicit", coverageSpans: [{ readerBlockRef: "p1", readerTextQuote: "核心判断包含" }] },
      { evidenceRef: "E0002", importance: "medium", presentation: "synthesized", coverageSpans: [{ readerBlockRef: "p1", readerTextQuote: "包含必要限定" }] },
      { evidenceRef: "E0003", importance: "low", presentation: "evidence_only", coverageSpans: [] },
    ],
  };
  assert.deepEqual(readerMapContractErrors(map, { id: "qr-9999-fixture" }, claims, deep), []);
  const invalid = structuredClone(map);
  invalid.entries[1].coverageSpans[0].readerTextQuote = "正文不存在的断言";
  assert.match(readerMapContractErrors(invalid, { id: "qr-9999-fixture" }, claims, deep).join("\n"), /readerTextQuote/);
});

test("readability metrics expose list, duplicate, ASR and hierarchy regressions", () => {
  const deep = {
    sections: [{ modules: [{ blocks: [
      { id: "g1", type: "prose_group", provenance: "speaker_view", paragraphs: [
        { id: "p1", role: "thesis", text: "这是一个清晰而完整的核心判断。", evidenceRefs: ["E0001"] },
        { id: "p2", role: "explanation", text: "这是一个清晰而完整的核心判断。", evidenceRefs: ["E0001"] },
      ] },
      { id: "l1", type: "structured_list", provenance: "speaker_view", items: [{ id: "i1", text: "呃 然后然后然后", evidenceRefs: ["E0001"] }] },
    ] }] }],
  };
  const metrics = readabilityMetrics(deep);
  assert.equal(metrics.readerDuplicateCount, 1);
  assert.ok(metrics.asrArtifactCount > 0);
  assert.equal(metrics.maximumListItems, 1);
});

test("mobile share segmentation uses safe boundaries and respects maximum height", () => {
  const boundaries = chooseSegmentBreaks(12_000, [4_900, 5_200, 9_700], 2.25, 12_000, 16_000);
  assert.deepEqual(boundaries, [0, 5200, 12000]);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    assert.ok((boundaries[index + 1] - boundaries[index]) * 2.25 <= 16_002);
  }
});

test("all 2.2 schemas and profile/reviewer prompt fixtures exist", async () => {
  const schemas = ["case", "coverage", "segment", "evidence", "theme-map", "reader-map", "deep-read", "brief", "audit-claim", "quality-report", "human-review", "render-report", "claim-review", "blind-candidate", "blind-alignment", "coverage-review", "fidelity-review", "reader-review", "adjudication", "review-manifest", "claim-bundle", "evidence-migration", "repair-log"];
  for (const name of schemas) JSON.parse(await fs.readFile(path.join(REPO_ROOT, "schemas", `${name}.schema.json`), "utf8"));
  for (const name of ["knowledge", "strategy", "narrative", "debate", "general"]) {
    await fs.access(path.join(REPO_ROOT, "prompts", "profiles", `${name}.md`));
  }
  for (const name of ["claim-auditor", "blind-recall", "alignment", "coverage-a", "coverage-b", "fidelity", "reader-advocate", "adjudicator", "repair-editor"]) {
    const prompt = await fs.readFile(path.join(REPO_ROOT, "prompts", "reviews", `${name}.md`), "utf8");
    const example = prompt.match(/```json\s*([\s\S]*?)```/u);
    assert.ok(example, `${name} 缺少 JSON 输出示例`);
    JSON.parse(example[1]);
    if (name === "claim-auditor") {
      assert.match(prompt, /不等于句子只能有一个动词/u);
      assert.match(prompt, /不要为数据整齐而拆句/u);
      assert.match(prompt, /自然指代/u);
    }
  }
});
