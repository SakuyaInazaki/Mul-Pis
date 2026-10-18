# 各阶段改用装配表注入；M05/M06 产出可检查的结构

## 为什么

- 注入侧：M04 48 条 / 60000 字符、M06 32 条 / 40000、M05 30000 都是各自拍的数字，没有阶段差异，
  也没有「这条进过哪个提示」的回执。
- M05/M06 侧：两个阶段的全部产物都是自然语言。依据对这一点的结论很直接——原则级文档几乎无效，
  只有能转成可执行示例、API 签名或硬性数值约束的资料才有价值；专家源码直接丢给模型在 10/10 个
  算子-平台对上更慢，必须以带前提的技能卡形式出现；阅读深度要分级，深层分析的价值是排除错误方向，
  因此「看了但没有可行动结论」必须有地方记。

## 改了什么

- `src/stages/m04.ts`、`m05.ts`、`m06.ts` 改用 `assembleInjection`：分别走 judgment / acquisition /
  applicability 相位，条数与字符由装配表统一规定，并带冻结分层先验；M04 的 `knowledge-selection.json`
  和 M05 新增的 `knowledge-injection.json` 保存注入回执。
- 新增 `src/stages/source-knowledge.ts`（新的提示词拼装与确定性解析，`prompts.ts` 未改）：
  - M06 适用性会话追加结构化抽取要求：声明阅读深度 L1–L4 与升级理由，并用 `knowledge-card` 代码块
    给出零到多张知识卡；
  - `extractSourceKnowledge` 按卡片 schema 逐张校验，未通过的记录原因而不丢弃，也不猜测；
  - 没有任何卡片通过校验时结论为 `inconclusive`，这是如实结果，不是失败；
  - M05 追加「可执行化产出」小节要求（可编译范例 / 确切 API 签名 / 硬数值约束及出处），缺节记 failure。
- `src/stages/m06.ts`：资料组新增 depth / depthReason / conclusion / extraction 字段，冻结
  `frozen/reports/<S>/extraction.json`，整批汇总列出深度与抽取结果。
- 文档：design.md 的 M05/M06 行与新增段落写明产物形态、深度分级与 inconclusive 语义。

## 验证

- 类型检查 0 错误。
- 新增 `test/m06-source-extraction.test.ts` 2 项（解析/校验/深度/inconclusive；M06 实跑两份来源，
  一份出卡一份 inconclusive，核对冻结报告、汇总文本，并确认抽取不写入知识库）。
- `test/m05.test.ts` 的假报告补上新小节；M04/M05/M06 相关测试 18 项全通过。

## 限制

- 抽取只做结构校验：卡片是否科学成立仍由 M04 判断，宿主不做内容判定。
- 阅读深度由会话自述、宿主只校验「深度声明 + 升级理由」的存在性；它不能证明确实做到了那一层。
