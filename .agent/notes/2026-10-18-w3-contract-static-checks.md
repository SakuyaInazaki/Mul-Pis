# 生成后、编译前的契约静态检查

## 为什么

依据里这一项的性价比最高：昇腾实测 51.9% 的失败是签名与重载问题、74.8% 的失败含 `no member named`，
而这类错误完全可以在本地、零设备成本地驳回。项目此前没有任何 API 白名单、没有生成后静态匹配、
也没有幻觉 API 的驳回计数；硬件数值约束（UB 预算、对齐、队列配平）同样只能靠模型自觉。

## 改了什么

- 新增 `src/knowledge/static-checks.ts`：由 `contract` 卡驱动的两类确定性检查。
  - API 签名：从源码里提取限定调用（`A::b(...)`、`a.b(...)`），只在契约卡覆盖的命名空间内判定；
    未知符号本地驳回并按编辑距离给出最接近的合法签名，未覆盖的命名空间记为 uncovered 不作判定。
  - 数值约束：按 at_most / at_least / multiple_of / equals 核对声明值，违反时返回带单位和出处的
    witness；没有对应声明值的约束记为 constraint-unchecked，绝不当作通过。
  - 组合报告的状态只有 reject / pass / inconclusive 三种，inconclusive 是结果而不是通过。
- `src/m07/execution-knowledge.ts`：新增 `knowledge_contract_check` 工具（需要任务 work 目录）。
  它按本任务冻结快照取契约卡，先用情境标量硬过滤（别的后端/工具链的约束不能驳回本候选），
  再按实时限制排除 not_allowed 的记录，最后输出检查报告。调用走既有审计路径，冻结存档为知识访问
  事件（kind=check，content=contract-check）。

## 跨归属改动（需主会话知悉）

- `src/m07/controller.ts`：创建执行工具时多传一个 `candidateRoot: workDir`（一处属性，W2 归属）。
- `src/m07/feedback.ts`：知识访问内容标签表补一行 `contract-check`（一行，W2 归属）。

## 验证

- 类型检查 0 错误。
- 新增 `test/knowledge/static-checks.test.ts` 3 项；`test/m07-execution-knowledge.test.ts` 新增 1 项，
  覆盖未知 API 驳回与最接近签名、超预算 witness、别的后端契约不参与判定、冻结事件字段、
  路径逃逸与参数互斥的拒绝。全文件 15 项通过。

## 限制

- 覆盖面完全取决于库里有多少 `contract` 卡；没有卡时结果是 inconclusive，不是通过。
- 调用检查是执行会话的主动行为；把它变成编译前的强制门需要改候选评估链路（W1 归属）。
