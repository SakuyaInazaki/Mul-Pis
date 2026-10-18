# 终端控制台增加确定性审计投影与 audit 命令

## 为什么

调研依据里与「终端执行树界面与可观测性」有关的三条未合并条目，以及工程规范里的两条 P0：

- G1-44（P1，推断）：执行树必须展示**判决与证据**，而不只是日志流。最小可见集合包括每个候选的判决与停滞计数、停在哪一级验证门、每轮 token/时间/成本、harness 失败与模型失败分列、引擎驳回 agent 自接受候选的计数。违反的表现是「只有滚动日志，归因要翻原始输出」。
- G7-30（P1）：profiler 不可用或不够时，必须让替代反馈信号本身可见；违反的表现是「只有加速比一个标量」。
- RB-A13-08（P0，单篇消融 + 方法学）：审计账本要能按时间窗重建每任务的变体数、查询数、成本，并把**基础设施失败与策略失败分开计**；依据给出的实证是「4 天 619 次调用抓到的问题全都不在实验数字里显形」。
- RB-A13-09（P0）：先对自己的工作流做一次 wall-clock 画像，把**反馈密度**、turn-per-pass、改动类型分布、累计花费当一级指标；可检查形式写明「控制台实时显示……；违反＝只显示当前最优加速比」。
- RB-A8-05 / RB-A13-02（P0，多篇消融）：接受权归确定性引擎，并保留「引擎驳回 agent 自接受」的计数，量级 12.5%–33.3%。

改动前，这些字段在持久记录里大多已经存在（候选观测、诊断摘要、用量 sidecar、任务状态），但没有任何一处把它们汇总出来：根视图只有目标标题、生命周期、基线和反馈快照。

## 改了哪里

- 新增 `terminal-console/src/console/audit.ts`：`buildWorkflowAudit()` 从目标控制记录与会话用量确定性派生一份 `WorkflowAuditV1`，`renderWorkflowAudit()` 做固定顺序的文本渲染。
  - 验证门分级直接复用已有的确定性解读层 `summarizeCandidateDiagnostics()`，不新增一套判定。
  - 失败分账规则写死在模块里并在输出中说明：源码未绑定、未终态外部操作、任务执行失败记为基础设施失败；编译/数值/运行/正确性失败与复核失败记为策略失败；状态为失败但两类证据都没有的记为未分类。
  - 「引擎驳回 agent 自述」＝有 agent 候选声明的任务里，宿主核验未通过（失败或未判定）的数量，另列控制器驳回数。
  - 没有分母时一律输出「无分母」，不编造比值；用量记录不完整时标注数字是下界。
- `terminal-console/src/console/model.ts`：新增 `WorkflowAuditV1`，`WorkflowSnapshot` 增加必填字段 `audit`。
- `terminal-console/src/console/read-model.ts`：`read()` 在用量汇总之后构建审计；审计覆盖工作区里每一个可读的 M07 目标，而不只是当前选中的那一个。
- `terminal-console/src/console/overview.ts`：根节点概况加四行摘要，根节点完整记录加整份审计。
- `terminal-console/src/console/cli.ts`：新增 `audit` 子命令（文本或 `--json`）；`--json` 的使用范围校验相应放宽，`--once` 仍只用于查看状态。
- `tsconfig.json`：`include` 补上 `terminal-console/test/**/*.ts`。此前这 9 个测试文件从不参与类型检查，补上后立即暴露出 6 处类型错误（缺字段的复核记录、`version: number` 推断、三处快照字面量缺 `audit`），已全部修掉。
- 新增 `terminal-console/test/helpers/snapshot.ts` 作为共享测试辅助（测试 glob 只收 `*.test.ts`，不会把它当用例）。
- 新增 `terminal-console/test/console-audit.test.ts`：判决分布、去重、失败分账、预算下界、无分母、跨目标覆盖。
- 文档：`terminal-console/docs/implementation/terminal-console-design.md` 增加「审计投影」一节并修掉已不存在的 `--model` 参数；`terminal-console/README.md` 重写——旧版说控制台「没有接入当前运行代码」并指向一个已不存在的 `integration.patch`。

## 验证

- 类型检查：`tsc --noEmit -p tsconfig.json`，0 错误（现在含 `terminal-console/test/`）。
- `terminal-console/test/**`：54 项全部通过。
- 全量测试结果见本批次最后一个提交对应的 note。

## 边界

审计只做计数。它不判断科研质量，不声称某个已测量候选真的更快，也不把「宿主核验通过」当作原目标达标。失败分账是一条确定性规则，不是对失败原因的诊断。
