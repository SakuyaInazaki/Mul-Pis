# 合并 M04/M07 两套知识会话工具；门禁判定冻结存档

## 为什么

- `knowledge_select` / `knowledge_read` / `knowledge_artifact_read` 有两份实现：M04 在 `src/stages/m04.ts`，
  M07 在 `src/m07/execution-knowledge.ts`。两边各自做选择、版本解析、分页范围校验，以及「快照或实时
  限制是否在出页期间变动」这项安全检查。同一条安全性质有两份实现，修了一处就等于另一处有缺口。
- 另有两条外部提出的知识层缺口（来自 W5 的 issue 草稿）：入库门禁没有可读回的量化结果与反作弊判定
  记录；知识条目的后端/版本/dtype/结构标签没有强制，检索硬过滤因此可能形同虚设。

## 改了什么

- 新增 `src/knowledge/session-tools.ts`：共用的选择分页（`selectKnowledgePage`）、依赖/反驳索引
  （`recordDependencyIndex`）、快照内版本解析（`resolveSnapshotRecord`）、不可变原件渲染、字符范围
  与生效限制筛选，以及唯一一处稳定性检查 `assertStableKnowledge`。
- `src/stages/m04.ts` 与 `src/m07/execution-knowledge.ts` 的三个工具改用这套核心，各自只保留自己的
  审计记录、措辞与失败处理。m04.ts 净减 44 行，execution-knowledge.ts 的 `index()` 收敛为一次依赖索引。
- 入库门禁：判定结果新增四项检查（反作弊、阈值、去重、容量），每批提案冻结
  `proposals/P####.admission.json`；`readAdmissionReceipts` + `summarizeAdmissionRate` 给出
  proposed / admitted / rejected / rate，入库率可读回核对。
- 卡片标签收紧：案例卡的 applicability 必须写 dtype 与 structure（跨 dtype、跨 rank 照抄是静默失效
  的主要来源）；`provenance.kind="harness-run"` 的 detail 必须含确切运行或任务标识，来源轨迹可回溯。

## 验证

- 类型检查 0 错误；全量测试 468 项，464 通过、0 失败、4 项仅 Linux。
- M04 与 M07 的原有知识工具测试（5 + 15 项）在不改断言的前提下全部通过，说明合并没有改变行为。
- 新增 `test/knowledge/session-tools.test.ts` 3 项与门禁回执 1 项。

## 限制

- 两处工具的响应措辞仍分属中英文，这是面向各自会话的刻意保留，不是重复实现。
- 入库率只统计带结构化卡片的提案；普通认识记录不经过这道门禁。
