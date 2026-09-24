# M08/M09 有限实现记录（2026-09-20）

## 当前重新授权的实现批次

用户在先前误实现已撤回后，另行明确授权实现当前对齐中的 M08/M09，并授权完成检查后推送。本节记录当前活动实现；下方“纠正状态/撤回记录”保留第一次误实现的历史，不代表本批仍被撤回。

- M08 新增 `src/stages/artifacts.ts` 与 `src/stages/m08.ts`：逐字节复制调用方选定成果及控制器生成的原问题、必要输入和知识快照，不生成文件哈希；拒绝符号链接和递归复制目标。调用方显式给出自查任务和 reviewer 列表、角色及只读/执行模式。自查全部成功才启动同版外审，任一选定成员失败则整批失败且不产生反馈包；复审重新固定材料并记录前次运行、变化与影响范围。
- M08 自查加载原 workflow 的完整 P08M；PDF 页渲染产物写在 frozen 材料之外，避免并发检查把派生页误判为固定材料变化。M08 到 M04 使用专用 feedback 类型并强制 fresh research 会话。M04 保存来源、完整消息和受校验的 `m08-disposition`；ready/partial/rework/needs_evidence/unresolved 明确分开。ready/partial 的可交付项必须有实际文件读取证据，列目录不能冒充读取目录内文件；无效处置收敛为 unresolved。一致意见和运行完成都不等于科研正确。
- M09 新增 `src/stages/m09.ts`：严格验证命名 M08/M04 的来源配对、M04 处置和当前知识快照，只复制处置允许且调用方 included 的 manifest 路径。两个独立新会话均加载原 workflow 的完整 P09，再附接各自任务边界；保存源到副本追踪、实际覆盖、失败、限制、恢复入口和收口回执。
- M09 的 `full-recomputation` 是调用方请求模式。复核会话没有自由 bash，只能用受控工具按索引执行调用方在 `reproduction.instructions` 中预先列出的精确 shell 命令；控制器记录真实退出码、stdout/stderr 和覆盖，AbortSignal 会终止受控命令进程组并保存取消日志。计算命令可在 verification copy 新增核验输出，但必须逐字节保留原交付文件；改写或删除原文件会拒绝收口，命令应选择新的输出路径。organizer 与 checker 都取得显式 PDF 必查/未覆盖页计划。running facts 在最终知识限制 guard 前取得，guard 覆盖其等待窗口；这不是跨进程原子事务。命令完成不认证完整复现；`read-only` 模式的命令列表为空。收口不会自动发布、投稿、外发、压包、关闭 Pi、启动下一目标或 RSI。
- `src/pi/service.ts`、`src/pi/extension.ts` 和 `src/cli.ts` 接入 M08/M09。Pi 工具使用具体 TypeBox 字段；CLI 从显式 JSON 文件读取材料、自查、reviewer、交付范围与复核配置。M08 只有完整反馈包才可按明确请求自动送 M04；M09 不自动发布。
- Pi extension 的 compact 结果保留 M08 每个成员的 id/role/status/failure/coverage 与反馈包路径，并保留 M09 的版本、交付范围、实际复核状态、限制、恢复入口和未采取动作。显式相对 workspace 以每次调用的 Pi `ctx.cwd` 为基准；M09 schema 同步可选 `pdfPages` 页级覆盖要求。
- 更新 README、docs、AGENTS 和测试。测试全部使用本地 fake/scripted sessions 与真实文件存储，不调用真实模型或网络，不选择默认模型。

### 本地验收结果

- `node third_party/pi/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：通过。
- `npm test`：97 项通过，0 失败、0 跳过；其中覆盖 verification copy 只允许新增核验输出、不得改写/删除原交付字节，以及 running facts 后重新检查知识限制。全部使用本地 fake/scripted session，没有调用真实模型或网络。
- `git diff --check`：通过。
- 独立只读复核发现的 verification copy 原文件可变与最终限制检查时序问题均已修复，并由独立复核回归确认闭环，无剩余阻塞。
- 公开文件模拟与发布审计通过：未包含 `resources/`、`third_party/`、私有目录、虚拟环境、依赖目录、工作区或嵌套 `.git`；原 `workflow/v1.0/` 无差异，第三方源码无修改，未发现机器绝对路径、凭据或私密邮箱。

以上只证明当前离线实现与测试约束通过；真实模型端到端运行尚未执行，也不证明科研结论、完整复现或实际发布流程已经验证。

### 合并记录

- `.agent/notes/2026-09-20-M08-core.md` 当时是未跟踪的并行记录，其 M08 核心变更内容已合并到本节供后续查阅；为避免同一批次存在两份 note，随后移除该未跟踪文件。

> **纠正状态：已撤回活动工作树。** 用户随后澄清，本轮只要求对齐流程，并未授权实现 M08/M09。以下内容记录实际发生过的误实现及其边界，不表示当前仍获授权或仍在活动项目树中。

## 授权与范围

- 当时错误理解为用户授权实现 M08 和 M09；用户随后明确，实际授权仅为流程对齐。
- 本批在不修改 `workflow/v1.0` 的前提下，实现 M08/M09 有限运行支撑并同步项目说明。

## 变更清单

- 新增 `src/review-delivery/types.ts`：定义五工具、审查记录、复现记录和收口回执的接口。
- 新增 `src/review-delivery/core.ts`：实现固定材料、自查与 reviewer 汇集、同版本 M04 交接、便携交付、临时副本复现和本地收口。
- 新增 `src/review-delivery/pi.ts`：接入 Pi 0.85.1 SDK 独立 reviewer session，只开放快照读取工具。
- 新增 `.pi/extensions/research-review.ts`：向 Pi 注册五个项目本地工具及 `m09_finalize` 的当前 turn 终止请求。
- 新增 `test/review-delivery/core.test.ts` 与 `test/pi.test.ts`：覆盖阶段门槛、失败重试、原问题实际读取、便携交付、复现失败/超时/取消、未决保留和关闭边界。
- 新增 `package.json` 与 `tsconfig.json`：提供依赖声明、测试和类型检查入口；最终 TypeScript 配置不依赖 `third_party/` 的类型路径。
- 更新 `docs/implementation/m08-m09.md`、`docs/README.md`、根 `README.md`、`AGENTS.md` 及本记录：说明实际能力、运行前提、授权范围和未实现边界。

## 已同步的设计

- 五个 Pi extension 工具：`m08_prepare`、`m08_review`、`m09_prepare`、`m09_reproduce`、`m09_finalize`。
- M08 复制真实文件形成无哈希快照；主 Agent 先按 P08M 自查，再配置独立 SDK reviewer。所有选定 reviewer 成功返回才进入 `awaiting_m04`；失败保留为不完整状态。
- M04 未在本轮实现。M09 必须取得与 `reviewId`、`versionLabel` 对应的外部 M04 处理记录，且没有需要新审查的实质变化。
- M09 按接收者、用途和范围准备便携材料；argv 命令在临时副本运行并记录真实结果；finalize 分开记录研究/交付状态、核验覆盖、未决、恢复入口和运行任务。
- finalize 成功会同时返回 Pi tool result 的 `terminate: true`。Pi 0.85.1 仅在同一 tool batch 所有结果都 terminating 时跳过自动后续 LLM 调用并结束当前 turn；这不终止 Pi/session、不监管外部已有进程，也不自动发送、公开或开始下一目标。
- 最终实现入口为 `.pi/extensions/research-review.ts`，生成含 `DELIVERY.md`、相对路径 `manifest.json`、内容与审查/M04 记录的便携交付目录。reviewer 必须实际读取原问题文件，可见原始报告保留且不冒充已结构化解析；prepare 时已有未决与 finalize 新增项合并保留。`npm test` 的 19 项测试与 `npm run typecheck` 均通过；测试未启动 Pi CLI，也没有调用付费模型。

## 边界

- reviewer 可能只做只读检查而未运行计算，其覆盖必须如实记录。
- 文件复制目录不是操作系统隔离，也不是科研知识库原子事务。
- 并发锁只覆盖同一 Node.js 进程，复制期间的大小/修改时间检查也不是跨项目事务或内容证明。
- 自报 M04 已处理、reviewer 一致或命令退出码为 0 都不构成科学正确性证明。
- 本轮已支持调用侧显式配置 reviewer 模型，但没有默认选型；研究模型选型、全流程模型分配、本轮以外各阶段 runtime、抓取、RSI 与自我改进仍未决定。

## 变更性质

- 本批为新增有限运行代码、测试与说明更新，无删除、覆盖原 workflow 或其他破坏性操作。
- 验证复用已有本地依赖，没有联网安装、启动 Pi CLI 或发起真实模型请求；`npm test` 19/19 通过，`npm run typecheck` 通过。
- 未提交、未推送。

## 撤回记录

- 撤回原因：实现行为超出用户授权范围，项目恢复到纯文档对齐阶段。
- 归档位置：`.agent/private/archives/2026-09-20-unapproved-m08-m09/`。
- 归档对象：`src/review-delivery/`、`.pi/extensions/research-review.ts`、`test/pi.test.ts`、`test/review-delivery/`、`package.json`、`tsconfig.json`、`docs/implementation/m08-m09.md`，以及本批为离线依赖接线建立的根 `node_modules/` 符号链接目录。
- 可恢复性：以上对象按原相对结构移动到私密归档，没有不可恢复删除；`third_party/` checkout 及其 `node_modules` 未修改或移动。
- 活动文档恢复：根 README 与 AGENTS 撤销本批运行实现声明；docs 索引仅移除 M08/M09 实现入口并保留先前 M05 候选入口。
