# W2：按用户决定去掉搜索预算，恢复「不设上限」

## 用户决定（2026-10-19）

预算设定是无限的。本轮重构中新增的每任务搜索预算、子预算、类别预算与评审轮数上限全部撤回，
AGENTS.md 的控制策略段恢复 0cf09d3 原文。另：工作流保持泛用，不写死某个平台的结论。

## 删掉了什么

- `src/m07/candidate-policy.ts`：`SearchBudgetPolicyV1`、`DEFAULT_SEARCH_BUDGET`、`validateSearchBudget`、
  `SearchBudgetLedgerV1`、`SearchBudgetStop`、`candidateBudgetLedger`、`requireBudget`、
  `OperatorCategoryBudgetV1`、`DEFAULT_CATEGORY_BUDGETS`、`operatorCategoryBudget` 全部删除。
  `OPERATOR_CATEGORIES` 保留为纯轨迹记录（不带预算或准入含义）。
- `src/types.ts`、`src/config.ts`：删 `HarnessConfig.searchBudget`；episode 边界重启的节奏改成独立的
  `episodeRestart.evaluations`（默认 8，0 关闭）——它只决定何时清空上下文，不限制做多少工作。
- `src/m07/types.ts`：删 `CurrentGoal.searchBudget`、`M07CandidateEpisodeV1.budget`、
  `subjectProfile.categoryJustification`；`executionLoop` 恢复 0cf09d3 的形态（历史 `{maxRounds, deadlineAt}`
  只解码供审计，规范化时丢弃）。
- `src/m07/controller.ts`：删 begin 时冻结 searchBudget、类别准入门、分支数上限、
  `loopStopReason = budget-boundary`、以及 until-ready 的上限传递。
- `src/m07/execution-loop.ts`：恢复无界的 until-ready 轮次循环（只由 reviewer 终态或真实阻断结束）。
- `src/m07/candidate-episode.ts`：删评测前的预算检查与 `budget` 搜索事件；
  `src/m07/feedback.ts`：搜索账本去掉预算用量与停止原因，保留覆盖面/幅度/停滞，并标明次数是观察不是上限。
- 控制台：`terminal-console/src/console/{audit,model,read-model}.ts` 去掉 searchBudget 聚合与展示。
- 剩余墙钟暴露：删 `SessionSpec.runDeadline`、`remainingWallClockNote`、`runDeadlineFromEnvironment`
  与 pi.ts 里的注入和回执字段，以及 M07 两处注入点。
- 文档与提示词：design.md 的预算段落删除；P07 恢复原句「工具不会自动缩小目标或规定搜索轮数。」，
  类别一句改为纯记录；按 `test/workflow-manifest.test.ts` 口径同步 `文件清单.md` 与 `提示词全集.md`。
- AGENTS.md 控制策略段恢复 0cf09d3 原文（不设任何上限、不按轮数停止）。

## 保留

确定性判决（guard/score/lane/相位）、三级准入状态与分支决策、宿主判定消费、停滞检测与强制换向
（只换方向，不终止）、受约束动作空间与决策表方法菜单、episode 边界重启、CLI 保护对等。
路线阈值（修复深度、停滞计数）只决定下一步方向，不结束任务，也不再带任何平台的数值；
噪声余量 `DEFAULT_NOISE_MARGIN` 明确为中立占位值，宿主判定存在时整体让位给宿主。

## 一个直接后果

episode 边界重启循环原来靠预算触顶收尾；预算去掉后，它的结束条件就是「某一轮新增候选少于设定的节奏」，
也就是执行会话自己停止评测。没有任何轮数或花费会结束它——这正是「预算无限」的含义，
控制器注释与 design.md 都写明了这一点。原先依赖预算收尾的那条测试改为由假执行者在四次评测后停止评测。

## 验证

类型检查 0 错误；受影响测试（policy、execution-loop、failure-class、console-audit）36 项通过；
整词 grep `(cann|ascend|ascendc|npu)|昇腾` 在 candidate-policy、其测试、P00–P03/P07 与 design.md 中无残留。
