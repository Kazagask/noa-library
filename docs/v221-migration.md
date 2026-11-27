# V2.2.1 迁移与上线保护

## 兼容路径

- V2 `noa_shard` 与 V3 `noa_v3_doc` 保留为兼容数据。
- V3 通用组件表为新增：schema/entity/component/collection_item/component_index/component_checkpoint。
- `promoteV3` 一次性从 V3 快照建立组件分片；常规事务只读写本轮涉及组件。
- `event_commit` 输入协议不变，NOA 不需要立即改写业务调用。

## 隔离迁移演练

1. 从隔离库导出 V2/V3 数据，生成动态私有基准：state、memory、history、receipt、RNG、persona 哈希。
2. 在新建隔离库应用全部 schema，导入快照。
3. 执行 `promoteV3`，校验组件重建 state 与源 state 完全一致。
4. 执行 event_commit、runtime_execute、checkpoint、恢复与双 owner/双世界线测试。
5. 运行五类十万轮场景与回滚演练。
6. 校验 V3 写入对 V3 所有读取接口立即可见。
7. 人工确认后才允许 Sites 侧绑定切换。

## 回滚

- Worker 回滚到 `2.2.0-incremental-core` 或 `2.0.0-storage.4`；V3 组件表可保留。
- 若需清除组件派生数据，只删除 V3 组件表；V2/V3 快照与事件不删除。
- checkpoint 回滚使用迁移前私有备份，不补骰、不重算收益、不覆盖人格记忆。

## 授权边界

未访问正式 D1；未重新部署生产；未索取或提交生产凭据。托管 D1 验收完成前不得上线。
