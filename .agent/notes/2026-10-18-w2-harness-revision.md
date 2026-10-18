# W2：本地 mission 的 harness 版本改为单一来源

## 为什么

依据 RB-A13-07（P0，多篇消融）：harness 本身必须版本化冻结并作为实验变量记录；同一模型换 harness
分数最多变 Δ=0.43 且排名不传递。本地 mission 路径把 `codeRevision` 写死成字面量 `"local-harness-v1"`（五处），
于是不同时间、不同代码跑出来的记录在账本里看起来是同一个 harness，数字会被当成可比。
M07 主路径已经按「已验证的 loaded source commit → 显式配置 → unrecorded」取值（controller.ts）。
（由 W5 在审查中发现并移交：issues/W5-06。）

## 改了哪里

- 新增 `src/m07/harness-revision.ts`：`harnessCodeRevision()` 与主路径同规则取值，非法值回落为 `unrecorded`
  而不是悄悄变成另一个可比版本；`LEGACY_LOCAL_HARNESS_REVISION` 只用于识别旧记录。
- `src/m07/local-mission.ts`（三处）、`src/m07/local-interrupted-reconcile.ts`（新 attempt 一处）改为动态取值；
  reconcile 对旧记录的 legacy 判定改用具名常量。

## 验证

- 类型检查 0 错误；`local-mission-workflow`、`local-mission-cli`、`local-interrupted-reconcile` 全部通过。
- 新增一项测试：配置值被采用、非法值回落 unrecorded、无配置为 unrecorded、旧常量仍可识别。
