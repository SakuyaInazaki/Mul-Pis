# 删除 CI 及只为它服务的全部代码

用户 2026-10-19 的决定：去掉 CI 相关的一切东西。本批次按引用关系逐个确认后整体回收。

## 删了什么（87 个文件、约 30,713 行）

- `.github/` 全部：4 个 workflow 与 3 个 composite action（final-carry-upload、live-control-smoke）。
- `scripts/` 13 个：私有 campaign 入口与心跳/实时状态/观察者、Actions 传输与余额探针（Python）、
  实时控制帧读取、私有续跑与运行请求准备、`action.yml`、campaign 公钥、公开 M01 smoke。
- `src/runner/` 28 个：账本续跑、mission supervisor / host adapter / resume journal / mission-state、
  carry 与 sidecar codec（含增量前缀）、增量私有检查点、private-\*、signed-mission-ledger、
  live-control-frame、emergency-carry、research-history-\*、provider-availability-proof、
  四个 \*-source-review、result-only-\*、m04-quarantine、archived-m07-import、deepseek-availability、
  deepseek-campaign、deepseek-cny-pricing、deepseek-provider-limits。
- `src/m07/` 3 个：independent-restart（它的全部调用方都是上面这条链路）、evidence-finalization、
  prior-objective-checkpoint-evidence（后两个只被 `manual-private-campaign.ts` 使用）。
- `src/workflow-archive/` 4 个全部。
- 测试 28 个：上述模块与脚本的测试，含 `test/private_actions_transport_test.py` 与
  `test/live-control-actions-smoke.test.ts`（后者直接 import `.github/actions/.../main.mjs`）。
- 文档 2 个：`docs/implementation/private-run-request.md`、`manual-public-m01-smoke.md`。

## 改了什么

- `src/runner/pi.ts`：删掉 `campaignBudget` 与 `onCampaignAccountingBoundary` 两个选项，以及约 50 处
  campaign 分支。保留行为按**原来没有 campaign 时的那条路径**逐一对齐：
  - strict 请求的校验简化为「必须有正整数输入字节上限、不得带工具、不得带输出 token 上限」；
  - strict 流不再包账本包装层，只保留模型身份核对与 payload 字节上限核对；
  - `attestConfinedGrant` 去掉 campaign 前置条件，确认受限文件工具这一能力对本地 source 研究臂继续可用；
  - `forkGrantNoBroader` 去掉 `campaignAudited` 参数：custom→custom 的 fork 本来在非 campaign 下一律拒绝
    （自定义工具是绑定在活会话上的宿主闭包，持久化 spec 无法证明是同一批闭包），随之删除其后已不可达的
    「受审 custom fork 写白名单」校验块。
- `src/runner/index.ts`：去掉 deepseek-campaign 的再导出。
- `src/m07/objective-progress.ts` 不动；`repair-liveness.ts` **保留**——它被 `objective-progress.ts` 与
  `src/stages/m04.ts` 使用，不属于这条链路。`confined-campaign-files.ts` 也保留，`src/improvement/source-candidate.ts`
  依赖它（名字里的 campaign 是历史命名）。
- `tsconfig.json`：去掉 `scripts/manual-private-campaign.ts`。
- 两个测试改为不依赖已删代码：`test/m07-context-branches.test.ts` 直接断言 lineage sidecar 的
  `state`/`child.sessionId`/`evidenceBindings`，不再借 campaign 脚本的 helper；
  `test/runner/pi-sdk-tool-stream.test.ts` 去掉账本与传输诊断断言，改为断言「中断的响应不会重放本地工具、
  每次重试都带同一条已记录的工具结果」——没有 campaign 时 SDK 自身的重试是正常行为，之前是 campaign 把它关掉的。
- `test/runner/pi.test.ts`：strict 请求的拒绝消息跟着改。
- 文档：`AGENTS.md` 增加一条「本仓库没有 CI」并写明不要重新引入 `.github/`、托管付费试跑与写死的仓库/分支名；
  `docs/github-push-policy.md` 同步一句；`docs/implementation/workflow-limit-inventory.md` 删掉 campaign/Actions
  四行并修正范围说明；`docs/implementation/context-boundaries.md` 去掉 private campaign 措辞与引用已删函数的整段。

## 验证

- 类型检查 0 错误。
- 全量测试 510 项、509 通过、0 失败、1 跳过（仅 Linux）。
- 删除后用一份可达性脚本从保留入口（CLI、两个 extension、终端控制台、workflow-control、
  prepare/run-workflow-source、两个 deepseek 手动脚本、improver 子进程程序）重算：`src/`、`extensions/`、
  `terminal-console/src/` 里只剩三个 barrel（`src/index.ts`、`src/knowledge/index.ts`、`src/runner/index.ts`）
  不被任何入口引用，它们是预先存在的公开 API 面，已按删除结果裁剪，未动其余导出。
- 全仓已 grep 不到 `GITHUB_*` 环境变量、`SakuyaInazaki/Mul-Pis` 之类写死的仓库名，或 `run-requests/` 分支名。

## 需要注意

- `src/m07/independent-restart.ts` 与 `src/runner/mission-state.ts` 一起删掉了：前者的职责是「终态尝试之后
  接管一个独立目标，调用方自己认证 carry」，调用方全在私有 campaign 链路里，删完没有任何保留功能用到它。
  如果用户要恢复，这两个文件与其测试在本提交之前的历史里完整可取。
- 远端 `run-requests/*` 与 `improve/*` 分支未动。
