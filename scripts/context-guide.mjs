const KINDS = new Set(["product", "project", "organization", "technology", "concept", "event"]);

export const CONTEXT_KIND_LABELS = Object.freeze({
  product: "产品",
  project: "项目",
  organization: "机构",
  technology: "技术",
  concept: "概念",
  event: "事件",
});

function unique(values = []) {
  return [...new Set(values)];
}

function statementErrors(statement, location, evidenceIds, citationIds) {
  const errors = [];
  if (!statement || !String(statement.text ?? "").trim()) errors.push(`${location} 缺少说明文本。`);
  if (!["source_fact", "speaker_view", "external"].includes(statement?.provenance)) {
    errors.push(`${location}.provenance 非法。`);
    return errors;
  }
  const evidenceRefs = statement.evidenceRefs ?? [];
  const citationRefs = statement.citationRefs ?? [];
  if (statement.provenance === "external" && !citationRefs.length) errors.push(`${location} 为外部背景但没有 citationRefs。`);
  if (["source_fact", "speaker_view"].includes(statement.provenance) && !evidenceRefs.length) {
    errors.push(`${location} 为来源内容但没有 evidenceRefs。`);
  }
  for (const ref of evidenceRefs) if (!evidenceIds.has(ref)) errors.push(`${location} 引用未知 claim：${ref}`);
  for (const ref of citationRefs) if (!citationIds.has(ref)) errors.push(`${location} 引用未知资料：${ref}`);
  return errors;
}

export function contextGuideContractErrors(guide, {
  manifest,
  evidenceIds = new Set(),
  citationIds = new Set(),
} = {}) {
  const errors = [];
  if (guide?.schemaVersion !== "1.0.0") errors.push("context-guide.schemaVersion 必须为 1.0.0。");
  if (guide?.caseId !== manifest?.id) errors.push("context-guide.caseId 与案例不一致。");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(guide?.verifiedAt ?? "")) errors.push("context-guide.verifiedAt 必须为日期。");
  const entries = guide?.entries ?? [];
  if (!entries.length) errors.push("context-guide 至少需要一个关键名词条目。");
  const ids = entries.map((entry) => entry.id);
  const names = entries.map((entry) => entry.name);
  if (new Set(ids).size !== ids.length) errors.push("context-guide 条目 ID 重复。");
  if (new Set(names).size !== names.length) errors.push("context-guide 名称重复。");
  for (const entry of entries) {
    const location = `context-guide ${entry.name || entry.id || "条目"}`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id ?? "")) errors.push(`${location} id 非法。`);
    if (!String(entry.name ?? "").trim()) errors.push(`${location} 缺少名称。`);
    if (!KINDS.has(entry.kind)) errors.push(`${location} kind 非法或误用了人物类型。`);
    const aliases = entry.aliases ?? [];
    if (new Set(aliases).size !== aliases.length) errors.push(`${location} aliases 重复。`);
    if (aliases.includes(entry.name)) errors.push(`${location} aliases 不得重复正式名称。`);
    errors.push(...statementErrors(entry.inlineDefinition, `${location}.inlineDefinition`, evidenceIds, citationIds));
    errors.push(...statementErrors(entry.background, `${location}.background`, evidenceIds, citationIds));
    errors.push(...statementErrors(entry.relevance, `${location}.relevance`, evidenceIds, citationIds));
  }
  return unique(errors);
}

export function contextGuideEntryMap(guide) {
  return new Map((guide?.entries ?? []).map((entry) => [entry.id, entry]));
}

export function selectContextGuideEntries(guide, entryRefs = []) {
  const selected = new Set(entryRefs);
  return {
    ...guide,
    entries: (guide?.entries ?? []).filter((entry) => selected.has(entry.id)),
  };
}

export function contextGuideCitationRefs(guide) {
  return unique((guide?.entries ?? []).flatMap((entry) => [entry.inlineDefinition, entry.background, entry.relevance]
    .flatMap((statement) => statement?.citationRefs ?? [])));
}

export function contextGuideEvidenceRefs(guide) {
  return unique((guide?.entries ?? []).flatMap((entry) => [entry.inlineDefinition, entry.background, entry.relevance]
    .flatMap((statement) => statement?.evidenceRefs ?? [])));
}

function markdownRefs(statement) {
  const evidence = (statement?.evidenceRefs ?? []).map((ref) => `[${ref}](evidence-book.md#${ref.toLowerCase()})`);
  const citations = (statement?.citationRefs ?? []).map((ref) => `[${ref}](#${ref.toLowerCase()})`);
  const refs = [...evidence, ...citations];
  return refs.length ? ` 〔${refs.join("、")}〕` : "";
}

export function renderContextInlineMarkdown(entry, { detailed = false } = {}) {
  if (!detailed) {
    const statement = entry.inlineDefinition;
    return `> **名词速记｜${entry.name}**：${statement.text}${markdownRefs(statement)}`;
  }
  return [
    `> **名词背景｜${entry.name}（${CONTEXT_KIND_LABELS[entry.kind]}）**`,
    ">",
    `> **是什么**：${entry.inlineDefinition.text}${markdownRefs(entry.inlineDefinition)}`,
    `> **背景**：${entry.background.text}${markdownRefs(entry.background)}`,
    `> **本期作用**：${entry.relevance.text}${markdownRefs(entry.relevance)}`,
  ].join("\n");
}

export function renderContextGuideMarkdown(guide, entryRefs = null) {
  const selected = entryRefs?.length
    ? entryRefs.map((ref) => contextGuideEntryMap(guide).get(ref)).filter(Boolean)
    : (guide?.entries ?? []);
  const lines = ["> 这里只解释理解后文所必需的产品、项目与概念；人物身份见上一节。", ""];
  for (const entry of selected) {
    lines.push(`- **${entry.name}｜${CONTEXT_KIND_LABELS[entry.kind]}**：${entry.inlineDefinition.text}${markdownRefs(entry.inlineDefinition)}`);
    lines.push(`  - **背景**：${entry.background.text}${markdownRefs(entry.background)}`);
    lines.push(`  - **本期作用**：${entry.relevance.text}${markdownRefs(entry.relevance)}`);
  }
  return lines.join("\n");
}

export function contextGuideCharacters(guide, { compact = false } = {}) {
  return (guide?.entries ?? []).reduce((total, entry) => total + [
    entry.name,
    entry.inlineDefinition?.text,
    entry.background?.text,
    compact ? "" : entry.relevance?.text,
  ].join("").replace(/\s+/gu, "").length, 0);
}

export function contextInlineCharacters(guide) {
  return (guide?.entries ?? []).reduce((total, entry) => total
    + [entry.name, entry.inlineDefinition?.text].join("").replace(/\s+/gu, "").length, 0);
}

export function countContextReferences(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((count, item) => count + countContextReferences(item), 0);
  return (value.contextRefs?.length ?? 0)
    + Object.entries(value)
      .filter(([key]) => key !== "contextRefs")
      .reduce((count, [, child]) => count + countContextReferences(child), 0);
}

function nodeText(node, kind) {
  if (kind === "deep-read") return String(node?.text ?? "");
  return [
    node?.text,
    ...(node?.items ?? []).map((item) => item?.text),
    ...(node?.columns ?? []).flatMap((column) => column?.items ?? []),
  ].filter(Boolean).join(" ");
}

function contextRefNodes(document, kind) {
  const nodes = [];
  if (kind === "deep-read") {
    for (const section of document?.sections ?? []) {
      for (const module of section.modules ?? []) {
        for (const block of module.blocks ?? []) {
          for (const node of [...(block.paragraphs ?? []), ...(block.items ?? [])]) {
            nodes.push({
              ...node,
              text: nodeText(node, kind),
              eligible: node.role !== "transition",
            });
          }
        }
      }
    }
  } else {
    for (const section of document?.sections ?? []) {
      nodes.push({
        id: `${section.id ?? "section"}-lead`,
        text: String(section.lead ?? ""),
        contextRefs: section.contextRefs ?? [],
        contextPreviewRefs: section.contextPreviewRefs ?? [],
        eligible: true,
      });
      for (const [blockIndex, block] of (section.blocks ?? []).entries()) {
        const blockId = block.id ?? `${section.id ?? "section"}-block-${blockIndex + 1}`;
        const eligible = block.provenance !== "editorial" && block.type !== "editor_note";
        const nestedItems = (block.items ?? []).filter((item) => item && typeof item === "object");
        const nestedColumns = (block.columns ?? []).filter((column) => column && typeof column === "object");
        if ((!nestedItems.length && !nestedColumns.length) || block.contextRefs?.length) {
          nodes.push({ ...block, id: blockId, text: nodeText(block, kind), eligible });
        }
        for (const [itemIndex, item] of nestedItems.entries()) {
          nodes.push({
            ...item,
            id: item.id ?? `${blockId}-item-${itemIndex + 1}`,
            text: String(item.text ?? ""),
            eligible,
          });
        }
        for (const [columnIndex, column] of nestedColumns.entries()) {
          nodes.push({
            ...column,
            id: column.id ?? `${blockId}-column-${columnIndex + 1}`,
            text: [column.title, ...(column.items ?? []).map((item) => typeof item === "string" ? item : item?.text)].filter(Boolean).join(" "),
            eligible,
          });
        }
      }
    }
  }
  return nodes;
}

function normalizedTerm(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function nodeMentionsEntry(node, entry) {
  const text = normalizedTerm(node.text);
  return [entry.name, ...(entry.aliases ?? [])]
    .some((name) => text.includes(normalizedTerm(name)));
}

function nodePreviewsEntry(node, ref) {
  return (node.contextPreviewRefs ?? []).includes(ref);
}

export function contextGuideUsageErrors(document, guide, {
  kind,
  selectedRefs = null,
  enforceEarliest = false,
} = {}) {
  const errors = [];
  const entries = contextGuideEntryMap(guide);
  const selected = selectedRefs === null
    ? new Set(entries.keys())
    : new Set(selectedRefs);
  const nodes = contextRefNodes(document, kind);
  const markedByRef = new Map();
  for (const node of nodes) {
    for (const ref of node.contextPreviewRefs ?? []) {
      const entry = entries.get(ref);
      if (!entry) {
        errors.push(`${kind} ${node.id ?? "block"} 将未知 context entry 标为预告：${ref}`);
        continue;
      }
      if (!selected.has(ref)) errors.push(`${kind} 将未被 contextGuide 选中的名词 ${entry.name} 标为预告。`);
      if ((node.contextRefs ?? []).includes(ref)) {
        errors.push(`${kind} ${node.id ?? "block"} 不能同时把 ${entry.name} 标为背景注和纯预告。`);
      }
      if (!nodeMentionsEntry(node, entry)) {
        errors.push(`${kind} ${node.id ?? "block"} 将 ${entry.name} 标为纯预告，但正文未出现其名称或别名。`);
      }
    }
    for (const ref of node.contextRefs ?? []) {
      const entry = entries.get(ref);
      if (!entry) {
        errors.push(`${kind} ${node.id ?? "block"} 引用未知 context entry：${ref}`);
        continue;
      }
      if (!selected.has(ref)) errors.push(`${kind} 标记了未被 contextGuide 选中的名词 ${entry.name}。`);
      const marked = markedByRef.get(ref) ?? [];
      marked.push(node);
      markedByRef.set(ref, marked);
      if (!nodeMentionsEntry(node, entry)) {
        errors.push(`${kind} ${node.id ?? "block"} 标记了 ${entry.name}，但正文未出现其名称或别名。`);
      }
      if (enforceEarliest && !node.eligible) errors.push(`${kind} ${node.id ?? "block"} 不是 ${entry.name} 的实质正文位置；标题、纯预告、过渡或编辑块不能承载背景注。`);
    }
  }
  for (const ref of selected) {
    const entry = entries.get(ref);
    if (!entry) {
      errors.push(`${kind} contextGuide 选择了未知条目：${ref}`);
      continue;
    }
    const marked = markedByRef.get(ref) ?? [];
    if (!marked.length) {
      errors.push(`${kind} 未设置 ${entry.name} 的首次关键出现 contextRef。`);
      continue;
    }
    if (marked.length > 1) errors.push(`${kind} 重复标记关键名词 ${entry.name}；背景注只允许在首次关键出现处生成。`);
    if (enforceEarliest) {
      const earliest = nodes.find((node) => node.eligible
        && !nodePreviewsEntry(node, ref)
        && nodeMentionsEntry(node, entry));
      if (!earliest) {
        errors.push(`${kind} 找不到 ${entry.name} 的实质正文出现位置。`);
      } else if (marked[0]?.id !== earliest.id) {
        errors.push(`${kind} ${entry.name} 必须标记在最早实质出现 ${earliest.id}，不能延后到 ${marked[0]?.id ?? "未知位置"}。`);
      }
    }
  }
  return unique(errors);
}
