import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  fidelityEntryHardReasons,
  fidelityReviewGateFailures,
  fidelityReviewWarnings,
} from "../scripts/review-contract.mjs";

function entry(overrides = {}) {
  return {
    readerBlockRef: "theme-1-p1",
    verdict: "supported",
    provenance: "speaker_view",
    evidenceRefs: ["E0001"],
    citationRefs: [],
    unsupportedText: [],
    provenanceVerdict: "correct",
    severity: "none",
    issueKind: "none",
    rationale: "来源完整支持正文。",
    ...overrides,
  };
}

function review(entries, schemaVersion = "1.1.0") {
  return { schemaVersion, entries };
}

test("2.3.2 classifies every partial Fidelity finding as a non-blocking warning", () => {
  for (const issueKind of ["minor_paraphrase", "minor_context", "minor_bridge"]) {
    const report = review([entry({
      verdict: "partial",
      unsupportedText: ["一处非关键解释"],
      severity: "warning",
      issueKind,
    })]);
    assert.deepEqual(fidelityReviewGateFailures(report), []);
    assert.equal(fidelityReviewWarnings(report).length, 1);
    assert.equal(fidelityReviewWarnings(report)[0].issueKind, issueKind);
  }
});

test("2.3.2 keeps only concrete Fidelity issue kinds as hard errors", () => {
  for (const issueKind of [
    "fabrication",
    "contradiction",
    "misattribution",
    "material_distortion",
    "invalid_external",
    "quote_integrity",
  ]) {
    const finding = fidelityReviewGateFailures(review([entry({
      verdict: "unsupported",
      unsupportedText: ["具体硬错误"],
      severity: "hard",
      issueKind,
    })]));
    assert.equal(finding.length, 1);
    assert.ok(finding[0].reasons.includes(`hard:${issueKind}`));
  }
});

test("wrong provenance and unchecked external citations cannot be softened", () => {
  const wrong = entry({
    verdict: "unsupported",
    provenanceVerdict: "wrong",
    unsupportedText: ["归属错误"],
    severity: "hard",
    issueKind: "misattribution",
  });
  assert.ok(fidelityEntryHardReasons(wrong, { schemaVersion: "1.1.0" }).includes("provenance"));

  const external = entry({
    provenance: "external",
    evidenceRefs: [],
    citationRefs: ["R1"],
  });
  const reasons = fidelityEntryHardReasons(external, {
    schemaVersion: "1.1.0",
    research: { citations: [{ id: "R1" }], checks: [] },
  });
  assert.ok(reasons.includes("missing_research_check:R1"));
});

test("legacy 1.0 reports retain their original strict gate semantics", () => {
  const legacy = review([{
    ...entry({
      verdict: "partial",
      unsupportedText: ["旧报告中的未支持文本"],
    }),
    severity: undefined,
    issueKind: undefined,
  }], "1.0.0");
  assert.equal(fidelityReviewGateFailures(legacy).length, 1);
  assert.deepEqual(fidelityReviewWarnings(legacy), []);
});

test("Fidelity schema and reviewer prompts expose the 2.3.2 contract and emotion checks", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/fidelity-review.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.schemaVersion.enum, ["1.0.0", "1.1.0"]);
  const kinds = schema.properties.entries.items.properties.issueKind.enum;
  for (const kind of ["minor_bridge", "fabrication", "misattribution", "quote_integrity"]) {
    assert.ok(kinds.includes(kind));
  }

  const fidelityPrompt = fs.readFileSync(new URL("../prompts/reviews/fidelity.md", import.meta.url), "utf8");
  assert.match(fidelityPrompt, /partial.*severity=warning/u);
  assert.match(fidelityPrompt, /普通解释性桥接、轻微背景补充、非关键措辞差异/u);
  assert.match(fidelityPrompt, /provenanceVerdict=wrong.*hard.*misattribution/u);

  const readerPrompt = fs.readFileSync(new URL("../prompts/reviews/reader-advocate.md", import.meta.url), "utf8");
  assert.match(readerPrompt, /真实存在的焦虑、沮丧、勇气、质疑、比喻或行业批评/u);
  assert.match(readerPrompt, /震撼、疯狂、颠覆/u);
  assert.match(readerPrompt, /明确写成“某人认为／形容”/u);
  assert.match(readerPrompt, /情绪锚点是否推动人物理解/u);
});
