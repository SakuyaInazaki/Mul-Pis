# Pre-RSI 科研工作流

基于 [Pi](https://github.com/earendil-works/pi) 的泛科研执行工作流与本地 TypeScript 研究 harness。流程包含 M01–M09 阶段、C/K/E/J/Q/D/X 知识库、CLI 和 Pi extension；模型由工作区 `research.config.json` 显式指定。

## 内容

- `workflow/v1.0/`：科研执行流程 v1.0 与提示词。
- `docs/research/workflow-foundation.md`：当前阶段对齐与边界。
- `src/`：工作区、阶段编排、M07 目标与有界任务、M08/M09 审查与交付控制器。
- `extensions/research.ts`：Pi extension 入口。
- `docs/implementation/design.md`：实现设计与运行边界。
- `docs/implementation/dashboard.md`：只读本地工作流面板。
- `docs/provenance.md`：第三方来源与版本记录。

## 本地准备与验证

1. 按 `docs/provenance.md` 准备 `third_party/pi` checkout。
2. 在本仓库根目录建立 `node_modules/@earendil-works/{pi-coding-agent,pi-ai,pi-agent-core}` 符号链接。
3. 运行 `npm test` 与 `npm run typecheck`。

`third_party/` 与 `resources/` 仅供本地使用，不进入公开发行。

## 运行

```bash
pi -e ./extensions/research.ts
```

或使用项目 CLI：

```bash
node src/cli.ts --help
```

## 许可证

许可证尚未确定；在项目所有者添加许可证前，不应视为已授予开源使用许可。
