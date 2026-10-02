# 05 — 增量隔离审计与定向修复（Prompt 3.4.2 / Review Policy 2.4.2）

审核目标是发现具体问题，而不是证明某个百分比。所有角色只读取 `review-prepare` 或 `review-consensus` 分配的 packet；不得共享上下文、作者讨论或中间结果。审核输出只含契约字段和简短依据，不保存隐藏推理。

## 角色与隔离

固定 role ID：`claim_auditor`、`blind_recall`、`alignment`、`coverage_a`、`coverage_b`、`fidelity`、`reader_advocate`、`adjudicator`、`repair_editor`。

- 每个角色使用唯一 reviewerId 和独立上下文。
- `coverage_a` 与 `coverage_b` 不得由同一审核员承担；`blind_recall` 与 `alignment` 必须分离。
- `adjudicator` 不兼任 coverage 或 repair；`repair_editor` 不兼任内容审核；`reader_advocate` 保持 evidence-blind。

## Evidence change gate

先运行 `npm run evidence-check -- cases/<slug>`，再运行 `npm run evidence-diff -- cases/<slug>`。没有已接受基线，或来源/规范化来源/segment ownership/speaker mapping 变化时，执行一次完整 Claim Auditor。语义哈希不变的 `mechanical` 变化只跑确定性检查；可追踪的 `semantic_delta` 只用 `review-prepare --claims-delta` 审核变化 claim、相邻来源和受影响内容。只有增量审核发现具体 hard error 或语义分歧时才启用 Claim Gate。Blind Recall、Coverage A/B 和全文 Claim Auditor 不因局部变化自动重跑。

审核结果绑定局部 claim、support span、citation 和 reader block 哈希。只有依赖发生变化的报告失效；历史日志原样保留。人物导览、关键名词背景、主动读者改写与机械变化不增加 `repairAttempt`。

## Source Scout 与正文抽查

1. Blind Recall 只读 segments，寻找可能改变整篇理解的关键观点、转折、机制、反例或限制。Alignment 在候选冻结后判断它是有效命题、提问、导航、ASR 残片、重复表达，还是已经被现有 claim 包含。
2. Recall 比例只进入 diagnostics。候选只有同时满足以下条件，才可能成为硬错误：
   - 来源中存在完整、可恢复的命题；
   - 遗漏会改变核心结论、机制、决策逻辑、关键边界或重要反例；
   - Source Scout 与另一名独立审核角色均确认其为关键遗漏。
3. Coverage A/B 只审核 packet 中列出的、正文实际使用的 claim。它们抽查正文是否表达了核心语义；coverage 比例、普通 partial/missing、低置信和 reviewer 分歧都只进入 diagnostics。
4. `contradicted` 表示正文与来源命题相反，属于具体硬错误。Timeline、system、external、editorial 与 QR-Pilot 不得代替来源正文承担证据表达。

## Fidelity 与 Reader Advocate

- Fidelity 逐个检查实际发布的 reader leaf。只有明确的 unsupported、overstated、misattributed、fabricated、wrong provenance、无效引用或未标注外部补充才是内容硬错误。计数与百分比不是 Fidelity 门禁，不能被仲裁用来制造硬错误。
- Reader Advocate 只看去引用读者稿，指出审核报告腔、重复、术语负担、章节割裂和节奏问题。六项分数全部进入 diagnostics；只有能够定位到具体 block、并明确破坏普通读者理解的问题才列为 blocker。
- 字数、章节数、段落长度、列表比例、时间线数量、QR-Pilot 数量、bundle 密度、Evidence Book 覆盖率和映射率都不得单独阻止交付或触发扩写。

## Adjudication 与 Repair

- Adjudicator 只处理匿名分歧包。普通 missing 或分歧不能单独升格为核心遗漏；必须满足上面的“双角色确认＋改变核心理解”条件。
- Repair Editor 只修复已定位的限定词、数字、因果强度、反例、来源、错引、错误归属、矛盾或已确认的核心遗漏。
- 不得为了改善 coverage、recall、篇幅、评分、列表比例、bundle 数量或任何其他数字而添加正文。
- 阅读性 warning 只有在用户明确选择后才进入修订；默认不触发自动补写。
- 修复后记录 `repair-log.json`。只使受影响 claim、reader block、brief 或审核依赖失效；不得因局部变化宣布整套历史审核无效。默认最多两次语义硬错误修复；案例级额外授权只允许继续处理同一个具体硬错误。

## 人物导览审核

- 只核验外部引用、事件日期、事件时身份及深度稿/速览的一致性。
- 人物导览变化不进入 Claim Auditor、Blind Recall 或 Coverage；它不参与字幕覆盖率。
- 只有无效来源、错误身份、把政策立场写入背景卡、或深度稿与速览身份不一致才是 hard error。排版与措辞问题交 Reader Advocate 和渲染检查。

## 关键名词背景审核

- 用三个隔离角色检查 `work/context-guide.json`：`external_citation` 核验外部背景，`fidelity` 核验定义与本期作用的来源/归属，`reader_advocate` 检查解释时机、重复说明、术语墙及外部背景与嘉宾观点混写。
- Context Guide 变化不进入 Claim Auditor、Blind Recall、Source Scout 或 Coverage；它不参与字幕覆盖率、reader-map 或 repairAttempt。
- 只有无效引用、编造背景、实质改写嘉宾观点、错误 provenance、把人物塞进名词导览或产物定义漂移属于 hard error。数量、篇幅和是否达到某个术语数只能是 diagnostics。

## 交付判断

仅以下情况自动阻止交付：

- 正文存在编造、错引、夸大、错误因果、错误归属或来源类别混淆；
- 外部背景缺少有效引用，或引用、哈希、schema、案例 ID、版本绑定已损坏；
- 两名独立角色确认存在会改变核心理解的关键遗漏；
- HTML/PNG 存在越界、乱码、文件损坏或产物错配。

其余 coverage、recall、Evidence Book 收录率、重复率、长度、结构数量、置信度和 Reader 分数均记录为 warnings 或 diagnostics。深度稿只要没有具体硬错误，就可以进入 `04-edit.md` 生成速览；最终仍由用户进行一次集中校审，Agent 不得代填 `work/human-review.json`。
