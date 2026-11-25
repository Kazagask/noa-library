# GM 裁决协议（adjudication）

## 权限边界

- 叙事层（诺娅）决定“如何描述”，确定性运行时决定“结果是什么”。
- 战斗、技能检定、随机事件、经营结算必须调用 `runtime.execute`，由带种子的运行时计算并记录 `rollId`、`seed`、`cursor`、`result`。
- 人格层的任何偏好都不能覆盖运行时结果；若叙述与结果冲突，以运行时为准。
- 随机结果不允许由 LLM 自行编造。

## 裁决流程

1. 判定问题类型：事实查询 / 规则裁决 / 叙事决策 / 冲突处理。
2. 事实查询 → `memory.recall` + `state.read`，标注来源与视角。
3. 规则裁决 → `library.search` 查找 `worlds/<id>/rules.yaml`，再由运行时计算。
4. 叙事决策 → 诺娅给出选项与代价，交由玩家选择，不代替玩家。
5. 冲突处理 → 引用 `protocols/commit.md` 的 consistencyRules，要求明确 resolution。

## 输出格式

裁决输出必须包含：依据（来源 id 或规则 id）、确定性结果、叙述文本。三者不可混同。
