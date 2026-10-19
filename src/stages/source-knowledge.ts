/**
 * Turning external material into something the harness can check.
 *
 * M05 and M06 used to end in prose: an acquisition report, a reading record, a
 * check record and an applicability analysis. Prose cannot be retrieved by
 * bottleneck, cannot be filtered by backend, cannot be statically checked and
 * cannot be refused for lack of an anchor. The evidence on this is blunt:
 * principle-level documentation is close to worthless, while the same effort
 * spent turning material into runnable examples, exact API signatures and hard
 * numeric constraints is what moves first-round compile rates.
 *
 * So both stages keep their sessions and their reports, and additionally emit
 * one deterministic, validated structure: optimization cards (`src/knowledge/
 * optimization-card.ts`), a declared reading depth with an escalation reason,
 * and an explicit `inconclusive` outcome when a source yields nothing usable.
 * Nothing here adopts anything: M04 remains the only path into the store.
 */
import { validateOptimizationCard, type OptimizationCard } from "../knowledge/optimization-card.ts";

/** Four reading depths, in escalation order. Deeper is not better: the value of
 * a deep pass is usually ruling a direction out, not producing a rewrite. */
export const READING_DEPTHS = ["L1", "L2", "L3", "L4"] as const;
export type ReadingDepth = (typeof READING_DEPTHS)[number];

export const READING_DEPTH_TITLES: Record<ReadingDepth, string> = {
	L1: "模式分诊：材料直接给出可用模式、签名或硬约束",
	L2: "实测对照：须与本项目的测量或 profiling 结果对照才能判断",
	L3: "中间表示：须看 IR / 中间产物才能解释",
	L4: "编译器或库源码：须读实现才能解释",
};

export const CARD_BLOCK_TAG = "knowledge-card";
export const DEPTH_HEADING = "## 阅读深度";
export const CARD_HEADING = "## 可执行化产出";

export interface ExtractedCard {
	card?: OptimizationCard;
	issues: string[];
	/** Index of the block in the session output, for locating a rejected one. */
	ordinal: number;
}

export interface SourceExtraction {
	depth?: ReadingDepth;
	depthReason?: string;
	cards: ExtractedCard[];
	/** `actionable` when at least one card validated; `inconclusive` otherwise.
	 * An inconclusive source is a recorded result, not a failed one. */
	conclusion: "actionable" | "inconclusive";
	issues: string[];
}

function blocks(text: string): string[] {
	const found: string[] = [];
	const pattern = new RegExp("```" + CARD_BLOCK_TAG + "\\s*\\n([\\s\\S]*?)```", "gu");
	for (const match of text.matchAll(pattern)) found.push(match[1]);
	return found;
}

/** Parse what the applicability session declared. Anything unparseable is an
 * issue on the group, never a guessed card. */
export function extractSourceKnowledge(text: string): SourceExtraction {
	const issues: string[] = [];
	const cards: ExtractedCard[] = [];
	let ordinal = 0;
	for (const block of blocks(text)) {
		ordinal++;
		let parsed: unknown;
		try { parsed = JSON.parse(block); }
		catch { cards.push({ ordinal, issues: [`第 ${ordinal} 个 ${CARD_BLOCK_TAG} 代码块不是合法 JSON`] }); continue; }
		const items = Array.isArray(parsed) ? parsed : [parsed];
		for (const item of items) {
			const result = validateOptimizationCard(item);
			cards.push({ ordinal, issues: result.issues, ...(result.card ? { card: result.card } : {}) });
		}
	}
	const depthMatch = /(?:^|\n)\s*[-*]?\s*深度\s*[:：]\s*(L[1-4])/u.exec(text);
	const reasonMatch = /(?:^|\n)\s*[-*]?\s*升级理由\s*[:：]\s*([^\n]+)/u.exec(text);
	const depth = depthMatch ? depthMatch[1] as ReadingDepth : undefined;
	const depthReason = reasonMatch?.[1].trim();
	if (!depth) issues.push(`缺少「${DEPTH_HEADING}」中的「深度：L1–L4」声明`);
	else if (depth !== "L1" && !depthReason) issues.push(`声明深度 ${depth} 时必须写明升级理由：本层须定位出主导对象、把下一步收敛到唯一改写族，并能用本层证据辩护`);
	const valid = cards.filter((item) => item.card);
	return { ...(depth ? { depth } : {}), ...(depthReason ? { depthReason } : {}), cards,
		conclusion: valid.length ? "actionable" : "inconclusive", issues };
}

/** Appended to the M06 applicability message. Kept out of `prompts.ts` so the
 * workflow prompt files stay the workflow's own text. */
export function sourceExtractionInstruction(sourceId: string): string {
	return [
		`【${sourceId} 结构化抽取（宿主确定性校验）】`,
		`本会话除适用性分析外，还要输出 ${DEPTH_HEADING} 与 ${CARD_HEADING} 两个小节。`,
		`${DEPTH_HEADING} 写两行：「深度：L1|L2|L3|L4」与「升级理由：……」。深度含义：`,
		...READING_DEPTHS.map((depth) => `- ${depth} ${READING_DEPTH_TITLES[depth]}`),
		"L1 以外必须写升级理由，理由要说明本层定位出了什么、把下一步收敛到哪一个改写族、用本层哪条证据可以辩护；深层分析的价值通常是排除错误方向，不是直接给出改写。",
		`${CARD_HEADING} 下用零到多个 \`\`\`${CARD_BLOCK_TAG} 代码块给出 JSON（单个对象或对象数组），每个对象是一张结构化知识卡：`,
		'- kind="contract"：API 签名或硬数值约束。必须写 source（已登记来源 ID 如 S003，或工作区相对路径），不接受 URL、不接受凭记忆的数字。',
		'- kind="rule"：按确切错误签名的一句硬规则，带 frequency 与 evidence。',
		'- kind="case"：带 diff、硬约束、profile 证据与宿主实测的具体案例。资料里的加速数字不是本项目的实测，不能写进 measurement；没有本项目实测就不要出 case 卡。',
		'- kind="avoid"：被否方向，带 attempts/successes 或实测退化。',
		'- kind="when"：瓶颈 → 允许方法集与屏蔽规则。',
		"每张卡必须写 operatorCategory、canonicalFamily、bottleneck、applicability（backend 与 toolchain 必填，dtype/layout 按资料实际条件写）、provenance（kind=\"external-source\"，detail 指向本来源）。",
		"宁可一张卡都不出，也不要把只在论文条件下成立的结论写成本项目已成立的事实。没有可执行化产出时，该小节写「无」，本来源会被如实记为 inconclusive。",
		"卡片只是候选：宿主只做结构校验与记录，是否入库由 M04 按证据决定。",
	].join("\n");
}

/** Appended to the M05 acquisition protocol. */
export function acquisitionDeliverableInstruction(): string {
	return [
		`【可执行化产出要求】`,
		`获取报告必须另含小节「${CARD_HEADING}」，逐条写明本轮材料里可以转成下列三类形态的内容，并给出所在文件与位置：`,
		"- 可编译/可运行的范例（哪个文件、哪一段）；",
		"- 确切 API 签名（符号名与完整签名文本）；",
		"- 硬数值约束（容量、对齐、队列深度等，写明数值、单位与出处文件）。",
		"三类都没有就写「无」，并在「未解决缺口与续查建议」里说明还缺什么。原则级论述、综述性描述和没有数值的经验谈不计入本小节。",
		"硬件参数以本地取得的材料为准；联网检索到的数字必须落到已登记来源文件后才可引用，不作主信息源。",
	].join("\n");
}

export interface ExtractionReportV1 {
	version: 1;
	kind: "m06-source-extraction";
	sourceId: string;
	depth?: ReadingDepth;
	depthReason?: string;
	conclusion: SourceExtraction["conclusion"];
	accepted: Array<{ ordinal: number; cardKind: OptimizationCard["kind"]; canonicalFamily: string }>;
	rejected: Array<{ ordinal: number; issues: string[] }>;
	issues: string[];
}

export function extractionReport(sourceId: string, extraction: SourceExtraction): ExtractionReportV1 {
	return { version: 1, kind: "m06-source-extraction", sourceId,
		...(extraction.depth ? { depth: extraction.depth } : {}),
		...(extraction.depthReason ? { depthReason: extraction.depthReason } : {}),
		conclusion: extraction.conclusion,
		accepted: extraction.cards.flatMap((item) => item.card
			? [{ ordinal: item.ordinal, cardKind: item.card.kind, canonicalFamily: item.card.canonicalFamily }] : []),
		rejected: extraction.cards.flatMap((item) => item.card ? [] : [{ ordinal: item.ordinal, issues: item.issues }]),
		issues: extraction.issues };
}
