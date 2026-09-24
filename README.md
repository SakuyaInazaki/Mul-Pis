# Mul-Pis

基于 Pi 的多阶段科研工作流执行与验证框架。

实现与边界见 [设计记录](docs/implementation/design.md)；独立预算策略改进入口、显式实验计划、晋级条件和未验证范围见 [首轮改进外环](docs/implementation/rsi.md)。CLI 使用 `node src/cli.ts improve status|run|rollback|export|bind --workspace <dir>`；`run` 需提供 `--plan <json>`。投影筛选本身不会晋级策略。

有限的 H/I 科研方法开发使用独立入口：`node src/cli.ts improve research bootstrap --workspace <dir> --methods <json>`。CPU 辨识使用 `improve research run --plan <json>`；显式 M07 证据交接单槽实验使用 `improve research workflow run --plan <json>`。后者只产生本地交接机制证据，真实科学收益与多代 RSI 尚未验证。计划结构、预算与限制见 [RSI 实现说明](docs/implementation/rsi.md)。
同一入口还提供显式的 `advance-knowledge` 与 `transition-dependencies`，用于在 M04 合入后建立新知识 epoch 或按已采纳决定更新必要科学前提。M07 新目标可显式绑定专用工作流 H 槽位；这些能力的输入和限制见 [RSI 实现说明](docs/implementation/rsi.md)。
