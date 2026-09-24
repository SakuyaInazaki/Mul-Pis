# 2026-09-22 统一文本媒体分类

## 问题

- `Workspace.readRawInfo()` 只用 `\.(md|txt|markdown)$` 判定 raw 文本。
- `src/m07/controller.ts` 的 `TEXT_EXTENSIONS` 却把 `.json`、`.csv`、`.yaml` 等视为文本。
- 结果 raw `.json` 被记录成“非文本原始信息”，与工作流其他部分的分类不一致。

## 修复

- 新增 `src/media.ts`，统一维护 `TEXT_EXTENSIONS`、`isTextFile()` 和 `mediaType()`。
- `src/workspace.ts` 的 `readRawInfo()` 改用共享 `isTextFile()`。
- `src/m07/controller.ts` 移除本地重复分类，改用共享 `mediaType()`。
- 新增 `test/raw-info.test.ts` 覆盖 JSON 被读取、PNG 仍被列为 skipped。

## 验证

- `npm run typecheck` 通过。
- `npm test` 通过：130 tests，0 fail。

本地记录，未推送。
