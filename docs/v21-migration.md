# V2.1 生产迁移与回滚方案

## 保护原则

- 不修改 SAVE-481 / wl-main 的权威 state、working、事件、回执或人格记忆。
- 不在公开仓库保存 D1 数据库导出、原始剧情正文或凭证。
- 未经 dry-run、差异报告与回滚验证，不执行破坏性清理。
- Sites 仍是唯一在线权威源；Vault 是只读冷备份。

## 迁移前基准

由 `packages/library/migration-baseline.ts` 校验：

- eventId：`EDEN-NARRATIVE-REFINE-CLOSURE-V1`
- stateRevision 1075 / memoryRevision 586 / RNG cursor 472
- 资金 819921G；萧炎七星斗尊，经验 24700.73955/40000
- 焚诀天阶高级，第八蜕变待选；原始失败骰 98/95 保留

人格独立记忆、跨世界关系、纪念性物品与历史授权记录必须单独哈希比对。

## 步骤

1. 对生产 D1 做完整逻辑导出 `archive_export`，记录 contentHash、分片数、checkpoint 清单。
2. 在隔离库恢复导出，运行 `verifyProductionBaseline`。
3. 构建 `memory.layers` 索引（apply 到隔离库），确认 L3 引用数与原文分离。
4. 对已结束副本批量提交 `memory.summarize` 提案；服务端校验引用与幂等。
5. 运行全部 V2.1 QA，记录响应体积、幂等命中、投影一致性。
6. 生成差异报告：迁移前后权威哈希、人格哈希、关键收益、事件/回执数量。
7. 人工确认后，才允许 Sites 侧启用新读取预算与恢复工具。

## 回滚

- 读取预算回滚：关闭 dispatch 层的 `enforceBudget` 包装，保留指标记录。
- 记忆分层回滚：`memory/governance/layers.json` 是派生索引，可删除或重建，不影响权威快照。
- 生命周期回滚：摘要与归档事件只追加，不删除原始事件；恢复时忽略 `memory.summarize` 事件即可回到原视图。
- 投影回滚：投影是现场重建，无独立写入；回滚不需要迁移数据。
- Checkpoint：不删除任何历史 checkpoint；新策略先在隔离库验证。

## 禁止事项

禁止补骰、重算收益、删除战斗原文、覆盖人格记忆、把冷备份设为可写主库。
