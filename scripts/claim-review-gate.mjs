import { claimOrganizationWarningDispositions, isLegacyMissingSupportQuoteEntry, sha256Value } from "./review-contract.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_REF_PATTERN = /^E[0-9]{4,}$/u;
const REVIEW_VERSIONS = new Set(["1.0.0", "1.1.0"]);
const VERDICTS = new Set(["pass", "revise", "split", "merge", "remove"]);
const ATOMICITY = new Set(["pass", "fail"]);
const SUPPORT = new Set(["supported", "partial", "unsupported"]);
const IMPORTANCE_VERDICTS = new Set(["confirmed", "change"]);
const IMPORTANCE_VALUES = new Set(["high", "medium", "low", null]);
const THEME_VERDICTS = new Set(["confirmed", "change"]);
const SPEAKER_VERDICTS = new Set(["confirmed", "unknown_safe", "change"]);
const ADJUDICATION_TRIGGERS = new Set(["verdict_conflict", "finding_conflict", "remedy_conflict"]);

export const CLAIM_FINDING_CODES = Object.freeze([
  "compound_claim",
  "support_gap",
  "overstatement",
  "importance_misclassified",
  "theme_misclassified",
  "speaker_attribution_unsafe",
  "duplicate_claim",
  "empty_semantics",
  "other_semantic",
  "missing_support_quote",
]);

const FINDING_CODES = new Set(CLAIM_FINDING_CODES);
const MECHANICAL_FINDING_CODES = new Set(["missing_support_quote"]);
const SEMANTIC_FINDING_CODES = new Set(CLAIM_FINDING_CODES.filter((code) => !MECHANICAL_FINDING_CODES.has(code)));

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function sameSet(left, right) {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function targetSetHash(evidenceRefs) {
  return sha256Value(uniqueSorted(evidenceRefs));
}

function expectedEvidenceHash(context, claims) {
  return context.evidenceHash ?? sha256Value(claims);
}

function cleanPass(entry) {
  return entry?.verdict === "pass"
    && entry.atomicity === "pass"
    && entry.support === "supported"
    && entry.importance?.verdict === "confirmed"
    && entry.importance?.proposed === null
    && entry.theme?.verdict === "confirmed"
    && entry.theme?.proposedThemeId === null
    && ["confirmed", "unknown_safe"].includes(entry.speaker)
    && Array.isArray(entry.issues)
    && entry.issues.length === 0;
}

function inferredFindingCodes(entry, { suppressGeneric = false } = {}) {
  const codes = new Set();
  if (entry?.atomicity === "fail" || entry?.verdict === "split") codes.add("compound_claim");
  if (["partial", "unsupported"].includes(entry?.support)) codes.add("support_gap");
  if (entry?.importance?.verdict === "change") codes.add("importance_misclassified");
  if (entry?.theme?.verdict === "change") codes.add("theme_misclassified");
  if (entry?.speaker === "change") codes.add("speaker_attribution_unsafe");
  if (entry?.verdict === "merge") codes.add("duplicate_claim");
  if (entry?.verdict === "remove") codes.add("empty_semantics");
  if (!cleanPass(entry) && codes.size === 0 && !suppressGeneric) codes.add("other_semantic");
  return [...codes].sort();
}

function findingCodesFor(entry, schemaVersion) {
  if (schemaVersion === "1.1.0" && Array.isArray(entry?.findingCodes)) {
    const suppressGeneric = entry.findingCodes.includes("missing_support_quote");
    return uniqueSorted([...entry.findingCodes, ...inferredFindingCodes(entry, { suppressGeneric })]);
  }
  return inferredFindingCodes(entry);
}

function decisionFromEntry(entry, schemaVersion) {
  return {
    evidenceRef: entry.evidenceRef,
    verdict: entry.verdict,
    findingCodes: cleanPass(entry) ? [] : findingCodesFor(entry, schemaVersion),
    remedy: {
      mergeWithRefs: uniqueSorted(entry.mergeWithRefs ?? []),
      replacementStatements: [...(entry.replacementStatements ?? [])],
      importance: entry.importance?.proposed ?? null,
      themeId: entry.theme?.proposedThemeId ?? null,
      speaker: entry.speaker === "change" ? "change" : null,
    },
  };
}

function decisionWithFindingCodes(decision, allowedCodes) {
  return { ...decision, findingCodes: decision.findingCodes.filter((code) => allowedCodes.has(code)) };
}

function quoteIgnoredEvidenceHash(claims) {
  const withoutQuotes = claims.map((claim) => ({
    ...claim,
    supportSpans: Array.isArray(claim?.supportSpans)
      ? claim.supportSpans.map((span) => Object.fromEntries(Object.entries(span).filter(([key]) => key !== "quote")))
      : claim?.supportSpans,
  }));
  return sha256Value(withoutQuotes);
}

function comparableDecision(decision) {
  return {
    verdict: decision.verdict,
    findingCodes: uniqueSorted(decision.findingCodes),
    remedy: {
      mergeWithRefs: uniqueSorted(decision.remedy.mergeWithRefs),
      replacementCount: decision.remedy.replacementStatements.length,
      importance: decision.remedy.importance,
      themeId: decision.remedy.themeId,
      speaker: decision.remedy.speaker,
    },
  };
}

function conflictTriggers(primaryDecision, secondaryDecision) {
  const triggers = [];
  if (primaryDecision.verdict !== secondaryDecision.verdict) triggers.push("verdict_conflict");
  if (!sameSet(primaryDecision.findingCodes, secondaryDecision.findingCodes)) triggers.push("finding_conflict");
  const primaryRemedy = comparableDecision(primaryDecision).remedy;
  const secondaryRemedy = comparableDecision(secondaryDecision).remedy;
  if (sha256Value(primaryRemedy) !== sha256Value(secondaryRemedy)) triggers.push("remedy_conflict");
  return triggers;
}

function validateStringArray(value, label, errors, { allowed = null, minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  if (value.length < minItems) errors.push(`${label} must contain at least ${minItems} item(s).`);
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) errors.push(`${label} must contain non-empty strings.`);
    else if (allowed && !allowed.has(item)) errors.push(`${label} contains unsupported value ${item}.`);
  }
  const repeated = duplicates(value);
  if (repeated.length) errors.push(`${label} contains duplicate values: ${repeated.join(", ")}.`);
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

function validateHash(actual, expected, label, errors) {
  if (!HASH_PATTERN.test(actual ?? "")) errors.push(`${label} must be a lowercase SHA-256 hash.`);
  else if (expected && actual !== expected) errors.push(`${label} is stale.`);
}

function validateEntry(entry, { claimsById, schemaVersion }, errors) {
  const ref = entry?.evidenceRef ?? "<missing>";
  if (!isObject(entry)) {
    errors.push("claim-review entries must be objects.");
    return;
  }
  if (!EVIDENCE_REF_PATTERN.test(entry.evidenceRef ?? "")) errors.push(`claim-review entry ${ref} has an invalid evidenceRef.`);
  if (!VERDICTS.has(entry.verdict)) errors.push(`claim-review ${ref} has an invalid verdict.`);
  if (!ATOMICITY.has(entry.atomicity)) errors.push(`claim-review ${ref} has an invalid atomicity verdict.`);
  if (!SUPPORT.has(entry.support)) errors.push(`claim-review ${ref} has an invalid support verdict.`);
  if (!isObject(entry.importance)
    || !IMPORTANCE_VERDICTS.has(entry.importance.verdict)
    || !IMPORTANCE_VALUES.has(entry.importance.proposed)) {
    errors.push(`claim-review ${ref} has an invalid importance decision.`);
  } else {
    if (entry.importance.verdict === "confirmed" && entry.importance.proposed !== null) {
      errors.push(`claim-review ${ref} confirms importance but proposes a replacement.`);
    }
    if (entry.importance.verdict === "change" && entry.importance.proposed === null) {
      errors.push(`claim-review ${ref} changes importance without a proposed value.`);
    }
  }
  if (!isObject(entry.theme)
    || !THEME_VERDICTS.has(entry.theme.verdict)
    || !(entry.theme.proposedThemeId === null || /^T[0-9]{3,}$/u.test(entry.theme.proposedThemeId ?? ""))) {
    errors.push(`claim-review ${ref} has an invalid theme decision.`);
  } else {
    if (entry.theme.verdict === "confirmed" && entry.theme.proposedThemeId !== null) {
      errors.push(`claim-review ${ref} confirms theme but proposes a replacement.`);
    }
    if (entry.theme.verdict === "change" && entry.theme.proposedThemeId === null) {
      errors.push(`claim-review ${ref} changes theme without a proposed theme ID.`);
    }
  }
  if (!SPEAKER_VERDICTS.has(entry.speaker)) errors.push(`claim-review ${ref} has an invalid speaker decision.`);
  validateStringArray(entry.issues, `claim-review ${ref}.issues`, errors);
  if (typeof entry.rationale !== "string" || entry.rationale.trim().length === 0) errors.push(`claim-review ${ref} lacks a rationale.`);

  const mergeRefs = entry.mergeWithRefs ?? [];
  if (!Array.isArray(mergeRefs)) errors.push(`claim-review ${ref}.mergeWithRefs must be an array.`);
  else if (entry.verdict === "merge") {
    if (mergeRefs.length !== 1) errors.push(`claim-review ${ref} merge must name exactly one canonical claim.`);
    for (const targetRef of mergeRefs) {
      if (targetRef === ref) errors.push(`claim-review ${ref} cannot merge into itself.`);
      else if (!claimsById.has(targetRef)) errors.push(`claim-review ${ref} merges into unknown claim ${targetRef}.`);
    }
  } else if (mergeRefs.length > 0) {
    errors.push(`claim-review ${ref} carries mergeWithRefs without a merge verdict.`);
  }

  const replacements = entry.replacementStatements ?? [];
  if (!Array.isArray(replacements) || replacements.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    errors.push(`claim-review ${ref}.replacementStatements must contain non-empty strings.`);
  } else {
    if (entry.verdict === "split" && replacements.length < 2) errors.push(`claim-review ${ref} split needs at least two replacement statements.`);
    if (entry.verdict === "pass" && replacements.length > 0) errors.push(`claim-review ${ref} pass cannot carry replacement statements.`);
  }

  if (entry.verdict === "pass" && !cleanPass(entry)) errors.push(`claim-review ${ref} pass contradicts its semantic axes.`);
  if (schemaVersion === "1.1.0") {
    const codes = validateStringArray(entry.findingCodes, `claim-review ${ref}.findingCodes`, errors, { allowed: FINDING_CODES });
    if (entry.verdict === "pass" && codes.length > 0) errors.push(`claim-review ${ref} pass must have no finding codes.`);
    if (entry.verdict !== "pass" && codes.length === 0) errors.push(`claim-review ${ref} nonpass must have at least one finding code.`);
  }
}

/**
 * Separates artifact/contract defects from semantic claim findings.
 *
 * Required context: { caseId, claims, segmentsHash }. For a targeted 1.1 review,
 * callers must also provide targetRefs and primaryClaimReviewHash. evidenceHash
 * and reviewRound are optional expected values.
 */
export function assessClaimReview(review, context = {}) {
  const contractErrors = [];
  const claims = Array.isArray(context.claims) ? context.claims : [];
  if (!Array.isArray(context.claims)) contractErrors.push("context.claims must be an array.");
  if (typeof context.caseId !== "string" || context.caseId.length === 0) contractErrors.push("context.caseId is required.");
  validateHash(context.segmentsHash, null, "context.segmentsHash", contractErrors);

  const claimIds = claims.map((claim) => claim?.id).filter(Boolean);
  const duplicateClaimIds = duplicates(claimIds);
  if (duplicateClaimIds.length) contractErrors.push(`context.claims contains duplicate IDs: ${duplicateClaimIds.join(", ")}.`);
  const claimsById = new Map(claims.map((claim) => [claim?.id, claim]));
  let evidenceHash = context.evidenceHash;
  try {
    evidenceHash = expectedEvidenceHash(context, claims);
  } catch {
    contractErrors.push("context.claims cannot be canonically hashed.");
  }

  if (!isObject(review)) {
    return {
      valid: false,
      auditMode: "full",
      contractErrors: [...contractErrors, "claim-review must be an object."],
      semanticFindings: [],
      mechanicalFindings: [],
      reviewedRefs: [],
    };
  }
  try {
    if (/\uFFFD|\?{2,}/u.test(JSON.stringify(review))) contractErrors.push("claim-review contains corrupted or placeholder text.");
  } catch {
    contractErrors.push("claim-review cannot be serialized.");
  }

  const schemaVersion = review.schemaVersion;
  if (!REVIEW_VERSIONS.has(schemaVersion)) contractErrors.push("claim-review.schemaVersion must be 1.0.0 or 1.1.0.");
  const auditMode = schemaVersion === "1.0.0" ? "full" : review.auditMode;
  if (schemaVersion === "1.1.0" && !["full", "targeted"].includes(auditMode)) {
    contractErrors.push("claim-review.auditMode must be full or targeted for schema 1.1.0.");
  }
  if (context.expectedAuditMode && auditMode !== context.expectedAuditMode) {
    contractErrors.push(`claim-review audit mode must be ${context.expectedAuditMode}.`);
  }
  if (review.caseId !== context.caseId) contractErrors.push("claim-review.caseId does not match the case.");
  if (review.role !== "claim_auditor") contractErrors.push("claim-review.role must be claim_auditor.");
  if (typeof review.reviewerId !== "string" || review.reviewerId.length < 2) contractErrors.push("claim-review.reviewerId is required.");
  if (!Number.isInteger(review.reviewRound) || review.reviewRound < 1) contractErrors.push("claim-review.reviewRound must be a positive integer.");
  if (context.reviewRound && review.reviewRound !== context.reviewRound) contractErrors.push("claim-review.reviewRound does not match the expected round.");
  validateHash(review.inputHashes?.segments, context.segmentsHash, "claim-review.inputHashes.segments", contractErrors);
  validateHash(review.inputHashes?.evidence, evidenceHash, "claim-review.inputHashes.evidence", contractErrors);

  let scopeRefs = claimIds;
  if (schemaVersion === "1.1.0") {
    scopeRefs = validateStringArray(review.scope?.evidenceRefs, "claim-review.scope.evidenceRefs", contractErrors, { minItems: 1 });
    for (const ref of scopeRefs) {
      if (!EVIDENCE_REF_PATTERN.test(ref)) contractErrors.push(`claim-review.scope contains invalid evidence ref ${ref}.`);
      else if (!claimsById.has(ref)) contractErrors.push(`claim-review.scope contains unknown claim ${ref}.`);
    }
  }
  if (auditMode === "targeted") {
    if (!Array.isArray(context.targetRefs) || context.targetRefs.length === 0) {
      contractErrors.push("targeted claim-review requires context.targetRefs.");
    } else if (!sameSet(scopeRefs, context.targetRefs)) {
      contractErrors.push("claim-review.scope.evidenceRefs does not match the expected target set.");
    }
    if (!HASH_PATTERN.test(context.primaryClaimReviewHash ?? "")) {
      contractErrors.push("targeted claim-review requires context.primaryClaimReviewHash.");
    }
    validateHash(review.inputHashes?.primaryClaimReview, context.primaryClaimReviewHash, "claim-review.inputHashes.primaryClaimReview", contractErrors);
    const expectedTargetHash = Array.isArray(context.targetRefs) ? targetSetHash(context.targetRefs) : null;
    validateHash(review.inputHashes?.targetSet, expectedTargetHash, "claim-review.inputHashes.targetSet", contractErrors);
  } else {
    if (schemaVersion === "1.1.0" && !sameSet(scopeRefs, claimIds)) {
      contractErrors.push("full claim-review.scope.evidenceRefs must contain every claim exactly once.");
    }
    if (review.inputHashes && (Object.hasOwn(review.inputHashes, "primaryClaimReview") || Object.hasOwn(review.inputHashes, "targetSet"))) {
      contractErrors.push("full claim-review cannot carry targeted-review hashes.");
    }
  }

  const entries = Array.isArray(review.entries) ? review.entries : [];
  if (!Array.isArray(review.entries) || review.entries.length === 0) contractErrors.push("claim-review.entries must be a non-empty array.");
  const entryRefs = entries.map((entry) => entry?.evidenceRef).filter(Boolean);
  const duplicateEntryRefs = duplicates(entryRefs);
  if (duplicateEntryRefs.length) contractErrors.push(`claim-review.entries contains duplicate evidence refs: ${duplicateEntryRefs.join(", ")}.`);
  for (const entry of entries) {
    validateEntry(entry, { claimsById, schemaVersion }, contractErrors);
    if (entry?.evidenceRef && !claimsById.has(entry.evidenceRef)) contractErrors.push(`claim-review references unknown claim ${entry.evidenceRef}.`);
  }
  const expectedRefs = auditMode === "targeted" && Array.isArray(context.targetRefs) ? context.targetRefs : claimIds;
  if (!sameSet(entryRefs, expectedRefs)) contractErrors.push("claim-review.entries does not exactly cover its required scope.");

  const findings = entries
    .filter((entry) => isObject(entry) && !cleanPass(entry))
    .map((entry) => decisionFromEntry(entry, schemaVersion));
  const semanticFindings = findings
    .filter((finding) => finding.findingCodes.some((code) => SEMANTIC_FINDING_CODES.has(code)))
    .map((finding) => decisionWithFindingCodes(finding, SEMANTIC_FINDING_CODES));
  const mechanicalFindings = findings
    .filter((finding) => finding.findingCodes.some((code) => MECHANICAL_FINDING_CODES.has(code)))
    .map((finding) => decisionWithFindingCodes(finding, MECHANICAL_FINDING_CODES));
  return {
    valid: contractErrors.length === 0,
    auditMode,
    contractErrors,
    semanticFindings,
    mechanicalFindings,
    reviewedRefs: uniqueSorted(entryRefs),
  };
}

function quoteAdditions(beforeClaims, afterClaims, errors) {
  const changes = new Map();
  if (quoteIgnoredEvidenceHash(beforeClaims) !== quoteIgnoredEvidenceHash(afterClaims)) return changes;
  for (let claimIndex = 0; claimIndex < afterClaims.length; claimIndex += 1) {
    const beforeClaim = beforeClaims[claimIndex];
    const afterClaim = afterClaims[claimIndex];
    for (let spanIndex = 0; spanIndex < (afterClaim?.supportSpans?.length ?? 0); spanIndex += 1) {
      const beforeQuote = beforeClaim?.supportSpans?.[spanIndex]?.quote;
      const afterQuote = afterClaim?.supportSpans?.[spanIndex]?.quote;
      if (beforeQuote === afterQuote) continue;
      if (typeof beforeQuote === "string" && beforeQuote.trim().length > 0) {
        errors.push("mechanical fix changed an existing supportSpans.quote at " + afterClaim.id + "[" + spanIndex + "].");
        continue;
      }
      if (typeof afterQuote !== "string" || afterQuote.trim().length === 0) {
        errors.push("mechanical fix did not add a non-empty supportSpans.quote at " + afterClaim.id + "[" + spanIndex + "].");
        continue;
      }
      if (!changes.has(afterClaim.id)) changes.set(afterClaim.id, []);
      changes.get(afterClaim.id).push(spanIndex);
    }
  }
  return changes;
}

function validateMechanicalFix(mechanicalFix, { context, primary, primaryAssessment, beforeClaims, afterClaims }) {
  const errors = [];
  if (!isObject(mechanicalFix)) return { errors: ["claim-mechanical-fix must be an object."], resolvedRefs: [] };
  if (!Array.isArray(beforeClaims) || !Array.isArray(afterClaims)) {
    return { errors: ["mechanical fix requires before and current evidence arrays."], resolvedRefs: [] };
  }
  if (mechanicalFix.schemaVersion !== "1.0.0") errors.push("claim-mechanical-fix.schemaVersion must be 1.0.0.");
  if (mechanicalFix.workflowVersion !== "2.2.1") errors.push("claim-mechanical-fix.workflowVersion must be 2.2.1.");
  if (mechanicalFix.caseId !== context.caseId) errors.push("claim-mechanical-fix.caseId does not match the case.");
  if (mechanicalFix.role !== "claim_mechanical_fix") errors.push("claim-mechanical-fix.role must be claim_mechanical_fix.");
  if (mechanicalFix.reviewRound !== primary.reviewRound) errors.push("claim-mechanical-fix.reviewRound does not match the primary review round.");

  const beforeEvidenceHash = sha256Value(beforeClaims);
  const afterEvidenceHash = sha256Value(afterClaims);
  const beforeSemanticHash = quoteIgnoredEvidenceHash(beforeClaims);
  const afterSemanticHash = quoteIgnoredEvidenceHash(afterClaims);
  validateHash(context.evidenceHash, afterEvidenceHash, "context.evidenceHash", errors);
  validateHash(mechanicalFix.inputHashes?.primaryClaimReview, sha256Value(primary), "claim-mechanical-fix.inputHashes.primaryClaimReview", errors);
  validateHash(mechanicalFix.inputHashes?.beforeEvidence, beforeEvidenceHash, "claim-mechanical-fix.inputHashes.beforeEvidence", errors);
  validateHash(mechanicalFix.inputHashes?.afterEvidence, afterEvidenceHash, "claim-mechanical-fix.inputHashes.afterEvidence", errors);
  validateHash(mechanicalFix.inputHashes?.beforeQuoteIgnoredEvidence, beforeSemanticHash, "claim-mechanical-fix.inputHashes.beforeQuoteIgnoredEvidence", errors);
  validateHash(mechanicalFix.inputHashes?.afterQuoteIgnoredEvidence, afterSemanticHash, "claim-mechanical-fix.inputHashes.afterQuoteIgnoredEvidence", errors);
  if (primary.inputHashes?.evidence !== beforeEvidenceHash) errors.push("primary claim-review is not bound to the mechanical fix beforeEvidence.");
  if (beforeSemanticHash !== afterSemanticHash) errors.push("mechanical fix changed quote-ignored evidence semantics.");

  const additions = quoteAdditions(beforeClaims, afterClaims, errors);
  const entries = Array.isArray(mechanicalFix.entries) ? mechanicalFix.entries : [];
  if (!Array.isArray(mechanicalFix.entries) || entries.length === 0) errors.push("claim-mechanical-fix.entries must be a non-empty array.");
  const entryRefs = entries.map((entry) => entry?.evidenceRef).filter(Boolean);
  const duplicateRefs = duplicates(entryRefs);
  if (duplicateRefs.length) errors.push("claim-mechanical-fix.entries contains duplicate refs: " + duplicateRefs.join(", ") + ".");
  if (!sameSet(entryRefs, [...additions.keys()])) errors.push("claim-mechanical-fix.entries does not exactly cover the added support quotes.");
  const mechanicalRefs = new Set(primaryAssessment.mechanicalFindings.map((finding) => finding.evidenceRef));
  const legacyMechanicalRefs = new Set(primary.schemaVersion === "1.0.0"
    ? primary.entries.filter(isLegacyMissingSupportQuoteEntry).map((entry) => entry.evidenceRef)
    : []);
  const afterByRef = new Map(afterClaims.map((claim) => [claim.id, claim]));
  for (const entry of entries) {
    const ref = entry?.evidenceRef ?? "<missing>";
    if (entry?.findingCode !== "missing_support_quote") errors.push("claim-mechanical-fix " + ref + ".findingCode must be missing_support_quote.");
    if (entry?.status !== "mechanically_resolved") errors.push("claim-mechanical-fix " + ref + ".status must be mechanically_resolved.");
    if ((afterByRef.get(ref)?.supportSpans ?? []).some((span) => typeof span.quote !== "string" || span.quote.trim().length === 0)) {
      errors.push("claim-mechanical-fix " + ref + " leaves at least one supportSpans.quote missing.");
    }
    const indexes = Array.isArray(entry?.supportSpanIndexes) ? entry.supportSpanIndexes : [];
    if (!Array.isArray(entry?.supportSpanIndexes)
      || indexes.length === 0
      || indexes.some((index) => !Number.isInteger(index) || index < 0)
      || duplicates(indexes).length) {
      errors.push("claim-mechanical-fix " + ref + ".supportSpanIndexes must contain unique non-negative integers.");
    } else if (!sameSet(indexes, additions.get(ref) ?? [])) {
      errors.push("claim-mechanical-fix " + ref + ".supportSpanIndexes does not match the added quotes.");
    }
  }
  const resolvedRefs = entryRefs.filter((ref) => mechanicalRefs.has(ref) || legacyMechanicalRefs.has(ref));
  const legacyResolvedRefs = entryRefs.filter((ref) => legacyMechanicalRefs.has(ref));
  return {
    errors,
    resolvedRefs: errors.length === 0 ? uniqueSorted(resolvedRefs) : [],
    legacyResolvedRefs: errors.length === 0 ? uniqueSorted(legacyResolvedRefs) : [],
  };
}

function validateAdjudication(adjudication, { context, primary, secondary, conflicts }) {
  const errors = [];
  if (!isObject(adjudication)) return ["claim-adjudication must be an object."];
  try {
    if (/\uFFFD|\?{2,}/u.test(JSON.stringify(adjudication))) errors.push("claim-adjudication contains corrupted or placeholder text.");
  } catch {
    errors.push("claim-adjudication cannot be serialized.");
  }
  if (adjudication.schemaVersion !== "1.0.0") errors.push("claim-adjudication.schemaVersion must be 1.0.0.");
  if (adjudication.workflowVersion !== "2.2.1") errors.push("claim-adjudication.workflowVersion must be 2.2.1.");
  if (adjudication.caseId !== context.caseId) errors.push("claim-adjudication.caseId does not match the case.");
  if (adjudication.role !== "claim_adjudicator") errors.push("claim-adjudication.role must be claim_adjudicator.");
  if (typeof adjudication.reviewerId !== "string" || adjudication.reviewerId.length < 2) errors.push("claim-adjudication.reviewerId is required.");
  if ([primary.reviewerId, secondary.reviewerId].includes(adjudication.reviewerId)) errors.push("claim adjudicator must be independent from both claim auditors.");
  if (adjudication.reviewRound !== primary.reviewRound) errors.push("claim-adjudication.reviewRound does not match the claim review round.");
  const evidenceHash = expectedEvidenceHash(context, context.claims);
  validateHash(adjudication.inputHashes?.segments, context.segmentsHash, "claim-adjudication.inputHashes.segments", errors);
  validateHash(adjudication.inputHashes?.evidence, evidenceHash, "claim-adjudication.inputHashes.evidence", errors);
  validateHash(adjudication.inputHashes?.primaryClaimReview, sha256Value(primary), "claim-adjudication.inputHashes.primaryClaimReview", errors);
  validateHash(adjudication.inputHashes?.secondaryClaimReview, sha256Value(secondary), "claim-adjudication.inputHashes.secondaryClaimReview", errors);
  validateHash(adjudication.inputHashes?.targetSet, targetSetHash(conflicts.map((conflict) => conflict.evidenceRef)), "claim-adjudication.inputHashes.targetSet", errors);

  const entries = Array.isArray(adjudication.entries) ? adjudication.entries : [];
  if (!Array.isArray(adjudication.entries) || entries.length === 0) errors.push("claim-adjudication.entries must be a non-empty array.");
  const refs = entries.map((entry) => entry?.evidenceRef).filter(Boolean);
  const duplicateRefs = duplicates(refs);
  if (duplicateRefs.length) errors.push(`claim-adjudication.entries contains duplicate refs: ${duplicateRefs.join(", ")}.`);
  if (!sameSet(refs, conflicts.map((conflict) => conflict.evidenceRef))) errors.push("claim-adjudication.entries does not exactly cover the conflict set.");
  const conflictByRef = new Map(conflicts.map((conflict) => [conflict.evidenceRef, conflict]));
  for (const entry of entries) {
    const ref = entry?.evidenceRef ?? "<missing>";
    const conflict = conflictByRef.get(entry?.evidenceRef);
    if (!EVIDENCE_REF_PATTERN.test(entry?.evidenceRef ?? "") || !conflict) errors.push(`claim-adjudication ${ref} is outside the conflict set.`);
    const triggers = validateStringArray(entry?.triggers, `claim-adjudication ${ref}.triggers`, errors, { allowed: ADJUDICATION_TRIGGERS, minItems: 1 });
    if (conflict && !sameSet(triggers, conflict.triggers)) errors.push(`claim-adjudication ${ref}.triggers does not match the computed conflict.`);
    if (!["primary", "secondary", "original", "unreviewable"].includes(entry?.selection)) errors.push(`claim-adjudication ${ref} has an invalid selection.`);
    if (typeof entry?.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      errors.push(`claim-adjudication ${ref} has an invalid confidence.`);
    }
    if (typeof entry?.rationale !== "string" || entry.rationale.trim().length === 0) errors.push(`claim-adjudication ${ref} lacks a rationale.`);
  }
  return errors;
}

function resolutionBase(primary, context) {
  const inputHashes = {};
  if (HASH_PATTERN.test(context.segmentsHash ?? "")) inputHashes.segments = context.segmentsHash;
  try {
    inputHashes.evidence = expectedEvidenceHash(context, Array.isArray(context.claims) ? context.claims : []);
  } catch {
    // The assessment reports the unusable context; omit a fabricated hash here.
  }
  if (isObject(primary)) inputHashes.primaryClaimReview = sha256Value(primary);
  const suppliedRound = primary?.reviewRound ?? context.reviewRound;
  return {
    schemaVersion: "1.0.0",
    workflowVersion: "2.2.1",
    caseId: context.caseId ?? "",
    role: "claim_gate",
    reviewRound: Number.isInteger(suppliedRound) && suppliedRound > 0 ? suppliedRound : 0,
    inputHashes,
    reviewerIds: isObject(primary) && primary.reviewerId ? { primary: primary.reviewerId } : {},
    status: "invalid",
    targetRefs: [],
    contractErrors: [],
    semanticFailures: [],
    conflicts: [],
    decisions: [],
    metrics: {
      primaryEntryCount: Array.isArray(primary?.entries) ? primary.entries.length : 0,
      targetCount: 0,
      agreementCount: 0,
      conflictCount: 0,
      resolvedPassCount: 0,
      resolvedNonpassCount: 0,
      mechanicalResolvedCount: 0,
    },
  };
}

/**
 * Resolves the 2.2.1 Claim Gate state machine. The first review is full; a
 * second independent auditor sees only primary semantic findings; only
 * disagreements are eligible for independent adjudication.
 */
export function resolveClaimReview({ primary, mechanicalFix = null, secondary = null, adjudication = null, context = {} } = {}) {
  const result = resolutionBase(primary, context);
  const beforeClaims = mechanicalFix ? context.preRepairClaims : context.claims;
  const primaryEvidenceHash = Array.isArray(beforeClaims) ? sha256Value(beforeClaims) : context.evidenceHash;
  const primaryAssessment = assessClaimReview(primary, {
    ...context,
    claims: beforeClaims,
    evidenceHash: primaryEvidenceHash,
    expectedAuditMode: "full",
  });
  if (!primaryAssessment.valid) {
    result.contractErrors = primaryAssessment.contractErrors.map((error) => `primary: ${error}`);
    return result;
  }

  let mechanicallyResolvedRefs = [];
  let legacyMechanicallyResolvedRefs = [];
  if (mechanicalFix) {
    if (!Array.isArray(context.preRepairClaims)) {
      result.contractErrors.push("mechanical fix requires context.preRepairClaims.");
      return result;
    }
    const mechanicalValidation = validateMechanicalFix(mechanicalFix, {
      context,
      primary,
      primaryAssessment,
      beforeClaims: context.preRepairClaims,
      afterClaims: context.claims,
    });
    result.contractErrors.push(...mechanicalValidation.errors.map((error) => "mechanicalFix: " + error));
    if (result.contractErrors.length) return result;
    mechanicallyResolvedRefs = mechanicalValidation.resolvedRefs;
    legacyMechanicallyResolvedRefs = mechanicalValidation.legacyResolvedRefs;
    result.inputHashes.mechanicalFix = sha256Value(mechanicalFix);
    result.inputHashes.evidence = sha256Value(context.claims);
    result.metrics.mechanicalResolvedCount = mechanicallyResolvedRefs.length;
  }

  const legacyMechanicallyResolved = new Set(legacyMechanicallyResolvedRefs);
  const warningDispositions = claimOrganizationWarningDispositions(primary, context);
  const warningRefs = new Set(warningDispositions.map((entry) => entry.evidenceRef));
  if (warningDispositions.length) result.warningDispositions = warningDispositions;
  const targetRefs = primaryAssessment.semanticFindings
    .filter((finding) => !legacyMechanicallyResolved.has(finding.evidenceRef) && !warningRefs.has(finding.evidenceRef))
    .map((finding) => finding.evidenceRef)
    .sort();
  result.targetRefs = targetRefs;
  result.metrics.targetCount = targetRefs.length;
  const unresolvedMechanicalRefs = primaryAssessment.mechanicalFindings
    .map((finding) => finding.evidenceRef)
    .filter((ref) => !mechanicallyResolvedRefs.includes(ref));
  if (unresolvedMechanicalRefs.length) {
    result.status = "needs_mechanical_fix";
    return result;
  }
  if (targetRefs.length === 0) {
    if (secondary || adjudication) {
      result.contractErrors.push("secondary review or adjudication is not allowed when the primary review has no semantic findings.");
      return result;
    }
    result.status = "pass";
    return result;
  }

  result.inputHashes.targetSet = targetSetHash(targetRefs);
  if (!secondary) {
    if (adjudication) result.contractErrors.push("claim adjudication cannot precede the targeted secondary review.");
    else result.status = "needs_secondary";
    return result;
  }

  result.inputHashes.secondaryClaimReview = sha256Value(secondary);
  if (secondary.reviewerId) result.reviewerIds.secondary = secondary.reviewerId;
  if (secondary.reviewerId === primary.reviewerId) {
    result.contractErrors.push("primary and secondary claim auditors must have different reviewer IDs.");
  }
  if (secondary.reviewRound !== primary.reviewRound) {
    result.contractErrors.push("primary and secondary claim reviews must use the same review round.");
  }
  const secondaryAssessment = assessClaimReview(secondary, {
    ...context,
    expectedAuditMode: "targeted",
    reviewRound: primary.reviewRound,
    targetRefs,
    primaryClaimReviewHash: sha256Value(primary),
  });
  result.contractErrors.push(...secondaryAssessment.contractErrors.map((error) => `secondary: ${error}`));
  if (result.contractErrors.length) return result;
  if (secondaryAssessment.mechanicalFindings.length) {
    result.status = "needs_mechanical_fix";
    return result;
  }

  const primaryByRef = new Map(primaryAssessment.semanticFindings.map((finding) => [finding.evidenceRef, finding]));
  const secondarySemanticByRef = new Map(secondaryAssessment.semanticFindings.map((finding) => [finding.evidenceRef, finding]));
  const secondaryByRef = new Map(secondary.entries.map((entry) => [
    entry.evidenceRef,
    cleanPass(entry) ? decisionFromEntry(entry, secondary.schemaVersion) : secondarySemanticByRef.get(entry.evidenceRef),
  ]));
  const agreements = [];
  const conflicts = [];
  for (const ref of targetRefs) {
    const primaryDecision = primaryByRef.get(ref);
    const secondaryDecision = secondaryByRef.get(ref);
    const triggers = conflictTriggers(primaryDecision, secondaryDecision);
    if (triggers.length === 0) agreements.push(primaryDecision);
    else conflicts.push({ evidenceRef: ref, triggers, primary: primaryDecision, secondary: secondaryDecision });
  }
  result.conflicts = conflicts;
  result.decisions = [...agreements];
  result.semanticFailures = agreements.filter((decision) => decision.verdict !== "pass");
  result.metrics.agreementCount = agreements.length;
  result.metrics.conflictCount = conflicts.length;

  if (conflicts.length === 0) {
    if (adjudication) {
      result.contractErrors.push("claim adjudication is not allowed when both auditors agree.");
      return result;
    }
    result.status = result.semanticFailures.length ? "repair_required" : "pass";
    result.metrics.resolvedPassCount = result.decisions.filter((decision) => decision.verdict === "pass").length;
    result.metrics.resolvedNonpassCount = result.semanticFailures.length;
    return result;
  }

  if (!adjudication) {
    result.status = "needs_adjudication";
    result.metrics.resolvedNonpassCount = result.semanticFailures.length;
    return result;
  }

  result.inputHashes.adjudication = sha256Value(adjudication);
  if (adjudication.reviewerId) result.reviewerIds.adjudicator = adjudication.reviewerId;
  const adjudicationErrors = validateAdjudication(adjudication, { context, primary, secondary, conflicts });
  result.contractErrors.push(...adjudicationErrors.map((error) => `adjudication: ${error}`));
  if (result.contractErrors.length) return result;

  const minimumConfidence = context.minimumAdjudicationConfidence ?? 0.8;
  const adjudicationByRef = new Map(adjudication.entries.map((entry) => [entry.evidenceRef, entry]));
  let requiresHuman = false;
  for (const conflict of conflicts) {
    const entry = adjudicationByRef.get(conflict.evidenceRef);
    if (entry.selection === "unreviewable" || entry.confidence < minimumConfidence) {
      requiresHuman = true;
      continue;
    }
    if (entry.selection === "original") {
      result.decisions.push({
        evidenceRef: conflict.evidenceRef,
        verdict: "pass",
        findingCodes: [],
        remedy: {
          mergeWithRefs: [],
          replacementStatements: [],
          importance: null,
          themeId: null,
          speaker: null,
        },
      });
      continue;
    }
    result.decisions.push(entry.selection === "primary" ? conflict.primary : conflict.secondary);
  }
  result.decisions.sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));
  result.semanticFailures = result.decisions.filter((decision) => decision.verdict !== "pass");
  result.metrics.resolvedPassCount = result.decisions.filter((decision) => decision.verdict === "pass").length;
  result.metrics.resolvedNonpassCount = result.semanticFailures.length;
  result.status = requiresHuman ? "human_required" : (result.semanticFailures.length ? "repair_required" : "pass");
  return result;
}
