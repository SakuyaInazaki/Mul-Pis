# 文档索引

## 阅读顺序

1. [`../workflow/v1.0/README.md`](../workflow/v1.0/README.md)：用户原 workflow 阅读入口；它是本项目的直接研究基础和原 v1 历史基线，当前阶段调整见第 2 项。
2. [`research/workflow-foundation.md`](research/workflow-foundation.md)：原 v1 基础理解与 M01–M09 当前对齐入口；区分原规范、本轮调整、暂定安排和待实现事项。
3. [`research/workflow-prompts-reading.md`](research/workflow-prompts-reading.md)：全部提示词的逐文件阅读与关系梳理；载体差异以第 2 项当前对齐为准。
4. [`research/m05-tool-candidates.md`](research/m05-tool-candidates.md)：M05 不预设站点白名单的资料获取工具选择、现行接入状态、边界与可替换候选。
5. [`research/pi-harness.md`](research/pi-harness.md)：已同步当前流程对齐的 Pi 承载调研；现行实现决定见实现设计。
6. [`research/rsi-solpi-workflow.md`](research/rsi-solpi-workflow.md)：RSI/SoL-Pi 的外部启发比较，不替代 workflow，也不属于现行科研执行层。

阅读始终以第 1 项用户原 workflow 为基础；第 2 项记录当前对齐并在承载方式冲突处优先，第 3 项辅助理解原提示词，第 4 项保留 M05 工具候选入口，第 5、6 项服务于承载方式和后续方向的讨论。

## 实现

- [`implementation/design.md`](implementation/design.md)：研究 harness 的架构决定、阶段到会话的映射、控制器自写文本清单、知识库语义、未决与运行入口。

## 来源与复现

- [`provenance.md`](provenance.md)：第三方 checkout、论文资料与用户自有工作流的来源说明。
- [`../.agent/notes/`](../.agent/notes/)：整理、研究和验收记录。

## 当前边界

M01–M07 的阶段职责和关键会话关系已有当前对齐，M06 的批次调整与停用边界是用户已接受的暂定共识，M08/M09 是按用户委托补齐的暂定安排。M01–M06、文件式知识库与 CLI 已获准并已有实现；真实云端模型端到端运行尚未执行。模型由工作区配置且无默认，M07 封装、M08/M09、预算与并发策略、RSI、自我改进程度和扩展机制仍待决定。
