# V2.2.3 权威读写路径矩阵

V3 激活后：adapted 写/读 V3；reject 明确返回 `v3_governance_not_adapted`。

| 工具 | 读写 | 实际后端 | V3 行为 | 权限 | 幂等/Revision |
| --- | --- | --- | --- | --- | --- |
| vault_stats | read | v3-stats | adapted | read | none/none |
| vault_compact | write | v2 | reject | admin | none/v2-version |
| vault_migrate | write | v2 | reject | admin | none/v2-version |
| qa_create | write | v2 | reject | admin | none/v2-version |
| archive_export | read | v3-archive | adapted | read | none/bound |
| archive_import | write | v3-archive | adapted | admin | required/new |
| runtime_init | write | v3-adapter | adapted | write | required/v2-version |
| campaign_list | read | v3 | adapted | read | none/none |
| campaign_import | write | v2 | reject | admin | none/v2-version |
| event_commit | write | v3-event | adapted | write | required/expectedRevision |
| event_receipt | read | v3-index | adapted | read | none/none |
| session_bootstrap | read | v3 | adapted | read | none/none |
| persona_load | read | v3-persona | adapted | read | none/none |
| state_read | read | v3-components | adapted | read | none/none |
| state_commit | write | v3-event | adapted | write | required/expectedRevision |
| memory_recall | read | v3-index | adapted | read | none/none |
| memory_traverse | read | v3-index | adapted | read | none/none |
| memory_record | write | v3-adapter | adapted | write | required/memoryRevision |
| memory_revise | write | v3-adapter | adapted | write | required/memoryRevision |
| runtime_execute | write | v3-rng | adapted | write | required/expectedRevision |
| save_checkpoint | write | v3-checkpoint | adapted | write | required/current |
| session_recover | read | v3-index | adapted | read | none/none |
| save_restore | write | v3-checkpoint | adapted | admin | required/monotonic |
| memory_summarize | write | v3-adapter | adapted | write | required/memoryRevision |
| memory_layers | read | v3-index | adapted | read | none/none |
| todo_status | write | v3-adapter | adapted | write | required/memoryRevision |

## 管理 API

| 路径 | 状态 | 原因 |
| --- | --- | --- |
| /api/migrate-save-481 | reject | campaign import 未适配 V3 |
| /api/repair-authority | reject | repair apply 未适配 V3 |

记忆/摘要/待办/随机流已通过 V3 适配器写入；V2 Writer 保持禁用。
