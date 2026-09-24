# XPUOJ 132 有界试跑准备

- 目标：为题目 `https://xpuoj.com/p/132` 准备私有研究工作区与可监控、可取消的分阶段调用入口；未调用模型。
- 用户目标保持为：在遵守算子数学语义、允许误差、接口和赛题提交规则的前提下，尽可能提高平台 pass 与 score；禁止硬编码测试答案、读取隐藏基准或修改评测器等骗分手段。
- 题面尚待真实获取，因此不写入或猜测题意。
- 模型选择仅写入该私有工作区：所需角色使用 `deepseek/deepseek-flash:low`，并发为 1；不修改项目全局默认。
- 输出能力纠正：不修改 harness 核心或共享 DeepSeek profile。初次曾额外限制为 8192，M01 真实请求的 8193 token 全部用于 reasoning、visible text 为空并以 length 失败；随后临时提高为 32768，M01/M02 在该范围内成功。用户指出不应把正常输出能力调小后，已删除 workspace maxTokens override，恢复 `deepseek-flash` 官方 384000 上限（reasoning 与答案合计），thinking 保持 low。wrapper 不再断言旧 cap；600 秒 watchdog、取消与日志保留继续生效。
- 凭据来源：既有 ignored 私有 DeepSeek profile。task launcher 只在内存中读取并注入子进程环境，不复制或回显 key；本记录不包含机器绝对路径或凭据内容。
- 题面身份：用户确认正确标题为 `#132 Dynamic Quantize GeMM`；此前取得的另一内部记录/Fused RoPE 是错题，禁止进入工作区和模型输入。wrapper 对标题设置硬闸门。
- 纠正记录：误执行 `npm run harness -- init workspaces/xpuoj-132` 时，CLI 将位置参数忽略并在仓库根目录初始化。删除目标严格限于该命令报告为新建的根目录骨架：`problem/`、`stages/`、`references/`、`.agent/knowledge/`、`.agent/sessions/` 以及 `.agent/notes/2026-09-20-init.md`。这些内容均是刚创建的空目录或初始化模板，可由正确的 init 命令恢复；不删除任何既有用户文件。
