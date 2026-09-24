# M07 evidence-handoff 单槽工程增量

本批在既有研究方法代际存储和 M07/M04 控制链之上增加显式 workflow bootstrap 与 run 入口。工作流 H 仅允许 evidence-handoff 槽；I 只能检查冻结开发证据、提出该槽候选并请求开发评价。准入采用独立工作区内成对新 M07/M04 会话、调用方给定的保护案例及控制器机械检查，缺独立 G、完整可见用量或严格配对收益即不晋级。

预算层新增带工具 Pi prompt 的串行额度预留和 SDK 可见事件结算。此结算无法在 SDK 单次 prompt 内物理截断调用，不能代表 provider 全账。离线验证涵盖服务全链、CLI bootstrap/入口失败闭合、真实 Pi runner 接本地 fake provider 两轮工具读取、CPU 原路径回归；没有调用真实模型或网络。真实 P3 开发 pilot、独立科学收益及递归继承仍待另行验证。
