# W2：M08/M09 的声明式规格入口

## 为什么

依据 RB-A13-04（P1，**仅声称**，spec 格式本身无消融）：规格应当是可被脚本解析的声明式文件，
最小字段集含来源与许可、验证方式与容差、可见/不可见文件、anti_cheat 模式等；
条件与注意里明确「spec 框架再好，oracle 弱则结论无效」——某套件只有 7/87（8%）的 spec 有 medium/strong oracle。
改之前，M08/M09 的选项只能由调用方在 TypeScript 里拼出来，CLI 要分别传 `--materials`、`--self-checks`、
`--reviewers` 等分项参数，新增一类复核任务没有「写一份规格就能跑」的路径，oracle 强度也无处登记。
（由 W5 在审查中发现并移交：issues/W5-05。）

## 改了哪里

- 新增 `src/stage-spec.ts`：`parseStageSpec` / `loadStageSpec` 校验 M08、M09 两种规格的信封与自有字段
  （版本、阶段、provenance 的 oracleStrength + source + 可选 license/notes），阶段专有的选项结构仍由阶段自己校验；
  `stageSpecNotice` 把来源、许可与 oracle 强度打印到控制台，weak/none 时明确提示结论强度受限。
- `src/cli.ts`：`m08`、`m09` 支持 `--spec <json>`，省略时完全沿用原有分项参数；用法说明同步。

## 限制（仍留在 issues/W5-05）

anti_cheat 的 blocked/required patterns、验证模式与容差、可见/不可见文件这几项需要 M08/M09 阶段内部支持
（`src/stages/m08.ts`、`m09.ts` 按文件归属属于 W5）。本次只做入口层的规格化与来源/oracle 登记，
不在阶段内放任何未被执行的字段，避免死代码。

## 验证

- 类型检查 0 错误；新增一项 CLI 测试：一份规格跑通 M08、oracle 强度被打印并带受限提示、
  缺 provenance 与阶段不匹配的规格被拒。
