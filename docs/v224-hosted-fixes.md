# V2.2.4 托管验收缺陷修复（P0-01..05）

基线：`39459fa805d2`；本轮只改存储可靠性，不新增业务功能。

| 编号 | 修复 |
| --- | --- |
| P0-01 | D1 PreparedStatement 元数据改用 `WeakMap` 记录 SQL/参数字节，不再读取 `.sql`；迁移批限不再抛 TypeError。 |
| P0-02 | `noa_v3_migration_progress` 记录 `documents` 批次游标；每批写入后持久化；续跑按 cursor 跳过已提交批次；迁移仍保持幂等。 |
| P0-03 | 归档分页校验 chunk 连续数量、逐片 digest、页字节长度；缺失/损坏返回 `archive_chunk_missing`/`archive_chunk_corrupt`，不再 `ok:true`。 |
| P0-04 | 归档缓存键加入 head version，任何权威写入（含 memory_record）都会生成新 archiveId/哈希。 |
| P0-05 | `commitEventV3` 持久化 `noa_v3_event`，事件序号单调；回执与事件历史同步增长。 |

## 验证

- 91/91 自动化测试。
- 新增：事件/回执同步、归档缓存失效、chunk 缺失/损坏拒绝、64KB 分页足额。
- R1365 674/674 深度校验。
- 源码清单 113 文件，根 SHA-256 `2f2f968a63baf5589d09429e93989cd3488cb06c9152b8bf1984c819748e3fa5`。

托管 1x/5x/10x、跨请求续跑与故障注入仍需 Sites 复测；当前仍 NO-GO。
