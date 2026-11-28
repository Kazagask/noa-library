# V2.2.4 存储可靠性专项 · GO/NO-GO

## 结论

**NO-GO（等待 Sites 定向托管复测）**。

代码层已关闭本轮剩余 3 个 P0：归档权威清单、build→verify→activate 状态机、V2 指针回切。真实托管 D1 的 1x/5x/10x 长周期与故障注入仍未在本环境执行，不能以本地 SQLite 结果替代。

## 已实现

- 归档完整性：按权威表生成预期 ID 集合/数量/哈希；导出后与流式实际记录清单比较；checkpoint 缺片/损坏直接 fail-closed；归档 header 携带 `integrity`。
- 发布状态机：`promoteV3` 只 build（status=building，hasV3=false）；`verifyV3` 生成绑定 sourceVersion/generation/全领域摘要的 `noa_v3_activation` 凭证；`activateV3` 校验凭证与源版本后才写 complete 和 `noa_authority_pointer=v3`。
- 冒烟冻结：`activateV3` 默认 frozen=1，业务写入返回 `authority_frozen`；checkpoint/恢复/归档仍可用。
- 回滚：`rollbackToV2` 要求 frozen=1，只切 `noa_authority_pointer=v2`；V2 原库保留，V3 数据不删除。
- checkpoint 48KB 分片、working >512KiB 分片、归档增量序列化/增量 SHA-256/分片读取、迁移 40 条/512KiB 双限与批次游标。
- 记忆写入不再读写完整 working；todo_status 使用独立 `noa_v3_todo` 覆盖表。

## 回归

- 100/100 自动化测试通过。
- R1365 674/674 深度校验通过。
- 源码清单 130 文件，根 SHA-256 `c28ea4837432faf2d51729b17a690cbecef6cc0e7e170909c2cc1e7c4e1b5356`。

## 未完成门禁

1. 托管 D1 1x/5x/10x 长周期读写。
2. 跨请求 build 续跑、超时、重复提交、chunk 缺失/损坏、迁移中断故障注入。
3. 托管归档全分页重组与大归档回导。
4. 托管 checkpoint 3MB+ 保存/恢复及 rows/P50/P95 证据。
5. 回滚演练：冻结后切 V2，确认 V2 可写、V3 数据保留。

正式库仍为 V2；R1550 / Storage 1559 未修改；未执行生产迁移。
