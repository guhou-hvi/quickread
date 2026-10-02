import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMain,
  readJson,
  readJsonLines,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";
import { resolveClaimReview } from "./claim-review-gate.mjs";
import { claimOrganizationWarningDispositions, claimReviewResolutionContractErrors, isLegacyMissingSupportQuoteEntry, sha256Value } from "./review-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_VERSION = "2.2.1";
const MECHANICAL_REPORT = "work/claim-mechanical-fix.json";
const SECONDARY_REPORT = "work/claim-review-secondary.json";
const ADJUDICATION_REPORT = "work/claim-adjudication.json";
const RESOLUTION_REPORT = "work/claim-review-resolution.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const SECONDARY_INSTRUCTIONS = `# Targeted secondary Claim Auditor

Review only the claims in this packet. They were selected by a mechanical gate, but the primary auditor's verdict, findings, issues, rationale, and identity are deliberately hidden. Judge every claim independently against its supplied evidence, source segments, and the hash-bound theme definitions. Use those definitions when assessing theme_misclassified.

Return only JSON matching output.contract. Use schemaVersion 1.1.0, auditMode targeted, the exact assignedReviewerId, reviewRound, inputHashes, scope.evidenceRefs, and one entry per scoped claim. Do not open the primary report, other reviews, reader artifacts, prompts, schemas, or user discussion outside this packet.`;

const ADJUDICATOR_INSTRUCTIONS = `# Anonymous Claim Adjudicator

Resolve only the conflicts in this packet. The two option labels are opaque selection keys; reviewer identities and raw rationales are not disclosed. Select primary or secondary only when the supplied claim, source segments, and hash-bound theme definitions support that option. Select original when both supplied options are wrong but the original claim itself is fully supported and needs no repair. Use payload.referencedClaims to assess any duplicate/merge choice, and use the theme definitions for theme_misclassified conflicts. Select unreviewable only when the source context is genuinely insufficient to choose either option or confirm the original claim.

Return only JSON matching output.contract. Copy the exact assignedReviewerId, reviewRound, inputHashes, evidenceRef, and triggers. Do not invent a third decision or inspect raw auditor reports, other reviews, reader artifacts, prompts, schemas, or user discussion outside this packet.`;

export class ClaimGateOrchestrationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "ClaimGateOrchestrationError";
    this.errors = [...errors];
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function sameSet(left, right) {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function quoteIgnoredEvidenceHash(claims) {
  return sha256Value(claims.map((claim) => ({
    ...claim,
    supportSpans: Array.isArray(claim?.supportSpans)
      ? claim.supportSpans.map((span) => Object.fromEntries(Object.entries(span).filter(([key]) => key !== "quote")))
      : claim?.supportSpans,
  })));
}

function declaredMechanicalFinding(primary) {
  return (primary?.entries ?? []).some((entry) => (
    entry?.findingCodes?.includes("missing_support_quote")
      || (primary?.schemaVersion === "1.0.0" && isLegacyMissingSupportQuoteEntry(entry))
  ));
}

function relativeCasePath(caseDir, filePath) {
  return path.relative(caseDir, filePath).replaceAll("\\", "/");
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

async function optionalJson(filePath) {
  return (await exists(filePath)) ? readJson(filePath) : null;
}

function isClearlyHistoricalReview(report, {
  caseId,
  role,
  reviewRound,
  inputHashes,
  lineageHashKeys,
}) {
  if (!isObject(report) || report.caseId !== caseId || report.role !== role) return false;
  if (Number.isInteger(report.reviewRound)
    && Number.isInteger(reviewRound)
    && report.reviewRound !== reviewRound) return true;
  return lineageHashKeys.some((key) => {
    const actual = report.inputHashes?.[key];
    const expected = inputHashes?.[key];
    return HASH_PATTERN.test(actual ?? "")
      && HASH_PATTERN.test(expected ?? "")
      && actual !== expected;
  });
}

function gatePaths(caseDir, primary, themeMapHash = null) {
  const reviewRound = primary?.reviewRound;
  const roundName = `round-${String(reviewRound).padStart(2, "0")}`;
  const primaryHash = sha256Value(primary);
  const packetRoot = path.join(
    caseDir,
    "work",
    "reviews",
    WORKFLOW_VERSION,
    "claim-gate",
    roundName,
    `claim-gate-${primaryHash.slice(0, 12)}-themes-${themeMapHash?.slice(0, 12) ?? "unbound"}`,
    "packets",
  );
  return {
    primary: path.join(caseDir, "work", "claim-review.json"),
    mechanical: path.join(caseDir, ...MECHANICAL_REPORT.split("/")),
    secondary: path.join(caseDir, ...SECONDARY_REPORT.split("/")),
    adjudication: path.join(caseDir, ...ADJUDICATION_REPORT.split("/")),
    resolution: path.join(caseDir, ...RESOLUTION_REPORT.split("/")),
    secondaryPacket: path.join(packetRoot, "claim_auditor_secondary.json"),
    adjudicatorPacket: path.join(packetRoot, "claim_adjudicator.json"),
  };
}

export function claimGatePaths(caseDir, primary, { themeMapHash = null } = {}) {
  return gatePaths(path.resolve(caseDir), primary, themeMapHash);
}

export function reconstructPreRepairClaims(currentClaims, mechanicalFix) {
  const errors = [];
  if (!Array.isArray(currentClaims)) errors.push("Current evidence must be an array.");
  if (!isObject(mechanicalFix)) errors.push("claim-mechanical-fix must be an object.");
  if (errors.length) throw new ClaimGateOrchestrationError("Cannot reconstruct pre-repair evidence.", errors);

  const preRepairClaims = structuredClone(currentClaims);
  const claimIndexes = new Map();
  for (let index = 0; index < preRepairClaims.length; index += 1) {
    const ref = preRepairClaims[index]?.id;
    if (typeof ref !== "string" || ref.length === 0) errors.push(`Current evidence entry ${index} lacks an id.`);
    else if (claimIndexes.has(ref)) errors.push(`Current evidence contains duplicate claim ${ref}.`);
    else claimIndexes.set(ref, index);
  }

  if (mechanicalFix.inputHashes?.afterEvidence !== sha256Value(currentClaims)) {
    errors.push("claim-mechanical-fix.inputHashes.afterEvidence does not match current evidence.");
  }
  const entries = mechanicalFix.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push("claim-mechanical-fix.entries must be a non-empty array.");
  } else {
    const entryRefs = new Set();
    const visitedPaths = new Set();
    for (const entry of entries) {
      const ref = entry?.evidenceRef;
      if (typeof ref !== "string" || ref.length === 0) {
        errors.push("A claim-mechanical-fix entry lacks evidenceRef.");
        continue;
      }
      if (entryRefs.has(ref)) errors.push(`claim-mechanical-fix.entries contains duplicate ref ${ref}.`);
      entryRefs.add(ref);
      if (entry.findingCode !== "missing_support_quote") errors.push(`claim-mechanical-fix ${ref}.findingCode must be missing_support_quote.`);
      if (entry.status !== "mechanically_resolved") errors.push(`claim-mechanical-fix ${ref}.status must be mechanically_resolved.`);
      const indexes = entry.supportSpanIndexes;
      if (!Array.isArray(indexes) || indexes.length === 0
        || indexes.some((index) => !Number.isInteger(index) || index < 0)
        || new Set(indexes).size !== indexes.length) {
        errors.push(`claim-mechanical-fix ${ref}.supportSpanIndexes must contain unique non-negative integers.`);
        continue;
      }
      const claimIndex = claimIndexes.get(ref);
      if (claimIndex === undefined) {
        errors.push(`claim-mechanical-fix ${ref} does not exist in current evidence.`);
        continue;
      }
      const claim = preRepairClaims[claimIndex];
      for (const spanIndex of indexes) {
        const repairPath = `${ref}.supportSpans[${spanIndex}].quote`;
        if (visitedPaths.has(repairPath)) {
          errors.push(`claim-mechanical-fix repeats repair path ${repairPath}.`);
          continue;
        }
        visitedPaths.add(repairPath);
        const span = claim.supportSpans?.[spanIndex];
        if (!isObject(span)) {
          errors.push(`claim-mechanical-fix path ${repairPath} does not exist.`);
          continue;
        }
        if (!Object.hasOwn(span, "quote")) {
          errors.push(`claim-mechanical-fix path ${repairPath} has no added quote to remove.`);
          continue;
        }
        if (typeof span.quote !== "string" || span.quote.trim().length === 0) {
          errors.push(`claim-mechanical-fix path ${repairPath} does not contain a non-empty quote.`);
          continue;
        }
        delete span.quote;
      }
    }
  }

  const beforeHash = sha256Value(preRepairClaims);
  const beforeQuoteIgnoredHash = quoteIgnoredEvidenceHash(preRepairClaims);
  const afterQuoteIgnoredHash = quoteIgnoredEvidenceHash(currentClaims);
  if (mechanicalFix.inputHashes?.beforeEvidence !== beforeHash) errors.push("Reconstructed evidence does not match claim-mechanical-fix.inputHashes.beforeEvidence.");
  if (mechanicalFix.inputHashes?.beforeQuoteIgnoredEvidence !== beforeQuoteIgnoredHash) errors.push("Reconstructed evidence does not match claim-mechanical-fix.inputHashes.beforeQuoteIgnoredEvidence.");
  if (mechanicalFix.inputHashes?.afterQuoteIgnoredEvidence !== afterQuoteIgnoredHash) errors.push("Current evidence does not match claim-mechanical-fix.inputHashes.afterQuoteIgnoredEvidence.");
  if (beforeQuoteIgnoredHash !== afterQuoteIgnoredHash) errors.push("claim-mechanical-fix changed quote-ignored evidence semantics.");
  if (errors.length) throw new ClaimGateOrchestrationError("Cannot reconstruct pre-repair evidence.", errors);
  return preRepairClaims;
}

async function loadMechanicalBridge(paths, { primary, claims, context }) {
  if (!(await exists(paths.mechanical))) return { present: false, valid: false, mechanicalFix: null, preRepairClaims: null, errors: [] };
  let mechanicalFix;
  try {
    mechanicalFix = await readJson(paths.mechanical);
  } catch (error) {
    return { present: true, valid: false, mechanicalFix: null, preRepairClaims: null, errors: [`Cannot read claim-mechanical-fix.json: ${error.message}`] };
  }
  const errors = [];
  if (mechanicalFix.schemaVersion !== "1.0.0") errors.push("claim-mechanical-fix.schemaVersion must be 1.0.0.");
  if (mechanicalFix.workflowVersion !== WORKFLOW_VERSION) errors.push(`claim-mechanical-fix.workflowVersion must be ${WORKFLOW_VERSION}.`);
  if (mechanicalFix.caseId !== context.caseId) errors.push("claim-mechanical-fix.caseId does not match the case.");
  if (mechanicalFix.role !== "claim_mechanical_fix") errors.push("claim-mechanical-fix.role must be claim_mechanical_fix.");
  if (mechanicalFix.reviewRound !== primary.reviewRound) errors.push("claim-mechanical-fix.reviewRound does not match the primary review round.");
  if (mechanicalFix.inputHashes?.primaryClaimReview !== sha256Value(primary)) errors.push("claim-mechanical-fix.inputHashes.primaryClaimReview does not match the primary review.");
  let preRepairClaims = null;
  try {
    preRepairClaims = reconstructPreRepairClaims(claims, mechanicalFix);
  } catch (error) {
    errors.push(...(error.errors?.length ? error.errors : [error.message]));
  }
  return { present: true, valid: errors.length === 0, mechanicalFix, preRepairClaims: errors.length === 0 ? preRepairClaims : null, errors: uniqueSorted(errors) };
}

function themeDefinitionsFromMap(themeMap, caseId) {
  const errors = [];
  if (!isObject(themeMap)) errors.push("theme-map.json must be an object.");
  if (themeMap?.caseId !== caseId) errors.push("theme-map.json caseId does not match the case.");
  if (!Array.isArray(themeMap?.themes) || themeMap.themes.length === 0) errors.push("theme-map.json themes must be a non-empty array.");
  const definitions = [];
  const ids = new Set();
  for (const theme of themeMap?.themes ?? []) {
    const id = theme?.id;
    const title = theme?.title;
    const thesis = theme?.thesis ?? theme?.summary;
    if (typeof id !== "string" || !/^T[0-9]{3,}$/u.test(id)) errors.push("theme-map.json contains a theme without a valid Txxx id.");
    else if (ids.has(id)) errors.push(`theme-map.json contains duplicate theme ${id}.`);
    else ids.add(id);
    if (typeof title !== "string" || title.trim().length === 0) errors.push(`theme-map.json theme ${id ?? "<missing>"} lacks a title.`);
    if (typeof thesis !== "string" || thesis.trim().length === 0) errors.push(`theme-map.json theme ${id ?? "<missing>"} lacks a thesis/summary.`);
    if (typeof id === "string" && typeof title === "string" && typeof thesis === "string") definitions.push({ id, title, thesis });
  }
  if (errors.length) throw new ClaimGateOrchestrationError("Theme definitions are invalid; no Claim Gate packet was written.", uniqueSorted(errors));
  return definitions;
}

async function loadGateInputs(caseDir) {
  const resolvedCaseDir = path.resolve(caseDir);
  const workDir = path.join(resolvedCaseDir, "work");
  const [primary, claims, segments, themeMap, manifest] = await Promise.all([
    readJson(path.join(workDir, "claim-review.json")),
    readJsonLines(path.join(workDir, "evidence.jsonl")),
    readJsonLines(path.join(workDir, "segments.jsonl")),
    optionalJson(path.join(workDir, "theme-map.json")),
    optionalJson(path.join(resolvedCaseDir, "case.json")),
  ]);
  const caseId = path.basename(resolvedCaseDir);
  if (manifest && manifest.id !== caseId) throw new ClaimGateOrchestrationError("case.json identity does not match the Claim Gate case directory.");
  // A new case is audited before synthesis. An entirely passing primary
  // needs no theme context; every targeted repair still requires real themes.
  const allPass = primary.entries?.length === claims.length
    && primary.entries.every((entry) => entry.verdict === "pass" && !(entry.findingCodes?.length));
  const themeDefinitions = themeMap === null && allPass ? [] : themeDefinitionsFromMap(themeMap, caseId);
  const context = {
    caseId,
    workflowVersion: manifest?.workflow?.version,
    claims,
    segmentsHash: sha256Value(segments),
    evidenceHash: sha256Value(claims),
    themeMapHash: themeMap === null ? null : sha256Value(themeMap),
    themeDefinitions,
    reviewRound: primary.reviewRound,
  };
  const paths = gatePaths(resolvedCaseDir, primary, context.themeMapHash);
  const mechanicalBridge = await loadMechanicalBridge(paths, { primary, claims, context });
  return { caseDir: resolvedCaseDir, primary, claims, segments, context, paths, mechanicalBridge };
}

function claimsWithSegments(claims, segments, targetRefs) {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  return targetRefs.map((ref) => {
    const claim = claimById.get(ref);
    if (!claim) throw new ClaimGateOrchestrationError(`Target claim ${ref} is missing from evidence.jsonl.`);
    const segmentIds = uniqueSorted((claim.supportSpans ?? []).map((span) => span.segmentId));
    const supportSegments = segmentIds.map((segmentId) => {
      const segment = segmentById.get(segmentId);
      if (!segment) throw new ClaimGateOrchestrationError(`Claim ${ref} references missing segment ${segmentId}.`);
      return structuredClone(segment);
    });
    return { ...structuredClone(claim), supportSegments };
  });
}

async function outputContract(schemaName) {
  return readJson(path.join(REPO_ROOT, "schemas", schemaName));
}

function packetBase({ caseId, reviewRound, role, reviewerId, inputHashes, outputPath, schemaPath, contract, instructions, allowed, forbidden }) {
  return {
    schemaVersion: "1.0.0",
    workflowVersion: WORKFLOW_VERSION,
    caseId,
    reviewRound,
    role,
    assignedReviewerId: reviewerId,
    inputHashes,
    output: { path: outputPath, schema: schemaPath, contract },
    reviewInstructions: instructions,
    inputPolicy: {
      isolation: "packet-only",
      instruction: "Read only this packet's payload, reviewInstructions, and output.contract.",
      allowed,
      forbidden,
    },
  };
}

function themePacketContract(stage, context, additionalInputHashes = {}) {
  const inputHashes = {
    themeMap: context.themeMapHash,
    themeDefinitions: sha256Value(context.themeDefinitions),
    ...additionalInputHashes,
  };
  return {
    id: sha256Value({ workflowVersion: WORKFLOW_VERSION, stage, inputHashes }),
    inputHashes,
  };
}

function minimalReferencedClaim(claim) {
  return {
    id: claim.id,
    statement: claim.statement,
    provenance: claim.provenance,
    themeId: claim.themeId,
    supportSpans: structuredClone(claim.supportSpans ?? []),
    supportSegments: structuredClone(claim.supportSegments ?? []),
  };
}

export function adjudicatorReferenceContext(claims, segments, conflicts) {
  const conflictRefs = new Set((conflicts ?? []).map((conflict) => conflict?.evidenceRef).filter(Boolean));
  const referencedRefs = uniqueSorted((conflicts ?? []).flatMap((conflict) => [
    ...(conflict?.primary?.remedy?.mergeWithRefs ?? []),
    ...(conflict?.secondary?.remedy?.mergeWithRefs ?? []),
  ]).filter((ref) => !conflictRefs.has(ref)));
  const invalidRefs = referencedRefs.filter((ref) => !/^E[0-9]{4,}$/u.test(ref));
  if (invalidRefs.length) {
    throw new ClaimGateOrchestrationError("Adjudicator merge-reference context is invalid.", invalidRefs.map((ref) => `Referenced claim ID is invalid: ${ref}.`));
  }
  let referencedClaims;
  try {
    referencedClaims = claimsWithSegments(claims, segments, referencedRefs).map(minimalReferencedClaim);
  } catch (error) {
    throw new ClaimGateOrchestrationError(
      "Adjudicator merge-reference context is incomplete.",
      error.errors?.length ? error.errors : [error.message],
    );
  }
  return { referencedRefs, referencedClaims, hash: sha256Value(referencedClaims) };
}

function contextBoundAdjudicatorPath(basePath, packet) {
  const contextHash = packet.packetContract.inputHashes.referencedClaims;
  return path.join(path.dirname(basePath), `referenced-${contextHash.slice(0, 12)}`, path.basename(basePath));
}

async function secondaryPacket({ caseDir, primary, claims, segments, context, targetRefs, reviewerId }) {
  const primaryHash = sha256Value(primary);
  const inputHashes = {
    segments: context.segmentsHash,
    evidence: context.evidenceHash,
    primaryClaimReview: primaryHash,
    targetSet: sha256Value(uniqueSorted(targetRefs)),
  };
  return {
    ...packetBase({
      caseId: context.caseId,
      reviewRound: primary.reviewRound,
      role: "claim_auditor",
      reviewerId,
      inputHashes,
      outputPath: SECONDARY_REPORT,
      schemaPath: "schemas/claim-review.schema.json",
      contract: await outputContract("claim-review.schema.json"),
      instructions: SECONDARY_INSTRUCTIONS,
      allowed: ["targeted claims", "their support spans", "their exact source segments", "hash-bound theme definitions"],
      forbidden: ["primary claim-review", "primary verdicts or rationales", "all other reviews", "reader artifacts", "user discussion"],
    }),
    gateStage: "targeted_secondary",
    packetContract: themePacketContract("targeted_secondary", context),
    payload: {
      blindToPrimaryDecision: true,
      themeDefinitions: structuredClone(context.themeDefinitions),
      scope: { evidenceRefs: uniqueSorted(targetRefs) },
      claims: claimsWithSegments(claims, segments, uniqueSorted(targetRefs)),
    },
  };
}

async function adjudicatorPacket({ primary, secondary, claims, segments, context, conflicts, reviewerId }) {
  const conflictRefs = conflicts.map((conflict) => conflict.evidenceRef).sort();
  const packetClaims = new Map(claimsWithSegments(claims, segments, conflictRefs).map((claim) => [claim.id, claim]));
  const referenceContext = adjudicatorReferenceContext(claims, segments, conflicts);
  return {
    ...packetBase({
      caseId: context.caseId,
      reviewRound: primary.reviewRound,
      role: "claim_adjudicator",
      reviewerId,
      inputHashes: {
        segments: context.segmentsHash,
        evidence: context.evidenceHash,
        primaryClaimReview: sha256Value(primary),
        secondaryClaimReview: sha256Value(secondary),
        targetSet: sha256Value(conflictRefs),
      },
      outputPath: ADJUDICATION_REPORT,
      schemaPath: "schemas/claim-adjudication.schema.json",
      contract: await outputContract("claim-adjudication.schema.json"),
      instructions: ADJUDICATOR_INSTRUCTIONS,
      allowed: ["conflicting normalized decisions", "the disputed claims", "referenced merge claims and their exact source segments", "hash-bound theme definitions"],
      forbidden: ["reviewer identities", "raw primary or secondary reports", "non-conflicting claims", "all other reviews", "reader artifacts", "user discussion"],
    }),
    gateStage: "anonymous_adjudication",
    packetContract: themePacketContract("anonymous_adjudication", context, { referencedClaims: referenceContext.hash }),
    payload: {
      reviewerIdentitiesHidden: true,
      themeDefinitions: structuredClone(context.themeDefinitions),
      scope: { evidenceRefs: conflictRefs },
      referencedClaims: referenceContext.referencedClaims,
      conflicts: conflicts.map((conflict) => ({
        evidenceRef: conflict.evidenceRef,
        triggers: [...conflict.triggers],
        claim: packetClaims.get(conflict.evidenceRef),
        options: {
          primary: structuredClone(conflict.primary),
          secondary: structuredClone(conflict.secondary),
        },
      })),
    },
  };
}

async function writeImmutablePacket(filePath, packet) {
  if (await exists(filePath)) {
    const existing = await readJson(filePath);
    if (sha256Value(existing) !== sha256Value(packet)) {
      throw new ClaimGateOrchestrationError(`Refusing to overwrite an existing isolated packet: ${filePath}`);
    }
    return { reused: true };
  }
  await writeJson(filePath, packet);
  return { reused: false };
}

function addContractErrors(resolution, errors) {
  if (!errors.length) return resolution;
  resolution.status = "invalid";
  resolution.contractErrors = uniqueSorted([...(resolution.contractErrors ?? []), ...errors]);
  return resolution;
}

function assignedReviewerId(value, label) {
  const reviewerId = String(value ?? "").trim();
  if (reviewerId.length < 2) throw new ClaimGateOrchestrationError(`${label} reviewer ID is required.`);
  return reviewerId;
}

function forceMechanicalFixResolution(resolution) {
  return {
    ...resolution,
    status: "needs_mechanical_fix",
    contractErrors: [],
    semanticFailures: [],
    conflicts: [],
    decisions: [],
  };
}

function resolveLoadedGate(loaded, { secondary = null, adjudication = null } = {}) {
  const storedBridge = loaded.mechanicalBridge;
  // A fresh primary report that declares no quote-only repair directly audits
  // the current evidence. An invalid bridge left by an older primary must not
  // block its unrelated semantic findings. Valid bridges remain usable because
  // they can still prove complete historical quote additions outside the
  // current semantic target set.
  const bridge = storedBridge.present
    && !storedBridge.valid
    && !declaredMechanicalFinding(loaded.primary)
    ? { present: false, valid: false, mechanicalFix: null, preRepairClaims: null, errors: [] }
    : storedBridge;
  if (bridge.present && !bridge.valid) {
    const resolution = resolveClaimReview({ primary: loaded.primary, secondary, adjudication, context: loaded.context });
    return { resolution: forceMechanicalFixResolution(resolution), bridgeErrors: bridge.errors, blockedByBridge: true };
  }
  const context = bridge.valid ? { ...loaded.context, preRepairClaims: bridge.preRepairClaims } : loaded.context;
  let resolution = resolveClaimReview({
    primary: loaded.primary,
    mechanicalFix: bridge.valid ? bridge.mechanicalFix : null,
    secondary,
    adjudication,
    context,
  });
  const coreBridgeErrors = (resolution.contractErrors ?? [])
    .filter((error) => error.startsWith("mechanicalFix:"));
  if (coreBridgeErrors.length) {
    resolution = forceMechanicalFixResolution(resolution);
    return { resolution, bridgeErrors: coreBridgeErrors, blockedByBridge: true };
  }
  if (!bridge.present && resolution.status === "invalid" && declaredMechanicalFinding(loaded.primary)) {
    resolution = forceMechanicalFixResolution(resolution);
    return {
      resolution,
      bridgeErrors: [`${MECHANICAL_REPORT} is required to validate repaired support quotes.`],
      blockedByBridge: true,
    };
  }
  return {
    resolution,
    bridgeErrors: [],
    blockedByBridge: resolution.status === "needs_mechanical_fix" && !bridge.valid,
  };
}

async function isolatedPacketErrors(filePath, { expectedStage, expectedRole, expectedReviewerId, expectedPacket }) {
  const errors = [];
  if (!(await exists(filePath))) return [`Missing isolated ${expectedStage} packet.`];
  let packet;
  try {
    packet = await readJson(filePath);
  } catch (error) {
    return [`Cannot read isolated ${expectedStage} packet: ${error.message}`];
  }
  if (packet.gateStage !== expectedStage) errors.push(`Isolated packet gateStage must be ${expectedStage}.`);
  if (packet.role !== expectedRole) errors.push(`Isolated ${expectedStage} packet has the wrong role.`);
  if (packet.assignedReviewerId !== expectedReviewerId) errors.push(`Isolated ${expectedStage} packet reviewer assignment does not match the report.`);
  if (sha256Value(packet) !== sha256Value(expectedPacket)) errors.push(`Isolated ${expectedStage} packet is stale or was modified.`);
  return errors;
}

export async function prepareClaimGate(caseDir, { reviewerId } = {}) {
  const loaded = await loadGateInputs(caseDir);
  const state = resolveLoadedGate(loaded);
  const { resolution } = state;
  if (resolution.status === "invalid") throw new ClaimGateOrchestrationError("Primary claim review is invalid; no targeted packet was written.", resolution.contractErrors);
  const targetRefs = resolution.targetRefs ?? [];
  if (["pass", "needs_mechanical_fix"].includes(resolution.status)) {
    await writeJson(loaded.paths.resolution, resolution);
    return {
      status: resolution.status,
      targetRefs,
      resolution,
      resolutionPath: loaded.paths.resolution,
      bridgeErrors: state.bridgeErrors,
      packetPath: null,
      packet: null,
      reused: false,
    };
  }
  if (resolution.status !== "needs_secondary") {
    throw new ClaimGateOrchestrationError(`Unexpected Claim Gate prepare status: ${resolution.status}.`);
  }
  const secondaryReviewerId = assignedReviewerId(reviewerId, "Secondary Claim Auditor");
  if (secondaryReviewerId === loaded.primary.reviewerId) {
    throw new ClaimGateOrchestrationError("Secondary Claim Auditor must be independent from the primary reviewer.");
  }
  const packet = await secondaryPacket({ ...loaded, targetRefs, reviewerId: secondaryReviewerId });
  const { reused } = await writeImmutablePacket(loaded.paths.secondaryPacket, packet);
  await writeJson(loaded.paths.resolution, resolution);
  return {
    status: "needs_secondary",
    targetRefs,
    resolution,
    resolutionPath: loaded.paths.resolution,
    bridgeErrors: state.bridgeErrors,
    packetPath: loaded.paths.secondaryPacket,
    packet,
    reused,
  };
}

// Read-only consumer check for the optional 2.4.2 disposition. Baselines bind
// its complete resolution; quality recomputes the decision from unchanged
// auditor inputs instead of trusting a stored status or a warning label.
export async function validateClaimOrganizationWarningResolution(caseDir, { manifest, claims, segments, baseline = null }) {
  if (manifest.workflow?.version !== "2.4.2" && !baseline?.claimOrganizationWarningResolution) {
    return { errors: [], warnings: [], resolutionHash: null };
  }
  const primary = await optionalJson(path.join(caseDir, "work", "claim-review.json"));
  const resolution = await optionalJson(path.join(caseDir, "work", "claim-review-resolution.json"));
  const context = { caseId: manifest.id, workflowVersion: manifest.workflow?.version,
    claims, segmentsHash: sha256Value(segments), evidenceHash: sha256Value(claims), reviewRound: primary?.reviewRound };
  const expectedWarnings = primary?.inputHashes?.evidence === context.evidenceHash
    ? claimOrganizationWarningDispositions(primary, context) : [];
  const boundHash = baseline?.claimOrganizationWarningResolution;
  // A later accepted delta may supersede the original full audit. Do not
  // revive an unrelated historical disposition against that newer evidence.
  const currentDisposition = resolution?.inputHashes?.evidence === context.evidenceHash && resolution?.warningDispositions?.length;
  if (!boundHash && !expectedWarnings.length && !currentDisposition) return { errors: [], warnings: [], resolutionHash: null };
  const errors = [];
  if (boundHash && (!resolution || boundHash !== sha256Value(resolution))) errors.push("accepted organization-warning resolution is missing or stale.");
  try {
    const loaded = await loadGateInputs(caseDir);
    const [secondary, adjudication, mechanicalFix] = await Promise.all([
      resolution?.inputHashes?.secondaryClaimReview ? optionalJson(loaded.paths.secondary) : null,
      resolution?.inputHashes?.adjudication ? optionalJson(loaded.paths.adjudication) : null,
      resolution?.inputHashes?.mechanicalFix ? optionalJson(loaded.paths.mechanical) : null,
    ]);
    const recomputed = resolveLoadedGate(loaded, { secondary, adjudication }).resolution;
    if (sha256Value(recomputed) !== sha256Value(resolution)) errors.push("organization-warning resolution does not match the validated Claim Gate inputs.");
    errors.push(...claimReviewResolutionContractErrors(resolution, { ...context, primary, secondary, adjudication, mechanicalFix }));
  } catch (error) {
    errors.push(...(error.errors?.length ? error.errors : [error.message]));
  }
  return { errors, warnings: expectedWarnings, resolutionHash: !errors.length && resolution ? sha256Value(resolution) : null };
}

export async function resolveClaimGate(caseDir, { adjudicatorReviewerId = null } = {}) {
  const loaded = await loadGateInputs(caseDir);
  const [storedSecondary, storedAdjudication] = await Promise.all([
    optionalJson(loaded.paths.secondary),
    optionalJson(loaded.paths.adjudication),
  ]);
  const primaryState = resolveLoadedGate(loaded);
  const primaryTargetRefs = primaryState.resolution.targetRefs ?? [];
  const secondary = isClearlyHistoricalReview(storedSecondary, {
    caseId: loaded.context.caseId,
    role: "claim_auditor",
    reviewRound: loaded.primary.reviewRound,
    inputHashes: {
      segments: loaded.context.segmentsHash,
      evidence: loaded.context.evidenceHash,
      primaryClaimReview: sha256Value(loaded.primary),
      targetSet: sha256Value(uniqueSorted(primaryTargetRefs)),
    },
    // A targetSet mismatch by itself may be a malformed current report. The
    // bound primary hash (or round) is the immutable lineage proof that this
    // fixed-path artifact belongs to an older review.
    lineageHashKeys: ["primaryClaimReview"],
  }) ? null : storedSecondary;
  const secondaryState = resolveLoadedGate(loaded, { secondary });
  const currentConflicts = secondaryState.resolution.conflicts ?? [];
  const adjudication = isClearlyHistoricalReview(storedAdjudication, {
    caseId: loaded.context.caseId,
    role: "claim_adjudicator",
    reviewRound: loaded.primary.reviewRound,
    inputHashes: {
      segments: loaded.context.segmentsHash,
      evidence: loaded.context.evidenceHash,
      primaryClaimReview: sha256Value(loaded.primary),
      secondaryClaimReview: secondary ? sha256Value(secondary) : null,
      targetSet: sha256Value(uniqueSorted(currentConflicts.map((conflict) => conflict.evidenceRef))),
    },
    // Either auditor report changing creates a new conflict lineage. Other
    // malformed fields that still claim this lineage must remain hard errors.
    lineageHashKeys: ["primaryClaimReview", "secondaryClaimReview"],
  }) ? null : storedAdjudication;
  const state = resolveLoadedGate(loaded, { secondary, adjudication });
  let { resolution } = state;
  const orchestrationErrors = [];

  if (secondary && !state.blockedByBridge) {
    const targetRefs = resolution.targetRefs ?? [];
    if (targetRefs.length) {
      const expected = await secondaryPacket({ ...loaded, targetRefs, reviewerId: secondary.reviewerId });
      orchestrationErrors.push(...await isolatedPacketErrors(loaded.paths.secondaryPacket, {
        expectedStage: "targeted_secondary",
        expectedRole: "claim_auditor",
        expectedReviewerId: secondary.reviewerId,
        expectedPacket: expected,
      }));
    }
  }

  if (adjudication && secondary && resolution.conflicts?.length && !state.blockedByBridge) {
    try {
      const expected = await adjudicatorPacket({
        ...loaded,
        secondary,
        conflicts: resolution.conflicts,
        reviewerId: adjudication.reviewerId,
      });
      const expectedPath = contextBoundAdjudicatorPath(loaded.paths.adjudicatorPacket, expected);
      orchestrationErrors.push(...await isolatedPacketErrors(expectedPath, {
        expectedStage: "anonymous_adjudication",
        expectedRole: "claim_adjudicator",
        expectedReviewerId: adjudication.reviewerId,
        expectedPacket: expected,
      }));
    } catch (error) {
      orchestrationErrors.push(...(error.errors?.length ? error.errors : [error.message]).map((detail) => `adjudicator reference context: ${detail}`));
    }
  }
  resolution = addContractErrors(resolution, orchestrationErrors);

  let adjudicatorPacketPath = null;
  let packet = null;
  let reused = false;
  if (resolution.status === "needs_adjudication" && !adjudication) {
    const reviewerId = assignedReviewerId(adjudicatorReviewerId, "Claim Adjudicator");
    if ([loaded.primary.reviewerId, secondary?.reviewerId].includes(reviewerId)) {
      throw new ClaimGateOrchestrationError("Claim Adjudicator must be independent from both Claim Auditors.");
    }
    try {
      packet = await adjudicatorPacket({ ...loaded, secondary, conflicts: resolution.conflicts, reviewerId });
      adjudicatorPacketPath = contextBoundAdjudicatorPath(loaded.paths.adjudicatorPacket, packet);
      const writeResult = await writeImmutablePacket(adjudicatorPacketPath, packet);
      reused = writeResult.reused;
    } catch (error) {
      resolution = addContractErrors(
        resolution,
        (error.errors?.length ? error.errors : [error.message]).map((detail) => `adjudicator reference context: ${detail}`),
      );
      packet = null;
      adjudicatorPacketPath = null;
    }
  }

  await writeJson(loaded.paths.resolution, resolution);
  return {
    resolution,
    resolutionPath: loaded.paths.resolution,
    adjudicatorPacketPath,
    packet,
    reused,
    bridgeErrors: state.bridgeErrors,
  };
}

function optionValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    if (!names.includes(args[index])) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new ClaimGateOrchestrationError(`${args[index]} requires a value.`);
    return value;
  }
  return null;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/claim-gate.mjs prepare cases/<slug> --reviewer <secondary-reviewer-id>",
    "  node scripts/claim-gate.mjs resolve cases/<slug> [--reviewer <adjudicator-reviewer-id>]",
  ].join("\n");
}

async function main() {
  const [command, caseArgument, ...args] = process.argv.slice(2);
  if (!["prepare", "resolve"].includes(command) || !caseArgument) throw new ClaimGateOrchestrationError(usage());
  const caseDir = resolveCaseDir(caseArgument);
  if (command === "prepare") {
    const result = await prepareClaimGate(caseDir, { reviewerId: optionValue(args, ["--reviewer", "--secondary"]) });
    console.log(JSON.stringify({ status: result.status, targetRefs: result.targetRefs, resolutionPath: relativeCasePath(caseDir, result.resolutionPath), packetPath: result.packetPath ? relativeCasePath(caseDir, result.packetPath) : null, bridgeErrors: result.bridgeErrors, reused: result.reused }, null, 2));
    return;
  }
  const result = await resolveClaimGate(caseDir, { adjudicatorReviewerId: optionValue(args, ["--reviewer", "--adjudicator"]) });
  console.log(JSON.stringify({ status: result.resolution.status, resolutionPath: relativeCasePath(caseDir, result.resolutionPath), adjudicatorPacketPath: result.adjudicatorPacketPath ? relativeCasePath(caseDir, result.adjudicatorPacketPath) : null, bridgeErrors: result.bridgeErrors, reused: result.reused }, null, 2));
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    for (const detail of error.errors ?? []) console.error(`- ${detail}`);
    process.exitCode = 1;
  });
}
