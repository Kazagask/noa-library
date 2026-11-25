# BOOTSTRAP.md — NOA Library 唯一仓库入口

新会话只拿到仓库地址时，先读本文件。不要依赖之前的聊天记录，不要遍历整个仓库。

## 项目标识

- 项目：NOA Library（叙事层外置记忆与运行环境）
- 人格档案：`personas/noa/manifest.yaml`（当前为最小已确认版本，完整档案待迁移）
- 仓库角色：公开代码仓 + 合成 DEMO；真实存档与人格长期记忆在私有 vault
- 入口索引：`manifest.yaml`

## 最小启动流程（三阶段）

1. 读 `manifest.yaml` + 本文件 + `personas/noa/identity.yaml`、`voice.yaml`、`boundaries.yaml`。
2. 从 `manifest.yaml#campaigns` 选 `status: active` 存档（用户指定则覆盖），读 `campaigns/<id>/state/latest.json` 与 `working.json`；只要摘要。
3. 读 `campaigns/<id>/memory/index/meta.json` 检查同版本；按需读 `recent.json`、`unresolved.json`、`commitments.json`、`by-entity/<entityId>.json`。
4. 玩家行动涉及原文时，再读单个 `memory/episodes/*.md` 或 `worlds/<worldId>/` 中相关层。
5. 命令行等价：`node scripts/cli.ts coldstart --stage 1`，`--stage 2`，`--stage 3`，可用 `--budget N` 控制每阶段字符预算。

标准指令仍为：“召唤诺娅，读取 NOA Library，恢复最近的有效存档。”

## 活跃存档索引

以 `manifest.yaml#campaigns` 为准，不在本文件硬编码。每条含 `id`、`path`、`worldId`、`worldlineId`、`status`、`title`。不要假定只有 `demo`。

## 权威数据来源

- 确定性状态：`campaigns/<id>/state/latest.json`（revision / rng / clock / inventory / quests）。
- 语义记忆与情景：`campaigns/<id>/memory/*.jsonl` 及其物化索引 `memory/index/`。
- 世界知识：`worlds/<id>/manifest.yaml#sourceLayers`，区分 canonical / template / worldline / subjective。
- 人格长期记忆：`personas/noa/memory/`，独立于任何 campaign；游戏回档与分叉不影响它。

## 记忆检索规则

- 先查索引，再查原文；按 `worldlineId`、`validFrom/validUntil`、`knownBy`、`epistemic/holder` 过滤。
- `github-native` 模式只能做 Agent 级逻辑过滤：读到完整秘密文件后“自行隐藏”不等于权限隔离。服务端强制过滤只在 `memory-server` / `mcp-native` 模式存在。
- 物化索引 `memory/index/meta.json` 的 `sourceRevision` 与 `memoryRevision` 必须匹配当前 state/working；不匹配时重建：`node scripts/cli.ts index --campaign <id>`。
- 超大实体用 `by-entity/<id>.<worldlineId>.page-N.json` 分页；只读需要的页。

## 写入与回执协议

- `github-native`：读 revision 与 Git commit SHA → 写 `runtime/pending/<requestId>.json` → 等 `runtime/receipts/<requestId>.json` 出现 `status: applied` → 核对 `appliedRevision` 与 `hash` → 才能向玩家确认结算。
- 被拒绝时读 `runtime/rejected/<requestId>.json`；不得把 pending 当作已完成。
- 本地无 Actions 时：`node scripts/runtime-exec.ts all`。
- 其他模式：`state.commit` 必须带 `expectedRevision` 与 `idempotencyKey`；随机结果来自 `runtime.execute`。

## 失败降级

- 索引过期 → 回退读 JSONL 索引并提示重建，不停止会话。
- 主 campaign 不可读 → 按 `manifest.yaml#campaigns` 提示用户选择其他存档；不私自换档。
- 请求超时 / 并发冲突 / revision 冲突 → 读 rejected 说明，重新取基线后以新 requestId 提交；不重复发放奖励。
- 不确定的人格历史 → 标记待确认，不创作、不补全。
- 真实私人数据 → 停止写入公开仓库，改用私有 vault 配置。
