# M01–M09 对齐整理记录

日期：2026-09-20

## 本批目的

将已经讨论的 M01–M09 阶段安排整理回现有项目文档，使原 v1 规范、当前调整、暂定安排和未决实现边界能够同时被准确阅读。

## 实际变更

- 更新 `docs/research/workflow-foundation.md`，增加术语边界和 M01–M09 当前对齐；保留原 v1 的逐文件理解，并把旧人工转交等描述明确标为历史基线。
- 更新 `docs/research/workflow-prompts-reading.md`，说明其记录原提示词语义，当前会话编排以 foundation 为入口。
- 更新根 `README.md`、`docs/README.md` 和 `workflow/v1.0/README.md` 的阅读入口与状态说明；对 `AGENTS.md` 作两处最小澄清，区分原 v1 与当前对齐，并区分 Codex 仓库编排判断和 workflow 的 M04 科学判断。
- `docs/research/pi-harness.md` 的同步修订由同批独立任务完成：增加 foundation 当前对齐入口；同步 M02 独立新会话、M03 自动编排、M04 会话安排、M05 初筛边界、M06 每份材料三会话组，以及 M08/M09 暂定自动独立任务流程；具体接口仍未决定。本记录登记协作结果，不冒称由本文件编辑者独自完成。

## 边界与未决

- M01–M07 记录本轮已对齐的关键职责和会话关系；M08/M09 标为用户委托依原 workflow 补齐的当前暂定安排。
- 具体模型、工具、API、并发、预算、长会话恢复和持久化实现仍未决定；M05 工具候选保留在既有文档中，没有在本批重复展开。
- 当前没有获准的科研运行时。此前误实现已撤回并保留真实历史，私密归档未恢复。
- 曾计划的独立交接稿在落盘前已停止，因此没有文件需要删除或归档。

本批没有修改 workflow 手册、分册或提示词正文，没有恢复代码、安装依赖、运行测试、提交或推送，也没有破坏性操作。

## 收尾验证

- 对本批涉及的 README、AGENTS、foundation、提示词阅读、Pi 映射和本记录检查 Markdown 本地相对链接，共检查 30 个，缺失 0 个。
- `git diff --check` 通过。
- 核对未生成 `docs/alignment/` 或独立 M01–M09 交接稿。
- 核对撤回批次的 `src/review-delivery/`、Pi extension、测试目录、根 `package.json`、`tsconfig.json` 与 M08/M09 实现说明均未恢复到活动树。

## 2026-09-20 补记

- 独立审查后撤销了本批对 `workflow/v1.0/README.md` 的追加引导块，该文件恢复为与 `workflow/v1.0/文件清单.md` 一致的 v1.0 原文；当前对齐入口保留在根 README、docs/README 和 AGENTS.md。其余修正见 `2026-09-20-audit-fixes.md`。
