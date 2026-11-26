# NOA 会话恢复与记忆治理操作指南

## 新会话

1. 调用 `session_recover`，读取当前 revision、RNG cursor、场景、活跃待办、近期事务和待补叙述。
2. 若需要人格，调用 `persona_load`；人格记忆独立保存，不随 Campaign 归档。
3. 若需要场景上下文，调用 `session_bootstrap`，默认 8 KiB；不要请求全部历史。
4. 若恢复结果中有 `pendingNarratives`，只补叙述，不重新掷骰、扣费或发奖。

## 查证事务

- 用 `event_receipt` 按 eventId / idempotencyKey / receiptId 查询。
- 回执状态为 applied 即视为已提交；客户端 SSE 中断不改变事务事实。
- 未在回执中找到记录时，才使用原幂等键重传；不得生成新的骰值或新事件 ID。

## 长副本治理

1. 副本结束并结算后，提交 `memory_summarize`。
2. 摘要至少包含：关键因果、人物变化、资源变化、未解决事项、重要裁决、来源事件 ID。
3. 服务端校验通过后，副本进入 `summarized` / `archived`；完整原文保留在 L3。
4. 用 `todo_status` 把相关待办改为 `sealed` 或 `completed`；历史详情仍可按 ID 查询。
5. 需要审计时，先查 L2 摘要，再按需展开 L3 原始事件与回执。

## 读取策略

- 默认只读 L0/L1/L2；L3 不进入 bootstrap 与普通召回。
- 大对象用 `paths`、`section`、`fields`、`limit`、`cursor`。
- 看到 `budget.truncated=true` 时，沿 `nextCursor` 继续，或按 refs 精确查询。
- 看到 `state_budget_exceeded` 时，改用字段投影；不要要求服务端返回“截断后的权威状态”。

## 禁止操作

- 不允许从摘要或投影覆盖权威 state。
- 不允许把完整战斗历史塞回活跃待办。
- 不允许删除原始骰值、回执、人格记忆或历史授权记录。
- 不允许把 Vault 冷备份变成可写主库。
