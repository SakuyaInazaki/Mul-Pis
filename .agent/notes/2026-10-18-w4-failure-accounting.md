# 2026-10-18 W4：基础设施失败与策略失败分账，剩余墙钟进工具返回值，harness 版本随会话落盘

## 为什么

- RB-A10-09（P0）：只有封闭清单内的错误才重试；仍无结论的标 `unjudged`，不进候选排名也不进反馈；
  harness 失败与模型失败在报表里必须分列。依据还点名了一个具体数据：人工检查 302 条零分轨迹后发现
  **超时零分是零分最大来源之一**，对策是**在工具返回值里**暴露剩余 wall-clock，并要求定期保存可提交版本；
  剩余预算放进 prompt 前缀会破坏前缀缓存（RB-A10-05）。
- RB-A10-14（P0）：harness 必须版本化冻结并**作为实验变量记录**。同一模型换 harness 分数最多变化 Δ=0.43
  且排名不传递，不记录就无法归因。
- G8-20：失败反馈要能定位到程序决策，机械压缩与路由可以，语义改写不行。

改动前：分账的原料齐全（`TransportFailureDiagnostic`、managed bash 回执里的 `processExit`、
`operation-disposition`），但没有统一的判定，`unjudged` 这一类根本不存在；剩余时间只在控制器内部
（`m07/types.ts` 的 `deadlineAt`），模型完全看不到；harness 版本只在运行描述符里，不随会话结果落盘。

## 改了哪里

- 新增 `src/runner/failure-class.ts`：
  - `classifyToolFailure` / `classifyTransportFailure` 给出 `infrastructure | policy | unjudged` 三分类、
    短稳定的 reason 和 retryable。**基础设施清单是封闭的**：超时、连接类 errno、设备租约、沙箱故障、
    provider 5xx 与限流、传输中断；命令真的跑完并返回非零退出码算候选自己的结果；被信号杀死、未知 errno、
    无法归因的 provider 失败一律 `unjudged`，不自动重试也不记成策略失败。
  - 平台档案若把输出判成 `infrastructure`，优先按基础设施算（这是依据里「环境故障不要让 agent 去改正确代码」
    的那一条）。
  - `tallyFailures` 额外给出 `unjudgedShare`，依据要求把它当 harness 健康指标展示。
  - `remainingWallClockNote` 渲染「还剩 1h30m / 请保证最优版本已保存可提交」；截止之后改成「停止优化、
    确保已保存」。`runDeadlineFromEnvironment` 读宿主的 `PRE_RSI_RUN_DEADLINE`（ISO 时间，非法即报错）。
- `src/runner/types.ts`：`ToolCallRecord` 与 `TransportFailureDiagnostic` 各加 `failureClass`/`failureReason`；
  `SessionSpec` 加 `runDeadline`。
- `src/runner/pi.ts`：
  - 每个执行工具结果末尾追加剩余墙钟（前缀不动，缓存不失效）；
  - 工具失败（返回 isError 或抛出）都走分类，结果进 `toolLog`；
  - bash 抛错时 Pi 把命令输出带在错误消息里，于是失败路径也跑平台机械解读，把分类与「最接近的合法签名」
    追加在原文之后——失败那一轮恰恰是路由最有价值的时候；
  - `TransportProbe.failure()` 直接带上分类结果；
  - 每个持久化会话旁写 `<session>.harness.json`：代码修订、源码根、模型、工具授权种类、压缩阈值、
    平台档案 ID、运行截止时间。

## 验证

- `tsc --noEmit` 0 错误。
- 新增 `test/runner/failure-class.test.ts`（5 项）与 `test/runner/platform-execution.test.ts` 的两项新用例，
  覆盖：三分类与封闭清单、未知一律 unjudged、provider 失败分账、unjudgedShare、剩余墙钟渲染、
  真实工具层上「非零退出=策略失败 / 输出里的设备故障=基础设施失败 / 契约驳回=策略失败」、
  以及 harness 回执字段。
- 全量测试 467 项：463 通过、0 失败、4 跳过（仅 Linux）。

## 边界

- 分类只提供判定与记录，**不自动重试**：重试策略属于控制器，依据也要求 fail-closed。
- `unjudged` 不是「没事」：它应当被展示和计数，比例升高说明 harness 本身有问题。
- 剩余墙钟只在执行会话的工具返回值里出现；阅读类会话不加这一行。
