# 关键工作流测试精简

用户要求继续清理重复、过时和过度设计的测试，仅保留关键功能，全部修改完成后统一验证。以下删除在执行前记录；不改生产源码、测试入口或 skip。所有文件已由 Git 跟踪，可通过 `git show HEAD:<path>` 提取原案例；恢复时只还原对应案例，保留同文件其他尚未提交修复。

保留功能：候选源码生成与工程检查、真实加载版本、独立成对执行与准入、知识依赖/撤回/持久化、M07→M04 归档重验及恢复、主状态显示。完整集成路径替代相同规则的字段排列和层层 mock 检查。

整体删除的替代覆盖：
- `loaded-source.test.ts` 由 `workflow-source-launch.test.ts` 的真实进程、晚加载及错误描述符验证，以及 `workflow-source-arm.test.ts` 的实际 A/B 加载覆盖。
- `model-json.test.ts` 由 `source-candidate.test.ts` 的实际生成器纠正/拒绝及 `workflow-source-search.test.ts` 的模型输出修复覆盖；不保留 Markdown 栅栏全部拼写组合。
- `experiments/review-regressions.test.ts` 的 CPU/元改进/租约排列由 CPU probe 持久化与 `research-improvement.test.ts` 的完整 quality/meta 链、`workflow-source-arm.test.ts` 的实际版本准入覆盖。
- `result-only-gap.test.ts` 是历史修复候选的低层字段矩阵；保留任务组中的真实未知动作对账和认证恢复链，数值/字段逐项排列退出主测试集。

## test/archived-m07-import.test.ts

保留：
- archive import fails closed for forgery, changed bytes, wrong binding, unsafe state and missing source
- frozen archived source gets fresh M07 review, full-read M04 and continued original-objective assessment
- throwing M04 leaves proposal effects unknown and fails the archived retry gate closed

删除：
- authenticated archived accepted source stages exact untrusted inputs without resurrecting old review
- failed M04 with no proposal still requires a matching no-proposal transaction
- authenticated future rejected-draft transaction allows only fresh untrusted provenance import
- future M04 proposal import refuses missing, malformed, conflicting, or merge-possible receipts
- registered historical plan stages exact bytes and missing declared plan is rejected
- authenticated completed provenance M04 is indexed as historical evidence without store activation
- import retry targets only newest failed-M04 accepted run; completion or partial yields to assessor
- one-use restart binder binds first fresh goal and reuses its ownership for later same-run goals
- import M04 effect disposition only continues on known safe failure or completed stage
- failed M04 with a submitted proposal blocks assessor dispatch pending reconciliation

## test/dashboard-state.test.ts

保留：
- fresh resumed telemetry outranks an old completed membership
- completed runs with failures are warnings and telemetry never exposes payload fields
- dashboard exposes a suspended M07 attempt even when the run and telemetry remain running

删除：
- dashboard snapshot separates fresh, idle, archived, and legacy unknown state
- fresh explicit membership activates a running stage before run.sessions is persisted
- a session in a legacy running run is unknown without fresh telemetry

## test/dashboard-server.test.ts

保留：
- dashboard exposes opaque workspace IDs and safe state on loopback
- dashboard rejects arbitrary workspace paths, foreign origins, writes, and traversal

删除：
- dashboard refuses metadata symlinks that escape a registered workspace

## test/experiments/local-environment.test.ts

保留：
- probe separates same initial observation, fork resets state, and private truth is absent from model view
- failed persistence leaves action unresolved and does not repeat a charged probe

删除：
- unidentifiable allowed probes are healthy only with justified-unknown calibration
- failed submit and stop persistence cannot produce protected acceptance
- stop retains scientific per-case probe semantics and ignores historical campaign time/count quotas
- historical monetary reference and unknown cost never gate later requests

## test/experiments/review-regressions.test.ts

保留：
- 整文件删除，替代覆盖见上文。

删除：
- finite CPU reference classifies initial, multi-step and budget-limited uncertainty
- completed branch closes independently while in-flight work remains open
- meta search freezes alternating settled no-winner arms before G and permits only measured efficiency
- quality protocol rejects identical no-winner H0 without a protected request
- meta efficiency never treats an unknown search price as a measured gain

## test/improvement.test.ts

保留：
- projection screen without admission case ends inconclusive and keeps active policy
- controller-owned paired local mechanism checks can promote one policy
- method export and manual bind move policy without case or knowledge data
- failed mechanical checks reject, and missing usage is inconclusive
- a duplicate proposal does not stop a later distinct feasible candidate
- concurrent services allow only one mutation
- promotion compares active pointer with frozen baseline before commit
- active pointer remains authoritative if the final run status write was interrupted

删除：
- runtime UTF-16 projection survives replay and rejects a byte-only reduction
- development cases may diagnose but cannot authorize promotion
- an older attempt remains inspectable after more than twenty historical runs
- mixed paired costs remain inconclusive even when total cost falls
- second generation cannot cross the absolute inline coverage floor
- rollback does not lift an active knowledge restriction

## test/loaded-source.test.ts

保留：
- 整文件删除，替代覆盖见上文。

删除：
- fixed source proof follows the actually imported module and rejects another claimed commit
- fixed source requires a descriptor proof and a read-only receipt

## test/model-json.test.ts

保留：
- 整文件删除，替代覆盖见上文。

删除：
- one JSON document follows a complete TypeScript example
- multiple, missing, and unfinished JSON fences remain rejected
- shorter nested fences inside a four-backtick example are not extracted

## test/research-dependencies.test.ts

保留：
- active I requirements survive an omitted plan selection and block new calls after recheck
- rollback prechecks the old generation and leaves the current pointer unchanged when its dependency is withdrawn
- V2 import preserves foreign pinned obligations and cannot activate without an explicitly registered store
- workflow method bind and rollback use the active workflow scope for inherited H and I experience
- a candidate saying to ignore dependencies still inherits controller-pinned I requirements
- a live limit after the first I reply blocks the next I request in the same campaign

删除：
- more than one hundred pinned refs are checked by exact store identity without rendering a pack
- active H requirement blocks a later campaign after its old pinned version is withdrawn
- method binding uses the package bytes that passed dependency checks even if its file changes

## test/research-improvement.test.ts

保留：
- research-only campaign consumes real CPU feedback, saves an agent H candidate, and leaves active generation unchanged
- executor-quality protocol may repair an underdetermined baseline without weakening mechanism-cost rules
- meta arms see separate development histories and select successors before G
- quality protocol credits justified unknown only partially and requires a solved-case gain

删除：
- meta refuses identical selected H bodies before any protected query
- one-decision I handoff reads only a matching persisted development world and no G
- I can probe and inspect a second registered case without losing its control facts
- feedback above one page is citable only after contiguous controller readback
- same-workspace development MetaEpisode is inspectable and citable without protected data
- large development MetaEpisode retains every feedback row and observation in bounded parts
- schema repair is explicit, bounded, and debited as another provider request
- development accepts justified unknown as partial scientific validity

## test/result-only-gap.test.ts

保留：
- 整文件删除，替代覆盖见上文。

删除：
- result-only gap screening retains observed aggregate and quarantines every request
- result-only gap screening rejects dropped requests, drifted accounting and in-flight transport
- result-only gap screening rejects actor effects, changed objective and broken predecessor binding

## test/source-candidate.test.ts

保留：
- a fake model edits an isolated source tree and produces a private commit and read-only snapshot
- builder corrects a prose-plus-raw-JSON handoff in the same session and commits the checked edit
- a second invalid handoff or provider error rejects the candidate
- a structured builder hypothesis preserves every nested field without another model turn
- full Git status rejects a control file edit even when the confined grant was narrow
- an empty edit is rejected and a failing engineering check remains visible
- a hanging engineering check ends on explicit cancellation

删除：
- cancellation during the hypothesis correction leaves a rejected receipt
- source builder rejects ambiguous JSON fences and missing hypothesis fields
- source H and I have separate typed bindings and cannot enter the prompt admission path
- a prepared source snapshot can import its own candidate builder without scripts
- an active builder prompt is aborted and its rejected receipt retains the session

## test/workflow-archive-csr-checker.test.ts

保留：
- independent checker times serial, std::thread, and every registered strategy
- new strategy cannot pass with stale, nonfinite, or unwritten output
- central gate preserves originals and rejects benchmark tampering and global initialization
- input mutation and output replacement fail independent verification

删除：
- helper functions, local preprocessing layouts, comments and main registration edits are supported
- single-target measurement invokes no other candidate strategy and records setup
- trusted source contains only original code and ignores worker status text as a protocol failure
- source diagnostics identify the exact construct and state that measurement never ran
- host parallel thread-selection and schedule clauses pass with explicit runtime caps
- OpenMP runtime cap is installed before worker startup and can coexist with explicit team requests

## test/workflow-archive.test.ts

保留：
- private M07 archive keeps each bounded round's source and host verification, plus structured reviewer feedback
- private review archive redacts credential values without discarding surrounding rationale
- private M04 export carries actual adopted record content, pinned dependencies, limits and snapshot without trusting the external archive
- M04 export marks missing store or unsafe knowledge incomplete instead of inventing adoption
- M04 export retains candidate, negative and limit-only published outcomes without claiming adoption

删除：
- private M07 archive retains bounded artifacts and a pending lesson without adopting it
- a merged M04 archive binds the portable snapshot identity exactly
- private M07 archive rejects a lesson whose evidence is missing or revision ref is unpinned
- private archive retains full long reviewer rationale and explicit controller decision as bounded artifacts
- private archive rejects malformed trusted numeric measurements rather than copying advisory payloads
- M04 export passes a live adopted experience with required tags to explicit authoritative follow-on selection
- private M04 export diagnoses a missing dependency with only pinned edge metadata
- private machine feedback retains actionable failed-case diagnostics and explicit measurement semantics
- private archive retains a settled but truncated terminal response without claiming task completion
- private archive carries only static host request-contract preflight controls and validates them on read

## test/workflow-evidence-handoff.test.ts

保留：
- builtin comparison runs a real M07/M04 arm without injecting its proposal-seed H
- workflow A/A calibration executes two fresh same-method arms without I, G, or promotion
- explicit workflow adapter runs frozen M07/M04 arms, checks G after selection, and activates only a new H
- workflow I receives one explicit frozen experience pack and records consulted refs on H
- selected development H remains research-only when independent G is absent
- protected G file inside pre-copied raw material is rejected before I can inspect it
- protected cases and input bytes are fixed before I and hidden during development
- independent research source freezes development history and owns I, candidates and activation

删除：
- workflow A/A builtin arms ignore unused H and I necessary refs
- workflow A/A records discordance without calling it improvement
- workflow A/A retains the first arm receipt when the second handoff fails
- workflow search rejects frozen improver model drift before I runs
- no winner, including an explicit null selection, performs no protected G work
- workflow I selection fails closed before a call when unavailable or changed
- workflow research keeps its frozen K when unrelated live knowledge advances
- missing current formal M04/K match stops before an I provider call
- workflow development source retains processing beyond the former 8,000-character clip
- public CLI bootstrap feeds the explicit workflow entry and fails closed on fake usage
- public CLI exposes the independent workflow calibration entry
- later workflow I can inspect a same-workspace development MetaEpisode without G
- protected input colliding with an arm-generated file is never silently replaced
- protected inputs cannot also be development inputs
- a source knowledge transaction cannot be copied into a runnable experiment
- workflow prepare CLI relocates a selected development MetaEpisode for the next I session
- research source preparation refuses unresolved knowledge, outside references and overlapping protected inputs

删除 protectedPolicyFile 两项路径排列；保留实际 protected G 落入 raw 输入时拒绝以及私有输入隔离集成。

生效知识变化仅保留 withdrawal 场景，删除 growth 同路径排列。

## test/workflow-source-launch.test.ts

保留：
- prepared A keeps loaded and later-imported source A while checkout and new launch advance to B
- launcher rejects a false source descriptor before the target process starts

删除：
- preparation uses an explicit commit and rejects indirect tracked source without replacing a destination

## test/workflow-source-search.test.ts

保留：
- two actually loaded I source versions choose different development action order
- asynchronous source-search actions stay pending on disk until their operation settles
- an I source cannot select an unregistered or unevaluated candidate
- invalid model JSON is a development observation that the same I source can repair
- a provider failure is recorded as unsettled and cannot become a complete no-winner
- a nonsettling loaded I decision is killed by the caller signal

删除：
- ask-model receives the trusted H or I source-edit target
- one complete JSON fence settles ask-model without a redundant retry
- incomplete callback usage cannot produce a complete selection
- complete token use with unpriced provider cost cannot write a terminal selection
- callback failure retains observed partial usage and cannot freeze a selection
- a source I missing its fixed export reports startup failure without a lingering child

## test/workflow-turn-budget.test.ts

保留：
- real Pi runner SDK boundary accounts for two offline provider rounds with an actual granted file read

删除：
- workflow arm does not abort progressing work at a legacy timeout
- failed tool turn retains current provider observations without rebilling an earlier turn

后续在以上文件删除仅供被删案例使用的 helper/import。保留案例内的重复变体另行按精确目标记录后缩减。

## 删除后辅助代码清理

- test/archived-m07-import.test.ts: import historicalM04EvidenceIndex
- test/archived-m07-import.test.ts: helper bundleForRejectedM04Transaction
- test/dashboard-server.test.ts: import symlink
- test/experiments/local-environment.test.ts: variable usage
- test/experiments/local-environment.test.ts: import UsageSummary
- test/improvement.test.ts: import evaluateCandidate
- test/improvement.test.ts: import collectProjectionHistory
- test/improvement.test.ts: import ImprovementProtocol
- test/research-dependencies.test.ts: import verifyRequiredExperience
- test/research-dependencies.test.ts: import verifyRequiredKnowledge
- test/research-improvement.test.ts: import mkdir, stat
- test/research-improvement.test.ts: import fullyReadDevelopmentFeedbackIds, validateResearchAction, ResearchInspectionResultV1
- test/research-improvement.test.ts: import publicResearchRun, publicResearchStatus
- test/research-improvement.test.ts: import runMetaImprovementAdmission
- test/research-improvement.test.ts: import buildMetaEpisode, loadMetaEpisode, metaEpisodePath, writeMetaEpisode
- test/source-candidate.test.ts: import cp
- test/source-candidate.test.ts: import pathToFileURL
- test/source-candidate.test.ts: import prepareWorkflowCodeSource
- test/source-candidate.test.ts: import GenerationStore, validateStrategy
- test/workflow-archive-csr-checker.test.ts: import CsrValidationError, getCsrValidationDiagnostic, validateCsrCandidateSource
- test/workflow-archive.test.ts: helper syntheticM04Export
- test/workflow-archive.test.ts: helper syntheticRecord
- test/workflow-archive.test.ts: import KnowledgeRecord, KnowledgeStore
- test/workflow-turn-budget.test.ts: import UsageEvent
- test/workflow-turn-budget.test.ts: variable deadlineLimits
- test/workflow-turn-budget.test.ts: helper deadlineRunner
- test/workflow-turn-budget.test.ts: variable deadlineSpec
- test/workflow-turn-budget.test.ts: import SessionHandle, SessionRunner
- test/workflow-turn-budget.test.ts: variable settledUsage

## 保留用例的重复参数精简

- archived-m07-import 的 mutatedCases 从 11 项保留 source byte mismatch 和 issued operation 两项；认证伪造和绑定失败的原直接断言仍保留。删除原目标/缺字段/状态形状的其他排列。
- workflow-source-search 的 pending 操作仅保留 evaluate-development，删除 ask-model/propose-source 两个相同持久化边界排列，随后去除单元素循环与无效分支。
- workflow-evidence-handoff 将 withdrawal 单元素循环改为直接用例，去除已删除 growth 路径的分支。
- workflow-archive-csr-checker 的 5 个实现×2 线程矩阵收窄至 serial、std_thread 和新增 strategy 各一次；编译、正确性与计时仍实际执行。移除已无人调用的 workerOverride 参数。

## test/private_actions_transport_test.py

CI 另有 Python 运输测试，一并按关键功能精简。保留输入解包、真实加密往返、分片完整性、错误接收方拒绝、余额查询及 CLI 凭据不外泄。删除旧 inline 兼容、同机制下不同诊断文件名、大小阈值排列、YAML 字面检查和历史 CI 翻页排列。下列删除可从 Git HEAD 提取原方法恢复。

- test_rejects_bad_base64_size_bomb_and_trailing_gzip
- test_legacy_inline_checkpoint_and_orphan_part_stay_readable
- test_assessor_diagnostics_roundtrip_only_under_exact_allowlisted_names
- test_provenance_import_evidence_roundtrips_without_canonical_promotion
- test_reviewer_text_cannot_exceed_archive_hard_limit_in_transport
- test_rejects_symlink_result_and_small_rsa_key
- test_small_provider_observation_is_sealed_in_campaign_result
- test_initial_probe_branch_creation_and_existing_tip_binding
- test_exact_source_ci_success_after_first_hundred_runs
- test_probe_workflow_has_no_custom_admission_quotas
- test_repository_workflows_require_explicit_manual_dispatch

参数精简：解包非法成员只保留相对越界、链接、重名三种真正不同的边界，并为每种提供完整三个成员，避免仅因文件数错误而通过；multipart 仅保留缺片和内容篡改；余额错误保留无效 JSON、网络错误、无密钥三种路径。

Python 往返测试进一步去除同一 allowlist 的文件名枚举：`test_roundtrip_and_allowlist` 保留源码、reviewer 全文、归档、M04 事务、状态、续跑 sidecar 与修复状态七类代表，以字节映射统一验证恢复内容。删除其余名称变体及逐文件重复断言。余额 verdict 保留真实加密往返与 metadata 篡改拒绝，去除手工重复解密算法、字段集合和格式/覆写/枚举值排列；算法行为由实际运输 API 验证。测试不再直接调用 RSA/AES 内部解密，删除对应导入。原内容可从 Git HEAD 恢复。

## 统一验证结果

全部修改后统一运行 Node 全套、Python 运输测试与 TypeScript 类型检查。Node 完整运行除 observer 测试导入清理误改外全部通过；该导入修正后补跑整份 observer 文件，7/7 通过，类型检查通过。最终保留 Node 317 项，其中 313 通过，4 项既有 Linux 专用案例在 macOS 跳过；Python 11/11 通过；`git diff --check` 通过。

相对上一批实际运行的 1168 项 Node 测试，本批删除 851 项（约 73%）；Python 从 22 项减至 11 项。没有通过改变测试入口、增加 skip 或缩小 glob 隐藏测试。本批只改测试及内部变更记录，运行中的任务、生产代码、知识库与公开说明均不在本批修改范围。
