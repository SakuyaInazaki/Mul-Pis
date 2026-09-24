# GitHub 推送规范

## 目的

本仓库是公开仓库。每次推送须按用户当次授权范围审查。本次用户明确要求原文发布项目 notes、运行日志、关联记录和附件；原件可保留其中的题目背景、运行路径、平台标识与成绩，不得为此改写或摘要原件。账户认证文件和实际账户密钥仍须排除。

## 允许推送

- `src/`
- `test/`
- `docs/`
- `scripts/`
- `.agent/notes/` 下经逐文件审查的项目变更记录；本次按用户要求保留原文
- `.agent/public-evidence/` 下按明确范围制作的无损原件归档和简短清单；本次包括运行日志、关联工作区记录、telemetry、现有资源附件和用户指定的恢复附件
- 根目录的构建、说明和配置模板文件
- 明确标记为公开的工作流文本

## 禁止推送

- 账户认证文件、实际账户 API key 和其原文副本；这类文件保留本地，不纳入原件归档
- 未获本次用户授权范围覆盖的材料
- 活动目录 `.agent/telemetry/`、`.agent/private/`、`.agent/improvement/`、`workspaces/`、`resources/` 的直接跟踪；经审查的原件仅以 `.agent/public-evidence/` 归档发布
- `third_party/`
- `.venv/`
- 未经明确授权的临时文件、缓存、本机产物和原始聊天记录

## Commit message 规范

- 必须是完整、有意义、可读的提交说明。
- 禁止为了脱敏而把提交说明截断成 `docs:`、`feat:`、`chore:` 这类无意义单词。
- 不得包含以下内容：
  - 本机家目录或系统盘符开头的绝对路径
  - 本机用户名、平台账号、邮箱
  - platform submission ID、进程 PID、机器名
  - telemetry、私有仓库、聊天记录等内部记录引用；公开 notes 的简明名称可按需提及
  - token、apiKey、sessionToken、Bearer、turnstile、密钥片段
- 原提交说明包含敏感内容时，应改写为可公开的等价摘要，而不是只删除冒号后的内容。

## 推送前检查

1. 运行 `git status --short`，确认工作区没有要提交的禁止路径。
2. 逐一审查 staged 的 `.agent/notes/` 原文和 `.agent/public-evidence/` 归档清单。确认原件来源属于本次明确范围，逐成员核对归档解包字节，排除认证文件及实际账户密钥；不要因题目、成绩、日志或本机路径出现就改写原件。确认 staged 不直接跟踪活动 `.agent/telemetry/`、`.agent/private/`、`.agent/improvement/`、`workspaces/`、`resources/`。只显式暂存审查通过的文件，不使用 `git add .`。
3. 扫描 staged diff 和 commit message，重点检查：
   - 提交说明和普通代码、文档中意外出现的本机绝对路径、身份、平台账号
   - 原件归档中实际账户 API key、认证文件或密钥副本；本次授权的原始路径、题目与运行数据不因此排除
   - `apiKey`、`sessionToken`、`Bearer`、`sk-`、`turnstile`
4. 运行 `npm run typecheck`。
5. 运行 `npm test`。
6. 模拟公开文件清单，确认 notes 和原件归档只含本次审查通过的材料，不含认证文件、额外第三方 checkout、依赖目录、软链接或嵌套 `.git`；简短清单列出来源、文件数、原始字节数、归档路径及认证排除理由，不建立 hash 清单。

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
