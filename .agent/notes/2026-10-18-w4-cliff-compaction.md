# 2026-10-18 W4：上下文压缩改为确定性悬崖式，并在丢弃前落盘

## 为什么

审查依据 RB-A10-01（P0）要求长程会话做「悬崖式压缩」：平时完全不动上下文，只在超过一个阈值时一次性丢弃，
且**只删除与截断、不改写**，不做「摘要的摘要」。依据里的对照数据：不压缩时 98% 的运行在中位第 99 步因上下文
耗尽提前终止、加速封顶 1.30×；加压缩后能跑满 200/400 步，2.23×/3.58×（设备为 L40S，倍数不可外推到别的硬件）。
RB-A10-03（P0）补了一条前提：压缩后还要用的信息必须先落盘，否则「被删的东西可以用工具重新取回」这个假设
对编译日志、profiler 报告、失败记录并不成立。RB-A10-04（P1）要求历史深度是一个可配置、可 A/B 的单一旋钮。

改动前的实现有三个问题：
1. 压缩走的是 Pi 自带的**模型摘要**路径，是改写，而且每次压缩要多花一次模型调用；连续压缩还会把上一份摘要
   再摘要一次。
2. 主控制器会话默认**完全不压缩**：只有当环境变量恰好等于字面量 `"200000"` 时才启用，等于把最需要压缩的那条
   长会话排除在外。
3. 被丢弃的内容只留在会话 JSONL 里，没有结构化记录，失败签名、读写过的文件都要人工翻原始转录。

## 改了哪里

- `src/runner/compaction.ts` 重写：
  - `cliffCompaction()` 是纯函数，按固定规则渲染被丢弃的那一段：首条任务原文（上限 8000 字符，防止一条超大
    首轮提示让压缩失效）、之后的用户消息与助手正文截断到 500 字符、助手思考截断到 300 字符、工具调用压成
    150 字符的签名、工具结果 ≤500 字符保留、>500 字符整条删除并记录原长度。
  - 上一次的压缩块**原样带过**，不参与本次压缩；渲染时跳过内容以压缩标记开头的消息。
  - `workflowCompactionExtension()` 在 `session_before_compact` 里直接返回这份结果，Pi 不再发起摘要请求。
    何时压缩仍由 Pi 的阈值、溢出与重试逻辑决定。
  - `appendCliffDigest()` 在内容离开上下文之前追加一条 JSONL 记录：渲染结果、丢弃条数与字符数、读过与改过的
    文件、最多 16 条逐字失败签名。落盘失败时把失败写进模型看到的那段文字，不吞掉。
  - `compactionPolicyFromEnvironment()`：阈值是唯一对外的旋钮，用 `PRE_RSI_CONTEXT_THRESHOLD_TOKENS` 覆盖，
    小于 16384 或非整数直接拒绝（依据提醒阈值过紧会因频繁缓存失效反伤效果）。该变量由宿主持有，模型侧 bash
    子进程的环境是重建的，拿不到也改不了它。
- `src/runner/pi.ts`：会话创建时读取环境策略，并把摘要文件定位到 `<persistDir>/<sessionId>.compaction.jsonl`。
- `src/pi/extension.ts`、`extensions/local-operator.ts`：删除 `newSessionCompaction` 开关与那个字面量环境判断，
  主会话一律启用悬崖式压缩；配置了续跑工作区时摘要写到 `.agent/sessions/main-<pid>.compaction.jsonl`。
- `docs/implementation/context-boundaries.md`：改写「Compaction for new sessions」一节。
- `test/runner/compaction.test.ts`：四个离线单测（渲染规则与确定性、上一次压缩块原样带过、摘要落盘、阈值旋钮
  校验）加一个端到端用例——压缩发生时**没有任何摘要请求**，三次 provider 调用全部是正常回合，压缩条目与
  摘要文件内容一致。

## 验证

- `tsc --noEmit` 0 错误。
- `test/runner/compaction.test.ts` 5/5 通过；`test/pi-extension.test.ts`、`test/pi-continuation.test.ts`、
  `test/runner/pi.test.ts`、`test/pi-main-usage.test.ts` 共 33 通过 1 跳过 0 失败。

## 兼容性

- 会破坏历史工作区的压缩格式：旧会话里 Pi 写的模型摘要仍然可读，但新会话的压缩条目是本文件定义的结构化文本块。
- `PRE_RSI_NEW_SESSION_COMPACTION` 不再有任何作用，设置它不会报错也不会生效。
