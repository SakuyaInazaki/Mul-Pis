# W2：搜索层改为消费宿主判定（W1-04）

## 为什么

合并后，本地算子宿主在回执里给出的已经是**判定**而不只是数字：逐用例逐 baseline 的
`decisions[name] = { tier, verdict, pairedRatioMedian, minimumImprovementThreshold, endToEndAdmissible?, confirmed? }`，
门槛 `1 + max(0.002, 0.85·cv)` 随实测离散度自适应，另有 `performanceDecidable`、`orderingStability`、
`aggregate` 与 `measurementNotComparable`。但这些只到达 `limitations` 文本，候选取舍仍在搜索层按 metric 数值比较做。

依据 RB-A4-12（ε=0.002、k=0.85 的噪声门槛）、RB-A4-13（差距小于噪声阈值必须判并列；64 agent 共享时十对里六对翻转）、
RB-A4-14（比率用几何平均/中位，失败计入；成功样本 1.76× 对全集 0.96×）、RB-A4-10（端到端过不了就保留基线）、
RB-A3-01（ACCEPT 不更新 best）。按数值小数点取优会同时犯「按噪声取舍」和「把没变慢写成变快」两个错。

## 改了哪里

- `src/m07/types.ts`：新增 `CandidatePerformanceVerdictV1` 与 `CandidateAggregateV1`；
  `CandidateCaseObservationV1` 增加 scope、performanceDecidable、performanceUndecidableReason、verdicts、orderingStability；
  `CandidateExternalEvaluationV1` 增加 aggregate 与 measurementNotComparable。判定形状从宿主实现提升为跨模块契约。
- `src/m07/local-operator-backend.ts`（W1 拥有，最小改动）：把回执里已有的 decisions / 可裁决性 / 排序稳定性 /
  aggregate / 不可比原因原样带进观测，不做任何重新聚合。
- `src/m07/candidate-policy.ts`：新增 `hostVerdictSummary()`；`decideCandidate` 在宿主有判定时按判定决定 guard：
  slower → revert；端到端不予准入 → accept（保留基线，不推进 best）；faster → keep；tie 或无可裁决 → accept。
  quarantined、未确认复测、`performanceDecidable === false` 一律单列为 excluded，不参与取舍。
  宿主有判定时不再做 metric 比较（`incumbentComparison` 置空），没有判定的宿主仍走原来的噪声余量比较。

## 验证

- 类型检查 0 错误；`m07-candidate-policy` 20 项、`m07-candidate-episode`/`m07-local-operator-backend`/
  `m07-candidate-verification` 35 项通过。
- 新增两项测试：判定压过漂亮的中位数（tie→accept、faster→keep、slower→revert）；
  quarantined / 未确认 / 不可裁决 / 端到端不予准入 / 不可比原因都不能选出候选。
