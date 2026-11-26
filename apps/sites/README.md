# NOA Library（阿卡夏图书馆）

NOA Library 的 Sites Worker 适配版。上游版本见 UPSTREAM。构建只使用已确认的人格骨架及合成 DEMO。真实档案通过私有控制台导入。

- 构建命令为 `npm ci` 和 `node scripts/build.mjs`。
- `node scripts/smoke.mjs` 通过 SQLite 适配对象检查 Worker 路由和 SQL。控制台「运行验证」在托管 D1 上检查同一组 DEMO 写入。
- 保持 Sites 访问策略为仅所有者。Sites 身份头用于隔离档案。诊断路由依赖 Sites 网关访问控制，并使用独立合成档案。
- D1 行版本以单条条件 UPDATE 提交档案、状态、回执和审计，逻辑 revision 与数据库版本分开。当前单所有者档案上限为 1.5 MB。查询对当前世界线内存扫描，支持四跳和认知过滤。
- JSON/JSONL 导入导出使用上游 noa-bundle v1。JSONL 每行是一个完整 bundle，控制台一次导入一个。全库备份包含审计和回执。世界线恢复保留单调 revision。
- 工具列表通过 Sites MCP 2026-07-28 发布。注册及客户端安装入口由 Sites 平台生成。

正式 Campaign `SAVE-481 / wl-main` 由 `campaign_import` 校验并导入指定私有源档。原始 Git blob 保留在所有者档案的 sourceArchives 中，应用版本、世界状态、审计、回执和归档按一次条件更新提交。站点源码与构建包只保留 DEMO。

正式写入需显式传入 Campaign 与世界线。GM 在 `session_bootstrap` 得到归档协议，经 `event_commit` 原子提交并可用 `event_receipt` 复查。statePatch 递归合并对象，替换数组或标量。历史回执缺失保留为缺失。新检定仅使用同世界线已持久化的真实运行时回执。

正式档分片从当前权威快照投影。事件事务可用业务分片名，或 business 对象提交科研、产业、功法、技能与人物关系更新。对象递归合并，数组整组替换。未知分片和只读来源字段返回 unsupported_state_field。游戏时间以 clock.advanceMinutes 结算，绝对日期可保持空值。

已验证的所有者请求可通过 viewer=gm 召回世界线内的全局记忆。GM 启动默认使用该视角。显式角色视角继续经过认知和时间过滤。runtime_init 初始化未来检定的随机流，runtime_execute 持久化真实检定回执。

### 斗破事务写入

在同一世界线读取最新 revision 后，用 event_commit 提交稳定 eventId、idempotencyKey
及 expectedRevision。state_commit 的 changes 使用同一套业务补丁协议。
同一键超时后重传原请求，已应用事务返回既有回执。版本冲突需要重新读取并复核。
正式科研推荐 event_commit 以关联事件和检定回执。

- clock.elapsedMinutes 是相对于 clock.anchor 的非负整数分钟。同一基准不可回退。
  也可改用 clock.advanceMinutes 表示本次推进，两者互斥。更换 anchor 时须明确提供
  elapsedMinutes。绝对日期未知时传 clock.date: null。
- research.projects 以稳定项目 ID 为键提交单项目局部更新。兼容带 id 的项目数组。
  state_read(section="research/PROJECT-ID") 读取写入后的正文。
- economy.industriesById 以产业 ID 为键。设置 next_due_elapsed_minutes 和可选
  clock_anchor，查询时按当前时钟导出 remaining_minutes、next_settlement_days 和
  pending_settlement。到期仅标记待结算。
- economy.settlementLedger 以稳定批次 ID 为键追加账本。已登记的键会拒绝新请求。
  通过 state_read(section="settlementLedger/BATCH-ID") 读取。将新到账余额放到
  resources.gold，将产业的下一到期时间和账本条目放在同一个事务。余额使用绝对值。
- state_read(section="pendingHistory/ID") 读取迁移前保留的完整原文，
  state_read(section="pendingHistory") 可分页浏览。活动待办仍通过 pendingEvents 读取。
- runtime_execute 独立提交随机检定。科研验收以原始骰值裁决，随后在 event_commit
  的 runtimeReceipt 中引用服务端回执 id 和 hash。超时重试使用原检定幂等键。
