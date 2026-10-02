import crypto from "node:crypto";

export const READER_DIMENSIONS = Object.freeze([
  "coherence",
  "terminology",
  "repetition",
  "hierarchy",
  "profileFit",
  "informationLoad",
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CLASSIFICATIONS = new Set(["clean_pass", "borderline", "revise"]);

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot hash a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError(`Cannot hash ${typeof value}.`);
}

export function sha256ReviewValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function exactDimensionSet(values, label) {
  if (!Array.isArray(values) || values.length !== READER_DIMENSIONS.length) {
    throw new TypeError(`${label} must list all six reader dimensions.`);
  }
  if (new Set(values).size !== values.length || READER_DIMENSIONS.some((name) => !values.includes(name))) {
    throw new TypeError(`${label} must contain each reader dimension exactly once.`);
  }
  return [...values];
}

export function readerGatePolicyFromConfig(config) {
  const dimensions = exactDimensionSet(config?.reviews?.readerDimensions, "reviews.readerDimensions");
  const gate = config?.reviews?.readerGate;
  if (!gate || typeof gate !== "object") throw new TypeError("reviews.readerGate is required for reviews 2.2.2.");
  const coreDimensions = Array.isArray(gate.coreDimensions) ? [...gate.coreDimensions] : [];
  if (coreDimensions.length !== 3
    || new Set(coreDimensions).size !== coreDimensions.length
    || coreDimensions.some((name) => !dimensions.includes(name))) {
    throw new TypeError("reviews.readerGate.coreDimensions must contain three unique configured dimensions.");
  }
  const weights = {};
  for (const dimension of dimensions) {
    const weight = gate.weights?.[dimension];
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
      throw new TypeError(`reviews.readerGate.weights.${dimension} must be an integer from 1 to 5.`);
    }
    weights[dimension] = weight;
  }
  for (const name of coreDimensions) {
    if (weights[name] !== 2) throw new TypeError(`core reader dimension ${name} must have weight 2.`);
  }
  for (const name of dimensions.filter((dimension) => !coreDimensions.includes(dimension))) {
    if (weights[name] !== 1) throw new TypeError(`non-core reader dimension ${name} must have weight 1.`);
  }
  const policy = {
    schemaVersion: "1.0.0",
    dimensions,
    coreDimensions,
    weights,
    cleanPassMinimumScore: gate.cleanPassMinimumScore,
    borderlineMinimumScore: gate.borderlineMinimumScore,
    borderlineMinimumWeightedAverage: gate.borderlineMinimumWeightedAverage,
    borderlineMaximumThreeScores: gate.borderlineMaximumThreeScores,
  };
  if (policy.cleanPassMinimumScore !== 4) throw new TypeError("reader cleanPassMinimumScore must be 4.");
  if (policy.borderlineMinimumScore !== 3) throw new TypeError("reader borderlineMinimumScore must be 3.");
  if (typeof policy.borderlineMinimumWeightedAverage !== "number"
    || policy.borderlineMinimumWeightedAverage < 3
    || policy.borderlineMinimumWeightedAverage > 5) {
    throw new TypeError("reader borderlineMinimumWeightedAverage must be between 3 and 5.");
  }
  if (!Number.isInteger(policy.borderlineMaximumThreeScores)
    || policy.borderlineMaximumThreeScores < 0
    || policy.borderlineMaximumThreeScores > dimensions.length) {
    throw new TypeError("reader borderlineMaximumThreeScores must be a valid count.");
  }
  return Object.freeze({
    ...policy,
    dimensions: Object.freeze(policy.dimensions),
    coreDimensions: Object.freeze(policy.coreDimensions),
    weights: Object.freeze(policy.weights),
  });
}

export function readerGatePolicyHash(policy) {
  return sha256ReviewValue(policy);
}

function scoreSummary(scores, policy) {
  const invalidDimensions = [];
  let weightedTotal = 0;
  let totalWeight = 0;
  let scoreThreeCount = 0;
  const scoreOneDimensions = [];
  const coreScoreTwoOrLower = [];
  const belowBorderline = [];
  for (const dimension of policy.dimensions) {
    const score = scores?.[dimension];
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      invalidDimensions.push(dimension);
      continue;
    }
    weightedTotal += score * policy.weights[dimension];
    totalWeight += policy.weights[dimension];
    if (score === 3) scoreThreeCount += 1;
    if (score === 1) scoreOneDimensions.push(dimension);
    if (score < policy.borderlineMinimumScore) belowBorderline.push(dimension);
    if (policy.coreDimensions.includes(dimension) && score <= 2) coreScoreTwoOrLower.push(dimension);
  }
  return {
    invalidDimensions,
    weightedAverage: totalWeight ? weightedTotal / totalWeight : 0,
    scoreThreeCount,
    scoreOneDimensions,
    coreScoreTwoOrLower,
    belowBorderline,
  };
}

export function evaluateReaderReview(review, policy, { ignoreDeclaredVerdict = false } = {}) {
  const summary = scoreSummary(review?.scores, policy);
  const errorIssues = (review?.issues ?? []).filter((issue) => issue?.severity === "error");
  const reasons = [];
  if (summary.invalidDimensions.length) reasons.push(`invalid_scores:${summary.invalidDimensions.join(",")}`);
  if (errorIssues.length) reasons.push("error_issue");
  if (summary.scoreOneDimensions.length) reasons.push(`score_1:${summary.scoreOneDimensions.join(",")}`);
  if (summary.coreScoreTwoOrLower.length) reasons.push(`core_score_2:${summary.coreScoreTwoOrLower.join(",")}`);

  const allClean = !summary.invalidDimensions.length
    && !errorIssues.length
    && policy.dimensions.every((dimension) => review.scores[dimension] >= policy.cleanPassMinimumScore);
  const borderline = !summary.invalidDimensions.length
    && !errorIssues.length
    && policy.dimensions.every((dimension) => review.scores[dimension] >= policy.borderlineMinimumScore)
    && summary.weightedAverage >= policy.borderlineMinimumWeightedAverage
    && summary.scoreThreeCount <= policy.borderlineMaximumThreeScores;
  let classification = "revise";
  if (allClean) classification = "clean_pass";
  else if (borderline) classification = "borderline";
  else {
    if (summary.belowBorderline.length && !summary.scoreOneDimensions.length && !summary.coreScoreTwoOrLower.length) {
      reasons.push(`below_borderline:${summary.belowBorderline.join(",")}`);
    }
    if (summary.weightedAverage < policy.borderlineMinimumWeightedAverage) reasons.push("weighted_average_below_3.8");
    if (summary.scoreThreeCount > policy.borderlineMaximumThreeScores) reasons.push("too_many_score_3");
  }
  const contractErrors = [];
  if (!ignoreDeclaredVerdict) {
    if (!CLASSIFICATIONS.has(review?.verdict)) contractErrors.push("reader-review verdict must be clean_pass, borderline, or revise.");
    else if (review.verdict !== classification) contractErrors.push(`reader-review verdict ${review.verdict} does not match computed ${classification}.`);
  }
  return {
    classification,
    needsSecondary: classification === "borderline",
    weightedAverage: summary.weightedAverage,
    scoreThreeCount: summary.scoreThreeCount,
    errorIssues,
    reasons: [...new Set(reasons)],
    contractErrors,
  };
}

export function resolveReaderPair(primary, secondary, policy) {
  const primaryResult = evaluateReaderReview(primary, policy);
  const secondaryResult = evaluateReaderReview(secondary, policy);
  if (primaryResult.classification !== "borderline") {
    throw new Error("A secondary Reader is legal only after a borderline primary review.");
  }
  const disputedDimensions = policy.dimensions.filter((dimension) => primary?.scores?.[dimension] !== secondary?.scores?.[dimension]);
  const sameOutcome = secondaryResult.classification === primaryResult.classification;
  return {
    status: sameOutcome ? "pass" : "pending",
    requiresAdjudication: !sameOutcome,
    primaryClassification: primaryResult.classification,
    secondaryClassification: secondaryResult.classification,
    disputedDimensions: sameOutcome ? [] : disputedDimensions,
  };
}

export function readerAdjudicationContractErrors(adjudication, {
  caseId,
  reviewRound,
  deepReadHash,
  readerMarkdownHash,
  policy,
  primary,
  secondary,
  assignedReviewerId,
  forbiddenReviewerIds = [],
}) {
  const errors = [];
  if (!adjudication || typeof adjudication !== "object") return ["reader-adjudication is missing."];
  if (adjudication.schemaVersion !== "1.0.0") errors.push("reader-adjudication.schemaVersion must be 1.0.0.");
  if (adjudication.caseId !== caseId) errors.push("reader-adjudication.caseId mismatch.");
  if (adjudication.role !== "reader_adjudicator") errors.push("reader-adjudication.role mismatch.");
  if (adjudication.reviewRound !== reviewRound) errors.push("reader-adjudication.reviewRound mismatch.");
  if (adjudication.evidenceBlind !== true) errors.push("reader-adjudication must remain evidence-blind.");
  if (!adjudication.reviewerId || adjudication.reviewerId !== assignedReviewerId) errors.push("reader-adjudication reviewerId does not match assignment.");
  if (forbiddenReviewerIds.includes(adjudication.reviewerId)) errors.push("reader-adjudication reviewerId is not isolated from Reader reviewers.");
  const expectedHashes = {
    deepRead: deepReadHash,
    readerMarkdown: readerMarkdownHash,
    readerGate: readerGatePolicyHash(policy),
    primaryReaderReview: sha256ReviewValue(primary),
    secondaryReaderReview: sha256ReviewValue(secondary),
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    const actual = adjudication.inputHashes?.[name];
    if (!HASH_PATTERN.test(actual ?? "")) errors.push(`reader-adjudication.inputHashes.${name} is not SHA-256.`);
    else if (actual !== expected) errors.push(`reader-adjudication.inputHashes.${name} is stale.`);
  }
  if (!new Set(["pass", "revise"]).has(adjudication.decision)) errors.push("reader-adjudication.decision must be pass or revise.");
  const pair = resolveReaderPair(primary, secondary, policy);
  if (!pair.requiresAdjudication) errors.push("reader-adjudication is forbidden when Reader outcomes agree.");
  const refs = Array.isArray(adjudication.disputedDimensions) ? adjudication.disputedDimensions : [];
  if (new Set(refs).size !== refs.length
    || refs.some((name) => !pair.disputedDimensions.includes(name))
    || pair.disputedDimensions.some((name) => !refs.includes(name))) {
    errors.push("reader-adjudication.disputedDimensions does not match the isolated Reader disagreement.");
  }
  if (!adjudication.rationale?.trim()) errors.push("reader-adjudication.rationale is required.");
  return errors;
}
