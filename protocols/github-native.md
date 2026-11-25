# GitHub Native Runtime 协议

适用模式：`github-native`。ChatGPT 只有 GitHub 文件读写能力时，仍可完成真实会话。本模式下**权威状态不由 Agent 直接改写**。

## 三种运行模式

| 模式 | 读 | 写 | 强制权限隔离 |
| --- | --- | --- | --- |
| `github-native` | GitHub Connector 读文件 | 写 `runtime/pending/*.json`，由可信执行器结算 | 否，只有 Agent 级逻辑过滤 |
| `memory-server` | HTTP API | HTTP API | 是（服务端 token + scope） |
| `mcp-native` | stdio/HTTP MCP | MCP 工具 | 是（服务端 token + scope） |

三种模式共享 `schemas/`、逻辑协议名与数据模型；`github-native` 能力降级，不提供服务端强制秘密隔离，不提供同步图数据库。

## 写入闭环

1. 读取基线：`campaigns/<id>/state/latest.json` 的 `revision`、`campaigns/<id>/working.json` 的 `memoryRevision`，以及当前 Git commit SHA。等价命令：`node scripts/runtime-exec.ts status --campaign <id>`。
2. 生成结构化请求，Schema 为 `schemas/runtime-request.schema.json`。`operations` 是白名单数组，可批量，禁止脚本或 shell。
3. 写入 `runtime/pending/<requestId>.json`。这一步只代表“已提交”，**不代表已结算**。
4. GitHub Actions（`.github/workflows/runtime.yml`）或本地 CLI 消费 pending：
   ```bash
   node scripts/runtime-exec.ts all
   node scripts/runtime-exec.ts execute --file runtime/pending/<requestId>.json
   ```
5. 执行器校验 Schema、操作白名单、revision、baseCommitSha、过期时间、幂等键，然后原子写权威状态、事件日志与记忆变更。
6. 读取 `runtime/receipts/<requestId>.json`。**只有 `status: "applied"` 的回执才算完成**；`runtime/rejected/<requestId>.json` 给出拒绝原因与恢复建议。
7. 向玩家展示结果前，必须核对回执的 `requestId`、`appliedRevision` 与 `hash`。

## 回执与拒绝

回执：`{status, requestId, campaignId, worldlineId, baseRevision, appliedRevision, baseCommitSha, executedAt, duplicate, operations, hash}`。

拒绝码：

- `invalid_request`：Schema/字段不合法；按 Schema 修正后重新提交。
- `unsupported_operation`：操作不在白名单；不得改用代码执行。
- `revision_conflict`：基线 revision 已变化；重新读取后提交新 requestId。
- `base_commit_mismatch`：Git 基线变化；重新确认后提交。
- `request_expired`：超过 `expiresAt`；设置新的过期时间后重提。
- `execution_failed`：执行中失败；执行器回滚快照，读 rejected 详情后以新 idempotencyKey 重试。
- `executor_busy`：并发锁占用；稍后重试，不直接写状态。

重复提交：同一 `idempotencyKey` 返回既有回执并标记 `duplicate: true`，不重复发放奖励或结算。失败后重试必须使用新 `requestId` 与 `idempotencyKey`。

## 安全边界

- 请求内容仅作数据解析。执行器不 eval、不执行 shell、不拼接命令；`git rev-parse` 使用固定参数。
- 工作流权限仅 `contents: write`，不运行 PR 标题或请求内容中的代码。
- 请求 id / actor / 幂等键限定字符；对象键禁止 `__proto__` / `constructor` / `prototype`。
- 单个请求最多 20 个操作；执行器持有文件锁，revision 乐观锁防止并发覆盖。
- pending 与 rejected 可能含玩家输入；公开仓库只接受合成测试数据，真实数据走私有 vault。
- 回执生成前的任何“已完成”叙述都是不允许的。
