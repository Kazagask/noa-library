# V2.2.2 托管验收整改

基线：托管 QA 对锁定源码 `8490ddbcf0a66dc2a768318c8cae929157ba5ca8` 的 NO-GO 报告。

## 已修复 P0

1. **全量世界线迁移**：`promoteV3` 遍历所有 campaign/worldline，不再只迁活动世界线。
2. **Campaign 人格迁移**：`campaignPersonas` 写入 `persona:<campaignId>`；bootstrap 优先读取专属人格。
3. **历史记忆/checkpoint/RNG 迁移**：迁移 entity/relation/episode 的 tier/knownBy/edge 索引、V2 checkpoints、runtime receipts 与消费状态。
4. **数组顺序与空集合**：集合按数值 itemKey 排序；`field@shape` 保留数组/对象形态；空集合重建为 `[]` 或 `{}`。
5. **Checkpoint 恢复 revision 倒退**：恢复写入新 revision（当前+1）、新 memoryRevision 与恢复回执，并在同幂等键重传时返回原结果。
6. **V3 治理/归档权威**：`archive_export` 从 V3 组件/文档重建完整文档；V2/V3 统计分离。

## 已修复 P1

- `state_read(section="clock")` 只返回 clock 分片。
- 修复工具注册顺序：`session_recover`、`save_restore` 出现在 `tools/list`。
- `session_bootstrap` 恢复 `mode=sites-mcp`、state summary、persona、persistenceProtocol、memory 引用协议。
- GM `memory_recall` 进入 L3 audit 层。

## 尚待验证

- 最新正式库完整 `noa-library-backup.json` 未取得；本地浏览器 CDP 未开启，无法只读下载。
- 托管 D1 复测需在新构建产物上执行并更新验收报告。
- `repair`/`formal` 仍是迁移治理工具，不作为常规 V3 权威读取路径。
