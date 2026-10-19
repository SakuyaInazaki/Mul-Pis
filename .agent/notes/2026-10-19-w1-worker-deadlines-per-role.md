# 2026-10-19 W1：把「宿主掐掉的 worker」和「候选判错」分开，并给角色各自的截止时间

## 症状

`test/m07-local-operator-backend.test.ts` 的「invalid or timed-out baselines never relabel a correct
candidate or create a performance incumbent」在全量测试满载时偶发失败，单独跑 3/3 通过。

## 真正的原因，不是测试写得随意

两处都依赖墙钟：

1. **契约只有一个全局 `workerTimeoutSeconds`。** 这个 fixture 需要一个故意停住的 baseline 被掐掉，
   于是把全局超时压到 1 秒——而同一个数字同时管着参考实现校准（2 次）、候选的三次确定性重跑、no-op、
   插桩、派生变体的有效性门禁，以及 16381 元素的测量（warmup 10 + 30 轮）。机器一满载，这些**诚实的**
   worker 也会越过 1 秒，于是和那个故意停住的 baseline 混在一起。超时调大只会把症状推到更满载的机器上。
2. **超时被记成候选的错。** 正确性阶段里 `run_worker` 的超时抛的是普通 `WorkerFailure`，
   `correctness()` 于是把 `failureRole` 写成 `"candidate"`，这一格按「候选失败」计。
   测量阶段同理：候选角色超时走 `MeasurementWorkerFailure("candidate", …)`，`passed` 为假。
   这是真缺陷：宿主在截止时间掐掉一个 worker，说明不了候选算得对不对，而按依据里的分类，
   把基础设施失败和策略失败算在一起会让 agent 拿着正确的代码去「修」机器噪声。

## 改了什么

- 新异常 `WorkerDeadline(role, message)`：只在宿主的截止时间触发时抛，带着是哪个角色。
  一次性 worker（`run_worker`）与常驻测量 worker（`measure_workers.transact`）都用它。
  `measure_workers` 的兜底包装不再把它重新包成 `MeasurementWorkerFailure`。
- `correctness()` 遇到 `WorkerDeadline`：`failureRole` 写成 `timeout:<role>`，该用例标 `inconclusive`
  且 `noopComplete=False`（这一格什么都没判成），测量阶段则按已有的「基线不可用」规则处理——
  `passed=True` + `correctnessFromPreviousStage=True`，由宿主账本验证器回查前一阶段确实通过。
  于是超时的结论是 `unknown`，不是 `failed`。
- 新契约字段 `SPEC.workerTimeoutSecondsByRole`：按角色给更紧的截止时间。角色名必须是真实角色
  （含 `baseline:<名字>`），值必须为正且**不超过**全局 `workerTimeoutSeconds`——只能更紧，不能更松，
  跟 `decisionPolicy` 的规则一致。更松会把一个挂死藏在最可能挂死的那个角色后面。
  `role_deadline()` 在 `run_worker` 与 `transact` 里生效，调用点不用改。
- 测试 fixture：故意停住的 baseline 改成**等一个永远不会出现的文件**（`time.sleep` 轮询，不再
  `while True: pass` 占着一个核），它只能被宿主掐掉、永远不可能提前返回；它自己的截止时间 0.5 秒，
  其余角色另给宽裕的任务级值。于是唯一的墙钟依赖只剩「永不结束的东西一定会撞上截止时间」这一个方向。
- 新增两项测试：给 `candidate` 角色 1 毫秒（起不了解释器，必然触发）验证超时记成 `timeout:candidate`、
  用例 inconclusive、观测结论是 `unknown`；以及按角色的截止时间只能收紧、角色名必须真实。

## 满载跑出来的另外两处同类问题

为了验证，我用两个进程同时跑全量测试制造了比要求更重的负载，于是暴露出同一类毛病的另外两处断言，
都在这个文件里，都已按同样的原则改掉：

- 主测试断言 `decisions["task-naive"].verdict === "faster"`（W4 在三重负载下也撞到这一条）。
  满载下方差自适应门槛 `1+max(0.002, 0.85·cv)` 随实测离散度变宽，同一个确实更快的候选被**正确地**
  判成 `tie`。宿主的判定口径没有问题，问题是 fixture 的差距只有 1.75 倍——`tie` 只需要配对比值的
  cv 超过 0.89 就会出现。**改的是被测差距，不是判定规则**：naive 基线加到 9 个精确零加法，
  候选对它的实测比值落在 0.42 附近，这时 `tie` 需要 cv > 1.4，远超任何负载下的实测值；同时比值仍
  明显高于宿主 1/3 的复测触发线（压到更低会换成「复测不一致」这种更差的失败模式）。
  断言恢复成强的 `verdict === "faster"`，并补两条守栏断言，保证以后改 fixture 时比值仍留在
  (1/3, 0.6) 这个既不进 tie 带也不触发复测的窗口里。
  顺带一提：旧 fixture 里 `while True: pass` 的停住基线会在整个超时期间占满一个核，它本身就是
  前面那几个测量的噪声来源之一；改成等文件之后这部分噪声一起消失了。
- 停住基线那一段断言 `correctness === "passed"`。满载到诚实 worker 也越过截止时间时，
  正确性阶段就结束了，结论诚实地变成 `unknown`。这个测试要证的是「不可用的基线不会把正确的候选
  改判成错，也不会留下一个数字」，所以改成断言 `correctness !== "failed"` 且 metrics 为空；
  只有在确实走到 measurement 阶段时才继续断言 `passed`、`timeout:baseline:stalled` 与
  `correctnessFromPreviousStage`。
- 另外把这个测试契约的任务级超时从 20 秒提到 60 秒（停住的角色那段用 300 秒）。这一次不是「调大了事」：
  挂死的角色现在由它自己的 0.5 秒截止时间兜住，任务级的数值不再需要小到能抓住挂死，于是可以给诚实工作
  留出 30 倍以上的余量。两件事是同一个改动的两面。

## 验证

- 类型检查 0 错误。
- 这个 fixture 从 32.6 秒（且偶发失败）变成约 12 秒：诚实工作不再被压在 1 秒里，而故意停住的角色
  0.5 秒就被掐掉，整个测量随即放弃。
- 满载验证：另一个进程跑全量测试制造负载（跑完即自动重启，保证每一次重复都有负载），
  同时把该文件连跑 5 次：**5/5 通过，每次 20 项全过**，单次耗时 191–658 秒。
