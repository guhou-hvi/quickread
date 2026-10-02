import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  EDITOR_NOTE_INTENT_LABELS,
  editorialBlockErrors,
  editorPersonaErrors,
  publicVersionErrors,
} from "../scripts/brief-contract.mjs";
import {
  footerText,
  renderBlock,
} from "../scripts/render.mjs";
import { readJson, REPO_ROOT } from "../scripts/lib.mjs";

const EDITOR_PERSONA = {
  name: "QR-Pilot",
  avatarText: "QR",
  footerRole: "AI 小编",
  uid: "440209381",
};

const VALID_NOTE = {
  type: "editor_note",
  provenance: "editorial",
  intent: "caution",
  title: "速度只有沉淀为知识才有价值",
  text: "失败必须被定位、修复并转化为系统知识。",
};

test("QR-Pilot contract enforces the dedicated shape and controlled intent", () => {
  assert.deepEqual(editorialBlockErrors(VALID_NOTE), []);
  assert.deepEqual(editorPersonaErrors(EDITOR_PERSONA), []);
  assert.deepEqual(publicVersionErrors("v0.1"), []);
  assert.deepEqual(editorialBlockErrors({ type: "paragraph", provenance: "source_fact" }), []);

  assert.match(
    editorialBlockErrors({ ...VALID_NOTE, type: "paragraph" }).join(" "),
    /只能使用 editor_note/,
  );
  assert.match(
    editorialBlockErrors({ ...VALID_NOTE, provenance: "source_fact" }).join(" "),
    /provenance 必须是 editorial/,
  );
  assert.match(
    editorialBlockErrors({ ...VALID_NOTE, label: "编辑分析", tone: "yellow" }).join(" "),
    /禁用字段：label、tone/,
  );
  assert.match(editorialBlockErrors({ ...VALID_NOTE, intent: undefined }).join(" "), /intent 必须是/);
  assert.match(editorialBlockErrors({ ...VALID_NOTE, intent: "opinion" }).join(" "), /intent 必须是/);
  assert.match(
    editorialBlockErrors({ type: "paragraph", provenance: "source_fact", intent: "summary" }).join(" "),
    /只有 editor_note 可以设置 intent/,
  );
  assert.match(editorialBlockErrors({ ...VALID_NOTE, title: "" }).join(" "), /观点标题不能为空/);
  assert.match(editorialBlockErrors({ ...VALID_NOTE, text: "" }).join(" "), /正文不能为空/);
});

test("QR-Pilot summary requires source evidence", () => {
  assert.match(
    editorialBlockErrors({ ...VALID_NOTE, intent: "summary" }).join(" "),
    /必须提供至少一个 evidenceRef/,
  );
  assert.deepEqual(
    editorialBlockErrors({ ...VALID_NOTE, intent: "summary", evidenceRefs: ["E001"] }),
    [],
  );
});

test("renderer maps all intents into one deterministic inline heading", () => {
  const expected = {
    summary: "总结",
    commentary: "点评",
    critique: "锐评",
    caution: "提醒",
  };
  assert.deepEqual(EDITOR_NOTE_INTENT_LABELS, expected);

  for (const [intent, label] of Object.entries(expected)) {
    const block = {
      ...VALID_NOTE,
      intent,
      ...(intent === "summary" ? { evidenceRefs: ["E001"] } : {}),
    };
    const html = renderBlock(block, new Map(), EDITOR_PERSONA);
    assert.equal((html.match(/class="editor-note"/g) ?? []).length, 1);
    assert.equal((html.match(/class="editor-note-heading"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`data-editor-intent="${intent}"`));
    assert.match(html, /class="editor-note-avatar"[^>]*>QR<\/span>/);
    assert.match(html, /class="editor-note-name">QR-Pilot<\/span>/);
    assert.match(html, new RegExp(`class="editor-note-action">${label}：</span>`));
    assert.match(html, /class="editor-note-subject">速度只有沉淀为知识才有价值<\/span>/);
    assert.doesNotMatch(html, /editor-note-identity|AI 小编|编辑分析|编辑综合/);
  }

  assert.throws(
    () => renderBlock({ ...VALID_NOTE, intent: "summary" }, new Map(), EDITOR_PERSONA),
    /必须提供至少一个 evidenceRef/,
  );
});

test("footer includes the public version from global config", () => {
  assert.equal(
    footerText("QuickRead Longform", "v0.1", EDITOR_PERSONA),
    "QuickRead Longform v0.1 · AI 小编 QR-Pilot 整理 · UID 440209381",
  );
});

test("schema and independent fixtures enforce all editor-note intents", async () => {
  const schema = await readJson(path.join(REPO_ROOT, "schemas", "brief.schema.json"));
  assert.deepEqual(schema.properties.schemaVersion.enum, ["1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"]);
  assert.equal(Object.hasOwn(schema.properties, "footerNote"), false);
  assert.ok(schema.$defs.block.properties.type.enum.includes("editor_note"));
  assert.deepEqual(schema.$defs.block.properties.intent.enum, ["summary", "commentary", "critique", "caution"]);

  const intentCounts = { summary: 0, commentary: 0, critique: 0, caution: 0 };
  for (const intent of Object.keys(intentCounts)) {
    const block = { ...VALID_NOTE, intent, ...(intent === "summary" ? { evidenceRefs: ["E0001"] } : {}) };
    assert.deepEqual(editorialBlockErrors(block), []);
    const html = renderBlock(block, new Map(), EDITOR_PERSONA);
    assert.match(html, new RegExp(`data-editor-intent="${intent}"`));
    intentCounts[intent] += 1;
  }
  for (const [intent, count] of Object.entries(intentCounts)) {
    assert.equal(count, 1, `fixture must exercise the ${intent} intent`);
  }
});
