# Claude 运行器：拼接输出边界续写的全部回答

- 变更文件：`src/runner/claude.ts`（仅 runner 基底接线，未改任何 stage、gate、提示词、产物或验收规则）
- 现象：M03 评审会话在 xhigh 下回答很长，撞到 substrate 的单次输出边界后由 CLI 自动续写。`result.result`
  只携带**最后一段**，于是 stage 收到的是答案尾部，`# 可转发问题` / `# 出题说明与判断依据` 两个必需标题
  随前半段一起丢失，M03 以 `m03.format` 失败且不转发。M02 之前同样被截断，只是其格式检查没有依赖开头。
- 变更内容：
  1. 在 `query()` 流循环中累积所有 assistant `text` 块（`assistantTexts`）。
  2. 把 substrate 以 user 轮次宣告的续写（文本以 `Output token limit hit` 开头）计数（`outputLimitContinuations`）。
  3. 仅当确实发生过续写且拼接结果非空时，用拼接文本作为该轮回答，否则保持原来的 `result.result`。
  4. 发生续写时向 stderr 打印拼接了几段，避免这件事无声发生。
- 为什么这样做：provider 的单次输出上限不可由本仓库取消；可修正的是**运行器只保留尾段**这一点。
  对未发生续写的普通轮次行为完全不变。
- 验证：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 干净；
  `node --test --test-concurrency=1 'test/**/*.test.ts'` 退出码 0。
  实跑 M03（20261015T213658Z-3c87）确认 R1 这次产出了 `reviewer-R1-questions.md` 与
  `reviewer-R1-rationale.md`，即原失败点已消除。
- 该次运行随后因账号会话额度上限在 R2 失败（`resets 2:10am Europe/Vienna`），与本变更无关。
