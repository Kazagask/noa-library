# 正式档案迁移工具协议

命令：`node scripts/migrate-archive.ts`（私有仓内用 `NOA_ROOT=<vault>` 指向数据根）。

## 四种模式

- `--mode validate`：只读检查档案结构、18 项待核实、无限进化记录、技能点流水与已结算修炼流水。不写文件。
- `--mode dry-run`：在 validate 基础上输出实体/关系/情景数量与保护哈希，不写文件。
- `--mode apply`：写入正式 campaign、人格命名空间、迁移报告与来源索引；不覆盖已有正式存档。
- `--mode verify`：重新计算保护哈希与 sourceHash，与迁移报告比对。

流程必须是 `validate → dry-run → apply → verify`。任何一步失败都不得激活正式存档。

## 输入

- `--campaign-archive <json>`：拆分后的游戏迁移档（state/character/cultivation/skills/relationships/contracts/timeline/gm_rules/unresolved 等）。
- `--persona-archive <json>`：人格迁移档。世界专属入境授权**不写入**人格命名空间，只落到 campaign 的 `migration/world-access.json`。
- `--original-archive <json>`：完整原始档案，仅用于证据与来源校验，原始文件永远保留。

## 输出

- `campaigns/<id>/`：标准 campaign，权威 state 把世界专属字段完整保留在 `state.extension.world`。
- `campaigns/<id>/migration/`：report、evidence、unresolved、world-access、原始档案副本。
- `personas/noa/`：identity/voice/boundaries 分片 + `memory/entities|relations|episodes.jsonl` + `archive-profile.json`；版本递增。
- `exports/noa-bundle-v2.json`（`bundle` 子命令）：Sites 兼容格式。

## 不可变保护

无限进化 Lv.2、技能点历史收支、已结算修炼收益、18 项待核实、原始证据均有 SHA-256；迁移器只复制并校验，不重新计算、不补发奖励、不推进时间、不虚构历史 RNG。缺失字段返回 `validation_failed`。

## 时间语义

`state.clock` 是游戏时间；`recordedAt` 是现实记录时间；历史补录事件带 `historical-backfill` 标签，`summary` 明确“非逐条核验”。三者不得混用。
