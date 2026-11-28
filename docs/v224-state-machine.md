# V2.2.4 发布状态机与回滚

## build → verify → activate

1. `promoteV3` 只构建：head 状态 `building`，不激活，`hasV3` 为 false。
2. `verifyV3` 执行全领域门禁，成功写 `noa_v3_activation` 凭证：
   - 绑定 `sourceVersion`、`generation`、全领域摘要；
   - 凭证 digest 校验。
3. `activateV3` 必须携带 verificationId：
   - 校验凭证未被消费、digest 正确；
   - 校验源版本与 generation 未变化；
   - 写 `noa_authority_pointer = v3`，默认 `frozen=1`；
   - 迁移内部不再自动 activate。

## 冻结

`activateV3` 默认 frozen=1。V3 冒烟期间业务写入（event_commit、state_commit、runtime_execute、memory_*、todo_status、runtime_init）返回 `authority_frozen`；只读、checkpoint/恢复/归档仍可用。

## 解冻与冒烟

`unfreezeAuthority` 只允许在 frozen=1 时调用，写入 `noa_authority_smoke` 并设置 frozen=0。解冻后业务写入放行，但一旦进入 smoke 阶段，`rollbackToV2` 永久拒绝（`authority_after_smoke`），避免覆盖冒烟期新增业务数据。

## 回滚

`rollbackToV2` 只在 `frozen=1` 且未进入 smoke 阶段时允许，将 `noa_authority_pointer` 切回 `v2`，V2 原库不删除、不重写。V3 数据保留供审计；V2 守卫在 pointer=v2 时恢复 V2 写入。
