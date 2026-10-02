function isValidGuideDate(value, { allowMonth = false } = {}) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(value);
  if (!parts || parts[0] !== value || (!parts[3] && !allowMonth)) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  if (month < 1 || month > 12) return false;
  if (!parts[3]) return true;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const day = Number(parts[3]);
  return day >= 1 && day <= daysInMonth[month - 1];
}

export function participantGuideContractErrors(guide, { manifest, citationIds = new Set() }) {
  const errors = [];
  if (!["1.0.0", "1.1.0"].includes(guide?.schemaVersion)) errors.push("participant-guide.schemaVersion 必须为 1.0.0 或 1.1.0。");
  if (guide?.caseId !== manifest.id) errors.push("participant-guide.caseId 与案例不一致。");
  const allowMonth = guide?.schemaVersion === "1.1.0";
  if (!isValidGuideDate(guide?.eventDate, { allowMonth })) {
    errors.push(`participant-guide.eventDate 必须为有效的 ${allowMonth ? "YYYY-MM 或 YYYY-MM-DD" : "YYYY-MM-DD"} 日期。`);
  }
  if (guide?.dateBasis !== undefined && !["event", "publication"].includes(guide.dateBasis)) errors.push("participant-guide.dateBasis 非法。");
  if (!isValidGuideDate(guide?.verifiedAt)) errors.push("participant-guide.verifiedAt 必须为有效的 YYYY-MM-DD 日期。");
  if (!["single_guest", "multi_speaker"].includes(guide?.mode)) errors.push("participant-guide.mode 非法。");
  const principals = guide?.principals ?? [];
  const supporting = guide?.supportingRoles ?? [];
  if (!principals.length) errors.push("participant-guide 至少需要一名主要人物。");
  if (guide?.mode === "single_guest" && principals.length !== 1) errors.push("single_guest 必须且只能有一名主要人物。");
  const people = [...principals, ...supporting];
  const ids = people.map((person) => person.id);
  const names = people.map((person) => person.name);
  if (new Set(ids).size !== ids.length) errors.push("participant-guide 人物 ID 重复。");
  if (new Set(names).size !== names.length) errors.push("participant-guide 人物姓名重复。");
  for (const person of people) {
    if (!(manifest.participants ?? []).includes(person.name)) errors.push(`participant-guide 人物不在 case.participants：${person.name}`);
    for (const field of ["id", "name", "roleAtEvent", "affiliationAtEvent", "relevantContext", "briefContext"]) {
      if (!String(person[field] ?? "").trim()) errors.push(`${person.name || person.id || "人物"} 缺少 ${field}。`);
    }
    if (!Array.isArray(person.citationRefs) || !person.citationRefs.length) errors.push(`${person.name} 缺少外部引用。`);
    for (const ref of person.citationRefs ?? []) if (!citationIds.has(ref)) errors.push(`${person.name} 引用未知资料：${ref}`);
  }
  return errors;
}

export function participantGuideCitationRefs(guide) {
  return [...new Set([...(guide?.principals ?? []), ...(guide?.supportingRoles ?? [])]
    .flatMap((person) => person.citationRefs ?? []))];
}

function citationSuffix(refs = []) {
  if (!refs.length) return "";
  return `〔${refs.map((ref) => `[${ref}](#${ref.toLowerCase()})`).join("、")}〕`;
}

export function renderParticipantGuideMarkdown(guide) {
  const dateLabel = guide.dateBasis === "publication" ? "本期资料发布时" : "本场活动发生时";
  const lines = [
    `> 以下身份以 ${guide.eventDate} ${dateLabel}为准，具体观点见后文主题章节。`,
    "",
  ];
  for (const person of guide.principals ?? []) {
    const role = [person.roleAtEvent, person.affiliationAtEvent].filter(Boolean).join(" · ");
    const context = person.relevantContext ? `。 ${person.relevantContext}` : "";
    lines.push(`- **${person.name}**｜${role}${context}${citationSuffix(person.citationRefs)}`);
  }
  if (guide.supportingRoles?.length) {
    lines.push("", "**现场角色**", "");
    for (const person of guide.supportingRoles) {
      const role = [person.roleAtEvent, person.affiliationAtEvent].filter(Boolean).join(" · ");
      const context = person.relevantContext ? `。 ${person.relevantContext}` : "";
      lines.push(`- **${person.name}**｜${role}${context}${citationSuffix(person.citationRefs)}`);
    }
  }
  return lines.join("\n");
}

export function participantGuideCharacters(guide, { compact = false } = {}) {
  return [...(guide?.principals ?? []), ...(guide?.supportingRoles ?? [])].reduce((total, person) => total
    + [person.name, person.roleAtEvent, person.affiliationAtEvent, compact ? (person.briefContext ?? person.relevantContext) : person.relevantContext]
      .filter(Boolean)
      .join("").replace(/\s+/gu, "").length, 0);
}
