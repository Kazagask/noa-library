# V2.2 架构决策记录

## ADR-V22-01：以局部文档表替代全量 Vault inflate/flatten

- 状态：Accepted（SQLite/D1 兼容环境已实现）
- 决策：新增 `noa_v3_doc`、`noa_v3_head`、`noa_v3_revision`、`noa_v3_tx`、`noa_v3_rng`、`noa_v3_index`、`noa_v3_checkpoint`。
- 常规 `event_commit` 只读：revision 行、当前 state/working/manifest、本次涉及的业务对象、一致性规则关系、幂等/事件/RNG 索引；不再调用 `openV2/inflate/flatten`，不扫描历史事件。
- 原子提交：通过 `noa_v3_head.version` CAS guard 同批写入状态分片、记忆分片、回执/幂等、revision 与 RNG 消费标记。
- V2 `noa_shard` 保留为兼容冷存档；V3 可离线由 V2 完整文档一次性迁移。
- 理由：让事务成本只与本轮变更量和索引查询相关。

## ADR-V22-02：索引与有界查询

- 状态：Accepted
- 决策：revision 按 owner/campaign/worldline 建主键；tx 按 idempotencyKey 建主键并对 eventId/receiptId 建索引；RNG 按 receiptId 建主键与 consumed 标记；index 表存 lifecycle/todo/memory/constraint。
- `event_receipt` 直接命中 tx 索引；`session_recover` 只读 revision + 最近 N 条 tx；`bootstrap` 只读 state/working/persona + 近 N 条非 L3 引用。
- 理由：查询性能不依赖调用者自行缩小范围。

## ADR-V22-03：单一声明式 MCP 注册表

- 状态：Accepted（共享工具已接入）
- 决策：`packages/core/mcp-registry.ts` 是共享工具名称、Schema、权限和后端范围的唯一来源；Node MCP 与 Sites tools 都从注册表生成共享部分。
- 平台专属工具仍可在 Sites 独立定义，但不能改变共享工具语义。
- 理由：消除 Node/Sites 对共享工具的双份维护。

## ADR-V22-04：V3 增量 checkpoint

- 状态：Accepted
- 决策：首份 checkpoint 为基准，后续仅存变化的 state/working 一级分片；恢复时回放父链并校验状态与记忆哈希，再原子写回。
- 理由：避免 89 个完整快照持续堆积。

## ADR-V22-05：故障与恢复边界

- 状态：Accepted
- 决策：事务分阶段失败后以数据库事务为准；响应丢失时重传原幂等键返回原回执；RNG 回执只能被一个事件消费。
- 边界：不声称能修复 ChatGPT 客户端自身 SSE 中断。
