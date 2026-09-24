# 本地 TypeScript 命令入口修复

- `node_modules/typescript` 已链接到仓库内现有的 Pi 依赖树，TypeScript 版本为 5.9.3，包内 `bin/tsc` 可执行。
- 本机缺少 npm 脚本所需的 `node_modules/.bin/tsc`；已创建 `.bin` 目录并补充指向 `../typescript/bin/tsc` 的相对符号链接。
- 未运行 `npm install`，未访问网络，也未修改 tracked 源码或配置。
- 使用仅包含本项目 `.bin`、本机 Node/npm 与系统基础命令的 PATH 验证：`command -v tsc` 命中项目本地入口，`npm run typecheck` 成功退出。
- `node_modules/` 已由 `.gitignore` 排除；此修复仅属于本机依赖布局，可通过删除新增符号链接恢复。
