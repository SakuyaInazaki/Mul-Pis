# 终端工作流控制台独立保存目录

这里保存主工作区在 Git 基线 `4b12d32` 上完成的终端控制台实现，供单独审阅和后续集成。它是源码快照，**没有接入本目录所在分支的当前运行代码**；直接在此目录执行入口不会启动一套独立应用。

- `src/console/`、`src/pi/console-bridge.ts`、`src/pi/preflight.ts`、`src/pi/tool-names.ts`、`src/m07/local-reconciliation.ts`、`src/runtime/telemetry.ts` 和 `scripts/workflow-rpc-host.ts` 保留新增源码的原始相对路径。
- `test/` 保留控制台、桥接、宿主、预检与本地协调相关测试；`docs/implementation/terminal-console-design.md` 是使用说明。
- `integration.patch` 保存对基线现有文件的改动及旧 dashboard 的删除，包括 npm 入口、Pi 扩展与服务、工作区所有权、M07 等待/恢复控制、工具遥测和对应测试。补丁中共享文件的改动与来源工作区同期的研究控制改进交织，审阅者必须按目标分支的现状逐项整合；不能把补丁在现有修复分支上直接应用并称作已集成。

恢复审阅时，先在**独立临时检出**中选择基线 `4b12d32`，从仓库根目录执行 `git apply --check terminal-console/integration.patch`，再应用补丁并按此目录中的原始相对路径复制新增文件。若在别处分离保存本目录，补丁路径仍以项目根目录为起点。随后检查共享文件冲突、执行 `npm run typecheck` 和 `npm test`，并实际验收终端启动、工作区所有权、Pi RPC 桥接和目标等待/恢复。当前目录的制作仅做文件和补丁完整性核对，没有运行测试，也没有触碰已有研究进程。

此目录不包含研究 notes、运行记录、私有目录、凭据或第三方 checkout。控制台源码对 M07 与 Pi 主会话的接口假设来自原控制台工作区；当前分支的算子修复仍在演进，必须单独核对这两处共享边界后才能合入运行树。
