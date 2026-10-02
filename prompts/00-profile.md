# 00 — Profile 与密度判定

## 目标

在抽取 claim 前确定访谈的主结构与信息密度。读取 `case.json`、完整元数据，以及 `work/profile-selection.json` 记录的均匀全文抽样；不要只看标题或开头。

## Profile

只选择一个主 profile：`knowledge`、`strategy`、`narrative`、`debate` 或 `general`。按需选择 0–3 个 lens；lens 不能替代主 profile。

- 自动分类只有在最高分不低于 0.75，且领先第二名不低于 0.15 时生效。
- 低于阈值时暂停抽取，请求一次人工确认。
- `general` 只用于多种结构真正均衡或来源结构很弱的情况。
- 把选择、五类得分、抽样 ID、置信度和阈值写入 `work/profile-selection.json`；同步 `case.json.profile`。

执行语义判定时，先写 `work/profile-assessment.json`：`assessedBy` 为实际 Agent 标识，`sourceSha256` 为原文件哈希，`scores` 包含五类 0–1 评分，`rationale` 解释基于全文的结构判断。然后运行 `npm run profile -- cases/<slug> --assessment work/profile-assessment.json`，评分路径相对于案例目录，也可使用绝对路径。命令计算阈值并同步选择记录与 manifest。没有 assessment 时命令仅使用关键词启发式；案例编号不再默认提供历史分类。不得将低分强行改成 confirmed，除非用户确实确认。

## 信息密度评分

对以下五项各给 0–4 分，并为每项写一句可核验理由：

1. `atomicInformation`：单位文本中的独立事实、观点和推论数量。
2. `themeDependency`：理解后文是否依赖前文定义、因果链或多主题关系。
3. `evidenceRichness`：数字、例子、论据、反例和可核验细节。
4. `controversy`：分歧、风险、条件、不确定性和互相冲突的说法。
5. `uniqueness`：去重后仍然独立且不可替换的信息比例。

总分必须等于五项之和。读者版建议篇幅由工作流结合总分和有效源文长度计算，但只作诊断，不设最低字符门槛；正文保留率也只记录现象，不参与通过或失败。速览目标字符为 `3000 + 250 × 总分`。不得为迁就已有稿件、旧稿长度或希望得到的保留率反向调整分数。
