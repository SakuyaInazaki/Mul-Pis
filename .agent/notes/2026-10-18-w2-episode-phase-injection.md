# W2：候选 episode 每轮按相位装配知识（W3-06）

## 为什么

依据 RB-A6-08（P0）：阶段差异化装配把单算子可行率从 40%（仅 L0）抬到 90%，prompt 从约 800 token 降到不足 100；
**变异阶段给范例会导致结构漂移**。依据 RB-A6-07（P0）：检索键用瓶颈症状 + 结构签名 + 已做过的优化。
合并后普通任务委派的初始包已经按 `INJECTION_PLANS.bootstrap` 取界，但热循环——轮数最多、注入收益最大的地方——
每轮看到的知识与阶段无关。

## 改了哪里

- `src/m07/candidate-episode.ts`：新增 `episodeInjectionPhase()`，只用宿主事实选相位：
  强制重写路线（restructure/replan）→ `mutation`；前置拒绝或编译失败 → `compile-fix`；
  数值/运行/混合失败或正确性回退 → `correctness-fix`；其余（已正确，在调优）→ `performance-tuning`。
  每次评测后用 W3 的 `assembleInjection` 按该相位装配：text 取假设、宿主阶段、必修项与前三个诊断位置；
  `errorSignatures` 与 `symptoms` 用判决里的失败签名；`context.appliedTransforms` 带上本 episode 已用过的策略，
  让决策表能屏蔽重复方向。装配结果随工具返回，并在候选记录上留下 `injection` 回执（相位、状态、refs、字符数），
  形成「注入—结果」配对。
- 装配读的是目标冻结的知识快照：快照变化时记 `snapshot-changed` 并不注入，绝不混用两个版本；
  装配失败记 `unavailable`，不影响已经取得的观测。
- `src/m07/controller.ts`：把知识库与 prior 目录传给 episode 工具（两处创建点）。
- `src/m07/types.ts`：候选记录新增 `injection` 回执字段。
- 保留原有的「完整必要依赖组宿主只读校验 + 索引预览」，那解决的是另一个问题。

## 验证

- 类型检查 0 错误；新增两项测试：失败轮拿到 correctness-fix、正确轮拿到 performance-tuning，
  且每个候选记录都带相位回执；相位映射表逐项断言（含强制重写走 mutation）。
- `m07-candidate-episode`、`m07-execution-knowledge` 全部通过。
