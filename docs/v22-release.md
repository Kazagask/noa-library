# V2.2 发布标识与源码映射

- Release：`2.2.0-incremental-core`
- 分支：`feature/v2.2-incremental-core`
- 权威提交：`feature/v2.2-incremental-core` 的 PR head（以 PR #4 当前 head 为准）。
- 源码清单：101 个文件（apps/sites、packages/core/edge/library/server、tests），SHA-256 `92c6e2854192824bcdcfeaeeb33e6be31af57119e600fbb403a60492a47fa35a`。此摘要不随发布说明文档变化，作为源码映射的长期稳定标识。

Worker 在 `initialize` 与工具响应中返回 release `2.2.0-incremental-core`。部署产物 SHA 需在 Sites 构建环境执行 `npm ci && node scripts/build.mjs` 后对 `dist/server/index.js` 计算；本环境未安装 apps/sites 依赖，故不宣称已取得托管构建产物 SHA。

正式部署前必须核对：Worker release、部署产物 SHA、提交 SHA 与源码清单摘要。三者不一致不得上线。
