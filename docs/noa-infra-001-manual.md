# NOA-INFRA-001 本地启动、备份与恢复

## 启动

```bash
node packages/local/cli.ts db:init
node packages/local/http.ts
```

默认 MCP：`http://127.0.0.1:8787/mcp`，本地 Bearer：`local-dev-token`（`NOA_LOCAL_TOKEN` 可覆盖）。DB：`deploy/data/local.sqlite`（`NOA_DB_PATH` 可覆盖）。

## stdio MCP

```bash
NOA_DB_PATH=deploy/data/local.sqlite node packages/local/stdio.ts
```

stdin/stdout 每行一条 JSON-RPC；与生产 Worker 共用工具定义及业务路径。

## 备份

```bash
node packages/local/cli.ts archive:export --out local-archive.json
```

归档包含权威清单、分页哈希与总 SHA-256；禁止只依赖单页成功。

## 恢复

```bash
NOA_IMPORT_DB=deploy/data/restored.sqlite \
node packages/local/cli.ts archive:import --file local-archive.json
```

恢复后启动：

```bash
NOA_DB_PATH=deploy/data/restored.sqlite node packages/local/http.ts
```

## 冒烟/门禁

```bash
node packages/local/cli.ts test:smoke
npm run test:gate
```

`test:smoke` 使用独立 stdio MCP 客户端，覆盖启动、bootstrap、召回、图谱、checkpoint、RNG、事件、回执、幂等、重启、恢复、归档、空库导入与继续读取。

## Docker

```bash
docker build -t noa-local .
docker run --rm -p 8787:8787 -v "$PWD/deploy/data:/app/deploy/data" noa-local
```

## 边界

- 不连接 Sites / 真实 D1 / 生产认证。
- SQLite 适配器只模拟 D1 的 `prepare/bind/all/first/run/batch` 契约，不提供跨 batch 交互式事务。
- 真实 D1 限额、托管认证和部署产物仍由 Sites/ChatGPT 验收。
