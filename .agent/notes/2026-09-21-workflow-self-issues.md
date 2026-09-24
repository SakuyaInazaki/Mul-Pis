# 2026-09-21 工作流自身问题增量记录

- 日期：2026-09-21
- 本记录承接 `.agent/notes/2026-09-20-workflow-trial-fixes.md`、`.agent/notes/2026-09-20-m07-pi-integration.md`、`.agent/notes/2026-09-20-xpuoj-105-workflow-trial.md`、`.agent/notes/2026-09-20-workflow-critical-fixes.md`。
- 目的：只补充前批记录尚未覆盖、或只在上批被一句话带过的工作流自身问题；不重复已有条目，不把 XPUOJ #2 的题目、分数、通道或平台策略写成工作流问题。
- 证据：只读检查当前 `src/` 代码、`run.jsonl`、`.agent/sessions` 与现有 notes/docs。没有修改源码、没有 commit、没有提交平台任务。
- 本次 XPUOJ #2 运行只作为触发实例；题目相关事实不进入本记录的结论。

---

## 1. 与已有记录的关系

以下条目已被前批记录或当前设计文档明确记载，本记录不再展开，只做索引：

| 主题 | 已有记录 |
|---|---|
| M07 同步等待、无 detached/异步 job、无后台队列 | `.agent/notes/2026-09-20-m07-pi-integration.md`；`docs/implementation/design.md` |
| M07 `research_delegate` 不经过 `runStage`，不在正常 shutdown run 记录机制内 | `.agent/notes/2026-09-20-workflow-trial-fixes.md`；`docs/research/workflow-foundation.md` |
| 工作区 mutation 互斥只在当前 Pi 进程内，不是跨进程任务锁 | `.agent/notes/2026-09-20-m07-pi-integration.md`；`docs/implementation/design.md` |
| 断线 running 任务不会自动恢复或重跑，只能受控归档 | `.agent/notes/2026-09-20-m07-pi-integration.md`；`.agent/notes/2026-09-20-xpuoj-105-workflow-trial.md` |
| M07 `research_goal interrupt` 只归档，不自动重跑或假称完成 | `.agent/notes/2026-09-20-workflow-critical-fixes.md` |
| M09 partial 收口规则与 unresolved 门禁 | `.agent/notes/2026-09-20-workflow-critical-fixes.md`；`docs/implementation/design.md` |
| 重复失败控制与晚返回不能覆盖 shutdown 记录 | `.agent/notes/2026-09-20-workflow-trial-fixes.md` |
| M07 `finish` 对 unknown-running 任务 fail closed | `.agent/notes/2026-09-20-m07-pi-integration.md`；`test/m07.test.ts` |

因此以下内容只记录**新增/明显欠说明**的部分。

---

## 2. 新增问题：M07 文本输入副本整段内联，没有消息预算或大文件保护

### 现状
- `src/m07/controller.ts` 的 `TEXT_EXTENSIONS` 把 `.json`、`.jsonl`、`.csv`、`.md`、`.py` 等都归为 `text`。
- `mediaType(file)` 只按扩展名分类，不按文件大小或实际内容分类。
- `taskMessage()` 对每个 `text` 输入副本执行：
  `await readFile(item.copy, "utf8")`
  然后整段追加到子任务 prompt。
- `knowledgeIds` 生成的局部知识包有 `maxChars: 60_000`，但 `inputs` 数组没有等价的字符数上限。
- `research_delegate` / `TaskSpecInput` 没有请求级消息预算、单文件大小上限或“只给路径、由子会话按需读取”的 text 引用模式。
- 输入副本会被复制到 `work/inputs/`，但复制行为本身不等于子会话会通过工具读取；当前 text 输入仍会被完整内联。

### 影响
- 大文本输入会直接进入子会话 prompt，可能在产生 assistant message 前失败。
- 失败信号是通用的 `session ... produced no assistant message`，不是明确的输入超限错误。
- 该失败发生在完整子会话启动之后，且同一义务的重复 member / 重复委派可能重复触发。
- 这是 M07 委派输入边界的问题，不依赖具体题目、平台或文件内容类型。

### 本次触发实例（只作证据锚点）
- `T002`、`T003` 两个 M07 task 的 `message.md` 约 2.9 MB，输入包含约 3 MB 的 JSON，最终执行失败并记录为 `session M07-T002/T003 produced no assistant message`。
- 该错误文本只说明 runner 没有取到 assistant message，不能指出原因是输入超限；这使同类失败在状态层表现为通用执行失败，而不是可识别的输入预算错误。
- 后续改为在 objective 中显式限制“不得整段读入大 JSON”后，同批核验才返回。

### 与前批记录的关系
前批 `workflow-trial-fixes` 已记录“输入隔离/不可信数据边界”，但未记录“text 输入无大小预算、整段内联、失败表现为 no assistant message”这一实现层缺口。

---

## 3. 新增细节：长委派的持久可观测性不足

### 现状
- 主 `run.jsonl` 的 `tool_execution_start`、`tool_execution_end`、`tool_execution_update` 顶层没有 `timestamp` 字段。
- `src/pi/service.ts` 的 `ProgressRunner` 只报告粗粒度阶段：`session-create`、`session-created`、`prompt-start`、`prompt-complete`。
- `prompt-start` 之后到 `prompt-complete` 之间没有周期性 heartbeat。
- `CurrentGoal`、`M07TaskRecord` 没有 last-heartbeat、lease、last-tool、progress-summary 等可持久轮询字段。
- `delegate()` 只在开始写入 `running` 和结束时写入 `returned/failed` 两个时刻保存 goal；长等待期间主记录不变。
- 长委派期间真正仍在更新的是子会话 `.agent/sessions/*.jsonl` 与 `.agent/telemetry/*.json`，它们不在主 `run.json`/`goal.json` 的监控入口内。

### 影响
- 按标准入口监控时，无法区分：正常长执行、等待外部条件、实际挂起、子会话静默失败。
- tool 事件无时间戳，无法用主日志可靠计算工具持续时间或检测停滞。
- 本次运行中，操作员必须直接读取子会话 JSONL 才能确认子任务是在 `sleep` 等待，而不是崩溃。
- 前批记录已记录“running 状态可能与进程结束脱节”，本条补充的是**长等待期间主状态缺少心跳和时间戳**。

---

## 4. 欠说明：M07 “有界任务”没有 wall-clock deadline

### 现状
- 工具描述和流程文档使用 `bounded task`，但当前边界是 inputs / expectedOutputs / checks 的声明边界。
- `TaskSpecInput` 没有 `timeout`、`deadline`、`maxDuration`、`heartbeat`、`maxToolCalls` 等字段。
- `research_delegate` 工具参数也没有超时参数。
- `delegate()` 直接 `await handle.prompt(message)`；`src/runner/pi.ts` 的 `prompt()` 没有 deadline，只在外部 `AbortSignal` 触发时 abort。

### 影响
- 子任务可以用长 `sleep` 或其他阻塞工具让父调用长时间不返回。
- 父 Pi 在该 tool call 结束前无法继续编排，且没有自动 timeout 把任务转入明确失败。
- 前批文档已说明“同步等待、无异步后台 job”，但没有说明“项目当前不设 deadline，因此长任务只能靠人工中断或模型自行返回”。

---

## 5. 欠说明：M07 interrupt 与真实会话生命周期没有绑定

### 现状
- `M07Controller.interrupt()` 只接收 runId/reason；它把 goal 中所有 `running` task 改成 `failed`，关闭 goal 为 `blocked`，写反馈包，并把 M07 run 结束为 failed。
- 该操作只修改持久状态文件；`M07TaskRecord.session` 存在，但 interrupt 路径没有调用对应 session 的 abort，也没有等待真实会话结束。
- 现有文档已说明中断是 archival、不会自动重跑或假称完成；本条需要补充的是：**归档状态不保证终止实际子会话。**

### 影响
- 如果 interrupt 与真实子会话并发，状态文件可以先进入 finished/blocked，而实际子会话仍在运行并可能继续写 work 目录。
- 下游读取 goal 时无法从状态本身判断实际会话是否已经停止。
- 该行为与前批“取消会传给 Pi session、后端 signal 支持不一致”的说明相邻，但不等价：这里记录的是 interrupt 归档路径本身没有绑定 session abort。

---

## 6. 本次不重复记录的既有问题

以下问题已经足够清楚，本次只作为索引，不再展开：

- `research_delegate` 不经过 `runStage`，因此正常 `session_shutdown` 的中断记录机制不覆盖 M07 delegate。
- 扩展工具同步等待，没有异步队列、后台 job 或跨进程调度器。
- 工作区 mutation 锁是进程内内存锁，不是跨进程锁；SIGKILL/崩溃恢复不保证。
- `finish` 对 running 任务 fail closed；没有 task 级 cancel/reconcile API。
- 重复失败控制只覆盖 extension/service stage 路径，不覆盖 CLI 直接阶段入口。

以上均在 `.agent/notes/2026-09-20-workflow-trial-fixes.md`、`.agent/notes/2026-09-20-m07-pi-integration.md`、`.agent/notes/2026-09-20-xpuoj-105-workflow-trial.md` 或 `docs/` 中有记录。

---

## 7. 本次新增问题的类型归纳

本次真正新增的是三个更底层的实现边界：

1. **输入预算边界缺失**：M07 text 输入无字符数/字节数上限，整段内联。
2. **持久心跳边界缺失**：委派内部只有粗粒度 phase，主记录无 heartbeat/lease，tool 事件无 timestamp。
3. **deadline 边界缺失**：bounded task 只约束产物和检查，不约束 wall-clock 时长。

其他问题大多不是新发现，而是前批记录已经承认的限制：同步阻塞、无跨进程锁、running 不可自动恢复、interrupt 只归档。

---

## 8. 限制

- 本记录只归纳工作流自身问题，不给修复方案，不改变既有设计结论。
- 引用具体运行实例只是为了定位触发条件，不作为工作流效果或题目结论。
- 本记录未修改源码；若后续要实现输入预算、heartbeat 或 deadline，需另行任务与用户授权。


---

## 9. 2026-09-21 收口时新增观察

以下来自本次运行的最终收口报告；仍只记录工作流/harness 层问题，不把题目结果混入。

- T002/T003 的失败现在有精确数字：check 模式把 2.93 MB 原始 JSON 作为输入副本内联，触发模型上下文上限，请求 1,242,732 > 上限 1,048,576 tokens。该数字补充了 WF-01 的触发证据。
- M07 反馈包整体超出可用上下文：M04 无法直接消费完整 M07 反馈，只能改用有界代理文件（任务报告）作为反馈。这说明 M07→M04 的反馈交接缺少大小分层/摘要机制，是 WF-01 之外的另一条输入预算边界。
- 一次 M04 因模型把知识提案中的 id 写成 `K023@1` 而非裸 `K023`，被结构校验拒绝；该 run 记为 failed、未合入，随后必须用另一个反馈文件重跑。这说明目标反馈交接中的格式错误会直接消耗一轮 M04，需要后续在流程层面决定如何处理“模型输出格式错误”与“有界重试/校验提示”。
- 以上三项均属于工作流/harness 自身问题，不依赖具体题目的算法或平台策略；修复设计留待工作流所有者后续决定。


---

## 10. 2026-09-21 continuation：主 Pi 自行 partial 收口并退出

### 事件
- 运行：M07 goal `20260921T054815Z-45aa`。
- 用户目标：继续真实提交，目标最高分，至少 70。
- 实际结果：真实最好到 68.6（SID 147463/147473，triton-h20）后，主 Pi 判断当前路线观测上限约 69.2–69.4，目标 70 不可达。
- 主 Pi 之后自行：
  - 写 `goal.json` 为 `lifecycle=finished`、`outcome=partial`、`returnPath=user`；
  - 输出最终汇报，列出 5 个待用户拍板选项；
  - Pi 进程随后正常退出（`agent_end`/`agent_settled`）。
- 操作员没有发停止指令、没有 kill、没有自动重启；操作员只观察到进程退出并汇报“当前无运行进程”。

### 工作流问题
- 当用户已给出明确未达成的数值目标时，主 Pi 仍可自行把 M07 goal 收口为 `partial/user`，随后 `-p` 进程退出，用户没有机会在进程存活期间直接回复路线选择。
- 这会使用户看到“目标未达标却已经结束”，只能由操作员重启新的 continuation，而不是在同一个活动 goal 内等待用户决定。
- 现有 M07 状态模型允许 `partial` 如实返回，但缺少“用户明确未达成的量化目标必须保持 active，或先取得用户确认才能 partial 收口”的门禁。
- 该问题与第 9 节记录的“主 Pi 无法在科研执行态写 notes”叠加：本轮变更记录也只能由操作员在退出后补录。

### 证据
- `goal.json`：`lifecycle=finished`、`outcome=partial`、`returnPath=user`、`feedbackPath=.../m04-feedback.md`。
- `run.jsonl` 末尾：`message_end → turn_end → agent_end → agent_settled`。
- 最终汇报文本：明确写出“目标 ≥70 未达成”“需要你拍板”“我在此停下”。
- 用户随后明确质疑“怎么结束了？谁说结束了”，说明该收口没有得到用户的事先确认。


---

## 11. T008 `cuda-recon.txt` 无界递归搜索导致 320 MB 产物

### 事件
- M07 run `20260921T080457Z-068a` 的 T008 是本地只读侦察任务，要求在某些目录/文件里搜索 `cutlass`、`cute/`、`cublas`、`nvcc`、`-arch=`、`sm_90` 等关键词，并逐条记录文件路径与原文片段。
- T008 实际产物 `tasks/T008/work/cuda-recon.txt` 达到 **320,916,619 字节（约 306 MiB）**。
- 该文件头部自述为 case-insensitive grep 扫描，搜索根包含 `~/Desktop/xpuoj-p1/`、`~/Desktop/xpuoj-p2/` 等大目录。
- 文件未使用 `grep -l`、`--include`、`--exclude-dir`、`-m/--max-count` 或输出字节上限；结果是所有匹配行的全量倾倒，包含仓库与历史 transcript 的大量文本。
- 后续主 Pi 在查看 T008 目录时遇到该文件，出现多轮 `auto_retry_start/agent_end/auto_retry_end` 后退出；新 continuation 只能显式禁止再整段读取该文件。

### 工作流问题
- 任务描述只要求“搜索”，没有规定工具、搜索范围白名单、排除目录、单文件大小上限或结果条数/字节预算。
- 环境实际已安装 `rg`（`/opt/homebrew/bin/rg`, ripgrep 15.2.0），但执行会话选择了 BSD `grep -RIn` 的递归全量匹配路径；工具选择指导缺失。
- M07 execute 任务没有对“搜索产物可能达到数百 MB”设置预算或中断阈值；失败表现为后续上下文/重试问题，而不是搜索阶段快速失败。
- 这和第 9/10 节的问题同源：工作流缺少对大输入/大输出的硬预算。

### 证据
- `tasks/T008/work/cuda-recon.txt`：320,916,619 bytes，UTF-8，含超长行。
- `tasks/T008/message.md` 第 38 行附近：只写“搜索”，未限制工具和输出规模。
- 环境：`rg` 可用；`grep` 为 BSD 兼容版。
- 后续 `run.jsonl` 末尾：`auto_retry_start → agent_end → auto_retry_end → agent_settled`。

## 12. 第三方中转站间歇性 provider error：Service temporarily overloaded（监控窗口 ��

### 现象
- 主 Pi PID 存活，但 `run.jsonl` 在当前 turn 连续出现 `message_end / turn_end` 的 assistant `stopReason=error`，`errorMessage="Service temporarily overloaded"`，且 `usage.output=0`。
- 日志序列为 `agent_end → auto_retry_start(attempt=1/2/3, maxAttempts=3) → agent_start → turn_start`；截至记录时最后一次为 `auto_retry_start attempt=3/3 delayMs=8000`。
- 同窗口内此前已出现过空 assistant 消息 / 无有效输出后重试；本条仅记录当前监控窗口新增实例，不重复已有章节。

### 工作流影响
- 监控期间无法把此类 error/重试写成任务 completed 或真实结果；需按 provider 错误如实记录，并报告模型/中转站不稳定。
- 若重试耗尽后没有后续 assistant 文本，主 Pi 可能停在错误态；在用户明确要求前不自动重启。

### 证据位置
- `/Users/sakimi/Desktop/rsi-test/.monitor/xpuoj-2/run.jsonl` 末尾 `auto_retry_start` 事件，字段 `errorMessage=Service temporarily overloaded`、`attempt=3`、`maxAttempts=3`。

### 追加观察（��
- 复查时 `kill -0 15618` 已失败：主 Pi 进程不存在。
- `run.jsonl` 末尾在 `auto_retry_start attempt=3/3` 后继续出现失败 `message_end/turn_end/agent_end`，随后为 `auto_retry_end attempt=3` 与 `agent_settled`；没有新的 assistant 有效输出。
- 因此当前状态应记录为：provider 连续 `Service temporarily overloaded` 导致主 Pi 退出/settled；未自动重启，等待用户明确指令。

## 13. T009 子会话疑似使用旧 DeepSeek provider/model，偏离 caicaicome 统一配置（��

### 现象
- 新主 Pi PID 93209 的 `research_delegate` 生成 M07-T009 子会话。
- 该子会话的 `.spec.json` 及会话日志显示：`model=deepseek/deepseek-flash:low` 或 `model=deepseek-flash`，`provider=deepseek`。
- 当前配置要求主 Pi 使用 `caicaicome/DeepSeek-V4.1-Flash:high`、工作区 M07/研究子会话使用 `caicaicome/DeepSeek-V4.1-Flash:low`，provider 为 `caicaicome`，且用户明确不能换回旧付费 DeepSeek 模型。

### 影响
- 违反模型/ provider 配置边界，可能产生非预期付费调用；在用户明确处置前不得自行切换或重启。
- 该子会话当前仍由 `research_delegate` 等待，telemetry 显示 `activity=active`、`lastSeenAt=2026-09-21T13:07:00.565Z`。

### 证据
- `workspaces/xpuoj-2-dense-gemm-bf16/.agent/sessions/2026-09-21T12-47-45-348Z_01a0c402-12c4-74cc-a6af-e1d6697880d8.spec.json`：`"model":"deepseek/deepseek-flash:low"`。
- 同会话 `.jsonl` 中 45 处 `"model":"deepseek-flash"`、46 处 `"provider":"deepseek"`。
- telemetry：`kind=agent`、`label=M07-T009`、`role=execution`、`activity=active`。

## 14. 官方 DeepSeek 模型核对、切换与 §13 更正（2026-09-21T13:11:56Z）

### 核对来源
- 官方 API：`GET https://api.deepseek.com/models` 返回 HTTP 200、`object=list`，`model_ids=["deepseek-flash","deepseek-v4-pro"]`。
- 官方文档：`https://api-docs.deepseek.com` 的 OpenAI `base_url` 为 `https://api.deepseek.com`；`/api/create-chat-completion` 的 `model` 可选值为 `deepseek-flash`、`deepseek-v4-pro`。

### 对第 13 节的更正
- 第 13 节曾把 `deepseek/deepseek-flash` 描述为“旧 DeepSeek provider/model”，该措辞不准确：`deepseek-flash` 是当前官方 API 的有效模型名，provider `deepseek` 指向官方接口。
- 真正的问题是模型传播与 provider 一致性：主 Pi 以 `--model caicaicome/DeepSeek-V4.1-Flash:high` 启动，但 `research_delegate` 生成的 M07-T009 子会话使用工作区 `research.config.json` 中的 `deepseek/deepseek-flash:low`。主 CLI 的 `--model` 没有传播到 delegate 子会话。
- 用户已明确终止第三方中转站路线；后续统一使用官方 DeepSeek。

### 切换结论
- 主 Pi 后续启动显式使用 `--model deepseek/deepseek-flash:high`；不要再传 `--model caicaicome/...` 或 `--provider caicaicome`。
- 工作区 `research.config.json` 目前所有角色已是官方 `deepseek/deepseek-flash:low`，与用户“官方模型”要求一致，无需改动。
- `scripts/run-deepseek-local.ts` 在没有 `--model/--provider` 时默认注入 `--model deepseek/deepseek-flash`；主 Pi 如需 `:high` 应显式传入。
- 已停止当前主 Pi 进程树，未自动重启；等待用户明确要求后再按官方模型启动。

## 15. 测试期工作流问题总表（工作流范围）

> 记录边界更正：本节只记录工作流 / harness / 进程 / 模型配置 / 可观测性 / 预算 / 生命周期问题。平台题解、真实提交、turnstile 池、题目分数等测试执行细节不属于本记录范围；此前版本误把测试细节写入本节，现予替换。

1) **主 Pi 与 delegate 子会话的模型配置传播不一致**
- 主 Pi 的 CLI `--model` 覆盖只作用于主会话；`research_delegate` 子会话使用工作区 `research.config.json` 的角色模型。
- 影响：同一工作流可能实际落到不同 provider/model，预算、稳定性和审计不一致。

2) **暂停 `run.pid` 不能保证停止完整进程树**
- 仅凭 `run.pid` 发 SIGTERM 后，可能仍有独立 `pi` 子进程及其 bash 子进程继续运行、继续更新 telemetry。
- 影响：暂停/停止语义不可靠，可能留下 orphan 会话。

3) **`research_delegate` 期间父日志无增量事件**
- 父 `run.jsonl` 只记录 delegate 的开始、少量 update 和结束，不转发子会话内部 assistant/tool 事件。
- 影响：长时间静默时无法区分“正常长委派”和“疑似挂起”。

4) **缺少统一的子会话 heartbeat / deadline / 静默阈值**
- 子会话活动可能只体现在独立 telemetry、session jsonl 或任务 work 目录 mtime 上，父日志与监控视图不统一。
- 影响：监控和自动处置缺少可靠判据。

5) **tool 事件可观测性不足**
- `tool_execution_start/end` 等事件可能没有 timestamp；长 thinking / toolcall delta 可能快速膨胀日志，却没有对应的高层进度事件。
- 影响：难以从日志快速定位当前 open tool、开始时间和健康状态。

6) **provider 稳定性与重试耗尽后的状态表达**
- 间歇性 provider error 可能表现为空 assistant 消息、`usage.output=0`、`auto_retry_start` 重试；重试耗尽后进入 `agent_settled`。
- 影响：错误态必须显式保留，不能因重试或静默写成 completed。

7) **orphan / 生命周期状态与真实进程状态不一致**
- 任务状态或 run 状态可能继续保持 `running`，但实际进程已停止或已被替代。
- 影响：监控容易把 orphan 当活任务，或把真实结束误记为 running。

8) **`run.pid` 不代表完整运行根**
- `run.pid` 可能是 wrapper 而非实际执行研究的子进程；wrapper 退出后真实 `pi` 进程仍可能存活。
- 影响：启动、监控、暂停、归档都需要进程组或 session/telemetry 关联。

9) **大文件与无界输出缺少预算**
- 长命令或搜索可能生成超大文件；长时间模型输出也可能快速放大 `run.jsonl`。
- 影响：可能触发上下文/OOM/重试；需要单文件大小、输出字节数和日志增长预算。

10) **模型/provider 名称与文档版本漂移**
- 模型 ID 和 base URL 可能随官方文档变化；工作流启动前必须重新核对官方文档 / models 接口。
- 影响：历史模型名或旧配置容易被错误复用。

11) **配置校验与启动前预检不足**
- 启动前没有强制校验：主 Pi 模型、子会话角色模型、provider、base URL、thinking level 是否互相一致且为当前官方有效值。
- 影响：运行时才发现 provider/model 偏离，造成预算和状态风险。

12) **缺少统一 pause / resume / abort 控制面**
- 暂停后需要人工找进程树、判断子会话是否仍在运行、确认 telemetry 是否停止。
- 影响：操作员无法用一个受控动作安全暂停和恢复工作流。


## 16. M07 验收假阴性：expectedOutputs 路径登记与实际落盘文件名/目录项不一致（2026-09-21）

### 现象

- 某次 M07 目标中，多个任务在 `.expectedOutputs` 声明了具体文件名或目录项，例如 `raw/`。
- 子会话实际确实生成了内容，但落盘文件名与声明文件名不一致，或只有目录下的若干文件而不是一个名为 `raw/` 的文件。
- 评审层按声明路径逐项检查，判定这些任务未达到声明产物要求，于是拒绝任务。
- 同义务重试不能降低或改写已有声明；在“相同义务必须原样重试”的约束下，错过一次声明即无法重新通过验收。
- 结果：平台侧真实动作已经成功，但目标收口仍因“任务义务未全部 accepted”而只能记为 `partial`，不能记为 `fulfilled`。

### 影响

- 目标状态与真实科研/平台结果脱节：客观目标已经达成，但 harness 只能输出 partial。
- 任务登记层成为独立失败点，可能掩盖真实成功，也可能让后续目标无法正常收口。
- 目录项声明和“逐文件路径”证据之间存在语义缺口。
- 目前没有受控的声明修正/重新验收路径，除非主 Agent 预先准确知道子会话最终文件名。

### 边界

- 该问题属于 harness 的任务登记、评审与收口协议，不是平台评测器或具体算法路线的失败。
- 本次只记录事实与影响，不在本记录中给出实现修复方案。

## 17. 修复：M07 expectedOutputs 文件/目录解析与评审自动冻结（2026-09-21）

### 修复内容

- 新增 `src/m07/expected-output.ts`，统一按 `task.workDir` 解析声明的 expectedOutputs。
- 声明为文件路径时，要求实际文件存在并位于任务目录内。
- 声明为目录路径时，要求目录存在且直接包含至少一个文件；评审会把这些直接子文件纳入该期望产物的覆盖范围。
- 评审阶段会自动冻结 expectedOutputs 对应的实际文件，并补入 `review.artifacts`，不再要求主 Agent 必须在 `artifacts` 参数中逐一声明。
- 声明路径不存在、目录为空、类型不支持或逃逸任务目录时，仍会记录失败，任务仍会被拒绝。
- 声明目录本轮只展开直接子文件，不递归展开更深层目录；这属于当前有界语义，避免无界遍历。

### 根因对应

- 第 16 节记录的假阴性来自评审只检查主 Agent 提交的 artifacts 是否逐项包含 expectedOutputPaths，而主 Agent 可能漏传声明产物，或声明为目录项时无法与文件路径精确相等。
- 修复后，expectedOutputs 成为任务返回后的真实文件系统义务，评审自动收集并冻结，而不是只依赖调用方重新点名。

### 测试与验证

- 新增 `test/m07-expected-output.test.ts`：验证文件解析、目录展开、缺失文件报错。
- 更新 `test/m07.test.ts`：验证评审能自动冻结声明产物并通过，同时缺失声明产物仍会被拒绝。
- `npm run typecheck` 通过。
- `npm test` 通过：125 tests，0 fail。

### 边界

- 该修复只改变 M07 产物登记与评审协议，不改变执行会话的工具权限、平台动作或算法判断。
- 不引入哈希清单，不改变相同义务重试的比较规则。

## 18. 修复后仍暴露：expectedOutputs 占位/动态路径未在委派时校验（2026-09-21）

### 现象

- M07 任务可以在 `expectedOutputs` 中声明并非真实文件名、而是占位或动态路径的字符串，例如 `raw/detail-<sid>.sanitized.json`。
- 子会话实际落盘的是具体文件名，例如 `raw/detail-52199.sanitized.json`。
- 评审阶段按声明的字面路径检查，找不到名为 `<sid>` 的文件，于是任务被拒绝。
- 同义务重试不能改写 `expectedOutputs`，任务被拒绝后无法重新验收，仍可能让真实完成的任务卡在 partial 收口路径上。

### 影响

- 第 16/17 节的修复覆盖了“文件存在但主 Agent 漏传 artifacts”和“目录声明”两类假阴性，但没有覆盖占位符/动态路径声明。
- 委派阶段没有拒绝不可解析的 `expectedOutputs`，把问题推迟到评审阶段才暴露。
- 真实产物已经生成，却因为声明格式问题被拒绝。

### 证据

- 本次 #4 测试中，T001 的 `expectedOutputs` 含 `raw/detail-<sid>.sanitized.json`。
- 该任务 review failures 明确记录“主 Agent 委派声明缺陷：预期产物列表含占位路径”和“预期产物未实际提交：raw/detail-<sid>.sanitized.json”。
- 实际 work 目录下存在 `raw/detail-52199.sanitized.json` 等具体文件。

### 边界

- 该问题属于 M07 声明语法、委派前校验与评审协议，不是平台评测器或算法路线失败。
- 本记录只记录问题，不在本次修复中直接给出实现方案。

## 19. 长委派中父心跳正常但子会话 provider 错误后停滞（2026-09-22）

### 现象

- M07-T004 的 `research_delegate` 父工具调用持续运行约 9 小时以上，父 `run.jsonl` 仍只有周期性 `tool_execution_update`，没有 `tool_execution_end`。
- 子会话 M07-T004 的 session 记录最后若干条 assistant 消息出现 `stopReason=error`，错误文本包括 `Request timed out.` 与 `terminated`。
- 子会话 telemetry 仍显示 `activity=active`，但 telemetry 心跳由定时器维持，不等于模型或工具仍在产生有效进展。
- 子会话 session 文件长期没有新的实际事件写入。
- 相关 turnstile 池当前可用数为 `submit_problem=0`、`custom_test=0`，没有新增平台 SID。

### 影响

- 父日志的 progress heartbeat 只能证明父包装器仍在运行，不能证明子会话仍在有效工作。
- 长委派可能在子会话 provider 错误后长时间停滞，而父监控看不到错误。
- 无 deadline、无子会话级重试上限展示、无卡死判定阈值时，容易无限等待。

### 证据

- 父日志：`/Users/sakimi/Desktop/rsi-test/.monitor/xpuoj-4/run.jsonl`，T004 的 `research_delegate` 只有 update 事件。
- 子 session：`workspaces/xpuoj-4-top-k-renorm-probs/.agent/sessions/2026-09-21T16-53-44-747Z_...jsonl`，末尾 assistant `stopReason=error`。
- M07-T004 telemetry：`activity=active`、`lastSeenAt` 仍在更新，但 session 无新事件。

### 边界

- 该问题属于 M07 长委派生命周期、子会话错误传播与卡死判定，不是平台算法结果本身。
- 本记录只记录事实与影响；未自动停止或重启主 Pi。

## 20. 长委派根因补充：provider error、父心跳误导、缺少 deadline/watchdog（2026-09-22）

### 结论更新

- 第 19 节记录的长委派不是永久死锁：子会话最终在 2026-09-22T02:20:22Z 恢复并 stop，T004 后续被接受。
- 但一个 `research_delegate` 从 2026-09-21T16:53Z 持续到 2026-09-22T02:20Z，约 9.5 小时，仍属于工作流生命周期问题。

### 直接触发因素

- 父 `run.jsonl` 中统计到：
  - `stopReason=error` 共 16 次；
  - `errorMessage="terminated"` 共 16 次；
  - `errorMessage="Connection error."` 共 5 次；
  - `auto_retry_start` 共 5 次。
- 子会话 M07-T004 中统计到：
  - `stopReason=error` 共 4 次；
  - `errorMessage="terminated"` 共 3 次；
  - `errorMessage="Request timed out."` 共 1 次。
- 说明长延时期间模型/transport 曾反复异常，之后通过内部重试恢复，而不是算法步骤本身持续计算了 9.5 小时。

### 工作流原因

1. **缺少整体 prompt/delegate deadline**
   - `M07Controller.delegate` 调用 `handle.prompt(message)` 时没有总时限。
   - `PiSessionRunner` 只是 `await session.prompt(text)`，没有超时封装；SDK 可长时间重试或等待。
   - 因此单个 delegate 可以在 provider error 后持续占用数小时，而不触发任务失败或用户决策。

2. **心跳只证明父包装器在运行，不证明子会话有进展**
   - `ProgressRunner` 每 15 秒发一次 `prompt-heartbeat`，与子会话实际事件无关。
   - `TelemetryWriter` 每 5 秒写一次 `activity=active`，也只表示定时器存在。
   - 父日志因此持续显示 `tool_execution_update`，掩盖了子会话长时间没有实际进展的事实。

3. **子会话 provider 错误没有可靠传播到父任务状态**
   - 子 session 中已经出现 `stopReason=error`，但父 `task.status` 仍为 `running`。
   - 父 `run.jsonl` 没有把子会话错误实时上报为任务警告或失败。
   - 缺少“子 session 最后事件时间超过阈值”的 watchdog。

4. **缺少卡死判定和受控中止路径**
   - 没有基于子 session 文件 mtime、最后 assistant 事件时间或 telemetry 进程 actual activity 的停滞检测。
   - 没有父侧超过 N 分钟无子会话进展时自动 abort/上报的机制。
   - 因此只能由操作员事后发现“9 小时无结束”，而不是工作流先报告。

5. **资源水位波动没有被生命周期感知**
   - 长委派期间 turnstile 池先后出现可用数波动，甚至 `submit_problem=0`、`custom_test=0`。
   - 任务没有把“池为空、等待回血、回退 api_token”作为可观察状态反馈给父监控。

6. **状态语义问题**
   - `task.status=running` 可以持续数小时，`goal.updatedAt` 不反映子会话是否仍有实际事件。
   - 父 `run.jsonl` 的 heartbeat 与子 `session` 的文件 mtime 没有统一视图。

### 责任边界

- 外部触发因素是 provider/transport 的 `terminated`、`Connection error.`、`Request timed out.`。
- 工作流问题是：没有 deadline、没有子会话 watchdog、heartbeat 语义误导、子会话错误未传播、缺少受控中止与卡死上报。

### 证据

- 父日志：`/Users/sakimi/Desktop/rsi-test/.monitor/xpuoj-4/run.jsonl`。
- 子会话：`workspaces/xpuoj-4-top-k-renorm-probs/.agent/sessions/2026-09-21T16-53-44-747Z_...jsonl`。
- M07-T004 telemetry：`activity=active` 持续更新，但 session 长时间无新事件。

## 21. 修复：prompt 总超时、停滞 watchdog 与心跳语义（2026-09-22）

### 修复内容

- 在 `ResearchServiceOptions` 增加：
  - `promptTimeoutMs`：单个 child prompt 的总 wall-clock 上限，默认 60 分钟，0 表示禁用。
  - `stallTimeoutMs`：无 transcript/tool-log 进展的上限，默认 10 分钟，0 表示禁用。
  - `stallCheckMs`：停滞检查间隔，默认 30 秒。
- `ProgressRunner` 现在用 `Promise.race` 同时等待：
  - 真实 `handle.prompt(text)`；
  - 一个 watchdog promise。
- watchdog 触发条件：
  - 超过 `promptTimeoutMs`；
  - 或 `handle.transcript().length + handle.toolLog().length` 在 `stallTimeoutMs` 内没有增长。
- watchdog 触发时会调用 `handle.dispose()`，并以 `runner.stop` 抛出明确错误，父任务会进入失败路径，而不会无限等待。
- `prompt-heartbeat` 文案改为明确说明“心跳不代表子会话有进展”，避免把父包装器定时器误认为真实进展。
- `stageContext` 默认把这些选项传给 `ProgressRunner`。

### 测试

- 新增 `test/prompt-timeout.test.ts`：
  - 验证超过 `promptTimeoutMs` 时任务 rejected，而不是挂起。
  - 验证 transcript/tool-log 无增长超过 `stallTimeoutMs` 时任务 rejected。
- `npm run typecheck` 通过。
- `npm test` 通过：127 tests，0 fail。

### 边界

- provider/transport 的外部不稳定仍然可能存在；本次修复保证工作流会在时限内失败并报错，而不是无限期占用。
- 当前已经启动的测试进程不会热加载本次代码；修复在下一次启动后生效。

## 22. xpuoj-4 测试受控停止记录（2026-09-22）

### 操作

- 用户要求停止 #4 测试并更换测试题。
- 操作员对 `/Users/sakimi/Desktop/rsi-test/.monitor/xpuoj-4/run.pid` 中的 PID 85584 发送 SIGTERM。
- PID 85584 在 1 秒内退出。
- 复查无残留 `comm=pi` 进程，无 workspace 相关 orphan 进程。

### 停止时的状态

- M07 goal `20260921T164208Z-da09` 仍为 `active`，`outcome` 为空。
- 任务：T001 rejected、T002 accepted、T003 accepted、T004 accepted、T005 failed、T006 returned、T007 running。
- 父 `run.jsonl` 末尾停在 `research_delegate` 的 update 事件，没有 `tool_execution_end`，也没有 `agent_settled`。
- 平台侧最新可见提交：
  - 147793 Pending
  - 147792 Pending
  - 147791 Accepted 90.2
  - 147790 Accepted 81.8
  - 147789 Accepted 90.8
  - 147702 TimeLimitExceeded 73.2

### 说明

- 这是操作员按用户要求执行的受控停止，不是正常收口，也不是科研失败。
- 两个 Pending 提交在客户端停止后无法由本主 Pi 继续轮询；平台侧状态以平台后续查询为准。
- 未自动重跑、未自动重启、未把停止写成 completed。

## 23. M07 check 模式任务与所需能力不匹配，导致 fulfilled 无法达成（2026-09-22）

### 现象

- 某次 M07 目标中，T001 被登记为 `mode=check`。
- T001 的义务需要调用平台读接口、执行本地 shell/查询脚本并写盘若干 raw 产物。
- 但 `check` 模式只获得只读目录工具，没有 shell、网络或写盘能力。
- 结果：T001 无法完成其声明义务，只能返回不可完成的报告；任务未 accepted。
- 目标真实平台结果已达成，但 `fulfilled` 要求所有有效任务均已 accepted，因此只能 partial。

### 为什么这是工作流问题

1. **缺少委派前能力预检**
   - 委派时没有检查 `mode`、工具授予与 `checks/expectedOutputs/objective` 是否冲突。
   - 需要 shell/网络/写盘的义务可以被登记为只读 check 任务。

2. **supersede 规则无法修正模式错误**
   - 合法替代要求同 mode、同 checks、同 inputs、同 expectedOutputs。
   - 因此无法把不可执行的 check 任务升级为可执行 execute 任务，也无法通过等价义务重新验收。

3. **缺少“不可执行义务”的受控作废路径**
   - 当一个任务因登记模式错误而客观上不可完成时，没有显式作废/重分类/用户裁决路径。
   - 它只能作为一个未 accepted 的 returned 任务永久阻塞 fulfilled。

4. **finish gate 过于刚性**
   - `fulfilled` 要求所有有效任务 accepted，但没有区分“科学/平台义务完成”与“任务登记模式错误导致的形式未完成”。

### 修复方向

- 委派前校验 `mode` 与任务声明能力需求，冲突时在创建前拒绝并给出明确错误。
- 允许受控的 supersede 修正模式/工具授予，但保持 objective、checks、expectedOutputs 和输入义务不变。
- 为不可执行的任务定义显式 blocked/waived 记录路径，并要求用户裁决。
- finish 时把形式性登记失败与真实科学义务分开记录，但仍不得把未完成写成 completed。

### 边界

- 本次运行不修改代码；等待当前任务结束后再按用户要求修复。
- 该问题属于 M07 任务登记、能力校验、supersede 与收口协议，不是平台评测器失败。

## 24. 修复：M07 check/reason 能力预检与 supersede 模式升级（2026-09-22）

### 修复内容

- `src/m07/controller.ts` 增加 `modeRank`：
  - `execute` 最高；
  - `check` 次之；
  - `reason` 最低。
- `sameSupersededObligation` 现在允许 **mode 能力升级**，例如 `check` 任务可由 `execute` 任务合法 supersede；但仍禁止降级（如 `execute` 被 `reason` 替代）。
- 委派前新增 check 能力预检：
  - `mode=check` 且 `expectedOutputs.length > 0` 时直接拒绝，明确提示 check 只读且不写盘，需要产出文件时使用 execute。
- execute 的 expectedOutputs 要求增加受控例外：
  - 普通 execute 任务仍必须声明至少一个预期产物；
  - 但带 `supersedesTaskId` 的修正任务允许在相同空 expectedOutputs 下升级为 execute，用于修正 mode 错误。
- supersedes 的错误文案更新为“兼容 mode（可升级到更强能力）”。

### 测试

- 新增/更新 `test/m07.test.ts`：
  - check 模式声明 expectedOutputs 会被拒绝；
  - check 义务可被 execute 合法 supersede；
  - execute 被 reason 降级仍被拒绝；
  - 普通 execute 无 expectedOutputs 仍被拒绝。
- `npm run typecheck` 通过。
- `npm test` 通过：129 tests，0 fail。

### 边界

- 本次修复解决的是 mode/能力登记错误和合法修正路径。
- expectedOutputs 的占位/动态路径问题（如 `raw/detail-<sid>.sanitized.json`，见第 18 节）本次未一并修改，仍留作后续专项修复。
- fulfilled 仍要求所有有效任务被接受；本修复使 mode 错误任务有合法替代路径，但没有放宽真实义务完成标准。

## 25. 顶层主 Pi provider fatal error 后退出，未走 session_shutdown，M07 run 留为 running（2026-09-22）

### 现象
- xpuoj-6 M07 主 Pi（PID 44972）在返回 `meta.displayScore` 逐例口径的思考过程中出现 provider 流式停滞。
- `run.jsonl` 随后记录 3 次 auto retry；最后一次 `auto_retry_end` 为 `success=false`、`finalError="Connection error."`，之后出现 `agent_settled`。
- 检查时进程已不存在：`kill -0 44972` 失败；主日志约 374 秒无更新。
- 未观察到正常的 `session_shutdown` 归档路径。

### 工作流问题
- 顶层主 Pi 的 fatal provider error 退出没有等价于 `host-shutdown` 的收口记录：M07 `run.json` 仍为 `running`，goal `lifecycle=active`，T001–T006 均 `returned`，没有写入 failures。
- harness 的 prompt timeout / stall watchdog 只包住子会话，不覆盖顶层主 Pi 自身的流式响应；顶层长时间无更新时不会自动触发受控停止或归档。
- 该失败形态不同于第 19/20 节的“子会话 provider 错误后停滞”，也不同第 10 节的“主 Pi 自行 partial 收口并退出”：这里是顶层 provider fatal error 直接退出且 M07 状态未收口。
- 按运行规则未自动重启、未发送停止信号、未改写工作区状态或产物。

### 证据
- 主日志：`/Users/sakimi/Desktop/rsi-test/.monitor/xpuoj-6/run.jsonl`（末尾含 `auto_retry_start attempt=3`、`auto_retry_end success=false finalError="Connection error."`、`agent_settled`）。
- M07 run：`/Users/sakimi/Desktop/[WF]Pre-RSI/workspaces/xpuoj-6-geglu-tanh-approx/stages/M07/20260922T050123Z-cc8f/run.json`（status=`running`，failures=0，finishedAt 缺失）。
- M07 goal：同目录 `goal.json`（lifecycle=`active`，updatedAt=`2026-09-22T05:43:40.340Z`，tasks T001–T006 均为 `returned`）。
- 平台只读查询：salt-Star 最近 5 条提交均 `Accepted`，最新 SID 147882，displayScore 97，timeUsed 4510；本轮无新提交。

## 26. 修复：主 Pi 顶层 watchdog、M07 收口与进程级暂停（2026-09-22）

### 修复
- `createResearchExtension` 新增顶层主 Agent 停滞 watchdog：`agent_start` 后按活动事件刷新；默认 10 分钟无 `message/tool` 进展且非 idle 时调用 `ctx.abort()`，并把 abort 原因交给 `session_shutdown` 收口。外部长计时器空隙按暂停处理，不当作停滞。
- `ResearchService` 持久登记 active M07 run；`quit` 级 `session_shutdown` 会调用 M07 `interrupt` 归档为 blocked，并把后补的 host-shutdown 事实写入 run failure。`reload/new/resume/fork` 不关闭 active goal。
- `ProgressRunner` 的 prompt timeout 与 stall 检测识别进程级暂停造成的计时器空隙，避免 SIGSTOP/SIGCONT 后误触发。
- 新增 `scripts/workflow-control.ts` 与 `npm run workflow:control`：`status|pause|resume|stop --pid-file <run.pid>`，使用 SIGSTOP/SIGCONT/SIGTERM，状态写入同目录 `control.json`。

### 验证
- `npm run typecheck` 通过。
- `npm test`：132 pass，0 fail。
- 新增测试：`test/pi-lifecycle.test.ts`、`test/pi-watchdog.test.ts`。

### 边界
- 暂停冻结进程不保证 provider/transport 在长时间暂停后仍可继续；恢复可能仍需重新请求。
- SIGKILL、进程崩溃、宿主断电仍不保证归档；当前修复覆盖正常 `quit` 路径和可响应的 top-level 停滞。

## 27. print 模式下主 Pi 提问后退出，session_shutdown 自动把 active M07 goal 归档为 blocked（2026-09-22）

### 现象
- xpuoj-7 主 Pi 在达到“需要用户决定 A/B/C”的状态后调用 `research_goal decision request` 登记 U001，并以 assistant 文本向用户提问。
- 运行于 `-p` / `--mode json` 单次打印模式；turn 结束后 process 正常 `agent_settled` 并退出，不会等待交互输入。
- 进程退出触发 `session_shutdown reason=quit`；新加入的 active M07 goal 收口逻辑自动将 goal 置为 `finished/blocked`，同时保留 `U001 open`。
- 未发现 provider error；这是正常退出路径而非崩溃。

### 工作流影响
- 在非交互模式中，“遇到用户决定就停止并提问”实际等价于“退出并把 goal 受控归档 blocked”；必须由用户回复后另起主 Pi 继续。
- goal 已 finished/blocked 后不能再被同一 goal 自动重跑；A/B/C 需要用户明确选择，之后通常需要新的 continuation/新 goal 会话。
- 这与 M07 设计中的“用户决定事项不能自动完成/不能 fulfilled”方向一致，但需要把非交互退出后的恢复入口写清楚。

### 证据
- 主日志：`/Users/sakimi/Desktop/rsi-test/.monitor/xpuoj-7/run.jsonl`（末段 `agent_settled`，最后 assistant 文本含 A/B/C）。
- goal：`workspaces/xpuoj-7-relu/stages/M07/20260922T081519Z-1731/goal.json`（lifecycle=finished，outcome=blocked，U001=open）。

## 28. 一次题后复盘：旁路 bash 侦察、M03 泄漏重试、池失败令牌消耗（2026-09-22）

### 现象
- 某次普通算子题运行中，主 Pi 在 `researchActive` 激活前使用大量 bash 完成平台/前端 bundle 侦察；工具门禁此时尚未启用。
- 该轮 M03 第一次运行 failed，原因是 reviewer R2 作答消息包含出题依据，系统按规则中止转发；重试后 completed。
- 真实提交轮中平台/池通道出现 1 次 HTTP 500 与 5 次 HTTP 403；按任务报告，失败请求消耗一次性令牌但未产生 submissionId，随后按授权回退 `api_key` 1 次。
- 非交互 `research_goal decision request` 防护在本轮生效：未再出现 A/B/C 提问后退出的事件。

### 工作流问题
- 主 Pi 在 researchActive 前仍可执行 bash、网络和写盘；只读/有界 M07 约束不是强制门禁，存在提前产生平台副作用的边界缺口。
- M03 对“作答消息夹带出题依据”的防护有效，但 reviewer 协议遵守不稳定，导致一次阶段失败与重试成本。
- 失败提交是否消耗一次性通道令牌由平台/池行为决定；当前只能事后记录和回退，无法回收或预扣保护。

### 边界
- 该轮主目标已 fulfilled，次目标 ceiling measurement 以 partial 如实收口；未发现 provider fatal error。
- 本轮只记录复盘，未修改代码。

## 29. 长时 continuation 工作流的资源硬停、stale lock 与注册/模型不一致（2026-09-24）

### 说明
- 本节只记录工作流机制问题，不记录具体题目、平台提交、SID/分数、候选代码、测试台账或测试专用产物。
- 背景：一次长时 continuation 工作流通过私有 launcher 续跑；运行中观察到控制面问题，最后一次累计主日志硬停止后主 Pi 退出、M07 goal 被收口为 blocked。

### 问题 1：私有主日志累计 64MiB 硬上限没有轮转语义
- launcher 的 `mainLogBytes()` 统计控制目录下全部 `main-*.jsonl`，并以 64MiB 为硬上限；没有按批次/会话/时间轮转、归档或压缩。
- 本次当前运行日志尚未达到 64MiB 时，旧批次累计已越过上限，launcher 在 5 秒资源监控中直接执行 `stop('cumulative-private-main-log-over-64MiB')`。
- 影响：长时或多次续跑会不可避免触发；旧日志会让新运行无法启动；重启前必须人工归档旧日志或调整计数语义。
- 资源硬停没有接近阈值预警，也没有在停止前强制生成一次 checkpoint/交接。

### 问题 2：硬停后的 M07 收口不完整
- session_shutdown 把 active goal 归档为 `finished/blocked`；M07 run failure 记录为反馈生成失败（`context.budget`），仅有界控制事实可供 M04 读取，原证据需另行核查。
- `feedbackStatus=control-facts-only`；finishSummary 为“受控中断归档：受信宿主生命周期停止：session-shutdown”。
- 影响：没有完整交接，原证据仅能靠文件位置，不符合可续跑要求的完整 checkpoint；之后通常需要用户/operator 决定新 continuation 或新 goal。

### 问题 3：stale knowledge merge lock 无自动恢复
- 观察到工作区知识库 `.merge.lock` 指向的 PID 已不存在；fresh M04 连续失败，原因均为“知识库合入锁正在使用中”。
- 主 Pi 因写权限/范围约束不能删除该锁；launcher 没有 stale lock 检查或回收流程；最终由 operator 确认 PID 不存在后手工删除。
- 影响：一个陈旧锁即可让整个 M04 回流和 M07 委派链停摆；缺少明确的 stale lock 授权和回收规则。

### 问题 4：主模型配置不一致
- 私有 launcher 曾硬编码主 Pi 模型为 `deepseek/deepseek-flash:low`，与“主 Pi high、工作区角色 low”的启动规范冲突。
- 已临时修复 launcher 的主模型参数和对应首轮 prompt 文案；`--check` 已能报告 high，但尚未做正式回归测试。
- 影响：若未发现，该轮不是有效的 high 主 Pi 测试。

### 问题 5：活动工作流注册/发现路径不统一
- 通用 operator 发现流程使用 `/Users/sakimi/Desktop/rsi-test/.monitor/*/run.pid`；私有控制面却把 active 运行注册在自己的 `run.pid`。
- 结果：第一轮自动发现把所有 `.monitor` 判为 dead，漏报 active 工作流。
- 影响：operator 可能误判、漏监控、误操作；需要统一注册接口，或让发现逻辑同时支持多个 control plane。

### 问题 6：外部提交/依赖通道健康未纳入工作流预检
- 观察到外部提交通道在线/离线波动、可用额度会降到 0；launcher/工作流继续科研步骤，但没有在提交前强制健康 preflight，也没有在不可用时向用户/operator 主动升级。
- 影响：提交阶段可能被卡住；需要独立恢复或补充通道水位。

### 问题 7：监控正在增长的主日志不能全量读取
- operator 侧全量 stream 正在增长的 `main-*.jsonl` 会持续读到新追加内容，命令超时后被宿主清理并 SIGTERM 整个 launcher/Pi；本次已实际发生一次。
- 后续所有监控必须只读 bounded tail 或固定字节数；工作流文档应明确该边界和最大读取量。

### 证据位置（仅工作流控制面）
- `<control-dir>/exit.json`：code=143，stopReason=`cumulative-private-main-log-over-64MiB`。
- `<control-dir>/stop.json`：stop 原因和 pid。
- 工作区内本轮 M07 `run.json`：status=failed，failure 为反馈生成失败 `context.budget`。
- 同 run `goal.json`：lifecycle=finished，outcome=blocked，feedbackStatus=control-facts-only。
- 工作区知识库 `.merge.lock` 曾在死 PID 下残留，operator 手工清理。
- 本节不记录具体题目、SID、分数或提交内容。

### 状态
- 仅记录工作流问题，不修复代码；当前无存活主 Pi。
- 后续修复建议（待评审）：日志轮转/压缩与 cap 语义、接近阈值预 checkpoint、stale lock 自动/授权回收、统一 control plane 发现、模型一致性检查、外部依赖 preflight、监控有界读取规范。
