# Sites 生产分支差异审计

## 范围与基线

- main：`d259a6b8b19ef3d3ce3694abf5ed51f611e478bb`
- Sites 生产分支：`sites/upstream-2.0.0-storage.4` → `29581962e0af517516cb324cd1fb3c1effa4701f`
- 生产导出记录的上游源码提交：`3277ba20949aa4e30d695334b9f4f5d9ef3fbb29`
- 导出时 GitHub merge base：`d259a6b8b19ef3d3ce3694abf5ed51f611e478bb`
- 生产 Worker release：`2.0.0-storage.4`
- MCP 协议：`2026-07-28`；main 现支持 `2024-11-05` 与 `2026-07-28`

审计方式：分别导出两分支 tarball，逐文件 `diff -rq`。结论：**生产分支相对 main 唯一的结构差异是新增 `apps/sites/`；main 已有文件没有任何内容改动。** 因此归一化策略是“保留 main 为共享内核，吸收 apps/sites 的生产行为到适配层”，而不是回写或覆盖生产目录。

## 生产新增文件清单（完整）

`apps/sites/` 共 39 个文件：

- 元数据：`.gitignore`、`.openai/hosting.json`、`README.md`、`UPSTREAM`、`UPSTREAM.md`、`package.json`、`package-lock.json`
- 迁移：`drizzle/0000_vault.sql`、`drizzle/0001_shards.sql`、`drizzle/meta/_journal.json`
- 脚本：`scripts/build.mjs`、`scripts/smoke.mjs`、`scripts/v2-qa.mjs`
- Worker 与路由：`src/worker.js`、`src/page.js`、`src/admin.js`
- 工具协议与事务：`src/tools.js`、`src/events.js`、`src/authority.js`
- 存储：`src/storage-v2.js`、`src/vault.js`、`src/export.js`
- 导入/投影/修复：`src/formal.js`、`src/projections-v2.js`、`src/repair.js`
- QA：`src/qa-v2.js`、`src/diagnostics.js`、`src/verify-formal.js`
- Schema：`src/schemas/{state,entity,relation,episode,manifest,runtime-request}.schema.json`
- 种子与上游副本：`src/seed.json`、`src/upstream/{domain,operations,store,util}.ts`

## 生产兼容基线

以下行为必须视为生产兼容契约，不得在共享内核重构中破坏：

1. 显式 `campaignId` / `worldlineId`；`event_commit` 要求稳定 `eventId`、`idempotencyKey`、`expectedRevision`，并返回可复查回执。
2. 正式写入经 `event_commit` 原子提交；超时重传原幂等键，版本冲突必须重新读取，禁止自动覆盖。
3. `statePatch` 递归合并对象、替换数组；业务分片含科研、产业、功法、技能、人物关系与相对时钟 `clock.advanceMinutes` / `elapsedMinutes`。
4. 随机流由 `runtime_init` / `runtime_execute` 管理；只接受同世界线服务端回执，禁止补骰或猜测历史骰值。
5. `state_read(section=...)` 支持业务投影、账本与 pendingHistory 分页。
6. GM 视角可召回世界线内全局记忆；其他视角继续按 `knownBy`、时间、认知过滤。
7. D1 V2 分片：`noa_head` / `noa_shard` / `noa_cas_guard`，V1 fence 阻止双写；owner 隔离依赖 Sites 身份网关。
8. 导入导出使用 noa-bundle v1；全库备份含审计和回执，世界线恢复保留单调 revision。

## 与 main 的能力差异

- **工具命名**：main 内部使用点分名并在 MCP 暴露 snake_case；生产直接使用 snake_case，且有生产专属工具 `event_commit`/`event_receipt`/`campaign_import`/`vault_*`/`qa_create`/`archive_export`/`runtime_init`。
- **平台依赖**：main 的 `core/util.ts` 直接依赖 Node fs/crypto；生产副本改为 `@noble/hashes` 与 Web Crypto， schemas 静态导入。
- **GM 可见性**：生产 `ViewContext` 增加 `gm`，允许 GM 绕过 `knownBy` 但仍受世界线/时间过滤；main 用 `viewer='gm'` 的显式视角模拟。
- **事务语义**：生产 `commitEvent` 的回执、业务补丁规范化和 D1 CAS 更新比 main 的通用 `state.commit` 更贴近正式玩法。
- **存储**：main 有 FsStore / SqliteStore / 备份 / 资产层；生产有 D1 分片与分页导出，但写路径仍部分加载历史数据。
- **仍有价值的生产能力**：`gmProtocol` 归档规则、回执查询、业务投影/补丁规范化、相对时钟、科研与产业账本、D1 V2 CAS 与分片契约、QA 隔离 campaign。
- **main 的增量价值**：统一事件日志与回放、实时权威守卫、BFS 邻接查询、资产权限与 GC、双馆备份协议。

## 归一化方案

1. 共享业务内核保留 `packages/library/domain.ts`、`operations.ts`、`store.ts`，新增平台无关 `packages/core/shared.ts` 作为哈希/ID/结果原语；Node 与 Worker 各自注入哈希实现。
2. 统一 MCP 协议模块 `packages/core/tool-protocol.ts`：点分名与 snake_case 双向规范；生产专属工具保留原名，不伪装为已实现。
3. 存储适配层 `packages/server/storage-adapter.ts`：统一 `SnapshotRepo` 契约；FS / SQLite / Memory 三后端跑同一业务契约；D1 侧固定分片 SQL 与编解码契约，实际事务仍由生产 Worker 执行。
4. 生产行为吸收顺序：先回执与规范化，再业务投影与相对时钟，最后 D1 分页/QA；每步由跨平台契约测试保护。
5. 不修改 `apps/sites/`，不导入正式存档，不改动生产分支。

## 已知导出限制

- Sites 只读身份头与 D1 绑定由平台提供，源码快照不含凭证或生产数据库。
- 生产写路径仍加载历史数据；10,000 commit 与托管重启测试未完成。
- `vault_compact` 只报告候选对象，不自动 GC 或重建索引。
