import fs from "node:fs/promises";
import path from "node:path";

import {
  isMain,
  readJson,
  readJsonLines,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";
import {
  contextGuideCitationRefs,
  contextGuideEntryMap,
  contextGuideEvidenceRefs,
  renderContextGuideMarkdown,
  renderContextInlineMarkdown,
} from "./context-guide.mjs";
import { sha256Value } from "./review-contract.mjs";

const POLICY_VERSION = "2.4.2";
const REQUIRED_ROLES = Object.freeze(["external_citation", "fidelity", "reader_advocate"]);

function reviewRoot(caseDir, policyVersion = POLICY_VERSION) {
  return path.join(caseDir, "work", "reviews", policyVersion, "context-guide");
}

function withinRoot(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function selectedResearch(guide, research) {
  const ids = new Set(contextGuideCitationRefs(guide));
  return (research.citations ?? []).filter((citation) => ids.has(citation.id));
}

function selectedEvidence(guide, claims) {
  const ids = new Set(contextGuideEvidenceRefs(guide));
  return claims.filter((claim) => ids.has(claim.id));
}

export function contextGuideExternalSurface(guide) {
  return {
    schemaVersion: guide.schemaVersion,
    caseId: guide.caseId,
    verifiedAt: guide.verifiedAt,
    entries: (guide.entries ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      externalStatements: [
        ["inlineDefinition", entry.inlineDefinition],
        ["background", entry.background],
        ["relevance", entry.relevance],
      ].filter(([, statement]) => statement?.provenance === "external")
        .map(([field, statement]) => ({ field, statement })),
    })),
  };
}

export function contextGuideReaderSurfaces(deepRead, brief, readerMarkdown) {
  const deepPlacements = [];
  const deepPreviews = [];
  for (const section of deepRead.sections ?? []) {
    for (const module of section.modules ?? []) {
      for (const block of module.blocks ?? []) {
        if (block.type === "context_guide") deepPlacements.push({ sectionId: section.id, moduleId: module.id, blockId: block.id, entryRefs: block.entryRefs });
        for (const node of [...(block.paragraphs ?? []), ...(block.items ?? [])]) {
          if (node.contextRefs?.length) deepPlacements.push({ sectionId: section.id, moduleId: module.id, blockId: node.id, text: node.text, contextRefs: node.contextRefs });
          if (node.contextPreviewRefs?.length) deepPreviews.push({ sectionId: section.id, moduleId: module.id, blockId: node.id, text: node.text, contextPreviewRefs: node.contextPreviewRefs });
        }
      }
    }
  }
  const briefPlacements = [];
  const briefPreviews = [];
  const briefTexts = [brief.summary];
  for (const section of brief.sections ?? []) {
    briefTexts.push(section.title, section.lead);
    const leadId = `${section.id}-lead`;
    if (section.contextRefs?.length) briefPlacements.push({ sectionId: section.id, blockId: leadId, text: section.lead, contextRefs: section.contextRefs });
    if (section.contextPreviewRefs?.length) briefPreviews.push({ sectionId: section.id, blockId: leadId, text: section.lead, contextPreviewRefs: section.contextPreviewRefs });
    for (const [blockIndex, block] of (section.blocks ?? []).entries()) {
      const blockId = block.id ?? `${section.id}-block-${blockIndex + 1}`;
      const blockText = [block.text, ...(block.items ?? []).map((item) => item?.text), ...(block.columns ?? []).flatMap((column) => [column?.title, ...(column?.items ?? []).map((item) => typeof item === "string" ? item : item?.text)])]
        .filter(Boolean).join(" ");
      briefTexts.push(block.title, blockText);
      if (block.contextRefs?.length) briefPlacements.push({ sectionId: section.id, blockId, text: blockText, contextRefs: block.contextRefs });
      if (block.contextPreviewRefs?.length) briefPreviews.push({ sectionId: section.id, blockId, text: blockText, contextPreviewRefs: block.contextPreviewRefs });
      for (const [itemIndex, item] of (block.items ?? []).entries()) {
        if (!item || typeof item !== "object") continue;
        if (item.contextRefs?.length) briefPlacements.push({ sectionId: section.id, blockId, itemId: item.id ?? `${blockId}-item-${itemIndex + 1}`, text: item.text ?? null, contextRefs: item.contextRefs });
        if (item.contextPreviewRefs?.length) briefPreviews.push({ sectionId: section.id, blockId, itemId: item.id ?? `${blockId}-item-${itemIndex + 1}`, text: item.text ?? null, contextPreviewRefs: item.contextPreviewRefs });
      }
      for (const [columnIndex, column] of (block.columns ?? []).entries()) {
        if (!column || typeof column !== "object") continue;
        if (column.contextRefs?.length) briefPlacements.push({
          sectionId: section.id,
          blockId,
          columnId: column.id ?? `${blockId}-column-${columnIndex + 1}`,
          text: [column.title, ...(column.items ?? []).map((item) => typeof item === "string" ? item : item?.text)].filter(Boolean).join(" "),
          contextRefs: column.contextRefs,
        });
        if (column.contextPreviewRefs?.length) briefPreviews.push({
          sectionId: section.id,
          blockId,
          columnId: column.id ?? `${blockId}-column-${columnIndex + 1}`,
          text: [column.title, ...(column.items ?? []).map((item) => typeof item === "string" ? item : item?.text)].filter(Boolean).join(" "),
          contextPreviewRefs: column.contextPreviewRefs,
        });
        for (const [itemIndex, item] of (column.items ?? []).entries()) {
          if (!item || typeof item !== "object") continue;
          if (item.contextRefs?.length) briefPlacements.push({ sectionId: section.id, blockId, itemId: item.id ?? `${blockId}-column-${columnIndex + 1}-item-${itemIndex + 1}`, text: item.text ?? null, contextRefs: item.contextRefs });
          if (item.contextPreviewRefs?.length) briefPreviews.push({ sectionId: section.id, blockId, itemId: item.id ?? `${blockId}-column-${columnIndex + 1}-item-${itemIndex + 1}`, text: item.text ?? null, contextPreviewRefs: item.contextPreviewRefs });
        }
      }
    }
  }
  return {
    readerMarkdown,
    deepPlacements,
    briefGuide: brief.contextGuide ?? null,
    briefPlacements,
    briefText: briefTexts.filter(Boolean).join("\n"),
    ...(deepPreviews.length ? { deepPreviews } : {}),
    ...(briefPreviews.length ? { briefPreviews } : {}),
  };
}

async function roleInputs(caseDir) {
  const [guide, research, claims, deepRead, brief, readerMarkdown] = await Promise.all([
    readJson(path.join(caseDir, "work", "context-guide.json")),
    readJson(path.join(caseDir, "work", "research.json")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "output", "deep-read.json")),
    readJson(path.join(caseDir, "output", "brief.json")),
    fs.readFile(path.join(caseDir, "output", "deep-read.md"), "utf8"),
  ]);
  const citations = selectedResearch(guide, research);
  const evidence = selectedEvidence(guide, claims);
  const surfaces = contextGuideReaderSurfaces(deepRead, brief, readerMarkdown);
  if (deepRead.schemaVersion === "2.4.0") {
    surfaces.renderedGuideMarkdown = renderContextGuideMarkdown(guide);
  } else {
    const entryMap = contextGuideEntryMap(guide);
    surfaces.renderedInlineMarkdown = surfaces.deepPlacements
      .flatMap((placement) => placement.contextRefs ?? [])
      .map((ref) => entryMap.get(ref))
      .filter(Boolean)
      .map((entry) => renderContextInlineMarkdown(entry, { detailed: true }));
  }
  const externalSurface = contextGuideExternalSurface(guide);
  const placements = {
    deep: surfaces.deepPlacements,
    brief: surfaces.briefPlacements,
    ...(surfaces.deepPreviews?.length ? { deepPreviews: surfaces.deepPreviews } : {}),
    ...(surfaces.briefPreviews?.length ? { briefPreviews: surfaces.briefPreviews } : {}),
  };
  return {
    external_citation: {
      payload: { contextGuideExternalBackgrounds: externalSurface, citations },
      inputHashes: { contextGuideExternalBackgrounds: sha256Value(externalSurface), citedResearch: sha256Value(citations) },
    },
    fidelity: {
      payload: { contextGuide: guide, evidence, citations, placements },
      inputHashes: {
        contextGuide: sha256Value(guide),
        citedEvidence: sha256Value(evidence),
        citedResearch: sha256Value(citations),
        placements: sha256Value({ deep: surfaces.deepPlacements, brief: surfaces.briefPlacements }),
      },
    },
    reader_advocate: {
      payload: { contextGuide: guide, readerSurfaces: surfaces },
      inputHashes: { contextGuide: sha256Value(guide), readerSurfaces: sha256Value(surfaces) },
    },
  };
}

export async function contextGuideReviewRoleInputHashes(caseDir) {
  const inputs = await roleInputs(caseDir);
  return Object.fromEntries(REQUIRED_ROLES.map((role) => [role, inputs[role].inputHashes]));
}

function roleInstructions(role) {
  if (role === "external_citation") return "只核验 Context Guide 外部背景是否被 packet 内引用直接支持、是否混入推测或时点错置。普通措辞偏好只能作为 warning。";
  if (role === "fidelity") return "检查名词定义和本期作用是否分别忠实对应引用的 evidence/citation，是否把背景冒充嘉宾观点，或实质改写人物立场。只报告具体错误。";
  return "以普通读者身份检查名词是否在首次实质出现后就地解释、三部分是否简洁有用；重点发现残留卷首术语总表、定义过晚、重复解释、连续背景注形成名词墙、与正文脱节或把人物塞进名词导览。不要按数量或篇幅判定失败。";
}

export async function prepareContextGuideReview(caseDir, assignments) {
  const root = reviewRoot(caseDir);
  const [manifest, inputs] = await Promise.all([readJson(path.join(caseDir, "case.json")), roleInputs(caseDir)]);
  const ids = Object.fromEntries(REQUIRED_ROLES.map((role) => [role, String(assignments?.[role] ?? "").trim()]));
  if (REQUIRED_ROLES.some((role) => !ids[role]) || new Set(Object.values(ids)).size !== REQUIRED_ROLES.length) {
    throw new Error("Context Guide 审核必须为 external_citation、fidelity、reader_advocate 分配三个不同 reviewerId。");
  }
  const packets = [];
  for (const role of REQUIRED_ROLES) {
    const suffix = sha256Value({ role, reviewerId: ids[role], inputHashes: inputs[role].inputHashes }).slice(0, 12);
    const packetPath = `packets/${role}-${suffix}.json`;
    const outputPath = `reports/${role}-${suffix}.json`;
    const base = {
      schemaVersion: "1.0.0",
      caseId: manifest.id,
      reviewPolicyVersion: POLICY_VERSION,
      role,
      assignedReviewerId: ids[role],
      inputHashes: inputs[role].inputHashes,
      outputPath,
      instructions: roleInstructions(role),
      outputContract: {
        requiredFields: ["schemaVersion", "caseId", "reviewPolicyVersion", "role", "reviewerId", "packetId", "packetHash", "inputHashes", "status", "hardErrors", "warnings", "summary"],
        status: "pass | fail",
        hardErrors: "string[]：每项是一条可定位的具体错误；没有则为空数组",
        warnings: "string[]：每项是一条非阻断建议；没有则为空数组",
      },
      payload: inputs[role].payload,
    };
    const packetId = sha256Value(base);
    const packetWithoutHash = { ...base, packetId };
    const packetHash = sha256Value(packetWithoutHash);
    const packet = { ...packetWithoutHash, packetHash };
    await writeJson(path.join(root, packetPath), packet);
    packets.push({ role, reviewerId: ids[role], packetPath, outputPath, packetId, packetHash, inputHashes: inputs[role].inputHashes });
  }
  const reviewManifest = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: POLICY_VERSION,
    roleInputHashes: Object.fromEntries(REQUIRED_ROLES.map((role) => [role, inputs[role].inputHashes])),
    packets,
  };
  await writeJson(path.join(root, "manifest.json"), reviewManifest);
  return { root, manifest: reviewManifest };
}

export async function validateContextGuideReview(caseDir, { policyVersion = POLICY_VERSION } = {}) {
  const root = reviewRoot(caseDir, policyVersion);
  const manifest = await readJson(path.join(root, "manifest.json"));
  const currentHashes = await contextGuideReviewRoleInputHashes(caseDir);
  const errors = [];
  const reports = [];
  if (manifest.caseId !== path.basename(caseDir) || manifest.reviewPolicyVersion !== policyVersion) errors.push("Context Guide 审核 manifest 的 caseId 或版本不一致。");
  const reviewerIds = new Set();
  for (const role of REQUIRED_ROLES) {
    if (sha256Value(manifest.roleInputHashes?.[role]) !== sha256Value(currentHashes[role])) errors.push(`Context Guide ${role} 输入已过期。`);
    const entry = manifest.packets?.find((candidate) => candidate.role === role);
    if (!entry) { errors.push(`Context Guide 审核缺少 ${role}。`); continue; }
    if (!withinRoot(root, entry.packetPath) || !withinRoot(root, entry.outputPath)) { errors.push(`${role} packet/report 路径越界。`); continue; }
    const packet = await readJson(path.join(root, entry.packetPath));
    const report = await readJson(path.join(root, entry.outputPath));
    reports.push(report);
    const { packetHash: declaredPacketHash, ...packetWithoutHash } = packet;
    if (declaredPacketHash !== entry.packetHash || sha256Value(packetWithoutHash) !== entry.packetHash || packet.packetId !== entry.packetId) {
      errors.push(`${role} packet 哈希已过期。`);
    }
    if (report.role !== role || report.reviewerId !== entry.reviewerId || report.packetId !== entry.packetId || report.packetHash !== entry.packetHash) errors.push(`${role} 报告身份或 packet 绑定错误。`);
    if (sha256Value(report.inputHashes) !== sha256Value(currentHashes[role])) errors.push(`${role} 报告输入已过期。`);
    if (!Array.isArray(report.hardErrors) || !report.hardErrors.every((item) => typeof item === "string")
      || !Array.isArray(report.warnings) || !report.warnings.every((item) => typeof item === "string")
      || !String(report.summary ?? "").trim()) errors.push(`${role} 报告结构不完整或 hardErrors/warnings 不是字符串数组。`);
    if (!['pass', 'fail'].includes(report.status)) errors.push(`${role} status 非法。`);
    if (reviewerIds.has(report.reviewerId)) errors.push("Context Guide reviewerId 必须相互独立。");
    reviewerIds.add(report.reviewerId);
  }
  return { errors: [...new Set(errors)], reports, manifest };
}

export async function recordContextGuideReview(caseDir, baselineReview) {
  const checked = await validateContextGuideReview(caseDir);
  if (checked.errors.length) throw new Error(checked.errors.join("\n"));
  const manifest = await readJson(path.join(caseDir, "case.json"));
  const reviewers = checked.reports.map(({ role, reviewerId, status, hardErrors, warnings, summary }) => ({ role, reviewerId, status, hardErrors, warnings, summary }));
  const hardErrors = [...new Set(reviewers.flatMap((reviewer) => reviewer.hardErrors ?? []))];
  const warnings = [...new Set(reviewers.flatMap((reviewer) => reviewer.warnings ?? []))];
  const record = {
    $schema: "../../../../../../schemas/context-guide-review.schema.json",
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    reviewPolicyVersion: POLICY_VERSION,
    reviewedAt: new Date().toISOString().slice(0, 10),
    baselineReview,
    roleInputHashes: await contextGuideReviewRoleInputHashes(caseDir),
    reviewers,
    hardErrors,
    warnings,
    status: hardErrors.length || reviewers.some((reviewer) => reviewer.status !== "pass") ? "fail" : "pass",
  };
  const outputPath = path.join(reviewRoot(caseDir), "review.json");
  await writeJson(outputPath, record);
  return { outputPath, record };
}

function assignmentsFromArgs(args) {
  return Object.fromEntries(args.filter((arg) => arg.includes("=")).map((arg) => arg.split("=", 2)));
}

if (isMain(import.meta.url)) {
  try {
    const [command, rawCase, ...args] = process.argv.slice(2);
    const caseDir = resolveCaseDir(rawCase);
    if (command === "prepare") {
      const result = await prepareContextGuideReview(caseDir, assignmentsFromArgs(args));
      console.log(JSON.stringify(result.manifest, null, 2));
    } else if (command === "validate") {
      const result = await validateContextGuideReview(caseDir);
      if (result.errors.length) throw new Error(result.errors.join("\n"));
      console.log("Context Guide 增量审核验证通过。");
    } else if (command === "record") {
      const baseline = args.find((arg) => arg.startsWith("baseline="))?.slice("baseline=".length);
      if (!baseline) throw new Error("record 需要 baseline=<历史审核路径>。");
      const result = await recordContextGuideReview(caseDir, baseline);
      console.log(JSON.stringify({ outputPath: result.outputPath, status: result.record.status }, null, 2));
    } else throw new Error("用法：context-guide-review.mjs prepare|validate|record <case> [role=id] [baseline=path]");
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
