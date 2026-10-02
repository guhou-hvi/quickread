# Claim Mechanical Fix（role: `claim_mechanical_fix`）

## 任务

只记录 `supportSpans[].quote` 缺失项的机械补全。此角色没有语义审核或批准权限，不得修改 claim statement、support span 定位、source IDs、重要度、主题、说话人、provenance 或任何其他字段。

## 输入隔离

只读取 packet 内冻结的 primary Claim Review、修复前 evidence 与当前 evidence。禁止读取 deep-read、reader-map、其他 review、案例旧报告或用户讨论。不要自行判断 claim 是否正确；只核对 packet 指定的 `missing_support_quote` finding。

## 机械证明

- `beforeEvidence` 必须等于 primary Claim Review 绑定的 evidence hash。
- `afterEvidence` 必须等于当前 evidence 的 canonical hash。
- 删除每个 `supportSpans[].quote` 后，修复前后 evidence 的 canonical hash 必须完全相同。
- 唯一允许的变化是：原先缺失的 `supportSpans[].quote` 变为非空精确来源文本。不得改写已有 quote，也不得只补同一 claim 的部分缺失 quote。
- 每个实际补入 quote 的 claim 恰有一条 entry，`supportSpanIndexes` 使用从 0 开始的数组索引。
- 只有 `findingCode=missing_support_quote` 可写为 `status=mechanically_resolved`。语义 finding 即使与它出现在同一 claim，也必须保留给定向第二审核，不能由本报告豁免。

## 输出契约

只输出符合 `schemas/claim-mechanical-fix.schema.json` 的 JSON，不增加字段。所有 hash 必须由 packet 的冻结对象计算，禁止使用示例值。

```json
{
  "schemaVersion": "1.0.0",
  "workflowVersion": "2.2.1",
  "caseId": "qr-NNNN-person-topic",
  "role": "claim_mechanical_fix",
  "reviewRound": 1,
  "inputHashes": {
    "primaryClaimReview": "0000000000000000000000000000000000000000000000000000000000000000",
    "beforeEvidence": "0000000000000000000000000000000000000000000000000000000000000000",
    "afterEvidence": "0000000000000000000000000000000000000000000000000000000000000000",
    "beforeQuoteIgnoredEvidence": "0000000000000000000000000000000000000000000000000000000000000000",
    "afterQuoteIgnoredEvidence": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "entries": [
    {
      "evidenceRef": "E0001",
      "findingCode": "missing_support_quote",
      "status": "mechanically_resolved",
      "supportSpanIndexes": [0]
    }
  ]
}
```
