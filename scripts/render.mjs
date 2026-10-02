import fs from "node:fs/promises";
import path from "node:path";
import {
  assertEditorialBlock,
  EDITOR_NOTE_INTENT_LABELS,
  editorPersonaErrors,
  publicVersionErrors,
} from "./brief-contract.mjs";
import {
  isMain,
  loadCase,
  readJson,
  REPO_ROOT,
  resolveCaseDir,
  writeText,
} from "./lib.mjs";
import {
  participantGuideContractErrors,
} from "./participant-guide.mjs";
import {
  CONTEXT_KIND_LABELS,
  contextGuideContractErrors,
  contextGuideEntryMap,
  contextGuideUsageErrors,
  selectContextGuideEntries,
} from "./context-guide.mjs";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function provenanceLabel(block) {
  if (block.label) return block.label;
  return {
    source_fact: "原文信息",
    speaker_view: "说话人观点",
    external: "背景补充",
  }[block.provenance];
}

function citationMarks(refs, citationIndex) {
  return (refs ?? [])
    .map((ref) => {
      const index = citationIndex.get(ref);
      return index
        ? `<a class="citation-ref" href="#source-${escapeHtml(ref)}" aria-label="来源 ${index}">[${index}]</a>`
        : "";
    })
    .join("");
}

function renderParticipantPerson(person, citationIndex, { compact = false, headingTag = "h3" } = {}) {
  const context = compact ? (person.briefContext ?? person.relevantContext ?? "") : (person.relevantContext ?? "");
  const role = [person.roleAtEvent, person.affiliationAtEvent].filter(Boolean).join(" · ");
  return `<article class="participant-card" data-participant-id="${escapeHtml(person.id)}">
    <${headingTag} class="participant-name">${escapeHtml(person.name)}</${headingTag}>
    <p class="participant-role">${escapeHtml(role)}</p>
    ${context || person.citationRefs?.length ? `<p class="participant-context">${escapeHtml(context)}${citationMarks(person.citationRefs, citationIndex)}</p>` : ""}
  </article>`;
}

export function renderParticipantGuide(guide, citationIndex) {
  if (!guide) return "";
  const dateLabel = guide.dateBasis === "publication" ? "本期资料发布时" : "本场活动发生时";
  const principals = (guide.principals ?? [])
    .map((person) => renderParticipantPerson(person, citationIndex, { compact: true }))
    .join("\n");
  const supporting = (guide.supportingRoles ?? [])
    .map((person) => renderParticipantPerson(person, citationIndex, { compact: true, headingTag: "h4" }))
    .join("\n");
  return `<section class="participant-guide" id="participant-guide" data-component="participant_guide" data-provenance="external">
    <div class="participant-guide-heading">
      <span class="participant-guide-mark" aria-hidden="true"></span>
      <div>
        <h2>人物速记</h2>
        <p>身份以 ${escapeHtml(guide.eventDate)} ${dateLabel}为准；具体主张见主题章节。</p>
      </div>
    </div>
    <div class="participant-grid">${principals}</div>
    ${supporting ? `<div class="participant-supporting"><h3>现场角色</h3><div class="participant-supporting-grid">${supporting}</div></div>` : ""}
  </section>`;
}

function contextStatementMarks(statement, citationIndex) {
  return citationMarks(statement?.citationRefs, citationIndex);
}

function contextEvidenceMarks(statement) {
  const refs = statement?.evidenceRefs ?? [];
  if (!refs.length) return "";
  return `<span class="context-evidence-refs" aria-label="访谈证据 ${escapeHtml(refs.join("、"))}">${refs
    .map((ref) => `<a href="evidence-book.md#${escapeHtml(ref.toLowerCase())}">[${escapeHtml(ref)}]</a>`)
    .join("")}</span>`;
}

function contextAllMarks(statement, citationIndex) {
  return `${contextEvidenceMarks(statement)}${contextStatementMarks(statement, citationIndex)}`;
}

export function renderContextGuide(guide, citationIndex, entryRefs = null) {
  if (!guide) return "";
  const entryMap = contextGuideEntryMap(guide);
  const entries = entryRefs?.length ? entryRefs.map((ref) => entryMap.get(ref)).filter(Boolean) : guide.entries;
  const cards = entries.map((entry) => `<article class="context-card" data-context-id="${escapeHtml(entry.id)}">
    <div class="context-card-title"><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(CONTEXT_KIND_LABELS[entry.kind])}</span></div>
    <p>${escapeHtml(entry.inlineDefinition.text)}</p>
    <p class="context-card-background">${escapeHtml(entry.background.text)}${contextStatementMarks(entry.background, citationIndex)}</p>
  </article>`).join("\n");
  return `<section class="context-guide" id="context-guide" data-component="context_guide" data-provenance="system">
    <div class="context-guide-heading">
      <span class="context-guide-mark" aria-hidden="true"></span>
      <div><h2>关键名词速记</h2><p>只解释理解后文所必需的产品、项目与概念。</p></div>
    </div>
    <div class="context-grid">${cards}</div>
  </section>`;
}

export function shouldRenderStandaloneContextGuide(brief) {
  return Boolean(brief?.contextGuide) && brief.schemaVersion !== "1.7.0";
}

export function renderContextInlineNote(entry, citationIndex, { detailed = false } = {}) {
  if (!detailed) {
    return `<aside class="context-inline-note" data-context-ref="${escapeHtml(entry.id)}">
      <span class="context-inline-label">${escapeHtml(entry.name)}</span>
      <p>${escapeHtml(entry.inlineDefinition.text)}${contextStatementMarks(entry.inlineDefinition, citationIndex)}</p>
    </aside>`;
  }
  return `<aside class="context-inline-note context-inline-note-detailed" data-context-ref="${escapeHtml(entry.id)}">
    <div class="context-inline-heading"><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(CONTEXT_KIND_LABELS[entry.kind])}</span></div>
    <dl class="context-inline-details">
      <div><dt>是什么</dt><dd>${escapeHtml(entry.inlineDefinition.text)}${contextAllMarks(entry.inlineDefinition, citationIndex)}</dd></div>
      <div><dt>背景</dt><dd>${escapeHtml(entry.background.text)}${contextAllMarks(entry.background, citationIndex)}</dd></div>
      <div><dt>本期作用</dt><dd>${escapeHtml(entry.relevance.text)}${contextAllMarks(entry.relevance, citationIndex)}</dd></div>
    </dl>
  </aside>`;
}

export function renderContextInlineNotes(block, guide, citationIndex, seen, { detailed = false } = {}) {
  if (!guide || !block.contextRefs?.length) return "";
  const entryMap = contextGuideEntryMap(guide);
  const notes = [];
  for (const ref of block.contextRefs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const entry = entryMap.get(ref);
    if (!entry) continue;
    notes.push(renderContextInlineNote(entry, citationIndex, { detailed }));
  }
  return notes.length ? `<div class="context-inline-notes">${notes.join("\n")}</div>` : "";
}

function locatorStart(value) {
  return String(value ?? "").match(/\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/u)?.[0]?.replace(/\.\d+$/u, "")
    ?? String(value ?? "").split(/[–—-]/u)[0].trim();
}

export function controlledBriefQuoteErrors(block) {
  const errors = [];
  if (!["verbatim", "spoken_cleanup"].includes(block?.quoteMode)) {
    errors.push("quoteMode 必须是 verbatim 或 spoken_cleanup。");
    return errors;
  }
  if (!String(block.attribution ?? "").trim()) errors.push("受控引语必须具有 attribution。");
  if (!String(block.text ?? "").trim()) errors.push("受控引语正文不能为空。");
  if (block.quoteMode === "spoken_cleanup") {
    if (!String(block.sourceLocator ?? "").trim()) errors.push("spoken_cleanup 必须具有 sourceLocator。");
    if (!String(block.sourceText ?? "").trim()) errors.push("spoken_cleanup 必须具有 sourceText。");
  }
  return errors;
}

function quoteAttributionHtml(block, controlled) {
  if (!block.attribution) return "";
  if (controlled && block.quoteMode === "spoken_cleanup") {
    return `<figcaption class="quote-attribution">——${escapeHtml(block.attribution)}〔口语整理 · ${escapeHtml(locatorStart(block.sourceLocator))}〕</figcaption>`;
  }
  return `<figcaption class="quote-attribution">——${escapeHtml(block.attribution)}</figcaption>`;
}

function blockShell(block, content, extraClass = "") {
  const label = provenanceLabel(block);
  return `<div class="content-block ${extraClass}" data-component="${escapeHtml(block.type)}" data-provenance="${escapeHtml(block.provenance)}">
    ${label ? `<div class="block-label">${escapeHtml(label)}</div>` : ""}
    ${content}
  </div>`;
}

export function renderBlock(block, citationIndex, editorPersona, briefSchemaVersion = "1.3.0", contextRuntime = null) {
  assertEditorialBlock(block);
  const marks = citationMarks(block.citationRefs, citationIndex);
  const itemContext = (item) => contextRuntime
    ? renderContextInlineNotes(item, contextRuntime.guide, citationIndex, contextRuntime.seen, { detailed: contextRuntime.detailed })
    : "";
  switch (block.type) {
    case "paragraph":
      return blockShell(block, `<p>${escapeHtml(block.text)}${marks}</p>`, "paragraph-block");
    case "bullets": {
      const items = (block.items ?? [])
        .map((item) => `<li><span>${escapeHtml(item.text)}${citationMarks(item.citationRefs, citationIndex)}</span>${itemContext(item)}</li>`)
        .join("\n");
      return blockShell(block, `<ul class="bullet-list">${items}</ul>`, "bullets-block");
    }
    case "quote": {
      const controlled = briefSchemaVersion === "1.4.0" || Object.hasOwn(block, "quoteMode");
      if (controlled) {
        const problems = controlledBriefQuoteErrors(block);
        if (problems.length) throw new Error(problems.join(" "));
      }
      return blockShell(
        block,
        `<figure class="quote-block tone-${escapeHtml(block.tone ?? "yellow")}">
          <blockquote>“${escapeHtml(block.text)}”${marks}</blockquote>
          ${quoteAttributionHtml(block, controlled)}
        </figure>`,
        "quote-wrapper",
      );
    }
    case "callout":
      return blockShell(
        block,
        `<aside class="callout tone-${escapeHtml(block.tone ?? "blue")}">
          ${block.title ? `<h3 class="callout-title">${escapeHtml(block.title)}</h3>` : ""}
          <p>${escapeHtml(block.text)}${marks}</p>
        </aside>`,
        "callout-wrapper",
      );
    case "stats": {
      const items = block.items ?? [];
      const cards = items
        .map(
          (item) => `<div class="stat-card">
            <div class="stat-value">${escapeHtml(item.value ?? "")}</div>
            <div class="stat-label">${escapeHtml(item.label ?? "")}${citationMarks(item.citationRefs, citationIndex)}</div>
            ${item.text ? `<div class="stat-text">${escapeHtml(item.text)}</div>` : ""}
            ${itemContext(item)}
          </div>`,
        )
        .join("\n");
      return blockShell(
        block,
        `<div class="stats-grid" style="--columns:${Math.min(Math.max(items.length, 2), 4)}">${cards}</div>`,
        "stats-block",
      );
    }
    case "comparison": {
      const columns = block.columns ?? [];
      const cards = columns
        .map(
          (column) => `<div class="comparison-card tone-${escapeHtml(column.tone ?? "plain")}">
            <h3 class="comparison-title">${escapeHtml(column.title)}</h3>
            <ul>${column.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
            ${itemContext(column)}
          </div>`,
        )
        .join("\n");
      return blockShell(
        block,
        `<div class="comparison-grid" style="--columns:${Math.min(Math.max(columns.length, 2), 3)}">${cards}</div>${marks}`,
        "comparison-block",
      );
    }
    case "steps": {
      const items = (block.items ?? [])
        .map(
          (item, index) => `<div class="step-item">
            <div class="step-number">${String(index + 1).padStart(2, "0")}</div>
            <div class="step-text">${escapeHtml(item.text)}${citationMarks(item.citationRefs, citationIndex)}${itemContext(item)}</div>
          </div>`,
        )
        .join("\n");
      return blockShell(block, `<div class="steps-list">${items}</div>`, "steps-block");
    }
    case "editor_note": {
      const personaProblems = editorPersonaErrors(editorPersona);
      if (personaProblems.length) throw new Error(personaProblems.join(" "));
      const intentLabel = EDITOR_NOTE_INTENT_LABELS[block.intent];
      return `<div class="content-block editor-note-block" data-component="editor_note" data-provenance="editorial">
        <aside class="editor-note" data-editor-intent="${escapeHtml(block.intent)}">
          <div class="editor-note-heading">
            <span class="editor-note-avatar" aria-hidden="true">${escapeHtml(editorPersona.avatarText)}</span>
            <h3 class="editor-note-title"><span class="editor-note-name">${escapeHtml(editorPersona.name)}</span> <span class="editor-note-action">${escapeHtml(intentLabel)}：</span><span class="editor-note-subject">${escapeHtml(block.title)}</span></h3>
          </div>
          <p class="editor-note-text">${escapeHtml(block.text)}${marks}</p>
        </aside>
      </div>`;
    }
    default:
      throw new Error(`未知组件类型：${block.type}`);
  }
}

export function footerText(brand, publicVersion, editorPersona) {
  const problems = [
    ...publicVersionErrors(publicVersion),
    ...editorPersonaErrors(editorPersona),
  ];
  if (problems.length) throw new Error(problems.join(" "));
  return `${brand} ${publicVersion} · ${editorPersona.footerRole} ${editorPersona.name} 整理 · UID ${editorPersona.uid}`;
}

export function titleMarkHtml() {
  return '<div class="title-mark" aria-hidden="true"><span class="title-mark-core"></span></div>';
}

export async function renderCase(caseDir) {
  const { manifest } = await loadCase(caseDir);
  const [brief, css, config, participantGuide, contextGuide] = await Promise.all([
    readJson(path.join(caseDir, "output", "brief.json")),
    fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8"),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
    readJson(path.join(caseDir, "work", "participant-guide.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    readJson(path.join(caseDir, "work", "context-guide.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  const personaProblems = editorPersonaErrors(config.editorPersona);
  const configProblems = [...personaProblems, ...publicVersionErrors(config.publicVersion)];
  if (configProblems.length) throw new Error(configProblems.join(" "));
  if (!["1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"].includes(brief.schemaVersion)) {
    throw new Error("brief schemaVersion 必须为 1.3.0–1.7.0 的已知版本，拒绝渲染未知产物。");
  }
  if (brief.workflowVersion !== manifest.workflow?.version) throw new Error("brief workflowVersion 与 case.json 不一致，拒绝渲染。");
  if (brief.templateVersion !== manifest.workflow?.templateVersion) throw new Error("brief templateVersion 与 case.json 不一致，拒绝渲染。");
  if (brief.profile?.primary !== manifest.profile?.primary) throw new Error("brief profile 与 case.json 不一致，拒绝渲染。");
  if (brief.density?.total === undefined) throw new Error("brief 缺少密度信息，拒绝渲染。");
  const citationIndex = new Map(brief.citations.map((item, index) => [item.id, index + 1]));
  if (["1.5.0", "1.6.0", "1.7.0"].includes(brief.schemaVersion) && (manifest.sourceType !== "article" || participantGuide || brief.participantGuide)) {
    if (!participantGuide) throw new Error("brief 1.5.0 缺少 work/participant-guide.json。");
    const guideErrors = participantGuideContractErrors(participantGuide, {
      manifest,
      citationIds: new Set(brief.citations.map((item) => item.id)),
    });
    if (guideErrors.length) throw new Error(guideErrors.join(" "));
    if (brief.participantGuide?.guideRef !== "work/participant-guide.json") {
      throw new Error("brief.participantGuide.guideRef 必须指向 work/participant-guide.json。");
    }
  }
  if (brief.schemaVersion === "1.7.0" && !brief.contextGuide) {
    if (contextGuide) throw new Error("brief 1.7.0 缺少 contextGuide inline_first_use 绑定。");
    const errors = contextGuideUsageErrors(brief, null, { kind: "brief", enforceEarliest: true });
    if (errors.length) throw new Error(errors.join(" "));
  }
  if (brief.contextGuide) {
    if (!contextGuide) throw new Error("brief.contextGuide 已声明，但缺少 work/context-guide.json。");
    const renderedContextGuide = selectContextGuideEntries(contextGuide, brief.contextGuide.entryRefs ?? []);
    const contextErrors = contextGuideContractErrors(renderedContextGuide, {
      manifest,
      evidenceIds: new Set(),
      citationIds: new Set(brief.citations.map((item) => item.id)),
    }).filter((message) => !message.includes("引用未知 claim"));
    contextErrors.push(...contextGuideUsageErrors(brief, contextGuide, {
      kind: "brief",
      selectedRefs: brief.contextGuide.entryRefs,
      enforceEarliest: brief.schemaVersion === "1.7.0",
    }));
    if (brief.contextGuide.guideRef !== "work/context-guide.json") contextErrors.push("brief.contextGuide.guideRef 必须指向 work/context-guide.json。");
    if (brief.contextGuide.type !== "context_guide" || brief.contextGuide.provenance !== "system") contextErrors.push("brief.contextGuide 必须保持 type=context_guide、provenance=system。");
    if (brief.schemaVersion === "1.7.0" && brief.contextGuide.placement !== "inline_first_use") contextErrors.push("brief 1.7.0 contextGuide.placement 必须为 inline_first_use。");
    for (const ref of brief.contextGuide.entryRefs ?? []) if (!contextGuideEntryMap(contextGuide).has(ref)) contextErrors.push(`brief.contextGuide 引用未知条目：${ref}`);
    if (contextErrors.length) throw new Error([...new Set(contextErrors)].join(" "));
  }
  const seenContextRefs = new Set();
  const contextRuntime = {
    guide: contextGuide,
    seen: seenContextRefs,
    detailed: brief.schemaVersion === "1.7.0",
  };
  const sections = brief.sections
    .map((section) => {
      const anchors = (section.timeAnchors ?? [])
        .map((anchor) => {
          const tag = anchor.href ? "a" : "span";
          const href = anchor.href ? ` href="${escapeHtml(anchor.href)}"` : "";
          return `<${tag} class="time-anchor"${href}>${escapeHtml(anchor.label)}</${tag}>`;
        })
        .join("");
      return `<section class="quick-section" id="${escapeHtml(section.id)}" data-component="section">
        <div class="section-heading">
          <span class="section-number">${section.number}</span>
          <h2>${escapeHtml(section.title)}</h2>
        </div>
        <p class="section-lead">${escapeHtml(section.lead)}</p>
        ${renderContextInlineNotes(section, contextGuide, citationIndex, seenContextRefs, { detailed: brief.schemaVersion === "1.7.0" })}
        ${anchors ? `<div class="time-anchors">${anchors}</div>` : ""}
        ${section.blocks.map((block) => `${renderBlock(block, citationIndex, config.editorPersona, brief.schemaVersion, contextRuntime)}${renderContextInlineNotes(block, contextGuide, citationIndex, seenContextRefs, { detailed: brief.schemaVersion === "1.7.0" })}`).join("\n")}
      </section>`;
    })
    .join("\n");

  const sources = brief.citations.length
    ? `<section class="sources" id="sources">
        <h2>背景资料与核验来源</h2>
        <ol class="source-list">
          ${brief.citations
            .map(
              (item) => `<li id="source-${escapeHtml(item.id)}"><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a> · ${escapeHtml(item.publisher)} · 访问于 ${escapeHtml(item.accessedAt)}</li>`,
            )
            .join("\n")}
        </ol>
      </section>`
    : "";

  const meta = [
    brief.sourceMeta.label,
    brief.sourceMeta.duration ? `原内容 ${brief.sourceMeta.duration}` : null,
    `预计阅读 ${brief.readingMinutes} 分钟`,
    `生成于 ${brief.generatedAt}`,
  ].filter(Boolean);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="generator" content="${escapeHtml(brief.brand)} workflow ${escapeHtml(brief.workflowVersion)}; template ${escapeHtml(brief.templateVersion)}">
  <title>${escapeHtml(brief.title)} · ${escapeHtml(brief.brand)}</title>
  <style>${css}</style>
</head>
<body>
  <article class="page" data-case-id="${escapeHtml(brief.caseId)}" data-profile="${escapeHtml(brief.profile.primary)}" data-density-score="${escapeHtml(brief.density.total)}" data-public-version="${escapeHtml(config.publicVersion)}" data-workflow-version="${escapeHtml(brief.workflowVersion)}" data-template-version="${escapeHtml(brief.templateVersion)}">
    <div class="page-inner">
      <header class="masthead">
        <div class="brand">${escapeHtml(brief.brand)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p class="deck">${escapeHtml(brief.subtitle)}</p>
        <div class="meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        ${titleMarkHtml()}
      </header>
      <p class="hero-summary">${escapeHtml(brief.summary)}</p>
      ${renderParticipantGuide(participantGuide, citationIndex)}
      ${shouldRenderStandaloneContextGuide(brief) ? renderContextGuide(contextGuide, citationIndex, brief.contextGuide.entryRefs) : ""}
      ${sections}
      ${sources}
      <footer class="footer">
        <span>${escapeHtml(footerText(brief.brand, config.publicVersion, config.editorPersona))}</span>
      </footer>
    </div>
  </article>
</body>
</html>`;
  const outputPath = path.join(caseDir, "output", "quickread.html");
  await writeText(outputPath, html);
  return { manifest, outputPath };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await renderCase(caseDir);
    console.log(`已渲染：${path.relative(REPO_ROOT, result.outputPath)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
