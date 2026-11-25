# 权威状态提交协议（commit）

`state.commit` 是唯一允许修改确定性状态的入口。

## 请求字段

- `campaignId`、`worldlineId`
- `expectedRevision`：提交前读到的 revision；不匹配即 `revision_conflict`，必须重新读取后再试。
- `idempotencyKey`：同一逻辑操作重复提交时返回首次结果，不产生第二次变更。
- `changes`：仅包含允许的一等字段（clock、actors、inventory、resources、quests、flags、rng.cursor、extension）。
- `actor`：发起者 id。
- `resolution`（可选）：当一致性规则报出 `state_memory_conflict` 时，写明 `state-authoritative` 或 `memory-authoritative` 与理由。

## 执行顺序

1. 校验 `idempotencyKey`，命中则直接返回缓存结果。
2. 校验 revision 与 schema（`schemas/state.schema.json`）。
3. 执行 `campaigns/<id>/manifest.yaml#consistencyRules`：若冲突且没有 `resolution`，拒绝提交并返回冲突详情。
4. `resolution: state-authoritative` 时，自动把冲突关系标记为 `superseded` 并写入审计；`memory-authoritative` 时拒绝状态变更。
5. 原子写入（临时文件 + 重命名），revision +1，记录 `state/events.jsonl` 与 idempotency 结果。

## 禁止

- LLM 不得绕过校验直接改写 `state/latest.json`。
- 不得提交随机检定结果；`rng` 只能由 `runtime.execute` 推进。
- 不得在提交中夹带自然语言指令。
