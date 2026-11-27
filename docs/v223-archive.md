# V2.2.3 V3 完整归档规范

## 导出

`archiveExportV3` 从 V3 权威组件/文档重建完整文档，绑定当前 active revision。

- `format: noa-archive-v3`
- 完整内容：active/persona/campaignPersonas/campaigns（manifest、state、working、entities、relations、episodes）/events/receipts/checkpoints
- 序列化：`stableStringify`，对象键排序，数组保持原顺序
- 分页：`pageBytes` 默认 12000，页 0 基
- 每页：`pageHash`、`base64`、`nextCursor`、`done`
- 总哈希：`sha256(stableStringify({format,revision,document}))`
- 首请求返回 `pages/bytes/sha256/nextCursor=0/done=false`

## 重新导入

`archiveImportV3`：

1. 校验 `format`。
2. 重新计算 `{format,revision,document}` 总哈希，不一致拒绝。
3. 通过 `promoteV3` 写入新 owner 的 V3 权威表。
4. 深度比较使用 `stableStringify` 或 `sha256`，不能只比较条数。

测试 `tests/v223.test.ts` 覆盖多页汇编、页哈希、总哈希、done 标记、重导入后 `documentV3` 完全相等。
