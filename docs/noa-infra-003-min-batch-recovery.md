# NOA-INFRA-003 · 最小批量恢复接口交付手册

## 目标与边界

把 NOA-INFRA-002 已生成的 R1550 纯净恢复产物，通过 **真实 D1 `DB.batch()`** 载入独立隔离 V3 实例。未重新设计归档格式、V3 内核或迁移逻辑；未访问旧线上实例；未增加在线迁移需求。

Worker 不提供任意 SQL 执行接口。CLI 在本地把 INFRA-002 的 `data-*.sql` 转换为结构化表记录批次，Worker 仅接受固定表/字段白名单内的参数化记录。

## Sites 调用者身份确认

Sites 脚本通过 MCP 请求头 `oai-authenticated-user-id` 传递**网关已认证的真实 MCP 身份**。Worker 要求：

- `oai-authenticated-user-id === NOA_REPAIR_OWNER`
- `NOA_RECOVERY_MODE === 'isolated'`
- `NOA_RECOVERY_OWNER` 已设置

数据 owner 固定来自 `NOA_RECOVERY_OWNER`（`save481-recovery`），调用方不能通过参数指定。隔离实例中，通过认证后所有 V3 业务工具也映射到该数据 owner；审计 actor 仍保留真实调用者身份。

错误身份、缺少隔离标记、非隔离环境均拒绝，代码分别为 `forbidden` / `recovery_not_allowed`。

## 环境变量（隔离恢复实例）

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `NOA_REPAIR_OWNER` | Sites 网关认证的真实 MCP owner | 调用者身份；恢复工具与业务工具均要求匹配 |
| `NOA_RECOVERY_OWNER` | `save481-recovery` | 固定数据 owner；由源归档无 owner 绑定决定 |
| `NOA_RECOVERY_MODE` | `isolated` | 仅该值允许恢复接口执行 |
| `NOA_ALLOW_LEGACY_GOVERNANCE` | `0` | 保持 V2 治理写入禁用 |

## 导入产物

来自 `deploy/data/r1550-recovery/recovery/`（`.gitignore` 已排除，不提交 GitHub）：

- `recovery-manifest.json`：批次清单、逐批 SHA-256、源清单 SHA-256、业务证据。
- `recovery-batches.jsonl`：397 行，每行一个结构化批次。
- 源产物仍为 `deploy/data/r1550-recovery/manifest.json` 与 `sql/*.sql`。

关键值：

| 项目 | 值 |
| --- | --- |
| INFRA-002 源清单 SHA-256 | `1eadb73aba0aea708172d74d45378484bd2da0045d86291d89528821c36bb35c` |
| 结构化清单对象 SHA-256 | `62a789646453a20b4e12fc0fa26b92934c26226c827e737c61c8590033372d8e` |
| 结构化清单文件 SHA-256 | `02edf902f3da525d5e084f029b78496bc8fe4bb875f65427182a212746326305` |
| 源 SQL 批次 → 结构化批次 | 110 → 397 |
| 导入记录数 | 15,182（排除由 finalize 发布的 authority pointer 1 行） |
| 单批上限 | 40 行 / 900,000 语句估算 bytes / 44 条语句（含 2 条会话元数据） |
| 请求体上限 | 1,950,000 bytes |
| 单值上限 | 1,000,000 bytes |
| 字段数上限 | 16 列/语句 |

## Sites 执行步骤

1. 创建**全新独立** D1 实例，绑定为 `DB`，只应用 INFRA-002 包中的 `sql/000_schema.sql`。恢复接口会自动补建会话表。
2. 部署包含本提交 Worker 的隔离实例，配置上表环境变量。
3. 在本地恢复包目录运行：

```bash
# 可选：重新从 INFRA-002 SQL 产物生成结构化批次
npm run recover:r1550:prepare

# 自动 begin → push（可断点续传）→ finalize
npm run recover:r1550:import -- \
  --endpoint https://<isolated-worker>/mcp \
  --owner <Sites 网关认证的真实 MCP owner>
```

4. 查询或人工收尾：

```bash
npm run recover:r1550:status -- --endpoint ... --owner ...
npm run recover:r1550:finalize -- --endpoint ... --owner ...
npm run recover:r1550:abort -- --endpoint ... --owner ...
```

导入脚本输出 `deploy/data/r1550-recovery/recovery/import-report.json`。`--session` 可显式指定会话；默认由清单对象哈希派生，天然支持断点续传。

## 协议行为

| 动作 | 行为 |
| --- | --- |
| `recovery_begin` | 校验清单哈希与 owner；若目标库已有该 owner 数据则 `recovery_target_conflict`；相同清单重复 begin 返回同一会话。 |
| `recovery_push` | 校验 batchId/ordinal/行数/逐批 SHA-256；重复提交返回 `duplicate=true`；内容变化返回 `recovery_sha256_mismatch` / `recovery_batch_conflict`。 |
| `recovery_status` | 返回已应用批次、行数、会话状态与当前权威指针。 |
| `recovery_finalize` | 仅在全部批次应用后执行；核验计数、表哈希、业务哈希、revision/rng 与 head 状态；通过后写入 `noa_authority_pointer(target=v3, frozen=1)`。 |
| `recovery_abort` | finalize 前可中止，按 owner 清理全部白名单表与会话记录；finalize 后禁止 abort。 |

`zzz_activate.sql` 不在本链路执行。解除冻结仍属于独立的托管验收后所有者动作。

## 完整性证据

finalize 核验以下 INFRA-002 证据（全部在本地 workerd D1 端到端测试中通过）：

- revision `1550`、RNG cursor `657`、seed `1581654255`
- events `2234`、receipts `1559`、checkpoints `9`、entities `20`、relations `48`、episodes `618`、rng `657`、campaigns `2`、worldlines `2`
- business `897aeeb4…cdf64`、state `52e1def2…86b5`、working `68bea2b6…e654`
- events `8dcade82…3492`、receipts `030beb0d…79cb`、checkpoints `30be8108…8999`
- persona `912263ac…ec608`、graph `b8b8f879…4758a`
- 全部业务表逐表行数与 SHA-256 一致（authority pointer/smoke 与 CAS guard 除外，由 finalize 单独管理）

## 本地验证

`tests/noa-infra-003.test.ts`：白名单拒绝、幂等/冲突/断点/abort、隔离环境与身份映射不可绕过；并使用实际 R1550 产物在 Miniflare/workerd D1 中完成 397 批导入、finalize 冻结、`state_read`/`session_bootstrap`/`memory_recall`/`archive_export` 冒烟、冻结写入拒绝、解冻后业务写入与回执验证。

原有 100 项回归测试继续通过。
