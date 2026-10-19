# W2：candidate episode 的边界重启（W4-01）

## 为什么

依据 RB-A10-02（P1，单篇消融）：每 N 轮在 episode 边界把轨迹蒸馏成有界记录后清空上下文重启，完整转录归档。
字段＝有效 tiling、边界 mask 要求、phase 谓词、数值约束、失败签名、最佳候选家族。
效应：GLM-5 2.294→2.745、Sonnet 4.6 2.417→2.546、GPT-5.4 1.973→2.153，15 次试验中 10 次优于不重启。
**该消融没有分离「摘要」与「清空上下文」各自的贡献**，所以这里做成可配置项而不是无条件行为。
依据 RB-A10-03（P0）：重启后还要用的信息必须先落盘。
合并后压缩侧与平台闸门都已经把结构化记录写进 JSONL，缺的就是边界上的蒸馏与重启。

## 改了哪里

- 新增 `src/m07/episode-record.ts`：`EpisodeRecordV1` 与 `distillEpisode()`。蒸馏只读宿主记录——
  候选判决（失败签名、禁令方向、guard 统计、已验证最佳及其策略）、runner 的压缩 JSONL、平台闸门 JSONL——
  不调用模型，每个字段都有条数与长度上限；`writeEpisodeRecord()` 写到
  `.agent/context/episodes/<runId>/<taskId>-E<n>.json`；`episodeRestartMessage()` 组装重启消息：
  只有任务说明 + 该记录，并明确说明上一会话的上下文已清空、完整转录在会话日志里。
- `src/m07/controller.ts`：candidate-episode 的 builder 循环外加一层 episode 边界循环。
  达到 `searchBudget.episodeRestartEvaluations` 次评测且预算未触顶时：蒸馏 → 落盘 →
  收走旧会话的 readCoverage 与 toolLog → dispose → 以 `intent: "episodic-restart"` 开新会话
  （证据绑定就是那份冻结记录）→ 用重启消息继续。重启记录写进 `episode.restarts`。
- `src/context/boundary.ts`（W4 拥有，最小改动）：新增 `episodic-restart` 意图，并要求证据里必须有
  标注为 episode record 的冻结文件——故意清空上下文只有在替代它的记录本身是冻结证据时才允许。
- `src/m07/candidate-policy.ts`：`searchBudget` 新增 `episodeRestartEvaluations`（默认 8，0 关闭）。
- `src/m07/types.ts`：`M07CandidateEpisodeV1` 新增 `restarts`。

## 验证

- 类型检查 0 错误。新增两项测试：
  - 端到端：两次评测后越过边界，重启消息以 `# Episode 1 restart` 开头、含已验证最佳候选引用、
    不含上一会话的原文；记录文件含失败签名与候选计数；新会话是独立 session。
  - 边界：缺少冻结 episode record 的 `episodic-restart` 被拒，带记录的被接受并写下回执。
- `m07-candidate-episode`、`context-boundary` 全部通过。
