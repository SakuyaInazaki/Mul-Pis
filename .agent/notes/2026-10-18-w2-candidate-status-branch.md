# W2：候选的三级准入状态与显式分支决策

## 为什么

依据 RB-A2-07 / RB-A5-08（单篇消融，五次独立试验）：候选状态机必须有「已验证但未晋升」的中间态，
并把验证、晋升与分支决策解耦；去掉多分支血统管理后 2.52×→2.00× 且 token 7M→13M，是该篇最大单项质量消融。
只保留当前最优会杀掉「先降资源再兑现加速」的铺路型路径。
（由 W5 在审查中发现并移交：issues/W5-04；与本分支先前的 guard 四态是同一处缺口的两面。）

## 改了哪里

- `src/m07/candidate-policy.ts`：判决新增 `status` 与 `branch`。
  - `status`：unverified（前置拒绝）→ verified（正确但相对现任回归）→ admissible（正确、可作工作点）
    → promoted（正确且严格更优）。与 guard 的映射是确定性的：reject/revert/accept/keep。
  - `branch`：continue（可继续派生）、merge（晋升的候选其父代来自另一个任务血统，等于把那条分支并进来）、
    archive（回归或失败，留档并可被新证据重新激活）、abandon（前置拒绝，不可派生）。
  - `decideCandidate` 新增可选 `taskId` / `parentTaskId`，只用于区分 merge 与 continue。
- `src/m07/candidate-episode.ts`：传入任务与父任务，并把两个字段放进工具返回。
- `docs/implementation/design.md`：补充状态与分支语义。

## 给控制台的字段（W5 的 audit 展示位）

- `task.episode.candidates[].policy.status` / `.policy.branch` / `.policy.guard` / `.policy.score` / `.policy.lane` / `.policy.phase`
- `task.episode.search.stagnation` / `.signals` / `.route` / `.bannedDirections`
- `task.episode.budget.evaluations` / `.remaining` / `.stop`

## 验证

- 类型检查 0 错误；`m07-candidate-policy.test.ts`、`m07-candidate-episode.test.ts` 共 30 项通过。
- 新增一项测试覆盖四级状态与四种分支决策，包括跨任务父代触发 merge。
