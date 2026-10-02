# Coverage B（role: `coverage_b`）

## 任务

独立于 Coverage A，从 reader leaf 实际表达的命题反向核对 packet 中列出的 claim。输出契约与 Coverage A 相同，但采用 reader-centred 方法。

Coverage 是诊断工具，不是篇幅或完整率门禁：`partial`、`missing`、分歧、低置信度和覆盖比例本身都不能授权补写正文。

只有一个遗漏同时满足以下条件时，才可在 `rationale` 中称为“核心遗漏候选”：来源是完整、可恢复的命题；遗漏会改变文章的核心结论、机制、决策逻辑、关键边界或重要反例。它仍须由另一名独立角色确认，才能成为硬错误。

## 输入隔离

Allowed inputs：只读取分配给 `coverage_b` 的 packet：`payload.claims` 和已移除 evidenceRefs 的 `payload.readerLeaves`。

`readerBlockRefs` 与 `verifiedQuotes[].readerBlockRef` 必须逐字复制匹配的 `payload.readerLeaves[].id`。packet 不提供父级 block ID；不得根据 module、标题或命名规律自行拼接 ID。

Forbidden inputs：reader-map、Coverage A、Fidelity、Reader Advocate、quality report、source transcript、作者讨论和 packet 外文件。Coverage A 与 B 必须使用不同 reviewerId，且不得交换中间结果。

## 判定契约

- 先从每个 reader leaf 独立还原它真正表达的命题，再寻找 claim 对应关系；不得从 claim wording 反向脑补正文。
- verdict 只能是 `covered / partial / missing / contradicted / unreviewable`。
- `issueType` 只能是 `none / importance_misclassified / theme_misclassified / provenance_conflict / semantic_conflict / insufficient_context`。
- `covered` 必须完整保留实质语义，提供 1–2 个 block、逐 block 精确 `verifiedQuote`、非空 materialFacets、空 missingFacets。
- `partial` 只用于缺少实质语义；省略不改变命题的修饰语、枝节例子或重复说法不判 partial。
- `partial/missing` 必须列出 missingFacets；`missing/unreviewable` 不得登记 block 或 quote。`missing` 是诊断，不等于必须补写。
- `contradicted` 只用于正文与 claim 实质冲突；不能因措辞、详略或叙述顺序不同而使用。
- 单个 block 映射多个 claim 时仍逐条判断；不能因段落主题宽泛而批量判 covered。confidence 表示判断把握，低于 0.8 只触发复核，不自动失败。
- 不根据 high/medium 标签、覆盖比例、Evidence Book 收录率、bundle 密度、正文长度或目标字数推导修复需求。

## 输出契约

只输出符合 `schemas/coverage-review.schema.json` 的 JSON，不增加字段：

```json
{
  "schemaVersion": "1.0.0",
  "caseId": "qr-NNNN-person-topic",
  "role": "coverage_b",
  "reviewerId": "agent-coverage-b",
  "reviewRound": 1,
  "inputHashes": {
    "evidence": "0000000000000000000000000000000000000000000000000000000000000000",
    "deepRead": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "blindToReaderMap": true,
  "blindToPeerReview": true,
  "entries": [
    {
      "evidenceRef": "E0001",
      "verdict": "partial",
      "confidence": 0.85,
      "issueType": "semantic_conflict",
      "readerBlockRefs": ["theme-1-thesis"],
      "verifiedQuotes": [
        { "readerBlockRef": "theme-1-thesis", "readerTextQuote": "正文中只覆盖部分语义的文本" }
      ],
      "materialFacets": ["已表达的主张"],
      "missingFacets": ["缺失的成立条件"],
      "rationale": "正文表达主张，但遗漏成立条件。"
    }
  ]
}
```

packet 中每条 claim 恰有一条 entry。实际 hash 从 packet 复制。不得保存隐藏推理；`rationale` 只写一至两句可核查说明。
