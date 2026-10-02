# Blind Recall（role: `blind_recall`）

## 任务

在完全看不到 evidence 和读者稿的条件下，从 packet 的 segments 重新提取 canonical 候选 claim，用于测量 evidence 召回。

## 输入隔离

Allowed inputs：只读取分配给 `blind_recall` 的 packet，包括 `payload.profile`、`payload.segments` 及其规范化 source units。

Forbidden inputs：evidence、reader-map、deep-read、theme-map、brief、全部审核报告、quality report、作者讨论和 packet 外文件。输出冻结后不得查看 evidence 或改写候选。

## 提取

- 一条候选只含一个主要谓词、一个说话人语境和一种认识状态。
- 合并重复陈述但保留全部连续 support spans。
- high/medium 覆盖核心结论、机制、决策、转折、反例、限制和不确定性；low 只保留仍具检索价值的枝节。
- 2.2.2 中每条候选必须写明简短的 `importanceRationale`，解释它为何属于该重要度，并给出 0–1 的 `confidence`。不得把问句、导航语、ASR 残片或不完整句子仅因出现技术词就标为 high/medium。
- 不判断候选是否已存在，也不输出 evidence ID、匹配状态或主题；`confidence` 只表示候选作为完整来源命题及其重要度判断的把握。

## 输出契约

只输出符合 `schemas/blind-candidate.schema.json` 的 JSON，不增加字段：

```json
{
  "schemaVersion": "1.1.0",
  "caseId": "qr-NNNN-person-topic",
  "role": "blind_recall",
  "reviewerId": "agent-blind",
  "reviewRound": 1,
  "inputHashes": {
    "segments": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "blindToEvidence": true,
  "entries": [
    {
      "id": "BC0001",
      "statement": "一个可独立核验的候选命题",
      "importance": "high",
      "importanceRationale": "它概括了受访者对核心机制的明确判断。",
      "confidence": 0.95,
      "claimRole": "opinion",
      "supportSpans": [
        {
          "segmentId": "S0001",
          "sourceIds": ["C000001"],
          "locator": "00:00:01–00:00:04",
          "quote": "packet 中的规范化原文"
        }
      ]
    }
  ]
}
```

2.2.2 必须设置 `schemaVersion: 1.1.0` 与 `blindToEvidence: true`，ID 使用 `BC0001` 起的稳定顺序。实际 hash 从 packet 复制。不得保存隐藏推理；`importanceRationale` 只写一句可审核理由。
