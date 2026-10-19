# W2：候选层确定性判决（guard / score / lane / phase）

## 为什么

审查依据（research-basis）里，A2/A5 的多条 P0 判据都指向同一处缺口：M07 候选层只产出事实，不产出判决。
`src/m07/candidate-search.ts` 的限制说明里甚至明确写着「不从这些事实推出任何搜索预算、父代选择或路线禁令」，
于是「选哪个候选、算不算更好、要不要回退」全部交给模型自述。依据中的对照是：确定性决策点 1.57× vs LLM 自选 0.97×；
只保留现任而没有「正确但不更快」的中间态会让必要的中间退步走不通；二值正确性会让约 60.6% 的候选批次梯度为零。

对应判据：RB-A2-04、RB-A2-06、RB-A2-07、RB-A2-08、RB-A2-10、RB-A2-13、RB-A5-07、RB-A5-08、RB-A5-18，
以及阶段顺序 RB-A1-03、RB-A1-05、RB-A5-11（本次只落地相位门的判定与动作校验入口）。

## 改了哪里

- 新增 `src/m07/candidate-policy.ts`：纯函数，输入是已冻结观测与同目标的历史候选，输出 `CandidatePolicyDecisionV1`。
  - lane：`repair`（changeKind=repair 或仍在 bootstrap）/ `optimization`，为后续分列预算留口径。
  - phase：按「该工作对象是否已有通过核验的正确候选」判定 bootstrap / tuning，切换点是宿主事实而不是模型声明。
  - guard：reject / keep / accept / revert 四态，噪声余量默认 1%，可按平台调高。
  - score：分层有界 [0,1]，性能项相对 seed（该对象第一个已验证正确候选）计算、2× 饱和。
  - requiredFix / advisory 各至多一条，对应依据里「失败时只给一个问题、通过时只给一个方法」的双模式反馈。
  - `requireAllowedAction`：动作与相位的确定性校验入口（参数搜索必须在 tuning 且有已验证正确父代）。
- `src/m07/candidate-episode.ts`：评测后计算判决，写入候选记录与冻结 observation.json，并在工具返回里给出判决摘要。
  观测文件改为先写后补：先写事实供归档快照做字节分组，再带判决重写，保证快照语义不变。
- `src/m07/types.ts`、`src/m07/candidate-archive.ts`：候选记录与归档条目新增 `policy` 字段。
- `docs/implementation/design.md`：新增一段描述候选 episode 与判决语义。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：0 错误。
- 新增 `test/m07-candidate-policy.test.ts`（6 项）：首个正确候选结束 bootstrap、超余量才推进 best、回归与失败都 revert、
  未绑定为 reject、分层分数序关系、相位门拒绝过早的参数搜索。
- `test/m07-candidate-episode.test.ts` 增加判决断言，12 项全部通过。
- 不调真实模型、不联网。
