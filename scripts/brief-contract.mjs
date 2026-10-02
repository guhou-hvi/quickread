const EDITOR_NOTE_ALLOWED_KEYS = new Set([
  "type",
  "provenance",
  "intent",
  "title",
  "text",
  "evidenceRefs",
  "citationRefs",
]);

const EDITOR_NOTE_INTENT_LABELS = Object.freeze({
  summary: "总结",
  commentary: "点评",
  critique: "锐评",
  caution: "提醒",
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function editorPersonaErrors(persona, location = "config.editorPersona") {
  const errors = [];
  for (const key of ["name", "avatarText", "footerRole", "uid"]) {
    if (!isNonEmptyString(persona?.[key])) errors.push(`${location}.${key} 必须是非空字符串。`);
  }
  return errors;
}

export function publicVersionErrors(value, location = "config.publicVersion") {
  return isNonEmptyString(value) ? [] : [`${location} 必须是非空字符串。`];
}

export function editorialBlockErrors(block, location = "block") {
  const errors = [];
  const isEditorial = block?.provenance === "editorial";
  const isEditorNote = block?.type === "editor_note";
  const hasIntent = Object.hasOwn(block ?? {}, "intent");
  if (!isEditorial && !isEditorNote) {
    if (hasIntent) errors.push(`${location} 只有 editor_note 可以设置 intent。`);
    return errors;
  }

  if (isEditorial && !isEditorNote) {
    errors.push(`${location} 为 editorial，只能使用 editor_note，当前为 ${block?.type ?? "未定义"}。`);
  }
  if (isEditorNote && !isEditorial) {
    errors.push(`${location} 为 editor_note，provenance 必须是 editorial。`);
  }
  if (!isNonEmptyString(block?.title)) errors.push(`${location} 的 QR-Pilot 观点标题不能为空。`);
  if (!isNonEmptyString(block?.text)) errors.push(`${location} 的 QR-Pilot 正文不能为空。`);
  if (!Object.hasOwn(EDITOR_NOTE_INTENT_LABELS, block?.intent)) {
    errors.push(`${location} 的 QR-Pilot intent 必须是 summary、commentary、critique 或 caution。`);
  }
  if (block?.intent === "summary" && (!Array.isArray(block.evidenceRefs) || !block.evidenceRefs.length)) {
    errors.push(`${location} 为 QR-Pilot 总结，必须提供至少一个 evidenceRef。`);
  }

  const forbidden = Object.keys(block ?? {}).filter((key) => !EDITOR_NOTE_ALLOWED_KEYS.has(key));
  if (forbidden.length) {
    errors.push(`${location} 的 editor_note 含有禁用字段：${forbidden.join("、")}。`);
  }
  return errors;
}

export function assertEditorialBlock(block, location = "block") {
  const errors = editorialBlockErrors(block, location);
  if (errors.length) throw new Error(errors.join(" "));
}

export {
  EDITOR_NOTE_ALLOWED_KEYS,
  EDITOR_NOTE_INTENT_LABELS,
};
