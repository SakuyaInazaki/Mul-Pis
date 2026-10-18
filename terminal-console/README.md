# 终端工作流控制台

控制台已接入本分支的运行代码：`package.json` 的 `console` 入口指向 `terminal-console/src/console/cli.ts`，`tsconfig.json` 把 `terminal-console/src/console/**` 与 `terminal-console/test/**` 一并纳入类型检查，`npm test` 同时运行 `test/` 与 `terminal-console/test/`。这里不再是待集成的源码快照，也没有需要手工应用的补丁。

- `src/console/`：只读读取模型（`read-model.ts`）、审计投影（`audit.ts`）、渲染与终端层、Pi RPC 客户端与宿主、命令行入口。读取模型直接 import 主树的 `src/m07`、`src/dashboard` 类型，不复制定义。
- `test/`：控制台、桥接、宿主、读取模型与审计的离线测试；`test/helpers/` 是共享测试辅助，不会被测试 glob 当作用例执行。
- `docs/implementation/terminal-console-design.md`：使用说明、按键表、工作流节点语义与审计投影字段。

常用命令：

```sh
npm run console -- --workspace /path/to/workspace          # 交互界面
npm run console -- status --workspace DIR --json           # 只读 JSON 快照
npm run console -- audit  --workspace DIR [--json]         # 判决、失败分账与预算的审计投影
```

控制台只读取工作区里的持久记录并通过 Pi RPC 发送有限的结构化动作；它不推断进度百分比，不把阶段完成当作科学结论成立，也不替用户选模型（主会话模型取工作区 `research.config.json` 的 research 角色）。本目录不包含研究 notes、运行记录、私有目录、凭据或第三方 checkout。
