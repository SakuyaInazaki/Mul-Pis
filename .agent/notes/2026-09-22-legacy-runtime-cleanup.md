# 2026-09-22 清理旧的 pre-rsi-runtime 副本

## 目标

- 目标目录：/Users/sakimi/Desktop/rsi-test/pre-rsi-runtime
- 原因：该目录是早期独立运行时副本，当前 #6 工作流从项目根 /Users/sakimi/Desktop/[WF]Pre-RSI 启动，不读取它。
- 旧副本自身带独立的 .agent/private/deepseek/credentials.json、workspaces、.monitor/xpuoj-1 等历史材料。

## 操作

- 先做外部归档：
  - /Users/sakimi/Desktop/rsi-test/archives/pre-rsi-runtime-20260922T051407Z.tar.gz
  - 权限 0600
  - gzip 完整性检查通过
- 归档完成后删除原目录。
- 复查原目录不存在。

## 可恢复性

- 可从上述 tar.gz 归档完整恢复。
- 归档位于 rsi-test 目录，不在公开仓库中。

## 边界

- 未修改公开仓库代码。
- 未推送任何内容。
- 本地记录，未推送。
