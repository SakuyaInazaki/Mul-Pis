# W2：把任务的截止时间接到会话的 runDeadline 上

## 为什么

W4 在 `SessionSpec` 上加了可选的 `runDeadline`（ISO 时间）：它只作为剩余墙钟的观测事实注入**工具返回值**，
不进提示词前缀，也不构成停止条件（`src/runner/pi.ts` 的 `remainingWallClockNote`）。
依据 RB-A5-22 的注意事项：超时零分是零分最大来源之一，必须在工具返回值里暴露剩余 wall-clock 并强制定期保存
当前最优可提交版本。M07 这边已经有任务级 `executionLoop.deadlineAt`（本轮之前只用于停止轮次），但没有传给会话，
于是执行会话看不到自己正在对着哪个墙钟工作。

## 改了哪里

- `src/m07/controller.ts`：execute/check/reason 任务的会话 spec 在有 `executionLoop.deadlineAt` 时设置 `runDeadline`。
- `src/m07/execution-loop.ts`：until-ready 的每轮 reviewer 会话沿用同一截止时间，避免评审跑过 builder 的时限。
- 没有截止时间时不编造一个。

## 验证

- 类型检查 0 错误；新增一项测试：带 deadlineAt 的任务里 builder 与 reviewer 两类会话的 `runDeadline` 都等于该时间，
  不带时为 undefined。`m07-execution-loop` 9 项通过。
