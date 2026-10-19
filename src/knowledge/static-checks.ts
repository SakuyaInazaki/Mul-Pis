/**
 * Deterministic checks that run after generation and before compilation, at
 * zero device cost.
 *
 * Two things are machine-checkable without a kernel ever running: whether a
 * called API exists in the toolchain's own signature list, and whether a
 * declared numeric budget (buffer bytes, alignment, queue depth) satisfies a
 * hard constraint that was recorded with a local citation. Both come from
 * `contract` cards; nothing here knows anything about a platform by itself.
 *
 * The checks fail closed on what they cover and stay silent on what they do
 * not: a symbol from a namespace no contract card describes is reported as
 * unknown, never as a hallucination. A check that cannot see the evidence it
 * needs returns `inconclusive`, which is a result, not a pass.
 */
import type { OptimizationCard, OptimizationConstraint } from "./optimization-card.ts";

export interface ApiContract {
	api: string;
	signature: string;
	source: string;
}

export interface StaticFinding {
	code: "unknown-api" | "constraint-violated" | "constraint-unchecked";
	message: string;
	/** Exactly what was observed, so the finding can be located without rerunning. */
	witness: string;
	/** Closest legal signature, when one exists. */
	suggestion?: string;
}

export interface StaticCheckReport {
	status: "pass" | "reject" | "inconclusive";
	findings: StaticFinding[];
	/** Symbols matched against a contract card. */
	checkedSymbols: string[];
	/** Symbols in namespaces no contract card covers; not judged. */
	uncoveredSymbols: string[];
}

/** Qualified call sites: `Ns::Symbol(...)`, `mod.symbol(...)`, `buf.alloc(...)`. */
const CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)(?:::|\.)([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^;{}()]*>)?\s*\(/gu;

export function collectApiContracts(cards: ReadonlyArray<{ card: OptimizationCard }>): ApiContract[] {
	const contracts: ApiContract[] = [];
	for (const { card } of cards)
		if (card.kind === "contract" && card.api && card.signature)
			contracts.push({ api: card.api, signature: card.signature, source: card.source });
	return contracts;
}

function distance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const next = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = previous[j];
			previous[j] = next;
		}
	}
	return previous[right.length];
}

/** Reject a call only inside a namespace the contract cards actually describe. */
export function checkApiSymbols(source: string, contracts: readonly ApiContract[]): StaticCheckReport {
	const known = new Map(contracts.map((item) => [item.api, item]));
	const namespaces = new Set([...known.keys()].flatMap((api) => {
		const separator = api.lastIndexOf("::") >= 0 ? "::" : ".";
		const index = api.lastIndexOf(separator);
		return index > 0 ? [api.slice(0, index)] : [];
	}));
	const findings: StaticFinding[] = [];
	const checkedSymbols: string[] = [];
	const uncoveredSymbols: string[] = [];
	const seen = new Set<string>();
	for (const match of source.matchAll(CALL_PATTERN)) {
		const separator = match[0].includes("::") ? "::" : ".";
		const symbol = `${match[1]}${separator}${match[2]}`;
		if (seen.has(symbol)) continue;
		seen.add(symbol);
		if (known.has(symbol)) { checkedSymbols.push(symbol); continue; }
		if (!namespaces.has(match[1])) { uncoveredSymbols.push(symbol); continue; }
		const nearest = [...known.keys()].map((api) => ({ api, score: distance(api, symbol) }))
			.sort((left, right) => left.score - right.score || left.api.localeCompare(right.api))[0];
		findings.push({ code: "unknown-api", witness: symbol,
			message: `命名空间 ${match[1]} 已有登记签名表，但其中没有 ${symbol}；编译前本地驳回，不消耗设备时间`,
			...(nearest ? { suggestion: known.get(nearest.api)!.signature } : {}) });
		checkedSymbols.push(symbol);
	}
	return { status: findings.length ? "reject" : known.size ? "pass" : "inconclusive", findings, checkedSymbols, uncoveredSymbols };
}

export interface ConstraintObservation {
	name: string;
	value: number;
}

/** Numeric budgets: buffer bytes against a capacity, element counts against an
 * alignment, queue depths against a balance requirement. */
export function checkHardConstraints(observations: readonly ConstraintObservation[],
	constraints: readonly OptimizationConstraint[]): StaticCheckReport {
	const findings: StaticFinding[] = [];
	let checked = 0;
	for (const constraint of constraints) {
		const observed = observations.find((item) => item.name === constraint.name);
		if (!observed) {
			findings.push({ code: "constraint-unchecked", witness: constraint.name,
				message: `约束 ${constraint.name}（出处 ${constraint.source}）没有对应的实测/声明值；未检查不等于已满足` });
			continue;
		}
		checked++;
		const ok = constraint.comparison === "at_most" ? observed.value <= constraint.limit
			: constraint.comparison === "at_least" ? observed.value >= constraint.limit
			: constraint.comparison === "equals" ? observed.value === constraint.limit
			: constraint.limit !== 0 && observed.value % constraint.limit === 0;
		if (!ok) findings.push({ code: "constraint-violated", witness: `${constraint.name}=${observed.value}${constraint.unit}`,
			message: `违反硬约束：${constraint.name} 必须 ${constraint.comparison} ${constraint.limit}${constraint.unit}（出处 ${constraint.source}）` });
	}
	const violated = findings.some((item) => item.code === "constraint-violated");
	return { status: violated ? "reject" : checked === constraints.length && checked > 0 ? "pass" : "inconclusive",
		findings, checkedSymbols: [], uncoveredSymbols: [] };
}

/** One report for a candidate: API signatures plus declared numeric budgets. */
export function checkCandidate(input: { source?: string; observations?: readonly ConstraintObservation[] },
	cards: ReadonlyArray<{ card: OptimizationCard }>): StaticCheckReport {
	const contracts = collectApiContracts(cards);
	const constraints = cards.flatMap(({ card }) => card.kind === "contract" ? card.constraints : []);
	const api = input.source === undefined ? undefined : checkApiSymbols(input.source, contracts);
	const numeric = constraints.length ? checkHardConstraints(input.observations ?? [], constraints) : undefined;
	const findings = [...(api?.findings ?? []), ...(numeric?.findings ?? [])];
	const status: StaticCheckReport["status"] = findings.some((item) => item.code !== "constraint-unchecked") ? "reject"
		: api?.status === "pass" && (numeric === undefined || numeric.status === "pass") ? "pass" : "inconclusive";
	return { status, findings, checkedSymbols: api?.checkedSymbols ?? [], uncoveredSymbols: api?.uncoveredSymbols ?? [] };
}
