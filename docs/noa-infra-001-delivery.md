# NOA-INFRA-001 交付说明

## 已交付

- 审计：`docs/noa-infra-001-audit.md`
- ADR：`docs/noa-infra-001-adr.md`
- 本地启动/恢复手册：`docs/noa-infra-001-manual.md`
- LocalD1：`packages/local/d1-sqlite.ts`
- Local Host：`packages/local/host.ts`
- stdio MCP：`packages/local/stdio.ts`
- HTTP MCP：`packages/local/http.ts`
- CLI：`packages/local/cli.ts`
- 生命周期 smoke：`packages/local/smoke.ts`
- 一键门禁：`scripts/test-gate.mjs`
- Dockerfile

## 测试分层

- T0/T1：`tests/v21.test.ts`、`tests/storage-contract-local.test.ts`
- T2：`tests/v22*.test.ts`、`tests/v223.test.ts`
- T3：`tests/local-host.test.ts`、`tests/local-http.test.ts`、`packages/local/smoke.ts`
- T4：`tests/v223.test.ts` 中 archive/recall/graph/working/bootstrap/maxBytes/checkpoint/receipt/RNG/chunk 回归
- T5：未执行真实 D1；保留给 Sites/ChatGPT

## 当前缺陷映射

| 缺陷 | 本地状态 |
| --- | --- |
| P0-001 archive_export | 本地 10x 归档、分页、缓存、权威清单通过 |
| P1-001 中文召回 | 本地后部实体/属性召回测试通过 |
| P1-002 响应预算 | `state_read` fields + maxBytes 测试通过 |
| BLOCKED-001 R1550/R1552 | 本地 checkpoint 恢复业务字段比较通过；真实备份未上传，不能替代 |

## 质量门禁

`npm run test:gate` 输出 `reports/local-gate.json`，包含 commit、环境、Adapter、通过/失败数、命令与日志。当前：100/100 测试、MCP smoke PASS、build entry PASS、boundary PASS。

## 本地运行

```bash
node packages/local/cli.ts db:init
node packages/local/http.ts
node packages/local/stdio.ts
node packages/local/cli.ts test:smoke
```

## 必须由 Sites/ChatGPT 完成的剩余项

1. 真实 D1 限额与执行语义。
2. 真实托管认证与部署产物工具注册。
3. 真实 MCP 网络调用与真实存档 R1550/R1552 一致性。
4. 真实托管归档连续导出。
5. 独立 V3 实例设为唯一运行环境前的最终裁决。
