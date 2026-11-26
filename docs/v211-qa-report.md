# V2.1.1 QA 测试报告

## 执行结果

- 全量测试：**60/60 通过**（含真实 Sites Worker + 隔离 D1 链路）
- `verify`：93 项通过
- MCP 客户端：通过
- 正式 D1 / 正式存档：未访问、未写入

## 真实链路覆盖

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 真实 Sites Worker + 隔离 D1 工具链 | 通过 | `tests/sites-d1.test.ts` |
| 50 轮完整事件提交 | 通过 | 真实 `event_commit` 50 次，普通召回不含 L3 标记 |
| 事务幂等与重启后回执 | 通过 | 相同 idempotencyKey 返回原回执；重开 D1 后 head 存在 |
| 真并发 CAS 冲突 | 通过 | 两个并发提交只有一个成功 |
| 恶意扩大 maxBytes/limit | 通过 | 服务端预算只能缩小，分页可遍历全部结果 |
| 只读 Token 写工具 | 通过 | HTTP MCP 对全部写工具返回 403 |
| 未知工具默认拒绝 | 通过 | `requiredScope` 返回 null |
| memory.layers 世界线隔离与陈旧检测 | 通过 | 另一世界线索引不存在；revision 前进后 fresh=false |
| 生命周期状态机与原子摘要 | 通过 | 非法跃迁被拒，摘要与归档原子落盘 |
| 叙述交付状态 | 通过 | 仅显式 `narrativeDelivered` 为真时不进入 pending |
| checkpoint 真实增量恢复 | 通过 | 父链回放、逐片哈希、完整状态/记忆哈希一致 |
| 投影覆盖生产业务字段 | 通过 | research/economy/ledger/pendingHistory 全覆盖 |

## 性能报告

性能报告区分以下维度：

- 响应字节数：`read-budget` 与 `ops.metrics` 记录。
- D1 prepare/batch 次数、`noa_shard` 读取行数、扫描字节数：隔离 D1 适配器埋点。
- 实际接口耗时：Worker 调用前后计时。

`reports/v211-scale.json`（10,000 次真实 Worker + 隔离 D1 commit）实测：

- 10,000 commits：3,229,807ms（53.8 分钟），3.1 commits/s。
- 结束后 bootstrap 42.9ms、recall 14.5ms，均成功。
- 物理分片 20,062 个、10.14 MB；响应累计 6,349,269 bytes。
- D1 prepare 90,072 次、batch 10,002 次、读取行 100,610,233、扫描字节 98,489,547,656（约 98.5 GB）。

这证明生产写路径存在严重放大：每次提交重建/扫描整个世界线，不能支撑万轮/十万轮。它是本轮最重要的根因证据，必须进入后续 D1 增量写路径专项。读取端 bootstrap/recall 仍可控。

## 未通过项

见 `docs/v211-defects.md`。本轮**不申请生产验收**。
