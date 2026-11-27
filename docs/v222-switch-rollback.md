# V2.2.2 正式切换与回滚方案

## 切换前置条件

- 独立 Sites QA 部署 release `2.2.2-migration-audit-fixes`，构建产物 SHA 与源码清单 SHA-256 `967387cd5d9bcb225a6505e9a702f753cb48721bf0c2846f68d2b16a907ba0e8` 一致。
- QA 上用 R1365 备份完成离线等价迁移与上一轮 NO-GO 全项复测。
- 真实 ChatGPT MCP 重连通过。
- 正式 D1 只读导出与迁移前私有基准已动态生成并校验。
- 用户明确授权生产切换。

## 切换步骤

1. 冻结正式写入入口，保留只读查询；记录当前 revision、RNG cursor、head version。
2. 只读导出正式 D1；在隔离库运行 `promoteV3`，执行 667 项等价校验。
3. 校验正式备份的 state/persona/memory/relations/timeline/RNG/receipts/checkpoints；任何一项不一致即停止。
4. 将 QA 构建产物发布到正式 Sites；D1 绑定切换到迁移后的正式库。
5. 执行 `bootstrap → recall → state_read → event_receipt → session_recover`；再执行一次隔离 event_commit + runtime_execute + checkpoint + restore。
6. 通过后解除写入冻结；保留 V2 分片与迁移前备份。

## 回滚

- Worker：回滚到 `2.2.1-akasha-state-core` 或 `2.0.0-storage.4`。
- 数据：保留 V2/V3 双份；切换回 V2 Worker 时只改绑定，不删除 V3 表。
- Checkpoint：使用迁移前完整备份恢复；恢复后 revision 必须单调递增。
- RNG/资源/人格：以迁移前私有基准为准，不补骰、不重算收益、不覆盖人格记忆。
- 治理写入：继续默认禁用 `campaign_import` / `repair apply`，直到 V3 适配完成。

## 禁止

- 未授权不得写正式 D1、不得重新部署生产。
- 不得把正式备份提交 GitHub、上传公共环境或写入公开测试报告。
- 不得用本地 SQLite 结果替代托管 D1 验收。
