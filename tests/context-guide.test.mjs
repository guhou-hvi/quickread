import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { renderDeepReadMarkdown } from "../scripts/deep-read.mjs";
import { renderCase } from "../scripts/render.mjs";

import {
  contextGuideContractErrors,
  contextGuideUsageErrors,
  countContextReferences,
  renderContextGuideMarkdown,
  renderContextInlineMarkdown,
  selectContextGuideEntries,
} from "../scripts/context-guide.mjs";
import {
  renderContextGuide,
  renderContextInlineNote,
  renderContextInlineNotes,
  shouldRenderStandaloneContextGuide,
} from "../scripts/render.mjs";
import {
  contextGuideExternalSurface,
  contextGuideReaderSurfaces,
} from "../scripts/context-guide-review.mjs";
import {
  applyBriefLeadContextDecisions,
} from "../scripts/relocate-context-leads-v242.mjs";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/u, "$1"));

function guideFixture() {
  return {
    schemaVersion: "1.0.0",
    caseId: "qr-test",
    verifiedAt: "2026-09-02",
    entries: [
      {
        id: "magi",
        name: "Magi",
        kind: "product",
        aliases: ["magi.com"],
        inlineDefinition: { text: "一个知识引擎项目", provenance: "source_fact", evidenceRefs: ["E1"] },
        background: { text: "由 Peak Labs 开发。", provenance: "external", citationRefs: ["R1"] },
        relevance: { text: "它帮助解释技术路线的转折。", provenance: "speaker_view", evidenceRefs: ["E2"] },
      },
    ],
  };
}

test("original article renders without invented guides but rejects dangling references", async (t) => {
  const deep = { schemaVersion: "2.5.0", title: "原创文章", sections: [{ id: "themes", number: 1, title: "方法", modules: [{ blocks: [{ id: "g1", type: "prose_group", provenance: "source_fact", paragraphs: [{ id: "p1", text: "记录自己的阅读问题。", evidenceRefs: ["E0001"] }] }] }] }] };
  assert.match(renderDeepReadMarkdown(deep, { sourceType: "article" }, {}), /记录自己的阅读问题/u);
  deep.sections[0].modules[0].blocks[0].paragraphs[0].contextRefs = ["missing"];
  assert.throws(() => renderDeepReadMarkdown(deep, { sourceType: "article" }, {}), /未知 context/u);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-guideless-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "output"));
  const manifest = { id: path.basename(dir), sourceType: "article", source: { path: "input/source.md" }, workflow: { version: "2.4.2", templateVersion: "1.4.4" }, profile: { primary: "knowledge" } };
  const brief = { schemaVersion: "1.7.0", caseId: manifest.id, workflowVersion: "2.4.2", templateVersion: "1.4.4", title: "原创文章", brand: "QuickRead", profile: manifest.profile, density: { total: 1 }, citations: [], sections: [{ id: "method", number: 1, title: "方法", lead: "先提问", timeAnchors: [], blocks: [] }], sourceMeta: { label: "原创文章" }, summary: "阅读测试", readingMinutes: 1, generatedAt: "2026-09-16" };
  await fs.writeFile(path.join(dir, "case.json"), JSON.stringify(manifest));
  const save = () => fs.writeFile(path.join(dir, "output/brief.json"), JSON.stringify(brief));
  await save();
  await renderCase(dir);
  brief.sections[0].contextRefs = ["missing"];
  await save();
  await assert.rejects(renderCase(dir), /未知 context/u);
  delete brief.sections[0].contextRefs;
  await save();
  manifest.sourceType = "video";
  await fs.writeFile(path.join(dir, "case.json"), JSON.stringify(manifest));
  await assert.rejects(renderCase(dir), /participant-guide/u);
});

test("context guide keeps source, external background and relevance separate", () => {
  const guide = guideFixture();
  assert.deepEqual(contextGuideContractErrors(guide, {
    manifest: { id: "qr-test" },
    evidenceIds: new Set(["E1", "E2"]),
    citationIds: new Set(["R1"]),
  }), []);

  const missing = structuredClone(guide);
  missing.entries[0].background.citationRefs = ["R404"];
  assert.match(contextGuideContractErrors(missing, {
    manifest: { id: "qr-test" },
    evidenceIds: new Set(["E1", "E2"]),
    citationIds: new Set(["R1"]),
  }).join("\n"), /未知资料：R404/u);

  const person = structuredClone(guide);
  person.entries[0].kind = "person";
  assert.match(contextGuideContractErrors(person, {
    manifest: { id: "qr-test" },
    evidenceIds: new Set(["E1", "E2"]),
    citationIds: new Set(["R1"]),
  }).join("\n"), /误用了人物类型/u);
});

test("brief citation checks can be limited to its selected context subset", () => {
  const guide = guideFixture();
  guide.entries.push({
    id: "manus",
    name: "Manus",
    kind: "product",
    aliases: [],
    inlineDefinition: { text: "一个任务型 Agent 产品。", provenance: "external", citationRefs: ["R2"] },
    background: { text: "由独立团队开发。", provenance: "external", citationRefs: ["R2"] },
    relevance: { text: "它不进入本速览。", provenance: "source_fact", evidenceRefs: ["E2"] },
  });
  const selected = selectContextGuideEntries(guide, ["magi"]);
  assert.deepEqual(selected.entries.map((entry) => entry.id), ["magi"]);
  assert.deepEqual(contextGuideContractErrors(selected, {
    manifest: { id: "qr-test" },
    evidenceIds: new Set(["E1", "E2"]),
    citationIds: new Set(["R1"]),
  }), []);
});

test("external citation review receives every externally sourced guide field", () => {
  const guide = guideFixture();
  guide.entries[0].inlineDefinition = {
    text: "外部定义",
    provenance: "external",
    citationRefs: ["R1"],
  };
  guide.entries[0].relevance = {
    text: "外部说明的本期关联",
    provenance: "external",
    citationRefs: ["R1"],
  };
  const [entry] = contextGuideExternalSurface(guide).entries;
  assert.deepEqual(entry.externalStatements.map(({ field }) => field), [
    "inlineDefinition",
    "background",
    "relevance",
  ]);
});

test("deep and brief require one first-use marker per guide entry", () => {
  const guide = guideFixture();
  const deep = {
    sections: [{ id: "themes", modules: [{ id: "chapter", blocks: [{
      type: "prose_group",
      paragraphs: [{ id: "p1", text: "Magi 改变了路线。", contextRefs: ["magi"] }],
    }] }] }],
  };
  const brief = {
    sections: [{ id: "s1", blocks: [{ type: "paragraph", text: "Magi 改变了路线。", contextRefs: ["magi"] }] }],
  };
  assert.deepEqual(contextGuideUsageErrors(deep, guide, { kind: "deep-read" }), []);
  assert.deepEqual(contextGuideUsageErrors(brief, guide, { kind: "brief" }), []);

  deep.sections[0].modules[0].blocks[0].paragraphs.push({ id: "p2", text: "Magi 再次出现。", contextRefs: ["magi"] });
  assert.match(contextGuideUsageErrors(deep, guide, { kind: "deep-read" }).join("\n"), /重复标记关键名词/u);

  brief.sections[0].blocks[0].contextRefs = ["unknown"];
  assert.match(contextGuideUsageErrors(brief, guide, { kind: "brief" }).join("\n"), /未知 context entry/u);
});

test("2.4.2 first-use validation ignores declared preview surfaces and rejects delayed placement", () => {
  const guide = guideFixture();
  const deep = {
    sections: [{ id: "overview", modules: [{ id: "overview", blocks: [{
      type: "prose_group",
      paragraphs: [
        { id: "preview", role: "transition", text: "后文会谈到 Magi。" },
        { id: "first", role: "explanation", text: "Magi 把公开网页组织成知识。", contextRefs: ["magi"] },
        { id: "later", role: "explanation", text: "Magi 后来遇到路线变化。" },
      ],
    }] }] }],
  };
  assert.deepEqual(contextGuideUsageErrors(deep, guide, {
    kind: "deep-read",
    enforceEarliest: true,
  }), []);
  deep.sections[0].modules[0].blocks[0].paragraphs[1].contextRefs = [];
  deep.sections[0].modules[0].blocks[0].paragraphs[2].contextRefs = ["magi"];
  assert.match(contextGuideUsageErrors(deep, guide, {
    kind: "deep-read",
    enforceEarliest: true,
  }).join("\n"), /必须标记在最早实质出现 first/u);

  const brief = {
    sections: [{ id: "s1", title: "Magi", lead: "先预告 Magi", contextPreviewRefs: ["magi"], blocks: [
      { type: "editor_note", provenance: "editorial", text: "Magi 点评", contextRefs: [] },
      { type: "paragraph", provenance: "speaker_view", text: "Magi 是一次产品路线选择。", contextRefs: ["magi"] },
    ] }],
  };
  assert.deepEqual(contextGuideUsageErrors(brief, guide, {
    kind: "brief",
    selectedRefs: ["magi"],
    enforceEarliest: true,
  }), []);
});

test("2.4.2 can mark a term-specific preview inside an otherwise substantive node", () => {
  const guide = guideFixture();
  const deep = {
    sections: [{ id: "overview", modules: [{ id: "overview", blocks: [{
      type: "prose_group",
      paragraphs: [
        {
          id: "overview-thesis",
          role: "thesis",
          text: "这段先建立创业主线，并预告后文会具体讨论 Magi。",
          contextPreviewRefs: ["magi"],
        },
        {
          id: "first-substantive-use",
          role: "explanation",
          text: "Magi 试图从公开网页持续提取结构化知识。",
          contextRefs: ["magi"],
        },
      ],
    }] }] }],
  };
  assert.deepEqual(contextGuideUsageErrors(deep, guide, {
    kind: "deep-read",
    enforceEarliest: true,
  }), []);

  deep.sections[0].modules[0].blocks[0].paragraphs[0].contextRefs = ["magi"];
  assert.match(contextGuideUsageErrors(deep, guide, {
    kind: "deep-read",
    enforceEarliest: true,
  }).join("\n"), /不能同时把 Magi 标为背景注和纯预告/u);
});

test("brief first-use and review surfaces include nested items and comparison columns", () => {
  const guide = guideFixture();
  const brief = {
    summary: "摘要",
    sections: [{ id: "s1", title: "主题", lead: "导语 Magi", contextPreviewRefs: ["magi"], blocks: [
      {
        type: "bullets",
        provenance: "speaker_view",
        items: [
          { text: "Magi 是知识产品。", contextRefs: ["magi"] },
          { text: "后续观察。" },
        ],
      },
      {
        type: "comparison",
        provenance: "speaker_view",
        columns: [{ title: "Magi 之后", items: ["路线变化"], contextRefs: [] }],
      },
    ] }],
  };
  assert.deepEqual(contextGuideUsageErrors(brief, guide, {
    kind: "brief",
    selectedRefs: ["magi"],
    enforceEarliest: true,
  }), []);
  const surfaces = contextGuideReaderSurfaces({ sections: [] }, brief, "reader");
  assert.equal(surfaces.briefPlacements.length, 1);
  assert.equal(surfaces.briefPlacements[0].itemId, "s1-block-1-item-1");
  assert.match(surfaces.briefText, /Magi 是知识产品/u);
  assert.match(surfaces.briefText, /路线变化/u);
  assert.equal(surfaces.briefPreviews[0].blockId, "s1-lead");
});

test("brief section lead is a substantive first-use node and renders its review placement", () => {
  const guide = guideFixture();
  const brief = {
    summary: "标题区只作导航，因此即使出现 Magi 也不承载背景注。",
    sections: [{
      id: "route",
      title: "Magi 路线",
      lead: "Magi 从公开网页持续提取并组织知识，成为上一轮创业的核心产品。",
      contextRefs: ["magi"],
      blocks: [{ type: "paragraph", provenance: "speaker_view", text: "这条路线随后遭遇通用模型冲击。" }],
    }],
  };
  assert.deepEqual(contextGuideUsageErrors(brief, guide, {
    kind: "brief",
    selectedRefs: ["magi"],
    enforceEarliest: true,
  }), []);
  const surfaces = contextGuideReaderSurfaces({ sections: [] }, brief, "reader");
  assert.equal(surfaces.briefPlacements[0].blockId, "route-lead");
  assert.deepEqual(surfaces.briefPlacements[0].contextRefs, ["magi"]);
  const inlineHtml = renderContextInlineNotes(brief.sections[0], guide, new Map([["R1", 1]]), new Set(), { detailed: true });
  assert.match(inlineHtml, /data-context-ref="magi"/u);
  assert.equal(countContextReferences(brief.sections), 1);

  delete brief.sections[0].contextRefs;
  brief.sections[0].blocks[0].text = "Magi 这条路线随后遭遇通用模型冲击。";
  brief.sections[0].blocks[0].contextRefs = ["magi"];
  assert.match(contextGuideUsageErrors(brief, guide, {
    kind: "brief",
    selectedRefs: ["magi"],
    enforceEarliest: true,
  }).join("\n"), /必须标记在最早实质出现 route-lead/u);
});

test("approved lead relocation is idempotent and preserves a genuine later preview", () => {
  const brief = {
    sections: [
      {
        id: "lead-section",
        lead: "Magi 只是后文预告。",
        blocks: [{ text: "Magi 从网页提取知识。", contextRefs: ["magi"] }],
      },
      {
        id: "substantive-section",
        lead: "Monica 提供现金流和真实用户观察。",
        blocks: [{ text: "Monica 是浏览器 AI 助手。", contextRefs: ["monica"] }],
      },
    ],
  };
  const decisions = {
    magi: { sectionId: "lead-section", action: "preview" },
    monica: { sectionId: "substantive-section", action: "move" },
  };
  applyBriefLeadContextDecisions(brief, decisions);
  applyBriefLeadContextDecisions(brief, decisions);
  assert.deepEqual(brief.sections[0].contextPreviewRefs, ["magi"]);
  assert.deepEqual(brief.sections[0].blocks[0].contextRefs, ["magi"]);
  assert.deepEqual(brief.sections[1].contextRefs, ["monica"]);
  assert.equal(brief.sections[1].blocks[0].contextRefs, undefined);
});

test("context guide rendering is compact, cited and responsive by contract", async () => {
  const guide = guideFixture();
  const citations = new Map([["R1", 1]]);
  const markdownFirst = renderContextGuideMarkdown(guide);
  const markdownSecond = renderContextGuideMarkdown(guide);
  assert.equal(markdownFirst, markdownSecond);
  assert.match(markdownFirst, /Magi｜产品/u);
  assert.match(markdownFirst, /\[R1\]\(#r1\)/u);

  const html = renderContextGuide(guide, citations);
  assert.match(html, /data-component="context_guide"/u);
  assert.match(html, /data-context-id="magi"/u);
  assert.match(html, /href="#source-R1"/u);

  const detailedMarkdown = renderContextInlineMarkdown(guide.entries[0], { detailed: true });
  assert.match(detailedMarkdown, /\*\*是什么\*\*.*\[E1\]/su);
  assert.match(detailedMarkdown, /\*\*背景\*\*.*\[R1\]/su);
  assert.match(detailedMarkdown, /\*\*本期作用\*\*.*\[E2\]/su);
  const detailedHtml = renderContextInlineNote(guide.entries[0], citations, { detailed: true });
  assert.match(detailedHtml, /<dt>是什么<\/dt>/u);
  assert.match(detailedHtml, /<dt>背景<\/dt>/u);
  assert.match(detailedHtml, /<dt>本期作用<\/dt>/u);
  assert.match(detailedHtml, /evidence-book\.md#e1/u);
  assert.match(detailedHtml, /href="#source-R1"/u);
  assert.equal(shouldRenderStandaloneContextGuide({ schemaVersion: "1.6.0", contextGuide: {} }), true);
  assert.equal(shouldRenderStandaloneContextGuide({ schemaVersion: "1.7.0", contextGuide: {} }), false);

  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  assert.match(css, /\.context-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/su);
  assert.match(css, /@media[^}]*max-width[^}]*\{[\s\S]*?\.context-grid\s*\{[^}]*grid-template-columns:\s*1fr/su);
  assert.match(css, /\.context-card\s*\{[^}]*break-inside:\s*avoid/su);
  assert.match(css, /\.context-inline-note-detailed\s*\{[^}]*display:\s*block/su);
});

test("2.4.2 version set retains 2.4.1 artifacts", async () => {
  const [pipeline, deepSchema, briefSchema, qualitySchema] = await Promise.all([
    fs.readFile(path.join(REPO_ROOT, "config", "pipeline.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "deep-read.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "brief.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "quality-report.schema.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(pipeline.workflowVersion, "2.4.2");
  assert.equal(pipeline.promptVersion, "3.4.2");
  assert.equal(pipeline.reviews.version, "2.4.2");
  assert.equal(pipeline.templateVersion, "1.4.4");
  assert.ok(pipeline.compatibility.retainedWorkflowVersions.includes("2.4.0"));
  assert.ok(pipeline.compatibility.retainedWorkflowVersions.includes("2.4.1"));
  assert.ok(deepSchema.properties.schemaVersion.enum.includes("2.4.0"));
  assert.ok(deepSchema.properties.schemaVersion.enum.includes("2.5.0"));
  assert.ok(briefSchema.properties.schemaVersion.enum.includes("1.6.0"));
  assert.ok(briefSchema.properties.schemaVersion.enum.includes("1.7.0"));
  const deepV25 = deepSchema.allOf.find((branch) => branch.if.properties.schemaVersion.const === "2.5.0");
  assert.equal(deepV25.then.properties.sections.items.$ref, "#/$defs/currentV23Section");
  assert.equal(deepSchema.$defs.currentV23Block.oneOf.some((item) => item.$ref === "#/$defs/contextGuideBlock"), false);
  const briefV17 = briefSchema.allOf.find((branch) => branch.if.properties.schemaVersion.const === "1.7.0");
  assert.ok(briefV17.then.properties.contextGuide.required.includes("placement"));
  assert.equal(briefV17.then.properties.contextGuide.properties.placement.const, "inline_first_use");
  assert.ok(qualitySchema.properties.schemaVersion.enum.includes("2.3.0"));
});
