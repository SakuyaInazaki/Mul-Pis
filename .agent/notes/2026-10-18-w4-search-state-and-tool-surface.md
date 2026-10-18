# 2026-10-18 W4（第二轮）：搜索状态事件日志、跨会话热启动、工具面收敛与长耗时工具异步化

## 为什么

两份 issue 对应依据里的两条：

- W4-04 / RB-A10-07（P0）：编排层应当是确定性状态机，控制状态**从持久事件日志重建**；要有候选关系库
  `(id, pid, score, is_buggy, path_ref)`、并发写入、递归查询与**跨会话热启动**（新变体直接检索历史同类
  算子，取最高分实现与其优化报告作为起点）。预算与停滞计数**全部以轮次表达**，以免换模型后口径漂移。
  缓存键与 run id 必须含硬件与工具链版本。依据自身的强度是「工程蓝图」（原篇无组件消融），所以这里只做
  机制，不声称收益。
- W4-03 / RB-A10-06（P0，全批证据最强的一条）：工具集小而稳（5–7 个）；长耗时工具必须异步化，一个候选
  等编译时不应阻塞其它工作；工具调用结构要记账并公示。RB-A10-12（P2，互相矛盾）：不得把多 agent 当默认
  更好写死，必须能一键退回单 agent 作对照。

改动前：M07 控制状态是整文件覆盖写；没有任何跨运行检索；执行会话的候选工具全部同步阻塞；主会话 9 个
`research_*` 工具里有两对语义重叠；没有工具调用口径的记账；没有单 agent 对照旋钮。

## 改了哪里

**新模块 `src/m07/search-state/`**（三个文件，职责分开）：
- `events.ts`：追加式 JSONL 日志。没有全局序号也不加锁——每个写者自带单调序号，读取按
  （时间、写者、序号）排成全序；一行一次写入，单行上限 8 KiB，字段逐个截断、整行再兜底；未知事件种类
  与未知判决直接拒写。读取容忍崩溃截断的尾行与异形行，计入 `skipped`，不猜。
- `store.ts`：纯函数 `rebuildSearchState` 把事件折叠成候选树、任务、计数器、轮数、停滞数与平台集合；
  配 `candidateAncestors/Siblings/Children`、`bestCandidates`（只排有宿主评分的候选，buggy 默认排除）与
  `searchStateSummary`。同一文件里别的 run 的事件不会混进来。
- `warm-start.ts`：扫描最近的 run 目录，读 `goal.json`，复用既有归档函数取每个工作对象的已验证最佳候选，
  返回候选引用、决定它为最佳的那个指标，以及冻结证据的精确路径。**来自其它芯片/工具链或没有记录平台的
  线索一律标 `comparable: false` 并默认丢弃**，`describeWarmStartLeads` 把这句话写进模型读到的文本里。
  扫描有上限（默认 25 个 run、8 条线索），坏目录只计数不致命。

**接线**：
- `src/m07/candidate-runner.ts`：新增 `searchEventLogFile` 选项，提交候选、每个阶段结果、评测结束各写一条
  事件；日志写不动时把错误报给模型（`eventLogError`），既不吞掉也不让它拖垮本来只是被描述的执行。
- `src/m07/controller.ts`（W2 的文件，两处最小调用）：传入本 run 的 `search-events.jsonl` 路径；在工具
  wrapper 的 finally 里 `await drainBackgroundRuns?.()`。
- `src/pi/extension.ts`：`research_status` 增加可选 `priorRuns`，这是规划者决定「下一个任务从哪儿起步」
  的那一步。

**长耗时工具异步化**（`candidate-runner.ts`）：
- `candidate_run` / `candidate_sweep` 新增 `background` 与 `collect`。后台提交立即返回，模型可以接着做别的；
  宿主**仍然一次只执行一个候选**，不给后端它没准备好的并发。`collect` 报告状态、完成后返回结果；会话重启后
  退回读durable journal，`collect` 永远不会启动任何东西。
- 后台运行会活过发起它的那次工具调用，所以宿主拿到一个 drain，必须在 prompt 结束前 await；没有这个，控制器
  就会对着「没人在等的副作用」做判断。因此该能力**默认关闭**，由宿主显式开启（`backgroundRuns`）。
- 排队与结束各写一条事件，`searchStateSummary(...).background.outstanding` 可回答崩溃后是否有未完成的运行。

**工具面收敛**（`src/pi/extension.ts`，9 → 7）：
- `research_init` 并入 `research_stage` 的 `stage=init`（工作区准备本来就是工作流的第一步）。
- `research_method_improve` 并入 `research_improve` 的 `track`（`budget` / `method`）：两者的动作词表本来
  高度重合；跨轨道的动作被显式拒绝，不做沉默重解释。
- 没有把 `research_delegate` 与 `research_review` 合并：那会造出一个 45 参数的工具，和依据要的「语义清晰」
  相反。

**记账与对照臂**：
- `src/runner/tool-usage.ts`：`summarizeToolCalls` 给出每个工具的调用数、按类别的失败数，以及
  **有多少次文件改动在下一次改动之前真的进了一次评测**——长时间只编辑不测量，在转录里看不出来。
  通过 `SessionHandle.toolUsage()` 暴露（pi 与 fake 都实现）。
- `src/runner/experiment-arm.ts`：`PRE_RSI_EXPERIMENT_ARM` = `multi-role`（默认）/ `single-agent`，
  写进每个会话的 harness 回执。本模块只解析与记录；对照臂具体少开哪些角色属于搜索层。

## 验证

- `tsc --noEmit` 0 错误。
- 新增 `test/m07-search-state.test.ts`（5）、`test/m07-search-warm-start.test.ts`（3）、
  `test/runner/tool-usage.test.ts`（2），扩充 `test/m07-candidate-runner.test.ts`（+2）与
  `test/pi-extension.test.ts`（+2）。覆盖：双写者不丢事件且顺序稳定、崩溃尾行只计数、状态是事件的函数、
  重启后从日志继续、单行上限与非法事件、热启动跨 run 检索与平台不可比、坏目录计数、后台提交立即返回且
  宿主仍串行执行、重启后 collect 读 journal、未开启时拒绝后台、工具轨道路由与跨轨拒绝、`priorRuns` 输出。
- 全量测试见下方提交说明。

## 边界

- 事件日志记录的是搜索的事实，不是新的真相来源：候选的证据仍在各自的 journal 与冻结观测里，日志只存
  `pathRef`。
- 热启动给的是**起点**，不是「旧结论仍然成立」；跨平台的数字必须重测后才能引用。
- 后台执行不改变后端并发度，也不改变控制器对未知外部操作的既有判断。
