# 首轮工作流改进外环

## 已实现范围

独立的 `research_improve` / `improve` 入口只允许改动 `BudgetPolicy` 的单文件与聚合内联上限。候选由工作区显式配置的 `improver` 模型提出；控制器固定策略 schema、投影筛选规则、局部机制准入检查与晋级条件。候选不能修改工作流正文、源代码、评价规则、知识限制或工具权限。

M07 在真实 `taskMessage` 与 `writeFeedback` 投影时，按调用边界及材料顺序保存私有事件：冻结策略版本、独立的 UTF-8 字节数与 UTF-16 code units、聚合预算前后值、内联或延后决定及原因。文件级 provider token 数不可从字符数推导，标为未知；会话 usage 另行记录。控制器为测量保留当时材料副本，默认额外磁盘上限为单材料 8 MiB、单次投影 16 MiB、单个 M07 run 累计 64 MiB。触限仍按原输入和原策略运行，但事件显式不可重放；旧运行没有事件或副本缺失也不可重放，不按零长度补样本。大小和修改时间的检查只能发现明显变化，不构成防篡改证明。M07 execute/bash 后续可能读取已变化的任务副本，其版本与范围仍是未知。

投影筛选器只用可重放事件的 UTF-16 长度，按每次调用的原材料顺序重算当前策略与候选策略；不会拿 M01–M09 阶段 `inputs` 的文件字节数冒充 M07 子任务输入。它可排除无观测机会或不满足固定硬门槛的候选，但减少初始内联量不等于科研质量不降，也不能单独授权晋级。反馈包写盘与 M04 组装反馈消息分别记录；材料被保存、工具实际返回某范围、模型使用该范围、独立检查确认使用正确，是四个不同事实。M04 的 `m07_evidence_read` 记录实际返回行范围和截断状态，即使后续模型调用失败也保留已返回范围；文件名访问不证明已读全文，更不证明语义正确。

改进器会收到先前尝试的假设、参数、失败类别与门槛结果摘要，并在本轮纳入已完成尝试；同一轮候选去重，跨轮也只在冻结基线、模型配置、投影观测与案例集相同的实验义务下阻止重复策略。没有可重放投影机会，或预算内没有通过准入的候选，均可正常结束为无晋级结果，不暗示研究失败或有效改进。

自动晋级还需要调用方提供 `split: "admission"` 的私有机制案例集及实验预算。控制器在提议前固定案例集，不把检查器答案送进 improver 或受测会话；每个案例、每次重复、每个策略臂都新建无工具的独立研究会话，从投影变化点重新求解，延后读取只从该次固定案例文本取回。准入至少要求两次偶数重复，基线/候选先后顺序交替；全部预设硬检查通过、每一配对中候选估计成本不增加，且总体严格降低，才允许原子晋级。混合增损、超时、失败、provider usage 不完整、超预算或案例未跑完均不能晋级。`development` 案例仅供开发观察，不能授权自动晋级。此实验只验证局部“投影—按需读回”机制，不能称整套 M01–M09 科研任务已成对重跑。

campaign 的预算和账目只覆盖它启动的提议、两臂及读回调用，包括失败与 SDK 可见的重试。provider token usage 与字符代理分列；成本是同一模型本地价表下的 SDK 估算。缺少 usage、价格或超时后仍可能在途的调用记为未知并阻止晋级。子会话另有 `<session>.usage.jsonl`；主 Pi 编排使用私有 `.agent/telemetry/pi-main-usage-<sessionId>.jsonl`，标记 `pi-main-orchestration`，只追加 SDK 可见的会话条目，缺 usage 或价格时标记未知。主账写入是 best-effort，失败不阻断主会话；CLI 运行没有该主账。主 Pi 会话可能跨多个工作区，历史归属不能保证精确，因此不能把两个账目相加当作 campaign 或项目总账。SDK 未报告的隐藏重试、外部实验资源、Codex 人工研发与审查时间及 provider 实际账单仍不在可验证总账内。

## 入口与计划

- CLI：`node src/cli.ts improve status|run|rollback|export|bind --workspace <dir>`；运行需 `improve run --plan <json>`。
- Pi extension：显式加载后使用 `research_improve`，`run` 动作需提供 `planPath`；另有 `status`、`rollback`、`export`、`bind`。
- `run` 读取工作区 `research.config.json` 的 `roles.improver`；准入案例还需 `roles.research`。harness 不替用户选择模型。
- 无 `caseSetPath` 或实验调用预算时只做投影筛选，正常结束为无准入证据的状态，不会晋级。
- 案例集结构及校验规则见 [`MechanismCaseSet` 与 `validateCaseSet`](../../src/improvement/admission.ts)；`checker` 是控制器私有的准入检查定义，不送给受测会话。

一个通用的准入计划结构如下。示例中除 `caseSetPath` 外均为必填字段；该可选路径相对工作区根目录，指向调用方自己准备的私有案例集。具体预算需由调用方按任务和模型定值。

```json
{
  "version": 1,
  "maxCandidates": 2,
  "maxTrialCalls": 12,
  "repetitions": 2,
  "maxReadbackChars": 20000,
  "maxTotalInputTokens": 100000,
  "maxTotalOutputTokens": 20000,
  "maxTotalCost": 10,
  "timeoutMs": 120000,
  "caseSetPath": "./cases/admission.json"
}
```

方法迁移需由调用方显式执行，例如 `node src/cli.ts improve export --workspace <source-workspace> --version <version-id> --applicability <public-description> --out <package.json>`，再在目标工作区运行 `node src/cli.ts improve bind --workspace <target-workspace> --package <package.json>`。

## 版本、回退与迁移

候选必须保留现有 `maxPromptChars`、`maxFeedbackChars` 和 `overflowMode`，不能扩大任何预算。控制器锁住同一工作区的改进操作，晋级前比较活动指针与冻结基线；版本和 prepared 回执先写入，只有原子替换 `active.json` 才激活。崩溃残留的 `mutation.lock` 要先核对 `owner.json` 和持有进程，再精确清理；不能凭超时自动删锁。回退只改变活动指针，不改知识撤回状态或历史运行。

新 M07 目标在 `begin` 时冻结策略正文、版本和方法绑定；后续晋级、回退、跨工作区导入只影响之后创建的目标。旧目标缺少策略快照时可查看或受控中断归档，不能悄悄加载当前策略继续。`export` 仅导出策略与限定元数据，不自动携带科研材料；`applicability` 是调用方自由文本，应自行避免写入私有内容。`bind` 是调用方在另一工作区显式导入的方法版本，标记为外部人工导入且未独立复验；包内声称的 provenance 或本地回执都不能代替该工作区的自动准入。

改进记录、案例、投影事件及方法运行信息保存在私有工作区 `.agent/`，不提交或公开推送。既有开发试跑已用于修复系统，不能重称盲测。当前只做了离线假会话测试；本批没有运行真实模型成对科研实验，因此尚无泛科研收益、跨任务有效迁移、长期适应或 L3/L4/L5 递归改进的证据。
