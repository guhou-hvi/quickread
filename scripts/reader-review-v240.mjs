import fs from "node:fs/promises";
import path from "node:path";

import {
  fidelityReaderLeaves,
  readerLeafIndex,
  sha256Text,
  sha256Value,
} from "./review-contract.mjs";

export const LITE_REVIEW_POLICY_VERSION = "2.4.0";
export const LITE_REVIEW_SCHEMA_VERSION = "1.0.0";
export const LITE_REVIEW_ROLES = Object.freeze(["source_scout", "fidelity", "reader_advocate"]);
export const LITE_REVIEW_DELTA_SCHEMA_VERSION = "1.0.0";
export const LITE_REVIEW_CHANGE_KINDS = Object.freeze([
  "text",
  "evidence_refs",
  "citation_refs",
  "provenance",
]);
export const LITE_REVIEW_HASH_KEYS = Object.freeze([
  "segments",
  "evidence",
  "deepRead",
  "readerMap",
  "research",
  "readerMarkdown",
]);

const CONCRETE_HARD_ERROR_CODES = new Set([
  "unsupported",
  "contradicted",
  "fabricated",
  "misattributed",
  "wrong_provenance",
  "invalid_citation",
  "core_omission",
  "corrupt_artifact",
  "reference_error",
]);

const DIAGNOSTIC_ONLY_CODES = new Set([
  "coverage",
  "recall",
  "length",
  "score",
  "paragraph_count",
  "list_share",
]);

const FIDELITY_HARD_CODE_ALIASES = new Map([
  ["invalid_evidence_mapping", "unsupported"],
  ["unsupported_speaker_view", "unsupported"],
  ["wrong_provenance", "wrong_provenance"],
  ["misattributed_detail", "misattributed"],
]);

const AUDITABLE_READER_PROVENANCES = new Set(["source_fact", "speaker_view", "external", "editorial"]);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function referenceFreeLeaf(leaf) {
  return {
    id: leaf.id,
    text: leaf.text,
    sectionId: leaf.sectionId,
    moduleId: leaf.moduleId,
    blockId: leaf.blockId,
    type: leaf.type,
  };
}

export function stripReaderReferences(markdown) {
  return String(markdown ?? "")
    .replace(/\[(?:E|R)\d{3,}(?:\s*[–-]\s*(?:E|R)?\d{3,})?(?:\s*,\s*(?:E|R)?\d{3,})*\]/gu, "")
    .replace(/<!--\s*(?:evidence|citations?):[\s\S]*?-->/giu, "")
    .replace(/[ \t]+$/gmu, "");
}

export function liteReviewInputHashes({ segments, evidence, deepRead, readerMap, research, readerMarkdown }) {
  return {
    segments: sha256Value(segments),
    evidence: sha256Value(evidence),
    deepRead: sha256Value(deepRead),
    readerMap: sha256Value(readerMap),
    research: sha256Value(research),
    readerMarkdown: sha256Text(readerMarkdown),
  };
}

export async function loadLiteReviewInputs(caseDir) {
  const [segments, evidence, deepRead, readerMap, research, readerMarkdown] = await Promise.all([
    readJsonl(path.join(caseDir, "work", "segments.jsonl")),
    readJsonl(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "output", "deep-read.json")),
    readJson(path.join(caseDir, "work", "reader-map.json")),
    readJson(path.join(caseDir, "work", "research.json")),
    fs.readFile(path.join(caseDir, "output", "deep-read.md"), "utf8"),
  ]);
  return {
    segments,
    evidence,
    deepRead,
    readerMap,
    research,
    readerMarkdown,
    inputHashes: liteReviewInputHashes({ segments, evidence, deepRead, readerMap, research, readerMarkdown }),
  };
}

export function liteReviewRoot(caseDir, reviewRound) {
  return path.join(caseDir, "work", "reviews", "2.4.0", "reader-first", `round-${String(reviewRound).padStart(2, "0")}`);
}

export async function latestCompletedLiteReviewRound(caseDir) {
  const root = path.join(caseDir, "work", "reviews", "2.4.0", "reader-first");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const rounds = entries
    .filter((entry) => entry.isDirectory() && /^round-\d+$/u.test(entry.name))
    .map((entry) => Number(entry.name.slice("round-".length)))
    .sort((left, right) => right - left);
  for (const reviewRound of rounds) {
    try {
      await fs.access(path.join(liteReviewRoot(caseDir, reviewRound), "consensus.json"));
      return reviewRound;
    } catch {
      // An incomplete newer round cannot conceal the latest completed review.
    }
  }
  throw new Error("缺少已完成的 2.4 读者审核 consensus。");
}

function assertAssignments(assignments) {
  const keys = Object.keys(assignments ?? {}).sort();
  const expected = [...LITE_REVIEW_ROLES].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`必须且只能分配 ${LITE_REVIEW_ROLES.join(", ")}。`);
  }
  const ids = LITE_REVIEW_ROLES.map((role) => String(assignments[role] ?? "").trim());
  if (ids.some((id) => !id)) throw new Error("每个 2.4 轻量审核角色都必须具有 reviewerId。");
  if (new Set(ids).size !== ids.length) throw new Error("2.4 轻量审核 reviewerId 必须唯一。");
}

function assertTargetedAssignments(assignments, requiredRoles, inheritedReviewerIds = []) {
  const roles = Object.keys(assignments ?? {}).sort();
  const expected = [...requiredRoles].sort();
  if (JSON.stringify(roles) !== JSON.stringify(expected)) {
    throw new Error(`本次定向审核必须且只能分配 ${expected.join(", ")}。`);
  }
  const ids = expected.map((role) => String(assignments[role] ?? "").trim());
  if (ids.some((id) => !id)) throw new Error("每个定向审核角色都必须具有 reviewerId。");
  if (new Set([...ids, ...inheritedReviewerIds]).size !== ids.length + inheritedReviewerIds.length) {
    throw new Error("定向审核必须使用与继承角色及彼此不同的新 reviewerId。");
  }
}

function packetPayload(role, inputs) {
  const allLeaves = [...readerLeafIndex(inputs.deepRead).values()];
  const strippedMarkdown = stripReaderReferences(inputs.readerMarkdown);
  if (role === "source_scout") {
    return {
      segments: inputs.segments,
      readerLeaves: allLeaves.map(referenceFreeLeaf),
      readerMarkdown: strippedMarkdown,
    };
  }
  if (role === "fidelity") {
    return {
      claims: inputs.evidence,
      segments: inputs.segments,
      readerLeaves: [...fidelityReaderLeaves(inputs.deepRead).values()],
      research: inputs.research,
    };
  }
  return {
    readerLeaves: allLeaves.map(referenceFreeLeaf),
    readerMarkdown: strippedMarkdown,
  };
}

function packetInstructions(role) {
  if (role === "source_scout") {
    return "只查会改变核心理解的完整、可恢复命题遗漏。单方候选只能作为 warning；不得用覆盖率、篇幅或分数制造 hard error。";
  }
  if (role === "fidelity") {
    return "只检查已发表内容中的编造、矛盾、错引、错归属、错误 provenance 与无效引用。轻微措辞差异和覆盖率不是 hard error。";
  }
  return "以普通读者身份检查重复、术语负担、背景不足和章节割裂。评分、篇幅和覆盖率只写入 diagnostics，不得作为 hard error。";
}

function readerLeafSnapshot(leaf) {
  return {
    id: leaf.id,
    text: leaf.text ?? "",
    evidenceRefs: [...new Set(leaf.evidenceRefs ?? [])].sort(),
    citationRefs: [...new Set(leaf.citationRefs ?? [])].sort(),
    sectionId: leaf.sectionId,
    moduleId: leaf.moduleId,
    blockId: leaf.blockId,
    type: leaf.type,
    provenance: leaf.provenance ?? null,
  };
}

function baseLeafSnapshots(validation) {
  if (validation.readerSnapshot?.readerLeaves) {
    return new Map(validation.readerSnapshot.readerLeaves.map((leaf) => [leaf.id, readerLeafSnapshot(leaf)]));
  }
  const snapshots = new Map();
  const sourcePacket = validation.effectivePackets?.get("source_scout") ?? validation.packets.get("source_scout");
  for (const leaf of sourcePacket?.payload?.readerLeaves ?? []) {
    snapshots.set(leaf.id, {
      ...readerLeafSnapshot(leaf),
      evidenceRefs: null,
      citationRefs: null,
      provenance: "__unavailable_in_base_packet__",
    });
  }
  const fidelityPacket = validation.effectivePackets?.get("fidelity") ?? validation.packets.get("fidelity");
  for (const leaf of fidelityPacket?.payload?.readerLeaves ?? []) {
    const current = snapshots.get(leaf.id) ?? {};
    snapshots.set(leaf.id, readerLeafSnapshot({ ...current, ...leaf }));
  }
  return snapshots;
}

function readerSnapshotFromInputs(caseId, inputs) {
  return {
    schemaVersion: "1.0.0",
    caseId,
    inputHashes: inputs.inputHashes,
    readerLeaves: [...readerLeafIndex(inputs.deepRead).values()].map(readerLeafSnapshot),
    strippedReaderMarkdown: stripReaderReferences(inputs.readerMarkdown),
  };
}

function appendOnlyResearchExtension(previous, current) {
  if (!previous || !current || previous.schemaVersion !== current.schemaVersion || previous.caseId !== current.caseId) return false;
  for (const key of ["citations", "checks", "background"]) {
    const before = Array.isArray(previous[key]) ? previous[key] : [];
    const afterHashes = new Set((Array.isArray(current[key]) ? current[key] : []).map((entry) => sha256Value(entry)));
    if (before.some((entry) => !afterHashes.has(sha256Value(entry)))) return false;
  }
  return true;
}

function reviewedResearchFromValidation(validation) {
  const packet = validation?.effectivePackets?.get("fidelity") ?? validation?.packets?.get("fidelity");
  return packet?.payload?.research ?? null;
}

function withoutParticipantGuideSurface(markdown) {
  return String(markdown ?? "")
    .replace(/\n##\s+\d+\.\s*人物导览[\s\S]*?(?=\n##\s+\d+\.|\n###\s+参考资料|$)/u, "\n")
    .replace(/\n###\s+参考资料[\s\S]*$/u, "")
    .trim();
}

function strippedMarkdownFromValidation(validation) {
  if (validation.readerSnapshot) return validation.readerSnapshot.strippedReaderMarkdown;
  const packet = validation.effectivePackets?.get("reader_advocate") ?? validation.packets.get("reader_advocate");
  return packet?.payload?.readerMarkdown ?? "";
}

function reconstructFlatReaderMap(caseId, leaves, evidence) {
  const claimById = new Map(evidence.map((claim) => [claim.id, claim]));
  const entries = [];
  for (const leaf of leaves.values()) for (const evidenceRef of leaf.evidenceRefs ?? []) {
    const claim = claimById.get(evidenceRef);
    if (!claim) throw new Error(`reader-map 重建引用未知 claim：${evidenceRef}。`);
    entries.push({
      evidenceRef,
      importance: claim.importance,
      presentation: "synthesized",
      coverageSpans: [{ readerBlockRef: leaf.id, readerTextQuote: leaf.text }],
    });
  }
  return { schemaVersion: "2.1.0", caseId, entries };
}

function canonicalReaderMapProjection(readerMap, { requireCanonical = false } = {}) {
  if (readerMap?.schemaVersion !== "2.1.0" || !String(readerMap?.caseId ?? "").trim() || !Array.isArray(readerMap?.entries)) {
    throw new Error("reader-map 必须是合法的 2.1.0 对象。");
  }
  const groups = new Map();
  for (const [index, entry] of readerMap.entries.entries()) {
    const evidenceRef = String(entry?.evidenceRef ?? "").trim();
    const importance = String(entry?.importance ?? "").trim();
    const presentation = String(entry?.presentation ?? "").trim();
    if (!evidenceRef || !importance || !presentation || !Array.isArray(entry?.coverageSpans)) {
      throw new Error(`reader-map.entries[${index}] 结构不完整。`);
    }
    if (!groups.has(evidenceRef)) groups.set(evidenceRef, { evidenceRef, importance, presentation, spans: new Map(), entryCount: 0 });
    const group = groups.get(evidenceRef);
    group.entryCount += 1;
    if (group.importance !== importance || group.presentation !== presentation) {
      throw new Error(`${evidenceRef} 的重复 reader-map 条目 importance/presentation 不一致。`);
    }
    for (const span of entry.coverageSpans) {
      const readerBlockRef = String(span?.readerBlockRef ?? "").trim();
      const readerTextQuote = String(span?.readerTextQuote ?? "");
      if (!readerBlockRef || !readerTextQuote) throw new Error(`${evidenceRef} 含不完整 coverageSpan。`);
      group.spans.set(`${readerBlockRef}\u0000${readerTextQuote}`, { readerBlockRef, readerTextQuote });
    }
  }
  if (requireCanonical && [...groups.values()].some((group) => group.entryCount !== 1)) {
    throw new Error("当前 reader-map 仍包含重复 evidenceRef 条目，尚未完成 canonicalization。");
  }
  return {
    schemaVersion: readerMap.schemaVersion,
    caseId: readerMap.caseId,
    entries: [...groups.values()]
      .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef))
      .map((group) => ({
        evidenceRef: group.evidenceRef,
        importance: group.importance,
        presentation: group.presentation,
        coverageSpans: [...group.spans.values()].sort((left, right) => (
          left.readerBlockRef.localeCompare(right.readerBlockRef)
          || left.readerTextQuote.localeCompare(right.readerTextQuote)
        )),
      })),
  };
}

function inheritedRoleRecords(baseValidation, roles) {
  return roles.map((role) => {
    const report = baseValidation.reports.get(role);
    const packet = baseValidation.effectivePackets?.get(role) ?? baseValidation.packets.get(role);
    return {
      role,
      reviewerId: report.reviewerId,
      baseRound: baseValidation.reviewRound,
      reportHash: sha256Value(report),
      packetHash: sha256Value(packet),
    };
  });
}

function sameStringArray(left, right) {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
}

function readerLeafChanges(baseLeaves, currentDeepRead) {
  const currentLeaves = new Map([...readerLeafIndex(currentDeepRead)].map(([id, leaf]) => [id, readerLeafSnapshot(leaf)]));
  const changes = [];
  const ids = [...new Set([...baseLeaves.keys(), ...currentLeaves.keys()])].sort();
  for (const id of ids) {
    const before = baseLeaves.get(id);
    const after = currentLeaves.get(id);
    if (!before || !after) {
      changes.push({ id, kinds: ["structure"], beforeHash: before ? sha256Value(before) : null, afterHash: after ? sha256Value(after) : null });
      continue;
    }
    const kinds = [];
    if (before.text !== after.text) kinds.push("text");
    if (before.evidenceRefs !== null && !sameStringArray(before.evidenceRefs, after.evidenceRefs)) kinds.push("evidence_refs");
    else if (before.evidenceRefs === null && after.evidenceRefs.length) kinds.push("evidence_refs");
    if (before.citationRefs !== null && !sameStringArray(before.citationRefs, after.citationRefs)) kinds.push("citation_refs");
    else if (before.citationRefs === null && after.citationRefs.length) kinds.push("citation_refs");
    if (before.provenance !== "__unavailable_in_base_packet__" && before.provenance !== after.provenance) kinds.push("provenance");
    else if (before.provenance === "__unavailable_in_base_packet__" && AUDITABLE_READER_PROVENANCES.has(after.provenance)) kinds.push("provenance");
    if (["sectionId", "moduleId", "blockId", "type"].some((key) => before[key] !== after[key])) kinds.push("structure");
    if (kinds.length) changes.push({ id, kinds, beforeHash: sha256Value(before), afterHash: sha256Value(after) });
  }
  return changes;
}

function normalizeDeclaredChanges(changes) {
  const byId = new Map();
  for (const change of changes ?? []) {
    const id = String(change.id ?? "").trim();
    if (!id) throw new Error("--change 必须包含 reader block id。");
    const kinds = [...new Set(change.kinds ?? [])].sort();
    if (!kinds.length || kinds.some((kind) => !LITE_REVIEW_CHANGE_KINDS.includes(kind))) {
      throw new Error(`${id} 的变化类型必须来自 ${LITE_REVIEW_CHANGE_KINDS.join(", ")}。`);
    }
    if (byId.has(id)) throw new Error(`重复声明 reader block：${id}。`);
    byId.set(id, { id, kinds });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function requiredRolesForChanges(changes, { strippedMarkdownChanged }) {
  const required = new Set();
  for (const change of changes) {
    if (change.kinds.some((kind) => ["text", "evidence_refs", "citation_refs", "provenance"].includes(kind))) required.add("fidelity");
    if (change.kinds.includes("text")) required.add("reader_advocate");
  }
  if (strippedMarkdownChanged) required.add("reader_advocate");
  return [...required].sort();
}

function targetedPacketPayload(role, inputs, changedIds) {
  const changedIdSet = new Set(changedIds);
  const allLeaves = [...readerLeafIndex(inputs.deepRead).values()];
  if (role === "fidelity") {
    const leaves = [...fidelityReaderLeaves(inputs.deepRead).values()].filter((leaf) => changedIdSet.has(leaf.id));
    const claimIds = new Set(leaves.flatMap((leaf) => leaf.evidenceRefs ?? []));
    return {
      claims: inputs.evidence.filter((claim) => claimIds.has(claim.id)),
      segments: inputs.segments,
      readerLeaves: leaves,
      research: inputs.research,
    };
  }
  if (role === "reader_advocate") {
    const leaves = allLeaves.filter((leaf) => changedIdSet.has(leaf.id)).map(referenceFreeLeaf);
    return {
      readerLeaves: leaves,
      readerMarkdown: leaves.map((leaf) => `${leaf.id}\n${leaf.text}`).join("\n\n"),
    };
  }
  throw new Error(`定向审核不应重新运行 ${role}。`);
}

function targetedPacketInstructions(role, changedIds) {
  const scope = changedIds.join(", ");
  if (role === "fidelity") {
    return `只复核已申报变化块 ${scope} 中的来源支持、归属、provenance 与引用。不得把未变化内容、覆盖率或轻微措辞差异作为 hard error。`;
  }
  return `只检查已申报变化块 ${scope} 的可读性及其局部衔接。不得重新审核全文，不得用评分或篇幅制造 hard error。`;
}

export async function prepareLiteReview(caseDir, options = {}) {
  if (options.readerMapMechanical) {
    return prepareReaderMapMechanicalReview(caseDir, options);
  }
  if (options.baseRound !== null && options.baseRound !== undefined) {
    return prepareTargetedLiteReview(caseDir, options);
  }
  const { reviewRound = 1, assignments } = options;
  if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new Error("reviewRound 必须为正整数。");
  assertAssignments(assignments);
  const inputs = await loadLiteReviewInputs(caseDir);
  const caseJson = await readJson(path.join(caseDir, "case.json"));
  const caseId = caseJson.id;
  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const packets = [];
  for (const role of LITE_REVIEW_ROLES) {
    const packetPath = `packets/${role}.json`;
    const outputPath = `reports/${role}.json`;
    const packetBase = {
      schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
      caseId,
      reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
      reviewRound,
      role,
      assignedReviewerId: assignments[role],
      inputHashes: inputs.inputHashes,
      outputPath,
      instructions: packetInstructions(role),
      outputContract: {
        schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
        reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
        requiredFields: ["$schema", "schemaVersion", "caseId", "reviewPolicyVersion", "reviewRound", "role", "reviewerId", "packetId", "inputHashes", "hardErrors", "warnings", "diagnostics", "summary"],
        findingRequiredFields: ["code", "message"],
        findingAllowedFields: ["code", "message", "findingKey", "readerBlockRef", "evidenceRefs", "value"],
        collectionTypes: { hardErrors: "array", warnings: "array", diagnostics: "array" },
        hardErrorPolicy: "Only concrete fidelity errors or a core omission independently confirmed by two roles can block.",
      },
      payload: packetPayload(role, inputs),
    };
    const packetId = sha256Value(packetBase);
    const packet = { ...packetBase, packetId };
    const packetHash = sha256Value(packet);
    await writeJson(path.join(reviewRoot, packetPath), packet);
    packets.push({ role, reviewerId: assignments[role], packetPath, outputPath, packetId, packetHash });
  }
  const manifest = {
    $schema: "../../../../../../../schemas/reader-review-v240-manifest.schema.json",
    schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
    caseId,
    reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
    reviewRound,
    gatePolicy: "concrete_hard_errors",
    inputHashes: inputs.inputHashes,
    artifacts: {
      segments: "work/segments.jsonl",
      evidence: "work/evidence.jsonl",
      deepRead: "output/deep-read.json",
      readerMap: "work/reader-map.json",
      research: "work/research.json",
      readerMarkdown: "output/deep-read.md",
    },
    packets,
    humanReviewRequired: true,
  };
  await writeJson(path.join(reviewRoot, "manifest.json"), manifest);
  return { reviewRoot, manifest, packets };
}

export async function prepareReaderMapMechanicalReview(caseDir, {
  reviewRound,
  baseRound,
  assignments = {},
} = {}) {
  if (!Number.isInteger(reviewRound) || !Number.isInteger(baseRound) || reviewRound <= baseRound) {
    throw new Error("reader-map 机械轮次 reviewRound 必须大于 baseRound。");
  }
  if (Object.keys(assignments).length) throw new Error("reader-map 机械轮次不得分配 Agent reviewer。");
  const baseValidation = await validateLiteReview(caseDir, baseRound, { requireReports: true, bindCurrent: false });
  if (baseValidation.errors.length) throw new Error(`基础轮次无效：${baseValidation.errors.join("；")}`);
  const baseConsensusPath = path.join(baseValidation.reviewRoot, "consensus.json");
  const baseConsensus = await readJson(baseConsensusPath);
  if (sha256Value(baseConsensus) !== sha256Value(liteReviewConsensusFromValidation(baseValidation))) {
    throw new Error("基础轮次 consensus 与不可变角色报告不一致。");
  }
  const inputs = await loadLiteReviewInputs(caseDir);
  const caseJson = await readJson(path.join(caseDir, "case.json"));
  for (const key of LITE_REVIEW_HASH_KEYS.filter((key) => key !== "readerMap")) {
    if (baseValidation.manifest.inputHashes?.[key] !== inputs.inputHashes[key]) {
      throw new Error(`reader-map 机械轮次不允许 ${key} 变化。`);
    }
  }
  if (baseValidation.manifest.inputHashes.readerMap === inputs.inputHashes.readerMap) {
    throw new Error("reader-map 未变化，无需创建机械轮次。");
  }
  // Every non-readerMap input is hash-identical to the base round at this point.
  // Use the current deep-read leaves because their evidenceRef order is part of the
  // original flat reader-map hash; the compact review snapshot intentionally sorts
  // refs for comparison and therefore cannot reproduce that historical array order.
  const reconstructedBefore = reconstructFlatReaderMap(caseJson.id, readerLeafIndex(inputs.deepRead), inputs.evidence);
  const reconstructedBeforeHash = sha256Value(reconstructedBefore);
  if (reconstructedBeforeHash !== baseValidation.manifest.inputHashes.readerMap) {
    throw new Error("无法从基础轮次的 reader leaves 精确重建旧 reader-map；不得机械继承审核。 ");
  }
  const beforeProjection = canonicalReaderMapProjection(reconstructedBefore);
  const currentProjection = canonicalReaderMapProjection(inputs.readerMap, { requireCanonical: true });
  if (sha256Value(beforeProjection) !== sha256Value(currentProjection)) {
    throw new Error("reader-map canonicalization 改变了 evidenceRef、importance、presentation、block 或 textQuote 语义映射。");
  }
  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const snapshot = readerSnapshotFromInputs(caseJson.id, inputs);
  const snapshotPath = "reader-snapshot.json";
  const beforeReaderMapPath = "reader-map-before.json";
  const currentReaderMapPath = "reader-map-current.json";
  await writeJson(path.join(reviewRoot, snapshotPath), snapshot);
  await writeJson(path.join(reviewRoot, beforeReaderMapPath), reconstructedBefore);
  await writeJson(path.join(reviewRoot, currentReaderMapPath), inputs.readerMap);
  const manifest = {
    $schema: "../../../../../../../schemas/reader-review-v240-reader-map-mechanical.schema.json",
    schemaVersion: "1.0.0",
    caseId: caseJson.id,
    reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
    reviewRound,
    reviewMode: "reader_map_mechanical",
    baseRound,
    gatePolicy: "concrete_hard_errors",
    base: {
      manifestHash: sha256Value(baseValidation.manifest),
      consensusHash: sha256Value(baseConsensus),
      inputHashes: baseValidation.manifest.inputHashes,
    },
    inputHashes: inputs.inputHashes,
    mechanicalProof: {
      operation: "merge_duplicate_evidence_entries",
      beforeReaderMapHash: baseValidation.manifest.inputHashes.readerMap,
      currentReaderMapHash: inputs.inputHashes.readerMap,
      reconstructedBeforeHash,
      canonicalSemanticHash: sha256Value(beforeProjection),
      beforeEntryCount: reconstructedBefore.entries.length,
      currentEntryCount: inputs.readerMap.entries.length,
      duplicateEntriesRemoved: reconstructedBefore.entries.length - inputs.readerMap.entries.length,
    },
    readerMaps: {
      before: { path: beforeReaderMapPath, hash: sha256Value(reconstructedBefore) },
      current: { path: currentReaderMapPath, hash: sha256Value(inputs.readerMap) },
    },
    readerSnapshot: { path: snapshotPath, hash: sha256Value(snapshot) },
    rerunRoles: [],
    inheritedRoles: [...LITE_REVIEW_ROLES],
    packets: [],
    inheritedReports: inheritedRoleRecords(baseValidation, LITE_REVIEW_ROLES),
    humanReviewRequired: true,
    repairAttemptConsumed: false,
  };
  if (manifest.mechanicalProof.duplicateEntriesRemoved <= 0) throw new Error("reader-map 机械轮次没有实际合并重复条目。");
  await writeJson(path.join(reviewRoot, "manifest.json"), manifest);
  return { reviewRoot, manifest, packets: [] };
}

export async function prepareTargetedLiteReview(caseDir, {
  reviewRound,
  baseRound,
  assignments,
  declaredChanges,
} = {}) {
  if (!Number.isInteger(reviewRound) || !Number.isInteger(baseRound) || reviewRound <= baseRound) {
    throw new Error("定向审核 reviewRound 必须大于 baseRound。");
  }
  const baseValidation = await validateLiteReview(caseDir, baseRound, { requireReports: true, bindCurrent: false });
  if (baseValidation.errors.length) throw new Error(`基础轮次无效：${baseValidation.errors.join("；")}`);
  const baseConsensusPath = path.join(baseValidation.reviewRoot, "consensus.json");
  const baseConsensus = await readJson(baseConsensusPath);
  const expectedBaseConsensus = liteReviewConsensusFromValidation(baseValidation);
  if (sha256Value(baseConsensus) !== sha256Value(expectedBaseConsensus)) throw new Error("基础轮次 consensus 与不可变角色报告不一致。");

  const inputs = await loadLiteReviewInputs(caseDir);
  const caseJson = await readJson(path.join(caseDir, "case.json"));
  const caseId = caseJson.id;
  for (const key of ["segments", "evidence", "research"]) {
    if (baseValidation.manifest.inputHashes?.[key] !== inputs.inputHashes[key]) {
      throw new Error(`定向读者审核不能处理 ${key} 变化；请使用对应 evidence/research 审核协议。`);
    }
  }
  const actualChanges = readerLeafChanges(baseLeafSnapshots(baseValidation), inputs.deepRead);
  if (!actualChanges.length) throw new Error("没有可供定向复核的 reader block 变化。");
  if (actualChanges.some((change) => change.kinds.includes("structure"))) {
    throw new Error("新增、删除、移动或改变 block 类型属于结构性变化，必须重新运行三个角色。");
  }
  const declared = normalizeDeclaredChanges(declaredChanges);
  const actualDeclaration = actualChanges.map(({ id, kinds }) => ({ id, kinds: [...kinds].sort() }));
  if (JSON.stringify(declared) !== JSON.stringify(actualDeclaration)) {
    throw new Error(`申报变化与实际 reader block 差异不一致。实际为：${actualDeclaration.map((item) => `${item.id}:${item.kinds.join(",")}`).join("；")}`);
  }
  const baseStrippedMarkdown = strippedMarkdownFromValidation(baseValidation);
  const currentStrippedMarkdown = stripReaderReferences(inputs.readerMarkdown);
  const strippedMarkdownChanged = sha256Text(baseStrippedMarkdown) !== sha256Text(currentStrippedMarkdown);
  const requiredRoles = requiredRolesForChanges(actualChanges, { strippedMarkdownChanged });
  const inheritedRoles = LITE_REVIEW_ROLES.filter((role) => !requiredRoles.includes(role));
  const inheritedReviewerIds = inheritedRoles.map((role) => baseValidation.reports.get(role)?.reviewerId).filter(Boolean);
  assertTargetedAssignments(assignments, requiredRoles, inheritedReviewerIds);

  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const snapshot = readerSnapshotFromInputs(caseId, inputs);
  const snapshotPath = "reader-snapshot.json";
  await writeJson(path.join(reviewRoot, snapshotPath), snapshot);
  const snapshotHash = sha256Value(snapshot);
  const changedIds = actualChanges.map((change) => change.id);
  const packets = [];
  for (const role of requiredRoles) {
    const packetPath = `packets/${role}.json`;
    const outputPath = `reports/${role}.json`;
    const packetBase = {
      schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
      caseId,
      reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
      reviewRound,
      role,
      assignedReviewerId: assignments[role],
      inputHashes: inputs.inputHashes,
      outputPath,
      instructions: targetedPacketInstructions(role, changedIds),
      reviewScope: { mode: "targeted_delta", baseRound, readerBlockIds: changedIds },
      outputContract: {
        schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
        reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
        requiredFields: ["$schema", "schemaVersion", "caseId", "reviewPolicyVersion", "reviewRound", "role", "reviewerId", "packetId", "inputHashes", "hardErrors", "warnings", "diagnostics", "summary"],
        findingRequiredFields: ["code", "message"],
        findingAllowedFields: ["code", "message", "findingKey", "readerBlockRef", "evidenceRefs", "value"],
        collectionTypes: { hardErrors: "array", warnings: "array", diagnostics: "array" },
        hardErrorPolicy: "Only concrete fidelity errors or a core omission independently confirmed by two roles can block.",
      },
      payload: targetedPacketPayload(role, inputs, changedIds),
    };
    const packetId = sha256Value(packetBase);
    const packet = { ...packetBase, packetId };
    const packetHash = sha256Value(packet);
    await writeJson(path.join(reviewRoot, packetPath), packet);
    packets.push({ role, reviewerId: assignments[role], packetPath, outputPath, packetId, packetHash });
  }
  const inheritedReports = inheritedRoles.map((role) => {
    const report = baseValidation.reports.get(role);
    const packet = baseValidation.effectivePackets?.get(role) ?? baseValidation.packets.get(role);
    return {
      role,
      reviewerId: report.reviewerId,
      baseRound,
      reportHash: sha256Value(report),
      packetHash: sha256Value(packet),
    };
  });
  const manifest = {
    $schema: "../../../../../../../schemas/reader-review-v240-delta-manifest.schema.json",
    schemaVersion: LITE_REVIEW_DELTA_SCHEMA_VERSION,
    caseId,
    reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
    reviewRound,
    reviewMode: "targeted_delta",
    baseRound,
    gatePolicy: "concrete_hard_errors",
    base: {
      manifestHash: sha256Value(baseValidation.manifest),
      consensusHash: sha256Value(baseConsensus),
      inputHashes: baseValidation.manifest.inputHashes,
    },
    inputHashes: inputs.inputHashes,
    changeSet: {
      changedReaderBlocks: actualChanges,
      strippedMarkdownChanged,
      readerMapChanged: baseValidation.manifest.inputHashes.readerMap !== inputs.inputHashes.readerMap,
      deepReadChanged: baseValidation.manifest.inputHashes.deepRead !== inputs.inputHashes.deepRead,
      readerMarkdownChanged: baseValidation.manifest.inputHashes.readerMarkdown !== inputs.inputHashes.readerMarkdown,
    },
    readerSnapshot: { path: snapshotPath, hash: snapshotHash },
    rerunRoles: requiredRoles,
    inheritedRoles,
    packets,
    inheritedReports,
    humanReviewRequired: true,
  };
  await writeJson(path.join(reviewRoot, "manifest.json"), manifest);
  return { reviewRoot, manifest, packets };
}

function sameKeys(actual, expected) {
  return JSON.stringify(Object.keys(actual ?? {}).sort()) === JSON.stringify([...expected].sort());
}

function withinRoot(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function packetAllowedPayloadKeys(role) {
  if (role === "source_scout") return ["segments", "readerLeaves", "readerMarkdown"];
  if (role === "fidelity") return ["claims", "segments", "readerLeaves", "research"];
  return ["readerLeaves", "readerMarkdown"];
}

function findingErrors(finding, { role, leafIds, claimIds, label }) {
  const errors = [];
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return [`${label} 必须为对象。`];
  if (!String(finding.code ?? "").trim()) errors.push(`${label}.code 缺失。`);
  if (!String(finding.message ?? "").trim()) errors.push(`${label}.message 缺失。`);
  const allowedKeys = ["code", "message", "findingKey", "readerBlockRef", "evidenceRefs", "value"];
  if (!sameKeys(finding, Object.keys(finding).filter((key) => allowedKeys.includes(key)))) errors.push(`${label} 含非法字段。`);
  for (const key of Object.keys(finding)) if (!allowedKeys.includes(key)) errors.push(`${label} 含非法字段 ${key}。`);
  if (finding.readerBlockRef && !leafIds.has(finding.readerBlockRef)) errors.push(`${label}.readerBlockRef 越过 packet 边界。`);
  for (const ref of finding.evidenceRefs ?? []) {
    if (role !== "fidelity" || !claimIds.has(ref)) errors.push(`${label}.evidenceRefs 含 packet 外引用 ${ref}。`);
  }
  return errors;
}

async function validateFullLiteReview(caseDir, reviewRound, { requireReports = true, bindCurrent = true } = {}) {
  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const errors = [];
  const manifest = await readJson(path.join(reviewRoot, "manifest.json"));
  const inputs = await loadLiteReviewInputs(caseDir);
  const caseJson = await readJson(path.join(caseDir, "case.json"));
  if (manifest.schemaVersion !== LITE_REVIEW_SCHEMA_VERSION) errors.push("2.4 轻量审核 manifest schemaVersion 不一致。");
  if (manifest.reviewPolicyVersion !== LITE_REVIEW_POLICY_VERSION) errors.push("2.4 轻量审核 reviewPolicyVersion 不一致。");
  if (manifest.caseId !== caseJson.id) errors.push("2.4 轻量审核 manifest caseId 不一致。");
  if (manifest.reviewRound !== reviewRound) errors.push("2.4 轻量审核 manifest reviewRound 不一致。");
  if (manifest.gatePolicy !== "concrete_hard_errors") errors.push("2.4 轻量审核 gatePolicy 非法。");
  if (!sameKeys(manifest.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push("2.4 inputHashes 必须恰好绑定六项输入，且不得包含 brief。");
  if (bindCurrent) for (const key of LITE_REVIEW_HASH_KEYS) {
    if (manifest.inputHashes?.[key] !== inputs.inputHashes[key]) errors.push(`2.4 轻量审核 inputHashes.${key} 已过期。`);
  }
  if (Object.hasOwn(manifest.inputHashes ?? {}, "brief") || Object.hasOwn(manifest.artifacts ?? {}, "brief")) {
    errors.push("2.4 轻量审核不得绑定尚未生成的 brief。");
  }

  const entries = Array.isArray(manifest.packets) ? manifest.packets : [];
  const roles = entries.map((entry) => entry.role);
  if (JSON.stringify([...roles].sort()) !== JSON.stringify([...LITE_REVIEW_ROLES].sort())) errors.push("2.4 轻量审核必须恰好包含三个隔离角色。");
  const reviewerIds = entries.map((entry) => entry.reviewerId);
  if (reviewerIds.some((id) => !id) || new Set(reviewerIds).size !== reviewerIds.length) errors.push("2.4 轻量审核 reviewerId 缺失或重复。");

  const packets = new Map();
  const reports = new Map();
  for (const entry of entries) {
    if (!withinRoot(reviewRoot, entry.packetPath)) {
      errors.push(`${entry.role} packetPath 越过 review root。`);
      continue;
    }
    if (!withinRoot(reviewRoot, entry.outputPath)) errors.push(`${entry.role} outputPath 越过 review root。`);
    let packet;
    try {
      packet = await readJson(path.join(reviewRoot, entry.packetPath));
    } catch (error) {
      errors.push(`${entry.role} packet 无法读取：${error.message}`);
      continue;
    }
    packets.set(entry.role, packet);
    if (sha256Value(packet) !== entry.packetHash) errors.push(`${entry.role} packet hash 已过期或被改写。`);
    const { packetId: recordedPacketId, ...packetBase } = packet;
    if (sha256Value(packetBase) !== recordedPacketId) errors.push(`${entry.role} packetId 不能由当前 packet 重建。`);
    if (packet.packetId !== entry.packetId) errors.push(`${entry.role} packetId 不一致。`);
    if (packet.role !== entry.role || packet.assignedReviewerId !== entry.reviewerId) errors.push(`${entry.role} packet 身份与 manifest 不一致。`);
    if (packet.outputPath !== entry.outputPath) errors.push(`${entry.role} packet outputPath 与 manifest 不一致。`);
    if (!packet.outputContract || packet.outputContract.hardErrorPolicy !== "Only concrete fidelity errors or a core omission independently confirmed by two roles can block.") errors.push(`${entry.role} packet 缺少固定 output contract。`);
    if (!sameKeys(packet.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push(`${entry.role} packet 输入哈希集合非法。`);
    for (const key of LITE_REVIEW_HASH_KEYS) if (packet.inputHashes?.[key] !== manifest.inputHashes?.[key]) errors.push(`${entry.role} packet inputHashes.${key} 不一致。`);
    if (!sameKeys(packet.payload, packetAllowedPayloadKeys(entry.role))) errors.push(`${entry.role} packet payload 越过角色边界。`);

    if (!requireReports) continue;
    if (!withinRoot(reviewRoot, entry.outputPath)) continue;
    let report;
    try {
      report = await readJson(path.join(reviewRoot, entry.outputPath));
    } catch (error) {
      errors.push(`${entry.role} 报告缺失或无法读取：${error.message}`);
      continue;
    }
    reports.set(entry.role, report);
    const requiredReportKeys = ["$schema", "schemaVersion", "caseId", "reviewPolicyVersion", "reviewRound", "role", "reviewerId", "packetId", "inputHashes", "hardErrors", "warnings", "diagnostics", "summary"];
    const allowedReportKeys = [...requiredReportKeys, "packetHash"];
    if (requiredReportKeys.some((key) => !Object.hasOwn(report, key)) || Object.keys(report).some((key) => !allowedReportKeys.includes(key))) {
      errors.push(`${entry.role} 报告含缺失或越界字段。`);
    }
    if (report.schemaVersion !== LITE_REVIEW_SCHEMA_VERSION || report.reviewPolicyVersion !== LITE_REVIEW_POLICY_VERSION) errors.push(`${entry.role} 报告版本非法。`);
    if (report.caseId !== manifest.caseId || report.reviewRound !== reviewRound) errors.push(`${entry.role} 报告案例或轮次不一致。`);
    if (report.role !== entry.role || report.reviewerId !== entry.reviewerId) errors.push(`${entry.role} 报告不是 packet 指定 reviewer 生成。`);
    if (report.packetId !== entry.packetId || (report.packetHash && report.packetHash !== entry.packetHash)) errors.push(`${entry.role} 报告未绑定指定 packet。`);
    if (!sameKeys(report.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push(`${entry.role} 报告输入哈希集合非法。`);
    for (const key of LITE_REVIEW_HASH_KEYS) if (report.inputHashes?.[key] !== manifest.inputHashes?.[key]) errors.push(`${entry.role} 报告 inputHashes.${key} 已过期。`);
    if (!String(report.summary ?? "").trim()) errors.push(`${entry.role} 报告 summary 缺失。`);
    for (const key of ["hardErrors", "warnings", "diagnostics"]) if (!Array.isArray(report[key])) errors.push(`${entry.role} 报告 ${key} 必须为数组。`);
    const leafIds = new Set((packet.payload?.readerLeaves ?? []).map((leaf) => leaf.id));
    const claimIds = new Set((packet.payload?.claims ?? []).map((claim) => claim.id));
    for (const key of ["hardErrors", "warnings", "diagnostics"]) {
      for (const [index, finding] of (Array.isArray(report[key]) ? report[key] : []).entries()) {
        errors.push(...findingErrors(finding, { role: entry.role, leafIds, claimIds, label: `${entry.role}.${key}[${index}]` }));
      }
    }
  }
  const reportIds = [...reports.values()].map((report) => report.reviewerId);
  if (new Set(reportIds).size !== reportIds.length) errors.push("2.4 轻量审核报告 reviewerId 必须唯一。");
  return {
    caseId: manifest.caseId,
    reviewRound,
    reviewRoot,
    manifest,
    packets,
    effectivePackets: packets,
    reports,
    inputs,
    errors: [...new Set(errors)],
  };
}

async function validateTargetedLiteReview(caseDir, reviewRound, { requireReports = true, bindCurrent = true } = {}) {
  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const errors = [];
  const manifest = await readJson(path.join(reviewRoot, "manifest.json"));
  const inputs = await loadLiteReviewInputs(caseDir);
  const caseJson = await readJson(path.join(caseDir, "case.json"));
  if (manifest.schemaVersion !== LITE_REVIEW_DELTA_SCHEMA_VERSION) errors.push("2.4 定向审核 manifest schemaVersion 不一致。");
  if (manifest.reviewMode !== "targeted_delta") errors.push("2.4 定向审核 reviewMode 非法。");
  if (manifest.reviewPolicyVersion !== LITE_REVIEW_POLICY_VERSION) errors.push("2.4 定向审核 reviewPolicyVersion 不一致。");
  if (manifest.caseId !== caseJson.id || manifest.reviewRound !== reviewRound) errors.push("2.4 定向审核案例或轮次不一致。");
  if (!Number.isInteger(manifest.baseRound) || manifest.baseRound < 1 || manifest.baseRound >= reviewRound) errors.push("2.4 定向审核 baseRound 非法。");
  if (manifest.gatePolicy !== "concrete_hard_errors") errors.push("2.4 定向审核 gatePolicy 非法。");
  if (!sameKeys(manifest.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push("2.4 定向审核 inputHashes 集合非法。");
  const researchHashChanged = manifest.inputHashes?.research !== inputs.inputHashes.research;
  const readerMarkdownHashChanged = manifest.inputHashes?.readerMarkdown !== inputs.inputHashes.readerMarkdown;
  if (bindCurrent) for (const key of LITE_REVIEW_HASH_KEYS) {
    if (!["research", "readerMarkdown"].includes(key) && manifest.inputHashes?.[key] !== inputs.inputHashes[key]) errors.push(`2.4 定向审核 inputHashes.${key} 已过期。`);
  }

  let baseValidation;
  let baseConsensus;
  let participantOnlyResearchExtension = false;
  try {
    baseValidation = await validateLiteReview(caseDir, manifest.baseRound, { requireReports: true, bindCurrent: false });
    errors.push(...baseValidation.errors.map((error) => `基础轮次：${error}`));
    baseConsensus = await readJson(path.join(baseValidation.reviewRoot, "consensus.json"));
    const expected = liteReviewConsensusFromValidation(baseValidation);
    if (sha256Value(baseConsensus) !== sha256Value(expected)) errors.push("基础轮次 consensus 与角色报告不一致。");
    if (manifest.base?.manifestHash !== sha256Value(baseValidation.manifest)) errors.push("基础轮次 manifest hash 已过期。");
    if (manifest.base?.consensusHash !== sha256Value(baseConsensus)) errors.push("基础轮次 consensus hash 已过期。");
    if (JSON.stringify(manifest.base?.inputHashes ?? {}) !== JSON.stringify(baseValidation.manifest.inputHashes ?? {})) errors.push("基础轮次 inputHashes 绑定不一致。");
    participantOnlyResearchExtension = researchHashChanged
      && appendOnlyResearchExtension(reviewedResearchFromValidation(baseValidation), inputs.research);
    if (bindCurrent && researchHashChanged && !participantOnlyResearchExtension) {
      errors.push("2.4 定向审核 inputHashes.research 已过期。");
    }
  } catch (error) {
    errors.push(`基础轮次无法验证：${error.message}`);
  }

  let readerSnapshot;
  try {
    if (!withinRoot(reviewRoot, manifest.readerSnapshot?.path)) throw new Error("reader snapshot 路径越界");
    readerSnapshot = await readJson(path.join(reviewRoot, manifest.readerSnapshot.path));
    if (sha256Value(readerSnapshot) !== manifest.readerSnapshot.hash) errors.push("reader snapshot hash 已过期。");
    if (readerSnapshot.caseId !== manifest.caseId) errors.push("reader snapshot caseId 不一致。");
    if (bindCurrent) {
      const currentSnapshot = readerSnapshotFromInputs(manifest.caseId, inputs);
      let participantSurfaceOnly = false;
      if (readerMarkdownHashChanged && participantOnlyResearchExtension
        && sha256Value(currentSnapshot.readerLeaves) === sha256Value(readerSnapshot.readerLeaves)
        && withoutParticipantGuideSurface(currentSnapshot.strippedReaderMarkdown)
          === withoutParticipantGuideSurface(readerSnapshot.strippedReaderMarkdown)) {
        try {
          const participantReview = await readJson(path.join(caseDir, "work", "reviews", "2.4.0", "participant-guide", "review.json"));
          participantSurfaceOnly = participantReview.caseId === manifest.caseId
            && participantReview.reviewPolicyVersion === "2.4.0"
            && participantReview.status === "pass"
            && !(participantReview.hardErrors ?? []).length;
        } catch {
          participantSurfaceOnly = false;
        }
      }
      if (readerMarkdownHashChanged && !participantSurfaceOnly) errors.push("2.4 定向审核 inputHashes.readerMarkdown 已过期。");
      if (participantOnlyResearchExtension) currentSnapshot.inputHashes.research = manifest.inputHashes.research;
      if (participantSurfaceOnly) {
        currentSnapshot.inputHashes.readerMarkdown = manifest.inputHashes.readerMarkdown;
        currentSnapshot.strippedReaderMarkdown = readerSnapshot.strippedReaderMarkdown;
      }
      if (sha256Value(currentSnapshot) !== sha256Value(readerSnapshot)) errors.push("reader snapshot 与当前读者稿不一致。");
    }
  } catch (error) {
    errors.push(`reader snapshot 无法验证：${error.message}`);
  }

  let actualChanges = [];
  if (baseValidation) {
    for (const key of ["segments", "evidence", "research"]) {
      if (baseValidation.manifest.inputHashes?.[key] !== manifest.inputHashes?.[key]) errors.push(`定向审核夹带未允许的 ${key} 变化。`);
    }
    if (readerSnapshot?.readerLeaves) {
      const currentMap = new Map(readerSnapshot.readerLeaves.map((leaf) => [leaf.id, readerLeafSnapshot(leaf)]));
      actualChanges = [];
      const baseMap = baseLeafSnapshots(baseValidation);
      const ids = [...new Set([...baseMap.keys(), ...currentMap.keys()])].sort();
      for (const id of ids) {
        const before = baseMap.get(id);
        const after = currentMap.get(id);
        if (!before || !after) {
          actualChanges.push({ id, kinds: ["structure"], beforeHash: before ? sha256Value(before) : null, afterHash: after ? sha256Value(after) : null });
          continue;
        }
        const kinds = [];
        if (before.text !== after.text) kinds.push("text");
        if (before.evidenceRefs !== null && !sameStringArray(before.evidenceRefs, after.evidenceRefs)) kinds.push("evidence_refs");
        else if (before.evidenceRefs === null && after.evidenceRefs.length) kinds.push("evidence_refs");
        if (before.citationRefs !== null && !sameStringArray(before.citationRefs, after.citationRefs)) kinds.push("citation_refs");
        else if (before.citationRefs === null && after.citationRefs.length) kinds.push("citation_refs");
        if (before.provenance !== "__unavailable_in_base_packet__" && before.provenance !== after.provenance) kinds.push("provenance");
        else if (before.provenance === "__unavailable_in_base_packet__" && AUDITABLE_READER_PROVENANCES.has(after.provenance)) kinds.push("provenance");
        if (["sectionId", "moduleId", "blockId", "type"].some((key) => before[key] !== after[key])) kinds.push("structure");
        if (kinds.length) actualChanges.push({ id, kinds, beforeHash: sha256Value(before), afterHash: sha256Value(after) });
      }
    } else {
      actualChanges = readerLeafChanges(baseLeafSnapshots(baseValidation), inputs.deepRead);
    }
    const recordedChanges = manifest.changeSet?.changedReaderBlocks ?? [];
    if (JSON.stringify(recordedChanges) !== JSON.stringify(actualChanges)) errors.push("定向审核 changeSet 未完整、精确绑定实际 reader block 变化。");
    if (actualChanges.some((change) => change.kinds.includes("structure"))) errors.push("定向审核不得包含结构性 reader block 变化。");
    const baseStripped = strippedMarkdownFromValidation(baseValidation);
    const currentStripped = readerSnapshot?.strippedReaderMarkdown ?? stripReaderReferences(inputs.readerMarkdown);
    const strippedChanged = sha256Text(baseStripped) !== sha256Text(currentStripped);
    if (manifest.changeSet?.strippedMarkdownChanged !== strippedChanged) errors.push("定向审核 strippedMarkdownChanged 记录不准确。");
    const flags = {
      readerMapChanged: baseValidation.manifest.inputHashes.readerMap !== manifest.inputHashes.readerMap,
      deepReadChanged: baseValidation.manifest.inputHashes.deepRead !== manifest.inputHashes.deepRead,
      readerMarkdownChanged: baseValidation.manifest.inputHashes.readerMarkdown !== manifest.inputHashes.readerMarkdown,
    };
    for (const [key, value] of Object.entries(flags)) if (manifest.changeSet?.[key] !== value) errors.push(`定向审核 ${key} 记录不准确。`);
    if (!flags.deepReadChanged || actualChanges.length === 0) errors.push("定向审核必须对应明确的 deep-read reader block 变化。");
  }

  const requiredRoles = requiredRolesForChanges(actualChanges, { strippedMarkdownChanged: Boolean(manifest.changeSet?.strippedMarkdownChanged) });
  const inheritedRoles = LITE_REVIEW_ROLES.filter((role) => !requiredRoles.includes(role));
  if (JSON.stringify([...(manifest.rerunRoles ?? [])].sort()) !== JSON.stringify(requiredRoles)) errors.push("定向审核 rerunRoles 与实际变化不一致。");
  if (JSON.stringify([...(manifest.inheritedRoles ?? [])].sort()) !== JSON.stringify(inheritedRoles.sort())) errors.push("定向审核 inheritedRoles 与实际变化不一致。");

  const entries = Array.isArray(manifest.packets) ? manifest.packets : [];
  if (JSON.stringify(entries.map((entry) => entry.role).sort()) !== JSON.stringify(requiredRoles)) errors.push("定向审核 packets 必须恰好覆盖 rerunRoles。");
  const packets = new Map();
  const reports = new Map();
  const effectivePackets = new Map();
  if (baseValidation) {
    for (const role of inheritedRoles) {
      const baseReport = baseValidation.reports.get(role);
      const basePacket = baseValidation.effectivePackets?.get(role) ?? baseValidation.packets.get(role);
      const record = (manifest.inheritedReports ?? []).find((item) => item.role === role);
      if (!record || record.baseRound !== manifest.baseRound || record.reviewerId !== baseReport?.reviewerId) errors.push(`${role} 继承报告身份不一致。`);
      if (record?.reportHash !== sha256Value(baseReport)) errors.push(`${role} 继承报告 hash 已过期。`);
      if (record?.packetHash !== sha256Value(basePacket)) errors.push(`${role} 继承 packet hash 已过期。`);
      if (baseReport) reports.set(role, baseReport);
      if (basePacket) effectivePackets.set(role, basePacket);
    }
  }
  if ((manifest.inheritedReports ?? []).length !== inheritedRoles.length) errors.push("定向审核 inheritedReports 数量不一致。");

  for (const entry of entries) {
    if (!withinRoot(reviewRoot, entry.packetPath) || !withinRoot(reviewRoot, entry.outputPath)) {
      errors.push(`${entry.role} packet/report 路径越过 review root。`);
      continue;
    }
    let packet;
    try {
      packet = await readJson(path.join(reviewRoot, entry.packetPath));
    } catch (error) {
      errors.push(`${entry.role} packet 无法读取：${error.message}`);
      continue;
    }
    packets.set(entry.role, packet);
    effectivePackets.set(entry.role, packet);
    const { packetId: recordedPacketId, ...packetBase } = packet;
    if (sha256Value(packet) !== entry.packetHash || sha256Value(packetBase) !== recordedPacketId || recordedPacketId !== entry.packetId) errors.push(`${entry.role} packet hash/packetId 已过期。`);
    if (packet.role !== entry.role || packet.assignedReviewerId !== entry.reviewerId || packet.outputPath !== entry.outputPath) errors.push(`${entry.role} packet 身份不一致。`);
    if (packet.reviewScope?.mode !== "targeted_delta" || packet.reviewScope?.baseRound !== manifest.baseRound) errors.push(`${entry.role} packet 缺少定向范围。`);
    const changedIds = actualChanges.map((change) => change.id);
    if (JSON.stringify([...(packet.reviewScope?.readerBlockIds ?? [])].sort()) !== JSON.stringify([...changedIds].sort())) errors.push(`${entry.role} packet readerBlockIds 范围不完整。`);
    if (!sameKeys(packet.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push(`${entry.role} packet 输入哈希集合非法。`);
    for (const key of LITE_REVIEW_HASH_KEYS) if (packet.inputHashes?.[key] !== manifest.inputHashes?.[key]) errors.push(`${entry.role} packet inputHashes.${key} 不一致。`);
    if (!sameKeys(packet.payload, packetAllowedPayloadKeys(entry.role))) errors.push(`${entry.role} packet payload 越过角色边界。`);
    const payloadLeafIds = new Set((packet.payload?.readerLeaves ?? []).map((leaf) => leaf.id));
    if ([...payloadLeafIds].some((id) => !changedIds.includes(id)) || changedIds.some((id) => !payloadLeafIds.has(id))) errors.push(`${entry.role} packet readerLeaves 未严格限制在变化块。`);

    if (!requireReports) continue;
    let report;
    try {
      report = await readJson(path.join(reviewRoot, entry.outputPath));
    } catch (error) {
      errors.push(`${entry.role} 报告缺失或无法读取：${error.message}`);
      continue;
    }
    reports.set(entry.role, report);
    const requiredReportKeys = ["$schema", "schemaVersion", "caseId", "reviewPolicyVersion", "reviewRound", "role", "reviewerId", "packetId", "inputHashes", "hardErrors", "warnings", "diagnostics", "summary"];
    const allowedReportKeys = [...requiredReportKeys, "packetHash"];
    if (requiredReportKeys.some((key) => !Object.hasOwn(report, key)) || Object.keys(report).some((key) => !allowedReportKeys.includes(key))) errors.push(`${entry.role} 报告含缺失或越界字段。`);
    if (report.schemaVersion !== LITE_REVIEW_SCHEMA_VERSION || report.reviewPolicyVersion !== LITE_REVIEW_POLICY_VERSION) errors.push(`${entry.role} 报告版本非法。`);
    if (report.caseId !== manifest.caseId || report.reviewRound !== reviewRound || report.role !== entry.role || report.reviewerId !== entry.reviewerId) errors.push(`${entry.role} 报告身份或轮次不一致。`);
    if (report.packetId !== entry.packetId || (report.packetHash && report.packetHash !== entry.packetHash)) errors.push(`${entry.role} 报告未绑定指定 packet。`);
    if (!sameKeys(report.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push(`${entry.role} 报告输入哈希集合非法。`);
    for (const key of LITE_REVIEW_HASH_KEYS) if (report.inputHashes?.[key] !== manifest.inputHashes?.[key]) errors.push(`${entry.role} 报告 inputHashes.${key} 已过期。`);
    if (!String(report.summary ?? "").trim()) errors.push(`${entry.role} 报告 summary 缺失。`);
    for (const key of ["hardErrors", "warnings", "diagnostics"]) if (!Array.isArray(report[key])) errors.push(`${entry.role} 报告 ${key} 必须为数组。`);
    const claimIds = new Set((packet.payload?.claims ?? []).map((claim) => claim.id));
    for (const key of ["hardErrors", "warnings", "diagnostics"]) {
      for (const [index, finding] of (Array.isArray(report[key]) ? report[key] : []).entries()) {
        errors.push(...findingErrors(finding, { role: entry.role, leafIds: payloadLeafIds, claimIds, label: `${entry.role}.${key}[${index}]` }));
      }
    }
  }
  const allReviewerIds = [...reports.values()].map((report) => report.reviewerId);
  if (allReviewerIds.some((id) => !id) || new Set(allReviewerIds).size !== allReviewerIds.length) errors.push("定向审核的继承与新 reviewerId 必须全部唯一。");
  return {
    caseId: manifest.caseId,
    reviewRound,
    reviewRoot,
    manifest,
    packets,
    effectivePackets,
    reports,
    inputs,
    readerSnapshot,
    baseValidation,
    errors: [...new Set(errors)],
  };
}

async function validateReaderMapMechanicalReview(caseDir, reviewRound, { requireReports = true, bindCurrent = true } = {}) {
  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const errors = [];
  const manifest = await readJson(path.join(reviewRoot, "manifest.json"));
  const inputs = await loadLiteReviewInputs(caseDir);
  const caseJson = await readJson(path.join(caseDir, "case.json"));
  if (manifest.schemaVersion !== "1.0.0" || manifest.reviewMode !== "reader_map_mechanical") errors.push("reader-map 机械审核 manifest 版本或模式非法。");
  if (manifest.reviewPolicyVersion !== LITE_REVIEW_POLICY_VERSION || manifest.caseId !== caseJson.id || manifest.reviewRound !== reviewRound) errors.push("reader-map 机械审核案例、策略或轮次不一致。");
  if (!Number.isInteger(manifest.baseRound) || manifest.baseRound < 1 || manifest.baseRound >= reviewRound) errors.push("reader-map 机械审核 baseRound 非法。");
  if (manifest.gatePolicy !== "concrete_hard_errors" || manifest.repairAttemptConsumed !== false) errors.push("reader-map 机械审核 gate/repairAttempt 声明非法。");
  if ((manifest.packets ?? []).length || (manifest.rerunRoles ?? []).length) errors.push("reader-map 机械审核不得生成 Agent packet 或 rerun role。");
  if (JSON.stringify([...(manifest.inheritedRoles ?? [])].sort()) !== JSON.stringify([...LITE_REVIEW_ROLES].sort())) errors.push("reader-map 机械审核必须继承全部三个角色。");
  if (!sameKeys(manifest.inputHashes, LITE_REVIEW_HASH_KEYS)) errors.push("reader-map 机械审核 inputHashes 集合非法。");
  if (bindCurrent) for (const key of LITE_REVIEW_HASH_KEYS) {
    if (manifest.inputHashes?.[key] !== inputs.inputHashes[key]) errors.push(`reader-map 机械审核 inputHashes.${key} 已过期。`);
  }

  let baseValidation;
  try {
    // Inherited reports are part of the mechanical proof even when callers only
    // ask to validate the new round's packet surface (which is intentionally empty).
    baseValidation = await validateLiteReview(caseDir, manifest.baseRound, { requireReports: true, bindCurrent: false });
    errors.push(...baseValidation.errors.map((error) => `基础轮次：${error}`));
    const baseConsensus = await readJson(path.join(baseValidation.reviewRoot, "consensus.json"));
    if (sha256Value(baseConsensus) !== sha256Value(liteReviewConsensusFromValidation(baseValidation))) errors.push("基础轮次 consensus 与角色报告不一致。");
    if (manifest.base?.manifestHash !== sha256Value(baseValidation.manifest)) errors.push("基础轮次 manifest hash 已过期。");
    if (manifest.base?.consensusHash !== sha256Value(baseConsensus)) errors.push("基础轮次 consensus hash 已过期。");
    if (JSON.stringify(manifest.base?.inputHashes ?? {}) !== JSON.stringify(baseValidation.manifest.inputHashes ?? {})) errors.push("基础轮次 inputHashes 绑定不一致。");
  } catch (error) {
    errors.push(`基础轮次无法验证：${error.message}`);
  }

  let beforeReaderMap;
  let currentReaderMap;
  for (const [label, record] of [["before", manifest.readerMaps?.before], ["current", manifest.readerMaps?.current]]) {
    try {
      if (!withinRoot(reviewRoot, record?.path)) throw new Error("路径越界");
      const value = await readJson(path.join(reviewRoot, record.path));
      if (sha256Value(value) !== record.hash) errors.push(`reader-map ${label} snapshot hash 已过期。`);
      if (label === "before") beforeReaderMap = value;
      else currentReaderMap = value;
    } catch (error) {
      errors.push(`reader-map ${label} snapshot 无法验证：${error.message}`);
    }
  }
  let readerSnapshot;
  try {
    if (!withinRoot(reviewRoot, manifest.readerSnapshot?.path)) throw new Error("reader snapshot 路径越界");
    readerSnapshot = await readJson(path.join(reviewRoot, manifest.readerSnapshot.path));
    if (sha256Value(readerSnapshot) !== manifest.readerSnapshot.hash) errors.push("reader snapshot hash 已过期。");
    if (bindCurrent && sha256Value(readerSnapshotFromInputs(manifest.caseId, inputs)) !== sha256Value(readerSnapshot)) errors.push("reader snapshot 与当前读者稿不一致。");
  } catch (error) {
    errors.push(`reader snapshot 无法验证：${error.message}`);
  }

  if (baseValidation && beforeReaderMap && currentReaderMap) {
    for (const key of LITE_REVIEW_HASH_KEYS.filter((key) => key !== "readerMap")) {
      if (baseValidation.manifest.inputHashes?.[key] !== manifest.inputHashes?.[key]) errors.push(`reader-map 机械审核夹带 ${key} 变化。`);
    }
    if (sha256Value(beforeReaderMap) !== baseValidation.manifest.inputHashes.readerMap) errors.push("before reader-map 未绑定基础轮次 readerMap hash。");
    if (sha256Value(currentReaderMap) !== manifest.inputHashes.readerMap) errors.push("current reader-map 未绑定机械轮次 readerMap hash。");
    if (bindCurrent && sha256Value(currentReaderMap) !== inputs.inputHashes.readerMap) errors.push("current reader-map 与工作区不一致。");
    try {
      const beforeProjection = canonicalReaderMapProjection(beforeReaderMap);
      const currentProjection = canonicalReaderMapProjection(currentReaderMap, { requireCanonical: true });
      if (sha256Value(beforeProjection) !== sha256Value(currentProjection)) errors.push("reader-map canonical 语义投影不等价。");
      const expectedProof = {
        operation: "merge_duplicate_evidence_entries",
        beforeReaderMapHash: sha256Value(beforeReaderMap),
        currentReaderMapHash: sha256Value(currentReaderMap),
        reconstructedBeforeHash: sha256Value(beforeReaderMap),
        canonicalSemanticHash: sha256Value(beforeProjection),
        beforeEntryCount: beforeReaderMap.entries.length,
        currentEntryCount: currentReaderMap.entries.length,
        duplicateEntriesRemoved: beforeReaderMap.entries.length - currentReaderMap.entries.length,
      };
      if (JSON.stringify(manifest.mechanicalProof) !== JSON.stringify(expectedProof)) errors.push("reader-map mechanicalProof 与实际变化不一致。");
      if (expectedProof.duplicateEntriesRemoved <= 0) errors.push("reader-map 机械审核没有合并重复条目。");
    } catch (error) {
      errors.push(`reader-map canonicalization 证明失败：${error.message}`);
    }
  }

  const reports = new Map();
  const effectivePackets = new Map();
  if (baseValidation) for (const role of LITE_REVIEW_ROLES) {
    const baseReport = baseValidation.reports.get(role);
    const basePacket = baseValidation.effectivePackets?.get(role) ?? baseValidation.packets.get(role);
    const record = (manifest.inheritedReports ?? []).find((item) => item.role === role);
    if (!record || record.baseRound !== manifest.baseRound || record.reviewerId !== baseReport?.reviewerId) errors.push(`${role} 继承报告身份不一致。`);
    if (record?.reportHash !== sha256Value(baseReport)) errors.push(`${role} 继承报告 hash 已过期。`);
    if (record?.packetHash !== sha256Value(basePacket)) errors.push(`${role} 继承 packet hash 已过期。`);
    if (baseReport) reports.set(role, baseReport);
    if (basePacket) effectivePackets.set(role, basePacket);
  }
  if ((manifest.inheritedReports ?? []).length !== LITE_REVIEW_ROLES.length) errors.push("reader-map 机械审核 inheritedReports 数量不一致。");
  return {
    caseId: manifest.caseId,
    reviewRound,
    reviewRoot,
    manifest,
    packets: new Map(),
    effectivePackets,
    reports,
    inputs,
    readerSnapshot,
    baseValidation,
    errors: [...new Set(errors)],
  };
}

export async function validateLiteReview(caseDir, reviewRound, options = {}) {
  const reviewRoot = liteReviewRoot(caseDir, reviewRound);
  const manifest = await readJson(path.join(reviewRoot, "manifest.json"));
  if (manifest.reviewMode === "targeted_delta") return validateTargetedLiteReview(caseDir, reviewRound, options);
  if (manifest.reviewMode === "reader_map_mechanical") return validateReaderMapMechanicalReview(caseDir, reviewRound, options);
  return validateFullLiteReview(caseDir, reviewRound, options);
}

function normalizedFinding(finding, role, severity) {
  return { ...finding, role, severity };
}

function normalizedHardCode(code) {
  const normalized = String(code ?? "").trim().toLowerCase().replace(/[\s-]+/gu, "_");
  return FIDELITY_HARD_CODE_ALIASES.get(normalized) ?? normalized;
}

function findingWithNormalizedCode(finding) {
  const code = normalizedHardCode(finding.code);
  return code === finding.code ? finding : { ...finding, code, originalCode: finding.code };
}

export function liteReviewConsensusFromValidation(validation) {
  if (validation.errors.length) {
    return {
      schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
      caseId: validation.caseId,
      reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
      reviewRound: validation.reviewRound,
      status: "invalid",
      gatePolicy: "concrete_hard_errors",
      inputHashes: validation.manifest?.inputHashes ?? {},
      hardErrors: validation.errors.map((message) => ({ code: "schema_error", message, role: "system", severity: "hard" })),
      warnings: [],
      diagnostics: [],
      humanReviewRequired: true,
    };
  }
  const hardErrors = [];
  const warnings = [];
  const diagnostics = [];
  const omissionCandidates = [];
  for (const [role, report] of validation.reports) {
    for (const finding of report.diagnostics ?? []) diagnostics.push(normalizedFinding(finding, role, "diagnostic"));
    for (const finding of report.warnings ?? []) warnings.push(normalizedFinding(finding, role, "warning"));
    for (const finding of report.hardErrors ?? []) {
      const canonicalFinding = findingWithNormalizedCode(finding);
      if (canonicalFinding.code === "core_omission") {
        omissionCandidates.push(normalizedFinding(canonicalFinding, role, "candidate"));
      } else if (DIAGNOSTIC_ONLY_CODES.has(canonicalFinding.code)) {
        diagnostics.push({ ...normalizedFinding(canonicalFinding, role, "diagnostic"), demotedFromHard: true });
      } else if (role !== "fidelity") {
        warnings.push({ ...normalizedFinding(canonicalFinding, role, "warning"), demotedFromHard: true });
      } else if (!CONCRETE_HARD_ERROR_CODES.has(canonicalFinding.code)) {
        hardErrors.push({
          ...normalizedFinding(canonicalFinding, role, "hard"),
          code: "unknown_hard_error",
          reportedCode: finding.code,
          message: `Fidelity 报告使用未知 hard error code ${finding.code}：${finding.message}`,
        });
      } else {
        hardErrors.push(normalizedFinding(canonicalFinding, role, "hard"));
      }
    }
  }
  const omissionGroups = new Map();
  for (const finding of omissionCandidates) {
    const key = String(finding.findingKey ?? "").trim();
    if (!key) {
      warnings.push({ ...finding, code: "core_omission_candidate", severity: "warning", demotedFromHard: true });
      continue;
    }
    if (!omissionGroups.has(key)) omissionGroups.set(key, []);
    omissionGroups.get(key).push(finding);
  }
  for (const [findingKey, findings] of omissionGroups) {
    const roles = [...new Set(findings.map((finding) => finding.role))];
    if (roles.length >= 2) {
      hardErrors.push({
        code: "core_omission",
        findingKey,
        message: findings[0].message,
        confirmedByRoles: roles,
        severity: "hard",
      });
    } else {
      warnings.push({ ...findings[0], code: "core_omission_candidate", severity: "warning", demotedFromHard: true });
    }
  }
  return {
    $schema: "../../../../../../../schemas/reader-review-v240-consensus.schema.json",
    schemaVersion: LITE_REVIEW_SCHEMA_VERSION,
    caseId: validation.caseId,
    reviewPolicyVersion: LITE_REVIEW_POLICY_VERSION,
    reviewRound: validation.reviewRound,
    status: hardErrors.length ? "blocked" : (warnings.length ? "pass_with_warnings" : "pass"),
    gatePolicy: "concrete_hard_errors",
    inputHashes: validation.manifest.inputHashes,
    reviewerIds: Object.fromEntries([...validation.reports].map(([role, report]) => [role, report.reviewerId])),
    hardErrors,
    warnings,
    diagnostics,
    humanReviewRequired: true,
  };
}

export async function computeLiteReviewConsensus(caseDir, reviewRound, { write = true, bindCurrent = true } = {}) {
  const validation = await validateLiteReview(caseDir, reviewRound, { requireReports: true, bindCurrent });
  const consensus = liteReviewConsensusFromValidation(validation);
  if (write && !validation.errors.length) await writeJson(path.join(validation.reviewRoot, "consensus.json"), consensus);
  return { validation, consensus };
}

export function parseLiteReviewCli(argv, { requireAssignments = false } = {}) {
  const args = [...argv];
  const caseDir = args.shift();
  if (!caseDir) throw new Error("缺少案例路径。");
  let reviewRound = 1;
  let baseRound = null;
  let historical = false;
  let readerMapMechanical = false;
  const assignments = {};
  const declaredChanges = [];
  while (args.length) {
    const flag = args.shift();
    if (flag === "--round") reviewRound = Number(args.shift());
    else if (flag === "--base-round") baseRound = Number(args.shift());
    else if (flag === "--historical") historical = true;
    else if (flag === "--reader-map-mechanical") readerMapMechanical = true;
    else if (flag === "--change") {
      const [id, ...kindParts] = String(args.shift() ?? "").split(":");
      declaredChanges.push({ id, kinds: kindParts.join(":").split(",").filter(Boolean) });
    }
    else if (flag === "--assign") {
      const [role, ...rest] = String(args.shift() ?? "").split("=");
      assignments[role] = rest.join("=");
    } else throw new Error(`未知参数：${flag}`);
  }
  if (requireAssignments && readerMapMechanical && Object.keys(assignments).length) throw new Error("reader-map 机械轮次不得分配 Agent。");
  if (requireAssignments && !readerMapMechanical && baseRound === null) assertAssignments(assignments);
  if (requireAssignments && !readerMapMechanical && baseRound !== null && Object.keys(assignments).length === 0) throw new Error("定向审核至少需要分配一个受影响角色。");
  return { caseDir: path.resolve(caseDir), reviewRound, baseRound, historical, readerMapMechanical, assignments, declaredChanges };
}
