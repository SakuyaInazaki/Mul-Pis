# Pre-RSI 科研工作流

本项目以用户经实战与逐环节讨论后确定的泛科研执行工作流为直接研究基础，并以 [Pi](https://github.com/earendil-works/pi) 作为可替换的 agent harness 承载当前研究执行层。该流程本身已经泛化，不是竞赛旧版工具包，也不是从 RSI 论文移植而来；方向层与 RSI 仍属于后续议题。仓库已有 M01–M07 的研究 harness 与显式 Pi extension 入口，但真实云端模型端到端运行尚未执行，也不构成“科研自我进化”能力已经得到验证的证据。

## 当前内容

- [`workflow/v1.0/`](workflow/v1.0/README.md)：用户经实战与逐环节讨论后确定的科研执行流程 v1.0，是本项目直接研究基础；本轮 M01–M09 调整入口见下项 foundation。
- [`docs/research/workflow-foundation.md`](docs/research/workflow-foundation.md)：原 v1 基础理解与 M01–M09 当前对齐，明确哪些已对齐、哪些暂定、哪些仍待实现。
- [`docs/`](docs/README.md)：其余逐文件阅读材料、M05 获取工具记录、Pi 承载调研和 RSI/SoL-Pi 外部启发。尚未决定的事项以各文档当前状态为准。
- [`docs/provenance.md`](docs/provenance.md)：第三方依赖和本地研究资料的固定版本与来源说明。
- [`src/`](src/)、[`extensions/research.ts`](extensions/research.ts) 与 [`docs/implementation/design.md`](docs/implementation/design.md)：研究 harness 实现（基于本地 Pi 0.85.1 SDK 的 TypeScript 控制器）：工作区初始化、M01–M06 的会话编排、M07 目标与有界任务、C/K/E/J/Q/D/X 知识库、CLI 和 Pi extension；模型由工作区配置指定，harness 不预设。
- [`.agent/notes/`](.agent/notes/)：为公开整理保留的审计、研究与验收记录。

`third_party/` 保存本地使用的上游 Pi 与 SoL-Pi checkout，`resources/` 保存本地研究资料。两者默认不进入公开发行；公开仓库记录其来源和所调研版本。

## 当前研究状态

现行科研执行层以原 workflow 为基础，并以 foundation 中记录的本轮阶段调整为当前入口。M01–M07 已对齐关键职责和会话关系，其中 M06 的批次调整与停用边界是用户已接受的暂定共识；M08/M09 是按用户委托补齐的暂定安排。2026-09-20 起用户授权实现运行时；本轮又明确授权 M07 的 Pi 主会话接入与动态委派。M05 可组合使用公开检索接口（OpenAlex、arXiv、Crossref、Hacker News、Stack Exchange、GitHub 仓库与 Issues、DuckDuckGo；Reddit 可选；有密钥时可用 Brave）、任意 HTTP(S) 地址抓取或下载、Crawl4AI 和 browser-use；这些入口是可替换的默认实现，不是来源白名单，也不承诺穷尽全网。取得的实际文件及其逐文件来源记录供 M06 使用。PDF 用 poppler 提取文本并按页渲染成图片交给多模态模型（不运行本地模型，不需要 Docker）。M07 由同一个交互式 Pi 主会话通过显式 extension 工具管理持久目标，按需建立有界任务会话并验收真实文件；M08/M09 未实现，真实模型端到端运行尚未执行。

现有研究执行层已选择 Pi SDK 控制器实现，并提供 `pi -e ./extensions/research.ts` 的显式 extension 入口。主会话仍使用用户启动 Pi 时选择的模型；各研究角色仍只读取工作区 `research.config.json`，harness 不作模型选择。RSI、自我改进程度和工作流改进循环仍属于后续议题。

## 本地准备

公开版本不携带 Pi 源码或论文 PDF。需要复现当前调研环境时：

1. 按 [`docs/provenance.md`](docs/provenance.md) 克隆 Pi 并 checkout 固定 commit 到 `third_party/pi/`。
2. 如需复核 SoL-Pi 的独立 extension 实现，按同一来源清单克隆其固定 commit 到 `third_party/sol-pi/`；它不是必需运行依赖。
3. 按 Pi 自身文档安装其依赖；然后在本仓库根目录建立 `node_modules/@earendil-works/{pi-coding-agent,pi-ai,pi-agent-core}` 到 `third_party/pi/packages/{coding-agent,ai,agent}` 的符号链接，并链接 `typescript`、`typebox`、`@types`；`node_modules` 不属于发布内容。运行 `npm test` 与 `npm run typecheck` 验证。
4. 从来源页合法取得所需论文版本并放入 `resources/`。

## 发布前待办

- 由项目所有者选择并添加本项目许可证。
- 确认工作流文本适合公开，且不包含内部比赛身份或其他不应公开的信息。

在许可证确定前，不应把本项目内容视为已授予开源使用许可。Pi 与论文分别遵循其上游许可证和来源条款。

真实科研任务验证属于未来可选验证阶段，不是本轮整理结果建立仓库或发布文档的前置条件。
