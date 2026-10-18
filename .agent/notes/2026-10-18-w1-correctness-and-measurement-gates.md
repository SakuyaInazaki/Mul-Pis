# 2026-10-18 W1：本地算子评测的正确性判据与计时方法学重建

## 为什么

对照调研依据（RB-A3 正确性与防作弊 29 条、RB-A4 计时与 profiling 15 条，以及未合并的 G 条目）逐条核对
`scripts/local-operator-stage.py` 与 `src/m07/local-operator-backend.ts` 后，确认以下几类问题会直接让
「正确」和「更快」两个结论都站不住：

1. **测试输入对候选可见**。收据里逐用例写入完整 `descriptor`，并整体写入 `caseDescriptors`；失败时这段
   JSON 原样进入给模型的诊断。依据里 input-blind 是「利用 harness 结构而非输入域作弊」的唯一结构性对策。
2. **容差可能根本分不开对错**。固定模式允许任务直接写一个相对输出量级过大的 `atol`，返回全零也能通过。
3. **退化用例没有剔除**。no-op 替换只要求整个套件里「至少一个用例」察觉，其余用例可以永远无信号。
4. **没有确定性检查**。候选在正确性阶段只跑一次，累加顺序改写一类的改动一次比对就放行。
5. **计时协议没有下限**，`warmup=0, repeats=1` 合法；没有最小可测时长；没有异常加速熔断；没有端到端门；
   没有方差自适应的最小改进门槛，配对比值的中位数被直接当成可排序的指标交给上层。
6. **基线只有一个分母**，精度策略、时钟策略、运行环境都不记录，数字可以被跨环境引用。
7. **profiler 指标已做白名单筛选，但没有确定性解读层**：没有瓶颈分类标签、没有 roofline 饱和阈值、
   没有 headroom，也没有注入体积上限。

## 改了什么

### `scripts/local-operator-stage.py`

- **冻结协议常量**集中在文件头部（warmup ≥ 10、repeats ≥ 30、最小可测时长 ≥ 1e-4 s、确定性重复 3 次、
  容差量级比 10、最小改进门槛 `1+max(0.002, 0.85·cv)`、端到端噪声余量 1.03、复测触发 3×、复测一致带 10%、
  熔断 10×、witness 条目上限 32）。契约可以更严，不能更松。
- **契约声明要求**：每个用例必须声明 `scope`（kernel / end-to-end）与非空 `axes` 覆盖轴标签；至少一个
  end-to-end 用例；至少两种不同轴组合；每个具名 baseline 必须声明 tier，且至少两种 tier；必须声明
  `measurementEnvironment`（environmentId / clockPolicy / precision / cacheState）与 `forbiddenRuntimeTargets`。
- **隐藏变体与有效性门禁**：宿主对每个用例派生四个「只改数值、不改形状」的变体（原值 / ×3 / ×0.01 / ×−1），
  整数、布尔与精确零保持不变。参考实现无法求值的变体被丢弃；派生变体若让任何一个已知正确的具名 baseline
  失败，判为输入缺陷并丢弃（baseline 不可用时只记录，不丢弃变体）。声明用例本身不走这道门。
- **容差空洞自查**：每次校准都算 `mean(|ref|)/atol`，比值 <10 且 rtol=0 时该变体不可裁决。
- **确定性**：候选在每个接受的变体上连跑 3 次，输出必须逐位相同。
- **逐用例 no-op 敏感性**：每个变体都做 ghost replay；全部变体都察觉不到替换的用例标为 `degenerate`，
  不计入「这个套件能判对错」的统计；no-op 本身崩溃记为未完成检查（inconclusive），永远不算通过。
- **运行时插桩**：按 `forbiddenRuntimeTargets` 在独立进程里给被替换的库入口装调用计数器，计数不为 0 即失败。
- **分级 oracle**：用例可声明 `matched-ratio`（低精度算子按匹配比例判），采样类 oracle 显式不支持而不是
  用逐元素比较误判。
- **ρ ≤ 10**：`reference-error` 模式下对每个候选记录候选误差与参考误差之比，拒绝与接受两侧都埋点。
- **witness**：`compare()` 现在给出不匹配元素比例、按列表深度的错误 bounding box、错误条目上限与省略计数，
  并且**不再回传参考值与候选值**（只给位置、类别与误差量级）。
- **计时判定**：逐 baseline 给出 `faster / tie / slower / quarantined`，门槛随配对比值的 cv 自适应；
  比值 ≤1/3（≥3× 加速）强制同协议复测，两次中位数相差超过 10% 即不可比；比值 ≤0.1（≥10×）直接熔断。
- **端到端门**：end-to-end 用例上要求配对比值 ≤1.03，否则整次测量不可比。
- **最小可测时长**：任何一方中位数低于声明下限的用例不参与候选取舍。
- **排序稳定性与聚合**：逐轮 Kendall τ_b 与成对翻转率；聚合同时给出成功率、仅成功样本几何平均、
  全集几何平均与中位数（比值一律不用算术平均）。
- **收据 input-blind**：`descriptor` 与 `caseDescriptors` 全部移除，改为 `caseSummaries`（id / scope / axes /
  oracle）。新增 `--case-input` 子命令，让契约自己把 profiling 需要的用例输入写进一次性文件。
- `correctness()` 拆成 `calibrate` / `check_case` / `measure_case` / `paired_decision` / `ordering_stability` /
  `aggregate` / 两个 verdict 函数，不再是一个大循环。

### `src/m07/local-operator-backend.ts`

- 声明的 `environmentId` 进入每个 metric 的 basis，跨环境的数字不会再被当成同一基准。
- 只有宿主判为 `performanceDecidable` 的用例才产生 metric；不可裁决、熔断、复测不一致的用例一个数字都不给。
- profiling 不再从收据里取用例描述，也不再把 worker 输入文件留作收据（用完即删）。
- limitations 里逐条给出：运行环境与精度策略、baseline tier、隐藏变体口径、integrity 计数
  （含「只做数值比较会不会通过」与「加上功能检查会不会通过」两个分数）、不可比原因、被排除的用例。

### `src/m07/profile-bottleneck.ts`（新）+ `candidate-diagnostics.ts`（两行调用）

- 固定阈值的瓶颈分类（compute / bandwidth / latency / unclassified），roofline 饱和阈值 0.70、
  headroom 倍数、未被规则解读的计数器单独列出，渲染摘要有 1 KB 硬上限。两个计数器不全时只说 unclassified，
  不编标签。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：0 错误。
- 全量测试：见下方提交记录；新增/改写的用例集中在 `test/m07-local-operator-backend.test.ts` 与
  `test/m07-profile-bottleneck.test.ts`，覆盖协议下限拒绝、容差空洞、确定性、被替换库调用、
  退化用例、隐藏变体丢弃、input-blind 收据、端到端门、聚合与排序稳定性字段。

## 口径变化（会破坏历史工作区格式）

- 历史收据里的 `cases[i].descriptor`、`caseDescriptors`、`cases[i].noop`、`cases[i].comparisons`
  在新格式下分别变成（移除）、`caseSummaries`、`cases[i].variants[j].noop`、`cases[i].variants[j].comparisons`。
  measurement 阶段的 `cases[i].comparisons` 仍在原位。
- 旧的任务契约会被新的 `validate()` 拒绝，必须补齐 scope / axes / baselineTiers / measurementEnvironment /
  forbiddenRuntimeTargets / timing 下限这几项。

## 第二批（合并 W5 交回的三项）

W5 在它那一轮里把三件事判给了本环节的文件，一并做掉：

### 阈值可配置但只能收紧

`SPEC.decisionPolicy` 可以覆盖九个判定阈值（确定性重复次数、容差量级比、ρ 上限、最小改进下限与方差系数、
端到端噪声余量、复测触发比、复测一致带、熔断比）。每个阈值的默认值就是依据里的公开数字，`TIGHTER` 表写明
哪个方向算更严；**往松的方向改直接拒绝**。有效值写进收据的 `decisionPolicy`。需要为真实硬件重新标定某个
默认值时，改的是这张表（要走评审），不是某个任务自己的配置。

### 迭代集与认证集分开

用例可以声明 `set: "iteration" | "certification"`，契约必须至少保留一个认证用例。候选的四级级联只跑迭代集，
`caseSummaries` 也只列迭代集，profiling 的 `--case-input` 只接受迭代集用例——认证用例不出现在候选能读到的
任何收据里。新增 `--certify` 子命令与宿主入口 `certifyCandidate(sourcePath)`：对一个**已接受**的候选跑全集，
给出逐用例结果与**条件正确率**（以「这个用例本身可裁决」为条件），只做正确性，不重新计时、不给性能结论。

顺带修掉一个比用例描述更大的泄漏：收据原先整份带着 `contractSource`（契约全文，里面有全部声明输入、参考
实现和认证集）。改成 `contractSha256`，绑定关系不变，内容不再随收据走。

### 逐位对拍

用例可声明 `bitExact: "<baseline 名>"`：候选的归一化输出必须与那条被声明等价的路径**逐位相同**，
容差挡不住两条本应等价的实现之间的真实分歧。

### 检查器的变异打分按故障族报

`MUTANTS` 从「名字 → 源码」改成「名字 → {family, source}」，family 取 arithmetic / precision /
synchronization / boundary / control。报告里除了总检出率，还逐族给出 `escapeRate`——依据里各族漏检率相差
一个数量级（算术 8.7% / 边界 22.9% / 同步 27.8% / 精度 78.6%），只报一个总数等于把最该看的那一族藏起来。

同一份报告里加了 `taskAudit`：对**题目本身**逐用例算参考输出的取值范围、标准差、平均量级、对输入是否敏感，
以及（契约提供 `golden` 时）参考与高精度金标准的不一致元素数，按三条规则列出退化用例。这是在判任何候选之前
先判题。

### 诊断的分层三问

`describeProfileBottleneck` 的输出改成固定的「What / Where / Why（/ Headroom）」顺序，仍然是 1 KB 硬上限，
且上限在**生成侧**而不是展示侧。

## 第二批验证

- 类型检查 0 错误。
- `test/m07-local-operator-backend.test.ts` 15 项全过，新增：协议与声明不可协商（含 bitExact、认证集必填）、
  阈值只能收紧、认证集不出现在任何候选可读收据里且条件正确率可算、逐位对拍能拒掉容差内但位不同的候选、
  变异打分按族、题目审计点名自己的退化用例。

## 第三批：评测 worker 断网

`createMacOSWriteSandboxProfile` 增加可选的 `denyNetwork`，本地算子的三个入口（stage 执行、goal 验证、
宿主侧 audit/certify）都打开它。候选侧本来就过不了 import 白名单，但契约自己的代码、原生编译产物或
vendored 模块都在同一个 worker 里；依据要求评测面断网，这一条成本为零。测试用受信任的契约代码主动发起
连接，并断言拿到的是 `PermissionError`（沙箱拒绝）而不是 `ConnectionRefusedError`（端口本来就关着），
否则这个测试会永远「通过」而什么都没验证。
