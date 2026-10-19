# W2：确定性停滞检测、强制换向与三级回退路线

## 为什么

依据 RB-A2-11 / RB-A5-19：停滞必须由代码判定而不是模型自述，触发后强制换方向，并把被否方向写成禁令。
实测里失败任务中 85%–99% 会触发四个信号之一，而实现成本只有两个哈希加两个计数器。
依据 RB-A2-12 / RB-A1-15：修复不能无界，按「调试 ≤3 → 同一计划下重写 ≤5 → 回到规划」三级回退，
并按失败类型路由回不同层级，而不是统一重试。依据 RB-A2-09：近似正确的候选应进修复专线而不是丢弃重生成
（Debug Pass@1 66.7% vs 重生成 40.7%，每成功 token 省 92.8%）。依据 RB-A5-09：父代应来自逐例前沿与工作点，
不是永远的全局 top-1。

改之前，`candidate-episode.ts` 只把 duplicate_code / code_cycle 当事实展示，没有计数、没有动作、没有禁令，
也没有任何修复深度或重写上限。

## 改了哪里

- `src/m07/candidate-policy.ts`：
  - 判决新增 `failureSignature`（stage + 第一个 witness 位置），这是「无进展」的判据。
  - 新增 `candidateSearchState()`：停滞计数（只算 keep/accept/revert）、修复深度、五类停滞信号、
    强制换向标记、禁令列表、三级回退路线、确定性父代选项。阈值在 `DEFAULT_ROUTE_LIMITS` 里（3 / 8 / 3），
    对应依据的「调试 3 步、重写 5 步」。
- `src/m07/candidate-episode.ts`：每次评测后重算搜索状态并写入 `episode.search`，同时返回给执行会话。
- `src/m07/types.ts`：`M07CandidateEpisodeV1` 新增 `search`。
- `docs/implementation/design.md`：补充停滞与路线语义。

## 验证

- 类型检查 0 错误。
- `test/m07-candidate-policy.test.ts` 新增 4 项：reject 不计停滞且 keep 清零；三步无提升触发换向与禁令；
  同一失败签名三次为 no_progress、类别反复切换为 category_oscillation、字节重复即触发；
  修复深度 3 升级为 restructure、停滞触顶为 replan。
- `test/m07-candidate-episode.test.ts`、`test/m07.test.ts` 全部通过。
