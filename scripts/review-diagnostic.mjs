import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  readJson,
  readJsonLines,
  REPO_ROOT,
  sha256File,
  writeJson,
} from "./lib.mjs";
import {
  blindAlignmentContractErrors,
  blindCandidateContractErrors,
  blindRecallMetrics,
  fidelityReaderLeaves,
  fidelityReviewContractErrors,
  fidelityReviewGateFailures,
  repairRoundLimitForCase,
  sha256Value,
} from "./review-contract.mjs";

const DIAGNOSTIC_ROLES = Object.freeze(["blind_recall", "alignment", "fidelity", "repair_editor"]);
const HASH = /^[a-f0-9]{64}$/u;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function roundDirectory(round) {
  if (!Number.isInteger(round) || round < 1) throw new Error("repair diagnostic round 必须为正整数。");
  return `round-${String(round).padStart(2, "0")}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function relativeToCase(caseDir, filePath) {
  return toPosix(path.relative(caseDir, filePath));
}

function resolveInside(caseDir, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`${label} 必须为案例内相对路径。`);
  const resolved = path.resolve(caseDir, relativePath);
  const relative = path.relative(caseDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出案例目录。`);
  return resolved;
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assignmentMap(assignments) {
  const normalized = Object.fromEntries(DIAGNOSTIC_ROLES.map((role) => [role, String(assignments?.[role] ?? "").trim()]));
  const missing = DIAGNOSTIC_ROLES.filter((role) => normalized[role].length < 2);
  if (missing.length) throw new Error(`repair diagnostic 缺少 reviewer assignment：${missing.join("、")}`);
  if (new Set(Object.values(normalized)).size !== DIAGNOSTIC_ROLES.length) {
    throw new Error("repair diagnostic 的四个角色必须使用唯一 reviewerId。");
  }
  return normalized;
}

function roleResources(role) {
  const schemaPath = {
    blind_recall: "schemas/blind-candidate.schema.json",
    alignment: "schemas/blind-alignment.schema.json",
    fidelity: "schemas/fidelity-review.schema.json",
    repair_editor: "schemas/repair-log.schema.json",
  }[role];
  const promptPath = {
    blind_recall: "prompts/reviews/blind-recall.md",
    alignment: "prompts/reviews/alignment.md",
    fidelity: "prompts/reviews/fidelity.md",
    repair_editor: "prompts/reviews/repair-editor.md",
  }[role];
  if (!schemaPath || !promptPath) throw new Error(`不支持 diagnostic 角色：${role}`);
  return {
    schemaPath,
    contract: JSON.parse(readFileSync(path.join(REPO_ROOT, schemaPath), "utf8")),
    instructions: readFileSync(path.join(REPO_ROOT, promptPath), "utf8"),
  };
}

function sourceUnitsForClaim(claim, sourceById) {
  return {
    ...claim,
    supportSpans: (claim.supportSpans ?? []).map((span) => ({
      ...span,
      sourceUnits: (span.sourceIds ?? []).map((id) => sourceById.get(id)).filter(Boolean),
    })),
  };
}

function fidelityLeaves(deepRead, claims, normalized, research) {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  const citationById = new Map((research.citations ?? []).map((citation) => [citation.id, citation]));
  return [...fidelityReaderLeaves(deepRead).values()].map(({ blockId: _blockId, ...leaf }) => ({
    ...leaf,
    evidence: (leaf.evidenceRefs ?? []).map((id) => claimById.get(id)).filter(Boolean).map((claim) => sourceUnitsForClaim(claim, sourceById)),
    citations: (leaf.citationRefs ?? []).map((id) => citationById.get(id)).filter(Boolean),
    researchChecks: (research.checks ?? []).filter((check) => (leaf.citationRefs ?? []).some((id) => (check.citationRefs ?? []).includes(id))),
  }));
}

async function currentState(caseDir) {
  const [normalized, segments, claims, deepRead, readerMap, research] = await Promise.all([
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "output", "deep-read.json")),
    readJson(path.join(caseDir, "work", "reader-map.json")),
    readJson(path.join(caseDir, "work", "research.json")),
  ]);
  const optional = {};
  for (const [key, relative] of [["claimBundles", "work/claim-bundles.json"], ["themeMap", "work/theme-map.json"], ["evidenceMigration", "work/evidence-migration.json"]]) {
    const filePath = path.join(caseDir, relative);
    if (await exists(filePath)) optional[key] = await readJson(filePath);
  }
  const hashes = {
    segments: sha256Value(segments),
    evidence: sha256Value(claims),
    deepRead: sha256Value(deepRead),
    readerMap: sha256Value(readerMap),
    research: sha256Value(research),
    ...Object.fromEntries(Object.entries(optional).map(([key, value]) => [key, sha256Value(value)])),
  };
  return { normalized, segments, claims, deepRead, readerMap, research, ...optional, hashes };
}

function diagnosticRoot(caseDir, repairRound, hashes) {
  return path.join(
    caseDir,
    "work",
    "reviews",
    "2.2.0",
    "preflight",
    roundDirectory(repairRound),
    `repair-diagnostic-${sha256Value(hashes).slice(0, 12)}`,
  );
}

function packetBase(manifest, role, inputHashes, outputPath) {
  const resources = roleResources(role);
  return {
    schemaVersion: "1.0.0",
    caseId: manifest.caseId,
    workflowVersion: "2.2.0",
    reviewRound: manifest.repairRound,
    diagnosticKind: "repair_diagnostic",
    sourceReviewRound: manifest.sourceReviewRound,
    role,
    assignedReviewerId: manifest.assignments[role],
    inputHashes,
    output: { path: outputPath, schema: resources.schemaPath, contract: resources.contract, dependencies: {} },
    reviewInstructions: resources.instructions,
    inputPolicy: {
      isolation: "packet-only",
      instruction: "只读取本 packet 的 payload、reviewInstructions 与 output.contract；不得读取源轮次报告、正式 consensus、其他角色结果或作者覆盖声明。",
      forbidden: ["源 full round 报告", "正式 consensus", "其他 reviewer packet", "human-review.json"],
    },
  };
}

async function writePacket(root, role, packet) {
  const filePath = path.join(root, "packets", `${role}.json`);
  await writeJson(filePath, packet);
  return { path: filePath, sha256: await sha256File(filePath), ready: role !== "alignment" };
}

async function configuredPipeline(options) {
  return options.pipelineConfig ?? readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
}

export async function prepareRepairDiagnostic(caseDir, {
  repairRound,
  sourceRound,
  assignments,
  pipelineConfig,
} = {}) {
  if (!Number.isInteger(sourceRound) || sourceRound < 1 || !Number.isInteger(repairRound) || repairRound <= 2) {
    throw new Error("repair diagnostic 必须指定 source round，并且 repair round 必须大于全局默认两轮。");
  }
  if (sourceRound >= repairRound) throw new Error("source round 必须早于 repair diagnostic round。");
  const caseManifest = await readJson(path.join(caseDir, "case.json"));
  const pipeline = pipelineConfig ?? await configuredPipeline({});
  const limit = repairRoundLimitForCase(pipeline, caseManifest);
  if (repairRound > limit) throw new Error(`${caseManifest.caseNumber ?? caseManifest.id} 未授权第 ${repairRound} 轮修复；当前上限为 ${limit}。`);
  if ((pipeline.reviews?.maximumRepairRounds ?? 2) !== 2) throw new Error("repair diagnostic 要求全局默认修复上限保持为 2。");
  const assigned = assignmentMap(assignments);
  const sourceRoot = path.join(caseDir, "work", "reviews", "2.2.0", roundDirectory(sourceRound));
  const sourceManifestPath = path.join(sourceRoot, "manifest.json");
  if (!(await exists(sourceManifestPath))) throw new Error("指定的源 full round 不存在。");
  const sourceManifest = await readJson(sourceManifestPath);
  if (sourceManifest.caseId !== caseManifest.id || sourceManifest.reviewRound !== sourceRound) {
    throw new Error("源 full round manifest 的 caseId 或 reviewRound 不一致。");
  }
  const state = await currentState(caseDir);
  const staleKeys = Object.entries(state.hashes)
    .filter(([key, value]) => sourceManifest.inputHashes?.[key] && sourceManifest.inputHashes[key] !== value)
    .map(([key]) => key);
  if (!staleKeys.length) throw new Error("源 full round 未因当前输入哈希变化而 stale；必须继续使用正式 review 链。" );
  const root = diagnosticRoot(caseDir, repairRound, state.hashes);
  if (await exists(root)) throw new Error(`repair diagnostic 已存在，拒绝覆盖：${relativeToCase(caseDir, root)}`);
  const artifacts = {
    blindCandidates: relativeToCase(caseDir, path.join(root, "blind-candidates.json")),
    blindAlignment: relativeToCase(caseDir, path.join(root, "blind-alignment.json")),
    fidelityReview: relativeToCase(caseDir, path.join(root, "fidelity-review.json")),
    consensus: relativeToCase(caseDir, path.join(root, "repair-diagnostic-consensus.json")),
    repairLog: relativeToCase(caseDir, path.join(root, "repair-log.json")),
  };
  const manifest = {
    schemaVersion: "1.0.0",
    kind: "repair_diagnostic",
    caseId: caseManifest.id,
    workflowVersion: "2.2.0",
    repairRound,
    sourceReviewRound: sourceRound,
    sourceRoundManifest: {
      path: relativeToCase(caseDir, sourceManifestPath),
      sha256: await sha256File(sourceManifestPath),
    },
    staleInputKeys: staleKeys,
    inputHashes: state.hashes,
    assignments: assigned,
    artifacts,
    authority: { maximumRepairRounds: limit, globalDefault: 2 },
    cannotReplaceFormalRound: true,
  };
  const sourceById = new Map(state.normalized.map((unit) => [unit.id, unit]));
  const blindPacket = {
    ...packetBase(manifest, "blind_recall", { segments: state.hashes.segments }, artifacts.blindCandidates),
    payload: {
      blindToEvidence: true,
      segments: state.segments.map((segment) => ({
        ...segment,
        sourceUnits: (segment.sourceIds ?? []).map((id) => sourceById.get(id)).filter(Boolean),
      })),
    },
  };
  const alignmentPacket = {
    ...packetBase(manifest, "alignment", { evidence: state.hashes.evidence, blindCandidates: null }, artifacts.blindAlignment),
    needsBlindRecall: true,
    payload: { claims: state.claims, blindCandidates: null },
  };
  const fidelityPacket = {
    ...packetBase(manifest, "fidelity", {
      evidence: state.hashes.evidence,
      deepRead: state.hashes.deepRead,
      research: state.hashes.research,
    }, artifacts.fidelityReview),
    payload: { readerLeaves: fidelityLeaves(state.deepRead, state.claims, state.normalized, state.research) },
  };
  await fs.mkdir(path.join(root, "packets"), { recursive: true });
  const packets = {};
  for (const [role, packet] of [["blind_recall", blindPacket], ["alignment", alignmentPacket], ["fidelity", fidelityPacket]]) {
    const record = await writePacket(root, role, packet);
    packets[role] = { path: relativeToCase(caseDir, record.path), sha256: record.sha256, ready: record.ready };
  }
  const packetIndex = { schemaVersion: "1.0.0", kind: "repair_diagnostic", alignmentReady: false, packets };
  await Promise.all([writeJson(path.join(root, "manifest.json"), manifest), writeJson(path.join(root, "packet-index.json"), packetIndex)]);
  return { root, manifest, packetIndex };
}

async function locateDiagnostic(caseDir, repairRound) {
  const parent = path.join(caseDir, "work", "reviews", "2.2.0", "preflight", roundDirectory(repairRound));
  const names = (await fs.readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("repair-diagnostic-"));
  if (names.length !== 1) throw new Error(`第 ${repairRound} 轮必须恰有一个 repair diagnostic，当前为 ${names.length} 个。`);
  return path.join(parent, names[0].name);
}

export async function refreshRepairDiagnostic(caseDir, repairRound) {
  const root = await locateDiagnostic(caseDir, repairRound);
  const [manifest, index] = await Promise.all([readJson(path.join(root, "manifest.json")), readJson(path.join(root, "packet-index.json"))]);
  if (manifest.kind !== "repair_diagnostic" || index.kind !== "repair_diagnostic") throw new Error("不是合法 repair diagnostic。" );
  if (index.alignmentReady) throw new Error("repair diagnostic alignment 已刷新，拒绝覆盖。" );
  const candidates = await readJson(resolveInside(caseDir, manifest.artifacts.blindCandidates, "blindCandidates"));
  const errors = blindCandidateContractErrors(candidates, { caseId: manifest.caseId, segmentsHash: manifest.inputHashes.segments });
  if (candidates.reviewerId !== manifest.assignments.blind_recall || candidates.reviewRound !== repairRound) errors.push("blind recall reviewer/round 与 diagnostic manifest 不一致。" );
  if (errors.length) throw new Error(`blind recall 报告非法：\n${errors.join("\n")}`);
  const packetPath = resolveInside(caseDir, index.packets.alignment.path, "alignment packet");
  const packet = await readJson(packetPath);
  packet.needsBlindRecall = false;
  packet.inputHashes.blindCandidates = sha256Value(candidates);
  packet.payload.blindCandidates = candidates;
  await writeJson(packetPath, packet);
  index.alignmentReady = true;
  index.packets.alignment = {
    path: index.packets.alignment.path,
    sha256: await sha256File(packetPath),
    ready: true,
    dependencies: [{ path: manifest.artifacts.blindCandidates, sha256: await sha256File(resolveInside(caseDir, manifest.artifacts.blindCandidates, "blindCandidates")) }],
  };
  await writeJson(path.join(root, "packet-index.json"), index);
  return { root, candidateCount: candidates.entries.length };
}

export async function validateRepairDiagnostic(caseDir, repairRound, { requireReports = true, pipelineConfig } = {}) {
  const errors = [];
  const failures = [];
  let root;
  try { root = await locateDiagnostic(caseDir, repairRound); } catch (error) { return { root: null, manifest: null, errors: [error.message], failures }; }
  const [manifest, index, state, pipeline] = await Promise.all([
    readJson(path.join(root, "manifest.json")),
    readJson(path.join(root, "packet-index.json")),
    currentState(caseDir),
    configuredPipeline({ pipelineConfig }),
  ]);
  if (manifest.kind !== "repair_diagnostic" || manifest.cannotReplaceFormalRound !== true) errors.push("diagnostic manifest 缺少不可替代正式轮次标记。" );
  if (manifest.repairRound !== repairRound) errors.push("diagnostic repairRound 不一致。" );
  if ((pipeline.reviews?.maximumRepairRounds ?? 2) !== 2) errors.push("全局默认修复上限必须保持 2。" );
  const limit = repairRoundLimitForCase(pipeline, manifest.caseId);
  if (repairRound > limit || manifest.authority?.maximumRepairRounds !== limit) errors.push("diagnostic 已越出当前案例授权上限。" );
  for (const [key, expected] of Object.entries(manifest.inputHashes ?? {})) if (state.hashes[key] !== expected) errors.push(`diagnostic inputHashes.${key} 已过期。`);
  if (!HASH.test(manifest.sourceRoundManifest?.sha256 ?? "")) errors.push("source round manifest hash 非法。" );
  else {
    const sourcePath = resolveInside(caseDir, manifest.sourceRoundManifest.path, "source round manifest");
    if (!(await exists(sourcePath)) || await sha256File(sourcePath) !== manifest.sourceRoundManifest.sha256) errors.push("source round manifest 被修改或删除。" );
  }
  if (!index.alignmentReady) errors.push("alignment packet 尚未 refresh。" );
  for (const role of ["blind_recall", "alignment", "fidelity", ...(index.packets?.repair_editor ? ["repair_editor"] : [])]) {
    const record = index.packets?.[role];
    if (!record?.path || !HASH.test(record.sha256 ?? "")) {
      errors.push(`${role} packet index 非法。`);
      continue;
    }
    const packetPath = resolveInside(caseDir, record.path, `${role} packet`);
    if (!isInside(path.join(root, "packets"), packetPath)) {
      errors.push(`${role} packet 不在当前 diagnostic/packets 内。`);
      continue;
    }
    if (!(await exists(packetPath)) || await sha256File(packetPath) !== record.sha256) {
      errors.push(`${role} packet 缺失、被改写或 hash 过期。`);
      continue;
    }
    const packet = await readJson(packetPath);
    if (packet.diagnosticKind !== "repair_diagnostic"
      || packet.sourceReviewRound !== manifest.sourceReviewRound
      || packet.reviewRound !== repairRound
      || packet.assignedReviewerId !== manifest.assignments[role]) {
      errors.push(`${role} packet 不能证明属于当前 diagnostic。`);
    }
  }
  const artifacts = {};
  for (const [key, role] of [["blindCandidates", "blind_recall"], ["blindAlignment", "alignment"], ["fidelityReview", "fidelity"]]) {
    const artifactPath = resolveInside(caseDir, manifest.artifacts[key], key);
    if (!(await exists(artifactPath))) {
      if (requireReports) errors.push(`缺少 diagnostic ${key}。`);
      continue;
    }
    artifacts[key] = await readJson(artifactPath);
    if (artifacts[key].reviewerId !== manifest.assignments[role] || artifacts[key].role !== role || artifacts[key].reviewRound !== repairRound) errors.push(`${key} reviewer/role/round 与 manifest 不一致。`);
  }
  if (artifacts.blindCandidates) errors.push(...blindCandidateContractErrors(artifacts.blindCandidates, { caseId: manifest.caseId, segmentsHash: state.hashes.segments }));
  if (artifacts.blindAlignment && artifacts.blindCandidates) errors.push(...blindAlignmentContractErrors(artifacts.blindAlignment, {
    caseId: manifest.caseId,
    candidates: artifacts.blindCandidates,
    claims: state.claims,
    evidenceHash: state.hashes.evidence,
  }));
  if (artifacts.fidelityReview) errors.push(...fidelityReviewContractErrors(artifacts.fidelityReview, {
    caseId: manifest.caseId,
    claims: state.claims,
    deepRead: state.deepRead,
    research: state.research,
    evidenceHash: state.hashes.evidence,
    deepReadHash: state.hashes.deepRead,
    researchHash: state.hashes.research,
    forbiddenReviewerIds: [manifest.assignments.repair_editor],
    requirePass: false,
  }));
  if (artifacts.blindCandidates && artifacts.blindAlignment) {
    const metrics = blindRecallMetrics(artifacts.blindCandidates, artifacts.blindAlignment);
    const allTarget = pipeline.qualityGates?.allClaimRecall ?? 0.95;
    if (metrics.allRecall < allTarget || metrics.highMediumRecall < 1) {
      const alignmentByRef = new Map(artifacts.blindAlignment.entries.map((entry) => [entry.candidateRef, entry]));
      failures.push({
        gate: "blind_recall",
        metrics,
        required: { allRecall: allTarget, highMediumRecall: 1 },
        issues: artifacts.blindCandidates.entries.flatMap((candidate) => {
          const alignment = alignmentByRef.get(candidate.id);
          return ["equivalent", "subsumed"].includes(alignment?.relation) ? [] : [{ candidate, alignment: alignment ?? null }];
        }),
      });
    }
  }
  if (artifacts.fidelityReview) {
    const entries = fidelityReviewGateFailures(artifacts.fidelityReview, { research: state.research });
    if (entries.length) failures.push({ gate: "fidelity", entries });
  }
  return { root, manifest, index, state, artifacts, errors: [...new Set(errors)], failures };
}

function failedEvidenceRefs(failures) {
  return [...new Set(failures.flatMap((failure) => {
    if (failure.gate === "fidelity") return (failure.entries ?? []).flatMap((entry) => entry.evidenceRefs ?? []);
    if (failure.gate === "blind_recall") return (failure.issues ?? []).flatMap((issue) => issue.alignment?.matchedEvidenceRefs ?? []);
    return [];
  }))];
}

export async function computeRepairDiagnosticConsensus(caseDir, repairRound, { write = true, pipelineConfig } = {}) {
  const validation = await validateRepairDiagnostic(caseDir, repairRound, { requireReports: true, pipelineConfig });
  if (!validation.manifest) return { schemaVersion: "1.0.0", kind: "repair_diagnostic", reviewRound: repairRound, status: "invalid", errors: validation.errors };
  const { manifest, state, failures, errors, root } = validation;
  const status = errors.length ? "invalid" : failures.length ? "repair_required" : "pass";
  const consensus = {
    schemaVersion: "1.0.0",
    kind: "repair_diagnostic",
    caseId: manifest.caseId,
    workflowVersion: "2.2.0",
    reviewRound: repairRound,
    sourceReviewRound: manifest.sourceReviewRound,
    status,
    cannotReplaceFormalConsensus: true,
    inputHashes: manifest.inputHashes,
    failures,
    errors,
  };
  const consensusPath = path.join(root, "repair-diagnostic-consensus.json");
  if (write && await exists(consensusPath)) {
    const retained = await readJson(consensusPath);
    if (sha256Value(retained) !== sha256Value(consensus)) throw new Error("repair diagnostic consensus 已存在且内容不同，拒绝覆盖。");
  } else if (write) {
    await writeJson(consensusPath, consensus);
  }
  if (write && status === "repair_required") {
    const resources = roleResources("repair_editor");
    resources.contract.properties.repairRound.maximum = repairRound;
    const allowedOutputPaths = [
      "work/evidence.jsonl",
      ...(state.evidenceMigration ? ["work/evidence-migration.json"] : []),
      ...(state.claimBundles ? ["work/claim-bundles.json"] : []),
      "work/theme-map.json",
      "output/deep-read.json",
      "work/reader-map.json",
      "work/research.json",
      manifest.artifacts.repairLog,
    ];
    const failedRefs = failedEvidenceRefs(failures);
    const claimById = new Map(state.claims.map((claim) => [claim.id, claim]));
    const sourceById = new Map(state.normalized.map((unit) => [unit.id, unit]));
    const packet = {
      ...packetBase(manifest, "repair_editor", {
        diagnosticConsensus: sha256Value(consensus),
        ...manifest.inputHashes,
      }, manifest.artifacts.repairLog),
      output: { path: manifest.artifacts.repairLog, schema: resources.schemaPath, contract: resources.contract, dependencies: {}, allowedOutputPaths },
      inputPolicy: {
        isolation: "packet-only",
        instruction: "只修复本 diagnostic 明示的 Blind Recall 或 Fidelity 失败；只能写 allowedOutputPaths。修复后必须由新 Claim Auditor 进入正式 full review 链，本 diagnostic 不构成批准。",
        forbidden: ["源 full round 文件", "正式 consensus", "human-review.json", "packet 外问题"],
      },
      payload: {
        authority: "diagnostic_repair_only_no_approval",
        requiresFreshClaimAuditor: true,
        sourceReviewRound: manifest.sourceReviewRound,
        repairRound,
        maximumRepairRounds: manifest.authority.maximumRepairRounds,
        failures,
        failedClaims: failedRefs.map((id) => claimById.get(id)).filter(Boolean).map((claim) => sourceUnitsForClaim(claim, sourceById)),
        editableSnapshots: {
          evidence: { path: "work/evidence.jsonl", sha256: state.hashes.evidence, format: "jsonl", value: state.claims },
          ...(state.evidenceMigration ? { evidenceMigration: { path: "work/evidence-migration.json", sha256: state.hashes.evidenceMigration, format: "json", value: state.evidenceMigration } } : {}),
          ...(state.claimBundles ? { claimBundles: { path: "work/claim-bundles.json", sha256: state.hashes.claimBundles, format: "json", value: state.claimBundles } } : {}),
          themeMap: { path: "work/theme-map.json", sha256: state.hashes.themeMap, format: "json", value: state.themeMap },
          deepRead: { path: "output/deep-read.json", sha256: state.hashes.deepRead, format: "json", value: state.deepRead },
          readerMap: { path: "work/reader-map.json", sha256: state.hashes.readerMap, format: "json", value: state.readerMap },
          research: { path: "work/research.json", sha256: state.hashes.research, format: "json", value: state.research },
        },
        allowedOutputPaths,
      },
    };
    const packetPath = path.join(root, "packets", "repair_editor.json");
    if (await exists(packetPath)) {
      const retained = await readJson(packetPath);
      if (sha256Value(retained) !== sha256Value(packet)) throw new Error("repair diagnostic Repair Editor packet 已存在且内容不同，拒绝覆盖。");
    } else {
      await writeJson(packetPath, packet);
      const index = await readJson(path.join(root, "packet-index.json"));
      index.packets.repair_editor = { path: relativeToCase(caseDir, packetPath), sha256: await sha256File(packetPath), ready: true };
      await writeJson(path.join(root, "packet-index.json"), index);
    }
  }
  return consensus;
}
