# 知识层的注释与测试取值改为平台中立

## 为什么

工作流是通用的，不针对任何硬件平台；平台规则属于实验工作区，不进可复用代码。此前我在知识层的
注释示例和测试取值里写了具体厂商/平台名称，机制虽然与平台无关，但示例会把人误导成「这套知识层
是为某个平台写的」。

## 改了什么（只改示例与取值，机制不变）

- `src/knowledge/prior-library.ts`、`rule-mining.ts`、`static-checks.ts` 的注释：改成「另一台设备/
  另一个工具链版本」「模型先验很弱的后端」「`Ns::Symbol(...)`」这类中立表述。
- `test/knowledge/{static-checks,injection,optimization-cards,rule-mining}.test.ts`、
  `test/m06-source-extraction.test.ts`、`test/m07-execution-knowledge.test.ts`：示例取值统一改为
  `backend: "backend-a"`、`toolchain: "toolchain-1.2"`、`BackendA::Add/Sub/Scale`、
  `Tensor&` 签名、`buffer_bytes` 约束名、`缓冲容量/缓冲上限`、profile 改为「实测 profile」。
- 一处测试断言跟着取值改：按记录标题找规则卡时改用中立标题片段。

## 验证

- 类型检查 0 错误；`test/knowledge/*`、`test/m06-source-extraction`、`test/m07-execution-knowledge`
  共 79 项全部通过。
- 整词 grep `\b(cann|CANN|[Aa]scend|AscendC|npu|NPU|msprof)\b|昇腾` 在 `src/knowledge/`、
  `src/stages/`、本轮我新增或改过的测试里已无残留。

## 范围说明

- `test/knowledge/retrieval.test.ts` 是 0cf09d3 原有文件，按指示不动，等用户决定。
- `src/m07/candidate-performance.ts` 的 ncu/msprof CSV 导入是 0cf09d3 原有的通用能力，按本轮说明保留；
  `candidate-policy.ts`、`platform-task-contract.ts` 里的平台内容属其他环节的清理范围。
