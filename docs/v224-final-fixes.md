# V2.2.4 最终四项整改

基线：PR #8；仅存储/协议读取修复。

| 项 | 修复 |
| --- | --- |
| archive_export | 归档流改为每 16 个 chunk 批量落盘，减少 D1 往返；权威清单 + fail-closed 缺片/损坏；10x 本地预检 21,374,884 bytes、64KB 页正确。 |
| memory_recall | 检索 SQL 直接在权威文档 body 上过滤，不再只扫每层前 N 条；补 `excerpt/path/attributes/aliases/tags/subject/object` 文本；索引缺失时走文档回退。新增后部实体「萧炎/九星斗圣」测试。 |
| bootstrap / state_read | `maxBytes` 生效；超限优先移除 working/manifest/memory/待办，仍超限返回 `response_too_large`；`fields` 投影保留。 |
| 恢复一致性 | checkpoint 恢复后 state/working 按业务字段比较，排除 revision/updatedAt/memoryRevision；测试覆盖写入后回滚。 |

托管 D1 仍需复测；未以本地 SQLite 替代。
