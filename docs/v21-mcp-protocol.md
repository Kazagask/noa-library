# V2.1 MCP 使用协议

## 协议兼容

- `2024-11-05` 与 `2026-07-28` 均支持。
- 内部点分名与生产 snake_case 通过 `packages/core/tool-protocol.ts` 统一映射，如 `state.commit` ↔ `state_commit`。
- 生产专属工具未实现时保持原名，不伪装为共享内核能力。

## 新增/变更工具

| 工具 | 用途 | 约束 |
| --- | --- | --- |
| `session_recover` | 新会话轻量恢复 | 返回 revision、近期事务、场景、活跃待办、待补叙述；不重放 L3 |
| `memory_layers` | 构建/读取记忆分层索引 | `apply=true` 才写索引；默认只返回 L0/L1/L2 引用 |
| `memory_summarize` | 提交结构化章节摘要 | 必须含因果、人物/资源变化、未解决、裁决、来源事件 ID；幂等 |
| `todo_status` | 待办状态迁移 | 支持 completed/cancelled/expired/superseded/sealed |
| `event_receipt` | 按 eventId/幂等键/回执 ID 查回执 | 不返回完整事件正文 |
| `ops_metrics` | 读取工具体积、耗时、截断、幂等命中 | 只读 |

## 通用读取参数

- `limit`：限制记录数。
- `cursor`：分页游标。
- `maxBytes`：仅约束工具结果中 `data` 对象的 UTF-8 JSON 字节数（`JSON.stringify(data)`），不含 JSON-RPC/MCP 信封（`jsonrpc`/`id`/`result.content`）、HTTP 传输开销或调用方本地打印。服务端硬上限为：bootstrap/persona 8 KiB、业务读取 16 KiB；`archive.export` 不受该读取预算约束，改由 `pageBytes` 控制。调用方只能缩小预算（`<=`），不能抬高；V3 在返回前按 `data` 实际字节裁剪，超限且无法裁剪时返回 `response_too_large`。旧适配层额外预留 1024 字节信封开销，实际可用预算为服务端硬上限减预留。
- `paths` / `section` / `fields`：大型业务对象字段投影，优先于放宽预算。

## 响应语义

- `budget.truncated=true`：响应为摘要、引用与游标，不是完整对象。
- `state_budget_exceeded`：权威状态超限，服务端拒绝返回截断版本；必须改用 `paths`。
- `duplicate=true` / `deduplicated=true`：命中幂等记录，不重复执行。
- `backup_only`：备份导出工具不得用于常规 GM 工作流。

## 客户端纪律

1. 写入只信 `status=applied` 的回执；超时先用 `event_receipt` 查询，再决定是否重传原幂等键。
2. 新会话先 `session_recover`，不要要求 `session_bootstrap` 返回全部历史。
3. L3 详情只在显式审计请求下按 ID 获取。
4. 不得从摘要、投影或历史记录反推并覆盖权威数值。
