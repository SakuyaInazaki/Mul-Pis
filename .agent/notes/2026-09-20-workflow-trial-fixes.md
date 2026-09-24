# 真实工作流试跑后的边界修复

一次真实题目的主 Pi 工作流试跑取得了局部阶段结果，同时暴露了主会话执行边界、重复失败控制、正常关闭后的状态、M04 知识身份与用途处置、M09 机器协议和核验材料可访问性等问题。该试跑没有严格完整通过 M01–M09，本批修复也不把局部成功提升为通用科研效果证明。

## 修复范围

- `src/pi/extension.ts`：区分 bootstrap/status/init 与实质研究操作的激活边界；激活后限制主 Pi 为研究编排与只读检查；正常 session shutdown 转交 service 记录由本实例拥有的活动阶段中断。
- `src/pi/service.ts`、`src/pi/retry-guard.ts`：为 extension/service 阶段调用记录有限重复失败控制；相同实际义务与相同失败连续出现时阻止原样盲重试；正常关闭按当前 service 在该 workspace 登记的全部精确 stage/runId 记录仍运行阶段，晚返回不能覆盖。CLI 仍直接调用阶段函数，M07 delegate 也不经过 stage service，均不在相应控制覆盖内。
- `src/runner/pi.ts`、`src/stages/context.ts`：为隔离会话增加统一的不可信数据边界；结束阶段前复读持久状态，避免正常 shutdown 已记录失败后被晚返回覆盖成完成。
- `src/m07/controller.ts`：正式 M07 只采用最新 M04；最新运行未完成、有失败或产生未合入提案时不回退旧基线，正式目标在委派和声明 fulfilled 前复核基线仍是最新。基线失效时 blocked/partial 仍可如实返回 M04，但转为非正式探索状态并披露限制。execute 任务先做本地兼容性预检并如实记录真实平台动作的资源消耗；新增外部研究资料仍返回 M05/M06→M04。
- `src/stages/m02.ts`：提示候选判据不得把 M01/M02 正文里的叙述编号当作已有知识 ID。
- `src/stages/m04.ts`：向研究会话明确正式知识 ID 与同批局部 handle 的身份规则；局部包没有相关旧 ID 时请求补足或保留待补证，不能重复创建绕过旧限制；M08 ready/partial 用途处置须由实际 fixed material 访问支持，不能只复述路径。
- `src/stages/m08.ts`：自查和外审按原问题及用户澄清解释验收范围，不把可选语言、工具或方法自动升级为义务，也不引入文件哈希核验。
- `src/stages/m09.ts`：统一 organizer/checker 的机器 schema 和控制器校验；`checked` 与真实 `unresolved` 继续 fail closed，显式非阻塞限制单独保存且不由未决自动转换；source trace 与移除原始命令文本但保留真实 stdout/stderr 的执行日志进入 checker 受控根并要求实际访问；原始 shell 命令只留私有审计，不进入 checker prompt；requested/actual 执行事实先于模型门禁解析落盘，失败或无效回复不能抹去实际执行。
- `docs/implementation/design.md`、`docs/research/workflow-foundation.md`：按实际代码更新当前承载、真实试跑状态和仍未保证的边界，没有改变工作流语义。
- `test/control-guard.test.ts`、`test/pi-extension.test.ts`、`test/runner/pi.test.ts`、`test/stages.test.ts`、`test/m07.test.ts`、`test/m08.test.ts`、`test/m09.test.ts`：补充主会话能力门禁、有限重试、shutdown/晚返回、隔离提示边界、正式基线、知识身份、验收范围、固定材料访问、M09 schema、证据读取、注入边界、未决门禁和失败执行摘要覆盖。

## 验证与限制

本批只运行离线测试与本地 TypeScript 检查；没有调用网络或真实模型。最终集成验证为：`npm test` 共 108 项测试、9 个 suite，108 pass、0 fail/cancelled/skipped/todo；`node third_party/pi/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 退出码 0；`git diff --check` 退出码 0 且无输出。

提示中的不可信数据声明只能降低材料、shell 注释和 stdout/stderr 的指令注入影响，不能保证模型行为；真正的收口仍依赖控制器结构校验、实际访问覆盖、不可变输入检查和 fail-closed 门禁。有限重复失败控制只覆盖 extension/service 路径，不覆盖当前直接阶段 CLI，也不提供跨进程锁、SIGKILL 恢复或自动重放。

本批没有修改原 `workflow/v1.0/`、旧试跑记录、`third_party/`、真实试跑产物、既有未提交脚本或 `package.json`；没有删除文件、提交或推送。
