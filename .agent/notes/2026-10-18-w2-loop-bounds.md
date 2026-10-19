# W2：until-ready 回路的硬上限，以及绑定核验器后不再走 reviewer 门

## 为什么

依据 RB-A2-12 / RB-A5-21：修复与评审回路不能无界，必须「调试 ≤3 → 同一计划下重写 ≤5 → 回到规划」，
任何运行都要有确定终止；预算以轮次计量并写进持久记录。依据 RB-A2-08 / RB-A5-22：接受/拒绝的判定权
归确定性引擎，agent（包括另一个模型扮演的 reviewer）不能宣布完成；完整性门禁实测驳回了工作流自己接受的
12.5%–33.3%。依据 RB-A1-01：阶段要以真实执行信号收尾，纯文本评审轮拿不到执行信号。

改之前：until-ready 是 `for (let index = 1; ; index++)` 的无界循环；调用方传的 `executionLoop.maxRounds`
与 `deadlineAt` 在 `controller.delegate` 里被静默丢弃（只留 mode），`loopStopReason` 的 `max-rounds`、
`deadline`、`budget-boundary` 三个取值从未被赋值。绑定宿主核验器时，service 只是把默认模式设成 candidate-episode，
调用方显式传 until-ready 仍然能用模型 reviewer 当验收门。

## 推翻的既有约定

同 `.agent/notes/2026-10-18-w2-search-budget.md`：AGENTS.md「不设任何上限、不按轮数停止」。
这里按依据给 until-ready 回路加轮次与截止时间上限，触顶时任务交回规划层（不是目标停止，目标的成功标准不变）。
对应 issue：W2-01。

## 改了哪里

- `src/m07/types.ts`：`executionLoop` 的规范形态变成 `{ mode, maxRounds?, deadlineAt? }`，旧的两字段形态仍可接受。
- `src/m07/controller.ts`：不再丢弃上限；绑定核验器时拒绝 execute 任务使用 until-ready；
  把上限与截止时间传给循环，缺省取冻结的 `searchBudget.reviewRoundsPerTask`。
- `src/m07/execution-loop.ts`：每轮发出前检查上限与截止时间，记录 `max-rounds` / `deadline` 并正常收尾。
- `src/m07/candidate-policy.ts`：`searchBudget` 新增 `reviewRoundsPerTask`（默认 12）。
- `docs/implementation/design.md`：补充这两条。

## 验证

- 类型检查 0 错误。
- 新增测试：maxRounds=2 时 builder 恰好被提示两次且 `loopStopReason = max-rounds`；
  过期 deadline 在发出任何一轮之前停止；绑定核验器时 until-ready 被拒。
- `m07-execution-loop`、`m07-candidate-episode`、`pi-extension`、`pi-noninteractive`、`pi-continuation` 全部通过。
