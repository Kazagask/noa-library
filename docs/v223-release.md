# V2.2.3 发布标识与源码映射

- Release：`2.2.3-authority-closure`
- 权威提交：`feature/v2.2.3-authority-closure` 的 PR head。
- 源码清单：110 个文件，根 SHA-256 `6f5bb77be1c2fd809b8d6b944a81ca556d599b99fbc9f03fe0b54e3f81e38bb3`。
- 清单脚本：`scripts/source-manifest.mjs`；规范见 `docs/v223-source-manifest.md`。

正式部署前必须用同一脚本在 Sites 与 W 分别生成清单，根哈希必须完全一致；未取得托管构建产物 SHA 与 Sites 复测前不得上线。
