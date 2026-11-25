# 世界线与回档协议（worldline）

## 分叉（worldline.fork）

- 从当前 worldline 复制 state、entities、relations、episodes 到新的 `worldlineId`，并写入 `forkedFrom`、`forkedAt`。
- 分叉后两条世界线的记忆互不可见；`recall`、`traverse` 必须带 worldlineId 过滤。
- 诺娅与玩家的跨世界关系在 `noa/persona-relationship` 命名空间中保留，但普通 NPC 不继承其他世界线的情报。

## 快照（save.checkpoint）

快照必须同时包含：权威 state、实体、关系、情景索引、working memory、journal 指针、state revision、rng cursor。只保存 state 的快照是不合格的。

```bash
node scripts/cli.ts checkpoint --campaign demo --label "before-choice"
node scripts/cli.ts restore --campaign demo --checkpoint <id>
```

## 回档（save.restore）

- 恢复 state 与全部记忆层；恢复后 revision 与 rng.cursor 一并回退，防止未来情报泄露。
- 回档操作需玩家确认，并写入审计事件。
- 回档不删除其他 worldline 的数据。

## 导入导出

`node scripts/cli.ts export --campaign demo --out <file>` 生成可迁移 JSON 包；`import` 在目标目录重建 campaign。显式操作，不隐式双向同步。
