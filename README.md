# Mul-Pis

基于 Pi 的多阶段科研工作流执行与验证框架。

实现与边界见 [设计记录](docs/implementation/design.md)；独立预算策略改进入口、显式实验计划、晋级条件和未验证范围见 [首轮改进外环](docs/implementation/rsi.md)。CLI 使用 `node src/cli.ts improve status|run|rollback|export|bind --workspace <dir>`；`run` 需提供 `--plan <json>`。投影筛选本身不会晋级策略。
