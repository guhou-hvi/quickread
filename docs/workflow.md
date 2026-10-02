# QuickRead Longform

> 技术流程与维护参考。本页完整保留宣传整理前的 README 内容；命令均从仓库根目录执行。用户入口见 [项目首页](../README.md)，首次使用见 [快速开始](getting-started.md)。实际处理以 [AGENTS.md](../AGENTS.md) 和对应版本的提示词为准。

QuickRead Longform turns long interview subtitles or articles into three coordinated delivery layers:

- a coherent reader edition (`deep-read.md`);
- a searchable evidence archive (`evidence-book.md` plus `evidence.jsonl`);
- a responsive HTML quick-read, a 1660 px desktop long PNG, and a 1080 px mobile-first long PNG.

The project does not call an AI API. You start a conversation in this repository, point the agent to a local `SRT`, `VTT`, `TXT`, or `MD` file, and the agent follows `AGENTS.md`.

The shortest path is to drop one source into `inbox/` and say `处理 inbox` in the project conversation. The agent archives the immutable original into a case, runs the staged Profile-aware content and independent-review workflow, validates it, and produces all deliverables.

## Reader-first incremental review policy 2.4.2

QuickRead 2.4 treats coverage, recall, evidence-book/body coverage, bundle density, length, paragraph/list/timeline counts and reviewer scores as diagnostics. It also reviews evidence changes by dependency scope: mechanical changes use deterministic checks, traceable semantic deltas review only affected claims and reader blocks, and full Claim Audit is reserved for untraceable structural changes or a case without an accepted baseline.

Only concrete integrity failures block automatically: an unsupported, contradicted, misattributed or fabricated published statement; wrong provenance; an invalid citation; stale/hash/schema/reference/render corruption; or a core omission independently confirmed by two roles. A core omission must be a complete source proposition whose absence changes a core conclusion, mechanism, decision logic, key boundary or important counterexample.

The reader edition is written in calm, third-person observer prose without flattening the guest's authentic emotion, metaphors, doubt or criticism. Strong judgments remain explicitly attributed; controlled `spoken_cleanup` quotes may remove disfluency but cannot add, reorder or translate away the speaker's meaning or code-switching. A 12,000–18,000 Chinese-character length and roughly 6–8 chapters are useful targets, not gates. Interview cases add a cited participant guide: one concise guest card for a single interview, or a multi-speaker guide for debates and roundtables. It records event-time identity and relevant context, never policy positions or rankings.

When a product, project, organization, technology, concept, or event repeatedly carries the interview's argument, 2.4.2 reads it from `work/context-guide.json`. Selection depends on comprehension value rather than frequency. Deep-read and quick-read no longer render a standalone key-term section: each selected term receives one compact three-line note—what it is, cited background, and why it matters here—immediately after its first substantive use. Titles, transitions, editorial blocks, and leads that only preview later discussion are ignored; a quick-read section lead that already explains the term's role counts as substantive and carries the note itself. The guide never contains people and contributes nothing to subtitle coverage, recall, reader-map coverage, or repair-attempt counts.

Context Upgrade now covers all 25 cases through a separate resumable ledger and never invokes the 2.4 evidence migration. The first fifteen retained cases remain in batches 1–3; the ten cases migrating from 1.5 use batches 4–5 only after their 2.4 content baseline is accepted:

Retained-case upgrade commands require explicit authorization; there is no active batch in a fresh checkout.

## Repository model

Unprocessed local drops live temporarily in `inbox/` and are ignored by Git. Each processed case is isolated under `cases/qr-NNNN-<person>-<topic>/`:

```text
case.json       metadata, source hash, and workflow versions
input/          immutable source
legacy/         previous outputs kept for comparison
work/           normalized source, atomic claims, bundles, reader map, isolated reviews, quality
output/         deep-read.json/md, evidence-book.md, brief.json, quickread.html, quickread*.png
```

Reference images and the reverse-engineered visual specification live under `references/`. Prompt, template, and schema versions are global so stale outputs can be detected.

Browse every processed case through [cases/README.md](../cases/README.md) or the searchable local [cases/index.html](../cases/index.html). Both catalogs expose Profile, Lens, reader length guidance, diagnostic coverage, evidence-book access, audit, and source status; run `npm run catalog` after metadata or outputs change.

Quick-read editorial synthesis has one reader-facing identity: `QR-Pilot`. In `brief.json`, it must use the dedicated `editor_note` component with a controlled `summary`, `commentary`, `critique`, or `caution` intent, a viewpoint title, and one body paragraph. The renderer maps those intents to “总结／点评／锐评／提醒” and owns the QR avatar, purple card styling, and `QuickRead Longform v0.1` footer, so cases cannot override them. A `summary` must include evidence references to the guest's source material. The deep-read contains no QR-Pilot cards and uses no `editor_note`.

## Install

```powershell
npm install
```

Only `playwright-core` is installed. Rendering uses the existing Microsoft Edge executable and does not download another browser.

## Process a new source

### Drop-zone workflow

Put one `SRT`, `VTT`, `TXT`, or `MD` file in `inbox/`, then say:

```text
处理 inbox
```

If several supported files are present, name the intended file. The equivalent intake command is:

```powershell
npm run ingest -- my-interview
npm run ingest -- my-interview "specific-file.srt"
```

The argument is a descriptive lowercase ASCII slug, not a case number. Intake allocates the next number and creates a directory such as `cases/qr-0010-my-interview/`. Successful intake preserves the original bytes and filename under its `input/`, records its SHA-256 and current workflow versions, and removes the corresponding inbox copy. A failed or ambiguous intake leaves the inbox files untouched.

### External-path workflow

In conversation, say:

```text
处理 D:\path\to\source.srt，案例名使用 my-interview。
```

The equivalent setup command is:

```powershell
npm run init-case -- my-interview D:\path\to\source.srt
```

The command prints the allocated case directory. Use that exact path for parsing and subsequent commands:

Every `review-prepare` packet is self-contained: it embeds the role instructions and output JSON Schema. A reviewer reads only that packet and writes only its declared output; it must not open repository prompts, schemas, author maps, or peer reports. Reviewer references always use the flattened `payload.readerLeaves[].id`; parent implementation block IDs are not exposed, preventing structurally valid reviews from pointing at an unresolvable level of the document tree.

```powershell
npm run parse -- cases\qr-0010-my-interview
npm run profile -- cases\qr-0010-my-interview --assessment work/profile-assessment.json
npm run segment -- cases\qr-0010-my-interview
# after atomic evidence is drafted, prepare and run the independent Claim Auditor:
npm run evidence-check -- cases\qr-0010-my-interview
npm run evidence-diff -- cases\qr-0010-my-interview
npm run review-prepare -- cases\qr-0010-my-interview --round 1 --claims-only --assign claim_auditor=agent-claim-0010
# if the primary report contains missing-support-quote findings, preview and apply only that mechanical bridge:
npm run claim-mechanical-fix -- cases\qr-0010-my-interview --dry-run
npm run claim-mechanical-fix -- cases\qr-0010-my-interview
npm run evidence-check -- cases\qr-0010-my-interview
# send only the primary semantic nonpass claims to an independent secondary auditor:
npm run claim-gate-prepare -- cases\qr-0010-my-interview --reviewer agent-claim-secondary-0010
# after the targeted secondary report is written, resolve agreement or prepare conflict-only adjudication:
npm run claim-gate-resolve -- cases\qr-0010-my-interview --reviewer agent-claim-adjudicator-0010
# after any requested adjudication report is written, run claim-gate-resolve again; proceed only on pass:
# then create claim bundles and the reader edition:
npm run build-deep -- cases\qr-0010-my-interview
npm run context-review -- prepare cases\qr-0010-my-interview external_citation=agent-context-source-0010 fidelity=agent-context-fidelity-0010 reader_advocate=agent-context-reader-0010
# after the three isolated reports are written:
npm run context-review -- validate cases\qr-0010-my-interview
npm run context-review -- record cases\qr-0010-my-interview baseline=work/reviews/2.4.0/reader-first/round-01/consensus.json
npm run review-prepare -- cases\qr-0010-my-interview --round 1 --assignments cases\qr-0010-my-interview\work\reviewers.json
# after the blind_recall report is frozen:
npm run review-prepare -- cases\qr-0010-my-interview --round 1 --refresh
npm run review-validate -- cases\qr-0010-my-interview --round 1
npm run review-consensus -- cases\qr-0010-my-interview --round 1
npm run quality -- cases\qr-0010-my-interview
npm run validate -- cases\qr-0010-my-interview
npm run render -- cases\qr-0010-my-interview
npm run screenshot -- cases\qr-0010-my-interview
npm run catalog
```

After the first accepted full review, record its immutable evidence baseline:

```powershell
npm run evidence-diff -- cases\qr-0010-my-interview --accept
```

For case workflow `2.4.2`, an explicit schema-1.1.0 `compound_claim` finding is a nonblocking organization warning only when support, speaker, importance and theme are all confirmed, with no other finding code or proposed axis change. Claim Gate retains the immutable auditor verdict and emits `warningDispositions` bound to the original entry and current claim hashes; it never manufactures a reviewer pass. Baseline acceptance binds that resolution and quality recomputes it. Legacy schema-1.0 findings, mixed codes, unsupported content, attribution errors and stale inputs remain on their existing gate paths.

If that first full review identifies a concrete repair before a baseline can be accepted, do not audit the whole evidence set again. After the independent Repair Editor applies the hash-bound Claim Gate decisions, seed the archived audit input as a temporary baseline and review only the declared delta:

```powershell
npm run evidence-diff -- cases\qr-0010-my-interview --seed-initial-audit-repair
npm run review-prepare -- cases\qr-0010-my-interview --claims-delta --assign claim_auditor=agent-claim-delta-0010
npm run review-validate-delta -- cases\qr-0010-my-interview
npm run evidence-diff -- cases\qr-0010-my-interview --accept
```

Later local evidence edits are classified automatically. `mechanical` needs only `evidence-check`; `semantic_delta` prepares only affected claims with `review-prepare --claims-delta` and is checked by `review-validate-delta`; `structural_full` explicitly requests one full Claim Auditor. Participant-guide updates do not modify evidence and do not consume a repair attempt.

After cloning or cleaning ignored review packets, recreate them without touching retained reports or the manifest:

```powershell
npm run review-prepare -- cases\qr-0010-my-interview --round 1 --rebuild-packets
```

The screenshot command always produces both full formats. Use `quickread-mobile.png` as the default phone/share deliverable; retain `quickread.png` for desktop. When the phone image exceeds 24,000 px, the same command also creates safe-break `quickread-mobile-01.png`, `-02.png`, and so on without deleting the full image.

## Existing-case development commands

```powershell
npm run build-deep -- cases\qr-0001-cage-ai-agent
npm run quality -- cases\qr-0001-cage-ai-agent
npm run check
npm run render-all
```

### Migrate retained cases to workflow 2.4

Migration is checkpointed and resumable. `--status` is read-only; a case or batch command prepares only cases explicitly listed in `config/pipeline.json` under `migration.activeCases`. It never advances a frozen batch merely because the global default version changed. When the user explicitly authorizes a named cross-batch subset, record exactly those case numbers in `migration.activeCases` before preparing them.

```powershell
npm run migrate-v24 -- --status
npm run migrate-v24 -- --status
npm run migrate-v24 -- --batch pilots
npm run migrate-v24 -- --batch legacy-a
npm run migrate-v24 -- --batch legacy-b
npm run migrate-v24 -- --batch legacy-c
```

After a migrated reader edition is built, the 2.4 reader and participant checks run before brief generation:

```powershell
npm run review-lite-prepare -- cases\<slug> --round 1 --assign source_scout=<id> --assign fidelity=<id> --assign reader_advocate=<id>
npm run review-lite-validate -- cases\<slug> --round 1
npm run review-lite-consensus -- cases\<slug> --round 1
npm run participant-review-prepare -- cases\<slug> --assign external_citation=<id> --assign reader_advocate=<id>
npm run record-participant-review -- cases\<slug>
npm run finalize-migration-v24 -- cases\<slug>
```

Each reviewer receives only its hash-bound packet. Finalization uses the latest completed `round-NN`; a later repair therefore does not require renaming or copying its reports back to `round-01`.

For a local reader-edition repair, declare every changed leaf and rerun only the roles whose inputs changed. `text` requires Fidelity and Reader Advocate; `evidence_refs`, `citation_refs`, or `provenance` require Fidelity only. Source Scout is inherited when no reader block is added, removed, moved, or retyped:

```powershell
npm run review-lite-prepare -- cases\<slug> --round 2 --base-round 1 `
  --change chapter-1-p01:text,evidence_refs `
  --change chapter-2-p01:evidence_refs `
  --assign fidelity=<new-id> --assign reader_advocate=<new-id>
npm run review-lite-validate -- cases\<slug> --round 2
npm run review-lite-consensus -- cases\<slug> --round 2
```

The delta manifest hash-binds the immutable base manifest/consensus, current inputs, exact before/after leaf hashes, and inherited reports. Undeclared leaf changes, source/evidence/research changes, or structural reader changes fail instead of silently broadening the review. Rerun-role reports replace only that role in the new consensus; unaffected reports remain inherited from the base round.

Two still narrower operations never create Agent packets. `--reader-map-mechanical` accepts only duplicate-entry canonicalization with the same evidenceRef, importance, presentation and exact union of `(readerBlockRef, readerTextQuote)` spans; all other inputs must be byte/hash unchanged. `--historical` seals an old round from its immutable manifest, packets and reports after the working reader has moved on; without that explicit flag validation remains bound to current files.

```powershell
npm run review-lite-prepare -- cases\<slug> --round 3 --base-round 2 --reader-map-mechanical
npm run review-lite-validate -- cases\<slug> --round 3
npm run review-lite-consensus -- cases\<slug> --round 3

npm run review-lite-validate -- cases\<slug> --round 1 --historical
npm run review-lite-consensus -- cases\<slug> --round 1 --historical
```

`deep-read.json` is the machine source for the reader edition, `evidence.jsonl` is the machine evidence source, and `reader-map.json` is only the writer's claim-to-text declaration. It cannot certify semantic coverage. `build-deep` deterministically renders both `deep-read.md` and `evidence-book.md`; external citations come from `work/research.json`, so this step never depends on a pre-existing `brief.json`. Profile configuration lives in `config/profiles.json`, with type-specific prompt fragments under `prompts/profiles/`.

The Claim Auditor first writes a hash-bound staging report to `work/claim-review.json`. New artifacts use workflow, prompt and review policy `2.4.2 / 3.4.2 / 2.4.2`; retained artifacts keep their recorded versions, so changing defaults alone does not invalidate or unfreeze retained cases. After an accepted baseline, reports bind to local claim, support-span, citation and reader-block hashes. Missing `supportSpans.quote` values may be repaired only by the deterministic quote-only command above; its before/after evidence and migration hashes form a mechanical bridge and does not consume a semantic repair attempt.

Re-running the claims-only preparation preserves the primary report beside its evidence-hash preflight, while full-round preparation validates the resolved claim gate and copies an immutable snapshot into the recorded review-policy round directory. Packets and their index isolate role inputs and are reproducible, so Git ignores them; `--rebuild-packets` restores them from the retained manifest and current hash-locked artifacts. Manifests, reports, consensus, adjudication and repair logs are retained. All review roles use unique reviewer IDs and independent contexts.

Blind Recall/Alignment act as a Source Scout, and Coverage A/B independently inspect reader expression. Their recall/coverage ratios, disagreements and confidence values are diagnostics. A disagreement escalated for a concrete contradiction or possible doubly confirmed core omission goes to an independent Adjudicator; ordinary disagreements remain diagnostic. Fidelity alone checks actual published statements for concrete support, attribution, provenance and citations; Reader Advocate reports specific comprehension problems while its six numeric scores remain diagnostic. Only a concrete contradiction or a core omission independently confirmed by two roles can promote completeness feedback into a hard error. Passing automatic and Agent review still requires the concentrated human checkpoint; agents never create or fill `work/human-review.json` for the user.

After a Repair Editor changes evidence, deep-read, or reader-map, run `evidence-diff` and review only the declared impact. A changed claim gets delta Claim Auditor review; a changed source-backed reader block gets Fidelity review; changed prose gets Reader Advocate review; Source Scout runs only when an addition or deletion may alter the core understanding. Blind Recall and Coverage A/B are not automatic consequences of a local edit. Unaffected historical reports remain valid and immutable.

Formal review labels and repair-attempt counts are independent. A retained audit may be `round-20` while the named case is only on its fifth authorized repair. Generate that consensus with `npm run review-consensus -- cases\<slug> --round 20 --repair-attempt 5`. The attempt must remain within the global or case-specific cap in `config/pipeline.json`; changing the formal round number never grants another repair.

## Adaptive content model

- Reader length is diagnostic. Aim for 12,000–18,000 Chinese characters and roughly 6–8 coherent chapters, but a concise complete article can pass and a longer article is revised only for a concrete fidelity or readability problem. Numbers never authorize padding.
- The quick-read target is `3,000 + 250 × density score`, bounded to 3,000–8,000 characters. It remains a layout target rather than a completeness claim; reading time is recalculated from actual text.
- Coverage 2.0 records how source units enter semantic segments. Evidence 2.0 stores retained atomic claims with continuous support spans. Mapping, recall and evidence-book coverage ratios are diagnostics. Every claim actually cited by deep-read or brief must be traceable, but low-value source detail need not be atomized or repeated to reach a percentage.
- `reader-map` 2.1 records only `explicit` or `synthesized` claims actually expressed in eligible reader prose, using exact reader quotes. It does not create placeholders for omitted claims and cannot certify semantic coverage.
- Claim bundles are selective planning aids rather than completeness ledgers. Multiple bundles may support one paragraph, and unselected claims may stay in the evidence layer. Bundle size, paragraph/list share and timeline density are diagnostics.
- Automatic advertisement exclusion accepts only explicit sponsor reads or promotional calls to action. Substantive discussion is never excluded merely because it contains “广告” or “赞助”; a concrete missing core proposition must still be confirmed independently before it becomes a hard omission.
- Five structural Profiles are available: `knowledge`, `strategy`, `narrative`, `debate`, and fallback `general`; up to three lenses refine the primary structure. Profile fit and Reader Advocate scores inform review but are not numeric pass thresholds.
- Atomic claims are verification units, never default prose units. Deep-read uses third-person, restrained observer prose, has no QR-Pilot blocks, and adds optional navigation/timeline only when it genuinely helps readers.

## Output policy

- Both generated PNGs are retained locally but ignored by Git because they are reproducible and large.
- Files waiting in `inbox/` are local-only; once archived under a case, their immutable originals are versionable.
- Source files, manifests, evidence, curated Markdown/JSON, HTML, prompts, and templates are versionable.
- Nothing is uploaded or published automatically.
- External background uses numbered citations; the source's own claims remain traceable to time or article anchors.
- A user-provided source URL is marked `verified`. Otherwise the agent searches for the original page; uncertain candidates go to `work/source-match.json`, while `source.url` remains empty and the catalog displays “来源待确认”.
