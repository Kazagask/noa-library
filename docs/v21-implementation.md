# V2.1 P0/P1 实现清单

## P0 已完成

- 四级记忆：`packages/library/memory-tiers.ts`，`memory.layers` 工具；L3 默认排除。
- 读取预算：`packages/server/read-budget.ts`；dispatch 统一包装 session.bootstrap / persona.load / state.read / memory.recall / memory.traverse / event.receipt / ops.metrics；archive.export 标记为 backup_only。
- 副本生命周期：`packages/library/lifecycle.ts`，`memory.summarize` 工具；结构、引用、幂等校验；open→active→settled→summarized→archived。
- 投影一致性：`packages/library/projections.ts`；bootstrap 从权威 state/working 重建 party/research/economy/pendingEvents，带 revision/hash/stale。
- 待办治理：`packages/library/todos.ts`；活跃与历史拆分，支持 completed/cancelled/expired/superseded/sealed。
- 事务恢复：`packages/library/recovery.ts`，`session.recover` 工具；只返回恢复所需最小集合。
- 权威基线：`packages/library/migration-baseline.ts`，内置 SAVE-481 迁移前后校验项。

## P1 已完成

- Checkpoint 评估：`packages/library/checkpoint-governance.ts`；内容寻址重复检测、基准+增量方案、恢复前哈希校验。
- 可观测性：`packages/server/observability.ts`，`ops.metrics` 工具。
- 分层检索：引用层过滤 `refsForTiers`，摘要优先，详情按需展开；避免摘要/原文/回执同时进入上下文。
- 契约与 QA：`tests/v21.test.ts` 覆盖 10 项验收场景；`reports/v21-performance.json` 与 `reports/v21-scale.json` 记录体积与趋势。

## 尚未完成（需 Sites 适配阶段）

- D1 真实分片读取数与查询数埋点：当前 `ops.metrics` 记录响应字节、耗时、截断与幂等命中，D1 侧指标需由生产 Worker 注入。
- 10,000 commit 与 100,000 commit 的真实托管环境恢复：本轮用合成引用数据验证趋势，未代替生产验收。
- 旧副本批量补归档：工具已支持提交结构化摘要，批量作业需在隔离迁移环境运行。
