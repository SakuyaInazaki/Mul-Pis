# Mul-Pis

基于 Pi 的多阶段科研工作流执行与验证框架。

实现与边界见 [设计记录](docs/implementation/design.md)；独立预算策略改进入口、显式实验计划、晋级条件和未验证范围见 [首轮改进外环](docs/implementation/rsi.md)。CLI 使用 `node src/cli.ts improve status|run|rollback|export|bind --workspace <dir>`；`run` 需提供 `--plan <json>`。投影筛选本身不会晋级策略。

有限的 H/I 科研方法开发使用独立入口：`node src/cli.ts improve research bootstrap --workspace <dir> --methods <json>`，随后 `node src/cli.ts improve research run --workspace <dir> --plan <json>`。当前只覆盖受控 CPU 响应辨识环境；计划结构、显式预算、经验引用和未验证范围见同一份 [RSI 实现说明](docs/implementation/rsi.md)。
