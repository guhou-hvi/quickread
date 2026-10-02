import fs from "node:fs/promises";
import path from "node:path";
import {
  isMain,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
} from "./lib.mjs";
import {
  adjudicationContractErrors,
  blindAlignmentContractErrors,
  blindCandidateContractErrors,
  blindRecallMetrics,
  claimBundleContractErrors,
  coverageClaimsForReview,
  claimReviewResolutionContractErrors,
  coverageReviewContractErrors,
  evidenceMigrationContractErrors,
  fidelityReviewContractErrors,
  fidelityReviewGateFailures,
  fidelityReviewWarnings,
  fidelityReaderLeaves,
  eligibleReaderLeaves,
  readerLeafIndex,
  readerMapV2ContractErrors,
  readerReviewContractErrors,
  readerReviewGateFailures,
  repairRoundLimitForCase,
  repairLogContractErrors,
  reviewManifestContractErrors,
  reviewWorkflowVersion,
  sha256Text,
  sha256Value,
} from "./review-contract.mjs";
import { validateRepairDiagnostic } from "./review-diagnostic.mjs";

const REQUIRED_REPORTS = Object.freeze([
  ["claimReview", "claim_auditor"],
  ["blindCandidates", "blind_recall"],
  ["blindAlignment", "alignment"],
  ["coverageA", "coverage_a"],
  ["coverageB", "coverage_b"],
  ["fidelityReview", "fidelity"],
  ["readerReview", "reader_advocate"],
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function roundDirectory(reviewRound) {
  if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new Error("reviewRound 必须为正整数。");
  return `round-${String(reviewRound).padStart(2, "0")}`;
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

async function readResolutionDependency(caseDir, resolution, hashName, fileName, errors) {
  if (!Object.hasOwn(resolution?.inputHashes ?? {}, hashName)) return null;
  return readRequiredJson(path.join(caseDir, "work", fileName), fileName, errors);
}

function resolveCasePath(caseDir, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`${label} 必须为相对路径。`);
  const resolved = path.resolve(caseDir, relativePath);
  const relative = path.relative(caseDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出案例目录：${relativePath}`);
  return resolved;
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function expectedArtifactKey(role) {
  return {
    claim_auditor: "claimReview",
    blind_recall: "blindCandidates",
    alignment: "blindAlignment",
    coverage_a: "coverageA",
    coverage_b: "coverageB",
    fidelity: "fidelityReview",
    reader_advocate: "readerReview",
    adjudicator: "adjudication",
    repair_editor: "repairLog",
  }[role];
}

function expectedArtifactSchema(role) {
  return {
    claim_auditor: "schemas/claim-review.schema.json",
    blind_recall: "schemas/blind-candidate.schema.json",
    alignment: "schemas/blind-alignment.schema.json",
    coverage_a: "schemas/coverage-review.schema.json",
    coverage_b: "schemas/coverage-review.schema.json",
    fidelity: "schemas/fidelity-review.schema.json",
    reader_advocate: "schemas/reader-review.schema.json",
    adjudicator: "schemas/adjudication.schema.json",
    repair_editor: "schemas/repair-log.schema.json",
  }[role];
}

function assignmentByRole(manifest) {
  return new Map((manifest.assignments ?? []).map((assignment) => [assignment.role, assignment.reviewerId]));
}

function artifactPath(caseDir, manifest, key) {
  const relativePath = manifest.artifacts?.[key];
  return relativePath ? resolveCasePath(caseDir, relativePath, `artifact ${key}`) : null;
}

async function readRequiredJson(filePath, label, errors) {
  if (!filePath || !(await exists(filePath))) {
    errors.push(`缺少 ${label}。`);
    return null;
  }
  try {
    return await readJson(filePath);
  } catch (error) {
    errors.push(`${label} 不是有效 JSON：${error.message}`);
    return null;
  }
}

function reviewerErrors(artifact, expectedRole, assignments, reviewRound) {
  const expected = assignments.get(expectedRole);
  if (!artifact) return [];
  const errors = [];
  if (artifact.reviewerId !== expected) errors.push(`${expectedRole}.reviewerId 与 manifest assignment 不一致。`);
  if (artifact.role !== expectedRole) errors.push(`${expectedRole}.role 与 artifact 类型不一致。`);
  if (artifact.reviewRound !== reviewRound) errors.push(`${expectedRole}.reviewRound 与 manifest 不一致。`);
  return errors;
}

function packetPayloadRefErrors(role, packet, { claims, segments, deepRead, reviewVersion }) {
  const errors = [];
  const claimIds = new Set(claims.map((claim) => claim.id));
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const sourceIds = new Set(segments.flatMap((segment) => segment.sourceIds ?? []));
  const leafIds = new Set();
  for (const section of deepRead.sections ?? []) for (const module of section.modules ?? []) for (const block of module.blocks ?? []) {
    for (const node of [block, ...(block.paragraphs ?? []), ...(block.items ?? [])]) if (node.id) leafIds.add(node.id);
  }
  if (role === "claim_auditor") {
    for (const claim of packet.payload?.claims ?? []) if (!claimIds.has(claim?.id)) errors.push(`${role} packet 越界 claim：${claim?.id ?? "<missing>"}`);
  } else if (role === "blind_recall") {
    for (const segment of packet.payload?.segments ?? []) {
      if (!segmentIds.has(segment?.id)) errors.push(`${role} packet 越界 segment：${segment?.id ?? "<missing>"}`);
      for (const unit of segment?.sourceUnits ?? []) if (!sourceIds.has(unit?.id)) errors.push(`${role} packet 越界 source：${unit?.id ?? "<missing>"}`);
    }
  } else if (role === "alignment") {
    for (const claim of packet.payload?.claims ?? []) if (!claimIds.has(claim?.id)) errors.push(`${role} packet 越界 claim：${claim?.id ?? "<missing>"}`);
  } else if (["coverage_a", "coverage_b"].includes(role)) {
    const expectedCoverageIds = new Set(coverageClaimsForReview(claims, deepRead, reviewVersion)
      .map((claim) => claim.id));
    for (const claim of packet.payload?.claims ?? []) if (!expectedCoverageIds.has(claim?.id)) errors.push(`${role} packet 包含不在当前 Coverage 审核范围内的 claim：${claim?.id ?? "<missing>"}`);
    for (const leaf of packet.payload?.readerLeaves ?? []) if (!leafIds.has(leaf?.id)) errors.push(`${role} packet 越界 reader leaf：${leaf?.id ?? "<missing>"}`);
  } else if (role === "fidelity") {
    for (const leaf of packet.payload?.readerLeaves ?? []) if (!leafIds.has(leaf?.id)) errors.push(`${role} packet 越界 reader leaf：${leaf?.id ?? "<missing>"}`);
  } else if (role === "reader_advocate") {
    for (const leaf of packet.payload?.readerLeaves ?? []) if (!leafIds.has(leaf?.id)) errors.push(`${role} packet 越界 reader leaf：${leaf?.id ?? "<missing>"}`);
  }
  return errors;
}

function blindSupportErrors(candidates, segments) {
  const errors = [];
  const segmentById = new Map(segments.map((segment) => [segment.id, new Set(segment.sourceIds ?? [])]));
  for (const candidate of candidates?.entries ?? []) for (const span of candidate?.supportSpans ?? []) {
    const owned = segmentById.get(span.segmentId);
    if (!owned) errors.push(`blind candidate ${candidate?.id ?? "<missing>"} 引用未知 segment：${span.segmentId}`);
    else for (const sourceId of span.sourceIds ?? []) if (!owned.has(sourceId)) errors.push(`blind candidate ${candidate?.id ?? "<missing>"} 越界引用 source：${sourceId}`);
  }
  return errors;
}

function stripPacketClaim(claim) {
  if (!claim || typeof claim !== "object") return claim;
  return {
    ...claim,
    supportSpans: (claim.supportSpans ?? []).map(({ sourceUnits: _sourceUnits, ...span }) => span),
  };
}

function embeddedClaimSourceErrors(role, claim, sourceById) {
  const errors = [];
  if (!claim || typeof claim !== "object") return [`${role} packet 包含非法 claim payload。`];
  for (const span of claim.supportSpans ?? []) {
    const expectedIds = span.sourceIds ?? [];
    const embeddedIds = (span.sourceUnits ?? []).map((unit) => unit.id);
    if (sha256Value(embeddedIds) !== sha256Value(expectedIds)) {
      errors.push(`${role} packet 的 ${claim.id} 未按 support span 精确附带 source units。`);
      continue;
    }
    for (const unit of span.sourceUnits ?? []) {
      const expected = sourceById.get(unit.id);
      if (!expected || sha256Value(unit) !== sha256Value(expected)) errors.push(`${role} packet 改写了 source unit：${unit.id}`);
    }
  }
  return errors;
}

function coverageClaim(claim) {
  return {
    id: claim.id,
    statement: claim.statement,
    provenance: claim.provenance,
    importance: claim.importance,
    claimRole: claim.claimRole,
    themeId: claim.themeId,
  };
}

function stripLeafReferences(leaf) {
  const {
    evidenceRefs: _evidenceRefs,
    citationRefs: _citationRefs,
    blockId: _parentBlockId,
    ...rest
  } = leaf;
  return rest;
}

function stripFidelityLeaf(leaf) {
  const {
    evidence: _evidence,
    citations: _citations,
    researchChecks: _researchChecks,
    blockId: _parentBlockId,
    ...rest
  } = leaf;
  return rest;
}

function stripReaderReferences(markdown) {
  return String(markdown)
    .replace(/\s*〔(?:\[[^\]]+\]\([^)]*\))(?:、\[[^\]]+\]\([^)]*\))*〕/gu, "")
    .replace(/\[完整证据册\]\([^)]*\)/gu, "完整证据册")
    .replace(/<a id="[^"]+"><\/a>\s*/gu, "");
}

function packetInputHashErrors(role, packet, expected) {
  const errors = [];
  const actualKeys = Object.keys(packet.inputHashes ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (sha256Value(actualKeys) !== sha256Value(expectedKeys)) {
    errors.push(`${role} packet.inputHashes 字段集合不符合固定契约。`);
  }
  for (const [name, value] of Object.entries(expected)) {
    if (packet.inputHashes?.[name] !== value) errors.push(`${role} packet.inputHashes.${name} 已过期。`);
  }
  return errors;
}

function packetSnapshotErrors(role, packet, { normalized, segments, claims, deepRead, deepMarkdown, research, artifacts, currentHashes, reviewVersion }) {
  const errors = [];
  const expectedHashes = {
    claim_auditor: { segments: currentHashes.segments, evidence: currentHashes.evidence },
    blind_recall: { segments: currentHashes.segments },
    alignment: {
      evidence: currentHashes.evidence,
      blindCandidates: artifacts.blindCandidates ? sha256Value(artifacts.blindCandidates) : null,
    },
    coverage_a: { evidence: currentHashes.evidence, deepRead: currentHashes.deepRead },
    coverage_b: { evidence: currentHashes.evidence, deepRead: currentHashes.deepRead },
    fidelity: { evidence: currentHashes.evidence, deepRead: currentHashes.deepRead, research: currentHashes.research },
    reader_advocate: { deepRead: currentHashes.deepRead, readerMarkdown: sha256Text(stripReaderReferences(deepMarkdown)) },
  }[role];
  errors.push(...packetInputHashErrors(role, packet, expectedHashes ?? {}));
  const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
  if (role === "claim_auditor") {
    if (sha256Value((packet.payload?.claims ?? []).map(stripPacketClaim)) !== sha256Value(claims)) errors.push("claim_auditor packet 改写了 evidence 内容。");
    for (const claim of packet.payload?.claims ?? []) errors.push(...embeddedClaimSourceErrors(role, claim, sourceById));
    if (packet.existingOutput?.immutable !== true || !artifacts.claimReview || packet.existingOutput.sha256 !== sha256Value(artifacts.claimReview)) {
      errors.push("claim_auditor packet 未绑定不可覆盖的既有 claim-review。");
    }
  } else if (role === "blind_recall") {
    const packetSegments = (packet.payload?.segments ?? []).map(({ sourceUnits: _sourceUnits, ...segment }) => segment);
    if (sha256Value(packetSegments) !== sha256Value(segments)) errors.push("blind_recall packet 改写或遗漏了 segment。");
    for (const segment of packet.payload?.segments ?? []) for (const unit of segment.sourceUnits ?? []) {
      const expected = sourceById.get(unit.id);
      if (!expected || sha256Value(unit) !== sha256Value(expected)) errors.push(`blind_recall packet 改写了 source unit：${unit.id}`);
    }
  } else if (role === "alignment") {
    if (sha256Value(packet.payload?.claims ?? []) !== sha256Value(claims)) errors.push("alignment packet 改写了 evidence。");
    if (artifacts.blindCandidates && sha256Value(packet.payload?.blindCandidates) !== sha256Value(artifacts.blindCandidates)) errors.push("alignment packet 与 blindCandidates artifact 不一致。");
  } else if (role === "coverage_a" || role === "coverage_b") {
    const expectedClaims = coverageClaimsForReview(claims, deepRead, reviewVersion).map(coverageClaim);
    const leaves = [...eligibleReaderLeaves(deepRead).values()].map(stripLeafReferences);
    if (sha256Value(packet.payload?.claims ?? []) !== sha256Value(expectedClaims)) errors.push(`${role} packet 改写或遗漏了当前 Coverage 审核范围内的 claim。`);
    if (sha256Value(packet.payload?.readerLeaves ?? []) !== sha256Value(leaves)) errors.push(`${role} packet 改写了 reader leaves。`);
  } else if (role === "fidelity") {
    const leaves = [...fidelityReaderLeaves(deepRead).values()].map(stripFidelityLeaf);
    if (sha256Value((packet.payload?.readerLeaves ?? []).map(stripFidelityLeaf)) !== sha256Value(leaves)) errors.push("fidelity packet 改写或遗漏了可审计 reader leaves。");
    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    const citationById = new Map((research?.citations ?? []).map((citation) => [citation.id, citation]));
    for (const leaf of packet.payload?.readerLeaves ?? []) for (const claim of leaf.evidence ?? []) {
      if (!claim?.id) {
        errors.push("fidelity packet 包含缺少 ID 的 claim。");
        continue;
      }
      const expected = claimById.get(claim.id);
      if (!expected || sha256Value(stripPacketClaim(claim)) !== sha256Value(expected)) errors.push(`fidelity packet 改写了 claim：${claim.id}`);
      errors.push(...embeddedClaimSourceErrors(role, claim, sourceById));
    }
    for (const leaf of packet.payload?.readerLeaves ?? []) for (const citation of leaf.citations ?? []) {
      const expected = citationById.get(citation.id);
      if (!expected || sha256Value(citation) !== sha256Value(expected)) errors.push(`fidelity packet 改写了外部引用：${citation.id}`);
    }
  } else if (role === "reader_advocate") {
    const leaves = [...readerLeafIndex(deepRead).values()].map(stripLeafReferences);
    if (sha256Value(packet.payload?.readerLeaves ?? []) !== sha256Value(leaves)) errors.push("reader_advocate packet 改写了 reader leaves。");
    if (packet.payload?.readerMarkdown !== stripReaderReferences(deepMarkdown)) errors.push("reader_advocate packet 改写了 reader Markdown。");
  }
  return errors;
}

export async function validateReviewRound(caseDir, reviewRound, { requireReports = true, requireAdjudication = false, includeAdjudication = true } = {}) {
  const errors = [];
  const warnings = [];
  const diagnostics = [];
  const hardErrors = [];
  // 2.3 keeps reportFailures as a compatibility alias, but only concrete
  // semantic failures belong here. Quantitative targets live in diagnostics.
  const reportFailures = hardErrors;
  const pipelineConfig = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const reviewVersion = reviewWorkflowVersion(pipelineConfig);
  const reviewRoot = path.join(caseDir, "work", "reviews", reviewVersion, roundDirectory(reviewRound));
  const manifest = await readRequiredJson(path.join(reviewRoot, "manifest.json"), "review manifest", errors);
  const packetIndex = await readRequiredJson(path.join(reviewRoot, "packet-index.json"), "packet index", errors);
  if (!manifest || !packetIndex) return {
    reviewRoot,
    manifest,
    packetIndex,
    artifacts: {},
    packets: new Map(),
    errors,
    warnings,
    diagnostics,
    hardErrors,
    reportFailures,
  };
  const maximumRepairRounds = repairRoundLimitForCase(pipelineConfig, manifest.caseId);

  const claimBundlesPath = path.join(caseDir, "work", "claim-bundles.json");
  const themeMapPath = path.join(caseDir, "work", "theme-map.json");
  const evidenceMigrationPath = path.join(caseDir, "work", "evidence-migration.json");
  const claimReviewPath = path.join(reviewRoot, "claim-review.json");
  const claimReviewResolutionPath = path.join(reviewRoot, "claim-review-resolution.json");
  const [normalized, segments, claims, deepRead, readerMap, deepMarkdown, research, claimReview, claimReviewResolution, claimBundles, themeMap] = await Promise.all([
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
    readJsonLines(path.join(caseDir, "work", "segments.jsonl")),
    readJsonLines(path.join(caseDir, "work", "evidence.jsonl")),
    readJson(path.join(caseDir, "output", "deep-read.json")),
    readJson(path.join(caseDir, "work", "reader-map.json")),
    fs.readFile(path.join(caseDir, "output", "deep-read.md"), "utf8"),
    readJson(path.join(caseDir, "work", "research.json")),
    readRequiredJson(claimReviewPath, "claimReview", errors),
    readRequiredJson(claimReviewResolutionPath, "claimReviewResolution", errors),
    readRequiredJson(claimBundlesPath, "claimBundles", errors),
    readRequiredJson(themeMapPath, "themeMap", errors),
  ]);
  const [mechanicalFix, secondaryClaimReview, claimAdjudication] = await Promise.all([
    readResolutionDependency(caseDir, claimReviewResolution, "mechanicalFix", "claim-mechanical-fix.json", errors),
    readResolutionDependency(caseDir, claimReviewResolution, "secondaryClaimReview", "claim-review-secondary.json", errors),
    readResolutionDependency(caseDir, claimReviewResolution, "adjudication", "claim-adjudication.json", errors),
  ]);
  const evidenceMigrationExists = await exists(evidenceMigrationPath);
  const evidenceMigration = evidenceMigrationExists
    ? await readRequiredJson(evidenceMigrationPath, "evidenceMigration", errors)
    : null;
  const currentHashes = {
    segments: sha256Value(segments),
    evidence: sha256Value(claims),
    ...(claimReview ? { claimReview: sha256Value(claimReview) } : {}),
    ...(claimReviewResolution ? { claimReviewResolution: sha256Value(claimReviewResolution) } : {}),
    deepRead: sha256Value(deepRead),
    readerMap: sha256Value(readerMap),
    ...(claimBundles ? { claimBundles: sha256Value(claimBundles) } : {}),
    ...(themeMap ? { themeMap: sha256Value(themeMap) } : {}),
    research: sha256Value(research),
    ...(evidenceMigration ? { evidenceMigration: sha256Value(evidenceMigration) } : {}),
  };
  const manifestExpectedHashes = { ...currentHashes };
  if (!Object.hasOwn(manifest.inputHashes ?? {}, "themeMap")) delete manifestExpectedHashes.themeMap;
  errors.push(...reviewManifestContractErrors(manifest, {
    caseId: path.basename(caseDir),
    inputHashes: manifestExpectedHashes,
    workflowVersion: reviewVersion,
    requireClaimReviewResolution: true,
  }));
  errors.push(...readerMapV2ContractErrors(readerMap, {
    caseId: path.basename(caseDir),
    claims,
    deepRead,
    evidenceHash: currentHashes.evidence,
    deepReadHash: currentHashes.deepRead,
  }));
  if (manifest.reviewRound !== reviewRound || packetIndex.reviewRound !== reviewRound) errors.push("reviewRound 与目录不一致。");
  if (packetIndex.caseId !== manifest.caseId || packetIndex.workflowVersion !== manifest.workflowVersion) errors.push("packet index 与 review manifest 不一致。");
  if (!packetIndex.alignmentReady) errors.push("alignment packet 尚未完成 blind_recall refresh。");
  const assignments = assignmentByRole(manifest);
  const expectedClaimReview = toPosix(path.relative(caseDir, claimReviewPath));
  if (manifest.artifacts?.claimReview !== expectedClaimReview) {
    errors.push(`artifact claimReview 必须固定为 ${expectedClaimReview}。`);
  }
  const expectedClaimReviewResolution = toPosix(path.relative(caseDir, claimReviewResolutionPath));
  if (manifest.artifacts?.claimReviewResolution !== expectedClaimReviewResolution) {
    errors.push(`artifact claimReviewResolution 必须固定为 ${expectedClaimReviewResolution}。`);
  }
  if (manifest.artifacts?.claimBundles !== "work/claim-bundles.json") {
    errors.push("artifact claimBundles 必须固定为 work/claim-bundles.json。");
  }
  if (manifest.artifacts?.themeMap !== undefined && manifest.artifacts.themeMap !== "work/theme-map.json") {
    errors.push("artifact themeMap must be work/theme-map.json when present.");
  }
  const expectedMigrationPath = evidenceMigrationExists ? "work/evidence-migration.json" : null;
  if (manifest.artifacts?.evidenceMigration !== expectedMigrationPath) {
    errors.push("artifact evidenceMigration 与 work/evidence-migration.json 的实际存在状态不一致。");
  }
  if (!evidenceMigrationExists && Object.hasOwn(manifest.inputHashes ?? {}, "evidenceMigration")) {
    errors.push("evidenceMigration 不存在时 manifest 不得保留 evidenceMigration hash。");
  }
  const expectedRepairLog = toPosix(path.relative(caseDir, path.join(reviewRoot, "repair-log.json")));
  if (manifest.artifacts?.repairLog !== expectedRepairLog) {
    errors.push(`artifact repairLog 必须固定为 ${expectedRepairLog}。`);
  }
  for (const [key, relativePath] of Object.entries(manifest.artifacts ?? {})) {
    if (relativePath === null && key === "evidenceMigration") continue;
    try {
      const resolved = resolveCasePath(caseDir, relativePath, `artifact ${key}`);
      if (["claimBundles", "evidenceMigration", "themeMap"].includes(key)) {
        if (!isInside(path.join(caseDir, "work"), resolved)) errors.push(`artifact ${key} 必须位于案例 work/ 目录：${relativePath}`);
      } else if (!isInside(reviewRoot, resolved)) {
        errors.push(`artifact ${key} 必须位于当前 ${reviewVersion} review round：${relativePath}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const packets = new Map();
  for (const role of ["claim_auditor", "blind_recall", "alignment", "coverage_a", "coverage_b", "fidelity", "reader_advocate"]) {
    const record = packetIndex.packets?.[role];
    if (!record) {
      errors.push(`packet index 缺少 ${role}。`);
      continue;
    }
    let packetPath;
    try {
      packetPath = resolveCasePath(caseDir, record.path, `${role} packet`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (!(await exists(packetPath))) {
      errors.push(`${role} packet 不存在。`);
      continue;
    }
    if (!isInside(path.join(reviewRoot, "packets"), packetPath)) errors.push(`${role} packet 必须位于当前 round/packets。`);
    if (await sha256File(packetPath) !== record.sha256) errors.push(`${role} packet hash 不一致。`);
    const packet = await readJson(packetPath);
    packets.set(role, packet);
    if (packet.caseId !== manifest.caseId || packet.reviewRound !== reviewRound || packet.role !== role) errors.push(`${role} packet 身份不一致。`);
    if (packet.assignedReviewerId !== assignments.get(role)) errors.push(`${role} packet reviewer assignment 已过期。`);
    if (packet.inputPolicy?.isolation !== "packet-only") errors.push(`${role} packet 未声明 packet-only 输入隔离。`);
    const artifactKey = expectedArtifactKey(role);
    if (packet.output?.path !== manifest.artifacts?.[artifactKey]) errors.push(`${role} packet 输出路径与 review manifest 不一致。`);
    if (packet.output?.schema !== expectedArtifactSchema(role)) errors.push(`${role} packet 输出 schema 不符合固定契约。`);
    if (role === "alignment" && (packet.needsBlindRecall || record.ready !== true)) errors.push("alignment 仍是占位 packet。");
    errors.push(...packetPayloadRefErrors(role, packet, { claims, segments, deepRead, reviewVersion: manifest.workflowVersion }));
    for (const dependency of record.dependencies ?? []) {
      try {
        const dependencyPath = resolveCasePath(caseDir, dependency.path, `${role} packet dependency`);
        if (!(await exists(dependencyPath)) || await sha256File(dependencyPath) !== dependency.sha256) errors.push(`${role} packet 动态输入已变化：${dependency.path}`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  for (const role of ["adjudicator", "repair_editor"]) {
    const record = packetIndex.packets?.[role];
    if (!record) continue;
    try {
      const packetPath = resolveCasePath(caseDir, record.path, `${role} packet`);
      if (!(await exists(packetPath))) errors.push(`${role} packet 不存在。`);
      else {
        if (!isInside(path.join(reviewRoot, "packets"), packetPath)) errors.push(`${role} packet 必须位于当前 round/packets。`);
        if (await sha256File(packetPath) !== record.sha256) errors.push(`${role} packet hash 不一致。`);
        const packet = await readJson(packetPath);
        if (packet.caseId !== manifest.caseId || packet.reviewRound !== reviewRound || packet.role !== role) errors.push(`${role} packet 身份不一致。`);
        if (packet.assignedReviewerId !== assignments.get(role)) errors.push(`${role} packet reviewer assignment 已过期。`);
        if (packet.inputPolicy?.isolation !== "packet-only") errors.push(`${role} packet 未声明 packet-only 输入隔离。`);
        const artifactKey = expectedArtifactKey(role);
        if (packet.output?.path !== manifest.artifacts?.[artifactKey]) errors.push(`${role} packet 输出路径与 review manifest 不一致。`);
        if (packet.output?.schema !== expectedArtifactSchema(role)) errors.push(`${role} packet 输出 schema 不符合固定契约。`);
        packets.set(role, packet);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const artifacts = { claimReview, claimReviewResolution, claimBundles, evidenceMigration, themeMap };
  for (const [key, role] of REQUIRED_REPORTS) {
    let filePath;
    try {
      filePath = artifactPath(caseDir, manifest, key);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (!filePath || !(await exists(filePath))) {
      if (requireReports) errors.push(`缺少 ${key}（${role}）。`);
      continue;
    }
    artifacts[key] = await readRequiredJson(filePath, key, errors);
    errors.push(...reviewerErrors(artifacts[key], role, assignments, reviewRound));
  }

  const adjudicatorPacket = packets.get("adjudicator");
  if (adjudicatorPacket && artifacts.coverageA && artifacts.coverageB) {
    errors.push(...packetInputHashErrors("adjudicator", adjudicatorPacket, {
      evidence: manifest.inputHashes.evidence,
      deepRead: manifest.inputHashes.deepRead,
      coverageA: sha256Value(artifacts.coverageA),
      coverageB: sha256Value(artifacts.coverageB),
    }));
    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    const coverageAById = new Map((artifacts.coverageA.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
    const coverageBById = new Map((artifacts.coverageB.entries ?? []).map((entry) => [entry.evidenceRef, entry]));
    const eligibleLeaves = eligibleReaderLeaves(deepRead);
    const coverageClaimIds = new Set(coverageClaimsForReview(claims, deepRead, manifest.workflowVersion)
      .map((claim) => claim.id));
    for (const conflict of adjudicatorPacket.payload?.conflicts ?? []) {
      const claim = claimById.get(conflict.evidenceRef);
      if (!claim || !coverageClaimIds.has(claim.id)) {
        errors.push(`adjudicator packet 包含越界 claim：${conflict.evidenceRef}`);
        continue;
      }
      if (!conflict.claim || sha256Value(conflict.claim) !== sha256Value(coverageClaim(claim))) errors.push(`adjudicator packet 改写了 claim：${conflict.evidenceRef}`);
      const expectedCoverageA = coverageAById.get(conflict.evidenceRef);
      const expectedCoverageB = coverageBById.get(conflict.evidenceRef);
      if (!conflict.coverageA || !expectedCoverageA || sha256Value(conflict.coverageA) !== sha256Value(expectedCoverageA)) errors.push(`adjudicator packet 改写了 coverage_a：${conflict.evidenceRef}`);
      if (!conflict.coverageB || !expectedCoverageB || sha256Value(conflict.coverageB) !== sha256Value(expectedCoverageB)) errors.push(`adjudicator packet 改写了 coverage_b：${conflict.evidenceRef}`);
      for (const leaf of conflict.candidateReaderLeaves ?? []) {
        const expected = eligibleLeaves.get(leaf.id);
        if (!expected || sha256Value(leaf) !== sha256Value(stripLeafReferences(expected))) errors.push(`adjudicator packet 包含越界 reader leaf：${leaf.id}`);
      }
    }
  }
  const repairPacket = packets.get("repair_editor");
  if (repairPacket) {
    const recordedRepairRounds = repairPacket.payload?.maximumRepairRounds;
    const consensusPath = path.join(reviewRoot, "consensus.json");
    const consensus = await readRequiredJson(consensusPath, "repair_editor packet 所依赖的 consensus", errors);
    if (consensus) errors.push(...packetInputHashErrors("repair_editor", repairPacket, {
      consensus: sha256Value(consensus),
      evidence: manifest.inputHashes.evidence,
      ...(Object.hasOwn(manifest.inputHashes ?? {}, "evidenceMigration") ? {
        evidenceMigration: manifest.inputHashes.evidenceMigration,
      } : {}),
      ...(Object.hasOwn(manifest.inputHashes ?? {}, "claimBundles") ? {
        claimBundles: manifest.inputHashes.claimBundles,
      } : {}),
      themeMap: manifest.inputHashes.themeMap ?? currentHashes.themeMap,
      deepRead: manifest.inputHashes.deepRead,
      readerMap: manifest.inputHashes.readerMap,
      research: manifest.inputHashes.research,
    }));
    if (consensus && consensus.status !== "repair_required") errors.push("repair_editor packet 只能由 repair_required consensus 触发。");
    if (consensus && sha256Value(repairPacket.payload?.failures ?? []) !== sha256Value(consensus.failures ?? [])) {
      errors.push("repair_editor packet 的 failures 与 consensus 不一致。");
    }
    if (repairPacket.payload?.sourceReviewRound !== reviewRound) {
      errors.push("repair_editor packet 的来源审核轮次不一致。");
    }
    if (consensus && repairPacket.payload?.repairRound !== (consensus.repairAttempt ?? reviewRound)) {
      errors.push("repair_editor packet 的修复次数与 consensus 不一致。");
    }
    const allowedRepairRoundLimits = new Set([
      pipelineConfig.reviews?.maximumRepairRounds ?? 2,
      maximumRepairRounds,
    ]);
    if (!allowedRepairRoundLimits.has(recordedRepairRounds)
      || recordedRepairRounds > maximumRepairRounds
      || !Number.isInteger(repairPacket.payload?.repairRound)
      || repairPacket.payload.repairRound < 1
      || repairPacket.payload.repairRound > recordedRepairRounds) {
      errors.push("repair_editor packet 超出本案例最多 " + maximumRepairRounds + " 轮修复限制。");
    }
    if (repairPacket.output?.contract?.properties?.repairRound?.maximum !== recordedRepairRounds) {
      errors.push("repair_editor packet 的 schema 上限与已记录修复上限不一致。");
    }
    const expectedAllowedOutputPaths = [
      "work/evidence.jsonl",
      ...(Object.hasOwn(repairPacket.inputHashes ?? {}, "evidenceMigration") ? ["work/evidence-migration.json"] : []),
      ...(Object.hasOwn(repairPacket.inputHashes ?? {}, "claimBundles") ? ["work/claim-bundles.json"] : []),
      "work/theme-map.json",
      "output/deep-read.json",
      "work/reader-map.json",
      "work/research.json",
      manifest.artifacts.repairLog,
    ];
    if (sha256Value(repairPacket.payload?.allowedOutputPaths ?? []) !== sha256Value(expectedAllowedOutputPaths)) {
      errors.push("repair_editor packet.allowedOutputPaths 不符合唯一写入白名单。");
    }
    if (sha256Value(repairPacket.output?.allowedOutputPaths ?? []) !== sha256Value(expectedAllowedOutputPaths)) {
      errors.push("repair_editor packet.output.allowedOutputPaths 与 payload 不一致。");
    }
    const snapshotExpectations = {
      evidence: { path: "work/evidence.jsonl", sha256: manifest.inputHashes.evidence, format: "jsonl", value: claims },
      ...(Object.hasOwn(repairPacket.inputHashes ?? {}, "evidenceMigration") ? {
        evidenceMigration: { path: "work/evidence-migration.json", sha256: manifest.inputHashes.evidenceMigration, format: "json", value: evidenceMigration },
      } : {}),
      ...(Object.hasOwn(repairPacket.inputHashes ?? {}, "claimBundles") ? {
        claimBundles: { path: "work/claim-bundles.json", sha256: manifest.inputHashes.claimBundles, format: "json", value: claimBundles },
      } : {}),
      themeMap: { path: "work/theme-map.json", sha256: manifest.inputHashes.themeMap ?? currentHashes.themeMap, format: "json", value: themeMap },
      deepRead: { path: "output/deep-read.json", sha256: manifest.inputHashes.deepRead, format: "json", value: deepRead },
      readerMap: { path: "work/reader-map.json", sha256: manifest.inputHashes.readerMap, format: "json", value: readerMap },
      research: { path: "work/research.json", sha256: manifest.inputHashes.research, format: "json", value: research },
    };
    for (const [name, expected] of Object.entries(snapshotExpectations)) {
      const actualSnapshot = repairPacket.payload?.editableSnapshots?.[name];
      if (actualSnapshot === undefined) {
        errors.push(`repair_editor packet.payload.editableSnapshots.${name} is missing.`);
        continue;
      }
      if (sha256Value(actualSnapshot) !== sha256Value(expected)) {
        errors.push(`repair_editor packet 的 ${name} 可编辑快照或哈希绑定不一致。`);
      }
    }
    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    const sourceById = new Map(normalized.map((unit) => [unit.id, unit]));
    for (const claim of repairPacket.payload?.failedClaims ?? []) {
      const expected = claimById.get(claim.id);
      if (!expected || sha256Value(stripPacketClaim(claim)) !== sha256Value(expected)) errors.push(`repair_editor packet 改写了失败 claim：${claim.id}`);
      errors.push(...embeddedClaimSourceErrors("repair_editor", claim, sourceById));
    }
    const leaves = readerLeafIndex(deepRead);
    for (const leaf of repairPacket.payload?.readerLeaves ?? []) {
      const expected = leaves.get(leaf.id);
      if (!expected || sha256Value(leaf) !== sha256Value(expected)) errors.push(`repair_editor packet 改写了 reader leaf：${leaf.id}`);
    }
    for (const [name, expectedReview] of [
      ["coverageA", artifacts.coverageA],
      ["coverageB", artifacts.coverageB],
      ["fidelity", artifacts.fidelityReview],
    ]) {
      const embeddedReview = repairPacket.payload?.reviews?.[name];
      if (embeddedReview === undefined) {
        errors.push(`repair_editor packet.payload.reviews.${name} is missing.`);
      } else if (expectedReview === undefined) {
        errors.push(`repair_editor packet.payload.reviews.${name} has no retained report to validate against.`);
      } else if (sha256Value(embeddedReview) !== sha256Value(expectedReview)) {
        errors.push(`repair_editor packet.payload.reviews.${name} does not match the retained report.`);
      }
    }
    const readerFailure = (consensus?.failures ?? []).find((failure) => failure.gate === "reader_advocate");
    if (readerFailure && repairPacket.payload?.referenceFreeReaderEdition !== packets.get("reader_advocate")?.payload?.readerMarkdown) {
      errors.push("repair_editor packet 缺少层级修复所需的 reference-free reader edition。");
    }
  }

  if (artifacts.claimReviewResolution) errors.push(...claimReviewResolutionContractErrors(artifacts.claimReviewResolution, {
    caseId: manifest.caseId,
    workflowVersion: (await readJson(path.join(caseDir, "case.json"))).workflow?.version,
    reviewRound,
    claims,
    segmentsHash: currentHashes.segments,
    evidenceHash: currentHashes.evidence,
    primary: artifacts.claimReview,
    mechanicalFix,
    secondary: secondaryClaimReview,
    adjudication: claimAdjudication,
  }));
  if (claimBundles && artifacts.claimReview) errors.push(...claimBundleContractErrors(claimBundles, {
    caseId: manifest.caseId,
    claims,
    claimReviewHash: sha256Value(artifacts.claimReview),
    evidenceHash: currentHashes.evidence,
    deepRead,
    readerMap,
  }));
  const oldEvidencePath = path.join(caseDir, "legacy", "workflow-2.1.0", "work", "evidence.jsonl");
  if (evidenceMigration) {
    if (!(await exists(oldEvidencePath))) {
      errors.push("evidenceMigration 存在，但缺少 legacy/workflow-2.1.0/work/evidence.jsonl。");
    } else {
      const oldClaims = await readJsonLines(oldEvidencePath);
      errors.push(...evidenceMigrationContractErrors(evidenceMigration, {
        caseId: manifest.caseId,
        oldClaims,
        newClaims: claims,
      }));
    }
  } else if (await exists(oldEvidencePath)) {
    errors.push("存在 workflow-2.1.0 证据基线，但本轮缺少 work/evidence-migration.json。");
  }
  if (artifacts.blindCandidates) {
    errors.push(...blindCandidateContractErrors(artifacts.blindCandidates, { caseId: manifest.caseId, segmentsHash: currentHashes.segments }));
    errors.push(...blindSupportErrors(artifacts.blindCandidates, segments));
  }
  if (artifacts.blindAlignment && artifacts.blindCandidates) errors.push(...blindAlignmentContractErrors(artifacts.blindAlignment, {
    caseId: manifest.caseId,
    candidates: artifacts.blindCandidates,
    claims,
    evidenceHash: currentHashes.evidence,
  }));
  const repairerId = assignments.get("repair_editor");
  if (artifacts.coverageA) errors.push(...coverageReviewContractErrors(artifacts.coverageA, {
    caseId: manifest.caseId,
    claims,
    deepRead,
    evidenceHash: currentHashes.evidence,
    deepReadHash: currentHashes.deepRead,
    expectedRole: "coverage_a",
    forbiddenReviewerIds: [assignments.get("coverage_b"), repairerId],
  }));
  if (artifacts.coverageB) errors.push(...coverageReviewContractErrors(artifacts.coverageB, {
    caseId: manifest.caseId,
    claims,
    deepRead,
    evidenceHash: currentHashes.evidence,
    deepReadHash: currentHashes.deepRead,
    expectedRole: "coverage_b",
    forbiddenReviewerIds: [assignments.get("coverage_a"), repairerId],
  }));
  if (artifacts.fidelityReview) errors.push(...fidelityReviewContractErrors(artifacts.fidelityReview, {
    caseId: manifest.caseId,
    claims,
    deepRead,
    research,
    evidenceHash: currentHashes.evidence,
    deepReadHash: currentHashes.deepRead,
    researchHash: sha256Value(research),
    forbiddenReviewerIds: [repairerId],
    requirePass: false,
  }));
  if (artifacts.readerReview) {
    const packet = packets.get("reader_advocate");
    const readerMarkdownHash = packet?.inputHashes?.readerMarkdown ?? sha256Text(deepMarkdown);
    if (packet && sha256Text(packet.payload.readerMarkdown) !== readerMarkdownHash) errors.push("reader_advocate packet 的 markdown hash 不一致。");
    errors.push(...readerReviewContractErrors(artifacts.readerReview, {
      caseId: manifest.caseId,
      deepRead,
      readerMarkdownHash,
      deepReadHash: currentHashes.deepRead,
    }));
  }

  if (artifacts.blindCandidates && artifacts.blindAlignment) {
    const metrics = blindRecallMetrics(artifacts.blindCandidates, artifacts.blindAlignment);
    const allRecallRequired = pipelineConfig.qualityGates?.allClaimRecall ?? 0.95;
    const highMediumRecallRequired = 1;
    if (metrics.allRecall < allRecallRequired || metrics.highMediumRecall < highMediumRecallRequired) {
      const alignmentByRef = new Map((artifacts.blindAlignment.entries ?? []).map((entry) => [entry.candidateRef, entry]));
      diagnostics.push({
        gate: "blind_recall",
        severity: "warning",
        enforced: false,
        metrics,
        required: { allRecall: allRecallRequired, highMediumRecall: highMediumRecallRequired },
        issues: (artifacts.blindCandidates.entries ?? []).flatMap((candidate) => {
          const alignment = alignmentByRef.get(candidate.id);
          return ["equivalent", "subsumed"].includes(alignment?.relation) ? [] : [{ candidate, alignment: alignment ?? null }];
        }),
      });
      warnings.push(`Blind Recall is below its diagnostic target (all=${metrics.allRecall}, high/medium=${metrics.highMediumRecall}).`);
    }
  }
  if (artifacts.fidelityReview) {
    const entries = fidelityReviewGateFailures(artifacts.fidelityReview, { research });
    if (entries.length) hardErrors.push({
      gate: "fidelity",
      kind: "concrete_hard_error",
      entries,
    });
    const warningEntries = fidelityReviewWarnings(artifacts.fidelityReview);
    if (warningEntries.length) {
      diagnostics.push({
        gate: "fidelity",
        kind: "non_blocking_fidelity_warning",
        severity: "warning",
        enforced: false,
        entries: warningEntries,
      });
      warnings.push(`${warningEntries.length} Fidelity findings are non-blocking warnings.`);
    }
  }
  if (artifacts.readerReview) {
    const findings = readerReviewGateFailures(artifacts.readerReview);
    if (findings.length) {
      diagnostics.push({
        gate: "reader_advocate",
        severity: "warning",
        enforced: false,
        ...findings[0],
      });
      warnings.push("Reader Advocate scores or verdict are below the diagnostic target.");
    }
  }

  for (const [role, packet] of packets) {
    if (["adjudicator", "repair_editor"].includes(role)) continue;
    errors.push(...packetSnapshotErrors(role, packet, {
      normalized,
      segments,
      claims,
      deepRead,
      deepMarkdown,
      research,
      artifacts,
      currentHashes,
      reviewVersion: manifest.workflowVersion,
    }));
  }

  let adjudicationPath = null;
  try {
    adjudicationPath = artifactPath(caseDir, manifest, "adjudication");
  } catch (error) {
    errors.push(error.message);
  }
  if (includeAdjudication && adjudicationPath && await exists(adjudicationPath)) {
    artifacts.adjudication = await readRequiredJson(adjudicationPath, "adjudication", errors);
    errors.push(...reviewerErrors(artifacts.adjudication, "adjudicator", assignments, reviewRound));
    const adjudicatorPacket = packets.get("adjudicator");
    if (!adjudicatorPacket) {
      errors.push("adjudication 存在，但缺少隔离的 adjudicator packet。");
    } else if (artifacts.adjudication) {
      const expected = new Map((adjudicatorPacket.payload?.conflicts ?? []).map((item) => [item.evidenceRef, item]));
      const actual = new Map((artifacts.adjudication.entries ?? []).map((item) => [item.evidenceRef, item]));
      for (const [ref, conflict] of expected) {
        const decision = actual.get(ref);
        if (!decision) errors.push(`adjudication 缺少 packet 指定的冲突 claim：${ref}`);
        else for (const trigger of conflict.triggers ?? []) if (!decision.triggers?.includes(trigger)) errors.push(`adjudication ${ref} 缺少 trigger：${trigger}`);
      }
      for (const ref of actual.keys()) if (!expected.has(ref)) errors.push(`adjudication 越界裁决无争议 claim：${ref}`);
    }
    if (artifacts.coverageA && artifacts.coverageB) errors.push(...adjudicationContractErrors(artifacts.adjudication, {
      caseId: manifest.caseId,
      claims,
      deepRead,
      coverageA: artifacts.coverageA,
      coverageB: artifacts.coverageB,
      evidenceHash: currentHashes.evidence,
      deepReadHash: currentHashes.deepRead,
      forbiddenReviewerIds: [assignments.get("coverage_a"), assignments.get("coverage_b"), repairerId],
    }));
  } else if (includeAdjudication && requireAdjudication) {
    errors.push("当前覆盖分歧需要 adjudication，但报告不存在。");
  }

  let repairLogPath = null;
  try {
    repairLogPath = artifactPath(caseDir, manifest, "repairLog");
  } catch (error) {
    errors.push(error.message);
  }
  if (repairLogPath && await exists(repairLogPath)) {
    artifacts.repairLog = await readRequiredJson(repairLogPath, "repairLog", errors);
    const consensusPath = path.join(reviewRoot, "consensus.json");
    const consensus = await readRequiredJson(consensusPath, "repairLog 所依赖的 consensus", errors);
    if (!packets.has("repair_editor")) errors.push("repairLog 存在，但缺少对应的 repair_editor packet。");
    if (consensus && consensus.status !== "repair_required") errors.push("repairLog 只能对应 repair_required consensus。");
    if (artifacts.repairLog && consensus) errors.push(...repairLogContractErrors(artifacts.repairLog, {
      caseId: manifest.caseId,
      reviewRound,
      reviewerId: assignments.get("repair_editor"),
      consensusHash: sha256Value(consensus),
      evidenceBeforeHash: manifest.inputHashes.evidence,
      evidenceMigrationBeforeHash: manifest.inputHashes.evidenceMigration,
      claimBundlesBeforeHash: manifest.inputHashes.claimBundles,
      themeMapBeforeHash: repairPacket?.inputHashes?.themeMap,
      deepReadBeforeHash: manifest.inputHashes.deepRead,
      readerMapBeforeHash: manifest.inputHashes.readerMap,
      researchBeforeHash: manifest.inputHashes.research,
      evidenceAfterHash: currentHashes.evidence,
      evidenceMigrationAfterHash: currentHashes.evidenceMigration,
      claimBundlesAfterHash: currentHashes.claimBundles,
      themeMapAfterHash: currentHashes.themeMap,
      deepReadAfterHash: currentHashes.deepRead,
      readerMapAfterHash: currentHashes.readerMap,
      researchAfterHash: currentHashes.research,
      maximumRepairRounds: repairPacket?.payload?.maximumRepairRounds ?? maximumRepairRounds,
    }));
  }

  return {
    reviewRoot,
    manifest,
    packetIndex,
    currentHashes,
    source: { normalized, segments, claims, deepRead, readerMap, deepMarkdown, research },
    artifacts,
    packets,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    diagnostics,
    hardErrors,
    reportFailures,
  };
}

function parseCli(argv) {
  const result = { caseArgument: argv[0], reviewRound: 1, allowMissing: false, requireAdjudication: false, repairDiagnostic: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--round") result.reviewRound = Number(argv[++index]);
    else if (argv[index] === "--allow-missing") result.allowMissing = true;
    else if (argv[index] === "--require-adjudication") result.requireAdjudication = true;
    else if (argv[index] === "--repair-diagnostic") result.repairDiagnostic = true;
    else throw new Error(`未知参数：${argv[index]}`);
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const caseDir = resolveCaseDir(options.caseArgument);
    const result = options.repairDiagnostic
      ? await validateRepairDiagnostic(caseDir, options.reviewRound, { requireReports: !options.allowMissing })
      : await validateReviewRound(caseDir, options.reviewRound, {
          requireReports: !options.allowMissing,
          requireAdjudication: options.requireAdjudication,
        });
    for (const warning of result.warnings ?? []) console.warn(`WARN  ${warning}`);
    for (const diagnostic of result.diagnostics ?? []) console.warn(`DIAG  ${diagnostic.gate}`);
    for (const failure of result.hardErrors ?? result.reportFailures ?? result.failures ?? []) console.error(`HARD  ${failure.gate}`);
    for (const error of result.errors) console.error(`ERROR ${error}`);
    const failureCount = (result.hardErrors ?? result.reportFailures ?? result.failures ?? []).length;
    console.log(`${result.errors.length || failureCount ? "FAIL" : "PASS"} ${toPosix(path.relative(REPO_ROOT, result.reviewRoot ?? result.root))}`);
    if (result.errors.length || failureCount) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
