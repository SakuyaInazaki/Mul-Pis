# 2026-09-22 GitHub 推送规范

## 变更

- 新增 `docs/github-push-policy.md`。
- 在 `AGENTS.md` 增加 GitHub push policy 引用和关键要求。

## 目标

- 后续 agent 推送时不得带入 notes、telemetry、private 记录、workspaces、日志、凭据、平台身份、本机路径或私人身份信息。
- commit message 必须完整、有意义，不得截断成 `docs:`、`feat:`、`chore:` 这类无意义前缀。
- 禁止推送具体测试题、平台提交内容、SID、分数、排名、测试台账、平台指南或测试专用产物。
- 推送前必须 typecheck 和测试；历史改写和 force push 必须获得用户明确授权并先做外部 bundle 备份。

## 验证

- `npm run typecheck` 通过。
- `npm test` 通过：129 tests，0 fail。
- 普通 `git push origin main` 成功。

本地记录，未推送。
