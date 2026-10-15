# 算子工作流的经验交接与测试精简

用户要求重新判断实现充分性，并实质清理重复、过时和仅验证内部实现写法的测试。所有修改完成后统一运行类型检查与测试；不在修改之间启动回归。改动理由直接在对话交付，不新增公开说明。

源码修复：src/knowledge/experience-index.ts 的显式经验包仍只显示正文和关系，遗漏 fields 中的完整条件及元数据；补入完整原字段，沿用已有字符预算和采用路径。移除本批经验发现入口自加的 tags/contextRefs 100 项数量限制，保留原格式检查；条件校验路径原本支持不受记录数量限制的 verificationOnly。

静态复核另发现同一裸 scope 的多个 contextRefs 会导致依赖清单失真：访问路径仅检查首个匹配版本，输出路径却列出所有匹配版本，包含可能不存在的版本。让既有 records 集合同时保存实际核验的 dependencyRefs，返回时直接复用，删除第二次筛选。现有版本情境测试补充“可用版本加未发布版本”的断言，不扩建测试矩阵。

## 删除前记录

以下均为 Git 已跟踪的测试用例，可从当前 HEAD 按文件恢复。仅删除列出的测试块，不移动到不执行的目录、不改测试入口、不增加 skip。原实验记录、知识库、生产源码不在删除范围。

### test/improvement.test.ts

Retain paired admission, incorrect-result rejection, duplicate-to-valid continuation, history reading, version freezing, locks and promotion recovery. Remove parallel legacy quota/schema/no-input variants and duplicate stop cases.

- run requires an explicit experimental plan and does not call a model
- a historical total-cost field cannot stop a paired mechanism experiment
- missing proposer cost stays unknown in ledger without blocking priced paired evidence
- mechanism readback can exceed a legacy cumulative limit while retaining material bounds
- mechanism case-set file still respects its byte-size boundary
- legacy active version exports with downgraded provenance
- residual mutation lock fails closed
- no observed text projection exits without calling the proposer
- zero trigger stays inconclusive while a legacy trial-call quota cannot block admission
- duplicate candidate is feedback before the model explicitly stops
- improver can explicitly stop without a monetary or count gate
- long valid hypothesis and stop reason are preserved without response-text caps
- a progressing proposer is not aborted by a legacy elapsed-time quota
- one admission repetition is insufficient and starts no proposer
- unreplayed prompt and feedback caps cannot win by shrinking
- policy schema and active pointer reject unknown fields and traversal
- past candidate is blocked only under the same frozen obligation

### test/research-improvement.test.ts

Keep executable H/I admission, development isolation, multi-case inspection, reuse and invalid-response recovery. Remove obsolete field enumeration, documentation-text coupling and validation-only duplicates.

- research plans reject obsolete per-request token fields
- legacy method output quota is omitted from active research plan
- research plans retain legacy cost references for display and accept no monetary input
- documented H plan reaches a complete fake model request with its frozen seed
- controller rejects a candidate that cites non-visible development evidence
- generation validation keeps pinned identities and ancestry without count gates

### test/workflow-archive.test.ts

Keep actual source/receipt round trips, complete reviewer feedback, credential redaction, adopted and negative knowledge, one missing-reference failure and current incomplete-operation records. Remove synthetic export-error permutations, repeated count-limit cases and retired monetary-stop archives.

- private archive retains ten actual reviewed rounds without a count ceiling
- private M07 archive records missing lesson rather than inventing adoption
- review text beyond the private archive hard limit fails visibly instead of reporting a normal exclusion
- private M04 export retains more than 48 dependencies and all adopted experience refs
- private M04 export keeps ref and edge when a dependency read throws
- private M04 export never echoes hostile extra ref fields and its repaired payload reads
- private M04 export distinguishes dependency cycle from missing and unsafe records
- private M04 export distinguishes malformed experience, unsafe content and physical bytes
- private M04 export identifies malformed and unpublished edges and unavailable condition checks
- private M04 export accepts over 100 refs and over 64 scopes within its physical byte bound
- private archive retains a controller-certified partial-settled budget stop distinctly from an unknown operation
- private archive distinguishes host-proven zero-request not-issued from a partial-settled prompt

### test/workflow-turn-budget.test.ts

Retain a progressing real wrapper, failed-turn accounting and the real Pi SDK file-read boundary. Remove alternate quota/unit accounting permutations and wording-only contract inspection.

- workflow arm accepts settled usage beyond a legacy wall quota
- workflow turn continues with complete provider events and unknown price
- bounded I request ignores legacy elapsed-time quotas
- tool-turn ledger retains missing usage but permits subsequent accounted turns
- workflow I sends its own flat-action contract through the Pi SDK boundary

### test/experiments/local-environment.test.ts

Keep scientific probe/submit/unknown behavior, frozen fork state and persistence failures. Unit-only health enumeration, input-size variants and old accounting quotas duplicate retained execution and SDK tests.

- CPU health calibration executes positive, negative, ambiguous, reset and per-case resource branches
- runtime case validation strips extra private fields from public hypotheses
- oversized model action is rejected before persistence
- shared root and child budget retain unknown usage without stopping later work
- multiple reported rounds charge cached input and reasoning output once at root and child
- cost-only live status strips all legacy quotas while retaining actual unlimited usage
- caller-selected case counts and probe allowances have no fixed workflow count ceiling

### test/experiments/review-regressions.test.ts

Keep scientific identifiability, closed/in-flight leases and actual paired meta admission. Remove repeated old elapsed/cost/token quota and prompt-length permutations already exercised by remaining runtime paths.

- branch activation and pilot pause remain lifecycle controls without elapsed-time quotas
- prepared request uses actual prompt bytes without a per-request token quota
- unknown SDK cost alone remains visible and does not stop the next model action
- an uncapped reply is recorded without enforcing a legacy aggregate output quota
- CPU executor accepts a valid action after a long provider reply
- phase preflight creates separate accounting namespaces without monetary gates
- historical phase and root monetary values do not gate a campaign

## 交接与独立检查测试的删除前记录

以下均为已跟踪用例，可从 HEAD 恢复。仍保留对应完整行为验证，不改变 test 入口或 skip。

### test/workflow-evidence-handoff.test.ts

Keep fresh paired M07/M04 execution, version isolation, actual selected-experience use, partial second-arm failure and protected-data separation. Remove overlapping validator, legacy quota, duplicate model-drift/first-arm and copy-layout cases.

- workflow plan accepts omitted monetary references
- builtin comparison accepts ordinary prompt text matching a short proposal-seed H body
- workflow A/A rejects frozen research model drift before a provider request
- workflow A/A stops after an incomplete first arm and persists its partial pair
- workflow I can repeatedly inspect past the old cumulative readback limit
- workflow promotion is not blocked by a legacy wall-time quota after G
- workflow I experience plan requires exact pinned refs and positive bounds
- ordinary M07 begin and delegation do not call I or change the active H
- workflow adapter rejects an overlapping experiment root before model calls
- isolated workflow copy accepts a plain tree deeper than twelve directories
- problem/config symlinks cannot seed an isolated workflow arm

### test/workflow-archive-csr-checker.test.ts

Retain actual compiled checks, correctness failure, input mutation, immutable baseline and runtime thread cap. Remove repeated single-selector/count cases, spelling/metadata checks and redundant lexical/schema permutations.

- checker derives bounded registry and model-authored cases
- single-strategy timing selection emits one host record after validation
- checker covers every permitted registered strategy through the task maximum
- capability inspection is input-derived and does not create a research plan
- bounded schema rejects extra fields, sparse arrays, invalid scalars and excessive work
- legacy lexical guard supplements its unchanged structural boundary
- truncated raw output cannot pass parent-side comparison
- forbidden token and immutable-region diagnostics retain source locations

### test/incremental-private-checkpoint.test.ts

Keep encrypted round-trip, authentication, invalid-write atomicity, sink failure, session/goal association and representative state progress. Remove exact historical payload sizes, memory-heavy bound variants and diagnostic-stage enumeration covered by whole-prefix behavior.

- incremental prefix preserves the exact run43-size objective checkpoint
- incremental prefix rejects an objective checkpoint beyond the logical carry bound
- incremental prefix keeps the 64 MiB physical file bound for an allowed objective
- private diagnostic stages distinguish source, envelope, decoded schema and physical bounds
- stale next census cannot erase an earlier reserved request

测试参数精简：incremental-private-checkpoint 的状态退回表从 8 种改为操作、任务和目标三个独立层各一个代表；删除同一层的 retired partial/terminal/confirmed/not-issued 变体以及 accepted/rejected 同义回退。已有 UNKNOWN 对账进展用例保留。原表可从 HEAD 恢复。

### test/source-candidate.test.ts

删除 `empty, null, array, and missing hypothesis fields remain rejected`：同一字段无效值的五种排列重复创建候选仓库，已有完整候选执行用例覆盖缺失 hypothesis 字段、修正失败及候选不提交。保留结构化 hypothesis 原字段完整性和实际取消/工程检查行为。该测试可从 HEAD 恢复。

## 统一验收

全部源码与测试精简完成后，统一执行一次类型检查和完整离线测试，未在逐处修改之间运行回归。

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：通过。
- `node --test --test-concurrency=1 'test/**/*.test.ts'`：1,168 项，1,155 通过，0 失败，13 跳过，耗时 347.29 秒。现有跳过涉及 Linux 专用进程/编译检查与本地 PDF 资料；没有新增 skip。
- 上次完整运行统计为 1,663 项，本次减少 495 项（含参数生成的独立子案例）。测试入口与全量 glob 保持不变。
- 当前相对 HEAD 的 test diff 涉及 61 个文件，342 行增加、10,278 行删除，净减少 9,936 行；该差异同时含此前尚未提交的必要修复断言。
- `git diff --check` 通过；删除后未发现新增的未使用顶层 helper 或导入。

完整执行日志保留在本地审计目录的 `operator-test-simplification-full-tests-20261015.log`。本批未提交或推送，原算子实验与知识库未启动或变更。
