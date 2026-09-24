# 2026-09-24 I 决策视图与终态区分

## 修改

- 每轮 I 提示加入剩余决策、候选、inspect 与 readback 额度，最终一轮标明 `finalDecision`。这些值由控制器当前计数产生，不由 I 自报。
- 下一轮 I 可看到上一动作实际执行或被拒绝的回执，包括候选登记 ID、development 状态、反馈/inspect ID 或拒绝原因。受保护 G 结果仍不进入该视图。
- I 可在最后一轮自己明确 `stop` 并记录正常 `no-winner`；若最后一次决策用于其他动作，运行记为 `inconclusive` 且原因明确为决策额度耗尽。控制器没有代选候选。
- 注册对象分页越界等可恢复 inspect 错误会扣除 inspect 次数、向下一决策返回拒绝原因，让 I 在剩余额度内修正；受保护结果、越权与未知费用仍不因此放行。
- run 添加可选的结构化 `outcome`，只在明确的分支写入 `completed-no-candidate`、`search-incomplete`、`setup-blocked`、`candidate-rejected` 或 `promoted`。原 `status` 保持兼容；未能准确判断的 provider 故障不猜作已分类结果。
- 未修改 development episode 的 `scientificStatus` 计算。

## 验证

- 新增独立 fake-runner 测试，检查额度递减、真实拒绝回执、可恢复 inspect 分页错误、明确无赢家与最终动作耗尽的差别。
- `npm run typecheck` 与 `node --test test/research-decision-view.test.ts` 通过；不调用真实模型或网络。
