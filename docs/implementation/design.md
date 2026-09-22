# 研究 harness 实现设计（v0.1）

> 状态：实现中。原始语义以 [`workflow/v1.0`](../../workflow/v1.0/README.md) 为准，当前阶段安排以 [`workflow-foundation.md`](../research/workflow-foundation.md) 的“当前对齐”为准。本文记录代码怎样承载这些规则、做了哪些工程决定、哪些仍未决定。它不改写工作流，也不声称科研效果已验证。

## 1. 决定与理由

| 决定 | 内容 | 理由 | 可逆性 |
|---|---|---|---|
| 承载方式 | TypeScript 控制器直接使用本地 `third_party/pi` 的 Pi 0.85.1 SDK（`createAgentSession`），不用 RPC 子进程；`extensions/research.ts` 是显式加载的薄入口 | SDK 提供自定义 `ResourceLoader`（真实输入隔离）、`SessionManager.create/open`（持久会话与续接）、原生/自定义工具白名单、按会话指定模型；这些是 M01–M09 所需原语，见 [`pi-harness.md`](../research/pi-harness.md) 第 3–8 节 | 高：`SessionRunner` 和 `ResearchService` 隔离 SDK 与 extension 接口 |
| 模型 | 每个实际运行子会话的角色模型来自工作区 `research.config.json`，写法 `provider/model[:thinking]`；harness 不预设任何模型。只有会启动模型会话的操作要求该配置，M07 goal/status/plan/decision/review/finish/interrupt 等纯状态操作不要求 | 用户尚未选定模型，且明确 Claude 不采用；选型是用户决定 | 高 |
| M03 评审成员 | 工作区可选 `m03Reviewers: [{ id, model }]` 显式列出成员；每项 `model` 直接写完整 `provider/model[:thinking]` 引用，可重复。只有缺省列表时才回退 `roles.reviewer`/`roles.default` 的原有单 reviewer 路径 | 允许当前用三个独立 DeepSeek 会话实验多成员编排，同时不把同模型会话误称为多模型验证，也不固定全局成员数量 | 高 |
| 主 Agent | 一个交互式 Pi 主会话通过 `research_*` extension 工具读取状态、运行 M01–M06/M08/M09、管理 M07 目标、动态委派并验收；CLI 也可直接运行这些阶段，但仍是直接阶段入口，不经过 extension 的主会话激活、能力门禁、有限重试或正常 shutdown 记录 | Pi 核心没有内建 subagent；独立任务用新建 SDK session 实现，不再造第二个主 Agent。extension 不替换主会话模型 | 高 |
| 提示词 | 运行时直接读取 `workflow/v1.0/提示词/*.txt`，不复制进代码 | 提示词是用户自有工作流的一部分，单一来源 | — |
| 知识库 | 文件式：`records/<ID>/v<N>.md`、`proposals/`、`snapshots/`、`CURRENT`、`limits.json`、派生 `views/` 与 `_index/`；单一串行合入入口；停用先行；不使用任何哈希 | 手册第七章第一版形态即文件式；用户明令不引入哈希清单 | 中：接口 `KnowledgeStore` 可换后端 |
| M08/M09 | M08 每轮复制并固定原问题、必要输入、当前知识和调用方选定成果；调用方显式列出自查和 reviewer。完整批次可送 fresh M04 生成受校验的用途处置。M09 只消费严格配对的 M08/M04，按该处置允许范围建立说明和交付副本并独立复核 | 保持暂定流程的版本同一性、完整批次和不以一致性作证据；M04 的结构化处置是 M09 范围门槛 | 中 |
| M05 | 以 `AcquisitionBackend` 提供可替换的搜索、抓取、下载、浏览器与 PDF 能力。默认检索包括 OpenAlex、arXiv、Crossref、Hacker News、Stack Exchange、GitHub 仓库与 Issues、DuckDuckGo；Reddit 为显式选择项，Brave 需密钥。搜索支持提供方适用范围内的 page/cursor/site 参数并如实警告未支持参数；Hacker News 同时保留文章与讨论地址。任意 HTTP(S) 地址可直接抓取或下载，Crawl4AI 用于浏览器渲染抓取，browser-use 用于适合交互、翻页、展开与下载的定点任务，不固定为最后手段。PDF 仅用 poppler 的文本层与按页图像。Docling 与 SearXNG 已因“不在本地跑模型、不用 Docker”而移除 | 用户 2026-09-20 的选择与任务范围完整性要求；提供通用入口但不作全网穷尽或任意站点必然成功的保证 | 高：默认集合可由配置取子集，各能力可经接口替换 |

## 2. 阶段到会话的映射

| 阶段 | 会话 | 角色 | 工具 | 输入 | 产物 |
|---|---|---|---|---|---|
| M01 | 新会话 `M01` | execution | 无 | P01 + 原始问题 + 必要原始信息（文本） | `initial-understanding.md` |
| M02 | 新会话 `M02`（与 M01 相同模型，不继承历史） | execution | 无 | P02 + 原始材料 + M01 完整产出 + 保存约定 | `criteria-candidates.md`，K 候选入库 |
| M03 | 每个显式成员各建独立 reviewer 会话出题；收齐后续接同一 `M01` 按成员串行作答；各 reviewer 只在自己的原会话评价自己的答案。缺省配置沿用单 reviewer | 成员项直接指定的模型 / execution / 同一成员模型 | 无 | 各 reviewer：P03Q + 同一冻结材料 + M01 + M02；M01：逐组可转发问题，M02 完整产出仅首组附带；各 reviewer：P03A + 自己那组完整回答 | 按成员保存问题、依据、回答和评价；完整批次汇总产物 |
| M04 | 有合格 M01 基线且尚无既往 M04 时可续接 `M01`；M07/M08 反馈和其他不满足基线资格的情况使用新会话 `M04-research` | execution / research | 普通处理无工具；M08 反馈会话只读该轮 frozen root，可读取待处置材料和按需渲染 PDF 页 | P04 + 意见 + 产物位置（新会话另加原始问题与局部知识包）；M08 处置须实际访问准备列为可交付的固定材料 | `processing.md`、知识提案、`merge.json`；M08 另有访问覆盖与 `m08-disposition.json` |
| M05 | 新会话 `M05` | acquisition | 自定义工具：web_search、find_open_access、fetch_page、list_page_links、download_file、extract_pdf、render_pdf_page、read_work_file、view_work_image、register_source、list_sources（配置了 browser-use 模型时另有 browse_interactive）；文件访问限定在本轮 `references/_work/<run>/` 与已登记来源 | P05 + 本轮目标 + 原始材料 + 局部知识包（C/K/Q/X）+ 已有索引 + 工具规则 | `acquisition-report.md`、`tool-log.jsonl`、`references/search/R###-<run>.md`、供 M06 使用的新登记 `sources/S###/` |
| M06 | 每份资料三个新会话：`-reader`、`-checker`、`-applicability` | reader / checker / applicability | 前两者：限定在资料目录的只读工具 + `render_pdf_page`（把 PDF 单页渲染成图片直接返回，供多模态模型看公式、表格、图和扫描页）；第三者：无 | 材料 + 阅读要求；材料 + 阅读记录；经核对内容 + 同一份项目状态 | 每组三份记录、`batch-summary.md`、`batch.json` |
| M07 | 每个动态子任务一个新会话 `M07-T###`；主会话只通过工具组织与验收 | execute/reason 为 execution，check 为 reviewer | execute：Pi 原生 read/write/edit/bash，cwd 为任务 work 目录；check：任务目录只读；reason：无工具 | 冻结目标、约束、成功要求、显式输入副本、局部知识包、预期产物与 checks | 自动保存的任务报告、execute 的 work 文件、逐项 review、目标状态与 `m04-feedback.md` |
| M08 | 调用方拆分的自查各一新会话；全部自查成功后，显式 reviewer 列表各一新会话 | 自查用 reviewer；外审角色由调用方从工作区角色中明确选择 | read-only 只读同一 frozen 目录；execute 只操作各自 verification 副本 | 同一固定版本的原问题、输入、知识和成果；未提供范围显式列出 | `manifest.json`、各报告与覆盖、完整 `review-bundle.md/json` |
| M09 | 新建成果说明会话与独立交付复核会话 | execution / checker | 说明只读固定材料；checker 只读 verification copy，并只能通过 `run_reproduction_check(index)` 让控制器执行预授权命令。原始 shell 留在私有审计，不进入 checker prompt；checker 可读移除命令文本但保留真实 stdout/stderr 的执行日志 | 严格配对的 M08 manifest 与 M04 `m08-disposition`；接收者、用途、允许范围、复核模式 | 源到副本追踪、成果说明、复核报告与覆盖、requested/actual 执行摘要、`M09 收口回执` |

“新会话”= 新的 `SessionManager` 文件 + 全部资源发现关闭（无 context 文件、skills、extensions、prompt templates、APPEND_SYSTEM）+ 空 agentDir + 内存 settings；M01–M06 的无工具/自定义工具会话使用空 scratch cwd，M07 execute 的 SDK cwd 明确设为该任务 work 目录，M08 execute 与 M09 执行复核只在各自 verification 副本中运行。系统提示由角色边界句（见 `src/prompts.ts` 的 `ROLE_SYSTEM_PROMPTS`）和统一的不可信数据边界组成；材料、shell 注释、stdout/stderr 和工具返回仍会作为待核对数据进入上下文，提示只能降低其指令注入影响，不能构成模型行为保证。会话之间只通过控制器显式搬运的可见文本交接。execution 工具集合是能力白名单而不是 OS 沙箱；尤其 bash 仍有当前进程权限，因此不能把 cwd 写成根目录强制隔离。

M07 先冻结原问题副本、目标关系、约束、成功要求、计划和当前正式 M04/知识快照。正式基线只取时间上最新的 M04；若该运行未 completed、含失败、产生未成功合入的知识提案，或其合入结果不能确定快照，就不回退旧 M04，调用方只能先修复或显式开始 exploratory 目标。正式目标在委派和声明 fulfilled 前再次确认该 M04/知识快照仍是最新；新 M04 出现后须显式刷新基线。基线失效时仍允许把目标按 blocked/partial 如实返回 M04，但会降为非正式探索状态并记录限制，不能声称原目标完成。输入文件被复制到任务目录。execute 必须明确至少一个预期文件且路径落在自己的 work 目录；若涉及真实提交、评测或远程实验，先做可用的本地语法、类型、编译与兼容性预检，并记录真实动作的成功、失败、配额消耗和已知恢复条件；未知配额不猜测。check/reason 可以不声明额外文件，但自动保存的 `report.md` 是必须实际提交和检查的产物。任务返回只进入 `returned`，主 Agent 须读取实际产物并用 `research_review` 逐项记录预定义 checks。通过要求每个 check 为 passed 且有文件证据、无失败和未执行项，并提交全部预期产物；验收时冻结被采用的产物、本任务报告与独立 checker 报告。声明需要独立检查时，check 任务取得的是待查材料副本，采用前还会核对它确实对应当前提交版本；反馈包只读取这些验收时固定的副本，避免把之后可变的报告混入正式反馈。这里不使用文件哈希清单。

任务失败、拒绝、工具日志和未执行项一直保留。返工任务只有在 objective、checks、expectedOutputs、mode、独立检查要求及输入材料版本保持同一义务时才能声明 `supersedesTaskId`；不能借替代降级执行模式、取消独立检查或更换输入。沿递归替代链的新任务被接受后，链上旧失败才不再阻止 fulfilled，但历史不会删除。结束目标时必须逐项映射原始 successCriteria；fulfilled 要求每项原目标标准 passed 且有来自已接受任务的固定文件证据、没有开放用户决定、至少有一个实际任务，并且每个当前有效任务义务均已 accepted；历史上已被合法替代的失败任务仍保持原状态。

`m04-feedback.md` 汇入全部任务状态、执行失败、检查、限制、工具日志和实际文本材料；二进制材料只声明存在与读取事实。M07 反馈进入 M04 时强制建立 fresh research 会话，不能续接 M01 或其他旧会话来吸收这些执行结果。

## 3. 控制器自写的文本

以下文本不来自用户提示词，而是控制器为落实边界而加的，可被审阅与替换：

- 角色系统提示 `ROLE_SYSTEM_PROMPTS`（七种角色各一段）。
- 材料标签 `【原始问题】`、`【必要原始信息：…】`、`【初始认识（…）】` 等。
- M03 每个成员的出题格式要求：两个一级标题 `# 可转发问题` / `# 出题说明与判断依据`，缺一则该成员失败且整批不能静默跳过。
- M03 作答框架 `【第三轮：回答外部质询】`（原 v1 无专用答题提示词，只转发问题；首组补一句说明 M02 产出的来源与“题目可被纠正”，后续组不重复附带 M02 完整产出）。
- M02/M04 的 `knowledge-proposals` 代码块约定（JSON 操作数组）。
- M05 的工具规则与报告小节要求（`buildM05Message`），以及各工具的描述文字。
- M06 三类任务框架（依据手册第十章 1–3 节改写为面向阅读者/核对者/适用性会话的任务说明）。
- M08 自查任务框架、外审固定材料说明、材料清单与整批反馈声明；reviewer 数量和角色不由 harness 默认决定。
- M09 加载原 workflow 的完整 P09，再附接接收者/用途说明、交付副本复核边界与收口回执要求。整理与复核共用由控制器校验的机器 schema：`status` 为 `checked | partial | needs_fix | blocked`；`scope`、`unresolved`、`evidence` 是字符串数组，可选 `nonBlockingLimitations` 只保存已明确确认但不阻塞当前交付范围的限制，不由 `unresolved` 自动转换。`checked` 只允许空 `unresolved`；只有 M04 处置为 `partial` 时才允许 `partial`，且必须保留真实非空 `unresolved`，表示受控部分交付而不是把它改写成非阻塞限制。checker 没有自由 bash，只看到预授权命令索引；原始命令留在根外私有审计，实际 exit/stdout/stderr 以不含命令文本的日志放入 checker 受控根。source trace 和每个已执行命令日志都必须被实际读取，命令不能静默改写控制证据。请求索引与实际执行（包括未执行、取消或失败）在解析模型机器块前先落盘，因此门禁失败也保留事实。计算命令应把结果写入新路径；verification copy 中原交付文件或既有控制证据被改写或删除时拒绝收口，新增核验输出则保留为实际覆盖。调用方可用 `pdfPages` 指定 included PDF 必查页，省略时要求覆盖 included PDF 全部页；完整复算模式只记录请求和实际命令覆盖，不认证完整复现。

## 4. 知识库语义

- 七类记录 C/K/E/J/Q/D/X，身份 `C001`，版本 `C001@2`；实质修订产生新版本，旧版本文件永不改写。
- 三种状态分开：`evidenceStatus`（依据状况）、`usageDecision`（历史使用决定，改变即新版本并生成 D 记录）、`availability`（读取时派生，不存储）。
- 关系带含义（premise_of/supports/refutes/limits/questions/checks/handles/replaces/splits/applies_in/located_in），只在拥有方写入。
- 提案 → 结构校验 → 在当前状态复查 → 先写限制 → 应用 → 影响分析只传播 `needs_recheck` → 发布快照 `G###` → 移动 `CURRENT`。任一步结构非法则整批拒绝，不留半发布状态。
- 入库、关闭 Q、采用决定都不是科学认证；视图与索引只由记录派生。

## 5. 未决与未做

- 模型选择与路由、并发数、预算：由 `research.config.json` 决定，harness 无默认。
- M05：browser-use 需在配置中指定模型与对应 API 密钥；当前 wrapper 只接 OpenAI/Anthropic，并新建无既有 profile/login state 的 headless `BrowserSession`，尚未接入用户已有浏览器会话或凭据管理，不能据此假定登录站点普遍可用。它会在同一浏览器任务会话内逐步保存发生变化的 DOM、正文、截图和下载，失败或超时前的有效文件仍保留；`result.md` 是浏览器模型报告，不能登记为外部原始材料。每个实际材料文件可记录 URL、标题、取得时间、内容类型、材料类型和派生关系。默认上限为 20 个页面状态、12 张截图、HTML 合计 5 MB、正文合计 2 MB、登记入材料的下载合计 250 MB；该下载上限不是浏览器写盘的硬配额。触限会明确警告，因此成功也不等于材料完整。Brave 密钥可选；DuckDuckGo HTML 没有可靠的 API 翻页实现，可改用浏览器继续。所有站点与论坛都只按本轮任务保存所需范围，不自动递归取得全部帖子，也不保证任意网站均能取得。Crawl4AI 与 browser-use 不运行本地模型；PDF 页面图像要求 reader/checker 角色使用多模态模型，长材料分块仍未实现。
- M07 通过显式 Pi extension 接入，但目前每次工具调用同步等待完成，没有 detached/异步 job、断线后自动重跑或进程重启后的 running 任务续跑。中断后仍记录为 running 的任务新增 `research_goal action=interrupt` 受控归档：显式记为 failed 并记录原因，目标以 blocked 收口、写入反馈包；仍不自动重跑或假称完成。取消会传到 Pi 会话；SDK abort 的失败会作为失败报告，已有外部 HTTP/browser 工具是否即时停下取决于其自身 signal 支持，不能承诺所有外部动作瞬停。M07 execution 会话禁止 resume，避免后续无声扩大工具范围；目标状态可恢复查看，已结束目标不能自动重跑。
- 非交互限制：print/json 单次模式不能收集用户回答；`research_goal decision request` 在这类模式下必须拒绝。主 Pi 应继续有界实验，或在额度、权限、凭据、平台硬阻塞时 finish outcome=blocked/partial 并如实报告，不得输出 A/B/C 等选项停住等待输入。
- 工作流控制：`npm run workflow:control -- status|pause|resume|stop --pid-file <run.pid>` 提供进程级暂停、恢复与停止。`pause`/`resume` 使用 SIGSTOP/SIGCONT；暂停期间 top-level watchdog 与子会话 watchdog 会把异常长的计时器间隔视为暂停而不是无进展。长时间暂停后 provider/transport 可能已断开，恢复不保证继续同一请求；SIGKILL 或进程崩溃仍不保证收口。
- M08/M09 当前按已授权的暂定流程实现；真实 reviewer 数量、模型组合、预算和领域检查策略仍由工作区配置与调用方决定。M08 完成不等于科研通过；M04 的 `m08-disposition` 可能是 partial/rework/needs_evidence/unresolved，只有 ready/partial、明确列出 deliverable paths 且本会话实际访问相应固定材料才可进入 M09。M09 在生成 running facts 后再次执行最终知识限制检查，再写收口；这缩小同进程检查窗口，但不构成跨进程原子事务。M09 不自动公开、投稿、外发、压包、启动下一目标或 RSI，也不把 `full-recomputation` 请求写成完整复现已验证。
- 知识库合入有锁文件保护；M07 service 的工作区 mutation 互斥只覆盖当前 Pi 进程，不能声称是跨进程任务锁，多机协调不在范围。
- 已进行一次真实题目的主 Pi 工作流试跑并取得局部阶段结果，但试跑暴露了控制、知识提案与 M09 交付协议缺口，且没有严格完整通过 M01–M09；它不能作为通用科研效果或完整流程已验证的证据。离线自动测试仍使用脚本化假会话与真实文件存储。

## 6. 运行入口

```bash
# 在仓库根目录；依赖通过 node_modules 符号链接指向 third_party/pi（不入库）
npm test            # node --test，全部使用假会话，不调用模型
npm run typecheck   # tsc --noEmit
node src/cli.ts init --workspace <dir>
node src/cli.ts m01 --workspace <dir>          # 需要 research.config.json
node src/cli.ts m02 --workspace <dir>
node src/cli.ts m03 --workspace <dir>
node src/cli.ts m04 --from M03 --workspace <dir>
node src/cli.ts m05 --goal "本轮知识需求" --workspace <dir>   # 检索、抓取、下载、PDF 提取、初筛、登记来源
node src/cli.ts m06 --workspace <dir>          # 读取已登记的 references/sources/S###/（文本或提取后的 markdown）
node src/cli.ts m04 --from M06 --workspace <dir>
node src/cli.ts m08 --materials materials.json --self-checks self-checks.json --reviewers reviewers.json --workspace <dir>
node src/cli.ts m09 --m08 <runId> --m04 <runId> --recipient <text> --purpose <text> --delivery-scope scope.json --reproduction reproduction.json --workspace <dir>
node src/cli.ts status --workspace <dir>
pi -e ./extensions/research.ts                         # 显式加载主会话入口
```

`--runner fake` 让任何命令走脚本化假会话（用于演练目录与产物结构，不产生科研内容）。

Pi extension 注册 `research_status`、`research_init`、`research_stage`、`research_goal`、`research_delegate` 与 `research_review`，并提供 `/research status [workspace]` 与 `/research off`。bootstrap、`research_status`、`research_init` 和 M07 `status` 只准备或查看状态，不激活 P07；第一次成功的实质阶段、目标变更、委派或验收操作才在当前 Pi session 和对应 cwd 上激活。激活后，主 Pi 的工具调用限于 `research_*` 编排工具以及 read/grep/find/ls 只读检查，其他工具由 extension 阻断；实现、平台操作和其他副作用应进入有界 M07 任务。失败调用不激活，切换 session 或 cwd 不继承，`/research off` 可显式停用。extension service 对同一失败类别和同一受控义务的重复阶段调用作有限阻断；改变纳入指纹的实际输入、证据、scope、配对 run 或授权命令计划才形成新义务。接收者/用途的自由文本刻意不参与指纹，避免通过改写措辞绕过阻断；若它们发生实质变化，调用方须用新的有效处置或输入表达新的交付义务。该保护只覆盖经 `ResearchService.runStage` 的 extension 路径，当前 CLI 仍直接调用各阶段函数，因此不具备这项重试保护。正常 `session_shutdown` 会让拥有当前 stage 操作的 service 按其在该 workspace 中已经登记的全部精确 stage/runId，把仍为 running 的 run 记为 failed，晚返回不能再覆盖成 completed；M08 显式转交 M04 时两个 run 都可被登记。M07 `research_delegate` 不经过 `runStage`，因此目前不在这项 shutdown run 记录机制内。SIGKILL、进程崩溃、跨进程恢复和自动重放同样不在保证内。它不调用 `setModel`，因此不会替换用户当前主会话模型。只有会新建阶段或任务模型会话的操作才读取 `research.config.json` 对应角色模型并在缺配置时拒绝；目标状态和验收等非模型操作可在没有模型配置时执行。

M05 的外部工具：`scripts/setup-tools.sh` 建立 `.venv` 并安装 Crawl4AI、browser-use 与 Playwright Chromium headless shell（不含任何本地 ML 模型，不需要 Docker）；检索来源可用 `tools.searchProviders` 限定为默认集合的子集，`tools.braveApiKey` 可选；`tools.browserUseModel` 指定 browser-use 的模型后交互式抓取才可用；PDF 只依赖本机 poppler（pdftotext、pdftoppm、pdfinfo），`tools.pageImageDpi` 可调页图分辨率（默认 110）。Python 工具缺席时网页抓取退化为纯 HTTP 并记录实际引擎；公共 HTTP 搜索与 PDF 工具按各自依赖继续工作。
