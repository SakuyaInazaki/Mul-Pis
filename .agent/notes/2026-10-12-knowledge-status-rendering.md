# 知识记录状态展示修复（2026-10-12）

本批仅修改知识包和检索输出的记录渲染。显示 Q 记录的本版本开闭状态、关闭原因、版本原因、被替代版本，以及历史引用对应的当前发布版本。已关闭 Q 的正文仍逐字保留；输出说明原有“未决”等措辞属于历史内容，关闭不代表命题已证实。历史版本的状态明确限定为该版本，并提示查看当前版本。

没有修改知识合入、可用性和限制的计算，也没有改写、删除原始记录。回归测试覆盖关闭后保留旧正文、旧版身份、当前版本指向、生效限制和原记录不变。

验证：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 通过；`node --test test/knowledge/pack-views.test.ts test/knowledge/retrieval.test.ts` 在可访问 macOS `kern.boottime` 的环境中 12/12 通过。
