const FAILURE_IMPACTS = new Set([
  "content_blocker",
  "external_provenance_blocker",
  "navigation_blocker",
]);
const ALL_IMPACTS = new Set([...FAILURE_IMPACTS, "navigation_warning", "none"]);

function entryReasons(entry, { citationIds, checkedCitationIds }) {
  const reasons = [];
  if (entry?.verdict !== "supported") reasons.push("support");
  if (entry?.provenanceVerdict !== "correct") reasons.push("provenance");
  if (entry?.unsupportedText?.length) reasons.push("unsupported_text");
  if (entry?.provenance === "external") {
    for (const ref of entry?.citationRefs ?? []) {
      if (citationIds.has(ref) && !checkedCitationIds.has(ref)) reasons.push(`missing_research_check:${ref}`);
    }
  }
  return [...new Set(reasons)];
}

function expectedImpactKind(entry, reasons) {
  if (entry?.provenance === "system") return reasons.length ? "navigation" : "none_or_warning";
  if (entry?.provenance === "external" || entry?.provenance === "editorial" || entry?.provenanceVerdict === "wrong") {
    return reasons.length ? "external_provenance_blocker" : "none";
  }
  return reasons.length ? "content_blocker" : "none";
}

export function evaluateFidelityReview(review, { research = { citations: [], checks: [] } } = {}) {
  const citationIds = new Set((research?.citations ?? []).map((citation) => citation.id));
  const checkedCitationIds = new Set((research?.checks ?? []).flatMap((check) => check.citationRefs ?? []));
  const entries = (review?.entries ?? []).map((entry) => ({
    ...entry,
    reasons: entryReasons(entry, { citationIds, checkedCitationIds }),
  }));
  const contentBlockers = entries.filter((entry) => entry.impact === "content_blocker");
  const externalProvenanceBlockers = entries.filter((entry) => entry.impact === "external_provenance_blocker");
  const navigationBlockers = entries.filter((entry) => entry.impact === "navigation_blocker");
  const navigationWarnings = entries.filter((entry) => entry.impact === "navigation_warning");
  const contentVerdict = contentBlockers.length || externalProvenanceBlockers.length ? "revise" : "pass";
  const navigationVerdict = navigationBlockers.length ? "block" : (navigationWarnings.length ? "warning" : "pass");
  const packageVerdict = contentVerdict === "pass" && navigationVerdict !== "block" ? "pass" : "revise";
  return {
    contentVerdict,
    navigationVerdict,
    packageVerdict,
    contentBlockers,
    externalProvenanceBlockers,
    navigationBlockers,
    navigationWarnings,
    gateFailures: entries.filter((entry) => FAILURE_IMPACTS.has(entry.impact)),
    entries,
  };
}

export function fidelityVerdictContractErrors(review, options = {}) {
  const errors = [];
  const result = evaluateFidelityReview(review, options);
  for (const entry of result.entries) {
    if (!ALL_IMPACTS.has(entry.impact)) {
      errors.push(`fidelity entry ${entry.readerBlockRef ?? "<missing>"} has invalid impact.`);
      continue;
    }
    const expected = expectedImpactKind(entry, entry.reasons);
    if (expected === "navigation") {
      if (!new Set(["navigation_blocker", "navigation_warning"]).has(entry.impact)) {
        errors.push(`system/navigation entry ${entry.readerBlockRef} must declare a navigation blocker or warning.`);
      }
    } else if (expected === "none_or_warning") {
      if (!new Set(["none", "navigation_warning"]).has(entry.impact)) {
        errors.push(`supported system/navigation entry ${entry.readerBlockRef} may only be none or navigation_warning.`);
      }
    } else if (entry.impact !== expected) {
      errors.push(`fidelity entry ${entry.readerBlockRef} impact ${entry.impact} must be ${expected}.`);
    }
  }
  if (review?.contentVerdict !== result.contentVerdict) {
    errors.push(`fidelity contentVerdict ${review?.contentVerdict ?? "<missing>"} does not match computed ${result.contentVerdict}.`);
  }
  if (review?.navigationVerdict !== result.navigationVerdict) {
    errors.push(`fidelity navigationVerdict ${review?.navigationVerdict ?? "<missing>"} does not match computed ${result.navigationVerdict}.`);
  }
  if (review?.packageVerdict !== result.packageVerdict) {
    errors.push(`fidelity packageVerdict ${review?.packageVerdict ?? "<missing>"} does not match computed ${result.packageVerdict}.`);
  }
  return errors;
}
