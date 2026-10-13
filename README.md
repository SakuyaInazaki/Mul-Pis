# Mul-Pis

基于 Pi 的多阶段科研工作流执行与验证框架。M01–M09 承载研究、执行、复核和交付，C/K/E/J/Q/D/X 知识库通过 M04 统一处理采用、纠错、替换和撤回。

## 当前工作与审阅入口

本轮修复覆盖连续目标的执行—复核—返修循环、未知外部操作对账与恢复、知识状态和替换关系展示、M04 证据读取，以及后续新会话的 200k 自动压缩。源码、针对性回归和通用变更记录随本分支发布；具体实验配置与原始运行材料保留在实验工作区。

方法改进的基础修复进一步固定搜索前的评测输入，支持真实默认工作流作为比较基线，并修正方法跨知识纪元、委派和导入时的经验适用性检查。知识继续在原工作区持久积累；独立评测使用冻结副本，实时撤回仍生效。对应记录见[输入冻结](.agent/notes/2026-10-13-workflow-research-input-freeze.md)、[默认基线](.agent/notes/2026-10-13-workflow-builtin-baseline.md)和[方法依赖](.agent/notes/2026-10-13-knowledge-epoch-workflow-experience-scope.md)。

建议按以下顺序审阅：

1. [本轮修复与验证记录](.agent/notes/2026-10-13-workflow-repair-publication.md)：改动原因、代码位置、验证结果与当前能力范围。
2. [原始工作流](workflow/v1.0/README.md)与[当前阶段对齐](docs/research/workflow-foundation.md)：研究流程的基础和当前职责。
3. [实现设计](docs/implementation/design.md)与[上下文边界](docs/implementation/context-boundaries.md)：实际执行、知识和会话机制。
4. [RSI 实现说明](docs/implementation/rsi.md)：已有方法改进外环、实际可修改范围及后续需要验证的能力。

持续执行、审查返修和知识更新已有局部真实运行观察。完整 M01–M09 验收、知识带来的因果收益和多代架构 RSI 仍需各自的实验依据；离线工程测试与真实实验结果分别记录。

## 方法改进入口

预算策略改进使用 `node src/cli.ts improve status|run|rollback|export|bind --workspace <dir>`；`run` 需提供 `--plan <json>`。候选先经过投影筛选，再由成对准入实验决定是否采用。

执行方法 H 和改进方法 I 使用独立入口：`node src/cli.ts improve research bootstrap --workspace <dir> --methods <json>`。CPU 辨识使用 `improve research run --plan <json>`；M07 证据交接方法实验使用 `improve research workflow run --plan <json>`。当前工作流适配器覆盖局部 reason/check 与证据交接，方法以数据化提示策略保存。`improve research workflow compare-sources --plan <json>` 可让两份固定源码在独立进程内完成同方法、同知识的 M07→M04 成对观察；源码候选准入与自动版本切换仍待后续接通。

研究前可用 `improve research workflow prepare --workspace <source> --plan <json> --output <new-source>` 准备独立研究工作区。它保留知识历史、活动方法版本和指定开发证据，返回副本内的 `planPath`；随后将 `workflow run` 的 `--workspace` 指向副本、`--plan` 指向该文件。改进器会话、候选和晋升记录由副本持有，原工作区后续变化不会进入这轮研究。

新研究进程还可通过 `scripts/prepare-workflow-source.ts` 固定已审阅提交的源码，再由 `scripts/run-workflow-source.ts` 启动。新 M07 attempt 记录经加载路径核对的源码根和完整提交；已有进程和历史记录保持原样。用法见 [源码版本绑定](docs/implementation/rsi.md#实际加载源码版本)和[独立进程源码比较](docs/implementation/rsi.md#独立进程源码比较)。

同版本对照使用 `improve research workflow calibrate --plan <json>`，或 Pi 工具的 `workflow-calibrate` action。两臂从同一冻结来源执行真实 M07→M04 链路，记录差异与用量；该校准与候选搜索、准入分别保存。

同一入口提供 `advance-knowledge` 与 `transition-dependencies`，用于在 M04 合入后建立新知识 epoch 或更新有采用依据的必要科学前提。M07 方法在新目标建立时显式绑定和冻结。参数与入口详见 [RSI 实现说明](docs/implementation/rsi.md)。
