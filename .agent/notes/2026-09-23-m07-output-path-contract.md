# M07 产物路径契约收口

- 日期：2026-09-23
- 范围：通用 M07 extension 接口、设计说明与离线回归；未修改研究工作区或既有运行记录。

## 取舍与变更

- 撤回尚未提交且没有后端持久化语义的 `{ path, description? }` 形式，`expectedOutputs` 统一为精确相对路径字符串数组。
- 人类说明继续放在 objective 或任务报告中，不混入路径。
- 设计说明收窄为控制器可验证的保证：委派时校验声明路径，评审时只接受真实位于任务 work 目录内的声明产物。
- 明确 execution bash 不是 OS 沙箱；提示要求其余写盘留在 work，但控制器不声称可以阻止或枚举所有越界副作用。

## 验证

- `node --test --test-concurrency=1 test/m07-expected-output.test.ts test/pi-extension.test.ts test/stages.test.ts`：27/27 通过。
- `npm run typecheck`：通过。
- 相关文件 `git diff --check`：通过。
- 全部测试使用 fake runner，没有调用模型或网络。

## 发布边界

本记录位于 `.agent/notes/`，依照项目策略仅保留在本地，不提交或推送。
