# ADR-001 本地 Host 直接复用 Worker

## 决策

本地 Host 不重写 MCP 或 V3 业务；它把 `apps/sites/src/worker.js` 的 `fetch` 作为唯一业务入口，注入本地 D1-compatible SQLite binding。

## 理由

- 避免第二套业务逻辑。
- 本地 E2E 覆盖生产 JSON-RPC、工具 Schema、鉴权后业务路径。
- 只在驱动层替换 D1，符合最小适配原则。

## 约束

- LocalD1 只实现 `prepare/bind/all/first/run/batch`，不提供 D1 没有的交互式事务。
- `batch` 使用单事务模拟 D1 batch；业务不得依赖跨 batch 事务。
- 本地认证使用 Bearer token，生产认证仍由宿主负责；鉴权后的业务路径一致。
