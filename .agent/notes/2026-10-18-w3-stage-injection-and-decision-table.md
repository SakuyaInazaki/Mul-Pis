# 阶段化知识注入、冻结分层先验与确定性方法决策表

## 为什么

注入此前是「每个调用点各拍一个大数」：M04 48 条 / 60000 字符、M06 32 条 / 40000、M07 任务 24 条 /
60000、M05 30000、M08 1e9。每轮给同一份大包，既没有阶段差异，也没有「这条进过哪个提示」的记录。
优化方向的选择则完全交给模型自由发挥：没有任何「瓶颈 + 已做优化 + 饱和指标 → 允许方法集」的代码
路径，被否定过的方向可以在三轮之后原样回来。

依据这两处都有硬数字：阶段差异化装配把单算子可行率从 40% 抬到 90%，而整段文档反而稀释上下文；
让模型自己选策略则从 1.57× 掉到 0.97×。冷启动一侧，分层先验（L0–L5）是「0% 与 90% 的差别」。

## 改了什么

- 新增 `src/knowledge/decision-table.ts`：确定性 when 知识。输入瓶颈签名、情境、已应用变换、
  指标读数与已发布卡片，输出允许方法集（每项带引用指标值或条目 ID 的理由）与屏蔽集（负层排除、
  饱和阈值、重复方向）。编译失败与数值错误阶段返回 blocked，不给性能方向；没有 when/case 条目时
  明确标注 default-menu，不把内置菜单伪装成实测结论。
- 新增 `src/knowledge/prior-library.ts`：`.agent/knowledge/prior/L0…L5/*.md` 的冻结分层先验。
  每条必须声明 backend、toolchain 与本地出处；装配时按情境硬过滤（不匹配直接丢弃而不是降权），
  并受条数与字符上限约束。解析不了的文件进 rejected，不猜测。
- 新增 `src/knowledge/injection.ts`：阶段×相位装配表（bootstrap / mutation / compile-fix /
  correctness-fix / performance-tuning / review / acquisition / applicability / judgment），
  每个相位规定先验层位、可见卡片种类、条数与字符上限，并产出注入回执（priorFiles、injectedRefs、
  cardRefs、omitted、chars）。显式 requiredIds 永不被相位过滤或预算丢弃。

## 验证

- 类型检查 0 错误。
- 新增 `test/knowledge/injection.test.ts` 6 项：方法排序与理由、三类屏蔽、失败阶段 blocked 与
  默认菜单标注、先验的分层/硬过滤/上限、各相位只注入自己的卡片种类且受界、required 永不丢。

## 限制

- 装配表的条数与字符是旋钮，取值参考依据里的「100 token 量级」与「一次 ≤3 条」，没有在本项目
  基线上标定过。
- 决策表的饱和阈值默认 0.75 来自 NVIDIA 平台的文献值；昇腾需要用 aiv_mte2_ratio / cube_utilization
  重新标定，因此 maskRules 由调用方传入而不是写死。
