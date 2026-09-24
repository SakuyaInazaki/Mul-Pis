# 2026-09-21 工作流可观测性与启动器修复

## 变更范围

- 同步模型会话长时间静默时，父日志缺少增量进度。
- 暂停主 Pi 时，run.pid wrapper 退出后可能遗留独立 pi 子进程。
- 默认模型启动路径需要明确回到官方 DeepSeek；不在启动器中硬编码第三方供应商黑名单。

## 代码变更

### src/pi/service.ts

- ResearchProgress 增加 prompt-heartbeat 阶段。
- ResearchServiceOptions 增加 progressIntervalMs，默认 15000 ms，0 表示禁用。
- ProgressRunner 在 handle.prompt 执行期间周期性发出心跳，完成后清理 timer。

### scripts/run-deepseek-local.ts

- 无显式 --model/--provider 时默认使用 deepseek/deepseek-flash:high。
- 主 Pi 使用 high；工作区 research.config.json 中所有子会话角色与 M03 reviewer 保持 deepseek/deepseek-flash:low。
- 模型选择仍由调用方显式参数或默认官方模型决定；启动器不负责硬编码第三方供应商策略。
- 子进程使用独立进程组，SIGINT/SIGTERM/SIGHUP 转发到子进程组，避免 wrapper 退出后遗留 orphan pi。


## 验证

- npm run typecheck 通过。
- npm test 通过：123 tests，0 fail。

## 边界

- 未触碰平台、提交、评测器、真实模型。
- 工作树中已有的未提交变更（M07 interrupt、M09 partial 等）属于之前批次的修复；本记录覆盖可观测性与启动器修复。
