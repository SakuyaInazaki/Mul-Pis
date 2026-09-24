# 首轮工作流改进外环

## 已实现范围

独立的 `research_improve` / `improve` 入口只允许改动 `BudgetPolicy` 的单文件与聚合内联上限。候选由工作区显式配置的 `improver` 模型提出；控制器固定策略 schema、投影筛选规则、局部机制准入检查与晋级条件。候选不能修改工作流正文、源代码、评价规则、知识限制或工具权限。

M07 在真实 `taskMessage` 与 `writeFeedback` 投影时，按调用边界及材料顺序保存私有事件：冻结策略版本、独立的 UTF-8 字节数与 UTF-16 code units、聚合预算前后值、内联或延后决定及原因。文件级 provider token 数不可从字符数推导，标为未知；会话 usage 另行记录。控制器为测量保留当时材料副本，默认额外磁盘上限为单材料 8 MiB、单次投影 16 MiB、单个 M07 run 累计 64 MiB。触限仍按原输入和原策略运行，但事件显式不可重放；旧运行没有事件或副本缺失也不可重放，不按零长度补样本。大小和修改时间的检查只能发现明显变化，不构成防篡改证明。M07 execute/bash 后续可能读取已变化的任务副本，其版本与范围仍是未知。

投影筛选器只用可重放事件的 UTF-16 长度，按每次调用的原材料顺序重算当前策略与候选策略；不会拿 M01–M09 阶段 `inputs` 的文件字节数冒充 M07 子任务输入。它可排除无观测机会或不满足固定硬门槛的候选，但减少初始内联量不等于科研质量不降，也不能单独授权晋级。反馈包写盘与 M04 组装反馈消息分别记录；材料被保存、工具实际返回某范围、模型使用该范围、独立检查确认使用正确，是四个不同事实。M04 的 `m07_evidence_read` 记录实际返回行范围和截断状态，即使后续模型调用失败也保留已返回范围；文件名访问不证明已读全文，更不证明语义正确。

M07 普通 `finish` 仍先执行原目标的成功标准、已接受证据、未决事项与有效任务硬检查。若长工具日志等控制事实使完整反馈超过该目标冻结的 `maxFeedbackChars`，控制器可写入不超过同一上限的 `indexed` 反馈，保留完整 `goal.json` 和固定证据；索引明示省略类别与原记录位置，不把截断片段冒充完整内容。`complete` 表示完整反馈写盘，`indexed` 表示仅有界索引；受控中断失败时的 `control-facts-only` 只含归档控制事实，`failed` 表示反馈交接需修复。M04 可用 `m07_evidence_read` 对同一 M07 run 的 `goal.json` 和证据按页实际读取；索引存在、路径可访问和 `fulfilled` 硬门通过，均不证明 M04 已读全或认可科学结论。归档写入异常会保留显式修复状态，不能把 goal/run 终态不一致视为正常完成。

主 Pi 的非交互持续执行只在显式设置 continuation 工作区与目标绑定时启用。已绑定目标仍为 active 且模型正常结束一回合时，extension 在 Pi 的 `agent_end` 队列中续接同一会话；普通 final/checkpoint 不等于目标完成。新 `begin` 只在指定工作区成功后绑定其实际 runId，未启用的只读会话不自动拾取旧 active goal。只有持久 M07 结果为 `fulfilled` 才停止正常续接；明确用户中止、provider 错误和重复无进展会停止续接并如实留下未完成/归档原因，防止热循环。此能力不自动重放进程崩溃后的阶段或子任务，不能代替模型或平台调用的外部资源预算。

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

改进记录、案例、投影事件及方法运行信息保存在私有工作区 `.agent/`，不提交或公开推送。既有开发试跑已用于修复系统，不能重称盲测。

## 有限科研方法开发切片

预算策略的局部机制改进与科研方法开发是两条不同实验路径。后一条把 H 定义为实际装入执行会话的有界数值辨识提示策略，把 I 定义为实际装入改进会话、指导下一步诊断和候选提出的提示策略；版本化代际包记录 H/I 版本、父版本、知识快照、环境和模型配置。I 可根据公开初始观测与开发反馈，在控制器允许的有限动作中检查证据、提出可证伪假设、调用辨识探针、写出候选 H/I 并请求开发评价。模型给出的解释和候选只是主张，不能自行写成通过的环境事实、知识采用决定或受保护的准入结果。

当前 CPU 数值环境只在一组预先列出的仿射或二次响应假设间做主动辨识。初态可以不足以分辨真值；合法探针返回带单位的观测，开发反馈可报告与已见观测相容、矛盾或仍未定，但不暴露私有真值。每个对比臂从同一初态独立 fork；受保护答案只在两个候选都已固定后由控制器检查，不作为 I 的开发反馈。受控 I/H 子会话没有通用工具，只接收白名单内的开发材料，G 结果不回灌；这是子会话上下文隔离，不是同机文件的 OS 权限隔离。调用入口的主 Pi 若另有普通读文件或 bash 权限，仍可能访问私有案例；不能宣称隐藏集对整个主 agent 密封。策略正文也不能改变动作白名单、事实生成器或预算，源代码候选执行尚未开放。单位按案例公开的固定单位解释；不同单位输入的诊断与换算尚未实现。

科研方法 campaign 另用调用方显式给出的根预算约束它启动的 I/H/meta 子请求：provider 调用、完整输入 token、输出 token、SDK 估计费用、探针、CPU 和壁钟；分支预算从同一根账扣除。缓存读写计入输入，推理输出已包含在 provider 的 output 口径，不重复加计；缺失 usage 或价格、超额和未结算调用均不能用于自动晋级。若由 extension 调用，主 Pi 编排会话另有 best-effort 主账，却不经同一根预算预约；CLI 没有主 Pi 会话。两者都不计 Codex 人工开发，也不是完整 workflow 或 provider 账单。`development` 仅供形成假设和观察结果。独立 `admission` 需要完整案例、交替顺序的重复双臂、受保护质量检查和冻结选择；H 质量与 I 产生后继 H 的能力分别评价，不能把一次碰巧作答或成本下降写成科研收益。证据仍不足时合理停止并明确报告未定，是应记录的部分质量，不等于错误答案，也不满足完整解题门槛。没有准入材料时运行保持 research-only。

经验仍存于原 C/K/E/J/Q/D/X 知识库，M04 是现有提案、判断与合入路径；实验反馈不能直接升格为 adopted 或 verified。每个知识库懒初始化稳定 `storeId`，跨库引用须显式注册并固定 `{storeId, recordId, version}`。调用方显式指定目标与有限条经验；选择器检查适用阶段、标签、情境、声明的必要依赖闭包和当前限制，超界或缺失即不给完整经验包。撤回、停用和传递必要依赖会阻止新的使用，历史记录仍可只读追溯；反例与替换史引用不自动当作科学前提。H/I 版本分别保存装载来源 `sourceExperienceRefs`、既有版本保守继承的 `requiredExperienceRefs`，以及结构化声明的必要科学前提 `requiredKnowledgeRefs`；新选入的普通参考不因被阅读就变成必要前提，旧版已记录的必要约束也不会被自动降级。候选正文和后续计划省略引用，都不能清除必要约束；新的 I/H 调用、激活、回退和 V2 导入前重查。跨库注册必须显式注入服务，方法包本身不导入外库记录。仅有选中或装载不证明忠实使用、科学正确或因果收益。

知识跨轮更新是显式操作：`advance-knowledge` 要求已完成合入的 M04 run、新知识快照、无运行中的 campaign 和预期活跃 bundle；控制器保留 H/I 正文与旧 bundle，核对必要引用及 live 限制后写入新知识 epoch，不改写旧 run。`transition-dependencies` 只处理结构化的 `requiredKnowledgeRefs`，需要指向当前方法与精确引用变更的已采纳 M04 决定、登记证据和复验记录，生成有不可变沿革的新方法版本；旧 `requiredExperienceRefs` 保守保留，知识库的撤回/限用授权不会因此解除。D/E 链路结构可核验，但这不能证明 M04 的科学判断正确。

M07 可在新目标 begin 时显式指定当前活跃的 `m07-workflow-prompt` H 版本，冻结 `research-check` 或 `evidence-handoff` 槽位、正文、必要引用与知识快照；CPU 数值 H 不能冒充工作流方法。正文进入真实子任务提示，证据交接槽位还随固定反馈包向 M04 标明采用的版本与适用限制，原目标、mandatory checks 和工具权限仍优先。新任务前重查 live 必要引用，已冻结目标不热换正文。普通经验包仍只在显式提供引用时有界装入任务；实际遵循和科研收益均需另有证据。

方法包只带策略正文和限定元数据，不自动携带案例、答案、轨迹或知识库；跨工作区绑定是调用方显式导入，不能借来源声明冒充本地自动准入。工程测试已使用假会话覆盖控制路径，也完成过小规模真实 H 与 I 动作链的 `development` 试跑以验证环境接线；I 尚未产生或选择新后继，未运行真实模型的完整 H/I 成对准入，也没有独立 executor 或 meta 收益证据。这不能称已形成结构化 L5。其他数值环境、外部异步任务恢复、真正的代码执行沙箱、长期课程迁移及 L3/L4/L5 递归改进仍未实现或验证。

M07 `evidence-handoff` 另有显式单槽入口：`improve research bootstrap --methods <methods.json>` 可用 `m07-workflow-prompt`、`slot: "evidence-handoff"` 与 `diagnostic-improver-prompt` 建立独立于 CPU 的方法包；`improve research workflow run --plan <plan.json>` 才启动 I。计划结构由 [`WorkflowEvidenceHandoffPlanV1`](../../src/improvement/workflow-types.ts) 定义，需指定真实已冻结的 `developmentSource`（M07 run、checkpoint、处理该包的 M04 run）、开发案例文件、与源工作区及彼此隔离且尚不存在的 `experimentRoot`、根预算及成对重复数；独立 G 案例文件可省略，此时仅研究留档。H 候选只能改交接槽正文，不能改目标、答案、mandatory checks、工具或 G。正常 M07 begin 不会自行唤醒 I，已冻结目标也不热换 H。

开发材料供 I 检视之前先核对 M07 冻结包与 M04 来源绑定。历史 `developmentSource` 仅提供反馈，不充当新执行臂的形式基线；在任何 I 调用前，控制器要求当前知识快照、冻结 H/K 与最新 completed 形式 M04 基线的知识纪元一致，执行臂复制该形式基线。基线和候选在独立新工作区、固定知识快照、模型配置与检查下执行 M07 委派、review、checkpoint 及 M04 处理；控制器检查冻结报告及 M04 对完整报告的实际接收记录。受保护 G 在 I 固定候选后才打开，结果不回灌 I。`contains`/`forbids` 是报告文字的机械完整性门，只能称本地交接机制证据，不能声称科学有效或泛化收益；没有独立 G、完整可见用量或每臂通过条件时不自动激活。开发及准入案例均由调用方从已有资料准备，不存在系统预写赢家。历史 P3 checkpoint 与处理它的 M04 run 可作 `developmentSource`，但独立 G、当前形式基线及预算仍须另行冻结；M04/K 可能带历史先验，不能把案例路径隔离称为语义盲测。

该入口在每次带工具的 Pi prompt 前串行预留当前根账剩余 provider 调用及输入额度，结束按 SDK 可见事件（含缓存输入、输出、估计费用）结算并退回未用额度。缺 usage、超额或 SDK 内部多轮无法完整观测均为 inconclusive，不能晋级。Pi SDK 目前不能在单个 prompt 内精确物理截断第 N 次 provider 调用，因此这是可见成本的准入边界，而非 provider 账单或物理硬停。离线测试包含实际 Pi runner 与本地 fake provider 的两轮工具读取、服务级配对与无赢家路径、CLI bootstrap 至 workflow 入口的缺用量失败闭合。两次真实模型 P3 development 试跑累计有五次可见 provider 事件；首轮发现旧 CPU 系统动作格式冲突，次轮 I 完成 inspect→propose→evaluate-development，但独立臂因私有副本当前 K 与历史 M04 基线不同而未启动 M07/M04，最后的空候选 stop 也被过严解析拒绝。两处已按实际失败修正并有离线回归；不把修复后的入口称为已完成真实模型配对验证。真实 I 后继继承、独立 G 准入、完整真实 L5 收益仍未验证。

新路径的 CLI 与上文旧预算策略 `improve run` 分开：先以 `node src/cli.ts improve research bootstrap --workspace <dir> --methods <methods.json>` 显式写入 H/I 种子，再以 `node src/cli.ts improve research run --workspace <dir> --plan <plan.json>` 启动。`methods.json` 的字段由 [`ResearchBootstrapInput`](../../src/improvement/research-service.ts) 定义；案例集及校验见 [`CpuCaseSetV1` 与 `validateCpuCaseSet`](../../src/experiments/local-environment.ts)。`status`、`rollback`、`export --version <id> --out <package.json>` 和 `bind --package <package.json>` 同在 `improve research` 下；`bind` 是显式人工导入。跨轮知识更新用 `advance-knowledge --m04-run <id> --expected-bundle <id>`；精确前提变更用 `transition-dependencies --m04-run <id> --expected-bundle <id> --method-version <id> --decision-ref <ref.json>`，后者的输入和结构校验见 [`KnowledgeRef`](../../src/knowledge/types.ts) 与 [knowledge-epoch.ts](../../src/improvement/knowledge-epoch.ts)。这些操作也可由显式 Pi extension action 调用。

例如，下列结构选择 H 的质量路径，假设准入集只有一个案例；**数值仅用于演示活动与阶段预算字段，没有经过真实多案例 H/I 工作负载校准，不应复制为默认上限，更不适用于主 Pi 科研工作流**。实际计划须先测组装请求和开发 pilot 的用量，再由调用方确定活动与阶段的总资源额度。`admissionCaseSetPath` 可省略，此时只保留开发记录而不晋级。案例文件必须由调用方私下提供，不应把真值或检查答案放进模型提示。元改进需另给 `target: "improver"`、`metaProtocol`、每臂候选上限与分支预算；两臂从同一冻结 H/K 与同一经验选择出发，各自建立开发 fork，先固定全部后继再查受保护案例。`MetaEpisode` 仅记录受保护检查前的有界开发历史，后续 plan 通过同工作区 `metaEpisodeRunIds` 显式选用；未有赢家和预算内不可判定均保留各自状态，历史不能充作新的 G 证据。

```json
{
  "version": 1,
  "experimentKind": "executor-quality",
  "target": "executor",
  "developmentCaseSetPath": "./cases/development.json",
  "admissionCaseSetPath": "./cases/admission.json",
  "maxDecisions": 6,
  "maxCandidates": 2,
  "admissionRepetitions": 2,
  "maxFeedbackItems": 8,
  "perPromptTimeoutMs": 120000,
  "searchReplicates": 1,
  "outcomeReplicates": 2,
  "outerBudget": { "maxProviderCalls": 16, "maxInputTokens": 320000, "maxOutputTokens": 32768, "maxSdkEstimatedCost": 100, "maxProbeCalls": 16, "maxCpuMillis": 20000, "maxWallMillis": 240000 },
  "pilotBudget": { "maxProviderCalls": 1, "maxInputTokens": 20000, "maxOutputTokens": 2048, "maxSdkEstimatedCost": 20, "maxProbeCalls": 0, "maxCpuMillis": 1000, "maxWallMillis": 120000 },
  "protectedBudget": { "maxProviderCalls": 12, "maxInputTokens": 240000, "maxOutputTokens": 24576, "maxSdkEstimatedCost": 800, "maxProbeCalls": 16, "maxCpuMillis": 20000, "maxWallMillis": 240000 },
  "budget": {
    "maxProviderCalls": 100,
    "maxInputTokens": 1000000,
    "maxOutputTokens": 200000,
    "maxSdkEstimatedCost": 1000,
    "maxProbeCalls": 32,
    "maxCpuMillis": 60000,
    "maxWallMillis": 600000
  },
  "experienceRefs": [],
  "experienceMaxRecords": 0,
  "experienceMaxChars": 0
}
```

I 的元改进路径需单独编制预算；上述 H 示例的 `pilotBudget.maxProviderCalls: 1` 不能支持一个实际内层搜索。将 `experimentKind` 改为 `meta-improvement`、`target` 改为 `improver` 时，还须提供足以覆盖候选提出、开发评价、终态选择及 H 执行的 pilot 额度。若提供受保护的 `admissionCaseSetPath`，还须显式提供 `metaProtocol`、`metaBranchBudget`（同一组预算字段）与 `maxCandidatesPerMetaArm`，两臂各自受该上限约束并共享根账。`experienceRefs` 可显式选择有界非空包，控制器在两臂使用同一次冻结选择并在新请求前复查 live 限制。`priorDevelopmentFeedbackPath` 若提供，只能装载受校验的开发反馈，不能把受保护答案移进 I 的上下文。

请求准备使用已组装提示词的 UTF-8 字节数加 2048 字节的 SDK/JSON 余量，作为实际 payload 的字节边界及保守输入 token 预留；这不是固定的单次输入额度，也不是 provider 实测 token。如果这一条已组装请求超过活动或阶段剩余的总输入预算，请求不会发出。模型返回后以独立 usage 结算输入、输出和 SDK 估算费用。

方法研究的提示词不再另受固定 4 万字符消息、8 千字符 system 或决策 JSON 长度门槛约束；完整组装请求只受模型上下文能力、实际 payload 检查及活动与阶段剩余总输入预算约束。有限的最近反馈与 inspect 页窗口会向 I 报告总数和省略数；旧开发材料仍留在控制器登记的对象中供按页读取。项目不再设置单次输入或输出 token 额度，也不再以固定的 16000 字符拒绝模型回复；Pi SDK 和 provider 的模型物理限制仍适用。输出和 SDK 估算费用在请求完成后按实测 usage 结算：最后一条回复可能超出活动或阶段预算，超额会被标记并停止后续请求，不能用于自动晋级。受保护阶段预检只保证声明的调用次数与各阶段总额度能装进活动总额度，不保证未知的实际 token 和费用能覆盖所有 G 请求；预算不足时结果不可判定。
