# V2.2 迁移与上线保护

## 兼容关系

- V2 `noa_head/noa_shard` 保留，不删除、不清空。
- V3 表与 V2 并存；Worker 在检测到 `noa_v3_head` 后，对 event_commit / event_receipt / session_recover / session_bootstrap / runtime_execute / checkpoint 走 V3。
- 其他生产工具仍走原 V2 路径，逐步迁移。

## 隔离迁移步骤

1. 从隔离 D1 只读导出 V2 文档，生成动态私有基准（state/memory/RNG/历史/回执/人格哈希）。
2. 在新建空库应用 V2 + V3 schema，导入 V2 快照。
3. 调用 `promoteV3(db, owner, document)` 一次性建立 V3 局部文档与索引；此步骤允许完整扫描，不进入常规提交。
4. 校验 promote 前后：state/memory/RNG、人格、事件/回执数量、关键业务收益、完整业务哈希。
5. 运行 fault injection、双 owner/双世界线、混合负载基准。
6. 重启 Worker 与数据库后重复轻量恢复与幂等重传。
7. 人工确认后才允许切换 Sites D1 绑定。

## 回滚

- Worker 回滚到 release `2.0.0-storage.4`，不删除 V3 表。
- 应用继续走 V2 路径（V3 head 存在但新 Worker 不识别）。
- V3 派生表可整表清空；V2 权威分片保持不变。
- checkpoint 回滚使用迁移前 `archive_export` 备份。

## 授权边界

本轮未访问或写入正式 D1，未重新部署生产。托管 D1 验收必须在用户提供的隔离托管数据库中执行；未执行前不得申请上线。

## 剩余缺陷

见 `docs/v22-defects.md`。
