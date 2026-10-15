# 2026-10-15：M07 checkpoint 保留失败控制事实

本批在 `src/m07/controller.ts` 的冻结副本中保留 selected 与 omitted 任务的执行失败原因，并对冻结字段应用与 Pi 扩展公开任务状态相同的凭据脱敏函数；live 目标原始记录不变。扩展的公开错误措辞沿用原规则。checkpoint 仍只复制已评审证据，不因失败任务进入批次而复制其未审 report/work；超出反馈长度时继续写有界索引，完整脱敏控制事实留在冻结 `goal.json`。

在 `test/m07.test.ts` 增加真实失败任务的两种选批、未审文件隔离、已评审材料复制、原始/公开失败区别和长控制原因索引回归。`npm run typecheck` 通过；离线运行 `node --test --test-concurrency=1 test/m07.test.ts test/pi-extension.test.ts`，67 项通过、0 失败。首次沙箱运行被 macOS `kern.boottime` 权限阻断，随后在允许该系统只读检查的环境重跑通过。未调用模型或网络，未改历史目标、checkpoint、实验与知识库，也未提交或推送。完整定向 diff 存于本任务私有审计文件，供复核后决定是否采纳。
