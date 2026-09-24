# P3 工作流接入准备

- 仅建立 ignored 的 `workspaces/xpuoj-p3-mhc/`，明确复制正式题目、历史最佳已验源码、未提交 CHAS3、近期状态/ledger；未改 P3 原目录与令牌池。
- 使用既有 DeepSeek 角色配置的副本，三名 M03 reviewer 会话、concurrency=1。M01 的 problem/raw 只含正式题目。
- 私有 `.agent/private/p3-workflow-control/` 保存启动器、输出上限 profile、DeepSeek HTTP 请求闸与离线测试。此准备未发真实模型请求。
- 运行时临时 auth 副本的精确目标为 `.agent/private/p3-workflow-control/profile/auth.json`，来源为既有私有凭据文件，仅供 Pi native auth store；正常进程退出时删除，因可从原私有凭据再生而可恢复。异常残留需核实进程和归属后人工精确清理。凭据不注入 M07 bash 继承的环境。
- 同一进程实际 HTTP 请求上限 192、每请求 32768 输出，90 分钟、1.5 GiB 进程树 RSS、3 GiB 剩余磁盘、200 MiB 工作区增长；它不是 OS 沙箱，也不硬预留总 token/费用。

## 用户取消总请求与 wall 强停后的私有控制更新

- 上述 192 次与 90 分钟强停规则已被本轮用户请求取代。`provider-guard.mjs` 不再设置总请求上限，仍在旧 JSONL 后连续记录每次实际 HTTP 尝试/重试，并拒绝错误路线及单次超过 32768 的输出请求。状态文件明确写 `requestLimit: none` 与 JSON null 上限/剩余槽位，不用大整数假装无限。
- `launch.mjs` 每 90 分钟只写进度检查点通知。进程树 RSS、磁盘余量、累计工作区增长和全批主日志累计硬保护继续执行；旧运行若缺原始增长基线，续跑以 0 字节保守基线计算，不重置额度。临时 auth 存储与 SDK HTTP dispatcher 预加载保持原样。
- 旧进程启动时冻结了原规则，磁盘修改不热更新。安全续跑必须在已有阶段落盘且无活动任务的检查点由监控方停止旧进程，确认 lock/auth 清理，再以 `--continue --session <原Pi主会话JSONL绝对路径>` 显式接回同一会话。脚本自身不停止旧进程、不启动第二个并行 Pi。
- 离线 SDK/guard、重试与旧 ledger 连续、主/角色 auth 隔离、launcher 显式会话预检均通过；没有实际 DeepSeek 请求、平台提交或算法修改。

## M07 T002 宿主 RSS 中断后的监控补丁

- 旧 launcher 的 stop 仅记录 `process-tree-rss-over-1.5GiB`，没有逐进程样本，无法把原因归到 T002 的检查脚本或算法。T002 最后一条 bash toolResult 已落盘且未报工具错误；随后 session shutdown 被受控归档为失败。
- 只读静态检查该检查脚本的导入与进程调用：有一次 `subprocess.run` 启动 Python 子进程、未设置该调用的 timeout；没有从旧运行中取得当时各进程 RSS，因此只能列为可能的资源贡献途径，不能断言根因。
- 新私有 launcher 每轮将 `ps` 的 `pid/ppid/rss/comm` 转成有界 96 行的 `memory-latest.json`；只保留可执行程序名，不读取完整 argv。触及原 1.5 GiB 阈值时，先把同一内存样本、全树总量与阈值写入 `stop.json`，再执行既有终止动作。未提高阈值、清日志或更改候选任务。
- `continue.md` 明确上一次是宿主资源中断，旧失败 goal 不原位重试；继续使用同一主 Pi 会话，先 status，由 workflow 决定后续新 goal。私有 memory/launcher/guard 离线验证通过；本补丁未启动 Pi 或发网络请求。

## 用户撤销固定 RSS 硬停

- 第二次原会话恢复后的私有快照记录总 RSS 1,942,032 KiB，进程链为 Pi→bash→Python→Python；旧 1.5 GiB 宿主阈值再次终止进程。快照可确认进程资源归属，但不证明算法或脚本失败。
- 用户明确反对自行设置该内存上限。私有 launcher 删除所有按 RSS 数值触发的终止分支，不调高阈值或改杀某个子树；内存快照继续只用于观察。单次输出上限、HTTP 计账、磁盘与累计文件增长保护保持。
- 两次宿主中断及限制撤销已写入后续会话提示，已完成阶段不重跑，失败 goal 的后续处理由 workflow 自主判断。本次未启动流程或修改候选。
