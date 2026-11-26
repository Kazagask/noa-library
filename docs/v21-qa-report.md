# V2.1 QA 测试报告

执行：`node --test tests/*.test.ts`

- 总测试：48
- 通过：48
- 失败：0
- `verify`：93 项通过
- MCP 工具客户端：通过

## V2.1 专项 10 项

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 50 轮大型战斗结算、摘要、封存 | 通过 | `tests/v21.test.ts#1` |
| 重复 bootstrap 不重载战斗原文 | 通过 | 两次响应均 6,974 bytes，均不含 `ROUND-50-CRITICAL` |
| 事务成功后连接断开不重复结算 | 通过 | 重复 idempotencyKey 后 cursor/revision/resources 不变 |
| 并发提交与 revision 冲突 | 通过 | 第二个提交返回 `revision_conflict` |
| 常规读取接口预算 | 通过 | bootstrap/persona ≤8KiB，业务读取 ≤16KiB；权威状态超限拒绝 |
| 封存事件仍可审计 | 通过 | `event.receipt` 可按 `roll:audit-roll` 查到事务回执 |
| checkpoint 恢复与时序校验 | 通过 | `verifyCheckpoints` 无 invalid |
| 1万/10万轮合成数据趋势 | 通过 | 10,000→100,000 引用过滤 0.59ms→3.57ms，6.05x |
| 人格独立记忆不受归档影响 | 通过 | 身份/实体/关系/档案文件哈希前后一致 |
| SAVE-481 迁移基准不被改写 | 通过 | `verifyProductionBaseline` 全项通过 |

## 性能对比

- 50 轮战斗 bootstrap：6,974 bytes / 8,192 bytes 上限；重复调用结果稳定。
- 10,000 引用可见集：314,169 bytes；100,000 引用可见集：3,216,669 bytes。
- 该规模趋势说明引用过滤近似线性；L3 原文不进入响应。生产 D1 单次分片读取数仍待 Sites 适配验收。
