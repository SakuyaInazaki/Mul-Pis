# Claude 运行器：释放后的会话不再污染后续续接

- 变更文件：`src/runner/claude.ts`（仅 runner 基底接线；未改任何 stage、gate、提示词、产物或验收规则）
- 现象：M03 在「评审出题 → 执行会话作答 → 评审逐题评价」的第三步失败，
  报 `runner.aborted：session M03-reviewer-R1 was aborted or disposed`。
  此前两步全部成功，两位评审的问题、依据与执行会话的完整回答都已产出。
- 原因：`dispose()` 把 `state.disposed` 置真并 abort 控制器，但**没有从 `this.states` 移除该状态**。
  `resume()` 命中活跃表时直接 `return this.handle(live)`，于是拿到一个已标记释放的状态，
  其 `prompt()` 在入口处就抛 `runner.aborted`。M03 的评价阶段正是对同一评审会话做 `mode: "continue"` 续接，
  因此必然失败。这是运行器生命周期缺陷，不是 M03 的流程问题。
- 变更内容：`resume()` 发现活跃状态已释放时，将其从 `this.states` 删除并走下面的持久化重建路径。
  该路径读取 `.spec.json`、`.jsonl` 与 `.conversation`，校验 model/role/label 边界，
  要求 `tools.kind === "none"`，与新进程中续接走的是同一条路。未改动 `dispose()` 自身语义。
- 影响范围：带工具授权的会话在释放后续接，现在会得到明确的 `runner.isolation: not resumable across processes`，
  而不是含义不明的 `aborted or disposed`。
- 验证：`tsc --noEmit` 干净；`node --test --test-concurrency=1 'test/**/*.test.ts'`
  271 项中 267 通过、0 失败、4 跳过（跳过项为改动前既有状态）。
