# 研究 harness 实现 — 2026-09-20

## 授权与范围

用户在两轮审查后要求“认真思考并进一步实现”。本批据此实现运行时的第一版，范围限于已对齐的 M01–M04 与 M06、知识库和工作区；M05 工具、M07 的 Pi 端封装、M08/M09 未实现（后两者仍是暂定安排）。设计决定与理由见 `docs/implementation/design.md`；AGENTS.md 的“Current implementation boundary”已同步改写。

## 实际变更

- 新增 `package.json`、`tsconfig.json`：Node 26 原生类型剥离运行 `.ts`；`npm test` 为 `node --test`，`npm run typecheck` 为 `tsc --noEmit`。依赖通过 `node_modules/` 符号链接指向 `third_party/pi/packages/{coding-agent,ai,agent}` 与其 `node_modules` 中的 `typescript`、`typebox`、`@types`；`node_modules` 被 `.gitignore` 忽略，没有联网安装。
- 新增 `src/`：
  - `types.ts`、`config.ts`、`workspace.ts`、`prompts.ts`：共享类型、角色→模型配置（无默认模型）、工作区布局与行为记录、提示词读取（运行时读 `workflow/v1.0/提示词/`）与材料装配。
  - `runner/types.ts`、`runner/fake.ts`（主会话编写）；`runner/pi.ts`（GPT-5.6 Sol 执行，主会话审查）：Pi 0.85.1 SDK 会话运行器，所有资源发现关闭、系统提示整体替换、空 cwd 与空 agentDir、内存 settings、按 `provider/model[:thinking]` 解析模型、工具授予为“无”或“限定目录只读 + 目录列表”，越界符号链接与 PDF 拒绝，读取覆盖记录，会话规格 `.spec.json` 与 JSONL 并存以便续接。
  - `knowledge/types.ts`（主会话）；`knowledge/store.ts`、`pack.ts`、`views.ts`（GPT-5.6 Sol 执行，主会话审查并修正）：七类记录、不可改写的版本文件、提案结构校验、单一串行合入（进程内队列 + 锁文件）、限制先写、影响分析只传播 needs_recheck、快照 `G###` 与 `CURRENT`、派生可用性、局部知识包与派生视图；全程无哈希。
  - `stages/`：`init.ts`（P00R 目录 + 知识库初始化）、`m01.ts`、`m02.ts`、`m03.ts`、`m04.ts`、`m06.ts`、`context.ts`。会话边界与当前对齐逐条对应，见设计文档第 2 节。
  - `cli.ts`、`index.ts`。
- 新增 `test/`：阶段契约测试（假运行器 + 真实文件存储）、知识库测试、Pi 运行器测试（注入桩会话，不调用模型）、发布态测试。
- 新增 `docs/implementation/design.md`；更新根 `README.md`、`docs/README.md`、`AGENTS.md`、`.gitignore`。

## 主会话对 Codex 交付的审查与修正

- 两份交付均通过类型检查与各自测试，报告无规格偏离。
- 修正一处与手册验收用例 T32 相关的漏洞：原实现的 `get/list` 读取目录中最新版本文件，合入在写记录后、移动 `CURRENT` 前中断时，未发布的版本会被读到。改为读者只按 `CURRENT` 快照读取，未发布的残留版本文件不可见；下一次合入允许覆盖这类残留并在结果 `warnings` 中如实记录；已发布版本永不覆盖。新增 `test/knowledge/published-state.test.ts`。
- 阶段测试一处断言写错已改正（M02 把非文本原始信息记为“未纳入”是正确行为）。

## 验证

- `./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：无错误。
- `node --test --test-concurrency=1 'test/**/*.test.ts'`：23 项全部通过，全部使用假会话或桩会话，没有调用模型或网络。
- CLI 用 `--runner fake` 在临时工作区跑通 init → m01 → m02 → m03 → m04 --from M03 → m06 → m04 --from M06 → status。
- Pi 运行器路径在本机因未配置 provider 而在模型解析处明确失败，未产生网络请求；这说明真实模型端到端运行尚未执行。

## 未完成与待用户决定

- 本机 `~/.pi/agent/auth.json` 没有任何 provider；真实运行前需在 Pi 中配置 provider，并在工作区 `research.config.json` 为各角色指定模型。
- M05 抓取工具、PDF/图表处理、M07 的 Pi extension 封装、M08/M09、并发与预算策略、跨进程合入锁之外的多机协调均未实现。
- 本批未提交、未推送。

## 冒烟运行中发现并修正

- CLI 入口判断原用 `new URL(import.meta.url).pathname`，仓库路径含 `[WF]` 被百分号编码后永不匹配，命令静默无输出；改为 `fileURLToPath`。
- M03 泄露检查原按整段子串匹配，评审输出很短或与问题重合时会误判；改为按出题依据中 ≥20 字的整行匹配（`rationaleLeaks`），并加单元测试。
- 假运行器跨进程续接：`resume` 在内存中找不到会话时改为从持久化的 `.spec.json` 与 JSONL 重建，使 `--runner fake` 的 CLI 演练能跨命令续接 M01 会话。
- 修正后用 `--runner fake` 完整跑通 init → m01 → m02 → m03 → m04 --from M03 → m06 → m04 --from M06 → status；作答消息不含出题依据，rationale.md 含之；每次运行都生成 run.json 与行为记录。

