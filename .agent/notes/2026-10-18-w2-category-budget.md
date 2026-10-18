# W2：按算子类别分配预算（W4-07 剩余部分）

## 为什么

依据 RB-A11-12（P0）：预算按**算子类别**而不是 benchmark level 分配。
Activation/Loss/Optimizer/elementwise/Math 一轮即可；norm、reduce 的融合是收益最大区；fusion 可行率约 56%、要多轮；
Convolution/Pooling 几乎必败（conv pass@4 仅 41%）；matmul 约持平或输给厂商库（L1 对 aclnn 仅 0.61×）；
broadcast、attention、sorting/indexing 当前 0%。调和 Amdahl 的做法是「占比高 × 基线弱」优先、
「占比高 × 基线强」直接委托库。W4-07 的其余部分（bootstrap/tuning 两段、实现空间显式决策、
sweep 只在结构稳定后启动、autotune 预算占比上限）在第一轮已经落地，缺的就是类别维度。

## 改了哪里

- `src/m07/candidate-policy.ts`：新增 `OPERATOR_CATEGORIES`、`OperatorCategoryBudgetV1`、
  `DEFAULT_CATEGORY_BUDGETS`（elementwise 6 次、norm-reduce 24 次、fusion 20 次、matmul 6 次且默认不准入、
  卷积/池化、attention、排序索引、broadcast 各 4 次且默认不准入、other 24 次）、`operatorCategoryBudget()`；
  `searchBudget.categoryBudgets` 可整体覆盖并同样走校验；`candidateBudgetLedger` 取
  `min(evaluationsPerTask, 类别上限)`，账本里记录 `category` 与 `categoryCap`。
- `src/m07/types.ts`、`src/m07/controller.ts`：`subjectProfile` 新增必填 `operatorCategory` 与可选
  `categoryJustification`；默认不准入的类别缺少理由时直接拒绝派发，理由随任务记录留在轨迹里。
- `src/pi/extension.ts`、`src/m07/feedback.ts`：工具 schema 与 M04 反馈包同步该声明。
- `workflow/v1.0/提示词/P07`：写明类别决定预算上限与是否进入优化队列，并按
  `test/workflow-manifest.test.ts` 的口径同步了 `文件清单.md` 与 `提示词全集.md`。

## 验证

- 类型检查 0 错误；新增两项策略测试（默认类别表与上限、配置覆盖与校验）与一项端到端测试
  （matmul 无理由被拒、有理由可派发且理由被记录）。
- `m07-candidate-policy` 22 项、`m07-candidate-verification` 5 项、`workflow-manifest` 2 项通过。
