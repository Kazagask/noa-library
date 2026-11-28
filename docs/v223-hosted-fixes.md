# V2.2.3 托管验收缺陷修复

基线下：PR #7 / `3a2b17802555`；本轮仅修复 01–05，不新增架构。

| 编号 | 修复 |
| --- | --- |
| 01 | `archive_export` 声明同时支持 `page` / `pageBytes`，兼容 `cursor`；V3 仅在两者都缺失时返回清单，`cursor=0/1` 均返回正文。 |
| 02 | 页哈希改为对分页原始字节做 SHA-256（`crypto.subtle`），不再对解码字符串重算；归档总哈希也按原始 UTF-8 字节计算。 |
| 03 | `documentV3` 导出 checkpoint 时 JOIN `noa_v3_checkpoint_meta`，保留 campaign/worldline/label/createdAt/source/version/format/revision/parentId，不再归到活动 Campaign。 |
| 04 | `memory_record` / `memory_revise` / `memory_summarize` / `todo_status` 同步更新 working.memoryRevision；记忆操作不回落。 |
| 05 | `state_read` 支持 `fields` 投影与 `limit`；新增 `noa_v3_adjacency` 复合邻接键；旧库回填从 `family` 解析 campaign/worldline；BFS 始终合并关系文档，部分邻接也不会漏边。 |

## 验证

- 自动化测试 84/84（既有 81 项保留 + state_read/traverse + 旧库邻接回填/部分邻接）。
- R1365 深度校验 674/674；checkpoint 元数据比较仍通过。
- 源码清单 110 文件，根 SHA-256 `6f5bb77be1c2fd809b8d6b944a81ca556d599b99fbc9f03fe0b54e3f81e38bb3`。

## 未完成

托管 Sites 复测和真实 ChatGPT `save_restore` 未在本环境执行；当前仍为 NO-GO。
