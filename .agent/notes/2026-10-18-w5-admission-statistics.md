# 改进层准入：headroom 筛选、token 口径、成对符号检验与入库率

## 为什么

- RB-A9-07（P1）：在饱和任务上做 A/B 等于量噪声，每次 A/B 必须先报 headroom 分布。实证是一次预注册 A/B（n=20/臂）测到效应为零（2.4840ms vs 2.4957ms），两臂都在第 1 次迭代就撞上同一堵墙。
- RB-A9-06（P0）：改进提案的验收要预注册、冻结协议、**配对检验并报 n**，预算单位统一用 **token** 而不是轮数或墙钟。依据同时指出全批 172 篇只有 3 处做了统计检验。
- RB-A9-11 / RB-A13-06（P1，互相矛盾）：同一机制在不同模型上方向会相反（GEPA 的 Merge 在一个模型上 +、在另一个上把 IFBench 从 38.61 砍到 28.23）。任何「某配置更好」的结论必须记录它属于哪个模型。
- RB-A9-02（P0）：入库门禁要能被量化成入库率，并且入库率必须明显低于 100%（roundtrip 60–80%、谱系约 13%）。

改动前：准入判定把**所有**案例的配对成本差一视同仁，包括两条策略投影完全相同、两臂跑同一段提示的案例；结果里没有 n、没有任何检验量、没有 token 口径的预算、没有模型标识；`status()` 也没有入库率。

## 改了哪里

- `src/improvement/admission.ts`
  - `AdmissionResult` 新增 `model`、`baselineTokens` / `candidateTokens`、`headroom{cases,triggeredCases,untriggeredCaseIds}`、`paired{n,candidateCheaper,candidateCostlier,tied,signTestTwoSidedP}`。
  - 判定只采用触发案例的配对；未触发案例仍完整记录，但不参与判定，理由写在代码注释里。
  - 新增导出的纯函数 `pairedStatistics()`：精确双侧符号检验，持平配对按检验要求排除在 n 之外，整数递推算二项系数，无依赖、可单独测试。
  - 接受理由改为写明「多少个触发配对里有多少个更省，以及 p 值」，不再只说「成本下降」。
- `src/improvement/types.ts` / `service.ts`：`ImprovementStatus` 增加 `admissionRate`（尝试、晋级、驳回、未定、其他、晋级率），由历史 run 的 attempts 确定性统计。
- 测试：`test/improvement.test.ts` 新增两项——符号检验的边界（空、全持平、单向 5 对 p=0.0625、6 对中 1 次反向 p=0.21875、1 对 1 反向 p=1），以及一次真实 campaign 后回执里的模型、token、headroom、成对统计与 `status().admissionRate` 自洽。
- 文档：`docs/implementation/rsi.md` 的准入段落与入口清单。

## 验证

- 类型检查 0 错误；`test/improvement.test.ts` 8/8。
- 全量测试结果见本批次最后一个提交对应的 note。

## 边界

符号检验的 p 值只描述这批配对的方向一致程度，不是科研收益的证据，也不能跨模型外推。依据里的「外部锚定」（按他人协议复现、±10% 内通过）需要真实模型与他人协议，这里做不了，留在 issue 里。
