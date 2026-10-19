# 2026-10-19 W4：进程身份探测不再受机器负载影响，恢复用例的等待改成确定性

## 症状

`test/local-mission-evaluator-recovery-integration.test.ts` 的「published knowledge and a dead recovery
claim commit the sealed receipt before any new model call」在全量测试满载时偶发失败，断言文字是
`receipt recovery did not enter M04: `——后面本该是子进程输出，实际为空；单独跑必过。

## 真正依赖时序的地方

1. **身份探测里有一个 2 秒的外部进程预算。** macOS 上 `startToken()` 要靠 `python3 + ctypes` 读
   libproc 的微秒级出生时间（`ps lstart` 只有秒精度，不足以支撑 PID 复用判定），`bootId()` 要 `sysctl`。
   两者都是 `timeout: 2_000`。机器满载时，光是拉起 python 就可能超过 2 秒：`execFile` 以
   ETIMEDOUT 失败 → `probeProcessIdentity` 返回 `unknown`，`readCurrentProcessIdentity` 直接抛错。
   于是**恢复判定本身会因为负载而改变答案**：本该「死亡 owner 可接管」的路径变成「身份不可知、
   fail closed」，子进程提前退出，父进程当然等不到 M04。
   每个恢复门都要读一次当前身份（`local-mission.ts`、`local-mission-host.ts`、`local-evaluator-run.ts`、
   `controller.ts`、`store.ts`、`ownership.ts` 各处），一次运行里会拉起几十个 python。
2. **等待是按迭代次数计数的。** 父进程等 `m04-entered` 是 400×10ms＝4 秒上限，子进程等
   `m04-release` 是 1000×10ms、等 `release-reconcile` 是 400×10ms。满载时这些上限本身就会到期。
3. **诊断丢失。** 失败分支只打印累计的子进程输出；子进程若在打印任何东西之前就退出，输出就是空字符串，
   而测试从不检查子进程是否已经退出。

## 改了哪里

- `src/runtime/process-identity.ts`：
  - 探测预算从 2 秒提到 15 秒，并在「只是资源不够」（被 kill/ETIMEDOUT/EAGAIN/ENOMEM/EMFILE/ENFILE/EINTR）
    时重试一次；真失败照原样报告。
  - 本进程自己的身份读一次就记住（出生时间不会变，自己的 PID 在自己活着时不会被复用），
    后续所有恢复判定零成本、且不可能与先前的答案不一致；探测自己时也直接用这份缓存，不再拉进程。
  - boot 身份同样只读一次（同一次 boot 内恒定）。
  - 失败原因不再被吞掉：`readCurrentProcessIdentity` 的错误会说明是 boot 还是出生令牌失败、
    哪个 pid、以及单行的原因（超时/errno/退出码），不带命令行与输出。
- `test/local-mission-evaluator-recovery-integration.test.ts`：五处按次数计数的轮询换成一个
  `waitForBarrier(file, { child })`——以墙钟为界（120 秒），负载只会让它更慢，不会让它给出错误答案；
  传了子进程时，子进程退出即刻结束等待，并把退出码/信号写进失败信息。父进程那处失败信息现在同时带
  等待失败原因与捕获到的子进程输出（没有就明说没有）。
- `test/runtime-control.test.ts` 新增两项回归：200 次并发读当前身份必须得到同一个身份、全部探测为
  `alive:identity verified` 且远低于 200 次外部探测的耗时；不可能存在的 pid 必须给出「哪个探测、哪个
  pid、什么原因」的单行错误。

## 验证

- `tsc --noEmit` 0 错误。
- 另开一个进程跑全量测试制造负载，同时把该文件连跑 5 次：5/5 通过（每次 3/3）。
- `test/runtime-control.test.ts` 5/5 通过。
