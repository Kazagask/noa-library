# 可复现源码清单规范

脚本：`scripts/source-manifest.mjs`，Sites 与 W 必须使用同一版本脚本。

- 范围：`apps/sites/src`、`apps/sites/test`、`packages/{core,edge,akasha,library,server}`、`tests`、`scripts`。
- 遍历：递归读取普通文件，排除 `node_modules`、`.git`。
- 路径：统一 `/`，按 UTF-8 字节序排序。
- 编码：UTF-8；读取后 CRLF/CR 统一为 LF。
- 文件哈希：`SHA-256(规范化内容字节)`。
- 根哈希：对 `path + "\0" + fileSha256 + "\0" + bytes + "\n"` 按路径排序连接后取 `SHA-256`。
- 输出：`reports/source-manifest.json`，包含算法、范围、路径顺序、编码、换行、每个文件哈希、根哈希。

当前清单：110 个文件，根 SHA-256 `6f5bb77be1c2fd809b8d6b944a81ca556d599b99fbc9f03fe0b54e3f81e38bb3`。重复运行结果完全一致。
