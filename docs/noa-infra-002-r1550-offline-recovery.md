# NOA-INFRA-002 · R1550 大归档离线恢复与分批初始化

目标：在完全离线的本地环境把 R1550 V2 备份恢复到 SAVE-481 V3，生成可分批导入的 D1 初始化产物，并在本地 D1 Runtime 中验证恢复后可继续运行。不访问旧线上实例，不重写 V3 内核，不增加在线迁移需求。

## 1. 来源与边界

- 原始备份：NAS `~/tmp/noa-library-backup.json.gz`（12,480,238 bytes），SHA-256 `bb760fd27cebf94fd2de892f1ef9bafe49baba827965a8920e0f7ec86bd58db9`。
- 只读副本：`backups/R1550/noa-library-backup.json.gz`（同哈希）与解压后的 `backups/R1550/noa-library-backup.json`（43,000,378 bytes，SHA-256 `80babb0ba6e5cab6166558c7dc1120791477a557f0508dda2b2b104823eb36f3`），两者已设为只读。
- 备份格式：`noa-sites-v2`，`storageVersion=1559`，`sourceVersion=99`，活动档 `SAVE-481 / wl-main`。
- 全程未连接 Sites / 生产 D1；恢复、迁移、校验均在本地 SQLite/D1 Runtime 完成。

## 2. 一键本地流程

```bash
npm run recover:r1550 -- \
  --backup backups/R1550/noa-library-backup.json \
  --out deploy/data/r1550-recovery \
  --owner save481-recovery
```

该命令依次执行 `restore → smoke → artifacts → load --smoke`，任一校验失败即非零退出。也可单独执行：

```bash
node scripts/noa-infra-002.mjs restore --force
node scripts/noa-infra-002.mjs smoke
node scripts/noa-infra-002.mjs artifacts --force
node scripts/noa-infra-002.mjs load --force --smoke
```

产物目录：`deploy/data/r1550-recovery/`

- `clean.sqlite`：未经测试写入污染的纯净恢复库。
- `restore-report.json`、`smoke-report.json`、`load-report.json`：全流程证据。
- `manifest.json`：分批导入清单、所有者映射、分片大小、顺序、激活条件、业务哈希与逐表哈希。
- `sql/000_schema.sql`、`sql/data-000.sql … data-109.sql`、`sql/zzz_activate.sql`。

## 3. 所有者映射与分片规则

- R1550 V2 归档本身不绑定 owner；目标 owner 由 `--owner` 显式指定，本次为 `save481-recovery`。
- Sites 实例必须把 `NOA_REPAIR_OWNER` 设为同一值；所有 `owner_id` 均按该值写入。
- 分片大小：900,000 bytes/批（`--shard-bytes` 可调），低于 Worker 1,950,000 bytes 请求上限；本次 110 个数据批，最大批 899,974 bytes。
- 顺序：`000_schema.sql` → `data-000.sql` … `data-109.sql`（按文件名升序）；`zzz_activate.sql` 不属于初始化顺序，仅在验收通过后单独执行。
- 迁移实现直接复用现有 `promoteVault` 与 `promoteV3AndActivate`；未新增迁移业务逻辑。

## 4. Sites 恢复步骤

1. 准备全新的隔离 D1 数据库并绑定为 `DB`，配置 `NOA_REPAIR_OWNER=save481-recovery`、`NOA_ALLOW_LEGACY_GOVERNANCE=0`。
2. 按 `manifest.json` 的 `order` 顺序执行 SQL 文件；每批执行前按 `manifest.json` 中的 `sha256` 校验文件，任一失败立即停止。
3. 执行只读核验：

```sql
SELECT migration FROM noa_v3_head WHERE owner_id='save481-recovery';
SELECT target,frozen FROM noa_authority_pointer WHERE owner_id='save481-recovery';
SELECT revision,rng_cursor FROM noa_v3_revision
  WHERE owner_id='save481-recovery' AND campaign_id='SAVE-481' AND worldline_id='wl-main';
SELECT count(*) FROM noa_v3_event WHERE owner_id='save481-recovery';
SELECT count(*) FROM noa_v3_tx WHERE owner_id='save481-recovery';
SELECT count(*) FROM noa_v3_checkpoint WHERE owner_id='save481-recovery';
SELECT count(*) FROM noa_v3_rng WHERE owner_id='save481-recovery';
```

4. 核对 `migration.status=complete`、`authority_pointer=(v3, frozen=1)`、`revision=1550`、`rng_cursor=657`，并把逐表行数/哈希与 `manifest.evidence.tableHashes` 对齐。
5. 只有 ChatGPT/NOA 完成真实托管验收后，才执行 `sql/zzz_activate.sql` 解除冻结；此前禁止任何业务写入。

本地复核命令：

```bash
node scripts/noa-infra-002.mjs load --artifact deploy/data/r1550-recovery --db deploy/data/r1550-recovery/verify.sqlite --force --smoke
```

## 5. 完整性证据

| 项目 | 结果 |
| --- | --- |
| 源 revision | 1550 |
| RNG cursor / seed | 657 / 1581654255 |
| 记录数 | events 2234、receipts 1559、checkpoints 9、entities 20、relations 48、episodes 618、rng 657、operations 657、campaigns 2、worldlines 2 |
| 文档哈希 | `fc51d269b24dfbfc5a4f838dad8f847b48b896c8bf828e62f82ed982114e1f46` |
| 业务领域哈希 | `897aeeb4a985402cacfe2867ced8cfef3f1b93c43d56cb0b96c831d6b19cdf64` |
| State / Working 哈希 | `52e1def27d85d27624a1c522cf5ea2b5ef1b351e62aea88b218e432ce27eb6b5` / `68bea2b6ac3a3d7e22bc803f1e967dbe5c2f4cba3fd7bd4660cc43b7464be654` |
| Events / Receipts / Checkpoints 哈希 | `8dcade82e8cdee08c530c0c470c739a50a884475919ebcb43dc8a5f562d83492` / `030beb0d43bfd9735d8e96456c979bed03e07b3112143dbfe03f6088e38679cb` / `30be8108b65e4f65a32b0e7b61eea9bdd8c7e1bb91684c3c57182de1ee0c8699` |
| Persona / Graph 哈希 | `912263ac45c2b50c7a006f237a4cae52605a10db295be827fb2b73a6de8ec608` / `b8b8f879082817d4f7d0cf28ac50336aca056b3e7e2153b857d130886be4758a` |
| 本地恢复校验 | 23/23 PASS（restore-report.json） |
| 本地 D1 Runtime 加载校验 | 44/44 PASS，含 32 张表逐表哈希/行数一致（load-report.json） |
| 真实 MCP 冒烟 | 独立副本 revision 1550→1551，回执 hit；纯净库哈希不变（smoke-report.json / load-report.json） |

## 6. 协议取舍与边界

- 本次采用分批 SQL 初始化产物；已满足“支持分批导入”，因此**未实现**分片 `archive_import` 协议。若 Sites 确认无法安全执行上述 ≤900KB SQL 批次，再按授权补最小化协议。
- 本地 Runtime 的写入冒烟只作用于 `smoke.sqlite` / `runtime.sqlite` 副本；`clean.sqlite` 与 SQL 产物在生成前后哈希一致。
- 不执行托管验收，不操作旧正式 V2，不做在线迁移；验收通过后的最终切流由 ChatGPT/NOA 决定。
