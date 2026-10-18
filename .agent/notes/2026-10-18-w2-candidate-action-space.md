# W2：收缩候选动作空间（一个策略 + 一个位置 + 相位门 + 禁令执行）

## 为什么

依据 RB-A2-02：动作必须是（优化类型, 代码区域）两个字段，一轮只做一个优化。这是依据里消融幅度最大的一类：
一次性混合改动时 L1 94%/2.14×→60%/1.38×、L2 97%/1.21×→32%/0.43×、L3 64%/0.69×→10%/0.09×；
去掉动作空间约束后继续掉到 10–50%，而「随机策略 + 受约束动作空间」在 L1 仍有 70%。
依据 RB-A2-03：优化方向必须来自可枚举、可统计的策略集（去菜单 5.53→2.34，是单项最大损失），并配 dropout 保证多样性
（去 dropout 4.72→2.30）；高风险低成功率的策略（tiling 成功率 14.4% 却贡献 61.5% 的最终最优）要留固定份额，
所以每个策略的成绩要可见而不是被折叠成一个偏好。
依据 RB-A1-03 / RB-A1-19 / RB-A5-06 / RB-A5-11：阶段顺序是结构先于数值参数，并且先拿到一个一定正确的种子；
「结构没定就搜 tiling」实测只有 1.02×。依据 RB-A1-17：编译前的廉价静态校验回报很高。

改之前：`candidate_evaluate` 只要 hypothesis（4000 字自由文本）+ changeKind 三值，没有位置、没有策略集、
没有阶段顺序约束，也没有任何重复方向的拦截。

## 改了哪里

- `src/m07/candidate-policy.ts`：新增枚举策略表、`candidateStrategyStats`（每策略 attempts/keeps/accepts/reverts/bestScore）、
  `candidateStrategyMenu`（按相位与路线过滤，再用可重放的确定性 dropout 隐去部分结构策略，至少保留两项）、
  `requireUnbannedDirection`（停滞期内重复被禁的「改动类别+策略+位置」必须给 newEvidence）。
  `candidateSearchState` 的停滞计数与禁令改为按任务（＝一个计划）统计，对应依据「计数器以计划为单位重置」。
- `src/m07/candidate-episode.ts`：`candidate_evaluate` 新增必填 `strategy`、`location` 与可选 `newEvidence`；
  位置必须指向已声明源码（允许宿主 runner 的冻结前缀），带符号或行段时在冻结字节里做零成本静态校验；
  相位门与禁令在任何宿主开销之前执行；策略菜单与策略成绩随每次反馈返回。
- `src/m07/candidate-runner.ts`（W1 拥有，最小透传改动）：`Request` 增加 strategy/location/newEvidence 并原样转给
  candidate_evaluate，sweep 默认 strategy=numerical-parameters，工具参数表补三项说明。
- 提示词与边界文本：`workflow/v1.0/提示词/P07`、`controller.ts` 的候选 episode 边界段、`extension.ts` 的 delegate 指南。

## 验证

- 类型检查 0 错误；`test/m07-candidate-policy.test.ts` 13 项、`m07-candidate-episode.test.ts` 12 项、
  `m07-candidate-runner.test.ts`、`m07-local-operator-backend.test.ts` 全部通过。
- 新增断言：菜单可重放且相位相关、至少两个结构选项、repair 路线只给 repair；策略成绩按策略聚合；
  禁令只在停滞期生效且可用 newEvidence 解除；不存在的位置与 bootstrap 期的参数搜索在宿主开销前被拒。
