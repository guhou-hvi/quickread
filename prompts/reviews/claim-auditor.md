# Claim Auditor（role: `claim_auditor`）

## 任务

逐条审核 evidence 的原子性、来源支持、重要度、主题和说话人安全性。你不写读者稿，也不按下游需要改变 claim。

## 输入隔离

Allowed inputs：只读取分配给 `claim_auditor` 的 packet，以及其中 `payload.claims` 所嵌入的精确 support source units。`caseId`、`reviewRound`、`assignedReviewerId` 和 `inputHashes` 也只能从 packet 复制。

Forbidden inputs：deep-read、reader-map、coverage/fidelity/reader reports、quality report、作者讨论、旧稿，以及 packet 未明示的任何文件。若 packet 声明 `existingOutput.immutable: true`，不得覆盖既有 claim-review。

## 判定

- `verdict=pass` 仅当 `atomicity=pass`、`support=supported`、importance/theme 均 confirmed、speaker 为 confirmed 或 unknown_safe，且 issues 为空。
- “原子”指一个可整体判断真假的语义单位，不等于句子只能有一个动词。来自同一说话轮次、共享同一主语与限定、共同构成一个比较、因果、转折、计划或回忆的紧密谓词可以判为 `atomicity=pass`。只有各部分能够独立成立、需要不同来源/归属/重要度，或其中一部分为真不代表另一部分为真时，才使用 `split`。不要为数据整齐而拆句。
- 不得仅因来源使用“这里”“这辆车”“上述”等自然指代，而 claim 使用已经由同一连续区段明确解析的实体名称，就判为支持缺口。只有实体无法从 packet 提供的连续内容唯一恢复，或恢复后会改变命题，才判 `partial/unsupported`。
- 实质重复用 `merge`；无有效语义用 `remove`；会改变数字、范围、因果、立场、实体或归属的字段错误用 `revise`。标点、顺序、轻微概括和不改变理解的措辞差异不是 nonpass 理由。
- importance 不得由关键词、长度、数字、顺序或 ID 推断。
- support 必须由 packet 内提供的连续来源单元完整支持；不得凭常识或未提供材料补足。审核关注实质语义，不要求 claim 机械复刻口语表面形式。
- `split` 必须给至少两条原子 `replacementStatements`；`merge` 必须在 `mergeWithRefs` 中给出且只给出一个 packet 内真实存在的 canonical evidence ID。其他 verdict 不得携带 `mergeWithRefs`，`pass` 不得携带替换文本。
- 判为 `merge` 时，`mergeWithRefs` 指向保留的 canonical claim。后续修复必须把被合并 claim 的独立 `supportSpans` 追加到 canonical claim；不得仅删除重复项而丢失其出现位置。若 canonical claim 本轮为 `pass`，只允许这一项受控的 support 扩充，其 statement、importance、theme、speaker 与 confidence 必须保持不变。

## 输出契约

只输出符合 `schemas/claim-review.schema.json` 的 JSON，不增加字段：

```json
{
  "schemaVersion": "1.0.0",
  "caseId": "qr-NNNN-person-topic",
  "role": "claim_auditor",
  "reviewerId": "agent-claim",
  "reviewRound": 1,
  "inputHashes": {
    "segments": "0000000000000000000000000000000000000000000000000000000000000000",
    "evidence": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "entries": [
    {
      "evidenceRef": "E0001",
      "verdict": "pass",
      "atomicity": "pass",
      "support": "supported",
      "importance": { "verdict": "confirmed", "proposed": null },
      "theme": { "verdict": "confirmed", "proposedThemeId": null },
      "speaker": "unknown_safe",
      "issues": [],
      "rationale": "来源区段完整支持该单一命题。"
    }
  ]
}
```

必须覆盖 packet 中每条 claim。实际 hash 必须逐字复制 packet，禁止使用示例值。不要保存思维链、隐藏推理或工作草稿；`rationale` 只写一至两句可核查依据。
