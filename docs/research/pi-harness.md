# Pi Agent Harness 对既有科研工作流的承载核查

> 调研日期：2026-09-20（Asia/Shanghai）  
> 工作流权威基线：[workflow/v1.0/README.md](../../workflow/v1.0/README.md) 与 [科研执行流程 v1.0 完整手册](../../workflow/v1.0/科研执行流程_v1.0_完整手册.md)；本目录中的阅读报告只作辅助索引  
> Pi 对象：[`earendil-works/pi`](https://github.com/earendil-works/pi)，本地只读快照 `third_party/pi/`  
> 固定快照：[`e4c75a73222ae2c72abb5f5314fa35ee8effc508`](https://github.com/earendil-works/pi/commit/e4c75a73222ae2c72abb5f5314fa35ee8effc508)，`@earendil-works/pi-coding-agent` 0.85.1  
> 当前资料：2026-09-20 重新浏览 `pi.dev/docs/latest`；latest 会变化，关键结论同时给固定提交链接。
>
> 流程调整说明：本报告完成初次 Pi 调研后，用户继续对齐了 M01–M09 的会话关系与自动编排方式。详尽流程以 [workflow foundation](workflow-foundation.md) 的当前对齐记录为准；本文只同步这些变化所影响的 Pi 能力映射，不把 SDK、RPC、extension 或工具名称写成已批准架构。

## 1. 结论先行

当前项目中的 Pi 正是官方 **Pi Agent Harness**。它适合承担交互、模型调用、工具循环、会话记录以及受控扩展入口，但它本身不等于现有科研工作流。工作流已经规定了 M01–M09、P00–P09、边界明确的委派、C/K/E/J/Q/D/X 权威知识库、三种状态分离、停用优先和串行合入；后续对齐还明确了 M01–M03 的自动跨会话编排、M06 的逐资料三会话组，以及 M08/M09 的暂定任务组织。本报告只核查 Pi 如何承载这些要求，不另造任务账本、知识目录或替代状态机。

主要判断如下。

1. **M01/P01 与 M06 阅读会话需要显式资源隔离。** 新 session、`--no-session`、换模型或独立子进程都不足以隔离输入。CLI 有 `--no-context-files/-nc`、`--no-skills`、`--no-prompt-templates`、`--no-extensions` 等发现开关，且可与显式资源组合；SDK 可用自定义 `ResourceLoader`。具体允许哪些全局规则、系统提示与工具，仍需按阶段白名单表达。
2. **M01 与 M02 前后相接，但使用两个会话。** M01 独立形成初始认识；M02 使用相同模型的新独立会话，只接收原问题所需原始信息、M01 完整产出和 P02 指令。M02U 只在后续出现新证据或纠错需要时重复。prompt template 只提供入口便利，SDK/RPC/extension 都只是尚未选定的自动组织方式。
3. **有限子任务委派是既有工作流需求。** Pi 核心不内建 subagent；官方示例通过独立 `pi` 子进程实现，默认仍会发现 context/skills/extensions，共享 cwd、环境和宿主权限。它是可参考的编排样例，不是隔离或稳定内建功能。
4. **M03 已对齐为自动跨会话编排。** 独立外审会话基于原问题和 M01/M02 产出生成质询，原 M01 会话续接作答，再回到原外审会话评价；自动化省去人工搬运，但不能合并出题、作答和评价的输入边界。M04 的实质研究判断交回研究会话，首轮可在原 M01 会话之后续接新一轮。
5. **M07 的完成必须有真实证据。** 同步 `bash` 可承载单次交互内完成的实验；需要异步运行、跨会话观察或可靠恢复的长作业才需外部 runner/tmux/调度器。`agent_end`、`agent_settled`、子进程结束或自然语言“完成”均不等于实验通过验收。
6. **M08 固定的是实际研究材料与阶段快照。** session tree/fork/compaction 只能保存对话谱系；不能替代代码、数据、引用、实验产物和知识库的固定版本。
7. **M09 是停止点。** Pi 的退出、abort、清空队列只控制进程；需要工作流层明确不自动生成或执行下一目标。
8. **Pi 没有内建 sandbox，也没有逐操作的权限审批。** project trust、工具白名单和同权 extension 的 hook 只能做合作式检查。若需限制宿主权限，应把边界放在受控工具、凭据层、容器或 VM 等 Pi 之外。

## 2. 身份、版本和证据范围

本地 `third_party/pi/` 的 origin 为官方 `https://github.com/earendil-works/pi.git`，固定提交为 `e4c75a7`，包命名空间是 `@earendil-works/pi-*`，版本为 0.85.1。官网与当前官方仓库也使用 `@earendil-works`。旧名称、旧仓库或第三方 fork 的行为不能倒推到本基线。

固定快照包含 coding-agent、ai、agent、protocol/client/server、Chord 等包，另有 `session-backends/sqlite-node`（pi-agent-core 的 SQLite session backend，coding-agent 不依赖它，见第 8 节）；没有 `packages/durable`。当前官方 main 的 README 另列 `pi-durable`（`packages/durable`），但这不能证明 0.85.1 的 coding-agent 已集成 durable research orchestration。Chord 在固定快照中的 coding-agent 使用集中于 experimental 路径，也不能据此声称工作流事务已经实现。[固定 package.json](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/package.json#L14-L38)

本轮只读官方网页、本地文档与源码。没有安装或运行 Pi、连接模型/provider、启动 SDK/RPC/extension、执行实验或验证科研闭环。因此下文的“可承载”是接口级判断，不是运行验收。

## 3. M01/P01 与 M06：真实输入隔离

### 3.1 Pi 实际会装载什么

Pi 默认从全局、cwd 的祖先目录和 cwd 装载 `AGENTS.md` 或 `CLAUDE.md`；同目录有 `AGENTS.override.md` 时只替代该目录的普通 context 文件，其他目录仍叠加。它还可装载全局/项目 `SYSTEM.md`、`APPEND_SYSTEM.md`、skills、prompt templates、extensions、settings 和 packages。[当前 Usage](https://pi.dev/docs/latest/usage#context-files) [固定 ResourceLoader 候选与选项](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/resource-loader.ts#L71-L194)

系统提示的组合顺序同样重要：custom/default system prompt 之后仍可追加 append prompt、context 文件、skills 与 cwd。当前 CLI 文档明确说明 `--system-prompt` 只替换默认提示，**context files 和 skills 仍会追加**。skills 段只在 `read` 或 `bash` 工具可用时才追加（固定实现 L165-L169），精确核算输入时须计入这一条件。[当前 CLI](https://pi.dev/docs/latest/usage#other-options) [固定 system-prompt 实现](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/system-prompt.ts#L142-L170)

Project trust 只决定项目 settings/resources/extensions/packages 是否装载。用户级 extension 与命令行 `-e` 在 trust 决定前加载；context files 官方文档写为 trust 决定前加载，固定快照的 resource-loader 实现是在 trust 回调之后加载但不受 trust 结果影响，两种表述结论相同：拒绝 trust 不能隔离 AGENTS/CLAUDE。非交互模式由 `defaultProjectTrust` 或本次 `--approve/--no-approve` 决定项目资源，但这仍不是 context 禁用开关。[当前 Project Trust](https://pi.dev/docs/latest/usage#project-trust) [固定 pre-trust 与回调顺序](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/resource-loader.ts#L380-L404) [固定 context 装载位置](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/resource-loader.ts#L515-L524)

### 3.2 阶段约束对应的可用控制

| 污染来源 | 当前 CLI 明确能力 | 边界 |
|---|---|---|
| AGENTS/CLAUDE 自动发现 | `--no-context-files` / `-nc` | 不处理 SYSTEM、skills、extensions |
| skill 自动发现 | `--no-skills`，同时可用重复 `--skill <path>` 显式加入 | skill 名称/描述会进入系统提示，正文按需加载；显式允许项仍是输入 |
| prompt template 自动发现 | `--no-prompt-templates` + 显式 `--prompt-template` | 模板只展开文本，不执行语义约束 |
| extension 自动发现 | `--no-extensions` + 显式 `-e` | 显式 extension 是同权代码，需可信 |
| 项目资源 | `--no-approve` | 不阻止 context files 和用户/CLI extension |
| session 历史 | 新 session 或 `--no-session` | `--no-session` 只是不保存；资源仍照常装载 |
| system prompt | `--system-prompt` / 自定义 ResourceLoader | CLI 替换后仍追加 context 和 skills |
| tools | `--tools`、`--exclude-tools`、`--no-builtin-tools`、`--no-tools` | 只决定暴露给模型的工具，不是 OS 权限 |

当前官方文档还明确允许把 `--no-*` 与显式资源组合，以便只加入所需资源。[当前 Resource Options](https://pi.dev/docs/latest/usage#resource-options) 这为 M01/P01 和 M06 阅读会话提供了必要原语，但报告不把未经运行验证的 flag 组合写成可直接采用的启动配方。

SDK 的 `createAgentSession()` 默认使用 `DefaultResourceLoader` 做标准发现；要控制输入，需通过真实 options 字段 `resourceLoader` 传入自定义 `ResourceLoader`，不能只使用 in-memory session。[当前 SDK](https://pi.dev/docs/latest/sdk#createagentsession) [固定 SDK 实现](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/sdk.ts#L176-L186)（options 字段见同文件 L78-L79）

### 3.3 会话恢复、压缩与分支摘要

resume、fork、clone、tree navigation 会带入所选 active branch；compaction 用 LLM 摘要替代较旧 active context，branch summary 也会把摘要注入目标分支。摘要是有损输入，不等于原材料。JSONL 中历史仍在，也不意味着模型当前完整可见。[当前 Sessions](https://pi.dev/docs/latest/sessions) [当前 Compaction](https://pi.dev/docs/latest/compaction) [固定 session 上下文构建规则](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/session-format.md#L334-L370) [固定 Sessions 文档：resume/fork/clone](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/sessions.md#L118-L139)

因此，M01/P01 的初始输入隔离和 M06 阅读会话都不能仅凭“fresh session”认定成立。M02 虽使用相同模型的新独立会话，但本来就必须显式接收 M01 完整产出；这里隔离的是未授权历史与自动发现资源，不是隔断 M01→M02 的交接。需要控制的是资源发现、显式提示、工具、cwd、环境变量和 session 来源；M06 还须以实际论文、网页或代码为验收对象，记录实际阅读范围，不能用 compaction 或子任务摘要替代原材料核对。

## 4. M01、M02 与 M02U：同模型、两会话和按需修订

[P01](../../workflow/v1.0/提示词/P01_独立初始认识.txt) 要求在不提前看候选判据的条件下形成初始认识；随后为 [P02](../../workflow/v1.0/提示词/P02_候选判据首次准备.txt) 建立相同模型的新独立会话，只显式传入原问题所需原始信息、P01 完整产出和 P02 指令。[P02U](../../workflow/v1.0/提示词/P02U_候选判据增量修订.txt) 只在新证据或纠错需要时重复，并保留增量与理由。这里要求前后相接的两轮交互，同时以新会话隔开其他历史。

Pi prompt templates 支持 `$1`、`$2`、`$@`、`$ARGUMENTS`、默认值与切片，适合把阶段入口和材料路径参数化。[当前 Prompt Templates](https://pi.dev/docs/latest/prompt-templates) 但模板展开不能保证：

- P01 没有提前看到候选判据或 P02U 的后续材料；
- P01 输出被完整交给随后的 P02；
- P02U 只在需要时触发；
- 修订保留旧判据、变更理由和影响范围；
- 输出满足手册交接格式。

承载时需先取得 P01 完整产出，再显式新建 M02 会话并提交限定输入；不能依赖隐含历史，也不能用 fork/import M01 历史冒充所需的新会话。SDK 可直接创建另一个 `AgentSession`；`AgentSessionRuntime` 虽另有 new/resume/fork/import 等 replacement API，M02 这里只能使用符合“新建会话 + 显式 M01 可见输出”边界的方式。具体采用 SDK、RPC 还是 extension 尚未决定。replacement API 属于 `AgentSessionRuntime` 而非 `AgentSession`；替换后调用方需重新绑定订阅。[当前 SDK：AgentSessionRuntime](https://pi.dev/docs/latest/sdk#createagentsessionruntime-and-agentsessionruntime)

## 5. 主 agent 与有限子任务委派

工作流已经要求主 agent 负责范围、依赖、验收和合入，并把边界清楚的工作交给子任务；待决的是 Pi 中的实现方式、模型路由和并发参数，不是“是否需要委派”。

Pi 核心有意不内建 subagent。[当前设计原则](https://pi.dev/docs/latest/usage#design-principles) 官方仓库提供的是 `examples/extensions/subagent/` 示例：

- 每个任务启动独立 `pi` 子进程，使用 `--mode json -p --no-session`；`--no-session` 只是不保存子 session。
- 父任务 cwd 默认传给子进程，可由任务配置覆盖；它仍共享宿主文件、环境、网络和凭据。
- agent 定义来自用户级目录；project/both scope 才纳入项目 `.pi/agents`，重名时项目定义覆盖。项目 agent 的确认逻辑是 UI 信任提示，不是安全隔离。
- agent 配置未指定模型时，示例继承父 session 当前 model 与 thinking level；只有配置了 tools 时才传 `--tools`，否则子 Pi 使用默认工具集。
- agent prompt 被写入权限为 0600 的临时文件，再通过 `--append-system-prompt` 加入；它不是替换系统提示。
- 示例没有传 `--no-context-files`、`--no-skills` 或 `--no-extensions`，所以独立进程仍按标准规则发现这些资源。
- 支持 single/parallel/chain；parallel 模式限制最多 8 个任务、并发 4，chain 无对应上限；chain 只把上一任务最终输出替换进 `{previous}`。
- abort 发送 SIGTERM 并意图在 5 秒后升级 SIGKILL，但实现以 `proc.killed` 判断，而 Node 在信号成功发送后即置该值为 true，升级通常不会执行；取消不等于子进程已终止。非零退出、error 或 aborted 算失败，chain 在首个失败处停止。
- parallel 模式下父 agent 可见的结果每任务最多 50 KB，single 与 chain 的最终输出不截断；完整 tool details 另存，但摘要交接不能替代 M06 对实际材料或 M08 固定产物的验收。

来源：[固定示例 README](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/examples/extensions/subagent/README.md) [固定进程参数与模型继承](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/examples/extensions/subagent/index.ts#L300-L349) [固定任务执行与 abort](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/examples/extensions/subagent/index.ts#L401-L425) [固定 agent scope](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/examples/extensions/subagent/agents.ts#L116-L146)

结论是：该示例可作为委派实现的参考，但默认仍自动加载资源，可能不满足特定阶段的输入边界；独立进程也不是 sandbox。主 agent 仍需核验子任务真实文件、引用与实验输出，并通过工作流既定的单一串行入口合入。

## 6. M03：自动跨会话质询链

[P03Q/P03A](../../workflow/v1.0/提示词全集.md) 的角色和材料边界保留，但当前已对齐为自动编排：外审模型的新会话读取原问题及 M01/M02 完整产出并生成质询，同时保留自己的评价依据；原 M01 会话收到 M02 完整产出与质询后作答；答案再送回原外审会话评价。出题与评价复用同一外审会话，作答复用原 M01 会话，不把三者合并为一个共享历史。

Pi 已核验的相关原语有限而明确：

- `@file`、stdin 或 read tool 可把指定真实材料送入 Pi；
- SDK `createAgentSession()`、`session.prompt()`、`messages` 与订阅事件可支持新会话和原会话续接；
- `/export` 可导出 session；跨会话传递应使用实际可见文本和指定材料，不能依赖 compaction 摘要或隐藏 thinking；
- 评价返回后，实质研究判断交回 M04 对应的研究会话，首轮可在原 M01 会话之后续接新一轮。

这些原语说明 Pi 可以承载自动搬运，但不决定最终采用 SDK、RPC、extension 还是其他控制器，也不能自动保证材料完整、会话隔离或评价有效。详细调用次数、输入组合与返回关系以 [workflow foundation](workflow-foundation.md) 的当前对齐记录为准。

## 7. M05/M06 与既有 references、notes、knowledge

工作流已经区分：`references` 存外部材料，`knowledge` 存项目解释，`notes` 存工作行为；索引与视图是派生物，不能独立维护事实。当前对齐把 M06 组织为每份资料三个隔离会话：阅读、核对、项目适用性分析；N 份资料的全部结果汇齐后统一回 M04。阅读会话不接收项目期待，适用性分析才接收项目状态；新会话只隔离输入与历史，不证明不同会话的错误统计独立。[分册 02，第 10–16、130–138 行](../../workflow/v1.0/分册/02_图式认识管理_含全部复核修订.md) [完整手册，第 456–510 行](../../workflow/v1.0/科研执行流程_v1.0_完整手册.md)

Pi 可以提供本地文件的 read/grep/find/ls、skills、prompt templates 和事件记录，但不会自动实现上述职责分离。默认工具不含专用 web search、浏览器或 PDF 阅读流程；按既有 M05/M06 还需接入实际的检索、下载和内容提取工具，具体工具选择后议。Skills 的启动扫描会把名称与描述加入 system prompt，正文按需载入；所以 skill 适合表达阅读方法，不等于材料本身，也不天然满足 M06 首轮隔离。[当前 Skills](https://pi.dev/docs/latest/skills) [当前内建工具清单](https://pi.dev/docs/latest/usage#tool-options)

M05 可以阅读摘要、搜索结果相关段落或材料局部内容做初筛；这不等于 M06 对实际所需范围的阅读、核对和适用性分析。M06 也不要求每份资料无差别通读全文；任务要求完整阅读时才需确保完整覆盖，否则必须记录实际阅读范围、未读部分与限制。

session JSONL 是 append-only 对话树。`custom` entry 可存 extension data 但不进入模型，`custom_message` 可进入模型而 details 不进入；compaction 后 active context 会使用摘要。它适合审计线索和对话谱系，不是 references/knowledge 的权威版本库。[固定 Session Format](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/session-format.md#L291-L370)

## 8. M04：C/K/E/J/Q/D/X 与知识更新协议

当前对齐还明确：M03 评价或 M06 全组结果返回后，实质研究判断交给研究会话中的 M04。第一次 M04 可沿用原 M01 会话继续交互，以免重复搬运其既有推理；后续 M04 默认新建研究会话，只读取完成本次判断所需的项目状态和实际材料。这个会话关系不改变下面的权威知识更新协议，也不表示 Pi session 自身就是知识库。

既有图式已经定义 C/K/E/J/Q/D/X，尤其 J 表示支持/反对理由，D 表示当前用途；关闭 Q 不等于证明。依据状况、历史使用决定和派生当前可用性必须分离。更新时上游变化和下游待复核同发，停用优先；完整更新失败、回滚或历史回放不得取消已知限制；合入只能经过单一串行入口，并重新检查读依赖、关系和“没有开放质疑”等条件。[分册 02，第 20–32、60–80、98–128 行](../../workflow/v1.0/分册/02_图式认识管理_含全部复核修订.md)

Pi 0.85.1 默认 session 路径没有这些知识事务语义：

- `appendEntry` 追加单个 custom entry，extension 要在 `session_start` 扫描并重建自有状态；`ctx.sessionManager` 对 extension 是只读 view。[固定 Extensions](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/extensions.md#L1482-L1497)
- 默认 SessionManager 先改内存再持久化单条 entry；没有提供 C/K/E/J/Q/D/X 整体发布、读依赖复查、停用跨分支强制继承或串行合入事务。[固定 SessionManager](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/session-manager.ts#L1004-L1074)
- RPC 提供 prompt、状态、session navigation、`get_entries`/`get_tree` 等命令，没有知识事务或 append custom entry 命令。[固定 RPC 类型](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L74)
- SDK 可用 in-memory、create/open session，也能将外部 DB entries 载入内存；这说明外部 authority 可接入，不表示 Pi 已替项目实现知识协议。[固定 SDK](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/sdk.md#L755-L800)

这个结论只针对 Pi 0.85.1 默认 JSONL session 和已核验 API，不推广为所有自定义 backend 都不可能支持事务。固定快照另含 `packages/session-backends/sqlite-node`（0.85.1）：它为 pi-agent-core 提供序列化提交队列和单事务批量写入，但 coding-agent 不依赖它，它没有跨进程锁或 fence，也没有实现本项目的知识协议；它只说明快照内存在事务原语，不说明默认路径具备这些语义。[固定 backend README 与跨进程边界](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/session-backends/sqlite-node/README.md#L1-L33) [固定提交队列](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/session-backends/sqlite-node/src/sqlite/storage.ts#L49-L74) [固定批量事务](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/session-backends/sqlite-node/src/sqlite/storage.ts#L163-L174) 真正待实现的是把**已有**知识规则映射到受控存储与合入程序，而不是重新决定要不要知识系统。

Tool event 可以做合作式 gate：`tool_call` 在执行前修改参数或阻断，`tool_result` 在执行后修改结果；默认 parallel 模式下同批 sibling tools 在各自 preflight 后并发（工具可标记 sequential），文档只保证 handler 不一定能看到同批其他结果，改参后也不重新做 schema 校验。[固定 Tool Events](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/extensions.md#L781-L855) [固定 per-tool sequential 字段](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/extensions/types.ts#L462-L479) [固定执行分支](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/agent/src/agent-loop.ts#L465-L478) 同权 extension、直接 SDK 或外部进程仍可绕过 hook，所以它不能单独承担知识库的强制串行入口或权限边界。

## 9. M07：长实验和完成事实

Pi 的同步 `bash` 可以执行并等待适合单次交互内完成的任务；Pi 明确不内建 background bash。对需要异步运行、跨会话观察或可靠恢复的长作业，才需要 extension/package 或外部 runner、tmux、调度器等补足生命周期管理。[当前设计原则](https://pi.dev/docs/latest/usage#design-principles) 官方 tmux 文档讲终端按键设置，并不是作业调度器。

对于同步任务，Pi 可直接等待 `bash` 结果；对于异步或跨会话长作业，runner/调度器应提供进程或作业 ID、命令与环境、开始/结束时间、退出码、日志、指标和产物完整性。Pi 可发起、观察、读回和核验这些事实，但：

- print 模式退出只说明该 Pi 进程结束；
- RPC `prompt` 的成功响应只表示请求已接收/处理，后续错误从事件流出现；
- `agent_end` 后仍可能有重试、压缩或排队继续；
- `agent_settled` 只表示当前 session run 已沉降；
- subagent exit 0 也不证明科研验收条件成立。

因此必须由 M07 的实际实验材料与验收条件决定完成，不能把 agent 的自然语言或生命周期事件直接写成成功。[当前 RPC](https://pi.dev/docs/latest/rpc)

## 10. M08：固定真实研究材料

M08/M09 是用户委托按原 workflow 方式补齐的当前暂定安排，并非像 M01–M07 一样逐项确认。当前 M08 默认由主 agent 把整体自查拆成具体独立任务，汇齐后让独立外审任务读取同一固定版本，全部返回再统一进入 M04；修改后按影响范围复审。自动组织独立任务是当前默认，不需要重新退回手工搬运，但 reviewer 数量、模型、并发和具体 Pi 接口仍未决定。

Pi session 有 entry id/parentId、tree、fork、clone、JSONL 和 export，适合记录“谁在何种上下文做了什么”。但 M08 要固定的是实际代码、数据版本、references、knowledge 快照、命令、环境、日志、指标和成果文件。对话分叉不能固定这些外部对象，独立会话也不自动保证审查独立或有效。

`get_entries` 还能返回压缩前历史和已放弃分支；这有利于审计，却意味着读取者必须区分 append order、active branch 与正式阶段材料。M08 应以工作流规定的真实文件/快照/CURRENT 为准，session id 与 entry id 仅作关联证据。[固定 RPC entries/tree](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/rpc.md#L717-L760)

## 11. M09：停止，不自动开启新目标

当前暂定安排先自动组织独立的成果整理任务和独立的交付复核任务；两者全部返回后，由主 agent 汇总研究完成程度、交付状态、实际核验覆盖、未决、限制、关键产物和恢复入口，再给回执并结束当前目标。Pi 的具体委派接口、会话数量和模型仍未决定。

Pi 提供 `/quit`、abort、queue 操作、RPC shutdown 等进程控制。它也允许 steering/follow-up 队列和 extension 在事件后继续发送消息。这些能力不理解 M09 的业务停止语义。

承载时需要主 agent 在 M09 结论中明确阶段已收口、剩余项如何记录，并禁止自动把“下一步建议”转成新目标或继续执行。M09 之后是否启动新任务必须由用户新的明确意图触发；清空队列或关闭进程只能作为实现动作，不能替代这条规则。

## 12. 模型、SDK/RPC、环境与权限边界

Pi 支持多 provider/model、thinking level 和交互切换；extension 也可注册 provider。[Providers](https://pi.dev/docs/latest/providers) [Models](https://pi.dev/docs/latest/models) 这可支持不同子任务的模型路由，但模型选择、交叉复核和并发值仍需按工作流阶段验证，切换模型本身不产生独立性或可靠性保证。

CLI/RPC 会设置 `AI_AGENT=pi`、`PI_CODING_AGENT=true`；shell tool 还暴露 session/provider/model/reasoning 等 Pi 环境变量。SDK 不会自动设置所有这些标记。环境变量本身也可能向“独立阅读”交互透露阶段或模型信息，实施时需要纳入输入清单。[当前 Environment Variables](https://pi.dev/docs/latest/environment-variables)

SDK 适合 Node 控制器；RPC 适合语言无关的 stdin/stdout JSONL 控制器；JSON mode 适合事件审计。三者都不会自动实现工作流状态、知识事务或科研验收。

Pi 官方明确没有内建文件系统、进程、网络或凭据权限系统，也没有 sandbox；extension 是可执行任意 Node/TypeScript 的同权代码。[当前 Security](https://pi.dev/docs/latest/security) Project trust、tools allowlist、tool hook 和确认 UI 都不是强隔离。如需限制宿主权限，应采用受控工具/存储、最小凭据以及容器或 VM 等外部边界，并按实际任务决定挂载和网络策略。

MCP 不是 Pi 核心内建能力，可通过 package/extension 增加；当前工作流的主要缺口不依赖 MCP，故本轮不展开第三方实现。

## 13. 按既有需求归类

| 既有需求 | Pi 内建/可配置 | 仍需项目实现或验证 |
|---|---|---|
| M01/P01、M06 输入隔离 | 资源发现开关、自定义 ResourceLoader、新/内存 session、工具白名单 | 阶段白名单、环境/cwd 控制、无污染证据与实测 |
| M01→M02、M02U | 可新建同模型 session；SDK/RPC/extension 均有可用原语 | M02 限定输入、P01 完整输出交接、按需触发 P02U、修订理由与验收；具体架构未定 |
| 主 agent + 有限委派 | 核心无 subagent；有官方示例 extension | 可靠编排、默认自动加载资源的边界控制、模型/并发/失败传播、主 agent 文件验收 |
| M03 自动质询链 | 新建/续接 session、文件输入、read/export、SDK prompt/messages/events | 原 M01 与原外审会话的正确续接、完整可见文本搬运、评价依据隔离；具体控制器未定 |
| M04 知识协议 | session/custom entry/tool events 可作接口 | 既有 C/K/E/J/Q/D/X、三状态、停用优先、串行合入与条件复查 |
| M05/M06 材料处理 | 本地 read/grep/find/ls、skills/templates、新 session | 实际检索/下载/提取工具；每资料阅读—核对—适用性三会话组；全组汇齐回 M04；具体架构未定 |
| M07 实验 | 同步 bash；外部 tmux/runner 可接 | 异步/跨会话长作业的事实源、环境与产物、验收判定、异常恢复 |
| M08 暂定自查与外审 | session ids/tree/export、新 session | 同版本真实材料、自查任务与独立外审全返统一 M04、影响范围复审；reviewer/模型/接口未定 |
| M09 暂定整理与收口 | session 与委派原语、quit/abort/queue/shutdown | 独立整理与交付复核汇齐、主 agent 回执/恢复入口、停止当前目标且不自动新目标；具体接口未定 |
| 权限限制 | 无内建 sandbox；可限工具 | 需要时用 Pi 外部安全边界；hook 仅合作式 gate |

## 14. 本轮未实测的关键接口

以下是调研结论的运行验证缺口，不是新增 workflow 阶段或默认测试计划：

- 固定 0.85.1 下，CLI 资源禁用/显式加入与 SDK `resourceLoader` 最终形成的实际输入；
- 官方 subagent 示例的资源继承、失败传播和 50 KB 父任务交接边界；
- 同步 `bash` 与未来可能选择的异步 runner 如何回填真实完成证据；
- 既有知识合入协议和 M09 停止语义通过何种受控接口落地。

## 15. 已核验、推断和待验证

**已核验：** repo/package/commit 身份；资源发现和禁用开关；trust 与 context 的关系；system prompt 组合；session/tree/fork/compaction；prompt 参数；SDK runtime 边界；RPC/events；官方 subagent 示例实现；无内建 MCP/subagent/permission popups/plan/todo/background bash/sandbox；默认 JSONL session 未提供既有知识事务语义。

**基于源码和工作流的判断：** 显式资源白名单与自定义 `ResourceLoader` 是输入隔离的可用原语；session 更适合对话谱系而非权威知识库；tool hook 可做合作式 gate；异步或跨会话长实验需要 Pi 之外的生命周期事实源。

**待运行验证：** 固定 0.85.1 的完整启动输入、SDK `resourceLoader` 组合、subagent 故障传播、可能采用的异步 runner 适配、知识合入程序、M09 停止守卫、模型路由与成本。自我改进采用人工批准、受控自动采用还是其他自治等级，用户尚未决定，本报告不设默认方案。

## 16. 官方来源索引

- [Pi 文档](https://pi.dev/docs/latest)；[Usage](https://pi.dev/docs/latest/usage)；[Security](https://pi.dev/docs/latest/security)
- [Skills](https://pi.dev/docs/latest/skills)；[Prompt Templates](https://pi.dev/docs/latest/prompt-templates)；[Extensions](https://pi.dev/docs/latest/extensions)
- [Sessions](https://pi.dev/docs/latest/sessions)；[Compaction](https://pi.dev/docs/latest/compaction)；[Session Format](https://pi.dev/docs/latest/session-format)
- [SDK](https://pi.dev/docs/latest/sdk)；[RPC](https://pi.dev/docs/latest/rpc)；[JSON mode](https://pi.dev/docs/latest/json)
- [Providers](https://pi.dev/docs/latest/providers)；[Models](https://pi.dev/docs/latest/models)；[Environment Variables](https://pi.dev/docs/latest/environment-variables)
- [固定提交](https://github.com/earendil-works/pi/tree/e4c75a73222ae2c72abb5f5314fa35ee8effc508)；[固定 subagent 示例](https://github.com/earendil-works/pi/tree/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/examples/extensions/subagent)
