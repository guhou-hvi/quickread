import path from "node:path";

import {
  isMain,
  readJson,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";

// These are editorial decisions, not occurrence-count heuristics. A `move` means
// the section lead already explains the term's role; `preview` means it only
// announces a later discussion and the existing inline note stays in place.
export const BRIEF_LEAD_CONTEXT_DECISIONS = Object.freeze({
  "QR-0002": Object.freeze({
    "falcon-9": Object.freeze({ sectionId: "prove-flight", action: "move" }),
    starlink: Object.freeze({ sectionId: "platform-and-boundaries", action: "move" }),
  }),
  "QR-0004": Object.freeze({
    minimax: Object.freeze({ sectionId: "chapter-1", action: "move" }),
  }),
  "QR-0008": Object.freeze({
    "compute-in-memory": Object.freeze({ sectionId: "edge-ai-and-chip", action: "move" }),
    "third-company": Object.freeze({ sectionId: "product-method-and-third-company", action: "move" }),
  }),
  "QR-0010": Object.freeze({
    cla: Object.freeze({ sectionId: "cla-platform", action: "move" }),
  }),
  "QR-0012": Object.freeze({
    gx: Object.freeze({ sectionId: "gx-and-company-boundary", action: "move" }),
  }),
  "QR-0013": Object.freeze({
    lean: Object.freeze({ sectionId: "contest-to-research", action: "move" }),
  }),
  "QR-0016": Object.freeze({
    openclaw: Object.freeze({ sectionId: "openclaw-framework-shift", action: "move" }),
    "post-training": Object.freeze({ sectionId: "agent-post-training", action: "move" }),
    "mimo-v2": Object.freeze({ sectionId: "model-and-compute-tradeoffs", action: "move" }),
  }),
  "QR-0017": Object.freeze({
    "world-model": Object.freeze({ sectionId: "world-model", action: "move" }),
  }),
  "QR-0022": Object.freeze({
    lovart: Object.freeze({ sectionId: "product-transition", action: "move" }),
  }),
  "QR-0023": Object.freeze({
    magi: Object.freeze({ sectionId: "routes-keep-changing", action: "preview" }),
    monica: Object.freeze({ sectionId: "observe-before-betting", action: "move" }),
    manus: Object.freeze({ sectionId: "cloud-async-general", action: "move" }),
  }),
  "QR-0025": Object.freeze({
    "social-contributions": Object.freeze({ sectionId: "wages-and-social-protection", action: "move" }),
    "pacte-dutreil": Object.freeze({ sectionId: "tax-and-transmission", action: "move" }),
  }),
});

function removeRef(value, property, ref) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) removeRef(item, property, ref);
    return;
  }
  if (Array.isArray(value[property])) {
    value[property] = value[property].filter((candidate) => candidate !== ref);
    if (!value[property].length) delete value[property];
  }
  for (const child of Object.values(value)) removeRef(child, property, ref);
}

function addUnique(node, property, ref) {
  node[property] = [...new Set([...(node[property] ?? []), ref])];
}

export function applyBriefLeadContextDecisions(brief, decisions) {
  for (const [ref, decision] of Object.entries(decisions ?? {})) {
    const section = (brief.sections ?? []).find((candidate) => candidate.id === decision.sectionId);
    if (!section) throw new Error(`找不到 brief section：${decision.sectionId}`);
    if (decision.action === "move") {
      removeRef(brief, "contextRefs", ref);
      removeRef(brief, "contextPreviewRefs", ref);
      addUnique(section, "contextRefs", ref);
    } else if (decision.action === "preview") {
      removeRef(brief, "contextPreviewRefs", ref);
      addUnique(section, "contextPreviewRefs", ref);
    } else {
      throw new Error(`未知 lead context action：${decision.action}`);
    }
  }
  return brief;
}

export async function relocateCaseBriefContext(caseDir) {
  const caseData = await readJson(path.join(caseDir, "case.json"));
  const decisions = BRIEF_LEAD_CONTEXT_DECISIONS[caseData.caseNumber];
  if (!decisions) return { caseNumber: caseData.caseNumber, changed: false };
  const briefPath = path.join(caseDir, "output", "brief.json");
  const brief = await readJson(briefPath);
  applyBriefLeadContextDecisions(brief, decisions);
  await writeJson(briefPath, brief);
  return { caseNumber: caseData.caseNumber, changed: true };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) throw new Error("请提供至少一个案例目录。此命令不会扫描未指定案例。");
    for (const rawCase of args) {
      const result = await relocateCaseBriefContext(resolveCaseDir(rawCase));
      console.log(`${result.caseNumber}: ${result.changed ? "已应用 section lead 名词决策" : "无已登记决策"}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
