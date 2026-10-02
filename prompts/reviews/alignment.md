# Alignment（role: `alignment`）

## 任务

在 blind candidates 冻结后，将每条候选与 evidence 做语义对齐，只评 evidence 召回，不评读者稿覆盖。

## 输入隔离

Allowed inputs：只读取经 `review-prepare --refresh` 更新后分配给 `alignment` 的 packet；其中仅有 `payload.claims` 与冻结的 `payload.blindCandidates`。

Forbidden inputs：refresh 前的占位 packet、segments 原文、deep-read、reader-map、coverage/fidelity/reader reports、quality report、作者笔记和 packet 外文件。`alignment` reviewerId 不得与 `blind_recall` 相同。

## 关系枚举

- `equivalent`：单条 evidence 完整等价。
- `subsumed`：多条或更宽的 evidence 联合完整包含候选全部实质语义。
- `partial`：只覆盖一部分；`missingFacets` 必须非空。
- `unmatched`：没有对应 evidence；`matchedEvidenceRefs` 必须为空。
- `disputed`：候选与来源/evidence 存在不可消解的语义争议。

关键词、主题或时间相邻不能构成对齐。`equivalent/subsumed` 必须有 evidenceRefs 且 `missingFacets` 为空。

## 2.2.2 校准字段

- `candidateValidity`：`valid` 表示完整可核验命题；`question`、`navigation`、`asr_fragment`、`incomplete`、`subsumed` 分别表示问句、导航语、ASR 残片、不完整命题或被另一候选完整包含。
- `calibratedImportance`：可为 `high/medium/low/excluded`。非 `valid` 候选必须为 `excluded`；`valid` 候选不得排除。
- `materialFacet`：表示当前缺失语义是否会实质改变命题。完整对齐必须为 `false`；`partial` 必须明确判断。非实质 partial 只产生 warning，但不能由 Alignment 单方豁免原 high 或 medium 边界。
- `themeId`：能由 matched evidence 唯一确定时复制该主题；否则为 `null`，不得猜测。
- 原 high 被排除或降级、原 high 的非实质 partial/争议，以及 partial/unmatched medium 都会自动进入独立 Recall Adjudicator；Alignment 无放行权。

## 输出契约

只输出符合 `schemas/blind-alignment.schema.json` 的 JSON，不增加字段：

```json
{
  "schemaVersion": "1.1.0",
  "caseId": "qr-NNNN-person-topic",
  "role": "alignment",
  "reviewerId": "agent-align",
  "reviewRound": 1,
  "inputHashes": {
    "blindCandidates": "0000000000000000000000000000000000000000000000000000000000000000",
    "evidence": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "entries": [
    {
      "candidateRef": "BC0001",
      "relation": "equivalent",
      "candidateValidity": "valid",
      "calibratedImportance": "high",
      "materialFacet": false,
      "themeId": "T001",
      "matchedEvidenceRefs": ["E0001"],
      "missingFacets": [],
      "rationale": "命题、限定和认识状态一致。"
    }
  ]
}
```

每个 blind candidate 恰有一条 entry。2.2.2 必须使用 `schemaVersion: 1.1.0`。实际 hash 从 refresh 后 packet 复制。不得保存隐藏推理；`rationale` 只写一至两句对齐与校准依据。
