# V2.2.4 持久化对象容量审计

硬限制：Cloudflare D1 单个字符串/BLOB/数据库行 **2,000,000 bytes**。

## 审计结果（R1365 正式备份，只读）

| 对象 | 数量 | 最大单对象 | 结论 |
| --- | ---: | ---: | --- |
| checkpoint snapshot | 7 | 2,414,782 B | 超限；已改 `noa_v3_checkpoint_chunk` 分片 |
| working | 2 | 1,643,478 B | 接近上限；已改 `noa_v3_doc_chunk` 分片（>512 KiB） |
| state | 2 | 583,125 B | 当前未超限；由 state components/collections 分片 |
| event | 1,992 | 189,397 B | 当前未超限 |
| episode | 486 | 12,792 B | 未超限 |
| relation | 48 | 836 B | 未超限 |
| receipt | 1,372 | 1,192 B | 未超限 |
| manifest | 2 | 935 B | 未超限 |

完整数据：`reports/v224-capacity-audit.json`。

注：checkpoint/working 分片后，单行风险已关闭；归档首次物化改为增量流式，不再先构造完整文档。

## 机制

- checkpoint：`noa_v3_checkpoint` 只保留 digest/元数据，正文按 48,000 bytes 分片写入 `noa_v3_checkpoint_chunk`；恢复时按 ordinal 拼装并校验整包 digest。
- working：超过 512 KiB 自动写 `noa_v3_doc_chunk`；`readDoc` 透明拼装并校验。
- archive：`noa_v3_archive` + `noa_v3_archive_chunk`，按 archiveId/revision 物化，分页只读覆盖当前页的分片，不重复整库序列化。
- migration：主语句按 40 条一批写入；状态组件按 40 条一批写入；head 先 `building`，全量状态哈希校验后才 `complete`，`hasV3` 只认 complete。

## 仍待托管验证

1x/5x/10x 合成夹具已生成：`backups/synthetic/v224-{1,5,10}x.json`（本地忽略，不进入仓库）。
本地预检：10x 迁移约 2.0s，checkpoint 12,263,200 bytes 分成 256 片并可恢复；这只能证明代码路径，**不能替代托管 D1 容量验收**。

## 托管验收要求

- 1x/5x/10x 均在真实隔离 D1 执行。
- 记录每张表最大单行、checkpoint chunk 数、归档 chunk 数、长周期 P50/P95、rows_read/written。
- 完成 checkpoint 保存/恢复、归档分页重组、迁移故障注入与续跑。
- 任何单行 ≥1.8MB 即停止并回到审计。
