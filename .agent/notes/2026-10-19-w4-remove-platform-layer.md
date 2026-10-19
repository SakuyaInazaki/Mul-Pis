# 2026-10-19 W4（第四轮）：删掉平台专用层，工作流回到平台中立

## 为什么

用户的决定：工作流应当保持泛用，不针对某一个硬件平台设置；平台规则属于实验工作区，不进可复用代码。
判断标准：可复用代码、提示词、文档里凡是只对某个平台成立的规则、常数、默认值或分支一律删除，
平台无关的通用机制保留。

## 删掉了什么

- `src/platform/`（档案加载与 probe 回执校验、规则引擎与静态写入门、机械诊断与瓶颈标签、设备租约、
  闸门与回执）整目录，连同 `test/platform/`、`test/runner/platform-execution.test.ts`。
- `src/runner/pi.ts` 里的平台门：`PRE_RSI_PLATFORM_PROFILE` 绑定、写盘前驳回、按档案串行化设备命令、
  工具输出的平台解读、harness 回执里的 `platformProfile` 字段，以及只服务该门的两个辅助函数
  （edit 结果重放、读当前文件）。
- `src/runner/failure-class.ts` 的 `platformClass` 输入与 `runner.platform-contract` / `platform.device-lease`
  两个分支：三分类本身（基础设施 / 策略 / unjudged）是通用机制，保留。
- `src/m07/platform-task-contract.ts`（含同源的首筛实现）与其测试。
- `scripts/local-operator-stage.py`：`platform-three-region` 容差模式、三区判定与区域计数、
  平台绑定对 `SPEC.timing` / `SPEC.cases` 的覆盖、worker 之间的 `platformBinding` 传递、收据里的
  `platformBinding` 与 `threeRegion` 字段。`verdict_for` 退化成只调用 `oracle_verdict`，一并去掉。
- `src/m07/profile-bottleneck.ts` 里走平台档案的分支与 `actions`/`platformId` 字段；
  ncu/msprof 口径的通用三吞吐判定保留。
- `src/m07/local-operator-backend.ts`：`platformProfilePath`/`platformDtype`/`platformPublicCases` 选项、
  派生绑定、测量阶段的设备租约、按档案的失败分类与符号路由、收据里的平台字段。
- `src/m07/evaluation-cache.ts`：缓存键去掉来自平台档案的 `platformKey` 与 `protocolVersion`，
  保留后端 id/版本、协议、工作对象、阶段、规范化源码摘要、契约摘要与用例集。
- `src/m07/search-state/`：事件与状态里的 `platform` 标签、热启动的「跨平台不可比」判定。热启动改成
  统一口径：历史线索是**起点**，文本里明说要在当前条件下重测后才能引用。
- `src/m07/prompt-layout.ts` 的 `hardware` 段（只由平台档案填充）与控制器里对应的那一行映射
  （这两个文件归 W2，只做了这处最小改动）。
- 文档：删掉 `docs/implementation/platform.md`、`local-operator-contract.md` 的平台档案一节与
  「不含昇腾口径」那句、`search-state.md` 的平台段落；`AGENTS.md` 去掉平台档案那一句，并把 harness
  回执字段清单里的 `platform profile` 去掉。

## 保留了什么

确定性悬崖压缩、失败三分类、供应商请求契约注册表、搜索事件日志与跨会话热启动、工具面收敛、
有界评估队列、评估缓存与知识卡片静态门，以及 0cf09d3 原有的 ncu/msprof CSV 导入。

## 验证

- `tsc --noEmit` 0 错误；`local-operator-stage.py` 语法检查通过。
- 整词 grep（`cann|ascend|ascendc|npu|昇腾`）在本轮负责的文件里无残留；剩余命中都在别人的文件里：
  W2 的 `candidate-policy.ts` 两处平台相关默认值注释、W1 的 `candidate-performance.ts` 的 msprof 导入
  （用户另行决定）、W3 知识层里作为调用语法示例的注释与测试取值。
- 全量测试见提交说明。
