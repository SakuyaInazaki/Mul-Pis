# M07 方法经验发现与 M04 指定证据读取接线

- 在原知识库 CURRENT 上为 `research_status` 增加可选、只读的 M07 executor 经验发现。候选经现有 provider 的适用条件、依赖、可用性与 live limits 校验；只显示前 24 条精确 pinned 身份及有限条件字段，超出显示上限的合格项计数。无请求时状态行为不变，发现不自动装载或采纳。
- `research_delegate` 的说明引导在有可复用观察的 execute 任务中显式声明 JSON lesson 和相应预期产物，并在选经验前先查当前可用身份；既有 controller 仍执行精确引用的再次校验。
- 文案明确发现结果只是 M07 execute 任务的条件匹配候选；显式委派仍须通过经验包记录数与正文长度预算。
- 将已有 M04 `requiredM07ReadPaths` 通过 `research_stage` 和服务层透传，并在已有 checkpoint 工具摘要中显示 `manifestPath`，让主 Pi 能从清单选定 lesson、源码、回执并使用既有全文返回门；不改变 checkpoint 或 M04 科学判断。
- 离线 `npm run typecheck` 通过；定向 `test/knowledge/experience.test.ts` 与 `test/pi-continuation.test.ts` 在可读取 macOS 进程身份的测试环境中 30/30 通过。普通沙箱运行时的 `sysctl -n kern.boottime` 权限错误属于测试环境限制，非业务断言失败；定向测试未联网或调用模型。
- 随后收敛知识主链：经验发现支持同一有序合格流的 offset 分页与 nextOffset；普通和检索知识包在原预算内显示本库身份及记录元数据；M04 重试身份纳入指定全文读取路径；M06 适用性与 M04 回流提示明确算子条件、同版源码回执及负证据。既有经验、知识包和重试测试补最小行为断言；本批按统一验证安排未单独运行测试或 typecheck。
- 局部知识包改为在既有整记录预算内展示完整原始 `fields`，以免 M04 修订经验时遗漏同一记录的检索标签和科学元数据；展示本身不表示采用。组合用例同步覆盖多字段可见及超预算时整记录省略，未单独运行测试或 typecheck。
- 修正原 `buildKnowledgePack.maxChars` 边界：头部不足时报现有 HarnessError，过长的未展开 ID 文本转为计数；结构化 `omitted` 仍保留全量，极小预算可只返回头部，不返回超预算文本。M04 候选经验提示改用实际 `lessonDeltaOutput` 声明的 JSON 路径概念，不假定固定文件名。组合用例覆盖短头部预算和大量省略项；未单独运行测试或 typecheck。
