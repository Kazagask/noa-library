# V2.2.1 剩余缺陷与验收边界

1. **托管 D1 验收未执行**：当前结果来自 SQLite/D1 兼容环境，不能替代 Sites 托管 D1 的事务限制、rows_read/rows_written 和性能验证。
2. **规则 VM 未实现**：本轮只提供 StateReader/Effect/TransactionPlan/SchemaRegistry/ExecutionContext 契约与存储侧能力；未实现动态规则语言、AST 解释器、eval、沙箱、Hook 调度或行动编排。
3. **部分旧接口仍可能读取 V2 兼容分片**：archive_export、repair、formal 等治理/迁移工具仍面向完整文档；常规权威读取已走 V3。
4. **D1 物理指标不可直接获取**：统计接口返回逻辑记录数/字节数；page_count、freelist 等需托管宿主注入。
5. **生产数据与生产部署未触碰**：迁移只做了隔离演练设计，未对正式存档写入。

生产上线需先完成托管 D1 验收。
