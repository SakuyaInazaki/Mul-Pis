# 2026-10-19 W4（第三轮）：执行会话工具面收敛到七个，评估池改成有界队列

## 为什么

- RB-A10-06（P0，全批证据最强的一条）：工具集小而稳 5–7 个。执行会话此前是 10 个：
  read/write/edit/bash 四个原生，加 `candidate_evaluate`、`candidate_run`、`candidate_sweep`、
  `candidate_list`、`candidate_read`、`candidate_checkout`。后三个是同一份归档的三个读法，
  `candidate_sweep` 与 `candidate_run` 是同一个后端、同一套 journal、同一条恢复路径。
- RB-A10-10（P0）/ RB-A11-26：成本几乎全在评估器上，生成与评估要解耦；并发度上限由计时保真决定
  （依据实测 MI308X 并发 4/8/16 的失真是 2.15%/7.61%/77.65%），队列要有界并给出 backpressure。

## 改了哪里

**工具面 10 → 7**
- `src/m07/candidate-archive.ts`：三个工具合成一个 `candidate_archive`，`action` 为 `list`（默认）/
  `read` / `checkout`。三段契约原样保留（分别是分区分页、按文件分页读取、冻结源码复制），只是入口合一；
  属于别的 action 的参数**显式拒绝**，不做沉默忽略。
- `src/m07/candidate-runner.ts`：`candidate_sweep` 并入 `candidate_run`。声明 `domainsJson` 即为一次
  参数域枚举；路由由**持久 journal 的 kind** 决定，所以 resume/查询不需要调用方记得当初是哪一种。
  对已是单候选的 runId 再给 `domainsJson`，或对单候选用 sweep 的分页参数，都会被拒绝。
- 同步更新了所有工具名引用：控制器的边界说明、episode/search 的回执里的 `readArchive`/`readCandidate`
  指针、extension 的 guidelines、`tool-usage` 的评测工具判定、P07 提示词与 `文件清单.md`/`提示词全集.md`
  （逐行重算字节数与 SHA-256，`test/workflow-manifest.test.ts` 通过）、design.md。

**评估池**
- 新增 `src/m07/evaluation-queue.ts`：FIFO 有界队列。`concurrency` 默认 1——两个进程同时测同一台设备
  得到的数字不可比，调高是知道机器的人做的保真决定；`capacity` 默认 8，满了就**拒绝提交**而不是让积压
  无限长。`assertCapacity()` 让不会 await 任务的调用方当场失败（后台提交就是这种），拒绝计入统计。
  统计含 accepted/rejected/completed/failed/running/queued/maxRunning/maxQueued/等待时长，
  `maxQueued` 就是「编译队列深度」这个指标。
- `candidate-runner` 用它替掉原来的 tail 链：行为默认不变（仍然一次一个候选），但现在队列深度可见、
  背压可报，`drain()` 也会等队列清空。后台提交的返回值与 `collect` 列表都带上 `evaluationPool` 统计。

## 验证

- `tsc --noEmit` 0 错误。
- 新增 `test/m07-evaluation-queue.test.ts`（6 项：提交顺序、并发度、满队列拒绝且不丢已接受的工作、
  失败释放槽位并单独计数、drain、assertCapacity 计一次）。
- `test/m07-candidate-runner.test.ts` 新增两项：一个工具同时覆盖单候选与参数域且不混淆（journal 决定路由）、
  有界池在真实工具层上的背压（第四次后台提交被拒，已接受的三个仍按序执行）。
- `test/m07-candidate-episode.test.ts` 新增一项：`candidate_archive` 的三个 action 各自保留契约，
  跨 action 的参数被拒。
- 全量测试见提交说明。

## 边界

- 评估池只解耦**宿主侧**：生成仍在模型会话里，后台提交是两者之间的接口。真正的多候选并行测量需要
  `concurrency > 1`，那是保真决定，默认不开。
- 合并工具没有合并语义：`candidate_archive` 的三个 action 与 `candidate_run` 的两种形态仍各自校验，
  错用参数一律拒绝。
