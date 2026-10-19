# W2：候选任务必须声明实现空间与 headroom（subjectProfile）

## 为什么

依据 RB-A1-07（P0，单篇消融 ×3）：「在哪个抽象层写」必须是显式决策并记进轨迹；90 题实测纯手写底层
最大 9.32× 但**均值 1.00×、中位 0.62×、方差 1.79**，库路径方差 0.27、库+框架均值 1.10×。
默认直奔手写底层会让一多半尝试比参考还慢。
依据 RB-A1-12 / RB-A5-13 / RB-A5-14（P0，强共识）：进入 M07 前要有三项记录——端到端占比、基线强度
（是否有成熟厂商库覆盖）、headroom；实测里有库覆盖的 9 个算子只赢 1 个却占 80%–93% 运行时，
75% 的回退源于库主导；这是全批最重要的负面结果之一。

改之前：任务只有自由文本 objective 与可选 subjectId，轨迹里查不到「为什么选这一层」，
也没有任何 headroom 或基线强度记录。

## 改了哪里

- `src/m07/types.ts`：新增 `SubjectProfileV1`（implementationSpace + rationale + baselineStrength +
  可选 endToEndShare 与 headroom{kind,value,source}），挂在 `TaskSpecInput` 上。
- `src/m07/controller.ts`：新增确定性结构校验；宿主绑定候选核验器时，execute 任务缺少该声明直接拒绝派发。
- `src/pi/extension.ts`、`src/cli.ts`：两条入口的 schema 与校验同步。
- `src/m07/feedback.ts`：反馈包逐任务输出该声明，并标明是声明而非宿主证明。
- `workflow/v1.0/提示词/P07`、`docs/implementation/design.md`：写明这条前置声明与「手写底层不是默认」。

## 限制

harness 只校验结构、记录取值、把它交给 M04，不校验数字真假，也不据此自动分配预算——
依据里的占比与 headroom 需要真实平台测量，自动按声明值分配预算会放大未经核实的数字。

## 验证

- 类型检查 0 错误；新增一项测试覆盖缺声明被拒、空 rationale 被拒、越界 endToEndShare 被拒、
  无来源 headroom 被拒、合法声明被完整记录；既有 M07 测试同步补上声明后全部通过。
