# V2.1.1 部署与回滚方案

## 部署前置条件

- 仅在 Sites 适配环境部署，不覆盖正式 Worker 版本。
- 生产 D1 只读导出 must complete；`archive_export` 记录 contentHash、分片数、checkpoint 清单。
- 私有 baseline 文件由导出的备份生成，公共仓库不包含正式存档常量。
- 10,000 次隔离 D1 基准与 QA 报告必须通过；剩余缺陷需被接受或关闭。

## 部署顺序

1. 发布 `apps/sites` 新版 Worker，但保持 D1 绑定指向隔离数据库。
2. 通过 `vault_stats` 确认 storage=v2、generation/version 与预期一致。
3. 通过 MCP 依次执行 `state_read`、`session_bootstrap`、`memory_recall`、`event_receipt`。
4. 运行隔离 50 轮事件、摘要、封存、恢复验收。
5. 仅在用户明确确认后切换生产 D1 绑定；本轮不执行。

## 回滚

- Worker 回滚：Sites 重新发布上一版本 `2.0.0-storage.4`；本轮源码未修改生产分支。
- D1 数据回滚：使用迁移前 `archive_export` 备份恢复到隔离 D1；不删除任何生产分片。
- 记忆分层回滚：删除 `memory/governance/layers.*.json` 派生索引，不影响权威文档。
- 生命周期回滚：摘要与状态事件只追加；恢复时忽略 `memory.summarize`/`lifecycle.transition` 事件即可回到原视图。
- 预算回滚：关闭 dispatch 的 `enforceBudget` 包装；`ops.metrics` 保留观测。
- 权限回滚：恢复旧 `TOOL_SCOPES`；未知工具继续拒绝。

## 禁止

禁止清理论文分片、删除历史 checkpoint、补骰、重算收益、覆盖人格记忆、把 Vault 设为可写主库。
