# W2：M07 任务提示词的静态→动态布局与 history_depth 旋钮（W4-02）

## 为什么

依据 RB-A10-05 / W4-02 的现状分析：系统提示每会话固定逐字使用这一半已经做对，但动态部分没有约定——
本轮反馈、历史、证据路径都拼在用户消息里，没有「静态在前、动态在后、动态元素确定性排序」的布局规则；
全仓 `grep -i 'historyDepth\|topK'` 命中 0，每轮放多少历史是写死的。前缀不稳定会同时丢掉
provider 的前缀缓存命中和模型对同一事实的位置稳定性。

## 改了哪里

- 新增 `src/m07/prompt-layout.ts`：固定顺序 instruction → hardware → knowledge → history → dynamic；
  `layoutPrompt()` 只按 kind 重排（kind 内保持调用方给的顺序，history 即「旧→新」），
  并产出 `PromptLayoutReceiptV1`：逐节字符数、historyDepth、实际带入与被丢弃的历史条数、总字符数。
  这些就是后续做 history-depth 扫描所需的读数；本模块不替用户选深度。
- `src/m07/controller.ts`：`taskMessage` 现在按该布局组装。新增两类节：
  - 硬件：配置了 `PRE_RSI_PLATFORM_PROFILE` 时从平台档案生成（芯片、工具链、容量上限、计时协议），
    并写明这些是档案登记事实而非性能保证；
  - 历史：同一工作对象的历史候选逐条一行（改动类别、策略、位置、宿主判决与准入状态、分数、失败签名、
    截断后的假设），条数由 history_depth 决定。
  布局回执记在任务记录的 `promptLayout` 上。
- `src/types.ts`、`src/config.ts`：`research.config.json` 新增 `promptLayout.historyDepth`（默认 4，0 表示不带历史）。
  默认值不来自任何论文，依据明确要求本机扫描后再定。

## 验证

- 类型检查 0 错误；新增 `test/m07-prompt-layout.test.ts` 4 项：跨 kind 重排且同一组节字节一致；
  深度从最新端截取并记录丢弃条数；回执逐节字符数与总长一致；空节不进提示词、深度参数被校验。
- `m07`、`m07-execution-loop`、`m07-candidate-episode` 全部通过。

## 还没做的部分（留在 W4-02）

cache read 命中率需要真实 provider 调用才能观测；三臂历史深度扫描（只留最新 / top-4 / 全历史）需要真实模型。
