# Runner 计量、读取范围与生命周期修复

- 由审计建议触发，runner 改为按 Pi 追加式会话条目记录每次 prompt 的 assistant、工具 usage、压缩与分支摘要用量。每个条目按 ID 只计一次，异常及中断也保留账目，缺失 provider 用量标记为 unknown。
- 用量账目逐次写到会话旁的本地 `.usage.jsonl`，明确 Pi cost 是按本地模型价表计算的估算；零价表的 cost 不作完整费用证明。
- 只读材料工具记录实际返回到模型的正文行范围、截断和错误状态；单纯访问文件不代表全文覆盖。
- 显式方法版本元数据随会话 spec/ref 固定，续接时核对，继续关闭全局扩展、技能与上下文文件发现。
- 会话建立后若配置落盘失败则释放 SDK session；dispose 幂等；本地 telemetry 低频记录进程内存与活跃会话数，仅用于观察，不能归因系统内存警告。
- 离线验证：`npm run typecheck` 与 `node --test test/runner/pi.test.ts`（16 项通过）。未调用真实模型或网络。
- 主 Pi 编排会话另加本地只含计量字段的 `.agent/telemetry/pi-main-usage-<sessionId>.jsonl`；按 session entry ID 水位去重，session 切换、agent 结束、关闭时刷新。无 assistant 用量回传的调用记 unknown。该账只涵盖 Pi SDK 可见记录，无法确认 provider 未回传的费用、隐藏重试或 Codex 人工开发成本；跨进程改变 cwd 时历史用量归属也可能不完整。
- 主账离线验证：`npm run typecheck` 与 `node --test test/pi-main-usage.test.ts`（3 项通过，含同一会话切换 cwd 水位）。

## 最终串行验收

- 本地 `node_modules/.bin/tsc` 指向项目 TypeScript，版本 5.9.3；全局 PATH 无 `tsc`，`npm run typecheck` 使用本地版本并通过。
- `npm test` 串行 183 项中 180 项通过；另 3 项 dashboard loopback 测试在受限沙箱内因 `listen EPERM 127.0.0.1` 未运行成功。仅这 3 项在正常权限通道离线重跑，通过 3/3；未调用真实模型或外网，未改测试/依赖。
- `git diff --check` 通过。`.agent/notes/`、`.agent/telemetry/` 和 `workspaces/` 均被 `.gitignore` 排除；已跟踪列表中仅有 `.agent/notes/.gitignore`。本轮生成的 telemetry 总计约 88 KB，最近 15 分钟未见上述目录内大于 10 MB 的新文件。独立进程检查未见残留 `node --test`、`tsc --noEmit` 或本项目子进程。现有 `workspaces/` 约 228 MB，为忽略的既有本地工作区，未清理。
