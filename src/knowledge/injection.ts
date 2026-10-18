/**
 * Stage- and phase-differentiated knowledge assembly.
 *
 * Before this module every call site built one large pack with its own hard
 * numbers (48/60000, 32/40000, 24/60000, 1e9 …) and handed the same block to
 * every session on every round. The assembly table replaces that with one
 * explicit plan per phase: which prior layers, which card kinds, how many
 * entries, how many characters, and whether the deterministic method menu is
 * part of the prompt.
 *
 * The numbers are knobs, not findings: they are deliberately small because a
 * long block dilutes the current topic, and they are in one place so they can
 * be scanned on this project's own baseline and changed by one edit.
 *
 * Every assembly also produces a receipt. Knowing which card actually entered
 * which prompt is what makes "did this entry ever help" answerable later; the
 * store itself stays append-only and is never mutated by an injection.
 */
import { renderOptimizationCard, readOptimizationCard, type OptimizationCardKind } from "./optimization-card.ts";
import { decideMethods, renderMethodMenu, type DecisionMetric, type DecisionPolicy, type MethodDecision } from "./decision-table.ts";
import { loadPriorLibrary, selectPrior, type PriorLayer, type PriorSelection } from "./prior-library.ts";
import { RETRIEVAL_FEATURE_KEYS, RETRIEVAL_SCALAR_KEYS, renderSelectedKnowledgeRecord, retrieveKnowledge,
	type KnowledgeRetrievalContext, type KnowledgeRetrievalSelection } from "./retrieval.ts";
import type { BottleneckSignature } from "./optimization-card.ts";
import type { KnowledgeRecord, KnowledgeStore, RecordType } from "./types.ts";

export const INJECTION_PHASES = ["bootstrap", "mutation", "compile-fix", "correctness-fix", "performance-tuning",
	"review", "acquisition", "applicability", "judgment"] as const;
export type InjectionPhase = (typeof INJECTION_PHASES)[number];

export interface InjectionPlan {
	phase: InjectionPhase;
	layers: readonly PriorLayer[];
	priorEntries: number;
	priorChars: number;
	/** Card kinds this phase may see. `[]` means no cards at all. */
	kinds: readonly OptimizationCardKind[];
	/** Whether records without a structured card may be injected. The research
	 * stages need them; a tuning round does not. */
	allowNarrative: boolean;
	maxRecords: number;
	maxChars: number;
	view: "brief" | "index";
	includeMethodMenu: boolean;
}

/** One table, one place to change. See docs/implementation/design.md for why
 * each phase gets what it gets. */
export const INJECTION_PLANS: Record<InjectionPhase, InjectionPlan> = {
	// Cold start: the full prior once, plus contracts, rules and the strongest examples.
	bootstrap: { phase: "bootstrap", layers: ["L0", "L1", "L2", "L3", "L4", "L5"], priorEntries: 12, priorChars: 12_000,
		kinds: ["contract", "rule", "case", "avoid", "when"], allowNarrative: false, maxRecords: 12, maxChars: 9_000, view: "brief", includeMethodMenu: true },
	// Mutation: guardrails only. Examples here cause structural drift.
	mutation: { phase: "mutation", layers: ["L2", "L3", "L4"], priorEntries: 3, priorChars: 2_000,
		kinds: ["contract", "rule", "avoid"], allowNarrative: false, maxRecords: 3, maxChars: 2_000, view: "brief", includeMethodMenu: true },
	"compile-fix": { phase: "compile-fix", layers: ["L4", "L5"], priorEntries: 3, priorChars: 3_000,
		kinds: ["rule", "contract"], allowNarrative: false, maxRecords: 3, maxChars: 2_500, view: "brief", includeMethodMenu: false },
	"correctness-fix": { phase: "correctness-fix", layers: ["L1", "L5"], priorEntries: 3, priorChars: 3_000,
		kinds: ["rule", "contract", "case"], allowNarrative: false, maxRecords: 3, maxChars: 3_000, view: "brief", includeMethodMenu: false },
	// Tuning: tiling prior and the methods that still have headroom.
	"performance-tuning": { phase: "performance-tuning", layers: ["L3"], priorEntries: 2, priorChars: 1_500,
		kinds: ["when", "case", "avoid"], allowNarrative: false, maxRecords: 3, maxChars: 2_500, view: "brief", includeMethodMenu: true },
	review: { phase: "review", layers: ["L2"], priorEntries: 2, priorChars: 1_500,
		kinds: ["contract", "avoid"], allowNarrative: false, maxRecords: 2, maxChars: 1_500, view: "brief", includeMethodMenu: false },
	// M05 acquisition: enough to know what is missing, not a reading list.
	acquisition: { phase: "acquisition", layers: ["L0", "L2"], priorEntries: 4, priorChars: 4_000,
		kinds: ["contract", "rule"], allowNarrative: true, maxRecords: 8, maxChars: 8_000, view: "brief", includeMethodMenu: false },
	// M06 applicability: the project state a reader compares a source against.
	applicability: { phase: "applicability", layers: ["L2"], priorEntries: 4, priorChars: 4_000,
		kinds: ["contract", "case", "avoid", "rule", "when"], allowNarrative: true, maxRecords: 12, maxChars: 12_000, view: "brief", includeMethodMenu: false },
	// M04 judgment: the broadest phase, and still an order of magnitude below the old pack.
	judgment: { phase: "judgment", layers: ["L2", "L3"], priorEntries: 6, priorChars: 6_000,
		kinds: ["contract", "rule", "case", "avoid", "when"], allowNarrative: true, maxRecords: 16, maxChars: 16_000, view: "brief", includeMethodMenu: false },
};

export function planInjection(phase: InjectionPhase, overrides: Partial<InjectionPlan> = {}): InjectionPlan {
	return { ...INJECTION_PLANS[phase], ...overrides, phase };
}

export interface InjectionReceiptV1 {
	version: 1;
	kind: "knowledge-injection";
	phase: InjectionPhase;
	at: string;
	snapshot?: string;
	/** Prior files that entered the prompt. */
	priorFiles: string[];
	/** Records that entered the prompt, pinned. */
	injectedRefs: string[];
	/** Of those, the ones carrying a structured card. */
	cardRefs: string[];
	/** Relevance hits left out by the phase filter or the bounds. */
	omitted: Array<{ ref: string; reason: string }>;
	chars: number;
	maxChars: number;
	methodMenu?: { status: MethodDecision["status"]; allowed: string[]; masked: string[] };
}

export interface InjectionRequest {
	store: KnowledgeStore;
	phase: InjectionPhase;
	purpose: string;
	/** Current objective, symptoms or error text. Never model-invented synonyms. */
	text: string;
	context?: KnowledgeRetrievalContext;
	requiredIds?: readonly string[];
	types?: readonly RecordType[];
	excludeExperience?: boolean;
	/** Directory of the frozen layered prior, when the workspace has one. */
	priorRoot?: string;
	/** Inputs for the deterministic method menu. */
	bottleneck?: BottleneckSignature;
	metrics?: readonly DecisionMetric[];
	canonicalFamily?: string;
	operatorCategory?: string;
	/** Exact compiler/runtime error symbols seen this round. Rule cards keyed by
	 * a matching signature are looked up deterministically, not ranked. */
	errorSignatures?: readonly string[];
	decisionPolicy?: DecisionPolicy;
	plan?: InjectionPlan;
}

export interface InjectionResult {
	markdown: string;
	plan: InjectionPlan;
	selection: KnowledgeRetrievalSelection;
	prior: PriorSelection;
	decision?: MethodDecision;
	receipt: InjectionReceiptV1;
}

/** Normalised containment either way: a compiler prints more than the symbol. */
function matchesSignature(signature: string, observed: readonly string[] | undefined): boolean {
	if (!observed?.length) return false;
	const left = signature.toLocaleLowerCase();
	return observed.some((item) => {
		const right = item.toLocaleLowerCase();
		return !!right.trim() && (right.includes(left) || left.includes(right));
	});
}

/** Reciprocal rank fusion of two routes: the lexical ranking retrieval already
 * produced, and a structured-key ranking over the cards' declared operator
 * category, structure family, bottleneck and applicability. Neither route alone
 * is enough: lexical retrieval misses a card written in other words, and key
 * matching alone would rank every card of the family identically. */
function fuseRanking(refs: readonly string[], cards: Map<string, NonNullable<ReturnType<typeof readOptimizationCard>>>,
	request: InjectionRequest, required: ReadonlySet<string>): string[] {
	const context = request.context ?? {};
	const structured = refs.filter((ref) => cards.has(ref)).map((ref) => {
		const card = cards.get(ref)!;
		let score = 0;
		if (request.bottleneck && card.bottleneck === request.bottleneck) score += 3;
		if (request.canonicalFamily && card.canonicalFamily === request.canonicalFamily) score += 3;
		if (request.operatorCategory && card.operatorCategory === request.operatorCategory) score += 2;
		for (const key of RETRIEVAL_SCALAR_KEYS)
			if (context[key] !== undefined && card.applicability[key] === context[key]) score += 1;
		for (const key of RETRIEVAL_FEATURE_KEYS) {
			const observed = new Set(context[key] ?? []);
			for (const label of card.applicability[key] ?? []) if (observed.has(label)) score += 1;
		}
		if (card.kind === "rule" && matchesSignature(card.errorSignature, request.errorSignatures)) score += 4;
		return { ref, score };
	}).filter((item) => item.score > 0)
		.sort((left, right) => right.score - left.score || left.ref.localeCompare(right.ref));
	const structuredRank = new Map(structured.map((item, index) => [item.ref, index]));
	const fused = refs.map((ref, index) => ({ ref,
		score: 1 / (60 + index) + (structuredRank.has(ref) ? 1 / (60 + structuredRank.get(ref)!) : 0),
		order: index }));
	fused.sort((left, right) => Number(required.has(right.ref)) - Number(required.has(left.ref)) ||
		right.score - left.score || left.order - right.order);
	return fused.map((item) => item.ref);
}

const HEADER = "本包按阶段装配，条数与字符都有上限；未展开的条目仍在库中，可用 knowledge_select / knowledge_read 按 ID 补读。入库不等于科学认证，装载不等于采用。";

/** Assemble one bounded prompt block: frozen prior, then the phase's card kinds
 * in relevance order, then the deterministic method menu. */
export async function assembleInjection(request: InjectionRequest): Promise<InjectionResult> {
	const plan = request.plan ?? INJECTION_PLANS[request.phase];
	const context = request.context;
	const selection = await retrieveKnowledge(request.store, {
		purpose: request.purpose, text: request.text, view: "refs",
		...(request.requiredIds?.length ? { requiredIds: [...request.requiredIds] } : {}),
		...(context ? { context } : {}),
		...(request.types?.length ? { types: [...request.types] } : {}),
		...(request.excludeExperience ? { excludeExperience: true } : {}),
		maxRecords: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER,
	});
	const prior = request.priorRoot
		? selectPrior(await loadPriorLibrary(request.priorRoot), { layers: plan.layers, context: context ?? {},
			maxEntries: plan.priorEntries, maxChars: plan.priorChars })
		: { markdown: "", included: [], omitted: [] };

	const omitted: InjectionReceiptV1["omitted"] = [...selection.omitted];
	const required = new Set(selection.rankedRefs.filter((ref) =>
		(request.requiredIds ?? []).some((item) => item === ref || item === ref.split("@")[0])));
	// Cards are indexed over the whole published catalogue, not only over the
	// lexical hits: a rule keyed by an error signature seen this round must be
	// found by its exact symbol even when the round's text never mentions it.
	const cardsByRef = new Map<string, NonNullable<ReturnType<typeof readOptimizationCard>>>();
	for (const record of await request.store.list()) {
		const card = readOptimizationCard(record.fields);
		if (card) cardsByRef.set(`${record.id}@${record.version}`, card);
	}
	for (const ref of selection.rankedRefs) {
		if (cardsByRef.has(ref)) continue;
		const [id, version] = ref.split("@");
		const record = await request.store.get(id, Number(version));
		const card = record && readOptimizationCard(record.fields);
		if (card) cardsByRef.set(ref, card);
	}
	const lookedUp: string[] = [];
	for (const [ref, card] of cardsByRef) {
		if (card.kind !== "rule" || !matchesSignature(card.errorSignature, request.errorSignatures)) continue;
		const [id, version] = ref.split("@");
		if ((await request.store.availability(id, Number(version))).availability === "not_allowed") {
			omitted.push({ ref, reason: "rule-lookup:not-allowed" });
			continue;
		}
		required.add(ref);
		lookedUp.push(ref);
	}
	const ordered = fuseRanking([...new Set([...selection.rankedRefs, ...lookedUp])], cardsByRef, request, required);
	const kinds = new Set<OptimizationCardKind>(plan.kinds);
	const injectedRefs: string[] = [];
	const cardRefs: string[] = [];
	const blocks: string[] = [];
	let used = HEADER.length;
	// The menu sees every published card the retrieval reached, not only the ones
	// this phase renders: a ruled-out direction must mask even when its card is
	// not part of the prompt.
	const cardsForMenu = [...cardsByRef].map(([ref, card]) => ({ ref, card }));
	for (const ref of ordered) {
		const [id, version] = ref.split("@");
		const record: KnowledgeRecord | undefined = await request.store.get(id, Number(version));
		if (!record) { omitted.push({ ref, reason: "record-unavailable" }); continue; }
		const card = cardsByRef.get(ref);
		const mandatory = required.has(ref);
		const report = await request.store.availability(record.id, record.version);
		if (!mandatory) {
			// A withdrawn or suspended entry is not injected as usable knowledge.
			// It remains readable by ID: relevance is not authority, and neither is
			// silence about a live limit.
			if (report.availability === "not_allowed") { omitted.push({ ref, reason: "not-allowed" }); continue; }
			if (card && !kinds.has(card.kind)) { omitted.push({ ref, reason: `phase-filter:${card.kind}` }); continue; }
			if (!card && !plan.allowNarrative) { omitted.push({ ref, reason: "phase-filter:narrative" }); continue; }
			if (injectedRefs.length >= plan.maxRecords) { omitted.push({ ref, reason: "over-record-budget" }); continue; }
		}
		const active = selection.limits.filter((limit) => !limit.liftedAt &&
			(limit.target === record.id || limit.target === ref));
		const block = card
			? `${renderOptimizationCard(ref, card)}- 当前可用性：${report.availability}${report.reasons.length ? `（${report.reasons.join("；")}）` : ""}；生效限制：${active.length ? active.map((limit) => `${limit.kind}:${limit.target}`).join("、") : "无"}\n`
			: renderSelectedKnowledgeRecord(record, report, selection.limits, record.version, plan.view, context);
		if (!mandatory && used + block.length > plan.maxChars) { omitted.push({ ref, reason: "over-char-budget" }); continue; }
		used += block.length;
		blocks.push(block);
		injectedRefs.push(ref);
		if (card) cardRefs.push(ref);
	}

	let decision: MethodDecision | undefined;
	let menu = "";
	if (plan.includeMethodMenu && request.bottleneck) {
		decision = decideMethods({ bottleneck: request.bottleneck, context: context ?? {}, cards: cardsForMenu,
			...(request.metrics?.length ? { metrics: [...request.metrics] } : {}),
			...(request.canonicalFamily ? { canonicalFamily: request.canonicalFamily } : {}),
			...(request.operatorCategory ? { operatorCategory: request.operatorCategory } : {}),
			...(request.decisionPolicy ? { policy: request.decisionPolicy } : {}) });
		menu = renderMethodMenu(decision, request.bottleneck);
	}
	const markdown = [`## 阶段知识注入（${plan.phase}）`, HEADER, prior.markdown,
		blocks.length ? blocks.join("\n") : "（本阶段没有符合情境与条数上限的条目）", menu]
		.filter((part) => part && part.trim()).join("\n\n");
	const receipt: InjectionReceiptV1 = { version: 1, kind: "knowledge-injection", phase: plan.phase,
		at: new Date().toISOString(), ...(selection.snapshot ? { snapshot: selection.snapshot } : {}),
		priorFiles: prior.included.map((item) => item.file), injectedRefs, cardRefs,
		omitted: [...omitted, ...prior.omitted.map((item) => ({ ref: `prior:${item.file}`, reason: item.reason }))],
		chars: markdown.length, maxChars: plan.maxChars,
		...(decision ? { methodMenu: { status: decision.status, allowed: decision.allowed.map((item) => item.method),
			masked: decision.masked.map((item) => item.method) } } : {}) };
	return { markdown, plan, selection, prior, ...(decision ? { decision } : {}), receipt };
}
