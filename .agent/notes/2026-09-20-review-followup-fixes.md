# 独立审查跟进修正 — 2026-09-20

## 原因

用户授权修复独立审查后发现的事实表述问题，并要求继续对齐认识。本批只修正文档事实和记录，不改变 workflow 设计，不实现代码。

## 修改

- `docs/research/rsi-solpi-workflow.md`：将 EdgeBench 的 GPT-5.6 Sol 与 Opus 5 结果拆开；将推理档位表述收窄为 Table 1/2 未统一注明，而 Fig. 7 的 GPT-5.6 Sol 合并机制分析另标 `xhigh`。
- `.agent/notes/2026-09-20-audit-fixes.md`：保留原操作历史，追加对错误数字和推理档位理由的显式纠正；移除“用户自研工具仍在研发”这一当前待确认项，并记录已有用户依据。
- `docs/research/pi-harness.md`：同批独立任务补充固定 commit `e4c75a73222ae2c72abb5f5314fa35ee8effc508` 的三类决定性源码直链：resource loader 的 trust/context 时序，SQLite backend 的提交队列与批量事务，以及 extension tool 的 `executionMode` 与顺序/并行执行分支。只补证据链接，没有扩大既有语义。

## 边界

- 没有把 foundation 的 M06 未决事项改成已批准方案。
- 没有新增交接文档、运行代码或哈希校验流程。
- 没有提交或推送。

## 验证

- 对照 SoL-Pi 官方 arXiv v1 的 Table 1/2 与 Fig. 7 说明核对上述数字和推理档位边界。
- 检查本批四个改动文档中的 13 个本地相对链接，缺失 0 个；外部链接不在本地存在性检查范围内。
- 对本批四个文档执行 `git diff --check`，通过。
- 目标文字核对确认报告使用拆分后的两组 EdgeBench 数字，Pi 报告包含三类固定源码直链，历史审计记录保留原文字并追加纠正。
