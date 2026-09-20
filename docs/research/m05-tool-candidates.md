# M05 外部知识获取：工具候选记录

## 定位

本文只记录 M05“外部知识获取”的现成工具候选与核查边界，不修改原 workflow，不选定实现架构，也不决定执行模型或预算。

检索范围是全网络，包括论文、论坛、社区及其他与研究问题有关的公开来源。用户已授权资料获取；不得购买付费资料。遇到付费墙或不可直接取得的版本时，应自动寻找作者稿、预印本、机构知识库或其他合法可用版本，并如实记录版本与来源。

用户自研工具仍在研发。2026-09-20 用户决定先用现成项目：其推荐的 browser-use 与本文候选表中的 Crawl4AI 已接入 harness 的 M05（见 `docs/implementation/design.md`），Playwright 作为二者底层随之安装。Docling 与 SearXNG 曾按候选表接入，用户明确不在本地运行模型、也不用 Docker 后均已移除：PDF 改为 poppler 文本层加按页渲染图像交给多模态模型；检索改为 OpenAlex、arXiv、Hacker News、Stack Exchange、Reddit、GitHub 的公开接口加 DuckDuckGo 公开 HTML，另可选 Brave Search API 密钥。以上都通过 `AcquisitionBackend` 接口保持可替换。

## browser-use web-ui

- 官方仓库：[browser-use/web-ui](https://github.com/browser-use/web-ui)
- 底层项目：[browser-use/browser-use](https://github.com/browser-use/browser-use)
- 支持模型文档：[Supported Models](https://docs.browser-use.com/open-source/supported-models)
- 官方 README 所述定位：基于 Gradio 的 browser-use 浏览器 agent 界面。
- 官方 README 展示的能力包括配置多个模型 provider、使用自有浏览器、保持浏览器会话，以及本地或 Docker 运行。
- 许可证：MIT。
- 当前判断：`web-ui` 应纳入 M05 候选，适合人工调试、观察浏览器 agent 行为，以及评估交互式资料获取与会话保持。
- Pi 集成边界：可评估把官方 `browser-use` Python library 或 CLI 封装为 Pi 可调用工具，也可评估由已有 agent 驱动 CLI；不能据此假设 `web-ui` 已提供稳定的公共编排 API 或 Pi 集成 API。
- 模型边界：若采用 `browser-use` 自身 agent，可以为浏览器执行单独配置模型，但该模型不等同于 Pi 中负责 M05 检索判断的模型。也可以评估由已有 agent 驱动 CLI，因此不预设必须使用两个模型。

以上仅为官方文档核查。本项目尚未安装、运行或实测 `web-ui`，也未选定其模型 provider。

## 其他可替换候选

| 候选 | 可能承担的环节 | 官方入口 | 当前状态 |
|---|---|---|---|
| Crawl4AI | 网页抓取与内容提取 | [GitHub](https://github.com/unclecode/crawl4ai) | 候选；未安装、未实测 |
| Playwright | 需要真实浏览器交互的页面操作 | [官方文档](https://playwright.dev/) | 候选；未安装、未实测 |
| Docling | PDF、办公文档等资料解析 | [GitHub](https://github.com/docling-project/docling) | 候选；未安装、未实测 |
| SearXNG | 搜索入口与结果网址发现 | [GitHub](https://github.com/searxng/searxng) | 候选；未安装、未实测 |

这些工具可能组合使用，也可能被用户自研工具或其他现成工具替换。本文不声称它们已经覆盖 M05 的全部来源类型、获取约束、内容核对或记录要求。

## 尚未决定

- 执行模型与 provider。
- 浏览器执行是否使用独立模型，或由已有 agent 驱动 CLI。
- Pi 中的具体工具接口和调用方式。
- 网页操作、内容抽取、文档解析和搜索发现之间的组合方式。
- 用户自研工具完成后与现成候选的取舍。

任何后续选择都应回到原 workflow 的 M05 目标、停止条件、来源状态和后续 M06 核对要求，而不是由某个工具的现成功能反向定义流程。
