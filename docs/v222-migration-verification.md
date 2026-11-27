# R1365 正式库备份离线迁移校验

## 输入

- 压缩包：`NOA-Library-V2-R1365-backup.zip`
- ZIP SHA-256：`2c4b3c356f4d8d7fcbdb34f992d782f8510721a34e7de73a6ef4424359aeac37`
- `noa-library-backup.json` SHA-256：`d70cc343547e27ad520de0ef7bec9f08cf6ae42298de592d497a1f28cd611c23`（与 `verification.json`、`SHA256SUMS` 一致）
- 正式备份 revision：1365；RNG cursor：602；campaign：2；worldline：2。

## 校验结果

`node scripts/verify-backup-migration.mjs`：**PASS，20/20 检查通过**。

| 项目 | 结果 |
| --- | --- |
| 备份哈希一致性 | PASS |
| 全部 campaign/worldline 迁移 | 2/2 |
| Campaign 人格迁移 | 1/1 |
| 权威 state 逐世界线完全一致 | PASS |
| working 逐世界线完全一致 | PASS |
| 实体/关系/情景文档 | 554/554 |
| 记忆层级索引 | 554/554 |
| 历史事件 | 1992/1992 |
| 事务回执 | 1372/1372 |
| RNG 历史 | 602/602 |
| Checkpoint | 7/7 |
| Revision 1365 / RNG 602 / pendingEvents 245 | PASS |

原始报告：`reports/r1365-migration-verification.json`。

## 边界

这是离线只读校验：未连接正式 D1，未对正式库写入，未部署生产。托管 D1 复测仍需在新构建产物上执行。
