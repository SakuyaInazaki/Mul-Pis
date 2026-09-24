# 2026-09-21 M07 goal 20260921T080457Z-068a：T008 orphan 处置与 T009 路线（主 Pi）

## 变更批次

- 只读恢复与研究判断；未改动工作流文件、未改动评测器、未向平台写入除既有授权提交以外的动作。
- 新增文件：`stages/M07/20260921T080457Z-068a/t009-brief.md`（T009 输入简报）、本记录。

## T008（orphan）真实状态

- `stages/M07/20260921T080457Z-068a/tasks/T008`：`status=running`、`returnedAt=""`、无 `report.md`、
  无 `ledger.csv`；其会话在返回前中断（跨进程 orphan）。本版 harness 的 `review` 只接受
  `returned` 状态，`interrupt` 会把目标关闭为 blocked——用户明确要求达标前不得收口，
  因此 **T008 保持 running，不伪造报告、不评审、不重跑同候选**。
- T008 已产生的真实平台动作（从 `work/raw/` 脱敏 payload 逐字读出）：
  - 提交：**SID 147588**，language `cuda-h20`，`progress.compile.success=true`，`meta.status=TimeLimitExceeded`，
    `meta.displayScore=0`，`meta.timeUsed=0`，`testcaseResult.time=25361613 µs`，`memory=1019668`，
    `timeLimit=15000 ms`，`totalOccupiedTime=26802 ms`。
  - `userOutput` 只有 `OJCHAL v1 9TKobayt7whlwh+LcwyDug==`；`userError` 只有 torch profiler 警告
    + `Running kernel, warmup=8, iters=155, testdata_groups=8`；**没有 `[CUTLASS] …` 诊断打印**。
  - 判读（本地派生）：25.4 s 与 `candidates/cutlass-nut.cu` 的 `naive_gemm_nt_kernel`（B 侧未合并访存）
    量级一致 ⇒ 实际执行的是 naive 回退；CUTLASS 路径未执行；**CUTLASS 头文件是否存在仍未知**。
  - 未执行/未取得：cuda-multi CT 探针、post-credit/post-pool 水位、ledger、report、静态/凭据检查。
- 资源消耗：turnstile 池 `submit_problem` 令牌 1 枚（T008 pre 水位 `{submit_problem:6, custom_test:1}`，
  取走 2345 → 本次恢复时平台侧池统计「取走 2347」）；`api_token` 未消耗（9/10 未动）。

## 路线结论（作为 T009 的输入）

- **厂商库路线闭合**：baseline `tb` 即 torch/cuBLAS 类内核（实测 121.6–136.6 TFLOPS = 82–92% 峰值），
  本工作区 tk 侧 133–141.5（94–95%）。库路线最多回到 50 分锚点档，不可能把 68.6 推到 70.6。
- **低精度路线闭合**：T007 真实 CT 已用平台 checker 否证 int8（`max_abs_diff=2.0` vs `rtol=0.01, atol=0.001`）。
- **剩余唯一路线**：主循环效率再提 0.5–1%（ds 灵敏度 −275…−472 /ms），首选尚未实测的
  plain-triton host 侧 TMA descriptor + `tl.range(warp_specialize=True)` + persistent 路径（R1），
  以及未测过的结构量（BK=128/256、深流水、per-shape 栅格化）（R2）。

## 目标状态

- goal 保持 `active`；`displayScore > 70.6` 未达成；M08/M09 未开始。
- 下一动作：委派 T009（execute）执行 R1/R2 实测并做真实 5 点正式提交验证。
