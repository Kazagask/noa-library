# V2.2.4 托管 D1 容量验收清单

禁止使用本地 SQLite 结果代替。必须在独立 QA D1 执行并保存原始 SQL/指标。

## 前置

- 部署 commit：V2.2.4 PR head。
- 源码清单 SHA-256 与 `scripts/source-manifest.mjs` 一致。
- 合成夹具：`node scripts/generate-scale-fixtures.mjs --scales=1,5,10 --out=backups/synthetic`。
- QA Campaign/worldline 显式指定，不接受默认活动存档。
- 仅使用隔离 QA；正式库不连接。

## 每档（1x / 5x / 10x）

1. 导入夹具到隔离 D1；记录每表最大单行、总字节、行数。
2. 执行长周期写入：event_commit、runtime_execute、memory_record、memory_revise、todo_status，至少 1000 轮。
3. 创建 ≥3MB checkpoint；确认 `noa_v3_checkpoint.delta=''`、chunk 数、最大 chunk <2MB。
4. 修改状态后恢复；校验 revision 单调、duplicate、业务状态深比较。
5. 归档 header + 全部分页；重组总字节/总 SHA-256/每页原始字节哈希；重新导入并深比较。
6. 迁移故障注入：组件批次失败、归档 chunk 失败、checkpoint chunk 失败；重跑必须恢复，重复迁移返回 alreadyActive 或续跑 complete。
7. 记录 rows_read/rows_written、P50/P95、最大单行。

## 通过线

- 任何表/字符串/BLOB/行 <2,000,000 bytes。
- 1x/5x/10x 全部 checkpoint/恢复/归档/迁移故障注入 PASS。
- 无无限分页、无缺失 chunk、无 revision/memoryRevision 回退。
