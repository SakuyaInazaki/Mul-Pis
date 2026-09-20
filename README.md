# Pre-RSI 科研工作流

本项目以用户经实战与逐环节讨论后确定的泛科研执行工作流为直接研究基础，并评估如何以 [Pi](https://github.com/earendil-works/pi) 作为可替换的 agent harness 承载和继续演进它。该流程本身已经泛化，不是竞赛旧版工具包，也不是从 RSI 论文移植而来；方向层与 RSI 仍属于后续议题。当前仓库处于资料整理与调研阶段，不是已经实现的科研运行时，也不构成“科研自我进化”能力已经得到验证的证据。

## 当前内容

- [`workflow/v1.0/`](workflow/v1.0/README.md)：用户经实战与逐环节讨论后确定的科研执行流程 v1.0，是本项目直接研究基础；本轮 M01–M09 调整入口见下项 foundation。
- [`docs/research/workflow-foundation.md`](docs/research/workflow-foundation.md)：原 v1 基础理解与 M01–M09 当前对齐，明确哪些已对齐、哪些暂定、哪些仍待实现。
- [`docs/`](docs/README.md)：其余逐文件阅读材料、M05 工具候选、Pi 承载调研和 RSI/SoL-Pi 外部启发。具体工具、模型和实现选择仍未确定。
- [`docs/provenance.md`](docs/provenance.md)：第三方依赖和本地研究资料的固定版本与来源说明。
- [`.agent/notes/`](.agent/notes/)：为公开整理保留的审计、研究与验收记录。

`third_party/` 保存本地使用的上游 Pi 与 SoL-Pi checkout，`resources/` 保存本地研究资料。两者默认不进入公开发行；公开仓库记录其来源和所调研版本。

## 当前研究状态

现行科研执行层以原 workflow 为基础，并以 foundation 中记录的本轮阶段调整为当前入口。M01–M07 已对齐关键职责和会话关系；M08/M09 是按用户委托补齐的暂定安排。当前没有获准的科研运行时实现。

RSI、自我改进程度、工作流改进循环以及是否使用 extension 或 SDK 均属于后续议题，当前没有据此选定系统架构。

## 本地准备

公开版本不携带 Pi 源码或论文 PDF。需要复现当前调研环境时：

1. 按 [`docs/provenance.md`](docs/provenance.md) 克隆 Pi 并 checkout 固定 commit 到 `third_party/pi/`。
2. 如需复核 SoL-Pi 的独立 extension 实现，按同一来源清单克隆其固定 commit 到 `third_party/sol-pi/`；它不是必需运行依赖。
3. 按 Pi 自身文档安装依赖；本地已有的 `node_modules` 不属于发布内容。
4. 从来源页合法取得所需论文版本并放入 `resources/`。

## 发布前待办

- 由项目所有者选择并添加本项目许可证。
- 确认工作流文本适合公开，且不包含内部比赛身份或其他不应公开的信息。

在许可证确定前，不应把本项目内容视为已授予开源使用许可。Pi 与论文分别遵循其上游许可证和来源条款。

真实科研任务验证属于未来可选验证阶段，不是本轮整理结果建立仓库或发布文档的前置条件。
