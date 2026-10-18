# W2：CLI 与扩展两条入口的保护对等

## 为什么

探查已记录：CLI 的阶段命令不经过 `ResearchService.withMutation`，因此没有进程内互斥、
没有跨进程工作区所有权、没有看门狗；`goal delegate` 也不传候选核验器与执行后端（cli.ts 对比 service.ts）。
依据 RB-A2-08 / RB-A5-22：接受/拒绝的判定权必须归确定性引擎，完整性门禁实测驳回了工作流自己接受的
12.5%–33.3%；一条绕过核验器的入口等于给自报留后门。所有权缺失还会让控制台与 CLI 同时改一个工作区。

## 改了哪里

- `src/cli.ts`：
  - 命令分发拆成 `runCliCommand`，`main` 只做解析与保护选择；只读命令（status、goal status、
    knowledge pack、mission status/reconcile-status）直接执行，其余一律包进
    `withWorkspaceMutationOwnership`，与 service 走同一把跨进程锁。
  - `goal delegate` 按 `PRE_RSI_LOCAL_OPERATOR_CONFIG` 绑定宿主核验器与执行后端（与
    `extensions/local-operator.ts` 同一套校验），相对路径等不可信配置直接拒绝。

## 验证

- 类型检查 0 错误；`stage-cli`、`local-mission-cli`、`knowledge-epoch-workflow` 全部通过。
- 新增两项测试：伪造一个活着的外部 owner 记录后，`m01` 被拒而 `status` 仍可读；
  相对路径的宿主配置在 `goal delegate` 上被拒。

## 未做

CLI 没有 `ProgressRunner` 的心跳与停滞看门狗（那是 service 的进度上报通道，CLI 是前台同步执行，
没有可上报的宿主）。如需对等，应在 service 侧统一暴露，不是在 CLI 里复制一份。
