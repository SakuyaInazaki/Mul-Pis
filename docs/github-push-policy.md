# GitHub 推送规范

## 目的

本仓库是公开仓库。推送时必须保证公开历史中只出现可公开的源码、测试、文档和工作流材料，不得把本机文件、私人记录、运行遥测、平台身份或凭据带入公开历史。

## 允许推送

- `src/`
- `test/`
- `docs/`
- `scripts/`
- 根目录的构建、说明和配置模板文件
- 明确标记为公开的工作流文本

## 禁止推送

- `.agent/notes/` 下的实际记录；远端只允许保留 `.agent/notes/.gitignore`
- `.agent/telemetry/`
- `.agent/private/`
- `workspaces/`
- `resources/`
- `third_party/`
- `.venv/`
- 运行日志、临时文件、缓存和本机产物
- 任何凭据、token、session、平台身份、邮箱、本机绝对路径、聊天记录或私人身份材料
- 任何具体测试题、测试任务、平台提交相关内容：题面、候选代码、评测数据、submissionId、displayScore、排名、平台指南、提交台账、测试日志或测试专用产物。测试内容与工作流本身无关，不得进入公开仓库。

## Commit message 规范

- 必须是完整、有意义、可读的提交说明。
- 禁止为了脱敏而把提交说明截断成 `docs:`、`feat:`、`chore:` 这类无意义单词。
- 不得包含以下内容：
  - 本机家目录或系统盘符开头的绝对路径
  - 本机用户名、平台账号、邮箱
  - platform submission ID、进程 PID、机器名
  - notes、telemetry、私有仓库、聊天记录等内部记录引用
  - token、apiKey、sessionToken、Bearer、turnstile、密钥片段
- 原提交说明包含敏感内容时，应改写为可公开的等价摘要，而不是只删除冒号后的内容。

## 推送前检查

1. 运行 `git status --short`，确认工作区没有要提交的禁止路径。
2. 确认 staged 内容不包含 `.agent/notes/`、`.agent/telemetry/`、`.agent/private/`、`workspaces/` 等目录。
3. 扫描 staged diff 和 commit message，重点检查：
   - 本机绝对路径与用户名
   - 平台身份、邮箱、submission ID、PID
   - notes 或 telemetry 引用
   - `apiKey`、`sessionToken`、`Bearer`、`sk-`、`turnstile`
4. 运行 `npm run typecheck`。
5. 运行 `npm test`。
6. 确认远端 `.agent/notes/` 树中只有 `.gitignore`。

## 推送流程

- 普通推送使用 `git push origin main`。
- 如果必须改写历史或 force push，必须先取得用户明确授权，并先把当前仓库做成仓库外的 bundle 备份。
- force push 使用 `git push --force-with-lease origin main`。
- push 后重新检查远端 commit message 和远端树，确认没有敏感内容。
- 历史改写只能由用户明确要求时执行，不能由 agent 自行决定。

## 事故处理

如果已经推送了敏感内容：

1. 立即停止继续推送。
2. 在仓库外做完整 bundle 备份。
3. 如实报告影响范围和涉及提交。
4. 按用户授权执行历史改写和 force push。
5. 必要时联系 GitHub Support 清理不可达旧对象。
