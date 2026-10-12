# GitHub 推送规范

## 目的

本仓库是公开仓库。每次推送须按用户当次授权范围审查。历史上一次发布曾获用户明确授权，原文发布经审查的项目 notes、运行日志、关联记录和附件；该次原件可保留题目背景、运行路径、平台标识与成绩。这项历史授权不延续到当前发布。当前发布范围是经审查的通用源码、测试、说明及相应通用变更记录；新的私人运行原件须另获明确范围。账户认证文件和实际账户密钥始终排除。

## 允许推送

- `src/`
- `test/`
- `docs/`
- `scripts/`
- `.agent/notes/` 下经逐文件审查、属于当次授权范围的项目变更记录；当前发布仅纳入通用变更记录
- `.agent/public-evidence/` 下在另获明确原件发布范围后制作的无损原件归档和简短清单；历史发布曾包含获授权的运行日志、关联工作区记录、telemetry、资源附件和指定恢复附件，当前发布不继承该范围
- 根目录的构建、说明和配置模板文件
- 明确标记为公开的工作流文本

## 禁止推送

- 账户认证文件、实际账户 API key 和其原文副本；这类文件保留本地，不纳入原件归档
- 未获当前用户授权范围覆盖的材料
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
2. 逐一审查 staged 的 `.agent/notes/` 原文；如当次另行授权原始证据，才审查 `.agent/public-evidence/` 归档清单并逐成员核对归档解包字节。确认每份材料属于当次明确范围，排除认证文件及实际账户密钥。历史发布中获授权的原件不得仅因题目、成绩、日志或本机路径出现而改写；此项历史处理方式不扩大当前范围。确认 staged 不直接跟踪活动 `.agent/telemetry/`、`.agent/private/`、`.agent/improvement/`、`workspaces/`、`resources/`。只显式暂存审查通过的文件，不使用 `git add .`。
3. 扫描 staged diff 和 commit message，重点检查：
   - 提交说明和普通代码、文档中意外出现的本机绝对路径、身份、平台账号
   - 如当次明确授权原件归档，检查其中实际账户 API key、认证文件或密钥副本；历史发布对原始路径、题目与运行数据的授权不适用于当前发布
   - `apiKey`、`sessionToken`、`Bearer`、`sk-`、`turnstile`
4. 运行 `npm run typecheck`。
5. 运行 `npm test`。
6. 模拟公开文件清单，确认 notes 和任何另获授权的原件归档只含当次审查通过的材料，不含认证文件、额外第三方 checkout、依赖目录、软链接或嵌套 `.git`；如有原件归档，简短清单列出来源、文件数、原始字节数、归档路径及认证排除理由，不建立 hash 清单。

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
