# W2：M07 搜索预算（以一次评测为单位的分级硬上限）

## 为什么

依据 RB-A5-21：任何运行都要有确定终止、崩溃可恢复、换模型后口径不漂移；预算以轮次计量而不是以钱计量
（用成本计量在换模型后会漂移），并配三级回退。依据 RB-A5-22：接受权归确定性引擎，失败与崩溃也占预算位，
否则 agent 会在难题上提前停止或无限重试。依据 RB-A5-12：预算要按进展出列，连续 w 次无提升即停（离线重放
省 19–43% token 并保留 ≥95% 的几何平均加速）。依据 RB-A5-26：昇腾单算子轮数上限不低于 15，第 8 轮之后
才首次达最佳的占 22/37，所以默认不能设小。依据 RB-A1-19 / RB-A5-06：autotune 的整体收益上限只有约 1.2×，
不应占超过约 20% 的预算，所以数值参数要有独立子预算。依据 RB-A1-04 / RB-A2-12：修复与优化分列预算，
修复不能无界。

改之前：工作区里唯一的 "budget" 是提示词字符上限（`src/improvement/policy.ts`），搜索侧没有任何计量或上限，
`executionLoop` 里的 maxRounds/deadlineAt 被静默丢弃，`loopStopReason` 的 budget-boundary 从未被赋值。

## 推翻的既有约定

AGENTS.md「Current implementation boundary」第一段写着：不要加任何总量、角色、阶段、分支、重试上限，
默认续跑不得因为固定轮数、重复提案或未变回合而终止。本次按依据推翻其中与**搜索预算**相关的部分：
- 新增按评测次数计的每任务上限与子预算，并在触顶时确定性拒绝继续评测；
- 停滞达到阈值时同样拒绝继续评测，要求回到规划。
保留的部分：仍然不设任何金额上限，费用仍只是观察量；上限作用在单个 M07 任务（一个计划），不是目标级停止，
目标的成功标准不变；模型仍然不能自行宣布完成或协商终止。对应 issue：W2-01。

## 改了哪里

- `src/m07/candidate-policy.ts`：`SearchBudgetPolicyV1`、`DEFAULT_SEARCH_BUDGET`、`validateSearchBudget`、
  `candidateBudgetLedger`（按任务统计评测、修复、优化、参数、拒绝与剩余额度，并复用停滞判据）、`requireBudget`。
- `src/types.ts`、`src/config.ts`：`research.config.json` 新增可选 `searchBudget`，走同一套校验。
- `src/m07/controller.ts`：`begin` 冻结 searchBudget；fork 时限制同一 checkpoint 的竞争分支数；
  episode 任务返回时若预算触顶记录 `loopStopReason = budget-boundary`。
- `src/m07/candidate-episode.ts`：评测前检查预算并在宿主开销前拒绝；每次反馈返回预算账本并写入 `episode.budget`。
- `docs/implementation/design.md`：新增预算段落。

## 验证

- 类型检查 0 错误。
- `test/m07-candidate-policy.test.ts` 新增 3 项：失败与前置拒绝同样计账、三类停止各自生效、配置校验拒绝非法值与未知字段。
- `test/m07-candidate-episode.test.ts` 新增 1 项端到端：预算 2 次时第三次评测在宿主之前被拒，任务返回且
  `loopStopReason = budget-boundary`、`episode.budget.stop = task-evaluation-budget`。
- 全量 `test/**` 通过。
