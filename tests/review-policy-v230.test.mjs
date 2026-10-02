import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { partitionReviewErrors } from "../scripts/quality-report.mjs";
import { consensusStatusForPolicy } from "../scripts/review-consensus.mjs";
import { reviewWorkflowVersion } from "../scripts/review-contract.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../config/pipeline.json", import.meta.url), "utf8"));

test("review policy 2.4.2 is the active incremental policy", () => {
  assert.equal(config.workflowVersion, "2.4.2");
  assert.equal(config.promptVersion, "3.4.2");
  assert.equal(config.reviews.version, "2.4.2");
  assert.equal(config.reviews.gatePolicy, "concrete_hard_errors");
  assert.equal(config.reviews.calibratedRecall.mediumMinimum, 0.98);
  assert.equal(reviewWorkflowVersion(config), "2.4.2");
  const manifestSchema = JSON.parse(fs.readFileSync(
    new URL("../schemas/review-manifest.schema.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    manifestSchema.properties.workflowVersion.enum,
    ["2.2.0", "2.3.0", "2.3.1", "2.3.2", "2.4.0"],
  );
});

test("quantitative review findings are diagnostics while integrity errors remain hard", () => {
  const metricBundle = "claim bundle B001 \u627f\u63a5 11 \u6761\u6b63\u6587 claim";
  const result = partitionReviewErrors([
    "Blind Recall is below target.",
    metricBundle,
    "manifest input hash is stale",
    "Fidelity hard error at p1: unsupported_text.",
  ]);
  assert.deepEqual(result.diagnostics, ["Blind Recall is below target.", metricBundle]);
  assert.deepEqual(result.hardErrors, [
    "manifest input hash is stale",
    "Fidelity hard error at p1: unsupported_text.",
  ]);
});

test("consensus status ignores diagnostics and only hard errors block", () => {
  assert.equal(consensusStatusForPolicy({
    hardErrors: [],
    reviewRound: 1,
    maximumRepairRounds: 2,
  }), "pass");
  assert.equal(consensusStatusForPolicy({
    hardErrors: [{ gate: "fidelity", kind: "unsupported_or_provenance" }],
    reviewRound: 1,
    maximumRepairRounds: 2,
  }), "repair_required");
  assert.equal(consensusStatusForPolicy({
    hardErrors: [{ gate: "semantic_coverage", kind: "contradicted" }],
    reviewRound: 3,
    maximumRepairRounds: 2,
  }), "human_required");
  assert.equal(consensusStatusForPolicy({
    hardErrors: [{ gate: "fidelity", kind: "unsupported_or_provenance" }],
    reviewRound: 20,
    repairAttempt: 5,
    maximumRepairRounds: 5,
  }), "repair_required");
});

test("review round labels and repair attempt ordinals remain independent", () => {
  const prepareSource = fs.readFileSync(new URL("../scripts/review-prepare.mjs", import.meta.url), "utf8");
  const validateSource = fs.readFileSync(new URL("../scripts/review-validate.mjs", import.meta.url), "utf8");
  const repairSchema = JSON.parse(fs.readFileSync(
    new URL("../schemas/repair-log.schema.json", import.meta.url),
    "utf8",
  ));
  assert.doesNotMatch(prepareSource, /repairLog\.repairRound !== previousRound/u);
  assert.match(prepareSource, /hasSupplementalClaimRepair = await exists\(supplementalPath\)/u);
  assert.match(validateSource, /consensus\.repairAttempt \?\? reviewRound/u);
  assert.equal(repairSchema.properties.repairRound.maximum, 99);
});

test("repair overrides require explicit valid case identities and finite positive caps", () => {
  assert.equal(config.reviews.maximumRepairRounds, 2);
  for (const [caseNumber, cap] of Object.entries(config.reviews.repairRoundOverrides ?? {})) {
    assert.match(caseNumber, /^QR-\d{4}$/u);
    assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 99);
  }
});

test("formal CLIs and quality report expose the reader-first hard-error split", () => {
  const validateSource = fs.readFileSync(new URL("../scripts/review-validate.mjs", import.meta.url), "utf8");
  const consensusSource = fs.readFileSync(new URL("../scripts/review-consensus.mjs", import.meta.url), "utf8");
  const qualitySource = fs.readFileSync(new URL("../scripts/quality-report.mjs", import.meta.url), "utf8");

  assert.match(validateSource, /const reportFailures = hardErrors/u);
  assert.match(validateSource, /result\.hardErrors/u);
  assert.doesNotMatch(consensusSource, /status = "needs_adjudication"/u);
  assert.match(consensusSource, /enforced: false/u);
  assert.match(qualitySource, /schemaVersion:\s*"2\.3\.0"/u);
  assert.match(qualitySource, /hardErrors: finalErrors/u);
  assert.match(qualitySource, /Unsupported claims:/u);
});

test('review prompts and operator docs forbid metric-driven expansion', () => {
  const files = {
    coverageB: fs.readFileSync(new URL('../prompts/reviews/coverage-b.md', import.meta.url), 'utf8'),
    adjudicator: fs.readFileSync(new URL('../prompts/reviews/adjudicator.md', import.meta.url), 'utf8'),
    fidelity: fs.readFileSync(new URL('../prompts/reviews/fidelity.md', import.meta.url), 'utf8'),
    reader: fs.readFileSync(new URL('../prompts/reviews/reader-advocate.md', import.meta.url), 'utf8'),
    repair: fs.readFileSync(new URL('../prompts/reviews/repair-editor.md', import.meta.url), 'utf8'),
    agents: fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readme: fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
    workflow: fs.readFileSync(new URL('../docs/workflow.md', import.meta.url), 'utf8'),
  };

  assert.match(files.coverageB, /Coverage 是诊断工具/u);
  assert.match(files.coverageB, /另一名独立角色确认/u);
  assert.match(files.adjudicator, /不能单独把普通 missing 升格为核心遗漏/u);
  assert.match(files.fidelity, /计数与百分比不是 Fidelity 门禁/u);
  assert.match(files.reader, /所有分数只进入 diagnostics/u);
  assert.match(files.reader, /核心概念是否到后半篇才解释/u);
  assert.match(files.reader, /先堆项目名和缩写/u);
  assert.doesNotMatch(files.reader, /任一分数低于 4.*verdict.*revise/u);
  assert.match(files.repair, /不得为了改善任何数字而添加正文/u);
  assert.match(files.agents, /12,000–18,000 Chinese characters and 6–8 chapters are targets rather than gates/u);
  assert.match(files.agents, /Numeric scores inform that decision but do not replace it/u);
  assert.doesNotMatch(files.agents, /Source-claim support and evidence-book coverage are 100%/u);
  // The public quick start links to the canonical operator reference.
  assert.match(files.readme, /\]\(docs\/workflow\.md\)/u);
  assert.match(files.workflow, /Reader-first incremental review policy 2\.4/u);
  assert.match(files.workflow, /deep-read contains no QR-Pilot cards/u);
});
