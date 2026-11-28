# NOA-INFRA-001 第二轮整改对照

基线 commit：`80e1de8396881d272b67c35765dbe60ca96bf115`  
质量门禁：`reports/local-gate.json`（commit=80e1de8，worktreeDirty=false，100/100，0 skipped）

| # | 整改 | 测试/实际断言 |
| --- | --- | --- |
| 1 | 确定性中文召回 | `packages/local/smoke.ts`：`recall entity id/content`、`recall episode source`、`recall pagination`、`recall visibility`、`recall GM visibility`。断言具体 `entity.qa-xiaoyan`、`ep-summary-chinese-*`、`sourceEventId=ep-qa-0`、`knownBy` 可见性、`nextCursor=1`。 |
| 2 | 归档逐页完整性 | smoke `archive pages`：校验 page/order、每页原始字节 SHA-256、期望字节数；`archive integrity` 校验清单；总哈希在同函数末尾。 |
| 3 | 导入全领域比较 | smoke `imported state`、`imported memory`、`imported graph`、`imported persona`、`imported archive domains`；`tests/save481-like.test.ts` 对 campaign/checkpoint 文档哈希比较。 |
| 4 | 导入后继续运行 | smoke `post-import rng`、`post-import cross-module event`、`post-import receipt`、`post-import replay`；事件同时写 State、Entity、Relation、Episode。 |
| 5 | SAVE-481 同结构规模 | `tests/save481-like.test.ts`：486 episodes、20 entities、48 relations、1992 events、1372 receipts、7 checkpoints，迁移/state/checkpoint/archive/import 全流程。 |
| 6 | workerd/Miniflare | `tests/miniflare-d1.test.ts`：真实 Miniflare workerd D1 Binding、schema、V2→V3 迁移、`tools/list`、`session_bootstrap`。 |
| 7 | LocalD1 契约 | `tests/local-d1-contract.test.ts`：prepare/bind/all/first/run/batch、错误回滚、`.sql` 元数据；`docs/noa-infra-001-d1-contract.md` 明确兼容范围。 |
| 8 | 跨模块 event_commit | smoke post-import event：State + Entity + Relation + Episode；`tests/v223.test.ts` 事件/回执/重放；`tests/storage-failure.test.ts` 原子性。 |
| 9 | 批失败/重启 | `tests/storage-failure.test.ts` 对 LocalD1/D1Sqlite 断言 batch 失败零残留；smoke `restart recover` 验证进程重启。 |
| 10 | RNG | smoke `runtime_execute` 断言 seed 不变、cursor+1；`rng replay no consume` 断言同键不重复消耗；`restart recover` 断言 cursor 连续。 |
| 11 | 历史缺陷回归 | `tests/v223.test.ts` 的 archive chunk 缺失/损坏、recall 后部实体、fields/maxBytes、checkpoint 缺片、事件/回执、迁移游标；修复后均为强断言。 |
| 12 | 真实 MCP 响应预算 | smoke `maxBytes actual MCP`：通过 `client.request` 读取原始 `content[0].text`，对解析后的 data 计算 UTF-8 bytes <=400。 |
| 13 | 类型/强制门禁 | `scripts/typecheck.mjs` 检查本地改动面，基线未修改文件错误单独计数；`test-gate` 强制 tests/smoke/build/boundary/typecheck。 |
| 14 | 报告对应源码 | `test-gate` 写 commit、worktreeDirty、worktreeStatus、pass/fail/skipped；最终报告 commit=80e1de8、dirty=false。 |
| 15 | 临时目录 | 所有新增测试用 `mkdtemp` + `finally rmSync`；smoke 只清理自己的 `smoke-*`，不删除用户 DB。 |
| 16 | 本地认证/Docker | 默认监听 `127.0.0.1`；Docker 显式 `NOA_HOST=0.0.0.0`；默认开发 token 仅本地，文档提示覆盖。 |
| 17 | PR 状态 | PR #9 当前 mergeable=true / clean；当前 73 文件变更归类见 `docs/noa-infra-001-pr-scope.md`（评审时 62，整改后增加）。 |

## 未覆盖

- 真实 Cloudflare D1 限额/网络认证/托管产物：仍由 Sites + ChatGPT/NOA 验收。
- R1550/R1552 真实备份未上传公共环境；本地只用合成夹具，不能替代真实存档验收。
