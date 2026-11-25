# NOA Library

叙事层外置记忆与运行环境。ChatGPT 负责叙事与交互；本仓库负责持久化记忆、知识检索、权威状态和确定性计算。

**位置**：`D:/CODE/noa-library`　**依赖**：Node.js 22.18+（内置类型擦除与 `node:sqlite`），零第三方 npm 包。
**公共仓库**：https://github.com/Kazagask/noa-library （`main`）。真实存档请使用私有 vault，不要提交到此处。

## 实施状态

| 阶段 | 状态 | 内容 |
| --- | --- | --- |
| P0 GitHub 图书馆 MVP | 已完成 | 目录、协议、Schema、合成 DEMO、人格骨架、冷启动、校验与备份 |
| P0 GitHub Native Runtime | 已完成 | pending 请求、可信执行器、receipts/rejected、批量、幂等、版本/基线校验、Actions |
| P0 记忆索引 | 已完成 | 实体/别名/按实体关系与情景/近期/未办/承诺/世界线索引，分页与同版本校验 |
| P0 冷启动增强 | 已完成 | `BOOTSTRAP.md`、三阶段可配置预算、动态 campaign、模式能力声明 |
| P0 人格迁移 | 已完成（最小已确认版） | 七分片、独立命名空间、版本与增量导入；正式历史仍待迁移 |
| P0 历史存档导入 | 已完成 | JSON/MD/YAML/对话/时间轴候选提取、dry-run、冲突报告、来源索引、幂等 |
| P0 安全整改 | 已完成 | vault 配置与迁移脚本、公开仓能力声明、生产 token fail-closed、最小权限 Actions |
| P1 Memory Server | 已完成并审查 | HTTP API + FTS5 + 鉴权；新增 `/mcp` Streamable HTTP |
| P2 MCP Adapter | 已完成并审查 | stdio JSON-RPC 2.0 与 HTTP 共用工具语义；**ChatGPT 实际连接未验证** |
| P3 游戏内核集成 | 仅评估，未实现 | 见文末边界说明 |

测试：**25/25 通过**（原 12 项 + 第二阶段 13 项）；`node scripts/cli.ts verify` 91 项通过；MCP 本地客户端通过。

## 快速开始

```bash
cd D:/CODE/noa-library
node scripts/cli.ts verify
node scripts/cli.ts coldstart --stage 1                 # campaign 自动取 active
node scripts/cli.ts coldstart --stage 2 --viewer person.player --budget 5000
node scripts/cli.ts coldstart --stage 3 --mode github-native
node scripts/cli.ts index --campaign demo
node scripts/cli.ts entity --id person.player
node scripts/runtime-exec.ts status
npm test                                               # 25 项测试
npm run serve                                          # HTTP API 127.0.0.1:8787
npm run mcp                                            # stdio MCP
npm run test:mcp
```

## 最新冷启动入口

唯一入口是仓库根 `BOOTSTRAP.md`。标准指令：

> 召唤诺娅，读取 NOA Library，恢复最近的有效存档。

阶段一读 `manifest.yaml` + `BOOTSTRAP.md` + 人格核心 + 权威状态摘要；阶段二读物化索引（相关人物、近期事件、未完成任务、长期关系）；阶段三只在需要时读单篇原文或世界知识。campaign 不硬编码：从 `manifest.yaml#campaigns` 取 `status: active`，用户指定则覆盖。

细则是 `protocols/bootstrap.md`；CLI 输出带 `stage`、`sources`、`nextStage`、`availableCampaigns`。

## GitHub Native Runtime（无需 Memory Server / MCP）

协议：`protocols/github-native.md`，Schema：`schemas/runtime-request.schema.json`，真实生成的请求/回执示例：`examples/github-native/request.example.json` 与 `receipt.example.json`（模板另见 `runtime/example-request.json`）。

流程：

1. 读 `state/latest.json` 的 `revision`、`working.json` 的 `memoryRevision` 与 Git commit SHA（`node scripts/runtime-exec.ts status`）。
2. 写 `runtime/pending/<requestId>.json`。JSON 数组 `operations` 支持批量，白名单操作见 Schema。
3. `.github/workflows/runtime.yml`（仅 `contents: write`）或本地 `node scripts/runtime-exec.ts all` 消费请求。
4. 读 `runtime/receipts/<requestId>.json`：**只有 `status: applied` 才算结算**；核对 `appliedRevision` 与 `hash`。
5. 拒绝见 `runtime/rejected/<requestId>.json`，含 `revision_conflict`、`base_commit_mismatch`、`request_expired`、`execution_failed` 等恢复建议。

重复幂等键返回 `duplicate: true` 的旧回执，不重复结算。请求内容只作数据解析，不 eval、不执行 shell；工作流不运行请求中的代码。

## 记忆索引（GitHub 场景）

由权威数据生成，位于每个 campaign 的 `memory/index/` 与 `memory/by-entity/`：

- `entities.json`、`aliases.json`（人名/别名）、`recent.json`、`unresolved.json`、`commitments.json`、`worldlines.json`
- `by-entity/<id>.json`：按实体聚合的关系与情景；超阈值拆成 `<id>.<worldlineId>.page-N.json`
- `meta.json` 以 `sourceRevision` + `memoryRevision` 做同版本校验；失配时查询返回 `index_stale`

重建：`node scripts/cli.ts index --campaign demo`。查询：`entity`、`recent`、`unresolved`、`commitments` 子命令。索引对受限条目只写 `[restricted]`，但这是工程措施，不是服务端权限隔离。

## 人格迁移与历史导入

- 正式人格分文件：`personas/noa/manifest.yaml` + `identity.yaml` / `voice.yaml` / `boundaries.yaml` / `relationship.yaml` / `preferences.yaml`，共同经历与对话样本在 `personas/noa/memory/*.jsonl` 与 `imports/`。`personas/noa.yaml` 已降级为指针。
- 已确认事实（名称 NOA、叙事层管理者、称呼玩家「大人」、温和活泼略俏皮但裁决严谨、不覆盖确定性内核、不向 NPC 泄露跨世界记忆）已落地；正式历史未迁移，不创作、不补全。
- 长期记忆命名空间 `noa/persona-relationship`，独立于 campaign，回档/分叉不影响。
- 增量导入：`node scripts/persona.ts show`；`node scripts/persona.ts import --kind examples --file <json|jsonl> --key <idempotencyKey> --source <来源> [--apply]`（默认 dry-run）。
- 历史存档：`node scripts/import-history.ts --input <文件或目录> [--campaign id] [--apply]`。默认 dry-run；输出冲突报告、未映射字段、来源索引；不覆盖已有正式存档；重复导入幂等。

## 安全与 vault

公开仓只放代码、Schema、协议与合成 DEMO。配置模板 `config/vault.example.yaml`；检查/规划/复制：

```bash
node scripts/vault.ts check
node scripts/vault.ts plan
node scripts/vault.ts apply --vault <私有目录>
```

`apply` 只复制不删除；删除公开副本需人工确认。私有 `noa-vault` 仓库尚未建立。详见 `SECURITY.md`。

生产环境必须设置 `NOA_API_TOKENS`，否则服务拒绝启动；默认 `dev-noa-token` 仅在开发环境存在。权限为 `read` / `write` / `admin`。

## P1/P2 兼容审查

- 保留 stdio MCP；新增 HTTP `POST /mcp`（Streamable JSON-RPC 2.0），两者共用 `packages/server/mcp-tools.ts`。
- HTTP `/mcp` 有 Bearer 鉴权、按工具 scope 检查、结构化 JSON-RPC 错误、工具 Schema、健康检查 `/health`。
- 写入幂等由 ops 层 idempotencyKey 处理；并发由 SQLite 事务 + revision 乐观锁 + GitHub Native 文件锁处理；事件写入 `state/events.jsonl` / events 表供审计。
- stdio 可用不等于 ChatGPT 可远程连接；该能力未验证，不为此继续扩张工程。

## 明确未实现 / 未验证

- 向量索引、PWA IndexedDB 双向同步、多用户 ACL、私有 vault 仓库、GitHub Actions 实际运行、Docker 镜像构建、ChatGPT 远程 MCP 连接，均未实现或未验证。
- `runtime.execute` 只有带种子的基础检定，未接入人生模拟器战斗/事件链；科研、经营、修炼结算仍无确定性实现。
- 人格正式历史与对话样本待从真实资料迁移；`github-native` 没有服务端强制权限隔离。

## 与现有人生模拟器的集成边界（P3 未实现）

可复用：`D:/CODE/ai-life-simulator/packages/game-core/src/rng.ts`（mulberry32、命名流、按 turn 派生种子）、`packages/game-core/src/v2/turn.ts|battle.ts|scheduler.ts`、`packages/shared/src/v2.ts|v2-state.ts`（`WorldStateV2`、schema v5）、`apps/server/src/store.ts` 的 envelope 与拒绝码。方案：把 `RpgEngineAPI.dispatch` 接为 `runtime.execute` 后端，存档 envelope 映射到 NOA state 的 `extension`。
