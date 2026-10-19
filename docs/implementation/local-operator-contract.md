# 本地算子评测契约与宿主判据

`src/m07/local-operator-backend.ts` 加 `scripts/local-operator-stage.py` 组成一个具体的本地算子评测后端：
宿主用固定 argv 启动 Python 控制器，按 `contract → compile → correctness → measurement` 四级级联执行，
前一级不过就短路。候选只提交**一个 Python 模块**；题目、参考实现、允许的 API、容差、同步函数、具名 baseline
全部来自宿主选定的**任务契约**（`contractPath`），模型不能提名契约、命令或判据。

这篇文档写的是契约必须声明什么，以及宿主在每一级上独立判什么。所有阈值都写在
`scripts/local-operator-stage.py` 顶部的常量里，契约可以更严，不能更松。

## 1 契约必须声明的内容

`SPEC`：

| 字段 | 要求 |
|---|---|
| `protocolId` | 与后端 `protocolId` 一致，≤160 字符 |
| `kernelSymbol` | 候选模块里被 ghost replay 替换的函数名 |
| `allowedImports` | 候选允许 import 的模块白名单 |
| `apiTargets` | 允许调用、且能机械解析签名的环境 API |
| `forbiddenRuntimeTargets` | 候选要替代的库入口；运行时计数必须为 0（可以是空列表） |
| `cases` | 每个用例要有唯一 `id`、`input`、`scope`（`kernel` / `end-to-end`）、非空 `axes`（形状、dtype、边界类别等标量标签）；可选 `set`（`iteration` 默认 / `certification`）、`oracle`（`deterministic` / `matched-ratio`，后者需 `matchedRatio`）、`bitExact`（某个具名 baseline） |
| `decisionPolicy` | 可选，覆盖判定阈值；只能往更严的方向改（见第 7 节） |
| `tolerance` | `fixed` / `reference-repeat` / `reference-error` 三选一（见第 3 节） |
| `timing` | `warmup`、`repeats`、`minimumSampleSeconds` |
| `baselineTiers` | 为每个具名 baseline 标 `naive` / `expert` / `library` / `compiler` |
| `measurementEnvironment` | `environmentId`、`clockPolicy`、`precision`、`cacheState`（`cold` / `warm`） |
| `workerTimeoutSeconds`、`workerOutputBytes` | 每个 worker 的执行与输出上限 |

模块级函数：`reference`、`invoke`、`synchronize`、`noop` 必需；`baselines` 是具名真实可调用实现的字典；
可选 `prepare`、`normalize`、`golden`、`compile_candidate` + `bind_compiled`、`validate_parameters`、
`classify_candidate_call`、`verify_goal`。

宿主在加载契约时直接拒绝的几类声明：

- `timing.warmup < 10` 或 `timing.repeats < 30`：计时协议下限是冻结的。
- `timing.minimumSampleSeconds < 1e-4`：比这更短的工作量分不出候选优劣。
- 迭代集里没有任何 `scope: "end-to-end"` 的用例：隔离的 kernel 计时不能单独接受一个候选。
- 没有任何 `set: "certification"` 的用例：候选迭代用的集合不能同时用来认证它。
- 全部用例只覆盖一种 `axes` 组合。
- `baselineTiers` 与 `baselines` 不同名，或所有 baseline 同一个 tier：每个加速比要有两个分母。
- `measurementEnvironment` 不完整。

## 2 宿主对候选做的独立检查

**contract 级（静态）**：导入白名单、禁用能力（`eval`/`exec`/`open`/反射/属性改写等）、API 签名必须能
`signature.bind`；解析不了的调用进 `unresolvedCalls`，该级判 inconclusive（fail closed），不会继续往下走。
契约可以用 `classify_candidate_call` 放行自己认得的调用形状，但放行结果仍要靠隔离执行验证。

**compile 级**：Python 字节码编译；契约若提供 `compile_candidate`，宿主在独立 worker 里跑它的真实编译器，
冻结产物，后续阶段只绑定这些冻结产物，不重新编译、不回落 Python。

**correctness 级**，对每个用例：

1. **隐藏变体**：宿主派生四个「只改数值、不改形状」的变体——原值、×3、×0.01、×(−1)。整数、布尔与精确零
   保持不变，所以三角/稀疏结构不会被破坏。
2. **有效性门禁**：参考实现求不出值的变体直接丢弃（不算候选的错）。派生变体若让任何一个已知正确的具名
   baseline 失败，说明是输入本身有缺陷，也丢弃；baseline 不可用时只记录不丢弃。声明用例本身不走这道门，
   baseline 的正确性由 measurement 级判。
3. **容差校准与空洞自查**：见第 3 节。
4. **确定性**：候选在每个接受的变体上连跑三次，输出必须逐位相同。
5. **ghost replay**：把 `kernelSymbol` 换成契约的 `noop` 重放；所有接受变体都察觉不到替换的用例标为
   `degenerate`，记录在案但不计入「这个套件能分辨真假实现」的统计。全套件没有一个非退化用例就不能报成功。
   no-op 本身崩溃记为未完成检查，永远不算通过。
6. **运行时插桩**：在独立进程里给 `forbiddenRuntimeTargets` 装调用计数器，计数不为 0 即失败。
7. **逐位对拍**：用例声明了 `bitExact` 时，候选的归一化输出必须与那条被声明等价的 baseline 路径逐位相同。
   容差挡不住两条本应等价的实现之间的真实分歧。

**measurement 级**：见第 4 节。

## 3 容差

三种模式，口径不同，不要混用：

- `fixed`：契约直接给 `atol`/`rtol`。
- `reference-repeat`：跑 `repeats` 次真实参考实现，取误差的 `max + sigmaMultiplier·σ` 作该用例的 `atol`。
- `reference-error`：另有一个独立的 `golden` 函数，expected 取 golden 输出，并对每个候选记录
  `ρ = 候选误差 / 参考误差`，`ρ > 10` 判错。被拒与被接受的候选**都**记 ρ。

无论哪种模式，宿主都会算 `mean(|参考输出|) / atol`。比值小于 10 且 `rtol = 0` 时，这个检查点分不开
「真实现」和「返回零」，该变体判为不可裁决并丢弃——这是「返回全零也能通过」的直接堵口。

判据是析取的：`|a−b| > atol + rtol·|b|` 即失败。失败时的 witness 给位置、类别、绝对/相对误差、
不匹配元素比例、按列表深度的错误 bounding box，条目超过 32 条就截断并记省略数；**不回传参考值与候选值**，
写 kernel 的上下文不应该学到测试输出。

## 4 计时与性能判定

- 执行形态是 `interleaved-persistent-v2`：候选与每个 baseline 各有一个常驻独立进程，import、native 绑定
  与 warmup 全部在第一个样本之前完成；之后逐轮交错取样，轮与轮之间颠倒角色顺序，控制器不计自己的管道时间。
- 每个 baseline 独立给出判定：门槛 `1 + max(0.002, 0.85·cv)` 随配对比值的离散度自适应，比值落在门槛带内
  报 `tie` 而不是「更快」。
- **异常加速护栏**：配对比值 ≤ 1/3（≥3× 加速）触发一次同协议复测，两次中位数相差超过 10% 即不可比；
  比值 ≤ 0.1（≥10×）直接熔断为 `quarantined`，需要线下复核。
- **端到端门**：`scope: "end-to-end"` 的用例上要求配对比值 ≤ 1.03，过不了整次测量不可比——子 kernel 变快
  不能换来端到端回归。
- **最小可测时长**：候选或任一 baseline 的中位数低于 `minimumSampleSeconds` 的用例不参与取舍，宿主在
  limitations 里逐个点名。
- 收据里还有逐轮 Kendall τ_b 与成对翻转率，以及按 baseline 的聚合：成功率、仅成功样本几何平均、
  全集几何平均与中位数。比值一律不用算术平均。

## 5 收据与反馈的边界

收据是 input-blind 的：只有 `caseSummaries`（id / scope / axes / oracle），没有用例输入，也没有参考输出。
需要具体输入的宿主动作（例如 NCU 采集）通过 `--case-input` 子命令让契约自己写一次性文件，用完即删，
不留作收据。

每个被 verifier 产生的 metric 的 `basisId` 里带着后端身份、协议、subject、用例与**声明的 environmentId**，
所以不同环境、不同精度策略的数字不会被当成同一基准排序。只有宿主判为可裁决的用例才产生 metric。

limitations 里固定会出现：运行环境与精度策略、baseline tier、隐藏变体口径、integrity 计数（含
「只做数值比较会不会通过」和「加上功能检查会不会通过」两个分数，二者之差就是这一次运行的作弊信号）、
不可比的原因、被排除的用例。

## 6 认证集、题目审计与检查器打分

三个**宿主自己发起**的入口，都不在候选的级联里，也都不产生候选可读的收据：

- `certifyCandidate(sourcePath)`（`--certify`）：对一个已接受的候选跑**全集**（迭代集 + 认证集），
  给出逐用例结果与**条件正确率**——分母是「这个用例本身可裁决」的用例数，不是全部用例。只做正确性，
  不重新计时，不给性能结论。认证集对候选全程不可见：不进 `caseSummaries`，不进 `--case-input`。
- `auditChecks()`（`--mutation-report`）：把契约声明的 `MUTANTS`（`{family, source}`，family 取
  arithmetic / precision / synchronization / boundary / control）逐个送进同一套检查，报总检出率**与逐族
  逃逸率**。各族漏检率在公开实测里相差一个数量级，只报一个总数等于把最该看的那一族藏起来。
- 同一份报告里的 `taskAudit` 先判**题目**：逐用例算参考输出的取值范围、标准差、平均量级、对输入是否敏感，
  以及（契约提供 `golden` 时）参考与高精度金标准的不一致元素数，按三条规则列出退化用例。

## 7 阈值：默认值来自公开实测，任务只能收紧

`SPEC.decisionPolicy` 可以覆盖这九个值：`determinismRepeats`、`toleranceMagnitudeRatio`、
`referenceErrorRatioLimit`、`minimumImprovementFloor`、`minimumImprovementDispersionFactor`、
`endToEndNoiseMargin`、`confirmRatio`、`confirmAgreement`、`quarantineRatio`。默认值就是依据里的公开数字；
脚本里的 `TIGHTER` 表写明每个阈值哪个方向算更严，**往松的方向改直接拒绝**，有效值写进收据。
需要为某块真实硬件重新标定某个默认值时，改的是那张表（走评审），不是某个任务自己的配置。

## 8 静态门禁与评估缓存

宿主可以再绑两样东西。两者都是宿主配置，模型都碰不到。

**知识卡片门禁（`knowledgeCardsPath`）**：contract 阶段在调用 Python 之前跑 `checkCandidate`，
命中已发布签名表之外的同命名空间调用就地驳回，findings 带 witness 与最接近的合法签名，级联短路，
不启编译器也不碰设备。`inconclusive` 只记录不阻断。

**评估缓存（`evaluationCacheDir`）**：键是候选 AST 规范化后的哈希 + 契约摘要 + 平台 chip/toolchain +
协议版本 + 用例集 id + 后端身份 + 阶段 id。命中就把历史回执整棵拷回本次目录，summary 标明是 replay，
**不得当成第二次独立测量**。`evaluationProfile()` 给出本地驳回数、最接近签名命中率、缓存命中/未命中、
以及「真正执行掉的墙钟」与「replay 顶掉的墙钟」。设备租约只包住 measurement 阶段。

## 9 这套机制没有解决的事

- 不是操作系统沙箱：worker 的写隔离在 macOS 用 `sandbox-exec`，其他平台必须由宿主提供真实隔离前缀，
  没有无隔离兜底；但同 UID 的进程边界不等于强隔离。
- 不证明「自定义 kernel 占设备时间的比例」。ghost replay 与被替换库调用计数只能证明声明的 kernel 被真正
  执行、被替换的库入口没有被调用；设备时间占比需要真实 profiler，当前没有设备可测。
- 计时环境的独占性、锁频、L2 flush 由契约声明，宿主只记录不验证。
- 失败时收据里保留 traceback，其中可能出现契约自身的源码行。收据不再携带契约全文（只带
  `contractSha256`），但 traceback 这条窄缝是留给可定位性的，契约作者应避免在被候选触发的路径上打印输入。
