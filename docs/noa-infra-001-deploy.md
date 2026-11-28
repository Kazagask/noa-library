# NOA-INFRA-001 隔离 V3 实例部署指令

适用范围：仅部署独立的 SAVE-481 V3 实例。本指令不执行托管验收测试，不迁移、不写入、不切换旧正式 V2。验收与最终切换由 ChatGPT/NOA 在真实托管环境独立完成。

## 1. 先确认部署源码等于受测源码

在本地仓库根目录执行：

```bash
node scripts/test-gate.mjs
node -e "const r=require('./reports/local-gate.json'); console.log(JSON.stringify({commit:r.commit,localCommit:r.localCommit,testedTree:r.testedTree,checks:r.checks,tests:r.tests,worktreeDirty:r.worktreeDirty,rootSha256:require('./reports/source-manifest.json').rootSha256},null,2))"
```

门禁强制项：`checks.tests`、`checks.skipped`、`checks.worktreeClean`、`checks.commitMatch`、`checks.smoke`、`checks.build`、`checks.boundary`、`checks.typecheck` 全部为 `true`；`tests.skipped=0`；`worktreeDirty=false`；`commit === localCommit`。`NOA_GATE_COMMIT` 只能作为审计提示，设置不等于实际受测 commit 时门禁直接失败，不得用它冒充受测版本。

后续构建必须 checkout 上述 `commit`，不得使用工作区未提交改动。

## 2. 构建 Worker 产物

```bash
git checkout <reports/local-gate.json 的 commit>
cd apps/sites
npm ci
node scripts/build.mjs
test -s dist/server/index.js
```

产物：`apps/sites/dist/server/index.js`（由 `src/worker.js` 经 esbuild 打包，keep `node:crypto` external）。构建源码清单由 `node scripts/source-manifest.mjs` 生成，根哈希见 `reports/source-manifest.json`。

## 3. 准备隔离 D1

创建全新的、与旧正式 V2 完全独立的 D1 数据库，绑定名必须为 `DB`。在该空库上按顺序执行：

1. `apps/sites/drizzle/0000_vault.sql`
2. `apps/sites/drizzle/0001_shards.sql`
3. V3 与组件表（可从源码精确导出，不要手写）：

```bash
node --input-type=module -e "import {V3_SCHEMA_SQL} from './apps/sites/src/storage-v3.js'; import {COMPONENT_SCHEMA_SQL} from './apps/sites/src/state-core.js'; console.log([...V3_SCHEMA_SQL,...COMPONENT_SCHEMA_SQL].map(s=>s.replace(/\s+/g,' ').trim()+';').join('\n'))"
```

## 4. 部署与环境变量

上传 `apps/sites/dist/server/index.js` 到独立 Sites Worker，仅配置以下最小环境：

- D1 binding：`DB` → 第 3 步新建的隔离数据库。
- `NOA_REPAIR_OWNER`：隔离实例唯一所有者身份（必须与调用身份头一致）。
- `NOA_ALLOW_LEGACY_GOVERNANCE=0`。
- 保持 Sites 网关仅所有者可访问；MCP 身份通过 `oai-authenticated-user-id` 传递。

不配置旧 V2 的 D1 绑定、不配置旧 V2 的 owner、不启用 legacy governance、不设置 `NOA_MIGRATION_OWNER` 指向正式实例。

## 5. 导入 SAVE-481 V3 归档

通过 Worker 的 `archive_import` 工具导入权威 V3 归档（该工具是空库入口，且为特权工具，调用身份必须等于 `NOA_REPAIR_OWNER`）：

- 先核对归档 `format=noa-archive-v3`、`sha256`、分页数量与每页字节摘要。
- 只导入一次；重复导入必须命中幂等，不产生第二条权威记录。
- 导入后只做最小只读连通性检查（例如 `session_bootstrap` / `state_read`），不在托管环境跑验收脚本或业务写入。

## 6. 交付边界

- 本步骤完成后，隔离 V3 实例处于待验收状态；不执行真实托管验收、不做容量压测、不做蓝绿切换。
- 旧正式 V2 保持原样，不读写、不备份覆盖、不切流。
- ChatGPT/NOA 完成真实 D1 限额、认证、归档导出、R1550/R1552 备份一致性与 MCP 工具注册验收后，才决定是否将 V3 设为唯一游戏运行环境。
