# V2.1.1 生产链路整改说明

## 真实源码统一

- `apps/sites/` 已从生产快照纳入统一工程分支，保留原生产目录与 38 个源文件。
- `apps/sites/src/upstream/*` 不再保留独立业务实现，全部转发到共享内核 `packages/edge/*`；`packages/edge` 从生产兼容实现提取 domain/operations/store/util 与 JSON Schema。
- 共享哈希注入在 `apps/sites/src/shared-hash.ts`：生产使用 `@noble`，隔离 Node 测试回退 `node:crypto`。`storage-v2.js`、`export.js`、`formal.js` 不再静态依赖厂商哈希包。
- 新增 `packages/edge/async-store.ts`：异步 `open/transact/stats/promote/compact`，局部 `readMode`，CAS 原子事务；生产 `createD1StorageAdapter(db)` 实现该接口，不要求 D1 兼容同步全量 SnapshotRepo。

## 审查问题整改

| 问题 | 整改 |
| --- | --- |
| read-budget 扩大预算 | `clampBudget` 只允许缩小；预留 MCP content/text 包裹开销；列表按字节逐条收缩并保留 `nextCursor` |
| auth | `TOOL_SCOPES` 显式注册全部新工具；`requiredScope` 未知工具返回 null；`memory.layers apply=true` 需 write，`memory.recall includeL3=true` 需 admin |
| recall L3 | 真实检索循环内调用 `isL3Row` 过滤；摘要引用不再作为唯一防线 |
| lifecycle | 显式状态机与合法迁移表；`submitChapterSummary` 原子写摘要、状态、事件与幂等记录 |
| todo | 状态迁移写入 `todoRevisions` 和 `memoryRevision`，通过 `repo.commit` 同批提交事件与幂等记录 |
| recovery | `pendingNarratives` 来自事件回执的 `narrativeRequired/narrativeDelivered` 显式标记，不再从“未被摘要引用”推断 |
| checkpoint | 实现真实增量分片、父链回放、逐片哈希与完整状态/记忆哈希校验 |
| memory.layers | 索引按 campaign/worldline 文件隔离；引用带 knownBy/epistemic/holder；revision 陈旧检测 |
| projection | 适配生产 `state.actors`、`extension.business`、`pendingTasks/legacyPendingRecords`；新增覆盖校验防止业务数据丢失 |
| baseline | 删除公共源码中所有正式存档硬编码常量；基准改为私有备份动态生成，缺失即 fail-closed |

## 兼容基线

生产 `event_commit` 的稳定 eventId、idempotencyKey、expectedRevision、回执、业务补丁规范化、相对时钟与 D1 CAS 分片保持不变；重构只替换共享内核来源和治理层，不回写生产分支或正式数据。
