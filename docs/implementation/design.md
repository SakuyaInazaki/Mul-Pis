# 研究 harness 实现设计（v0.1）

> 状态：实现中。原始语义以 [`workflow/v1.0`](../../workflow/v1.0/README.md) 为准，当前阶段安排以 [`workflow-foundation.md`](../research/workflow-foundation.md) 的“当前对齐”为准。本文记录代码怎样承载这些规则、做了哪些工程决定、哪些仍未决定。它不改写工作流，也不声称科研效果已验证。

## 1. 决定与理由

| 决定 | 内容 | 理由 | 可逆性 |
|---|---|---|---|
| 承载方式 | TypeScript 控制器直接使用本地 `third_party/pi` 的 Pi 0.85.1 SDK（`createAgentSession`），不用 RPC 子进程，不先做 extension | SDK 提供自定义 `ResourceLoader`（真实输入隔离）、`SessionManager.create/open`（持久会话与续接）、`tools`/`customTools` 白名单（限定只读工具）、按会话指定模型；这些正是 M01–M06 对齐所需的原语，见 [`pi-harness.md`](../research/pi-harness.md) 第 3–8 节 | 高：`SessionRunner` 接口把 SDK 细节隔离在 `src/runner/pi.ts`，日后可换 RPC 或 extension |
| 模型 | 每个角色的模型来自工作区 `research.config.json`，写法 `provider/model[:thinking]`；harness 不预设任何模型，缺配置即拒绝运行 | 用户尚未选定模型，且明确 Claude 不采用；选型是用户决定 | 高 |
| 主 Agent | 当前由用户或一个交互式 Pi 会话通过 CLI 驱动各阶段；控制器承担“委派”语义 | Pi 核心无 subagent；先把阶段编排做对，再决定是否包成 extension 工具 | 高 |
| 提示词 | 运行时直接读取 `workflow/v1.0/提示词/*.txt`，不复制进代码 | 提示词是用户自有工作流的一部分，单一来源 | — |
| 知识库 | 文件式：`records/<ID>/v<N>.md`、`proposals/`、`snapshots/`、`CURRENT`、`limits.json`、派生 `views/` 与 `_index/`；单一串行合入入口；停用先行；不使用任何哈希 | 手册第七章第一版形态即文件式；用户明令不引入哈希清单 | 中：接口 `KnowledgeStore` 可换后端 |
| M08/M09 | 本版不实现 | 仍是用户委托补齐的暂定安排 | — |
| M05 | 用户推荐的 browser-use 作为交互式站点的最后手段（需单独配置模型）；Crawl4AI（网页抓取为 markdown）接入；检索全部走公开 HTTP 接口、无本地服务：OpenAlex 与 arXiv（论文与开放版本）、Hacker News、Stack Exchange、Reddit、GitHub（社区，官方无密钥接口）、DuckDuckGo 公开 HTML（无密钥通用网页，尽力而为）、Brave Search API（可选，需密钥）；每种能力都有无 Python 时的退化路径（纯 HTTP 抓取）。PDF 不用任何本地 ML 模型：pdftotext 提取文本层，pdftoppm 按需把单页渲染成图片交给多模态模型直接阅读。Docling 与 SearXNG（Docker）曾被接入，用户明确不想本地模型与 Docker 后已移除 | 用户 2026-09-20 的选择与“不在本地跑模型、不用 Docker、机器空间有限”的约束 | 高：`AcquisitionBackend` 接口可换任何一项 |

## 2. 阶段到会话的映射

| 阶段 | 会话 | 角色 | 工具 | 输入 | 产物 |
|---|---|---|---|---|---|
| M01 | 新会话 `M01` | execution | 无 | P01 + 原始问题 + 必要原始信息（文本） | `initial-understanding.md` |
| M02 | 新会话 `M02`（与 M01 相同模型，不继承历史） | execution | 无 | P02 + 原始材料 + M01 完整产出 + 保存约定 | `criteria-candidates.md`，K 候选入库 |
| M03 | 新会话 `M03-reviewer` 出题；续接 `M01` 作答；续接 `M03-reviewer` 评价 | reviewer / execution / reviewer | 无 | P03Q + 材料 + M01 + M02；M02 完整产出 + 可转发问题；P03A + 完整回答 | `questions.md`、`rationale.md`（不转发）、`answers.md`、`evaluation.md` |
| M04 | 首轮续接 `M01`；其后新会话 `M04-research` | execution / research | 无 | P04 + 意见 + 产物位置（新会话另加原始问题与局部知识包） | `processing.md`、知识提案、`merge.json` |
| M05 | 新会话 `M05` | acquisition | 自定义工具：web_search、find_open_access、fetch_page、download_file、extract_pdf、render_pdf_page、read_work_file、register_source、list_sources（配置了 browser-use 模型时另有 browse_interactive）；文件访问限定在本轮 `references/_work/<run>/` 与已登记来源 | P05 + 本轮目标 + 原始材料 + 局部知识包（C/K/Q/X）+ 已有索引 + 工具规则 | `acquisition-report.md`、`tool-log.jsonl`、`references/search/R###-<run>.md`、新登记的 `sources/S###/` |
| M06 | 每份资料三个新会话：`-reader`、`-checker`、`-applicability` | reader / checker / applicability | 前两者：限定在资料目录的只读工具 + `render_pdf_page`（把 PDF 单页渲染成图片直接返回，供多模态模型看公式、表格、图和扫描页）；第三者：无 | 材料 + 阅读要求；材料 + 阅读记录；经核对内容 + 同一份项目状态 | 每组三份记录、`batch-summary.md`、`batch.json` |

“新会话”= 新的 `SessionManager` 文件 + 全部资源发现关闭（无 context 文件、skills、extensions、prompt templates、APPEND_SYSTEM）+ 空的 cwd 与 agentDir + 内存 settings；系统提示只含角色边界句（见 `src/prompts.ts` 的 `ROLE_SYSTEM_PROMPTS`）。会话之间只通过控制器显式搬运的可见文本交接。

## 3. 控制器自写的文本

以下文本不来自用户提示词，而是控制器为落实边界而加的，可被审阅与替换：

- 角色系统提示 `ROLE_SYSTEM_PROMPTS`（七种角色各一段）。
- 材料标签 `【原始问题】`、`【必要原始信息：…】`、`【初始认识（…）】` 等。
- M03 出题格式要求：两个一级标题 `# 可转发问题` / `# 出题说明与判断依据`，缺一不转发。
- M03 作答框架 `【第三轮：回答外部质询】`（原 v1 无专用答题提示词，只转发问题；这里补一句说明 M02 产出的来源与“题目可被纠正”）。
- M02/M04 的 `knowledge-proposals` 代码块约定（JSON 操作数组）。
- M05 的工具规则与报告小节要求（`buildM05Message`），以及各工具的描述文字。
- M06 三类任务框架（依据手册第十章 1–3 节改写为面向阅读者/核对者/适用性会话的任务说明）。

## 4. 知识库语义

- 七类记录 C/K/E/J/Q/D/X，身份 `C001`，版本 `C001@2`；实质修订产生新版本，旧版本文件永不改写。
- 三种状态分开：`evidenceStatus`（依据状况）、`usageDecision`（历史使用决定，改变即新版本并生成 D 记录）、`availability`（读取时派生，不存储）。
- 关系带含义（premise_of/supports/refutes/limits/questions/checks/handles/replaces/splits/applies_in/located_in），只在拥有方写入。
- 提案 → 结构校验 → 在当前状态复查 → 先写限制 → 应用 → 影响分析只传播 `needs_recheck` → 发布快照 `G###` → 移动 `CURRENT`。任一步结构非法则整批拒绝，不留半发布状态。
- 入库、关闭 Q、采用决定都不是科学认证；视图与索引只由记录派生。

## 5. 未决与未做

- 模型选择与路由、并发数、预算：由 `research.config.json` 决定，harness 无默认。
- M05：browser-use 需在配置中指定模型与提供 API 密钥，未配置即无交互式浏览器；Brave 密钥可选，缺省时通用网页检索只有 DuckDuckGo 公开 HTML 接口，可能限流。Crawl4AI 与 browser-use 本身不运行本地模型（Crawl4AI 的 markdown 生成是规则式的；browser-use 调用你配置的云端模型）。PDF 页面图像要求 reader/checker 角色使用多模态模型；长材料分块仍未实现。
- M07 主 Agent 的 Pi 端封装（extension 工具）、M08/M09：未实现。
- 跨进程合入锁只有锁文件保护；多机无协调写入不在范围。
- 真实模型端到端运行尚未执行；测试使用脚本化假会话与真实文件存储。

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
node src/cli.ts status --workspace <dir>
```

`--runner fake` 让任何命令走脚本化假会话（用于演练目录与产物结构，不产生科研内容）。

M05 的外部工具：`scripts/setup-tools.sh` 建立 `.venv` 并安装 Crawl4AI、browser-use 与 Playwright Chromium headless shell（不含任何本地 ML 模型，不需要 Docker）；检索来源可用 `tools.searchProviders` 限定，`tools.braveApiKey` 可选；`tools.browserUseModel` 指定 browser-use 的模型后交互式抓取才可用；PDF 只依赖本机 poppler（pdftotext、pdftoppm、pdfinfo），`tools.pageImageDpi` 可调页图分辨率（默认 110）。工具缺席时 M05 仍可运行，只是退化为 OpenAlex/arXiv 检索与纯 HTTP 抓取，并把所用引擎写进记录。
