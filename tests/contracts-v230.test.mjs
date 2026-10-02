import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  deepReadContractErrors,
  renderDeepReadMarkdown,
} from "../scripts/deep-read.mjs";
import { REPO_ROOT } from "../scripts/lib.mjs";
import {
  claimBundleContractErrors,
  coverageClaimsForReview,
  readerMapV2ContractErrors,
  sha256Value,
} from "../scripts/review-contract.mjs";
import { validateThemeMap } from "../scripts/validate-case.mjs";

const CASE_ID = "qr-9999-v230-contract";
const profiles = {
  version: "1.1.0",
  profiles: {
    knowledge: { modules: ["overview", "argument"] },
  },
};
const manifest = {
  id: CASE_ID,
  profile: { primary: "knowledge" },
};
const claims = [
  {
    id: "E0001",
    importance: "high",
    provenance: "source_fact",
    themeId: "T001",
    statement: "Capability depends on data.",
    supportSpans: [],
  },
  {
    id: "E0002",
    importance: "medium",
    provenance: "speaker_view",
    themeId: "T002",
    statement: "Deployment has boundaries.",
    supportSpans: [],
  },
  {
    id: "E0003",
    importance: "low",
    provenance: "source_fact",
    themeId: "T001",
    statement: "Validation precedes deployment.",
    supportSpans: [],
  },
];

function currentDeepRead() {
  return {
    schemaVersion: "2.1.0",
    caseId: CASE_ID,
    workflowVersion: "2.3.0",
    title: "A restrained reader edition",
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
        title: "Overview",
        modules: [{
          id: "overview-main",
          title: null,
          profileModule: "overview",
          blocks: [{
            id: "overview-group",
            type: "prose_group",
            provenance: "source_fact",
            paragraphs: [{
              id: "p-core",
              role: "thesis",
              text: "Models need data and validation for deployment.",
              evidenceRefs: ["E0001", "E0003"],
            }],
          }],
        }],
      },
      {
        id: "themes",
        number: 2,
        title: "Themes",
        modules: [{
          id: "theme-main",
          title: "Boundaries",
          profileModule: "argument",
          blocks: [
            {
              id: "theme-group",
              type: "prose_group",
              provenance: "speaker_view",
              paragraphs: [{
                id: "p-theme",
                role: "explanation",
                text: "The speaker treats deployment boundaries as material.",
                evidenceRefs: ["E0002"],
              }],
            },
            {
              id: "long-list",
              type: "structured_list",
              provenance: "system",
              items: Array.from({ length: 9 }, (_, index) => ({
                id: `item-${index + 1}`,
                text: `Diagnostic list item ${index + 1}.`,
              })),
            },
            {
              id: "short-timeline",
              type: "timeline",
              provenance: "system",
              items: [{
                id: "timeline-1",
                anchor: "Start",
                title: "One optional navigation point",
                evidenceRefs: [],
              }],
            },
          ],
        }],
      },
    ],
  };
}


test("2.3 Coverage packets audit every body-cited claim, including low importance, while legacy scope stays high/medium", () => {
  const deepRead = currentDeepRead();
  const unusedHigh = {
    id: "E9999",
    importance: "high",
    provenance: "source_fact",
    themeId: "T999",
    statement: "This high claim is not used by the reader edition.",
    supportSpans: [],
  };
  assert.deepEqual(
    coverageClaimsForReview([...claims, unusedHigh], deepRead, "2.3.0").map((claim) => claim.id),
    ["E0001", "E0002", "E0003"],
  );
  assert.deepEqual(
    coverageClaimsForReview([...claims, unusedHigh], deepRead, "2.2.1").map((claim) => claim.id),
    ["E0001", "E0002", "E9999"],
  );
});

test("deep-read 2.1 accepts overview plus themes without editor notes or count gates", () => {
  const deepRead = currentDeepRead();
  assert.deepEqual(deepReadContractErrors(deepRead, manifest, profiles, claims), []);

  const withEditor = structuredClone(deepRead);
  withEditor.sections[1].modules[0].blocks.push({
    id: "editorial",
    type: "editor_note",
    provenance: "editorial",
    intent: "commentary",
    title: "Editorial",
    text: "Not permitted in deep-read 2.1.",
  });
  assert.match(
    deepReadContractErrors(withEditor, manifest, profiles, claims).join("\n"),
    /zero editor_note/u,
  );
});

test("workflow 2.4 accepts descriptive Profile module labels as reader metadata", () => {
  const deepRead = currentDeepRead();
  deepRead.schemaVersion = "2.3.0";
  deepRead.workflowVersion = "2.4.0";
  deepRead.sections.splice(1, 0, {
    id: "participants",
    number: 2,
    title: "人物导览",
    modules: [{
      id: "participant-guide",
      title: null,
      profileModule: "participants",
      blocks: [{ id: "participant-guide-main", type: "participant_guide", provenance: "external", guideRef: "work/participant-guide.json" }],
    }],
  });
  deepRead.sections[2].number = 3;
  deepRead.sections[2].modules[0].profileModule = "reader_friendly_explanation";
  assert.deepEqual(deepReadContractErrors(deepRead, manifest, profiles, claims), []);

  const themeMap = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    profile: "knowledge",
    themes: [{
      id: "T001",
      order: 1,
      title: "主题",
      summary: "摘要",
      profileModules: ["reader_friendly_explanation"],
      claimRefs: ["E0001", "E0002", "E0003"],
      importanceCoverage: { high: 1, medium: 1, low: 1 },
    }],
    unassignedClaimRefs: [],
  };
  const v24Manifest = { ...manifest, workflow: { version: "2.4.0" } };
  assert.deepEqual(validateThemeMap(themeMap, v24Manifest, new Set(claims.map((claim) => claim.id)), profiles), []);

  themeMap.themes[0].claimRefs = ["E0001"];
  themeMap.unassignedClaimRefs = ["E0002", "E0003"];
  assert.deepEqual(validateThemeMap(themeMap, v24Manifest, new Set(claims.map((claim) => claim.id)), profiles), []);

  themeMap.unassignedClaimRefs.push("E9999");
  assert.match(
    validateThemeMap(themeMap, v24Manifest, new Set(claims.map((claim) => claim.id)), profiles).join("\n"),
    /引用未知 claim：E9999/u,
  );
});

test("deep-read Markdown 2.1/2.2 hides provenance labels while legacy rendering keeps them", () => {
  const config = { editorPersona: { name: "QR-Pilot" }, __citations: [] };
  const current = renderDeepReadMarkdown(currentDeepRead(), manifest, config);
  assert.doesNotMatch(current, /^\*\*[^\n]+\*\*$/mu);

  const controlled = currentDeepRead();
  controlled.schemaVersion = "2.2.0";
  const controlledMarkdown = renderDeepReadMarkdown(controlled, manifest, config);
  assert.doesNotMatch(controlledMarkdown, /说话人观点|原子 claim|支持区段/u);

  const legacy = currentDeepRead();
  legacy.schemaVersion = "2.0.0";
  const legacyMarkdown = renderDeepReadMarkdown(legacy, manifest, config);
  assert.match(legacyMarkdown, /^\*\*[^\n]+\*\*$/mu);
});

test("reader-map 2.1 validates only actual explicit or synthesized entries", () => {
  const deepRead = currentDeepRead();
  const readerMap = {
    schemaVersion: "2.1.0",
    caseId: CASE_ID,
    entries: [
      {
        evidenceRef: "E0001",
        importance: "high",
        presentation: "explicit",
        coverageSpans: [{
          readerBlockRef: "p-core",
          readerTextQuote: "need data",
        }],
      },
      {
        evidenceRef: "E0003",
        importance: "low",
        presentation: "explicit",
        coverageSpans: [{
          readerBlockRef: "p-core",
          readerTextQuote: "validation for deployment",
        }],
      },
    ],
  };
  assert.deepEqual(readerMapV2ContractErrors(readerMap, {
    caseId: CASE_ID,
    claims,
    deepRead,
  }), []);

  const invalid = structuredClone(readerMap);
  invalid.entries[0].presentation = "evidence_only";
  assert.match(
    readerMapV2ContractErrors(invalid, { caseId: CASE_ID, claims, deepRead }).join("\n"),
    /explicit or synthesized/u,
  );

  const merged = structuredClone(readerMap);
  const mergedDeepRead = structuredClone(deepRead);
  mergedDeepRead.sections[0].modules[0].blocks[0].paragraphs.push({
    id: "p-second",
    role: "explanation",
    text: "The same data condition also shapes the next decision.",
    evidenceRefs: ["E0001"],
  });
  merged.entries[0].presentation = "synthesized";
  merged.entries[0].coverageSpans.push({
    readerBlockRef: "p-second",
    readerTextQuote: "same data condition",
  });
  assert.deepEqual(readerMapV2ContractErrors(merged, {
    caseId: CASE_ID,
    claims,
    deepRead: mergedDeepRead,
  }), []);

  const duplicateEntry = structuredClone(merged);
  duplicateEntry.entries.push(structuredClone(duplicateEntry.entries[0]));
  assert.match(
    readerMapV2ContractErrors(duplicateEntry, { caseId: CASE_ID, claims, deepRead: mergedDeepRead }).join("\n"),
    /duplicate|\u91cd\u590d/u,
  );
});

test("2.3 claim bundles are selective and multiple bundles may share a reader block", () => {
  const deepRead = currentDeepRead();
  const readerMap = {
    schemaVersion: "2.1.0",
    caseId: CASE_ID,
    entries: [
      {
        evidenceRef: "E0001",
        importance: "high",
        presentation: "explicit",
        coverageSpans: [{ readerBlockRef: "p-core", readerTextQuote: "need data" }],
      },
      {
        evidenceRef: "E0003",
        importance: "low",
        presentation: "explicit",
        coverageSpans: [{ readerBlockRef: "p-core", readerTextQuote: "validation for deployment" }],
      },
    ],
  };
  const claimReviewHash = "a".repeat(64);
  const bundles = {
    schemaVersion: "1.0.0",
    caseId: CASE_ID,
    inputHashes: {
      evidence: sha256Value(claims),
      claimReview: claimReviewHash,
    },
    bundles: [
      {
        id: "CB001",
        themeId: "T001",
        order: 1,
        title: "Data",
        narrativePurpose: "State the data condition.",
        readerBlockRef: "p-core",
        requiredReaderRefs: ["E0001"],
        optionalReaderRefs: [],
        evidenceOnlyRefs: [],
      },
      {
        id: "CB002",
        themeId: "T001",
        order: 2,
        title: "Validation",
        narrativePurpose: "State the validation condition.",
        readerBlockRef: "p-core",
        requiredReaderRefs: [],
        optionalReaderRefs: ["E0003"],
        evidenceOnlyRefs: [],
      },
    ],
  };
  assert.deepEqual(claimBundleContractErrors(bundles, {
    caseId: CASE_ID,
    claims,
    claimReviewHash,
    deepRead,
    readerMap,
  }), []);
});

test("2.4.2 schemas and prompt expose the current compatibility branches", async () => {
  const [config, deepSchema, readerSchema, qualitySchema, prompt] = await Promise.all([
    fs.readFile(path.join(REPO_ROOT, "config", "pipeline.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "deep-read.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "reader-map.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "schemas", "quality-report.schema.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(REPO_ROOT, "prompts", "03-synthesize.md"), "utf8"),
  ]);
  assert.equal(config.workflowVersion, "2.4.2");
  assert.equal(config.promptVersion, "3.4.2");
  assert.deepEqual(deepSchema.properties.schemaVersion.enum, ["2.0.0", "2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0"]);
  assert.deepEqual(readerSchema.properties.schemaVersion.enum, ["2.0.0", "2.1.0"]);
  const currentQuality = qualitySchema.allOf.find((branch) => (
    branch.if.properties.schemaVersion.const === "2.3.0"
  ));
  assert.deepEqual(
    currentQuality.then.required,
    ["contextGuide", "hardErrors", "warnings", "diagnostics", "metricPolicy"],
  );
  assert.equal(
    qualitySchema.properties.metricPolicy.properties.quantitativeMetricsBlocking.const,
    false,
  );
  assert.match(prompt, /Prompt 3\.4\.2/u);
  assert.match(prompt, /第三人称、克制的观察性叙述/u);
  assert.match(prompt, /核心概念必须在首次承担论证功能时/u);
  assert.match(prompt, /先说明一个方法解决什么问题、比较什么，再给缩写或项目名/u);
  assert.doesNotMatch(prompt, /\uFFFD/u);
});
