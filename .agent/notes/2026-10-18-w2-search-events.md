# W2：控制器补写 verdict / stall / budget / episode-restarted 四类搜索事件

## 为什么

W4 新增了 `src/m07/search-state/` 的追加式事件日志，候选执行事件（submitted / stage / evaluated）已经接上，
但判决、停滞、预算与边界重启四类只有控制器知道。控制台的判决视图与停滞视图据此渲染；
依据 G1-44「执行树必须展示判决与证据，而不只是日志流」与 RB-A5-19「停滞是执行树最该暴露的状态」。

## 改了哪里

- `src/m07/candidate-episode.ts`：接受 `searchEventLogFile`，每次评测后按序补写
  - `verdict`：guard 决定、候选事实（id、父代、工作对象、分数、是否失败、冻结观测路径、宿主阶段、准入状态）、
    理由首句，detail 里带 lane、相位、tier、是否推进最佳、本轮注入相位，以及宿主判定的 faster/slower/tie/excluded 计数；
  - `stall`：仅在强制换向时写，counters 给停滞计数、修复深度与禁令条数，detail 给路线与信号；
  - `budget`：每次评测后写，counters 给已用/剩余/修复/优化/参数/拒绝与类别上限，detail 给停止原因与类别。
  写入失败不影响评测结果（事件日志是观测，不是判定）。
- `src/m07/controller.ts`：两处 episode 工具创建点传入日志路径；边界重启处补写 `episode-restarted`
  （轮次、蒸馏计数、记录路径、前后会话 ID、已验证最佳）。

## 验证

- 类型检查 0 错误；新增一项端到端测试：四次评测跨一次边界重启后，日志里 verdict 与 budget 各四条、
  episode-restarted 一条，verdict 的判决序列与候选记录逐一相等，budget 末条带类别与已用次数，
  restart 事件的记录路径与 `episode.restarts[0]` 一致。
- `m07-candidate-episode` 23 项、`m07-search-state`、`m07-search-warm-start` 通过。
