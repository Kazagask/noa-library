# PROJECT AKASHA 运行时契约（设计，未实现）

本轮只定义 `packages/akasha/contracts.ts` 中的接口，不实现规则语言、AST 解释器、Hook 调度、行动编排、eval 或 JavaScript 沙箱。

- `StateReader`：按声明范围读取组件与集合，不允许任意查询。
- `Effect`：结构化状态变更指令，只有 upsert/delete/index 三类。
- `TransactionPlan`：scope + expectedVersion + idempotencyKey + effects，交给存储内核做 CAS 原子提交。
- `SchemaRegistry`：动态注册/解析组件 Schema 与版本。
- `ExecutionContext`：未来规则函数的唯一上下文；规则函数只能通过 `ctx.emit` 声明 Effect，不能直接访问数据库。

通用组件表已经提供 `registerSchema`、`readComponent(s)`、`readCollection`、`applyEffects` 的实际存储能力，可视为上述契约的存储侧基础；规则 VM 与受限执行环境留待 AKASHA 专项。
