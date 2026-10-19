/**
 * Deterministic write-back gate for optimization knowledge cards.
 *
 * Merging a proposal is not a truth certificate, but it must still be an
 * *anchored* act: a card may only enter the store when its claim is tied to a
 * signal the harness itself produced (a host-verified measurement, a counted
 * attempt history, a local document citation). Everything here is code: no
 * model decides admission, and no threshold is applied to a number the model
 * wrote about itself.
 *
 * The thresholds below are explicit knobs with literature defaults, not
 * calibrated project constants. They are meant to be scanned on this project's
 * own baseline and the result recorded; see docs/implementation/design.md.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { optimizationDirectionSignature, readOptimizationCard, type OptimizationCard } from "./optimization-card.ts";
import type { KnowledgeRecord } from "./types.ts";

export interface AdmissionPolicy {
	/** Asymmetric thresholds: a positive case needs this speedup ... */
	positiveSpeedup: number;
	/** ... and a negative entry needs at least this much regression. Anything
	 * between the two is the noise band and is not knowledge. */
	negativeRegression: number;
	/** Few-shot exemplars are held to a much higher measured bar. */
	exemplarSpeedup: number;
	/** Repeated timings required before a measurement counts at all. */
	minRepeats: number;
	/** A direction tried this often with a success rate below the next value
	 * belongs in the negative layer, not in the positive one. */
	avoidAttempts: number;
	avoidSuccessRate: number;
	/** Capacity per (canonicalFamily, kind). Retrieval quality degrades long
	 * before storage does, so the cap is small on purpose. */
	familyCapacity: number;
	/** When set, a measurement's verifier must be one of these. */
	trustedVerifiers?: readonly string[];
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
	positiveSpeedup: 1.05,
	negativeRegression: 1.20,
	exemplarSpeedup: 2.0,
	minRepeats: 3,
	avoidAttempts: 3,
	avoidSuccessRate: 0.3,
	familyCapacity: 24,
};

export interface ExistingCard {
	/** `C001@2`. */
	ref: string;
	id: string;
	version: number;
	card: OptimizationCard;
	/** Records under a live limit or otherwise not evictable by a new proposal. */
	protected: boolean;
}

export type AdmissionVerdict = "admit" | "replace" | "reject";

/** Which gate each card passed, recorded per decision so an admitted entry can
 * later be shown to have been through the anti-cheat and threshold checks and
 * not merely to have been structurally legal. */
export interface AdmissionChecks {
	antiCheat: boolean;
	thresholds: boolean;
	notDuplicate: boolean;
	withinCapacity: boolean;
}

export interface AdmissionDecision {
	verdict: AdmissionVerdict;
	checks: AdmissionChecks;
	/** For `replace`: the existing record this card must revise instead of duplicating. */
	replaces?: string;
	/** For `reject` by capacity: the weakest existing entries, named so the
	 * proposer can retire one explicitly rather than letting the store silently drop it. */
	evictionCandidates?: string[];
	reasons: string[];
}

/** A model may not write its own credit counters: they are host-maintained
 * evidence of use, and self-assigned credit would defeat the purpose. */
function creditIssues(card: OptimizationCard): string[] {
	const credit = card.credit;
	if (!credit) return [];
	return credit.injections || credit.adoptions || credit.benefitSamples
		? ["credit 由宿主按实际注入与采纳维护；提案中不得写入非零计数"] : [];
}

const SELF_REPORTED = /(模型|自述|self|model|agent|session|claimed)/iu;
const SHORTCUT = /(fall\s*-?\s*back|回落|回退到\s*(torch|pytorch|厂商|vendor)|torch\.|except\s*:\s*pass|skip\s+(the\s+)?(compute|computation|kernel)|跳过计算|直接返回(零|输入)|return\s+(zeros|input)\b)/iu;

/** Cheating that an effect threshold cannot see: a measured, reproducible
 * speedup obtained by not doing the work. This filter is a tripwire, not a
 * proof of honesty; it exists because the reward signal alone never catches it. */
function antiCheatReasons(card: OptimizationCard): string[] {
	const reasons: string[] = [];
	if (card.kind !== "case") return reasons;
	const surfaces = [card.diff.summary, card.diff.before ?? "", card.diff.after ?? "", card.rootMechanism, card.causalChain];
	if (surfaces.some(part => SHORTCUT.test(part)))
		reasons.push("改动描述含回落厂商库/跳过计算一类捷径特征；效果阈值挡不住规格漏洞型作弊，须由独立校验说明后再提");
	if (SELF_REPORTED.test(card.measurement.verifier))
		reasons.push("measurement.verifier 像是模型自述而非宿主校验组件");
	return reasons;
}

function measurementReasons(card: OptimizationCard, policy: AdmissionPolicy): string[] {
	const reasons: string[] = [];
	if (card.kind !== "case" && !(card.kind === "avoid" && card.measurement)) return reasons;
	const measurement = card.kind === "case" ? card.measurement : card.measurement!;
	if (measurement.repeats < policy.minRepeats)
		reasons.push(`实测重复次数 ${measurement.repeats} 少于 ${policy.minRepeats}，单次计时不作入库依据`);
	if (policy.trustedVerifiers && !policy.trustedVerifiers.includes(measurement.verifier))
		reasons.push("measurement.verifier 不在本工作区登记的宿主校验组件内");
	return reasons;
}

function positiveReasons(card: OptimizationCard, policy: AdmissionPolicy): string[] {
	if (card.kind !== "case") return [];
	const reasons: string[] = [];
	const { speedup, correctness } = card.measurement;
	if (correctness !== "verified")
		reasons.push(`正例必须先通过正确性校验，当前为 ${correctness}；更快但不正确只能作为负例或不入库`);
	if (speedup <= 1 / policy.negativeRegression)
		reasons.push(`实测为 ${(1 / speedup).toFixed(3)}× 退化，达到负例阈值；应以 kind="avoid" 记录被否方向，而不是正例`);
	else if (speedup < policy.positiveSpeedup)
		reasons.push(`实测 ${speedup.toFixed(3)}× 落在噪声带（正例阈值 ${policy.positiveSpeedup}×、负例阈值 ${policy.negativeRegression}× 退化之间），不入库`);
	if (card.exemplar && speedup < policy.exemplarSpeedup)
		reasons.push(`few-shot 范例要求实测不低于 ${policy.exemplarSpeedup}×，当前 ${speedup.toFixed(3)}×`);
	return reasons;
}

function negativeReasons(card: OptimizationCard, policy: AdmissionPolicy): string[] {
	if (card.kind !== "avoid") return [];
	const reasons: string[] = [];
	const rate = card.successes / card.attempts;
	const statistical = card.attempts >= policy.avoidAttempts && rate < policy.avoidSuccessRate;
	const measured = card.measurement
		? card.measurement.speedup <= 1 / policy.negativeRegression
		: card.lossMagnitude !== undefined && card.lossMagnitude >= policy.negativeRegression;
	if (!statistical && !measured)
		reasons.push(`负例需要实测退化不小于 ${policy.negativeRegression}×，或至少 ${policy.avoidAttempts} 次尝试且成功率低于 ${(policy.avoidSuccessRate * 100).toFixed(0)}%`);
	return reasons;
}

function strength(card: OptimizationCard): number {
	if (card.kind === "case") return card.measurement.speedup;
	if (card.kind === "avoid") return card.lossMagnitude ?? 1 + card.attempts / 1000;
	if (card.kind === "rule") return card.frequency;
	if (card.kind === "contract") return card.constraints.length + (card.signature ? 1 : 0);
	return card.allowedMethods.length;
}

function evictionOrder(existing: ExistingCard[]): string[] {
	return [...existing].filter(item => !item.protected && item.card.kind !== "avoid")
		.sort((left, right) => (left.card.credit?.adoptions ?? 0) - (right.card.credit?.adoptions ?? 0) ||
			(left.card.credit?.injections ?? 0) - (right.card.credit?.injections ?? 0) ||
			strength(left.card) - strength(right.card) || left.ref.localeCompare(right.ref))
		.map(item => item.ref);
}

export interface AdmissionRequest {
	card: OptimizationCard;
	/** Cards already published in the store. */
	existing: readonly ExistingCard[];
	/** Record this proposal revises, if any: a revise of the duplicate target is
	 * the intended way to replace an entry. */
	revisingId?: string;
	policy?: AdmissionPolicy;
}

/** One card, one deterministic verdict. Reasons are bounded and never echo the
 * proposer's own prose back as justification. */
export function evaluateCardAdmission(request: AdmissionRequest): AdmissionDecision {
	const policy = request.policy ?? DEFAULT_ADMISSION_POLICY;
	const card = request.card;
	const checks: AdmissionChecks = { antiCheat: true, thresholds: true, notDuplicate: true, withinCapacity: true };
	const cheating = [...creditIssues(card), ...antiCheatReasons(card)];
	const thresholds = [...measurementReasons(card, policy), ...positiveReasons(card, policy), ...negativeReasons(card, policy)];
	checks.antiCheat = !cheating.length;
	checks.thresholds = !thresholds.length;
	if (cheating.length || thresholds.length) return { verdict: "reject", checks, reasons: [...cheating, ...thresholds] };

	const signature = optimizationDirectionSignature(card);
	const duplicates = request.existing.filter(item => optimizationDirectionSignature(item.card) === signature &&
		item.id !== request.revisingId);
	if (duplicates.length) {
		checks.notDuplicate = false;
		const strongest = duplicates.reduce((best, item) => strength(item.card) >= strength(best.card) ? item : best);
		if (strength(card) > strength(strongest.card))
			return { verdict: "replace", checks, replaces: strongest.ref,
				reasons: [`已有同方向条目 ${strongest.ref}，本卡证据更强；用 revise ${strongest.id} 替换，不要新建近重复条目`] };
		return { verdict: "reject", checks, replaces: strongest.ref,
			reasons: [`已有同方向条目 ${strongest.ref} 且证据不弱于本卡；近重复条目会占满检索结果，不入库`] };
	}

	const family = request.existing.filter(item => item.card.canonicalFamily === card.canonicalFamily &&
		item.card.kind === card.kind && item.id !== request.revisingId);
	if (!request.revisingId && family.length >= policy.familyCapacity) {
		checks.withinCapacity = false;
		const candidates = evictionOrder(family).slice(0, 3);
		return { verdict: "reject", checks, evictionCandidates: candidates,
			reasons: [`结构族 ${card.canonicalFamily} 的 ${card.kind} 条目已达容量上限 ${policy.familyCapacity}；先按证据显式停用或修订最弱条目再提新卡`,
				...(candidates.length ? [`按采纳与注入计数最弱的候选：${candidates.join("、")}`] : ["没有可淘汰条目：现存条目都是负例或处于生效限制下"])] };
	}
	return { verdict: "admit", checks, reasons: [] };
}

export interface AdmissionReceiptV1 {
	version: 1;
	kind: "knowledge-admission";
	proposalId: string;
	at: string;
	policy: AdmissionPolicy;
	decisions: Array<{ opIndex: number; cardKind: OptimizationCard["kind"]; signature: string;
		verdict: AdmissionVerdict; checks: AdmissionChecks; reasons: string[] }>;
}

/** The admission rate is the point of the gate: a store that admits everything
 * it is offered has no gate, whatever its thresholds say. */
export function summarizeAdmissionRate(receipts: readonly AdmissionReceiptV1[]): {
	proposed: number; admitted: number; rejected: number; replaced: number; rate: number } {
	const decisions = receipts.flatMap((receipt) => receipt.decisions);
	const admitted = decisions.filter((item) => item.verdict === "admit").length;
	const replaced = decisions.filter((item) => item.verdict === "replace").length;
	return { proposed: decisions.length, admitted, replaced,
		rejected: decisions.length - admitted - replaced,
		rate: decisions.length ? admitted / decisions.length : 0 };
}

/** Read every frozen admission receipt under a store directory. Unreadable or
 * foreign files are skipped, never guessed into decisions. */
export async function readAdmissionReceipts(storeDir: string): Promise<AdmissionReceiptV1[]> {
	const dir = path.join(storeDir, "proposals");
	let names: string[];
	try { names = (await readdir(dir)).filter((name) => /^P\d{4,}\.admission\.json$/u.test(name)).sort(); }
	catch { return []; }
	const receipts: AdmissionReceiptV1[] = [];
	for (const name of names) {
		try {
			const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as AdmissionReceiptV1;
			if (parsed.version === 1 && parsed.kind === "knowledge-admission" && Array.isArray(parsed.decisions)) receipts.push(parsed);
		} catch { continue; }
	}
	return receipts;
}

/** Collect the published cards a gate needs, with their protection state. */
export function collectExistingCards(records: readonly KnowledgeRecord[], protectedIds: ReadonlySet<string>): ExistingCard[] {
	const cards: ExistingCard[] = [];
	for (const record of records) {
		const card = readOptimizationCard(record.fields);
		if (!card) continue;
		cards.push({ ref: `${record.id}@${record.version}`, id: record.id, version: record.version, card,
			protected: protectedIds.has(record.id) || protectedIds.has(`${record.id}@${record.version}`) });
	}
	return cards;
}
