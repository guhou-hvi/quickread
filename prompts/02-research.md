# 02 — 专名、数字、ASR、人物与外部背景核验（Prompt 3.4.2）

## 目标

在合成前先处理会污染全文的高风险信息：人名、机构、数字、日期、论文、产品、历史事件和 ASR 疑点。

## 规则

1. 从 claim 的疑点、争议和理解缺口出发，不做无目的资料堆积。
2. 优先原始论文、官方文档、公司披露、大学或政府页面；记录标题、发布方、URL、访问日期和它支持的具体 claim。
3. 对每项核验标记 `confirmed`、`corrected`、`contextualised`、`conflicted` 或 `limited`。
4. 外部资料不能把嘉宾回忆改写成既定事实；冲突必须保留。
5. 正式更正写入研究记录和成稿的外部区，不静默篡改来源 claim。
6. 每个可能进入读者版的外部事实都要有一条明确的 `checks` 记录：列出对应 citationRefs、核验结论和该资料实际支持的具体命题。只有 citation 元数据而没有核验记录，不能作为 Fidelity 的通过依据。

输出 `work/research.json`。外部内容在 deep/brief 中一律使用 `provenance: external` 和 `citationRefs`。

## 自适应人物导览

- 访谈、辩论、圆桌或多嘉宾对话同时生成 `work/participant-guide.json`，新产物使用 participant-guide schema 1.1.0；既有 1.0.0 完整日期产物保持兼容。
- 单人访谈只介绍核心嘉宾；三名及以上实质发言者使用 `multi_speaker`。主持人仅在其身份影响理解时进入较小的 `supportingRoles`。
- 所有身份以节目或活动发生日期为准。每人只写当时身份、党派或机构、与本场相关的一项经历/职责和一句速记语境。
- `eventDate` 保留核验精度：1.1.0 接受有效的 `YYYY-MM` 或 `YYYY-MM-DD`；仅能确认月份时不得补写某一天。`dateBasis` 区分活动日期与资料发布日期，`verifiedAt` 始终使用实际核验日的完整日期。Markdown 和 HTML 原样保留日期精度。
- 不在人物导览中写政策主张、意识形态评价、胜负判断、人物比较或当前支持率。
- 每项事实必须引用官方或权威来源；无法可靠核验的字段省略，不猜测、不写占位符。人物导览属于 `external`，不进入字幕 evidence 或 reader-map。

## 自适应关键名词导览

- 对产品、项目、机构、技术、概念和重要事件建立候选；人物继续只进入 participant-guide。
- 选择依据是其是否贯穿主线或承担转折、普通读者是否可能陌生、缺少解释是否妨碍后文，以及能否得到可靠的简洁说明。出现次数只是线索，不是入选门槛。
- 有必要时生成 `work/context-guide.json`，使用 context-guide schema 1.0.0。每项分别记录一句 inlineDefinition、外部背景和它在本场访谈中的作用；不得把三类内容混成无来源的综合判断。深度稿通常选择 3–8 项，但数量只作编辑参考。
- `source_fact` 与 `speaker_view` 必须引用 evidence，`external` 必须引用 research citation。无法核验的背景不写；常识、一次性举例和已经自然解释清楚的术语不进入导览。
- Context Guide 不生成卷首术语总表。完整三段说明只在名词第一次实质参与正文论证后就地出现一次；标题、目录和纯预告式点名不计为首次出现。速览章节导语若已经解释名词的作用，则属于实质使用并应承载背景注。
- Context Guide 不进入 coverage、reader-map 或 claim recall；新增或更新它不触发 Claim Auditor，也不消耗 repair attempt。
