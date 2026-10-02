import { normalizeText } from "./lib.mjs";

export const PROFILES = Object.freeze(["knowledge", "strategy", "narrative", "debate", "general"]);
export const PROFILE_SELECTIONS = Object.freeze(["pending", "auto", "confirmed", "manual", "seeded"]);
export const LENSES = Object.freeze([
  "research",
  "product",
  "startup",
  "organization",
  "career",
  "history",
  "industry",
  "policy",
  "open-source",
  "education",
]);
export const DENSITY_DIMENSIONS = Object.freeze([
  "atomicInformation",
  "themeDependency",
  "evidenceRichness",
  "controversy",
  "uniqueness",
]);
export const CLAIM_IMPORTANCE = Object.freeze(["high", "medium", "low"]);
export const CLAIM_ROLES = Object.freeze([
  "fact",
  "opinion",
  "prediction",
  "recollection",
  "example",
  "rebuttal",
  "limitation",
  "uncertainty",
]);

export function compactCharacters(value) {
  return String(value ?? "").replace(/\s+/gu, "").length;
}

export function densityTotal(scores) {
  return DENSITY_DIMENSIONS.reduce((total, key) => total + Number(scores?.[key] ?? 0), 0);
}

export function densityErrors(scores, declaredTotal, location = "density") {
  const errors = [];
  for (const dimension of DENSITY_DIMENSIONS) {
    const value = scores?.[dimension];
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      errors.push(`${location}.${dimension} 必须是 0–4 的整数。`);
    }
  }
  const computed = densityTotal(scores);
  if (declaredTotal !== undefined && declaredTotal !== computed) {
    errors.push(`${location}.total 为 ${declaredTotal}，按五项得分应为 ${computed}。`);
  }
  return errors;
}

export function adaptiveTargets(densityScore, effectiveSourceCharacters, config) {
  if (!Number.isInteger(densityScore) || densityScore < 0 || densityScore > 20) {
    throw new Error("densityScore 必须是 0–20 的整数。");
  }
  if (!Number.isInteger(effectiveSourceCharacters) || effectiveSourceCharacters < 0) {
    throw new Error("effectiveSourceCharacters 必须是非负整数。");
  }
  const deep = config.budgets.deepRead;
  const brief = config.budgets.brief;
  const uncappedReaderCharacters = deep.readerBaseCharacters
    + deep.readerCharactersPerDensityPoint * densityScore
    + deep.readerSourceCharacterRatio * effectiveSourceCharacters;
  const boundedReaderCharacters = Math.min(
    deep.readerMaximumGuideline,
    Math.max(deep.readerMinimumGuideline, uncappedReaderCharacters),
  );
  const recommendedReaderCharacters = Math.min(
    effectiveSourceCharacters,
    Math.round(boundedReaderCharacters / 500) * 500,
  );
  const targetBriefCharacters = Math.min(
    brief.targetMax,
    brief.targetMin + brief.charactersPerDensityPoint * densityScore,
  );
  return {
    recommendedReaderCharacters,
    readerMinimumGuideline: Math.min(effectiveSourceCharacters, deep.readerMinimumGuideline),
    readerMaximumGuideline: Math.min(effectiveSourceCharacters, deep.readerMaximumGuideline),
    readerSoftCharacterCap: deep.readerSoftCharacterCap,
    targetBriefCharacters,
  };
}

export function expectedReadingMinutes(characters, config) {
  const rate = config.budgets.brief.readingCharactersPerMinute;
  return Math.max(1, Math.ceil(characters / rate));
}

export function profileSelectionErrors(profile, profileConfig, { requireResolved = true } = {}) {
  const errors = [];
  if (!profile || typeof profile !== "object") return ["case.profile 缺失。"];
  if (requireResolved && !PROFILES.includes(profile.primary)) errors.push("case.profile.primary 尚未确认。");
  if (profile.primary !== null && !PROFILES.includes(profile.primary)) errors.push("case.profile.primary 非法。");
  if (!Array.isArray(profile.lenses) || profile.lenses.length > 3) errors.push("case.profile.lenses 必须为至多 3 项的数组。");
  for (const lens of profile.lenses ?? []) {
    if (!LENSES.includes(lens)) errors.push(`未知 lens：${lens}`);
  }
  if (new Set(profile.lenses ?? []).size !== (profile.lenses ?? []).length) errors.push("case.profile.lenses 不得重复。");
  if (!PROFILE_SELECTIONS.includes(profile.selection)) errors.push("case.profile.selection 非法。");
  if (typeof profile.confidence !== "number" || profile.confidence < 0 || profile.confidence > 1) {
    errors.push("case.profile.confidence 必须位于 0–1。 ");
  }
  if (profile.version !== profileConfig.version) errors.push("case.profile.version 已过期。");
  if (profile.selection === "pending" && profile.primary !== null) errors.push("待确认 profile 的 primary 必须为 null。");
  if (profile.selection !== "pending" && profile.primary === null) errors.push("已选择 profile 时 primary 不得为空。");
  return errors;
}

export function automaticProfileDecision(scores, selectionConfig) {
  const ranked = Object.entries(scores)
    .filter(([name, score]) => PROFILES.includes(name) && Number.isFinite(score))
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]));
  const [top, runnerUp] = ranked;
  if (!top) throw new Error("profile scores 为空。");
  const lead = top[1] - (runnerUp?.[1] ?? 0);
  const accepted = top[1] >= selectionConfig.minimumTopScore && lead >= selectionConfig.minimumLead;
  return {
    primary: accepted ? top[0] : null,
    topProfile: top[0],
    topScore: Math.round(top[1] * 1000) / 1000,
    runnerUp: runnerUp?.[0] ?? null,
    lead: Math.round(lead * 1000) / 1000,
    requiresConfirmation: !accepted,
  };
}

export function collectBlockCharacters(value) {
  let total = 0;
  const visit = (node, key = "") => {
    if (typeof node === "string" && ["title", "subtitle", "summary", "lead", "text", "label", "attribution"].includes(key)) {
      total += compactCharacters(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
    }
  };
  visit(value);
  return total;
}

export function normalizedClaim(value) {
  return normalizeText(value)
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .toLocaleLowerCase("zh-CN");
}

function ngrams(value, size = 2) {
  const chars = [...normalizedClaim(value)];
  if (chars.length <= size) return new Set(chars.length ? [chars.join("")] : []);
  return new Set(chars.slice(0, chars.length - size + 1).map((_, index) => chars.slice(index, index + size).join("")));
}

export function claimSimilarity(first, second) {
  const left = ngrams(first);
  const right = ngrams(second);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function nearDuplicateClaimIds(claims, threshold = 0.9) {
  const duplicates = new Set();
  // Claims may number in the thousands. Precompute normalized n-grams once;
  // rebuilding them for every pair made the audit needlessly quadratic in
  // both comparisons and string processing. The size-ratio bound cannot
  // discard a pair whose Jaccard similarity could reach the threshold.
  const prepared = claims.map((claim) => ({ claim, grams: ngrams(claim.statement) }));
  for (let left = 0; left < prepared.length; left += 1) {
    for (let right = left + 1; right < prepared.length; right += 1) {
      const leftGrams = prepared[left].grams;
      const rightGrams = prepared[right].grams;
      if (!leftGrams.size || !rightGrams.size) continue;
      if (Math.min(leftGrams.size, rightGrams.size) / Math.max(leftGrams.size, rightGrams.size) < threshold) continue;
      const smaller = leftGrams.size <= rightGrams.size ? leftGrams : rightGrams;
      const larger = smaller === leftGrams ? rightGrams : leftGrams;
      let intersection = 0;
      for (const item of smaller) if (larger.has(item)) intersection += 1;
      const similarity = intersection / (leftGrams.size + rightGrams.size - intersection);
      if (similarity >= threshold) {
        duplicates.add(claims[right].id);
      }
    }
  }
  return duplicates;
}

export function isContiguousSourceSpan(sourceIds, orderedSourceIds) {
  if (!Array.isArray(sourceIds) || !sourceIds.length) return false;
  const positions = sourceIds.map((id) => orderedSourceIds.get(id));
  if (positions.some((position) => position === undefined)) return false;
  return positions.every((position, index) => index === 0 || position === positions[index - 1] + 1);
}

export function roundRate(value) {
  return Math.round(value * 10_000) / 10_000;
}
