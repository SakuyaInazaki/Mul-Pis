# W2：把 W3 的决策表接进候选动作空间

## 为什么

W1 在第二轮回报里指出「决策表限定每轮允许的方法集」属于候选搜索；W3 的 `src/knowledge/decision-table.ts`
已经就绪（按瓶颈签名、`when`/`avoid`/`case` 卡、饱和度阈值与已应用变换产出 allowed/masked 菜单）。
依据 RB-A2-04：候选与策略的选择应由确定性决策表或统计控制器决定，全系统 1.57× vs LLM 自选 0.97×；
RB-A2-03：策略集必须可枚举、可统计。本分支此前已有枚举策略与停滞禁令，缺的是「本轮证据允许哪些方法」。

## 改了哪里

- `src/m07/candidate-policy.ts`：新增 `STRATEGY_METHODS`（候选策略 → 优化方法的显式保守映射）与
  `requireAllowedMethod()`。拒绝的条件是：该策略对应的**全部**方法都被屏蔽，且屏蔽**有出处**
  （`sourceRefs` 非空，即来自已发布卡片或测量规则）。两条刻意的限制：表没说的策略保持可用；
  仅因「本候选已用过该方向」而屏蔽的只影响建议——同方向换位置是合法的，重复本身已有停滞禁令管。
- `src/m07/candidate-episode.ts`：每轮装配时把宿主自己的瓶颈签名（compile-failure / numerical-failure /
  profile 解读的 compute/bandwidth/latency，其余 unknown）、speed-of-light 比例与算子类别传给
  `assembleInjection`，取回它算出的方法菜单，存进 `episode.methodDecision` 并随工具返回；
  下一个候选在任何宿主开销之前过 `requireAllowedMethod`。
- `src/m07/types.ts`：`M07CandidateEpisodeV1` 新增 `methodDecision`。

## 验证

- 类型检查 0 错误；新增一项策略测试覆盖：全部方法被屏蔽即拒、部分屏蔽仍可用、无对应方法的策略不受限、
  无出处的屏蔽不构成拒绝、blocked 或无决策时不拒。
- `m07-candidate-policy` 23 项、`m07-candidate-episode` 18 项通过。
