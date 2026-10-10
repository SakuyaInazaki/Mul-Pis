# 来源与固定版本

## Pi agent harness

- 上游仓库：https://github.com/earendil-works/pi.git
- 审计时分支：`main`
- 固定 commit：`e4c75a73222ae2c72abb5f5314fa35ee8effc508`
- 本地 Pi coding-agent 包版本：`0.85.1`（固定 commit 中 `packages/coding-agent/package.json`）。
- 本地路径：`third_party/pi/`
- 发布策略：不提交本地 checkout、嵌套 `.git`、依赖或构建产物；公开版只记录来源与固定 commit。
- 许可证：MIT License，Copyright (c) 2025 Mario Zechner；见固定 commit 的 [`LICENSE`](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/LICENSE)。该许可不自动套用于本项目原创内容。

复现 checkout：

```sh
git clone https://github.com/earendil-works/pi.git third_party/pi
git -C third_party/pi checkout --detach e4c75a73222ae2c72abb5f5314fa35ee8effc508
```

## SoL-Pi reference implementation

- 上游仓库：https://github.com/NVlabs/SoL-Pi.git
- 审计时分支：`main`
- 固定 commit：`bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`
- 本地路径：`third_party/sol-pi/`
- 获取方式：`git clone --depth 1`，未安装依赖、未执行脚本。
- 上游形态：独立 Pi extension checkout，不是本项目维护的 Pi fork。
- 许可证：固定 commit 根目录 `LICENSE` 所载 MIT-style permission notice；再分发时还需检查 `THIRD_PARTY_NOTICES.md`。
- 发布策略：不提交本地 checkout 或嵌套 `.git`；公开版只记录来源与固定 commit。

复现 checkout：

```sh
git clone --depth 1 https://github.com/NVlabs/SoL-Pi.git third_party/sol-pi
git -C third_party/sol-pi fetch --depth 1 origin bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1
git -C third_party/sol-pi checkout --detach FETCH_HEAD
```

## RSI 研究论文

- 标题：*The Last AI Built by Humans: Toward Genuine Recursive Self-Improvement*
- 作者：Yi Duan, Ying Liu, Zirui Tang, Haodong Chen, Jun Zhou, Yumou Liu, Bangrui Xu, Yukai Wu, Sidi Chen, Yuhan Zhou, Haoyu Wang, Xiaoyou Yu, Shaokun Han, Xuzhou Zhu, Le Zhou, Bolin Lu, Wei Zhou, Jiachen Liu, Nuozhou Fang, Jiaxin Tian, Ruoyu Chen, Yuxuan Li, Kai Zuo, Kaiyan Zhang, Jiantao Qiu, Conghui He, Guoliang Li, Bowen Zhou, Zhiyuan Liu, Zhoufutu Wen, Jihua Kang, Xuanhe Zhou, Fan Wu。
- 固定来源：https://arxiv.org/abs/2609.11873v1
- 项目页：https://theseus-labs-rsi.github.io/
- 本地文件名：`resources/2609.11873v1.pdf`
- 固定版本：arXiv:2609.11873v1 [cs.LG]，提交于 2026-09-10 17:44:23 UTC，75 页。arXiv 当前另有 v2；本项目资源和报告核验对象仍是 v1。
- 发布策略：PDF 仅本地保留，不进入公开发行；公开版保留来源元数据。
- 权利说明：论文版权和再分发条件由其发布者与作者决定。

## SoL-Pi 研究论文

- 标题：*SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent Harness*
- 作者：Haozhe Liu, Tian Ye, Sensen Gao, Qihang Cao, Yitong Li, et al.
- 固定来源：https://arxiv.org/abs/2609.20519v1
- 项目页：https://nvlabs.github.io/SoL-Pi/
- 固定版本：arXiv:2609.20519v1，2026-09-17，15 页。
- 本地状态：未保存论文 PDF；调研引用来源页和项目资料。
- 关系：论文、项目页与 NVlabs/SoL-Pi 仓库来自同一研究团队，不作为三份独立复现实证。

## 科研执行流程 v1.0

- 当前路径：`workflow/v1.0/`
- 所有权与角色：用户自有的科研工作流，是本项目继续研究、修改和演进的直接基础。
- 当前状态：从原目录迁移到现路径；后续按用户需求继续发展，不作为不可修改的第三方导入物管理。

## Mechanism references for the 2026-10-04 workflow increment

The links below distinguish the original design references from a later audit of the user-named Humanize repository. They are mechanism references, not Mul-Pis executable dependencies. No upstream implementation file, prompt, skill, corpus, or artifact was copied or vendored in this change batch. See `docs/implementation/workflow-learning-increment.md` for the implementation and evidence boundaries.

- [Humanize1 workflow](https://github.com/humanfia/humanize1-flow/tree/4ac8dd415cc1df16f71990bda7070e93af69287f), fixed commit `4ac8dd415cc1df16f71990bda7070e93af69287f`: the originally cited same-builder/fresh-reviewer and lesson-delta inspiration. This is a distinct repository from `humanfia/humanize`. The license at that exact snapshot was not independently verified; no code or text was imported.
- [Humanize](https://github.com/humanfia/humanize/tree/caac620fe5c39ab6d7ae0ab6675ad23a1300a3e0), audited commit `caac620fe5c39ab6d7ae0ab6675ad23a1300a3e0`: [`rlar`](https://github.com/humanfia/humanize/blob/caac620fe5c39ab6d7ae0ab6675ad23a1300a3e0/src/hmz/flows/builtin/rlar/__init__.py) starts one actor session, creates a fresh reviewer each round, and passes structured reviewer notes into the next actor turn. This substantiates a mechanism correspondence with Mul-Pis M07, not an implementation import. That flow does not itself implement Mul-Pis M04 knowledge adoption or the `lessonDeltaOutput` contract.
- [NVlabs KDA](https://github.com/NVlabs/kda/tree/ef6ce617693ef0782b3ecb9f37e39bbf10226a90), fixed commit `ef6ce617693ef0782b3ecb9f37e39bbf10226a90`: [`docs/agent-flow.md`](https://github.com/NVlabs/kda/blob/ef6ce617693ef0782b3ecb9f37e39bbf10226a90/docs/agent-flow.md) and [`prompts/basic-flow.md`](https://github.com/NVlabs/kda/blob/ef6ce617693ef0782b3ecb9f37e39bbf10226a90/prompts/basic-flow.md) describe a task contract, plan draft, validation, measurement, evidence records, and promotion rule. These are workflow guidance, not a KDA runner integrated into Mul-Pis. Its public licensing distinguishes first-party source code (Apache-2.0) from documentation/prompts/skills/assets (CC-BY-4.0); third-party submodules keep separate terms. No upstream content was imported.
- [EveryInc Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin/tree/9af474a70e7f2a844338519ad9e92aafbd92d4fb), fixed commit `9af474a70e7f2a844338519ad9e92aafbd92d4fb`: relevance-first learning lookup inspiration. Its public repository states MIT; no source content was imported.
- [KernelWiki](https://github.com/mit-han-lab/KernelWiki/tree/76d27b56f804e7e7295d4c570e1e5d7eef4b0a75), fixed commit `76d27b56f804e7e7295d4c570e1e5d7eef4b0a75`: task-scoped technical-reference lookup inspiration. Its tooling is described as MIT-style, while embedded/derivative artifacts may have separate terms. No wiki data or tooling was imported.
