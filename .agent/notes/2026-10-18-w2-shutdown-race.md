# W2：关闭路径上的运行中写入竞态（确定性化）

## 现象与原因

`test/control-guard.test.ts` 的「正常关闭只把自己拥有的活动运行记为 failed」在机器负载高时偶发失败：
断言期望阶段以「不能覆盖为 completed」被拒，实际有时拿到「不能覆盖为 running」。
原因是真实的时序竞态：该用例只等到 `startRun` 写出 run.json 就调用 `interruptAllActive`，
而阶段随后还会在 `openBoundedSession` 的边界回执里写一次**仍处于 running** 的记录。
关闭先发生时，那次 running 写入撞上终态保护，于是阶段以「不能覆盖为 running」失败——
结果正确（fail closed），但失败原因取决于调度，且文本看起来像是在复活已终结的记录。

## 改了哪里

- `src/pi/service.ts`：`stageContext` 现在同时包装 `ws.writeRun`。拥有本次活动操作的关闭一旦开始，
  该操作自己的 running 写入直接以 `run.interrupted: owned stage operation is shutting down` 失败，
  与 `startRun` 的既有行为一致；终态写入仍走 `finishRunIfRunning` 的原有保护。
- `test/control-guard.test.ts`：原用例改为等待「prompt 已经开始」再关闭，于是只与终态写入竞争，
  断言不再依赖调度；另新增一项用例，在会话内部触发关闭，覆盖「running 写入撞上关闭」这条路径，
  断言它报告关闭而不是复活记录，并且持久记录仍是 failed + host-shutdown。

## 验证

- 类型检查 0 错误；`control-guard.test.ts` 连续重复运行三次均 6/6 通过；
  `pi-extension`、`m07` 一并通过。
