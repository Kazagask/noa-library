# V2.2.1 发布标识与源码映射

- Release：`2.2.1-akasha-state-core`
- 权威提交：`feature/v2.2.1-akasha-state-core` 的 PR head。
- 源码清单：101 个文件（apps/sites、packages/core/edge/akasha/library/server、tests），SHA-256 `58aa07d883fa203e3b0391d421ede6396028ba9f4d4b3f710fb32a5299f30525`。此摘要不随发布说明文档变化。

Worker 在 initialize 与工具响应中返回 release `2.2.1-akasha-state-core`。部署产物 SHA 需在 Sites 构建环境生成后与 PR head、源码清单摘要一起核对；本环境未安装 apps/sites 构建依赖，不宣称已取得托管构建产物 SHA。

正式部署前必须核对：Worker release、部署产物 SHA、PR head 与源码清单摘要。三者不一致不得上线。
