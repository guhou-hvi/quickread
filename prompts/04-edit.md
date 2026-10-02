# 04 — Quick-read editorial brief（Prompt 3.4.2）

## Objective and input boundary

Turn a verified reader edition into a concise thematic reading experience for a broad Chinese audience. Deep-read is the upstream source of truth; brief is never used to create or repair deep-read.

Allowed inputs: verified `output/deep-read.json`, deterministic `deep-read.md`, resolved `reader-map.json`, `case.json`, profile/density metadata, and verified citations. Open source spans only to validate a selected quote or locator.

Forbidden inputs: old briefs, old reader editions, raw claim text as drafting material, HTML/CSS, image layout, character-retention targets, coverage scores as content, or material absent from the verified deep-read. Do not introduce a new source claim merely because it appears in evidence-book.

## Narrative rules

- Use 4–8 sections organised by the strongest explanatory thread, not mechanical chronology.
- Give the reader the thesis first, then selective evidence, tensions, and implications already established in deep-read.
- Retain time or article anchors so readers can return to the source.
- Use examples, numbers, and quotes selectively; exhaustive detail remains in `deep-read.md` and `evidence-book.md`.
- Every source-derived brief statement must resolve to one or more deep-read blocks and their evidence references. Compression may combine sentences, but must preserve conditions, uncertainty and attribution.
- Mark QR-Pilot interpretation as `editorial`, source views as `speaker_view`, background as `external`, and direct source statements as `source_fact`.
- Copy `profile` and `density` from the verified deep-read contract. Set `readingMinutes` from actual structured content at 450 Chinese characters per minute.
- The adaptive character target remains a planning hint only. There is no minimum-character acceptance gate; never add repetition or low-value material to reach a number.
- Do not copy atomic claim wording merely because it is traceable. Rewrite coherent reader prose while preserving meaning and references.
- Preserve the reader edition's concept-first order: explain a method's function before naming it, and do not reintroduce acronyms or technical branches that the reviewed deep-read intentionally left in the evidence archive.
- Give broad readers only the background needed for the current point. Use a short identity anchor for a person or institution only when the argument depends on who they are.
- Keep each section focused on one explanatory job. Remove repeated cautions and abstract closing slogans; state a necessary limitation once, in the block where it changes interpretation.
- When the deep-read presents a problem, constraint, response, and organisational consequence, retain that causal order instead of leading with the proposed solution.
- Preserve 2–4 of the reviewed deep-read's most useful emotional anchors when they clarify the person or argument. Prefer the guest's research emotion, industry criticism, or decision tension; do not turn the brief into a quote collection and never invent emotional language.
- Keep strong guest judgments explicitly attributed. A calm editorial voice must not flatten the guest's authentic anxiety, frustration, courage, doubt, metaphor, or criticism.

## Component selection

Write `output/brief.json` conforming to `schemas/brief.schema.json`. Choose components by meaning:

For new 2.4.2 artifacts, write brief schema 1.7.0 and set top-level `participantGuide.guideRef` to `work/participant-guide.json`. Bind the shared key-term source as `contextGuide: { type: "context_guide", provenance: "system", guideRef: "work/context-guide.json", entryRefs: [...], placement: "inline_first_use" }`, selecting only terms actually needed by the brief. Set each selected term's `contextRefs` exactly once on its first substantive non-editorial node. A section lead is substantive when it already explains the term's role; attach the note to that section. Header summaries and titles remain navigation surfaces. If a mixed-purpose node only previews a particular term, declare that term in `contextPreviewRefs` instead of moving its note to the front. The renderer places the three-line note at first substantive use and must not create a standalone key-term section.

- `paragraph`: narrative explanation;
- `bullets`: genuinely parallel evidence or implications;
- `quote`: short `verbatim` or validated `spoken_cleanup` wording only. Supply `quoteMode`, `sourceLocator`, and `sourceText`; the renderer owns the fixed “口语整理” attribution label;
- `callout`: source-grounded conclusion, background, or caution, but never QR-Pilot synthesis;
- `stats`: 2–4 comparable numbers;
- `comparison`: two or three genuinely parallel positions;
- `steps`: a process or chronological development, not an arbitrary list;
- `editor_note`: the only permitted component for `editorial` provenance.

Every QR-Pilot block must use this fixed content contract:

```json
{
  "type": "editor_note",
  "provenance": "editorial",
  "intent": "commentary",
  "title": "一句观点标题",
  "text": "一段观点正文"
}
```

- Choose exactly one machine-readable intent; never write the Chinese action label yourself:
  - `summary`: faithfully compress the guest's stated position without adding a new inference. It must include one or more `evidenceRefs`.
  - `commentary`: explain significance, connect evidence, or derive a clearly editorial implication.
  - `critique`: challenge an overclaim, contradiction, or hidden cost. Use it sparingly and never as a clickbait tone marker.
  - `caution`: surface a risk, limitation, dependency, or boundary condition.
- Supply only the viewpoint title and one plain-text paragraph. Evidence or citation references may be attached when needed for traceability.
- Never embed “总结／点评／锐评／提醒” in the title. The renderer places `QR-Pilot {动作词}：` before it.
- Never emit `label`, `tone`, `attribution`, `items`, `columns`, HTML, CSS, an avatar, or the QR-Pilot name inside the block.
- Never apply `editorial` to `paragraph`, `callout`, `comparison`, or any other component.
- Do not write `footerNote`; the renderer owns the editor identity and footer copy.

Avoid consecutive cards of the same type. A clean narrative paragraph between visual blocks improves rhythm. If compression would remove a necessary qualification, keep the qualification and shorten a less important example instead.
