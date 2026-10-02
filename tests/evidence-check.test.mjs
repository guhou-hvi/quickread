import assert from "node:assert/strict";
import test from "node:test";
import { evidenceArtifactErrors, selectiveThemeMapWarnings } from "../scripts/evidence-check.mjs";

function fixture() {
  const manifest = { id: "qr-0099-fixture-topic", profile: { primary: "knowledge" }, source: { sha256: "a".repeat(64) } };
  const normalized = [
    { id: "C000001", text: "第一项事实" },
    { id: "C000002", text: "以及限定条件" },
  ];
  const segments = [{ schemaVersion: "2.0.0", id: "S0001", caseId: manifest.id, sourceIds: normalized.map((unit) => unit.id), text: "第一项事实 以及限定条件" }];
  const coverage = {
    schemaVersion: "2.0.0",
    caseId: manifest.id,
    sourceHash: manifest.source.sha256,
    entries: normalized.map((unit) => ({ sourceId: unit.id, status: "mapped", segmentId: "S0001", reason: null, exclusionKind: null })),
  };
  const claims = [{
    schemaVersion: "2.0.0",
    id: "E0001",
    caseId: manifest.id,
    statement: "第一项事实具有一个限定条件。",
    provenance: "source_fact",
    importance: "high",
    claimRole: "fact",
    speaker: { name: null, status: "unknown", confidence: 0 },
    themeId: "T001",
    supportSpans: [{ segmentId: "S0001", sourceIds: normalized.map((unit) => unit.id), locator: "00:00:00–00:00:05", quote: "第一项事实 以及限定条件" }],
  }];
  const themeMap = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    profile: "knowledge",
    themes: [{ id: "T001", order: 1, title: "主题", summary: "摘要", profileModules: ["concept"], claimRefs: ["E0001"], importanceCoverage: { high: 1, medium: 0, low: 0 } }],
    unassignedClaimRefs: [],
  };
  return { manifest, normalized, segments, coverage, claims, themeMap };
}

test("evidence-only QA accepts supported uniquely-owned atomic claims", () => {
  assert.deepEqual(evidenceArtifactErrors(fixture()), []);
});

test("extraction preflight works before synthesis while still rejecting broken support", () => {
  const value = { ...fixture(), themeMap: null, extractionOnly: true };
  assert.deepEqual(evidenceArtifactErrors(value), []);
  value.claims[0].supportSpans[0].quote = "不在原文中的引语";
  assert(evidenceArtifactErrors(value).some((error) => error.includes("quote 与规范化原文不匹配")));
});

test("evidence-only QA catches quote, theme-count, and encoding regressions", () => {
  const value = fixture();
  value.claims[0].supportSpans[0].quote = "错误引语";
  value.claims[0].statement = "损坏??文本";
  value.themeMap.themes[0].importanceCoverage.high = 0;
  const errors = evidenceArtifactErrors(value);
  assert(errors.some((error) => error.includes("quote 与规范化原文不匹配")));
  assert(errors.some((error) => error.includes("importanceCoverage 已过期")));
  assert(errors.some((error) => error.includes("问号占位文本")));
});

test("evidence-only QA rejects named speaker attribution below the confidence gate", () => {
  const value = fixture();
  value.manifest.participants = ["谢赛宁", "主持人"];
  value.claims[0].provenance = "speaker_view";
  value.claims[0].claimRole = "opinion";
  value.claims[0].statement = "谢赛宁认为第一项事实具有一个限定条件。";

  const lowConfidenceErrors = evidenceArtifactErrors(value);
  assert(lowConfidenceErrors.some((error) => error.includes("低置信说话人实名归因")));

  value.claims[0].statement = "谢赛宁更喜欢第一项事实而不是另一种表达。";
  assert(evidenceArtifactErrors(value).some((error) => error.includes("低置信说话人实名归因")));

  value.claims[0].speaker = { name: "谢赛宁", status: "confirmed", confidence: 0.9 };
  assert(!evidenceArtifactErrors(value).some((error) => error.includes("低置信说话人实名归因")));
});

test("evidence-only QA requires each support span to be contiguous in normalized source order", () => {
  const value = fixture();
  value.normalized = [
    { id: "C000001", text: "第一项事实" },
    { id: "C000002", text: "中间插话" },
    { id: "C000003", text: "以及限定条件" },
  ];
  value.segments = [
    { schemaVersion: "2.0.0", id: "S0001", caseId: value.manifest.id, sourceIds: ["C000001", "C000003"], text: "第一项事实 以及限定条件" },
    { schemaVersion: "2.0.0", id: "S0002", caseId: value.manifest.id, sourceIds: ["C000002"], text: "中间插话" },
  ];
  value.coverage.entries = [
    { sourceId: "C000001", status: "mapped", segmentId: "S0001", reason: null, exclusionKind: null },
    { sourceId: "C000002", status: "mapped", segmentId: "S0002", reason: null, exclusionKind: null },
    { sourceId: "C000003", status: "mapped", segmentId: "S0001", reason: null, exclusionKind: null },
  ];
  value.claims[0].supportSpans[0] = {
    segmentId: "S0001",
    sourceIds: ["C000001", "C000003"],
    locator: "00:00:00–00:00:05",
    quote: "第一项事实 以及限定条件",
  };

  assert(evidenceArtifactErrors(value).some((error) => error.includes("规范化原文中不是连续来源区间")));
});

test("workflow 2.4 treats selective theme-map omissions as diagnostics without weakening evidence integrity", () => {
  const value = fixture();
  value.manifest.workflow = { version: "2.4.0" };
  value.themeMap.themes[0].claimRefs = [];
  value.themeMap.themes[0].importanceCoverage.high = 0;
  value.themeMap.unassignedClaimRefs = ["E0001"];

  assert.deepEqual(evidenceArtifactErrors(value), []);
  assert(selectiveThemeMapWarnings(value).some((warning) => warning.includes("仅作诊断")));

  value.claims[0].supportSpans[0].quote = "错误引语";
  value.claims[0].provenance = "editorial";
  value.themeMap.unassignedClaimRefs.push("E9999");
  const errors = evidenceArtifactErrors(value);
  assert(errors.some((error) => error.includes("quote 与规范化原文不匹配")));
  assert(errors.some((error) => error.includes("provenance 非法")));
  assert(errors.some((error) => error.includes("引用未知 claim：E9999")));
});
