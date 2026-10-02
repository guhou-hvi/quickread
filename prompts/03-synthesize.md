# 03 — 读者版合成（Prompt 3.4.2）

## 目标与输入边界

先完成可核验、连贯的读者版，再由下一阶段提炼 brief。原子 claim 是核验单位，不是写作单位；不得把 evidence.jsonl 的 statement 逐条复制、拼接或改成列表充当正文。

允许输入：case.json、已确认的 profile、通过 Claim Gate 的 segments.jsonl 与 evidence.jsonl、research.json、来源元数据和 profile 片段。

禁止输入：旧版 brief、HTML、PNG、旧稿篇幅、其他案例模板文案、审核员报告正文和作者讨论。不得从 quick-read 反向生成 deep-read。

## 输出顺序

1. 写 work/theme-map.json，保存 claim 的语义主题归属；完整主题图谱服务于证据后台，不要求每个 claim 进入读者正文。
2. 写选择性的 work/claim-bundles.json。bundle 只规划确实进入正文、语义兼容的 claim；不要求覆盖全部 claim，也不要求 bundle 与 reader block 一一对应。多个小 bundle 可以共同落在同一 reader block，但同一 claim 不得被重复分配。
3. 写 output/deep-read.json；新产物使用 deep-read schema 2.5.0 和 workflow 2.4.2。在 overview 后插入 `participants`，其人物数据源为 `work/participant-guide.json`。不得插入独立 `context_guide` block；关键名词只通过首次实质正文节点上的 `contextRefs` 就地呈现。
4. 写 work/reader-map.json，使用 schema 2.1.0。只登记正文实际表达的 explicit 或 synthesized claim；未进入正文的 claim 不写 entry，不写 evidence_only 或 unmapped 占位。
5. 运行 npm run build-deep -- cases/<slug>，确定性生成 output/deep-read.md 与 output/evidence-book.md。
6. deep-read 通过独立审核后，才允许执行 04-edit.md。

所有 JSON 与 Markdown 必须以 UTF-8 写入。U+FFFD 或连续 ?? 视为编码损坏，不得用占位文本替代无法确定的内容。

## 读者版结构

deep-read 2.4 强制三个起始章节，且顺序固定：

1. overview：交代访谈对象、问题背景和核心观察。
2. participants：自适应人物导览。单人访谈为一张简洁嘉宾卡；辩论、圆桌和多嘉宾访谈为主要发言者导览。人物事实只使用 external citation，不承担字幕观点覆盖。
3. themes：按 profile 组织主要论点、机制、例证与边界。

每个关键名词只在首次承担实质论证的 reader node 上设置一次 `contextRefs`；渲染器紧随该段生成“是什么／背景／本期作用”三行紧凑背景注。标题、目录、transition 段或无实质内容的提前点名不算首次关键出现；速览章节导语若已经解释名词的作用，则属于实质使用。同一节点若承担其他实质内容、却只顺手预告某个名词，将该名词列入 `contextPreviewRefs`，不要把整段降为 transition，也不要把背景卡硬移到概览。正文不要再次手写同一解释。

navigation 与 verification 均为可选章节。只有当材料本身需要路线提示、争议边界或外部核验时才加入。timeline 也是可选表达方式，不得为了满足数量而创建时间线。

读者版不得包含 editor_note，QR-Pilot 数量必须为 0。编辑判断、覆盖统计、claim 索引、审核话术和证据账本不得进入正文。

## 写作语气

- 使用第三人称、克制的观察性叙述。明确“谁说了什么、依据是什么、适用边界在哪里”，不替说话人强化结论。
- 平静叙述不等于抹平人物声音。嘉宾真实表达的焦虑、沮丧、勇气、质疑、比喻和行业批评，只要推动人物理解或主题主线，就应保留；不得由代理添加“震撼、疯狂、颠覆”等来源没有的煽情词。
- 争议性判断必须明确写成“某人认为／形容”，不能改成 QuickRead 的客观结论。深度稿可选择约 5–8 个现场感锚点，但这只是编辑目标，不是数量门禁，也不得为了凑数制造金句。
- 受控引语只使用 quoteMode=verbatim 或 spoken_cleanup。spoken_cleanup 只能删除口吃、重复、假启动和明显 ASR 噪声，并增加必要标点或省略号；不得新增、改序或改变语义，原有中英混说必须保留。sourceText 必须来自 evidence 的连续支持区段，署名标签由渲染器固定生成。
- 将 source fact、speaker view 与 external background 在机器结构中严格区分；读者版 Markdown 2.1 不显示“原文事实／说话人观点”等 provenance 标签。
- 清理口语重复和 ASR 断裂，但不补写原文没有的因果、动机、共识或确定性。
- 先形成连贯段落，再绑定实际表达的 evidence refs。不得先堆 refs 再拼接句子，也不得用同主题或共享关键词冒充语义覆盖。
- 列表、段落、timeline 和章节数量均由内容决定。它们的数量与占比只进入 diagnostics，不构成硬失败。

## 读者入口与背景知识

- 核心概念必须在首次承担论证功能时，用一句普通读者可以理解的话解释。不得让标题或概览中的关键词拖到后半篇才获得定义。
- 先说明一个方法解决什么问题、比较什么，再给缩写或项目名。专名服务于理解，不得把多个未解释的缩写连续堆成技术史清单。
- 背景知识只补到足以理解当前论点为止。人物导览只给事件时身份和与本场相关的职责/经历，不写百科式小传、政策摘要或人物比较；术语只解释会在后文继续使用的含义。
- Context Guide 只容纳会反复参与论证的陌生节点；常识、一次性产品列举和已经在正文中自然解释的词不入选。不得把名词速记扩成百科、产品列表或第二份人物导览。
- 相邻章节必须承担不同任务。生涯经历、研究方法、技术演进、产业约束与组织回应不得用近义标题反复讲述同一材料。
- 一个自然段只承担一个主要任务。先给判断，再给机制或例子；问题与约束通常先于解决方案和组织回应出现。
- 必要边界清楚说明一次。其余句子采用正面、直接的表述，不用重复的“不是／并非／仍需验证”或格言式段尾制造严谨感。
- 技术路线按概念转变组织；低价值专名、枝节版本和不影响主线的后续工作留在 evidence book，不得为了显得全面全部进入正文。

## 篇幅与密度

12,000–18,000 个中文字符只是写作目标，不是最低门槛、硬上限或自动扩写指令。更短但完整的稿件可以通过；更长稿件只有在出现明确重复、结构问题或已核实的语义错误时才需要修订。

density、bundle 大小、正文覆盖率、Evidence Book 覆盖率、列表占比和段落长度只用于 diagnostics 或 warnings。它们不得单独生成 hard error，也不得驱动把低价值 claim 倾倒进正文。

## 可追溯性

- source-derived 段落必须引用真实存在且语义吻合的 evidence refs；external 段落必须引用 hash-bound research citation。
- reader-map 的 quote 必须是对应 reader leaf 中的精确连续文本，且只校验已登记的实际条目。
- Evidence Book 保留完整原子 claim 与 support spans，作为后台检索层。其覆盖率是诊断指标，不等于正文覆盖，也不要求正文复述全部证据。
- 选择性 bundle 可以只覆盖正文核心材料；未被选择的 claim 留在 evidence archive。bundle 密度和未入正文比例只报告，不阻断交付。

只有具体的 unsupported、contradicted、misattributed、fabricated、stale hash、schema、reference 或 render-integrity 错误可以形成硬门。百分比、计数、长度、评分和结构密度不得替代具体语义错误。
