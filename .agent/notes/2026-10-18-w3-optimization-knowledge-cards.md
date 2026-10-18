# 结构化优化知识卡与确定性写回门禁

## 为什么

知识库原本只有七类认识记录（C/K/E/J/Q/D/X）。它们记录「项目相信什么、凭什么、现在还能不能用」，
但不承载「这个算子是怎么变快的」：没有 diff、没有适用与避免条件、没有 profile 证据，也没有任何
与实测挂钩的入库条件。`bottleneck`、`avoid_when` 这些字段名此前只在渲染和检索加权里被机会性地
读取，`fields` 本身不校验，于是：

- 同一条经验可以跨 dtype、跨后端被照抄，失效是静默的；
- 只要结构合法就能合入，入库率实际是 100%，噪声级加速和模型自述都能进库；
- 同方向的近重复条目可以无限增长，没有容量上限，也没有负例层。

调研依据对这一点的结论很硬：条目退化成纯文本时效果大幅下降；掺入少量未验证条目会让效果从
0.84 掉到 0.28；随机化记忆比完全没有记忆更差。因此入库必须锚定在可执行信号上。

## 改了什么

- 新增 `src/knowledge/optimization-card.ts`：`fields.optimization` 的精确结构与校验。五种 kind
  （case / avoid / rule / contract / when），统一的合法动作空间与瓶颈签名枚举，必填检索键
  （backend、toolchain 不可省略），硬件数值必须带本地出处，字段拼错按未知字段整批拒绝。
  另提供方向签名（去重用）与三段式渲染（Metadata / Rationale / Artifact）。
- 新增 `src/knowledge/admission.ts`：确定性写回门禁。非对称阈值（正例 ≥1.05×、负例退化 ≥1.20×、
  中间是噪声带）、最少重复次数、正确性前置、范例卡 ≥2.0×、独立于效果信号的反作弊过滤、同方向
  去重与「更强则替换」、按结构族的容量上限与最弱淘汰候选、credit 由宿主维护。
- `src/knowledge/store.ts`：create/revise 的 fields 增加卡片结构校验；合入入口在结构校验之后、
  应用之前执行门禁，拒绝写入 rejected 回执并抛错，门禁可在构造 store 时替换策略。
- `src/knowledge/retrieval.ts`：导出检索情境的键集合与非抛出式检查，供卡片校验复用，避免两处各
  维护一份标签表。
- 文档：`docs/implementation/design.md` 第 4 节补充卡片形态、门禁阈值与「阈值是旋钮不是已标定常数」。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：0 错误。
- `node --test test/knowledge/*.test.ts`：43 项通过，含新增 `test/knowledge/optimization-cards.test.ts`
  的 7 项（结构校验、各 kind 的锚点、阈值与噪声带、反作弊与自填 credit、去重与容量、渲染、
  经真实文件存储的合入拒绝与通过）。

## 限制

- 阈值取自文献默认值，没有在本项目基线上标定；真正的取值需要真机 A/B。
- 反作弊过滤是绊线，不是诚实性证明：效果阈值挡不住规格漏洞型作弊，这一点依据里有明确反例。
