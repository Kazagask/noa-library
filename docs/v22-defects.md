# V2.2 剩余缺陷与验收边界

1. **托管 D1 验收未执行**：本轮只在 node:sqlite 兼容环境运行。缺少用户提供的隔离托管 D1 实例与凭证，不能宣称真实 D1 事务限制、rows_read/rows_written 或托管性能已验收。
2. **并非所有生产工具都已接入 V3**：event_commit、event_receipt、runtime_execute、session_bootstrap、session_recover、save_checkpoint/restore 已走 V3；memory_recall、memory_traverse、state_read 等仍走 V2 局部读模式，后续需迁到 V3 索引。
3. **共享 Schema 仍保留平台专属定义**：共享工具已由统一注册表生成，Sites 专属工具仍在 `tools.js` 独立定义。
4. **正式迁移未执行**：未访问正式 D1；私有动态基准与差异报告机制已提供，但需在隔离托管库演练。
5. **100,000 次混合负载结果**以 `reports/v22-mixed-100000.json` 为准；若文件缺失，则视为未完成。
6. **rows_read/rows_written**：本地 SQLite 兼容层只能统计行数与 UTF-8 扫描字节，不等同于托管 D1 的计费指标。
7. **state 文档仍随业务字段增长**：混合负载中每次新增 flags 键使单份 state 文档持续变大，100k 末段 P95 为 1k 阶段的约 19.5 倍，未达到 ≤2 倍目标。下一步需把权威 state 也拆成按业务分片的小文档，仅加载本轮涉及分片。

本轮申请的是阶段验收，不申请生产上线。
