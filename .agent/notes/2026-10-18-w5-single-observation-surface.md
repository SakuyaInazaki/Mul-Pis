# 只保留一个观察面：删除 HTTP dashboard，控制台观察阈值外置

## 为什么

- RB-A13-08 / RB-A13-09（P0）：审计账本与 wall-clock 画像要有**一个**能回答「预算花在哪」的地方。改动前有两套互相独立的观察投影：`src/dashboard/`（HTTP 服务 + 浏览器图，`DashboardNode`/`DashboardEdge`）与 `terminal-console/`（`WorkflowNode`/`WorkflowSnapshot`）。两套各自从同一批持久记录派生，字段不同、判定不同，上一批的审计投影也只做进了控制台。两个会分歧的观察面比一个更糟。
- RB-A13-05（P0）：配置与常量一律外置，代码里不得出现写死的阈值。控制台把四个会**改变显示判决**的阈值写死在 `read-model.ts` 顶部：单份控制记录 40 MB、单文件尾 65,536 字节、心跳 20 秒、工具记录末 100 条。心跳阈值直接决定一个运行显示为「执行中」还是「状态未知」。
- 开发规范：被替换的旧路径直接删掉，不留死代码和兼容分支。`terminal-console/README.md` 原本记载，控制台当初的集成补丁里就包含「旧 dashboard 的删除」，这一步在集成时漏掉了。

## 改了哪里

- 删除 `src/dashboard/{cli,server,state,types}.ts` 与 `src/dashboard/public/`，以及 `test/dashboard-server.test.ts`、`test/dashboard-state.test.ts`、`docs/implementation/dashboard.md`、`package.json` 的 `dashboard` 入口。
- `src/dashboard/telemetry.ts` 是两边共用的会话遥测写入与读取，移到 `src/telemetry.ts`；三处 import 相应更新（其中 `src/runner/pi.ts`、`src/pi/extension.ts` 属于别人负责的文件，改动只有一行 import 路径）。
- 新增 `terminal-console/src/console/limits.ts`：`ConsoleLimitsV1` 四个字段、各自的取值区间、默认值，以及工作区级覆盖文件 `.agent/console-limits.json`。未知字段、非整数、越界一律报错，**不静默回退默认值**——否则在一个窗口下做出的观察会被当成另一个窗口下的观察。
- `read-model.ts` 改用实例上的 limits，在每次 `read()` 开始时加载。
- `package.json`：新增 `audit` 入口；补上一直被 `types: ["node"]` 依赖却没有声明的 `@types/node`，并把 `typescript` 从 `^5.9.0` 固定为 `5.9.3`（类型检查结论随版本变化，属于实验变量）。
- 文档：`README.md` 增加「本地环境与校验」「观察与审计」两节（此前 README 完全没有安装与校验步骤）；`docs/README.md` 实现索引加入控制台设计文档；`docs/implementation/workflow-limit-inventory.md` 的观察窗口一行改为指向 `limits.ts` 并写明可覆盖。
- 测试：`terminal-console/test/console-audit.test.ts` 增加一项——同一份记录在默认 20 秒窗口下显示为状态未知，把窗口放宽到 120 秒后显示为执行中；越界值与未知字段都被拒绝。

## 验证

- 类型检查 0 错误；`terminal-console/test/**` 55/55。
- 全量测试结果见本批次最后一个提交对应的 note。

## 推翻的原有约定

删除了 `npm run dashboard` 这个已记录的入口与它的浏览器界面。依据是 RB-A13-08/09（单一审计面）与本仓「被替换的旧路径直接删掉」的规范。对应 issue：`W5-01-remove-http-dashboard.md`，其中写明如何回退（本提交是独立提交，`git revert` 即可恢复）。
