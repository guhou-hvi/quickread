import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  controlledQuoteErrors,
  deepReadContractErrors,
  renderDeepReadMarkdown,
} from "../scripts/deep-read.mjs";
import {
  controlledBriefQuoteErrors,
  renderBlock,
} from "../scripts/render.mjs";
import { REPO_ROOT } from "../scripts/lib.mjs";

const claim = {
  id: "E0001",
  importance: "high",
  provenance: "speaker_view",
  themeId: "T001",
  statement: "研究空间像氧气。",
  supportSpans: [{
    segmentId: "S0001",
    sourceIds: ["C000001"],
    locator: "06:19:54–06:22:04",
    quote: "嗯，我我觉得 research 空间就是那个氧气。",
  }],
};

const spokenQuote = {
  id: "quote-research",
  type: "quote",
  provenance: "speaker_view",
  text: "我觉得 research 空间就是氧气。",
  attribution: "谢赛宁",
  quoteMode: "spoken_cleanup",
  sourceLocator: "06:19:54–06:22:04",
  sourceText: "嗯，我我觉得 research 空间就是那个氧气。",
  evidenceRefs: ["E0001"],
};

const claimById = new Map([[claim.id, claim]]);

function deepReadWith(block) {
  return {
    schemaVersion: "2.2.0",
    caseId: "qr-9999-controlled-quote",
    workflowVersion: "2.3.0",
    title: "受控引语夹具",
    profile: { primary: "knowledge", lenses: [], version: "1.1.0" },
    density: {
      scores: {
        atomicInformation: 1,
        themeDependency: 1,
        evidenceRichness: 1,
        controversy: 1,
        uniqueness: 1,
      },
      total: 5,
    },
    readerBudget: {
      recommendedCharacters: 12000,
      minimumGuideline: 12000,
      maximumGuideline: 18000,
      softCharacterCap: 35000,
    },
    sections: [
      {
        id: "overview",
        number: 1,
        title: "概览",
        modules: [{
          id: "overview-main",
          title: null,
          profileModule: "overview",
          blocks: [{
            id: "overview-group",
            type: "prose_group",
            provenance: "speaker_view",
            paragraphs: [{
              id: "overview-p1",
              role: "thesis",
              text: "研究空间决定探索是否还能继续。",
              evidenceRefs: ["E0001"],
            }],
          }],
        }],
      },
      {
        id: "themes",
        number: 2,
        title: "主题",
        modules: [{
          id: "theme-main",
          title: "研究空间",
          profileModule: "argument",
          blocks: [block],
        }],
      },
    ],
  };
}

const manifest = {
  id: "qr-9999-controlled-quote",
  profile: { primary: "knowledge" },
};
const profiles = {
  version: "1.1.0",
  profiles: { knowledge: { modules: ["overview", "argument"] } },
};

test("spoken_cleanup accepts deletion-only speech cleanup and exact support locator", () => {
  assert.deepEqual(controlledQuoteErrors(spokenQuote, claimById), []);
  assert.deepEqual(
    deepReadContractErrors(deepReadWith(spokenQuote), manifest, profiles, [claim]),
    [],
  );
});

test("controlled quote rejects missing disclosure, wrong source, additions and reordering", () => {
  assert.match(
    controlledQuoteErrors({ ...spokenQuote, sourceText: "" }, claimById).join("\n"),
    /requires sourceText|only delete/u,
  );
  assert.match(
    controlledQuoteErrors({ ...spokenQuote, sourceLocator: "06:10:00–06:11:00" }, claimById).join("\n"),
    /does not match a continuous referenced support span/u,
  );
  assert.match(
    controlledQuoteErrors({ ...spokenQuote, sourceText: "另一段并不存在的原话" }, claimById).join("\n"),
    /does not match a continuous referenced support span/u,
  );
  assert.match(
    controlledQuoteErrors({ ...spokenQuote, text: "我真的觉得 research 空间就是氧气。" }, claimById).join("\n"),
    /additions or reordering are forbidden/u,
  );
  assert.match(
    controlledQuoteErrors({ ...spokenQuote, text: "氧气就是 research 空间，我觉得。" }, claimById).join("\n"),
    /additions or reordering are forbidden/u,
  );
  assert.match(
    controlledQuoteErrors({ ...spokenQuote, text: "我觉得研究空间就是氧气。" }, claimById).join("\n"),
    /additions or reordering are forbidden/u,
    "translating the guest's code-switching is not spoken cleanup",
  );
});

test("verbatim remains an exact normalized substring and legacy branches stay readable", () => {
  const verbatim = {
    ...spokenQuote,
    text: "我我觉得 research 空间就是那个氧气",
    quoteMode: "verbatim",
  };
  delete verbatim.sourceLocator;
  delete verbatim.sourceText;
  assert.deepEqual(controlledQuoteErrors(verbatim, claimById), []);
  assert.match(
    controlledQuoteErrors({ ...verbatim, text: "我觉得研究空间就是氧气" }, claimById).join("\n"),
    /does not match normalized support text/u,
  );

  const legacy = deepReadWith({
    id: "quote-legacy",
    type: "quote",
    provenance: "speaker_view",
    text: "我我觉得 research 空间就是那个氧气",
    attribution: "谢赛宁",
    evidenceRefs: ["E0001"],
  });
  legacy.schemaVersion = "2.1.0";
  assert.deepEqual(deepReadContractErrors(legacy, manifest, profiles, [claim]), []);
});

test("Markdown and HTML generate the fixed spoken-cleanup disclosure and hide sourceText", () => {
  const markdown = renderDeepReadMarkdown(
    deepReadWith(spokenQuote),
    manifest,
    { editorPersona: { name: "QR-Pilot" }, __citations: [] },
  );
  assert.match(markdown, /> ——谢赛宁〔口语整理 · 06:19:54〕/u);
  assert.doesNotMatch(markdown, /嗯，我我觉得/u);

  assert.deepEqual(controlledBriefQuoteErrors(spokenQuote), []);
  const html = renderBlock(spokenQuote, new Map(), {}, "1.4.0");
  const htmlV15 = renderBlock(spokenQuote, new Map(), {}, "1.5.0");
  assert.match(html, /<figcaption class="quote-attribution">——谢赛宁〔口语整理 · 06:19:54〕<\/figcaption>/u);
  assert.match(htmlV15, /<figcaption class="quote-attribution">——谢赛宁〔口语整理 · 06:19:54〕<\/figcaption>/u);
  assert.doesNotMatch(html, /嗯，我我觉得/u);
  assert.doesNotMatch(html, /sourceText|sourceLocator|quoteMode/u);
});

test("2.2/1.4 schemas require controlled fields without removing legacy branches", async () => {
  const [deepSchema, briefSchema] = await Promise.all([
    fs.readFile(path.join(REPO_ROOT, "schemas", "deep-read.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "brief.schema.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(deepSchema.properties.schemaVersion.enum, ["2.0.0", "2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0"]);
  assert.deepEqual(deepSchema.$defs.controlledQuote.properties.quoteMode.enum, ["verbatim", "spoken_cleanup"]);
  assert.ok(deepSchema.$defs.controlledQuote.required.includes("quoteMode"));
  const spokenRule = deepSchema.$defs.controlledQuote.allOf.find(
    (rule) => rule.if?.properties?.quoteMode?.const === "spoken_cleanup",
  );
  assert.deepEqual(spokenRule.then.required, ["sourceLocator", "sourceText"]);

  assert.deepEqual(briefSchema.properties.schemaVersion.enum, ["1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"]);
  assert.deepEqual(briefSchema.$defs.block.properties.quoteMode.enum, ["verbatim", "spoken_cleanup"]);
  assert.ok(briefSchema.$defs.controlledBlock);
});
