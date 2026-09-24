# 2026-09-20 M07 Pi 主会话接入

## 授权与范围

用户在 M01–M06 对齐与实现之后，进一步授权实现 M07 的 Pi 主会话接入和动态委派。本批只把已对齐的 M07 阶段语义接入现有 research harness；不恢复或实现 M08/M09，不修改 `workflow/v1.0/` 或 P07 正文，不新增 handoff 文档，也不引入 RSI、workflow 自我改进或默认模型路由。

## 当前承载

- 显式入口为 `pi -e ./extensions/research.ts`。extension 向交互式 Pi 主会话提供状态、初始化、M01–M06 阶段运行、M07 目标管理、动态委派和任务验收工具。成功的研究操作只为当前 Pi session 和对应 workspace 激活 P07 执行边界；失败不激活，切换 session 或 cwd 不继承，并可用 `/research off` 显式停用。
- extension 不替换主会话模型。新建的研究会话继续只从工作区 `research.config.json` 读取角色模型；只有实际启动模型子会话的操作在缺少配置时拒绝，goal/status/plan/decision/review/finish 等非模型操作不要求模型配置。
- M07 将原问题、目标关系、约束、成功要求、计划和当前知识/M04 基线写入持久目标。正式目标要求已有完成的 M04 基线；没有时只能显式建立 exploratory 目标。
- 每项任务在新的 SDK session 中运行。显式输入复制到任务目录。execute 任务必须声明位于 task work 目录的预期文件，并启用 Pi 原生 read/write/edit/bash；check 任务只读该目录，reason 任务无工具，check/reason 可不声明额外文件，但自动保存的 `report.md` 是真实产物。
- execute 的 cwd 和工具白名单缩小默认作用面，但不是 OS 沙箱；bash 仍具有当前进程权限。execute session 不允许 resume，以免后续恢复时无声扩大工具范围。
- 任务会话返回只形成 `returned`。主 Agent 必须检查真实产物，逐项记录预定义 checks、固定版本的文件证据、失败、未执行项和限制；满足全部关口后才可 `accepted`。验收冻结本任务报告、采用产物和独立 checker 报告，反馈只读取这些固定副本。需要独立检查时，必须引用另一个真实 check 任务及其报告，核对其输入副本对应当前提交版本，并说明如何处置发现；不引入哈希清单。
- 目标结束时记录 partial、blocked 或 fulfilled 及返回 M04/M05/M06/M08/continue/user 的选择，并逐项映射原始 successCriteria。fulfilled 要求每项原目标标准 passed 且有来自已接受任务的固定文件证据、至少一个实际任务、当前有效任务义务均 accepted 且没有开放的用户决定。supersedes 必须保持 objective、checks、expectedOutputs、mode、独立检查要求和输入版本；合法替代任务接受后，其递归替代链上的旧失败不再永久阻止 fulfilled，但失败历史不会删除。M08 仍未实现，选择 M08 只记录返回方向。
- M07 反馈包包含全部任务状态、失败、未执行项、限制、工具日志和实际材料；送入 M04 时强制使用 fresh research 会话。

## 隔离、取消与恢复边界

- M01–M06 延续现有 session 输入隔离：关闭自动发现的 context、skills、extensions、prompt templates 和追加 system prompt，只搬运控制器显式提供的内容。M07 任务同样关闭资源发现；execute 例外是 SDK cwd 明确指向自己的 work 目录。
- Pi 工具调用的 AbortSignal 会传给 runner；prompt 前已取消则不发请求，执行中调用 SDK session abort，abort 或非正常 stop 不能当成功。自定义工具可接收 signal，但现有 HTTP/browser 后端是否即时终止取决于各自实现，不能声称所有外部动作瞬停。
- 会话文件和目标状态可用于查看与既有 M01/M03 等允许路径的恢复。M07 execution session 禁止恢复；结束目标不能自动重跑。进程退出后的 running 操作不会自动恢复或重放，只能如实查看，并会阻止结束目标；本版没有修改该未知状态的恢复 API，不能假称已经结束。
- 当前 extension 工具调用同步等待，没有 detached/异步 job、后台队列或跨进程调度器。工作区 mutation 互斥只存在于当前 Pi 进程，不能当作跨进程任务锁。

## 验证状态

实现包含离线、无网络、无真实模型的注入式 runner、extension/service 和 M07 controller 测试，并把 `extensions/**/*.ts` 纳入 TypeScript 检查。最终验证结果：

- `node third_party/pi/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：通过。
- `npm test`：66 项测试通过，0 失败、0 取消、0 跳过；共 8 个 suite。
- `git diff --check`：通过。
- 模拟公开文件清单使用 `git ls-files --cached --others --exclude-standard`；`third_party/`、`resources/`、`.agent/private/`、`node_modules/`、`.venv/` 和试验工作区均未进入清单。本机上游 checkout 的嵌套 `.git` 目录存在，但位于被排除的 `third_party/` 下。
- 对本批文件扫描了机器绝对路径、常见私钥/API token 形态和已知本地地址，未发现命中。`workflow/v1.0/` 的 Git diff 与状态均为空，原 workflow 正文未修改。

这些结果验证当前离线实现与发行边界，不声称真实模型端到端、长任务、provider 行为或科研效果已经验证。

## 本批文件与原因

- `extensions/research.ts`：提供 `pi -e` 显式入口。
- `src/pi/extension.ts`、`src/pi/service.ts`：注册主会话工具，连接 M01–M07 服务，处理激活、进度、取消、进程内 mutation 互斥和非模型状态操作。
- `src/m07/controller.ts`、`src/m07/types.ts`：实现持久目标、动态任务、固定输入与验收副本、独立检查、递归 supersedes 义务、目标验收和 M04 反馈包。
- `src/runner/types.ts`、`src/runner/pi.ts`、`src/runner/fake.ts`：增加 execution grant、Pi 原生工具白名单、任务 cwd、调用日志、取消传播和不可恢复边界。
- `src/stages/m04.ts`：让 M07 反馈强制进入 fresh research 会话。
- `src/index.ts`：导出新增的 M07 与 Pi 接口。
- `test/m07.test.ts`、`test/pi-extension.test.ts`、`test/runner/pi.test.ts`：离线覆盖目标/任务状态、真实文件验收、报告与独立检查冻结、supersedes 限制、extension 生命周期、隔离、工具和取消。
- `tsconfig.json`：把 `extensions/**/*.ts` 纳入类型检查。
- `README.md`、`docs/README.md`、`docs/implementation/design.md`、`docs/research/workflow-foundation.md`、`AGENTS.md`：同步 M07 已实现入口、真实能力与未实现边界。
- `.agent/notes/2026-09-20-m07-pi-integration.md`：记录本批授权、实现、验证和发行审计。

## 保留边界

本批没有修改 `workflow/v1.0/`、第三方源码或 Python 工具，没有实现 M08/M09、后台任务、断线 running 续跑、跨进程 M07 任务锁、模型默认路由、RSI 或 workflow 自我改进。M07 的 cwd 与工具白名单不是 OS 沙箱；真实模型、网络和外部工具取消响应仍需另行验证。
