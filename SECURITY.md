# 安全与能力声明

## 公开仓库边界

`noa-library` 是**公共代码仓**。允许提交：代码、Schema、协议、测试、合成 DEMO 存档与文档。

禁止提交：玩家真实历史、完整人格关系记忆、私人资料、正式游戏存档、token/API Key、`.env`。私有数据放 `noa-vault`（配置见 `config/vault.example.yaml`，仓库尚未建立）。迁移入口：`node scripts/vault.ts check|plan|apply --vault <dir>`。默认只复制、不删除；删除需人工确认。

## GitHub 模式不是权限隔离

`github-native` 模式下，Agent 通过 GitHub Connector 读取文件。它只能做 Agent 级逻辑过滤：按 `knownBy`、`worldlineId`、`validFrom/validUntil`、`epistemic/holder` 决定**是否把条目纳入上下文**。

如果 Agent 已经读取了完整秘密文件，再声称“我会隐藏它”不构成真正的访问控制。只有 `memory-server` / `mcp-native` 的服务端强制过滤才算权限隔离。物化索引对受限条目只写 `[restricted]`，这是减少泄露的工程措施，不是安全边界。

## 服务端鉴权

- 生产环境（`NODE_ENV=production`）必须设置 `NOA_API_TOKENS`，否则进程拒绝启动；缺省 `dev-noa-token` 只在开发环境生效。
- Token 按 `read` / `write` / `admin` scope 授权；`save.restore`、`worldline.fork` 需要 admin。
- `/mcp`（Streamable HTTP）与 stdio MCP 共用工具语义，但 HTTP 侧强制 Bearer token 与 scope。

## 请求安全

- GitHub Native 请求只写 `runtime/pending/*.json`，由可信执行器消费。执行器不 eval、不执行 shell、不拼接命令；`git rev-parse` 使用固定参数。
- 请求 Schema 限制 id 字符、操作白名单与批量数量；禁止 `__proto__` / `constructor` / `prototype` 键。
- GitHub Actions 仅 `contents: write`，不运行请求内容或 PR 标题中的代码。
- 文件锁 + `expectedRevision` + `baseCommitSha` 防止并发覆盖。重复 `idempotencyKey` 返回既有回执，不重复结算。

## 记忆与索引

- 检索时按世界线、有效期、认知权限和可见性过滤；NPC 主观认知不得升格为事实。
- 物化索引与权威数据用 `sourceRevision` / `memoryRevision` 做同版本校验，失配时拒绝查询并要求重建。
- 回档恢复 state 与全部记忆层，包括 rng cursor，防止未来情报泄露。
- 人格长期记忆在 `personas/noa/memory/`，与 campaign 回档/分叉隔离。

## 审计状态

- 未做真正的多用户 ACL、加密存储、密钥轮换或网络层隔离。
- 未验证 ChatGPT 账户能否连接远程 MCP；不要把 stdio 可用等同于云端可用。
- 未建立私有 vault 仓库；目前只有配置与迁移脚本。
