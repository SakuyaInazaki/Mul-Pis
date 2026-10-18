# 审计投影与交付证据改为消费运行层与宿主已经做出的判定

合并后的对接批次。前一轮里这两处只能看见自己能算出来的东西；合并带来了别人已经算好的判定，本批次把它们接上，
并且**不重新分类、不重算聚合**。

## 为什么

- G1-44 [P1]：执行树要展示判决与证据，最小可见集合包括每候选的 guard 判决与停滞计数、停在哪一级验证门、
  harness 失败与模型失败分列。合并前控制台只有自己按诊断层推出来的九级验证门，看不到搜索层真正的判决。
- RB-A13-08 [P0]：基础设施失败与策略失败分开计，`unjudged` 比例本身是 harness 健康指标。运行层现在给出
  `failureClass`/`failureReason`（`src/runner/failure-class.ts` 的封闭清单），再由界面自己猜是重复且会分歧的。
- RB-A8-01 / RB-A8-03 / RB-A8-06 [P0]：交付必须是历史最优；性能门开在端到端层面，过不了保留基线；报告要给
  两个分母、三个聚合数、三层口径。本地算子宿主现在逐 baseline 给出 faster / tie / slower / quarantined 判定、
  `performanceDecidable`，以及它自己算的三个聚合数（成功率、仅成功样本几何平均、全可裁决集几何平均与中位数）。
- RB-A4-14：比率型指标用几何平均或中位数、失败计入。交付层若自己再聚合一次，就会出现第二套数字。

## 改了哪里

### 控制台审计（`terminal-console/src/console/`）

- `audit.ts`：新增四块，全部是读回而非推断——
  - `classifiedFailures`：工具调用与传输失败各自按运行层标注的 `infrastructure` / `policy` / `unjudged` 计数，
    没有标注的旧记录单列 `unrecorded`，并给出未判定占比与失败原因分布。
  - `policy`：`episode.candidates[].policy` 的 guard、status、branch、lane、phase 分布，更新最佳指针的次数，
    评分的中位数与最大值，以及没有宿主判定的候选数。
  - `search`：`episode.search` 的最大停滞、强制换向次数、禁用方向条数、路线与停滞信号分布。
  - `searchBudget`：`episode.budget` 的已用评估（含前置驳回）、最小剩余、停止原因分布。
- `read-model.ts`：审计输入增加每个 M07 运行的传输观测（运行输出里标签为
  「Read-only assessor transport observation」的记录），按窗口读取最近若干条，超窗口时如实标注截断；
  候选节点与候选实验节点的 detail 直接列出宿主判决、搜索状态与预算全文。
- `limits.ts`：新增 `transportObservationWindow`（默认 200，可在 `.agent/console-limits.json` 覆盖）。
- `src/m07/objective-progress.ts`：持久化的传输观测补上 `failureClass` / `failureReason` 两个字段
  （运行层已经判好，之前只是没有落盘）。这是本轮唯一一处改动别人文件的地方，只有这两个字段。

### M09 交付（`src/stages/`）

- `delivery-evidence.ts`：新增 `hostDecision`——逐 baseline 的 faster / tie / slower / quarantined 与端到端回退
  计数、可裁决与不可裁决用例数、宿主不可比的逐条原因、以及宿主自己的三个聚合数原样读回。回执来自别的后端、
  不含宿主判定时单独计数，不猜测判定。
- `assertNoRecordedRegression()`：宿主记录了端到端回退时拒绝收口（`m09.recorded-regression`），与既有的
  「交付非历史最优即拒绝」并列。
- 渲染里明写「三个数一律由宿主计算，交付层不自造聚合」。

### 文档

`AGENTS.md`（并入 W1–W4 的句子，措辞按各分支实际实现核对）、`README.md`、
`terminal-console/docs/implementation/terminal-console-design.md`、`docs/implementation/design.md`。

## 验证

- 类型检查 0 错误。
- `terminal-console/test/**` 58 项、`test/delivery-evidence.test.ts` 7 项、`test/m09.test.ts` 4 项全部通过。
- 全量测试结果见本批次提交正文。

## 边界

审计仍然只做计数：它不判断候选好坏，也不把「宿主判定更快」当成科学结论。交付层不产生任何新的性能数字；
它报告的每一个比值都是宿主算出来的，口径标注随之一起搬运。
