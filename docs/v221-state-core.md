# V2.2.1 通用状态内核

## 设计

通用状态内核不绑定任何世界业务类型，只提供：

- **Entity**：`noa_v3_entity`，稳定 entityId、entityType、meta、revision。
- **Component**：`noa_v3_component`，按 `(owner,campaign,worldline,entityId,componentType,key)` 独立寻址、版本化、哈希化。
- **Collection**：`noa_v3_collection_item`，大型集合按 itemKey 独立增长，不作为单一 JSON 文档膨胀。
- **Schema**：`noa_v3_schema`，动态注册组件类型与版本。
- **Index**：`noa_v3_component_index`，支持 component type、entity、时间/状态/业务索引键；记忆层级、认知范围与关系边已实际写入索引。
- **Checkpoint**：`noa_v3_component_checkpoint`，记录组件哈希快照。

所有表均带 owner/campaign/worldline 隔离字段。

## 局部读写

- `stateFromComponents()` 按组件与集合重建权威 state；集合形态由 `field@shape` 组件记录，避免数组/对象混淆。
- `writeStateDiffToComponents()` 对字段和集合条目做差异写入，只提交本轮变化。
- `applyEffects()` 接受 upsert/delete/index Effect 列表，在 `noa_v3_head.version` CAS guard 下批量原子提交。
- `commitEventV3()` 兼容现有 event_commit 调用：输入仍是 eventId/expectedRevision/statePatch/记忆/pendingEvents/runtimeReceipt，但内部改为组件局部读写。

## 读取闭环

`state_read`、`memory_recall`、`memory_traverse`、`session_bootstrap`、`session_recover`、`event_receipt` 均从 V3 权威数据读取；V3 写入后立即对所有 V3 读取接口可见。V2 分片作为兼容冷数据保留，但不再作为这些接口的最新状态来源。

## 运行时契约

`packages/akasha/contracts.ts` 定义 StateReader、Effect、TransactionPlan、SchemaRegistry、ExecutionContext 与 RuleFunction 签名。本轮不实现规则 VM、AST 解释器、eval、Hook 调度或沙箱；规则函数不得直接操作数据库。
