# pi-research 2026-09-19

## 范围

仅调查 `Pi/` 现存仓库及 Pi 官方实时资料；没有修改 Pi 源码、安装包、执行第三方代码、commit 或 push。

## 身份记录

- initial path: `Pi/`
- current path after approved organization: `third_party/pi/`
- origin: `https://github.com/earendil-works/pi.git`
- branch: `main`
- commit: `e4c75a73222ae2c72abb5f5314fa35ee8effc508`
- commit time/title: `2026-09-16T23:35:01+02:00 fix(coding-agent): replace the system prompt when a handler forces it`
- checkout history marker: `grafted`（浅/截断历史）
- package versions inspected: `0.85.1`
- official site: `https://pi.dev/`
- official repo: `https://github.com/earendil-works/pi`

## 关键事实

1. Pi 是最小化 terminal coding harness；核心扩展面为 TypeScript extensions、skills、prompt templates、themes、packages。
2. 原生有多 provider/model、工具循环、JSONL 树状 session、fork/clone/tree、compaction、SDK、print、JSON events、RPC。
3. MCP、sub-agent、permission popups、plan mode、to-dos、background bash 被官方明确列为非核心内建；subagent/plan/sandbox/permission 只在示例扩展层出现。
4. Pi 无内建 permission system/sandbox；默认继承启动用户权限。Project trust 只控制项目资源加载。Tool event hook 和确认 UI 是软策略，不是隔离边界。
5. 既有 workflow 已规定 M01–M09、references/notes/knowledge、C/K/E/J/Q/D/X、三种状态与串行合入；Pi session 只可作为对话记录和推理谱系，不能替代它们。
6. 自我进化自治等级（建议、人工采用、受控自动采用等）尚待用户决定，本轮不定义方案或实现。
7. Chord/protocol/client/server/telemetry/evals 是相邻包；未核验为 coding-agent 内建完整科研编排能力，不能直接计入原生能力。

## 产物

- `docs/research/pi-harness.md`

## 未决事项

- 实施时重新核验 npm latest、`pi --version`、Git SHA 与 changelog。
- 明确实验执行环境、数据合规、成本阈值和实际权限边界。
- 有限子任务委派是既有需求；具体 Pi 实现、模型路由、并发与失败传播仍待验证。MCP 不是当前主轴。
- 本轮未连接模型、启动 Pi/SDK/RPC、执行实验或验证科研闭环；可行性结论属于接口级调研。

## 纠正记录

- 2026-09-19：按验收反馈，将报告第 5/6 节整体降格为非约束性候选，不预设自治等级、人工批准流程或实施顺序；安全建议改为条件式。
- 2026-09-19：补充关键能力在固定提交 `e4c75a7` 下的官方文档 permalink，避免只引用会变化的 `latest`。
- 2026-09-19：公开 notes 中的本机绝对路径改为仓库相对路径。
- 2026-09-20：在完整阅读并通过验收的 workflow 基线之上重写 Pi 报告；删除旧报告自造的 `research/tasks`、`claims/evidence/runs` 目录和独立状态机，不再用它们替代既有 M01–M09、C/K/E/J/Q/D/X 与三状态设计。
- 2026-09-20：重点核验输入隔离、两次独立交互、有限委派、网页 AI 人工转交、长实验、真实材料固定、知识合入和 M09 停止；明确 `--no-context-files/-nc`、`--no-session`、project trust、SDK `AgentSessionRuntime` 与官方 subagent 示例的实际边界。
- 2026-09-20：仅只读 `third_party/pi/` 固定快照和当前官方文档；未安装/运行 Pi，未连接模型，未执行科研闭环。
- 2026-09-20：最终验收修正权威 workflow 链接；明确 M01→M02 是同一 Pi 交互中的顺序两轮，SDK 实际字段为 `resourceLoader`；补充默认无专用联网/PDF 工具，并区分同步 `bash` 与异步长作业生命周期。
- 2026-09-20 补记：上一条中“M01→M02 是同一 Pi 交互中的顺序两轮”及本记录多处的“网页 AI 人工转交”已被同日的 M01–M09 当前对齐取代：M02 为同模型新会话，M03 为主 Agent 自动编排。以 `docs/research/workflow-foundation.md` 的“当前对齐”为准；`docs/research/pi-harness.md` 已同步，并按独立审查修正了 subagent 示例终止、parallel 限制范围、SDK 引用位置与 session-backends 遗漏，见 `2026-09-20-audit-fixes.md`。
