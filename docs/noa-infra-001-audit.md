# NOA-INFRA-001 宿主依赖审计

## 现状

- 生产 MCP 入口：`apps/sites/src/worker.js`，直接处理 JSON-RPC 与工具分发。
- 生产业务存储：`apps/sites/src/storage-v2.js` / `storage-v3.js`，直接使用 D1 `prepare/bind/all/first/run/batch`。
- 生产工具事实来源：`apps/sites/src/tools.js` + `packages/core/mcp-registry.ts`。
- 现有本地 server：`packages/server/*`，是旧 V2 SnapshotRepo 路径，不覆盖当前 V3 Core。
- 现有测试：`tests/*.test.ts` 通过 `apps/sites/test/d1-sqlite.mjs` 调用真实 Worker 路径，但缺少独立 MCP 客户端与可启动 Host。

## 依赖图

```text
MCP Client
  -> local HTTP / stdio (packages/local)
  -> apps/sites/src/worker.js (JSON-RPC + auth owner)
  -> storage-v3.js / state-core.js / events.js
  -> D1 SQL contract (prepare/bind/batch)
  -> LocalD1 (node:sqlite) | Cloudflare D1
```

## 问题清单

1. 无本地可启动的 V3 Host；旧 `packages/server` 不能直接驱动 V3。
2. MCP stdio 未与生产 Worker 共用入口，无法独立验证 tools/list、Schema、错误响应。
3. D1 SQLite 适配器只存在于测试文件，未被本地运行复用。
4. 缺少一键生命周期冒烟与质量门禁。
5. 缺少宿主无关的发布/恢复手册与 Docker 路径。
6. 现有测试覆盖 Worker 路径，但不覆盖实际 stdio/HTTP MCP 进程生命周期。

## 目标架构（最小改动）

- 保留 `worker.js` 作为唯一 JSON-RPC 业务入口。
- 新增 `packages/local/d1-sqlite.ts`：只实现 D1 驱动契约，不含业务。
- 新增 `packages/local/host.ts`：用 LocalD1 构造 Worker env，直接调用 `worker.fetch`。
- stdio/HTTP 仅做传输与本地鉴权，转发到同一 `host.rpc`。
- `/packages/server` 保持现状，不复制 V3 业务。

## 实施计划

1. LocalD1 + schema bootstrap（完成）。
2. local host + stdio/http（完成）。
3. CLI 与生命周期 smoke（完成）。
4. 本地测试与 gate（进行中）。
5. Docker/手册/审计交付（进行中）。
