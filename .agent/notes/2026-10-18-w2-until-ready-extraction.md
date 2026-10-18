# W2：把 until-ready 轮次循环从 controller.delegate 抽出到 execution-loop.ts

## 为什么

`createM07Controller` 是一个约 1150 行的工厂闭包，其中 `delegate` 一个方法就有 463 行，
until-ready 的轮次循环（builder 轮 → 工作目录快照 → 全新 reviewer → verdict → 文件门）整段内嵌在里面，
嵌套达到 7 层。`execution-loop.ts` 名义上是执行循环模块，实际只有 41 行的 verdict 解析。
开发规范要求函数与模块单一职责、新机制放进独立模块；后续要给这条回路加轮次上限和执行信号约束，
不能继续往这个超长方法里加分支。本次是纯结构改动，不改变行为。

## 改了哪里

- `src/m07/execution-loop.ts`：新增 `runUntilReadyRounds(input)` 与其输入契约 `UntilReadyLoopInput`；
  把只服务于这条回路的 `snapshotRoundForReviewer`、`freezeBuilderReportForReviewer` 一并移入。
  控制器通过回调提供 save、知识与冻结输入复核、活动操作与 prompt 标记、以及 ready 的文件门校验。
- `src/m07/controller.ts`：`delegate` 中的 82 行内嵌循环替换为一次调用（约 11 行），
  `validateCandidateFiles` 仍留在控制器，因为最终 review 也用它。controller.ts 2103 → 2038 行，
  delegate 约 463 → 约 395 行，execution-loop.ts 41 → 194 行。

## 验证

- 类型检查 0 错误；`m07.test.ts`、`m07-execution-loop.test.ts`、`m07-candidate-episode.test.ts`、
  `m07-context-branches.test.ts` 共 33 项通过。行为未变，无新增测试。
