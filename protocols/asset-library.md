# Asset Library 协议

资产是一等记忆节点，二进制与结构化存档分离。存档/人格只保存 assetId 或 AssetRef，不在 state、快照或普通工具响应里嵌入 Base64。

## 逻辑工具

- `asset.register`：注册已有内容哈希的元数据。
- `asset.upload`：导入二进制；计算 SHA-256；重复哈希去重；响应只含 assetId、sha256、integrity。
- `asset.resolve`：按 viewer 与链接 knownBy 授权，返回受控 URI/存储键，不返回内容。
- `asset.search`：按角色/事件节点、标签、类型、文本检索。
- `asset.link`：建立资产与图谱节点的关系（身份档案、原始证据、重逢经历等）。
- `asset.revise`：修订元数据；不允许改 sha256 与 storage。
- `asset.gc`：默认 dry-run；只清理无引用且无链接的资产。

## 存储

对象按 `sha256` 前两位分目录，内容寻址。适配器接口 `AssetAdapter` 有 filesystem、github、object-storage 三种实现；后者用可配置 HTTP 端点，不绑定厂商 SDK。私有资产根在私有仓 `assets/`，原始证据不可被衍生资产覆盖。

CLI：`node scripts/asset.ts import-embedded --archive <json> --path <dot.path> --source <来源> --node <nodeId> --predicate <关系> --known-by <id,id>`。
