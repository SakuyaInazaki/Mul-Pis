# M05 工具候选文档记录 — 2026-09-20

本批新增 `docs/research/m05-tool-candidates.md` 并加入文档索引。记录用户指定的 `browser-use/web-ui`，以及 Crawl4AI、Playwright、Docling、SearXNG 等可替换候选。

文档同步记录了当前授权和边界：检索范围覆盖全网络；资料获取已获授权但不购买付费资料，应寻找合法可用替代版本；执行模型、工具组合、Pi 接口和最终选型均未决定。此次仅依据已核查的官方说明整理文档，未安装、运行或实测工具，也未修改原 workflow。

补充核验后，进一步区分 `web-ui` 的人工调试/观察用途与底层 `browser-use` Python library 或 CLI 的 Pi 集成候选角色。浏览器执行可以单配模型，也可以由已有 agent 驱动 CLI；不预设必须采用两个模型，且不假设 `web-ui` 提供稳定公共编排 API。
