# 2026-10-18 W1（第二轮）：平台档案绑定评测契约、静态门禁强制化、评估缓存

合并后才能做的三件对接，对应 issue W4-06、W3-05、W4-05。

## 为什么

- **W4-06**：`src/platform/profile.ts` 已经把计时协议、按尾数位推导的精度表和四轴用例表收成带版本的探测事实，
  但评测侧完全没用到：warmup/repeats/容差/用例仍由任务契约自由给出。两个延迟数字可能来自两个协议却被直接比较，
  一个全局绝对容差会放过退化实现，单 shape 用例集放过 shape 型 bug。
- **W3-05**：`src/knowledge/static-checks.ts` 的签名表与硬约束检查已经存在，执行会话也有
  `knowledge_contract_check` 工具，但那是「可以调用」。依据给的收益来自把它放进链路里强制执行——
  幻觉 API 的本地驳回是零设备成本，而昇腾上过半失败是签名与重载问题。
- **W4-05**：全仓没有任何评估缓存。成本几乎全在评估器上（import+编译约 81%、正确性 10%、计时 8.5%），
  同一份候选换个会话就要重测一遍。

## 改了什么

### 平台档案 → 评测契约（新模块 `src/m07/platform-task-contract.ts`）

- `derivePlatformTaskBinding(profile, {dtype, publicCases})` 产出宿主绑定：协议版本、warmup/repeats/最小可测时长、
  延迟口径与指标口径（两者必须是不同的 pass，否则拒绝绑定）、按尾数位推导的 τ_d、四轴用例表（逐条算对齐与否）、
  迭代集/认证集切分、瓶颈标签清单。档案缺 timing / precision / cases 任一项就拒绝绑定，不回落到任务自己写的数字。
- 档案的协议若低于评测器冻结的 warmup≥10 / repeats≥30 下限，绑定直接拒绝并说明「重新探测协议，而不是降低下限」。
  两个下限在 TS 侧镜像了一份，测试逐个从 `scripts/local-operator-stage.py` 里读回来比对，防止两边漂移。
- 后端新增 `platformProfilePath` / `platformDtype` / `platformPublicCases`。绑定会：
  - 进入**每个 metric 的 basis**（`protocolId@protocolVersion`），两个协议版本的数字不可能落进同一张表；
  - 随 worker-options 传给控制器**和每个 worker**（worker 也要用同一份绑定校验同一份契约）；
  - 写进收据的 `platformBinding`，verifier 在协议版本不一致时直接判 `unknown`。
- `validate()` 在有绑定时强制：`SPEC.timing` 等于绑定、`minimumSampleSeconds` 不低于平台最小运行时长、
  用例 id 与顺序等于平台用例表、迭代/认证归属一致，并且**每个用例声明输入的数值叶子数等于用例表的 elements**
  —— 否则「同一个用例名」测的是另一个规模。
- 新容差模式 `platform-three-region`：首筛 `mean(e) < τ_d` 且 `max(e) < 10·τ_d`；没过的逐元素按参考值落在
  正常区 / 小值区 / 相消区分类，正常区有错直接判错，另两区改成与同精度 golden 的错误计数比（≤2）。
  三区边界与比值 2 没有校准依据，收据里原样带着这两个常数，便于之后拿真机数据校准。
  NaN/Inf 不会出现在这条路径上：`finite_tree` 在更早的地方就拒绝了非有限输出。
- 失败文本用 `diagnosePlatformOutput` 按冷启动三类（语法/硬件/数值）+ 基础设施分类并计数，
  被拒的符号附上探测到的最接近合法签名。
- `profile-bottleneck.ts` 在有档案时改用档案自己的 `classifyBottleneck` 标签与动作清单
  （阈值是那块芯片上探测出来的），摘要里多一行「这块平台给这个标签的动作类，按顺序」。

### 契约静态检查成为强制门（`knowledgeCardsPath`）

- 宿主冻结一份已发布卡片（构造时解析，运行中不会漂移）。contract 阶段在**调用 Python 之前**跑
  `checkCandidate`：`reject` 就地写一份 `evaluation.json`（含 findings、witness 与最接近签名）并判本阶段失败，
  级联就此短路——不启编译器、不碰设备。`inconclusive` 只记录不阻断。
- 计两个数：本地驳回次数与「最接近签名」命中率，连同缓存统计一起由新入口 `evaluationProfile()` 给出。
- 决策表（每轮允许方法集）属候选搜索，仍在 W2 的文件里；本轮只把平台瓶颈标签与动作清单送到解读层，
  让「哪个指标值 + 哪条条目」可追。

### 评估缓存与流水重叠（新模块 `src/m07/evaluation-cache.ts`）

- 键＝候选**AST 规范化**后的哈希（新增 `--normalize-source`，注释与排版不改变键）＋契约摘要＋
  平台 chip/toolchain＋协议版本＋用例集 id＋后端身份＋阶段 id。测试逐个字段验证它们都参与键。
- 命中就把历史回执整棵拷回本次 outputDir（含嵌套 worker 日志），summary 标明「replayed from an identical
  evaluation」；只有整棵都在本阶段目录内才入库，避免半份条目replay 出缺证据的阶段。
- 统计分开记「真正执行掉的墙钟」与「replay 顶掉的墙钟」，所以一次运行能回答设备时间花在哪、省掉多少。
- 设备租约（`src/platform/device-lease.ts`）只包住 measurement 阶段：import、编译与正确性不该占着设备，
  这正是「只串行化计时段」。

## 验证

- 类型检查 0 错误。
- 新增 `test/m07-platform-task-contract.test.ts`（4 项）、`test/m07-evaluation-cache.test.ts`（4 项），
  `test/m07-local-operator-backend.test.ts` 新增 3 项（静态门禁在编译前驳回、同一候选被 replay 而不重测、
  平台绑定决定协议/容差/用例表并拒绝不一致的契约），该文件 19 项全过。
- 全量测试见提交记录。

## 口径变化

- 绑定了平台档案的任务契约，其 SPEC 的 timing / cases / 元素数必须与档案一致，旧契约需要按档案改写。
- `platform-three-region` 要求契约提供同精度 `golden`。
- 收据新增 `platformBinding`；缓存 replay 的阶段 summary 带标记，不能当成第二次独立测量。
