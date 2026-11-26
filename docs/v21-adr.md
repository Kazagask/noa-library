# V2.1 架构决策记录

## ADR-V21-01：四级记忆分层

- 状态：Accepted
- 决策：所有记忆对象标记 L0/L1/L2/L3。`memory/governance/layers.json` 只保存引用与体积，不复制正文。
- L0：工作记忆、权威状态摘要、活跃待办。
- L1：当前章节、活跃情景、近期关键因果。
- L2：长期语义记忆、历史章节摘要、关系与世界知识。
- L3：逐轮战斗、原始事件、检定记录、完整回执、历史快照。默认不进 bootstrap 和常规召回。
- 理由：存储与上下文解耦；分层是检索优先级，不改变事实可信度，不绕过认知权限。

## ADR-V21-02：服务端硬预算

- 状态：Accepted
- 决策：所有读取接口在 dispatch 层统一经过 `enforceBudget`。
  - bootstrap/persona：8 KiB
  - 常规业务读取：16 KiB
  - 审计：独立受限分页
  - archive.export：仅备份用途，禁止进入 GM 工作流
- 超限列表返回摘要、引用、截断标记与游标；超限权威状态返回 `state_budget_exceeded`，禁止静默截断。
- 理由：避免“先返回大对象再让 LLM 过滤”。

## ADR-V21-03：副本生命周期

- 状态：Accepted
- 决策：统一 `open → active → settled → summarized → archived`。摘要由 NOA 提交，服务端校验结构、来源引用与幂等；完整事件与原始回执保留在 L3。
- 理由：结束副本不再污染活跃工作记忆，同时保持审计链。

## ADR-V21-04：权威投影

- 状态：Accepted
- 决策：party/research/economy/pendingEvents 从权威 state/working 现场重建，带 `sourceRevision`、`sourceMemoryRevision`、`sourceHash`、`stale`。禁止独立同义权威字段反写。
- 理由：修复 bootstrap 队伍投影与权威状态不一致。

## ADR-V21-05：事务恢复

- 状态：Accepted
- 决策：新增 `session.recover`，只返回当前 revision、近期事务、场景、活跃待办、未完成叙述提示。重复请求靠 idempotencyKey/eventId 返回原结果，不重新掷骰、扣费、发奖或推进时间。
- 边界：不声称能修复 ChatGPT 客户端自身 SSE 中断。

## ADR-V21-06：Checkpoint 基准+增量

- 状态：Accepted，迁移需 dry-run
- 决策：保留旧 checkpoint 兼容；新策略使用基准快照 + 增量日志、内容寻址去重、增量链长度上限。恢复前校验完整哈希链。
- 理由：减少 89 个完整快照的重复占用，不以恢复可靠性换空间。

## ADR-V21-07：可观测性

- 状态：Accepted
- 决策：`ops.metrics` 暴露每次工具调用的耗时、序列化字节、最大响应、截断次数、幂等命中与失败率。后续 Sites 适配层需补充 D1 分片读取数。
- 理由：先量化读取放大，再做针对性治理。
