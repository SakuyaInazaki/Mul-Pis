# 2026-10-18 W4：通用 runner 不再点名供应商，请求契约改成注册表

## 为什么

W5 的审查条目（供应商隔离）与本环节的 RB-A11-24、RB-A13-05 指向同一处：平台与供应商专用的东西不应该
留在可移植层里。改动前 `src/runner/pi.ts` 有三处硬编码：

- strict 请求只放行 `provider === "deepseek" && api === "openai-completions"`，错误信息也写死供应商名；
- 普通会话的 `onPayload` 检查同样按供应商名开关；
- 通用接口 `src/runner/types.ts` 从供应商模块 import 自己的诊断类型（依赖方向反了）。

## 改了哪里

- `src/runner/types.ts`：`ProviderRequestViolation` 现在定义在通用接口里，供应商模块改成别名引用
  （提交 e068938）。
- 新增 `src/runner/provider-contract.ts`：
  - `ProviderRequestContractError`（通用、静态、未发出请求）；
  - `ProviderRequestContract` 与注册表 `registerProviderRequestContract` / `providerRequestContract`；
  - `inspectCompletionsOutputRequest`：按 chat-completions **API 形状**校验输出上限，与供应商无关
    （原函数除了错误文案外本来就是通用的）。
- 新增 `src/runner/provider-contracts.ts`：**唯一点名供应商的文件**，import 各供应商模块以完成注册。
- `src/runner/deepseek-request-contract.ts`：`DeepSeekRequestContractError` 改为通用错误的子类，
  模块末尾注册自己的契约；供应商专有规则（reasoning 重放、签名、工具结果配对）仍留在这里，这是正确的分层。
- `src/runner/pi.ts`：strict 门改成「该 provider/api 必须有已注册的请求契约」，payload 检查与契约断言
  全部走注册表，文件里不再出现 `deepseek` 字样（除下面这一处）。

## 剩余耦合（有意保留）

`PiSessionRunnerOptions.campaignBudget` 的类型仍是 `DeepSeekCampaignBudget`。它只服务已停用的 GitHub
Actions 私有 campaign 链路，而本轮范围明确要求不改那条链路的文件；抽接口会连带改 `scripts/manual-private-campaign.ts`。
记在报告里，由主会话决定是否单独处理。

## 验证

- `tsc --noEmit` 0 错误；`test/runner/*.test.ts` 60 通过 0 失败 1 跳过（含 DeepSeek 契约、campaign 记账、
  传输诊断、上下文容量重试等原有用例，全部未改断言）。
