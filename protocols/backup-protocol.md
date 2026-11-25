# 双馆备份协议

默认权威源：Sites MCP（在线）。GitHub Vault：私有冷备份与应急运行。NAS：可选大资产存储，不在实时关键路径。

## 信封字段

`campaignId`、`worldlineId`、`stateRevision`、`memoryRevision`、`schemaVersion`、`checkpointId`、`parentHash`、`contentHash`、`assetRefs`、`authorityEpoch`、`mode`（full|incremental）。

## 工具

```bash
node scripts/backup.ts export-full --campaign <id> --epoch <n> --out <file>
node scripts/backup.ts export-inc --campaign <id> --state-revision <n> --memory-revision <n> --out <file>
node scripts/backup.ts verify --file <file>
node scripts/backup.ts diff --a <a> --b <b>
node scripts/backup.ts import --file <file> --epoch <n>
```

## 约束

- `contentHash` 覆盖整封；`verify` 不符即拒绝。
- `authorityEpoch` 单调递增；低于当前权威纪元、或与预期不符即拒绝。
- 增量导入需要基线，不会静默覆盖全量状态。
- 不默认双向同步；故障切换必须显式执行 import 并确认源。
- 资产只带引用与哈希，不带二进制。

Sites 端适配与部署任务见私有仓 `SITES-DEPLOY.md`；本仓库不声称已完成 Sites 部署。
