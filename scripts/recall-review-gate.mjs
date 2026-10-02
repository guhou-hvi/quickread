import { sha256Value } from "./review-contract.mjs";

export const RECALL_VALIDITIES = Object.freeze([
  "valid",
  "question",
  "navigation",
  "asr_fragment",
  "incomplete",
  "subsumed",
]);
export const RECALL_IMPORTANCES = Object.freeze(["high", "medium", "low", "excluded"]);
export const RECALL_RELATIONS = Object.freeze(["equivalent", "subsumed", "partial", "unmatched", "disputed"]);
export const RECALL_TRIGGER_CODES = Object.freeze([
  "high_exclusion",
  "high_downgrade",
  "high_nonmaterial_partial",
  "high_boundary",
  "medium_boundary",
]);

function unique(values) {
  return [...new Set(values)];
}

function sameSet(actual, expected) {
  return Array.isArray(actual)
    && new Set(actual).size === actual.length
    && actual.length === expected.length
    && actual.every((value) => expected.includes(value));
}

function entryMap(entries = [], key, errors, label) {
  const map = new Map();
  if (!Array.isArray(entries)) {
    errors.push(`${label} must be an array.`);
    return map;
  }
  for (const entry of entries) {
    const ref = entry?.[key];
    if (!ref) errors.push(`${label} contains an entry without ${key}.`);
    else if (map.has(ref)) errors.push(`${label} repeats ${ref}.`);
    else map.set(ref, entry);
  }
  return map;
}

function triggerCodes(candidate, alignment) {
  const triggers = [];
  const original = candidate?.importance;
  const calibrated = alignment?.calibratedImportance;
  const validity = alignment?.candidateValidity;
  const relation = alignment?.relation;
  if (original === "high") {
    if (validity !== "valid" || calibrated === "excluded") triggers.push("high_exclusion");
    else if (calibrated !== "high") triggers.push("high_downgrade");
    if (relation === "partial" && alignment?.materialFacet === false) triggers.push("high_nonmaterial_partial");
    if (relation === "disputed") triggers.push("high_boundary");
  }
  if ((original === "medium" || calibrated === "medium") && ["partial", "unmatched"].includes(relation)) {
    triggers.push("medium_boundary");
  }
  return unique(triggers);
}

export function recallAdjudicationTargets(candidates, alignment) {
  const aligned = new Map((alignment?.entries ?? []).map((entry) => [entry.candidateRef, entry]));
  return (candidates?.entries ?? []).flatMap((candidate) => {
    const entry = aligned.get(candidate.id);
    const triggers = triggerCodes(candidate, entry);
    return triggers.length ? [{ candidateRef: candidate.id, triggers }] : [];
  });
}

function decisionErrors(entry, candidate, claimsById, label) {
  const errors = [];
  if (!RECALL_VALIDITIES.includes(entry?.candidateValidity)) errors.push(`${label}.candidateValidity is invalid.`);
  if (!RECALL_IMPORTANCES.includes(entry?.calibratedImportance)) errors.push(`${label}.calibratedImportance is invalid.`);
  if (!RECALL_RELATIONS.includes(entry?.relation)) errors.push(`${label}.relation is invalid.`);
  if (typeof entry?.materialFacet !== "boolean") errors.push(`${label}.materialFacet must be boolean.`);
  if (!Array.isArray(entry?.matchedEvidenceRefs)) errors.push(`${label}.matchedEvidenceRefs must be an array.`);
  if (!Array.isArray(entry?.missingFacets)) errors.push(`${label}.missingFacets must be an array.`);
  for (const ref of entry?.matchedEvidenceRefs ?? []) if (!claimsById.has(ref)) errors.push(`${label} cites unknown evidence ${ref}.`);
  if (["equivalent", "subsumed"].includes(entry?.relation)) {
    if (!(entry?.matchedEvidenceRefs?.length)) errors.push(`${label} complete match requires evidence refs.`);
    if (entry?.missingFacets?.length) errors.push(`${label} complete match cannot retain missing facets.`);
    if (entry?.materialFacet !== false) errors.push(`${label} complete match must set materialFacet=false.`);
  }
  if (entry?.relation === "partial" && !(entry?.missingFacets?.length)) errors.push(`${label} partial match requires missing facets.`);
  if (["unmatched", "disputed"].includes(entry?.relation) && entry?.matchedEvidenceRefs?.length) {
    errors.push(`${label} ${entry.relation} cannot cite matched evidence.`);
  }
  if (entry?.candidateValidity === "valid" && entry?.calibratedImportance === "excluded") {
    errors.push(`${label} valid candidate cannot be excluded.`);
  }
  if (entry?.candidateValidity !== "valid" && entry?.calibratedImportance !== "excluded") {
    errors.push(`${label} invalid candidate must be excluded.`);
  }
  if (candidate?.importance === "high" && entry?.calibratedImportance !== "high" && entry?.candidateValidity === "valid") {
    // Legal only after adjudication; the caller decides whether this is an Alignment or adjudication report.
  }
  if (entry?.themeId !== null && entry?.themeId !== undefined && !/^T[0-9]{3,}$/u.test(entry.themeId)) {
    errors.push(`${label}.themeId is invalid.`);
  }
  return errors;
}

export function recallAdjudicationContractErrors(adjudication, {
  caseId,
  reviewRound,
  candidates,
  alignment,
  claims = [],
  segmentsHash,
  evidenceHash,
  forbiddenReviewerIds = [],
} = {}) {
  const errors = [];
  const targets = recallAdjudicationTargets(candidates, alignment);
  const expectedRefs = targets.map((entry) => entry.candidateRef);
  const targetHash = sha256Value([...expectedRefs].sort());
  if (!adjudication || typeof adjudication !== "object" || Array.isArray(adjudication)) return ["recall-adjudication is missing."];
  if (adjudication.schemaVersion !== "1.0.0") errors.push("recall-adjudication.schemaVersion must be 1.0.0.");
  if (adjudication.workflowVersion !== "2.2.2") errors.push("recall-adjudication.workflowVersion must be 2.2.2.");
  if (adjudication.caseId !== caseId || adjudication.role !== "recall_adjudicator") errors.push("recall-adjudication identity is invalid.");
  if (adjudication.reviewRound !== reviewRound) errors.push("recall-adjudication reviewRound is stale.");
  if (!adjudication.reviewerId || forbiddenReviewerIds.includes(adjudication.reviewerId)) errors.push("recall adjudicator must be independent.");
  const expectedHashes = {
    segments: segmentsHash,
    evidence: evidenceHash,
    blindCandidates: sha256Value(candidates),
    blindAlignment: sha256Value(alignment),
    targetSet: targetHash,
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (adjudication.inputHashes?.[name] !== expected) errors.push(`recall-adjudication.inputHashes.${name} is stale.`);
  }
  if (!sameSet(adjudication.targetRefs, expectedRefs)) errors.push("recall-adjudication targetRefs do not match the required target set.");
  const targetByRef = new Map(targets.map((entry) => [entry.candidateRef, entry]));
  const candidateById = new Map((candidates?.entries ?? []).map((entry) => [entry.id, entry]));
  const claimsById = new Map(claims.map((entry) => [entry.id, entry]));
  const entries = entryMap(adjudication.entries, "candidateRef", errors, "recall-adjudication.entries");
  for (const [ref, entry] of entries) {
    const target = targetByRef.get(ref);
    if (!target) {
      errors.push(`recall-adjudication adjudicates out-of-scope candidate ${ref}.`);
      continue;
    }
    if (!sameSet(entry.triggers, target.triggers)) errors.push(`recall-adjudication ${ref} triggers are stale.`);
    errors.push(...decisionErrors(entry, candidateById.get(ref), claimsById, `recall-adjudication ${ref}`));
    if (!entry.rationale?.trim()) errors.push(`recall-adjudication ${ref} requires rationale.`);
  }
  for (const ref of expectedRefs) if (!entries.has(ref)) errors.push(`recall-adjudication is missing ${ref}.`);
  return errors;
}

function effectiveDecision(candidate, alignmentEntry, adjudicationByRef, targetRefs) {
  const decision = targetRefs.has(candidate.id) ? adjudicationByRef.get(candidate.id) : alignmentEntry;
  return {
    candidateRef: candidate.id,
    originalImportance: candidate.importance,
    candidateValidity: decision?.candidateValidity,
    calibratedImportance: decision?.calibratedImportance,
    relation: decision?.relation,
    matchedEvidenceRefs: decision?.matchedEvidenceRefs ?? [],
    missingFacets: decision?.missingFacets ?? [],
    materialFacet: decision?.materialFacet,
    themeId: decision?.themeId ?? null,
    source: targetRefs.has(candidate.id) ? "adjudication" : "alignment",
  };
}

function recalled(entry) {
  return ["equivalent", "subsumed"].includes(entry.relation)
    || (entry.relation === "partial" && entry.materialFacet === false);
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 1;
}

function themeMetrics(entries, claims) {
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const groups = new Map();
  for (const entry of entries.filter((item) => ["high", "medium"].includes(item.calibratedImportance))) {
    const themes = unique(entry.matchedEvidenceRefs.map((ref) => claimsById.get(ref)?.themeId).filter(Boolean));
    const key = entry.themeId ?? (themes.length === 1 ? themes[0] : "unassigned");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups].map(([themeId, items]) => {
    const matched = items.filter(recalled).length;
    const materialMissCount = items.filter((entry) => !recalled(entry) && entry.materialFacet !== false).length;
    return {
      themeId,
      candidateCount: items.length,
      matchedCount: matched,
      recall: ratio(matched, items.length),
      materialMissCount,
    };
  }).sort((a, b) => a.themeId.localeCompare(b.themeId));
}

export function resolveRecallReview({
  candidates,
  alignment,
  adjudication = null,
  context = {},
} = {}) {
  const {
    caseId,
    reviewRound,
    segmentsHash,
    evidenceHash,
    claims = [],
    highThreshold = 1,
    mediumThreshold = 0.98,
    overallThreshold = 0.95,
    forbiddenReviewerIds = [],
  } = context;
  const targets = recallAdjudicationTargets(candidates, alignment);
  const targetRefs = targets.map((entry) => entry.candidateRef);
  const targetSet = new Set(targetRefs);
  const inputHashes = {
    segments: segmentsHash,
    evidence: evidenceHash,
    blindCandidates: sha256Value(candidates),
    blindAlignment: sha256Value(alignment),
    targetSet: sha256Value([...targetRefs].sort()),
    ...(adjudication ? { recallAdjudication: sha256Value(adjudication) } : {}),
  };
  const base = {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.2",
    caseId,
    role: "recall_gate",
    reviewRound,
    inputHashes,
    reviewerIds: {
      blindRecall: candidates?.reviewerId ?? null,
      alignment: alignment?.reviewerId ?? null,
      ...(adjudication ? { adjudicator: adjudication.reviewerId ?? null } : {}),
    },
    targetRefs,
  };
  if (targetRefs.length && !adjudication) {
    return { ...base, status: "needs_adjudication", contractErrors: [], warnings: [], failures: [], decisions: [], metrics: null };
  }
  if (adjudication) {
    const errors = recallAdjudicationContractErrors(adjudication, {
      caseId,
      reviewRound,
      candidates,
      alignment,
      claims,
      segmentsHash,
      evidenceHash,
      forbiddenReviewerIds,
    });
    if (errors.length) return { ...base, status: "invalid", contractErrors: errors, warnings: [], failures: [], decisions: [], metrics: null };
  }
  const aligned = new Map((alignment?.entries ?? []).map((entry) => [entry.candidateRef, entry]));
  const adjudicated = new Map((adjudication?.entries ?? []).map((entry) => [entry.candidateRef, entry]));
  const decisions = (candidates?.entries ?? []).map((candidate) => effectiveDecision(candidate, aligned.get(candidate.id), adjudicated, targetSet));
  const valid = decisions.filter((entry) => entry.candidateValidity === "valid" && entry.calibratedImportance !== "excluded");
  const high = valid.filter((entry) => entry.calibratedImportance === "high");
  const medium = valid.filter((entry) => entry.calibratedImportance === "medium");
  const matched = valid.filter(recalled);
  const matchedHigh = high.filter(recalled);
  const matchedMedium = medium.filter(recalled);
  const themes = themeMetrics(valid, claims);
  const themeGaps = themes.filter((entry) => entry.candidateCount >= 3 && entry.materialMissCount >= 2 && entry.recall < 0.95);
  const metrics = {
    candidateCount: decisions.length,
    validCandidateCount: valid.length,
    excludedCount: decisions.length - valid.length,
    matchedCount: matched.length,
    allRecall: ratio(matched.length, valid.length),
    highCandidateCount: high.length,
    highMatchedCount: matchedHigh.length,
    highRecall: ratio(matchedHigh.length, high.length),
    mediumCandidateCount: medium.length,
    mediumMatchedCount: matchedMedium.length,
    mediumRecall: ratio(matchedMedium.length, medium.length),
    nonMaterialPartialCount: valid.filter((entry) => entry.relation === "partial" && entry.materialFacet === false).length,
    thresholds: { high: highThreshold, medium: mediumThreshold, overall: overallThreshold },
    themes,
    themeGaps,
  };
  const warnings = valid
    .filter((entry) => entry.relation === "partial" && entry.materialFacet === false)
    .map((entry) => ({ code: "nonmaterial_partial", candidateRef: entry.candidateRef }));
  const failures = [];
  if (metrics.highRecall < highThreshold) failures.push({ code: "high_recall", actual: metrics.highRecall, required: highThreshold });
  if (metrics.mediumRecall < mediumThreshold) failures.push({ code: "medium_recall", actual: metrics.mediumRecall, required: mediumThreshold });
  if (metrics.allRecall < overallThreshold) failures.push({ code: "overall_recall", actual: metrics.allRecall, required: overallThreshold });
  for (const gap of themeGaps) failures.push({ code: "theme_gap", ...gap });
  return {
    ...base,
    status: failures.length ? "repair_required" : "pass",
    contractErrors: [],
    warnings,
    failures,
    decisions,
    metrics,
  };
}

export function recallResolutionContractErrors(resolution, options = {}) {
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) return ["recall-resolution is missing."];
  const expected = resolveRecallReview(options);
  return sha256Value(resolution) === sha256Value(expected)
    ? []
    : ["recall-resolution is stale or does not match the deterministic Recall Gate result."];
}
