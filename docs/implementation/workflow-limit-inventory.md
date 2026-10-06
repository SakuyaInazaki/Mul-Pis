# 全工作流限制清单（2026-10-06 代码审计）

## 结论和口径

用户要求去除自设的模型输出、执行时间和调用/返工次数上限，同时保留文件大小限制。**当前实现仍有其他边界**：文件与网络响应容量、用量与费用观察（不作为运行门槛）、外部平台和供应商能力、来源覆盖、权限/隔离、冻结证据与科研验收。不能把这些都叫作“执行配额”。本轮同时修复了写入可通过但读回仍受旧文件数量门槛阻断的分支快照，以及可显示索引却无法读回完整源文的历史反馈路径。本文按当前未提交工作树核查，区分：**运行硬停**（执行到数值即终止）、**容量拒绝**（文件/响应过大）、**可续读窗口**（原件保留）、**范围/证据门禁**（只对固定实验或已核实来源成立）、**外部限制**（本仓库无法取消）。

范围：实读 `src/`、`scripts/`、`tools/py/`、`.github/workflows/` 相关执行路径，查找 `max/min/limit/quota/budget/timeout/deadline/round/retry/slice/truncation/allowlist/concurrency`，参照 `workflow/v1.0/` 的科研阶段规则；`test/`仅用来核对预期。未读取 `third_party/`、`.venv/`、`resources/`、私有 case、真实运行结果或凭据。本文按最终合并的未提交工作树作静态核查；离线验收结果另据测试记录，仍不保证外部 SDK 或平台不存在额外限制。

## 已调整的执行时间与次数

| 入口 | 当前行为与证据 | 性质/剩余问题 |
| --- | --- | --- |
| 私密 campaign `scripts/manual-private-campaign.ts` + `.github/workflows/manual-private-campaign.yml` | 已去除原 25 分钟 campaign、45 秒结算预留、90 秒新 phase 门槛、64 全局/32 单 prompt calls、8 builder 轮和 Actions 30/45 分钟显式 timeout。曾用于单次续跑的付费 `push` 触发器已移除；现在只有显式 `workflow_dispatch` 且 `authorize_bounded_run=true`，并核查仓库/actor/ref/首次 attempt、保持同组串行。公开离线回归工作流的 push 不运行此私密 campaign。 | 原数值是**历史限额**，不得再描述成当前停止条件。GitHub 托管 runner 自身的生命周期仍属外部边界，跨进程续作须走已验证恢复协议。 |
| M07 `src/m07/controller.ts`、`src/m07/execution-loop.ts`、`src/m07/objective-progress.ts` | builder/reviewer 持续到 reviewer 终态或真实阻断；旧 `maxRounds/deadlineAt` 字段可读但仅为历史审计，不驱动当前停止；原目标重新评估循环也不再限 64 次。重复不可用提案和连续空回合只生成诊断/重规划反馈，不再按固定重复次数终止。 | 分支仍必须保持冻结目标、材料和检查义务；未决外部操作、失败、用户决定和进程身份可能阻止继续。这些是状态/证据门禁。 |
| Pi 主/子会话 `src/pi/service.ts`、`src/pi/extension.ts` | 整条子 prompt 的墙钟与停滞 watchdog 默认均为 0（关闭）；主会话停滞默认也关闭；显式旧配置可开启。 | 不再以默认 60 分钟/10 分钟终止仍在推进的执行；用户/调用者主动提供旧 watchdog 值仍可停止。注意供应商或 SDK 自身断连。 |
| Pi 严格请求 `src/runner/pi.ts`、专用结算 `src/runner/deepseek-campaign.ts` | 按实时核对的 provider 最大输出值请求；旧 CNY 总额与调用次数不再决定是否发送。模型/端点身份、输入 payload、逐请求使用事件与不确定费用继续核查；strict mode 禁 SDK 自动 retry/compaction。 | Provider 的真实单请求最大输出和 context window 是**外部物理限制**。无法核实币种/价格时费用记为未知，不伪造零费用或发票；未决外部操作仍需独立核对。 |
| 重试 `src/pi/retry-guard.ts` | 原“同一失败连续 2 次禁止原样重试”已不作为执行门槛；失败指纹仍记录。 | 幂等性、未知外部副作用与人工核对要求仍然有效，不能把无次数限制理解为盲目重复外部操作。 |
| M05 browser-use `tools/py/browser_task.py`、`src/stages/m05.ts`、`src/tools/fetch.ts` | 不再传 `max_steps`，直接驱动已核实 browser-use `step()` API 至任务完成/外部中断；与旧 SDK 不兼容时 fail closed，防止悄悄退回 SDK 强制最后一步。浏览脚本无固定 10 分钟总时限。 | 独立 browser 任务仍可能因模型、站点、网络或权限失败；版本特性检验是能力门禁，不是次数门槛。 |
| 自我改进 `src/improvement/service.ts`、`research-types.ts`、`workflow-types.ts`、`research-service.ts`、`workflow-adapter.ts`、`admission.ts` | 旧候选、试验调用、决策、inspect 次数、每 prompt 墙钟、root/phase call/input/CPU/wall/费用额度不再作为运行门槛；提案循环到明确终态/真实阻断。SDK 估计费用仍作为观察值。 | 旧累计回读额度 `maxReadbackChars` 仅作为历史字段读取；`maxFeedbackItems` 只控制单次可见反馈窗口；paired `admissionRepetitions` 和 case 集是显式实验定义。重复/负结果不能伪称增益或自动升格。 |
| CPU 机制实验 `src/experiments/local-environment.ts`、`executor-eval.ts`、`budget.ts` | 去除 campaign 的 probe/call/CPU/墙钟配额及默认 3 action episode 硬停。CPU case 自带的 `maxProbeCalls` 仍规定**该 case 可观察资源**，达到后给 `resource-exhausted`，不是整个科研任务的全局次数上限。 | 固定有限 hypothesis 域与 protected G checks 仍定义此适配器适用范围；费用账本和未知 usage 仍可能令 admission inconclusive。 |
| 独立公开 M01 smoke `.github/workflows/manual-public-m01-smoke.yml`、`scripts/manual-env-m01-smoke.ts` | 固定公开 M01 连通性试验已移除 2.1 CNY 自动费用门槛；保留 12,000 字节固定公共输入边界、实时 provider 输出上限核对、Pi 使用记录核查与隐私安全输出。 | 单阶段可能有多个 HTTP 请求；SDK 估计费用是观察值，不是独立发票。托管 runner 的外部生命周期仍不能保证无限。 |

## 仍有效的文件/数据容量和观察窗口

| 位置 | 当前上界或行为 | 到界效果 |
| --- | --- | --- |
| `src/runner/confined-campaign-files.ts` | 单次完整 read 1,000,000 字节；write/edit 结果 128,000 字节；任务工作目录限定。 | 超额**拒绝**而非截短；保留。 |
| `scripts/private_actions_transport.py` | 输入 base64 64 KiB、压缩 48 KiB、tar 96 MiB；单文件 64 MiB，review 文本 512,000 字节，封套 132 MiB；结果 allowlist。 | 超额/不在名单拒绝或不纳入；安全传输，不是模型回复 token 配额。 |
| `src/runner/ledger-continuation.ts` | 加密 carry 8 MiB，GitHub API 页/归档结构和身份、祖先/账目一致性检查。 | 不能恢复时 fail closed；不可把缺少证据当作已结算。 |
| `src/workflow-archive/m07-private.ts` | review 文本 512,000 字节；知识 256,000 字节、manifest 32,000 字节（旧 48 记录/24 采纳引用数量上限移除）；候选 128,000、验证 1,000,000、计划/lesson 各 16,000 字节。 | 文件超额拒绝私档；原 8 轮/8 操作归档计数限制已移除。 |
| `src/m07/controller.ts`、`src/improvement/observations.ts` | round/branch 快照不再限文件数量，仍限 64 MB 文件字节总量；checkpoint 的 9,999 编号、256 所选 task/file/raw 条目和 `resourceInputs` 12 条上限已移除；M04 12 所需材料与 100,000 行证明门槛也已移除。投影单材料 8 MiB、单调用 16 MiB、单 run 64 MiB；反馈策略的 prompt/内联/反馈字符默认 180,000/48,000/120,000/140,000。 | 这些是**每批文件/输入清单容量**，不是目标执行轮次；快照超额使重放不可用或拒绝，仍可调整批次再试。内联溢出可 manifest-and-defer，M04 必须按范围实读。原文件不自动删除，索引不证明已读。 |
| `src/m07/controller.ts`、`execution-loop.ts`、`objective-progress.ts`、`evidence-finalization.ts` | builder report 16,000 字符与 objective assessment 32,000 字节的原始回复门槛已移除；**reviewer 冻结文件**512,000 字节、candidate delta 文件 16,000 字节、objective evidence 文件总量 1 MB、finalization 单文件 1 MB 等仍保留。objective 协议的任意数组数量/自由文本长度门槛已移除；标识符、类型、实际证据范围和语义仍校验。 | 区分一般模型回复与要冻结的证据文件、结构化字段；后者超额需报容量/schema 错误，不可静默舍弃。 |
| `src/tools/http.ts`、`src/tools/fetch.ts` | 通用 `fetchJson/fetchText` 响应最多 20 MB、下载最多 250 MB；M05 `httpFetchPage` 通过下载容量路径读取，包含 HTML 在内最多 250 MB。读取过程中检测并拒绝超额。 | 文件/响应容量，保留。网络 header/body 均受逐段空闲计时，见下节。 |
| `tools/py/browser_artifacts.py` | 页状态/截图**数量**的旧 20/12 上限已取消；保留每个 HTML 5 MB、每个文本 2 MB、每张截图 250 MB、每个登记下载 250 MB 的单文件边界；不再累计耗尽整场会话的捕获额度。 | 单个超大文件明确 warning，后续合格小文件仍可捕获；这些不是浏览器磁盘硬 quota。遗漏不能称已完整覆盖。 |
| `src/stages/m05.ts` | 检索每 provider 每页默认 10/最多 30，链接显示每次 50/最多 200；工具文字默认 6,000 字符、`read_work_file` 可按 offset 续读；`view_work_image` 一次 ≤10 MiB；PDF 显式 `max_pages` 接受任意正整数（旧 500 clamp 已移除），省略则全文。 | **分页/单次显示/单文件**限制仍在。检索与 PDF 初筛会影响覆盖，需继续页/游标或全文重提。 |
| `src/tools/search.ts` | 各 provider 实际页大小多 ≤50；Brave 前 10 offset 页/每页 ≤20、GitHub 搜索可访问前 1,000、Crossref offset 近 10,000 后转 cursor。 | 一部分是供应商 API 窗口；不可因本地无时间/次数限额宣称全网穷举。 |
| `src/knowledge/retrieval.ts`、`experience-index.ts`、M04–M07 调用者 | 一般知识包 ≤500 条/1,000,000 字符；M05 30,000 字符、M06 32/40,000、M07 24/60,000；experience 显示包仍有字符/条数窗口，M07 默认 24/24,000；精确继承引用验证不再以 100 条为门槛；历史扫描 2,000 版本和排名首 24,000 字符/96 词截断已移除。 | 有省略元数据与 ID/range 补读路径。只有已实际读到的内容可支持科研判断；知识 live limits 仍核查。 |
| `src/improvement/admission.ts`、`research-service.ts`、`workflow-adapter.ts` | case 文件 ≤2 MB、material ≤200,000 字符/合计 ≤1,000,000；研究先前反馈保留文件边界，完整 MetaEpisode 可用每份 ≤120 KB 的无损分片读取；模板单文件 8 MiB，旧 12 层深度门槛移除；研究/工作流 inspect 单次 ≤4,000 字符，机制实验按登记材料范围读取；旧累计计划回读 40,000 字符上限已移除。 | 保留文件/上下文容量与可续读窗口；旧尝试可通过冻结分页历史工具读取；M04 源文不再截取首 8,000 字符，反馈行/观察记录不再只保留首 40/16 项。历史资料超额不得伪称已完整读取。 |
| `src/dashboard/server.ts`、`runtime/bounded-file-tail.ts` | 面板单次 JSON ≤2 MiB，否则 413；控制台单文件尾一次 1–65,536 字节。 | **只影响观察窗口**，不裁剪科研原始文件。 |

## 适配器、实验范围与不可混淆的次数

- `src/improvement/workflow-types.ts` 的 M07 evidence-handoff 适配器仍只允许 `reason/check` 类单任务、无额外知识/经验授权或独立检查，是第一版固定局部机制对比。旧每 split 4 case 上限与 30 决策/10 候选等执行次数上限已移除；paired admission 仍要求 ≥2 且偶数重复，这是**实验设计**，不代表一般科研目标最多运行几次。它**不支持宣称“整个 M07/全工作流适配”**。扩展任务类型、工具权限和 protected checks 要独立设计与验证。
- `src/experiments/local-environment.ts` 的 CPU 识别任务仍以有限候选假设（2–8）和 caller 给定的可探测点、每 case 的探针许可构成问题本身。一个 case 的 `maxProbeCalls` 是任务条件，不是 H/I campaign 的总 provider-call 上限。
- `src/workflow-archive/csr-checker.ts:CSR_EXPERIMENT_LIMITS` **仍保留实验域计数与工作量边界**：最多 16 策略、6 cases、重复 3–50、warmup 1–8、最多 4 个线程选项/16 线程、`timedWork` 2 亿；另有矩阵行/列/nnz、源码字节、worker 2 GiB 地址空间边界。它是专用 C++/CSR 安全与可比性适配器，**不能说全部次数限制都已取消**。worker CPU 60 秒和协议总时限 15 秒仍有效（`workerCpuSeconds`、`protocolTimeoutMs` 以及生成的 C++ `setrlimit(RLIMIT_CPU)`/deadline），本次只改工作流，不改此专用科学适配器。若用户要求这里的实验域也取消，需另作设计/安全审查，不能只改常数而声称同一实验仍可比。
- `src/stages/m08.ts` 的外审者是 caller 提供，harness 不固定人数；M09 只交付指定 M04 对指定 M08 版本允许的范围。M04 的 `suspended/withdrawn/needs_recheck` 是知识使用资格，不是算力配额。`src/m07/independent-restart.ts` 对未知外部操作和进程身份 fail closed；`src/knowledge/store.ts` merge 锁恢复也要求验证死 owner。这些均应保留。

## 通信超时实际含义

`src/tools/http.ts:fetchWithIdleTimeout` 现对建立连接/等响应头及**读取 body 的相邻数据块**使用空闲定时器：通用 JSON/文本默认 30 秒、下载默认 120 秒，M05 纯 HTTP 默认 60 秒；每收到一块便重置。因此它**不是总下载时长上限**；持续有数据的长下载可继续直到完成或碰到 20/250 MB 容量边界。`src/tools/fetch.ts` 的纯 HTTP 也改用这一路径；Python/Poppler 子进程父级的旧总执行计时已移除，父级取消信号仍可中止。Crawl4AI 路径已移除外层 `asyncio.wait_for` 总截止，显式传 `page_timeout=0` 取消此本地 Playwright 导航截止；`--timeout` 仅用于 HTTP fallback 的通信故障检测。未运行真实浏览器验收，也未声称消除了每个第三方 SDK 内部特定操作的超时。DeepSeek 元数据查询、结算 carry 的 GitHub API 与受控沙箱协议可有有限的**单次通信/握手空闲故障检测**，应与“研究执行总时长”分开记录；供应商、OS 或 Actions 隐含超时本仓库不能保证消失。超时/断连后的重新尝试仍需辨认幂等性、未知副作用、账目及冻结证据。

`src/runner/deepseek-cny-pricing.ts:assertNativeCnyPricingCurrent` 当前报价 profile 截止 2026-10-07T00:00:00Z；这是**价格依据新鲜度**，不是任务运行时限。到期后新请求的 CNY 费用记为未知；复核并版本化报价前不能把过期价格冒充核实后的费用，也不能用它阻止科研继续。

## 剩余核对

- 当前主路径不再施加自设 provider 输出、调用次数或费用总额上限；旧 runner 调用方的输出 override 已移除。实时供应商最大输出与上下文窗口仍是物理限制；已认证的历史费用承诺和未知数额仍作为账务证据保存，不能当作新运行的费用门槛或真实发票。
- 所有文件/响应字节界限、工具授权、私档 allowlist、科研验收和外部环境门禁仍生效。**无任意时间/调用次数上限**不等于“无限文件”“全网已覆盖”或“结果已通过科研验证”。
