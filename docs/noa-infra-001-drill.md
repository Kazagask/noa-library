# NOA-INFRA-001 本地灾难恢复演练

## 执行

```bash
node packages/local/cli.ts test:smoke
```

`test:smoke` 使用独立 stdio MCP 客户端，不直接调用 handler：

1. 初始化本地 SQLite 与 seed 存档。
2. `initialize` / `tools/list`。
3. `session_bootstrap`、`state_read`。
4. `memory_recall`、`memory_traverse`。
5. `save_checkpoint`。
6. `event_commit`。
7. `runtime_execute`。
8. `event_receipt`。
9. 同键 `event_commit` 重放，验证不重复结算。
10. 停止 stdio 进程并重启。
11. `session_recover` 验证 revision 与 RNG。
12. `save_restore` 回到 checkpoint。
13. `state_read` 比较业务状态（排除 revision/updatedAt）。
14. `archive_export` 全分页。
15. 总字节/总哈希校验。
16. 新空库 `archive_import`。
17. 新库读取并与原业务状态比较。
18. 清理临时数据库。

## 结果

- 当前本地门禁：95/95 tests，MCP smoke PASS，build entry PASS，boundary PASS。
- 归档导出/导入为本地 SQLite 路径；真实 D1 托管仍需 Sites/ChatGPT 验收。

## 故障注入

- 归档缺片/损坏：`tests/v223.test.ts` 覆盖。
- 迁移中断与批次游标：`tests/v223.test.ts` 覆盖。
- 幂等重复提交：smoke 与 v223 覆盖。
- checkpoint 缺失/损坏：托管已覆盖，本地补充 chunk 校验。
