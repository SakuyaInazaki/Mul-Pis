# workflow-research 独立记录（2026-09-19）

## 范围

- 只读盘点 `workflow/v1.0`、`resources/2609.11873v1.pdf`。
- 实际浏览 SoL-Pi 官方项目页、官方 arXiv 论文和官方 GitHub 仓库元数据。
- 未修改工作流原文件、Pi/third_party 内容；未安装依赖、未运行外部脚本、未提交或推送。

## 稳定定位

- RSI：[arXiv:2609.11873v1](https://arxiv.org/abs/2609.11873v1)，2026-09-10；本地核验副本 75 页，公开记录不依赖本地 PDF 链接。
  - 定义和与相邻范式区别：pp. 10-12。
  - 分级综合与评测维度：p. 35。
  - 科学 RSI：pp. 36-38。
  - agent-native research artifacts / deterministic verification：pp. 49-50。
  - 挑战、评价器独立、长期评测、人类协作：pp. 50-53。
- SoL-Pi：[arXiv:2609.20519v1](https://arxiv.org/abs/2609.20519v1)，2026-09-17，15 页。
  - 冻结/held-out/固定接受标准：p. 3。
  - 搜索环境与四机制：pp. 3-5。
  - 结果与触发交互：pp. 8-12。
  - 局限和“recursive efficient improvement 尚是愿景”：p. 12。
- SoL-Pi 官方项目页：https://nvlabs.github.io/SoL-Pi/ （2026-09-19 访问，页脚 sigil d179e73d）。
- 官方 repo：https://github.com/NVlabs/SoL-Pi ，2026-09-19 `main` SHA：`bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`；GitHub API size 26904 KiB。

## 关键判断

1. `workflow/v1.0` 本身就是泛科研执行层设计；M01—M09 的按需调用、M03 人工转交链和 M04 状态更新均以原文为准。
2. SoL-Pi 的筛选纪律可用于后续比较，coding verifier 结果不能外推为泛科研有效性。
3. 科研结果证据与工作流改动证据必须保持职责边界；沿用既定 E/J/D、knowledge 与 notes 分工，不另建平行账本。
4. 用户本轮明确暂不决定自治级别、采用与发布规则；隔离评测、人批准等只能列为待比较选项。
5. 历史回放和完整更新失败不得取消已知停用；任何未来回滚实现都要满足工作流原有规则。

## 工具与异常

- `pdftotext -layout`、`pdfinfo`、`pdftoppm` 用于检索与关键页视觉核验。
- 两份 PDF 均出现 Poppler “Unterminated string / font mismatch”警告，但可正常抽取正文并渲染关键页；未观察到关键页版面缺失。
- SoL-Pi 项目页和论文中的数值属于同一研究团队的材料，不应计为独立重复。

## 未验证

- 原工作流在泛科研任务的实际 A/B。
- 本项目任务分布、held-out 构造、保护项和容差。
- 用户最终授权的自我演进层级与采用规则，本轮明确保持待决。

## 本地快照复核

- organizer 已将官方仓库浅克隆到 `third_party/sol-pi`；复核 HEAD 为 `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`，工作树干净。
- 本地 README、`agents-install.md`、`docs/configuration.md`、`package.json` 共同确认：standalone extension、测试 Pi 0.85.1、四机制 opt-in 且默认关闭。

## 2026-09-20 深读后的修订

- 在完整工作流与分册逐文件读至 EOF 后，重写 `docs/research/rsi-solpi-workflow.md`：以 `workflow/v1.0` 为研究基础，不再称其为需泛化的竞赛旧版。
- 删除将网页版 AI 与用户人工转交替换为 adapter 的建议；该协作链按现行工作流属于已定设计。
- 删除预设的自我改进、人工批准、自动回滚和双账本路线；自治级别、接受与发布规则保持后议。候选隔离与 held-out 纪律只作为外部比较材料。
- 明确 RSI/SoL-Pi 只能提供外部分类与 coding-agent 场景证据，不能替代 C/K/E/J/Q/D/X、三状态、M04 更新协议和人的研究判断。
- 针对 Pi 0.85.1 核对 session/custom entry、compaction、extension tool hooks、SDK/RPC 与 Chord experimental 边界；证据已交 Pi 报告负责人，未另建架构文档，未修改 `third_party/pi`。
- 收紧报告措辞：外部材料可作后议参考，但不能单独决定交互链或架构；现有事实/论证/决定分工只是讨论改进证据的基础，尚未形成已定双账设计。

## 2026-09-20 补记

- 上文“M03 人工转交链以原文为准”“该协作链属于已定设计”描述的是原 v1；同日的 M01–M09 当前对齐已把 M03 改为主 Agent 自动编排，以 `docs/research/workflow-foundation.md` 的“当前对齐”为准。
- `docs/research/rsi-solpi-workflow.md` 中把人工转交链写成“当前已定设计”的两处已随独立审查修正；其中无法在 arXiv v1、项目页当前版本和固定仓库中找到来源的 ObservationPack 11 任务配对数字（-23.58% / +22.92%）已删除，EdgeBench 行去掉了论文未写明的 `xhigh` 并改用论文原数字。见 `2026-09-20-audit-fixes.md`。
