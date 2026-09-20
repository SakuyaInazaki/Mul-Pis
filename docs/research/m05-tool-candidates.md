# M05 外部知识获取：工具候选记录

## 定位

本文记录 M05“外部知识获取”的工具选择、现行接入状态与核查边界，不修改原 workflow，也不决定执行模型或预算。

来源范围不预设站点白名单，按研究任务扩展，包括论文、论坛、社区及其他与研究问题有关的公开来源。用户已授权资料获取；不得购买付费资料。遇到付费墙或不可直接取得的版本时，应自动寻找作者稿、预印本、机构知识库或其他合法可用版本，并如实记录版本与来源。

用户自研工具仍在研发。2026-09-20 用户决定先用现成项目：其推荐的 browser-use 与 Crawl4AI 已接入 harness 的 M05（见 `docs/implementation/design.md`），Playwright 是其浏览器运行依赖。Docling 与 SearXNG 曾接入，随后因用户明确不在本地运行模型、也不用 Docker 而移除；这两项不再是当前待选方案。PDF 改用 poppler 文本层和按页图像交给多模态模型。默认检索使用 OpenAlex、arXiv、Crossref、Hacker News、Stack Exchange、GitHub 仓库与 Issues、DuckDuckGo 公开 HTML；Reddit 为显式选择项，Brave Search API 需可选密钥。以上能力都通过 `AcquisitionBackend` 接口保持可替换，配置可把搜索提供方缩为子集。

## browser-use 与 web-ui 的区别

- 官方仓库：[browser-use/web-ui](https://github.com/browser-use/web-ui)
- 底层项目：[browser-use/browser-use](https://github.com/browser-use/browser-use)
- 支持模型文档：[Supported Models](https://docs.browser-use.com/open-source/supported-models)
- `browser-use` 是当前接入的 Python library；`web-ui` 是基于 Gradio 的独立浏览器 agent 界面。
- `web-ui` 官方 README 展示配置多个模型 provider、使用自有浏览器、保持浏览器会话，以及本地或 Docker 运行等能力；不能把这些能力自动视为本项目当前 wrapper 的能力。
- 许可证：MIT。
- 当前接入：项目用 `browser-use` library 的 `Agent` 与新的 headless `BrowserSession`，未安装或接入 `web-ui`。wrapper 当前只支持 OpenAI 与 Anthropic 的 browser-use 模型类；浏览器模型由 `research.config.json` 明确指定，不是 harness 默认选择，也不等于 M05 主会话模型。
- 会话边界：每个任务创建新会话，尚未接入用户已有浏览器、profile、login state 或凭据管理。正常授权访问并非一概禁止，但当前实现不能据此保证登录站点可用。
- 产物边界：同一任务会话按步骤增量保存变化后的 DOM、正文、截图和下载；同一 URL 的状态变化也可形成新产物。元数据逐步写入，因此成功保存的部分在后续失败或超时时仍可用。浏览器模型的 `result.md` 只是报告，不能登记为外部原始材料。
- 完整性边界：捕获有页面状态数、截图数和字节数上限，触限会产生警告；即使 browser-use 报告成功，也不代表原始材料范围已经独立证明完整。论坛全帖、多页材料和附件按任务需要取得，不自动递归抓取全部内容。

`web-ui` 仍仅是未安装、未实测的观察与调试候选，不是当前运行路径。

## 其他可替换候选

| 候选 | 可能承担的环节 | 官方入口 | 当前状态 |
|---|---|---|---|
| Crawl4AI | 网页抓取、渲染与正文提取 | [GitHub](https://github.com/unclecode/crawl4ai) | 已安装并接入；失败时可退化为纯 HTTP 抓取并记录实际引擎 |
| browser-use | 定点交互、展开、翻页与下载 | [GitHub](https://github.com/browser-use/browser-use) | 已安装并接入；须显式配置受支持的云端模型与密钥 |
| Playwright | 上述工具所需的 headless 浏览器运行层 | [官方文档](https://playwright.dev/) | 随 Python 工具环境安装 Chromium headless shell；不是独立 M05 决策者 |
| poppler | PDF 文本层提取、页数检查与单页渲染 | [官网](https://poppler.freedesktop.org/) | 当前 PDF 路径；无 OCR、本地 ML 或 Docker |
| browser-use web-ui | 人工调试与观察界面 | [GitHub](https://github.com/browser-use/web-ui) | 未安装、未接入；可替换候选 |
| Docling | PDF、办公文档等资料解析 | [GitHub](https://github.com/docling-project/docling) | 已移除；当前约束下不采用 |
| SearXNG | 搜索入口与结果网址发现 | [GitHub](https://github.com/searxng/searxng) | 已移除；当前约束下不采用 Docker 服务 |

现有搜索、直接抓取、下载与交互浏览可按任务灵活组合，没有“browser-use 只能最后使用”的顺序。任意 HTTP(S) URL 可进入通用抓取或下载路径，但站点访问控制、动态行为、登录状态和页面结构仍会影响结果；不预设站点白名单也不构成全网穷尽保证。抓取保存全部已提取并去重的 HTTP(S) 链接，M05 用 `list_page_links` 分页查看；失败或非 HTML 下载不声称链接提取完整。DuckDuckGo HTML 的可靠 API 翻页尚未实现，可用浏览器继续。

## 尚未决定或尚未验证

- 执行模型与 provider。
- 用户自研工具完成后与现成候选的取舍。
- 更通用的 browser-use provider 路由，以及既有浏览器会话、profile 和登录状态的安全接入方式。
- 针对具体论坛或网站的完整帖子、多页和附件获取策略；当前只要求任务范围内如实记录计划、取得与缺失部分。
- 真实云端模型端到端运行；当前不能据此声称对所有来源或网站有效。

任何后续选择都应回到原 workflow 的 M05 目标、停止条件、来源状态和后续 M06 核对要求，而不是由某个工具的现成功能反向定义流程。
