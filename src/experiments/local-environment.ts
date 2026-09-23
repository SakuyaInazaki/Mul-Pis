import { randomUUID } from "node:crypto";
import { isScientificActionId, type ArtifactRef, type DevelopmentEnvironment, type DevelopmentFeedback, type EnvironmentHealthReport, type ExperimentStart, type NumericObservation, type ProtectedEvaluator, type PublicHypothesis, type PublicTask, type ScientificAction } from "./contracts.ts";
import { SharedBudget } from "./budget.ts";

export interface CpuResponseCase {
	id: string;
	version: 1;
	/** This is private controller input; do not serialize it in PublicTask or model prompts. */
	truthHypothesisId: string;
	hypotheses: PublicHypothesis[];
	initialX: number[];
	allowedProbeX: number[];
	maxProbeCalls: number;
	tolerance: number;
	units: { x: string; y: string };
}

export interface CpuCaseSetV1 {
	version: 1;
	split: "development" | "admission";
	cases: CpuResponseCase[];
}

interface ActionRecord { action: ScientificAction; feedback?: DevelopmentFeedback }
interface State { start: ExperimentStart; observations: NumericObservation[]; probes: number; stopped: boolean; unresolved: boolean; submitted?: string; actions: Map<string, ActionRecord> }

const finite = (v: number): boolean => Number.isFinite(v);
function value(h: PublicHypothesis, x: number): number {
	return h.formula.kind === "affine" ? h.formula.slope * x + h.formula.intercept : h.formula.coefficient * x * x + h.formula.intercept;
}
function matches(h: PublicHypothesis, observations: NumericObservation[], tolerance: number): boolean {
	return observations.every((o) => Math.abs(value(h, o.x) - o.y) <= tolerance);
}

export function validateCpuCaseSet(input: unknown): CpuCaseSetV1 {
	if (!input || typeof input !== "object") throw new Error("case set must be an object");
	const set = input as CpuCaseSetV1;
	if (set.version !== 1 || !["development", "admission"].includes(set.split) || !Array.isArray(set.cases) || set.cases.length === 0 || set.cases.length > 32) throw new Error("invalid CPU case set");
	const seen = new Set<string>();
	for (const c of set.cases) {
		if (!c || c.version !== 1 || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) || seen.has(c.id)) throw new Error("invalid or duplicate CPU case id");
		seen.add(c.id);
		if (!Array.isArray(c.hypotheses) || c.hypotheses.length < 2 || c.hypotheses.length > 8 || !Array.isArray(c.initialX) || c.initialX.length < 1 || c.initialX.length > 8 || !Array.isArray(c.allowedProbeX) || c.allowedProbeX.length < 1 || c.allowedProbeX.length > 16) throw new Error("invalid CPU case dimensions");
		if (!Number.isInteger(c.maxProbeCalls) || c.maxProbeCalls < 1 || c.maxProbeCalls > 16 || !finite(c.tolerance) || c.tolerance < 0 || c.tolerance > 1) throw new Error("invalid CPU case limits");
		if (!c.units || typeof c.units.x !== "string" || typeof c.units.y !== "string" || c.units.x.length > 40 || c.units.y.length > 40) throw new Error("invalid CPU units");
		if (![...c.initialX, ...c.allowedProbeX].every((x) => typeof x === "number" && finite(x) && Math.abs(x) <= 1e6)) throw new Error("invalid CPU probe coordinate");
		const ids = new Set<string>();
		for (const h of c.hypotheses) {
			if (!h || typeof h.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(h.id) || ids.has(h.id) || !h.formula || !["affine", "quadratic"].includes(h.formula.kind)) throw new Error("invalid CPU hypothesis");
			ids.add(h.id);
			const coefficients = h.formula.kind === "affine" ? [h.formula.slope, h.formula.intercept] : [h.formula.coefficient, h.formula.intercept];
			if (!coefficients.every((x) => typeof x === "number" && finite(x) && Math.abs(x) <= 1e6)) throw new Error("invalid CPU coefficients");
			if (![...c.initialX, ...c.allowedProbeX].every((x) => finite(value(h, x)) && Math.abs(value(h, x)) <= 1e12)) throw new Error("CPU response outside finite bounds");
		}
		if (!ids.has(c.truthHypothesisId)) throw new Error("CPU truth id is not a listed hypothesis");
	}
	return {
		version: 1, split: set.split,
		cases: set.cases.map((c) => ({
			id: c.id, version: 1, truthHypothesisId: c.truthHypothesisId,
			hypotheses: c.hypotheses.map((h) => ({ id: h.id, formula: h.formula.kind === "affine" ? { kind: "affine" as const, slope: h.formula.slope, intercept: h.formula.intercept } : { kind: "quadratic" as const, coefficient: h.formula.coefficient, intercept: h.formula.intercept } })),
			initialX: [...c.initialX], allowedProbeX: [...c.allowedProbeX], maxProbeCalls: c.maxProbeCalls, tolerance: c.tolerance, units: { x: c.units.x, y: c.units.y },
		})),
	};
}

/** Private case and evaluator remain in controller memory; only publicTask/feedback reach a model. */
export function createCpuResponseEnvironment(caseInput: CpuResponseCase, budget: SharedBudget, options: {
	/** Must append a bounded private record before returning a resolvable reference. */
	persistObservation?: (record: { start: ExperimentStart; action: ScientificAction; feedback: DevelopmentFeedback }) => Promise<ArtifactRef>;
} = {}): { development: DevelopmentEnvironment; protectedEvaluator: ProtectedEvaluator } {
	const c = validateCpuCaseSet({ version: 1, split: "development", cases: [caseInput] }).cases[0]!;
	const truth = c.hypotheses.find((h) => h.id === c.truthHypothesisId)!;
	const states = new Map<string, State>();
	const initial = (): NumericObservation[] => c.initialX.map((x) => ({ x, y: value(truth, x), xUnit: c.units.x, yUnit: c.units.y, source: "initial" }));
	const state = (start: ExperimentStart): State => {
		const found = states.get(start.id);
		if (!found || JSON.stringify(found.start) !== JSON.stringify(start)) throw new Error("unknown or mismatched CPU start");
		return found;
	};
		const publicTask = (start: ExperimentStart): PublicTask => ({ version: 1, caseId: c.id, objective: "identify-response-mechanism", hypotheses: structuredClone(c.hypotheses), initialObservations: structuredClone(state(start).observations.filter((o) => o.source === "initial")), allowedProbeX: [...c.allowedProbeX], maxProbeCalls: c.maxProbeCalls, units: { ...c.units } });
		/** Shortest truth-consistent informative probe sequence within the remaining case allowance. */
		const referenceSequence = (observations: NumericObservation[], remainingProbes: number): number[] | undefined => {
			const maskFor = (items: NumericObservation[]) => c.hypotheses.reduce((mask, h, index) => matches(h, items, c.tolerance) ? mask | (1 << index) : mask, 0);
			const singleton = (mask: number) => mask !== 0 && (mask & (mask - 1)) === 0;
			const first = maskFor(observations);
			if (singleton(first)) return [];
			const queue: Array<{ mask: number; sequence: number[] }> = [{ mask: first, sequence: [] }];
			const seen = new Set<number>([first]);
			for (let index = 0; index < queue.length; index++) {
				const current = queue[index]!;
				if (current.sequence.length >= remainingProbes) continue;
				for (const x of c.allowedProbeX) {
					const y = value(truth, x);
					const probeMask = c.hypotheses.reduce((mask, h, hypothesisIndex) => Math.abs(value(h, x) - y) <= c.tolerance ? mask | (1 << hypothesisIndex) : mask, 0);
					const next = current.mask & probeMask;
					if (next === current.mask || seen.has(next)) continue;
					const sequence = [...current.sequence, x];
					if (singleton(next)) return sequence;
					seen.add(next);
					queue.push({ mask: next, sequence });
				}
			}
			return undefined;
		};
	const feedback = (s: State, actionId: string, status: DevelopmentFeedback["status"], observations: NumericObservation[] = []): DevelopmentFeedback => ({ version: 1, id: randomUUID(), startId: s.start.id, actionId, status, observations: structuredClone(observations), remainingProbeCalls: c.maxProbeCalls - s.probes, checks: [], evidence: [], visibility: "development" });
	const begin = (s: State, action: ScientificAction): DevelopmentFeedback | undefined => {
		const keys = action?.kind === "probe" ? ["kind", "actionId", "x"] : action?.kind === "submit" ? ["kind", "actionId", "hypothesisId", "explanation"] : action?.kind === "stop" ? ["kind", "actionId", "reason"] : [];
		if (!keys.length || Object.keys(action).some((key) => !keys.includes(key)) || !isScientificActionId(action.actionId) || Buffer.byteLength(JSON.stringify(action), "utf8") > 1024 || (action.kind === "submit" && (typeof action.hypothesisId !== "string" || (action.explanation !== undefined && (typeof action.explanation !== "string" || action.explanation.length > 500)))) || (action.kind === "stop" && (typeof action.reason !== "string" || action.reason.length > 500))) throw new Error("invalid or oversized CPU action");
		const prior = s.actions.get(action.actionId);
		if (prior) {
			if (JSON.stringify(prior.action) !== JSON.stringify(action)) throw new Error("CPU action id collision");
			if (!prior.feedback) throw new Error("CPU action persistence is unresolved; action cannot be repeated");
			return structuredClone(prior.feedback);
		}
		if (s.unresolved) throw new Error("CPU start has unresolved observation persistence");
		if ([...s.actions.values()].some((record) => !record.feedback)) throw new Error("CPU start has an in-flight action");
		s.actions.set(action.actionId, { action: structuredClone(action) });
		return undefined;
	};
	const persist = async (s: State, action: ScientificAction, result: DevelopmentFeedback): Promise<DevelopmentFeedback> => {
		try {
			if (options.persistObservation) result.evidence = [await options.persistObservation({ start: { ...s.start }, action: structuredClone(action), feedback: structuredClone(result) })];
		} catch {
			s.unresolved = true;
			throw new Error("CPU observation persistence failed; action outcome is unresolved");
		}
		s.actions.get(action.actionId)!.feedback = result;
		return structuredClone(result);
	};
	const prepare = async (seed: string): Promise<ExperimentStart> => {
		if (typeof seed !== "string" || seed.length > 200) throw new Error("invalid CPU seed");
		const start: ExperimentStart = { id: randomUUID(), caseId: c.id, environmentVersion: "cpu-response-identification/v1", inputSnapshotId: randomUUID(), seed };
		states.set(start.id, { start, observations: initial(), probes: 0, stopped: false, unresolved: false, actions: new Map() });
		return { ...start };
	};
	const fork = async (start: ExperimentStart): Promise<ExperimentStart> => {
		const source = state(start);
		if (source.unresolved || [...source.actions.values()].some((record) => !record.feedback)) throw new Error("CPU start has unresolved observation persistence");
		const child: ExperimentStart = { ...start, id: randomUUID() };
		states.set(child.id, { start: child, observations: initial(), probes: 0, stopped: false, unresolved: false, actions: new Map() });
		return { ...child };
	};
	const runProbe: DevelopmentEnvironment["runProbe"] = async (start, action, lease) => {
		const s = state(start);
		const previous = begin(s, action);
		if (previous) return previous;
		let result: DevelopmentFeedback;
		if (s.stopped || !c.allowedProbeX.includes(action.x) || !finite(action.x) || !action.actionId || action.actionId.length > 100) result = feedback(s, action.actionId, "invalid");
		else if (s.probes >= c.maxProbeCalls) result = feedback(s, action.actionId, "resource-exhausted");
		else {
			try { budget.reserveProbe(lease); }
			catch { result = feedback(s, action.actionId, budget.status(lease).remaining.wallMillis <= 0 ? "timed-out" : "resource-exhausted"); return persist(s, action, result); }
			const cpuStart = process.cpuUsage();
			const observation: NumericObservation = { x: action.x, y: value(truth, action.x), xUnit: c.units.x, yUnit: c.units.y, source: "probe" };
			s.probes++;
			s.observations.push(observation);
			const cpu = process.cpuUsage(cpuStart);
			budget.debitCpuMillis(lease, (cpu.user + cpu.system) / 1000);
			result = feedback(s, action.actionId, "observed", [observation]);
		}
		return persist(s, action, result);
	};
	const evaluateDevelopment: DevelopmentEnvironment["evaluateDevelopment"] = async (start, action, lease) => {
		const s = state(start);
		const previous = begin(s, action);
		if (previous) return previous;
		const budgetStatus = budget.status(lease);
		if (budgetStatus.settlement !== "settled" || budgetStatus.remaining.wallMillis <= 0 || budgetStatus.remaining.cpuMillis <= 0) return persist(s, action, feedback(s, action.actionId, budgetStatus.remaining.wallMillis <= 0 ? "timed-out" : "resource-exhausted"));
		const selected = c.hypotheses.find((h) => h.id === action.hypothesisId);
		const surviving = c.hypotheses.filter((h) => matches(h, s.observations, c.tolerance));
		const status: DevelopmentFeedback["status"] = s.stopped || !selected || !action.actionId || action.actionId.length > 100 ? "invalid" : !surviving.some((h) => h.id === selected.id) ? "contradicted" : surviving.length === 1 ? "supported-by-observations" : "underdetermined";
		if (status !== "invalid") { s.submitted = action.hypothesisId; s.stopped = true; }
		const result = feedback(s, action.actionId, status);
		return persist(s, action, result);
	};
	const stop: DevelopmentEnvironment["stop"] = async (start, action) => {
		const s = state(start);
		const previous = begin(s, action);
		if (previous) return previous;
		if (!action.actionId || action.actionId.length > 100 || typeof action.reason !== "string" || action.reason.length > 500) return persist(s, action, feedback(s, action.actionId, "invalid"));
		s.stopped = true;
		const result = feedback(s, action.actionId, "stopped");
		return persist(s, action, result);
	};
	const healthCheck = async (): Promise<EnvironmentHealthReport> => {
		const checks: EnvironmentHealthReport["checks"] = [];
		const add = async (name: EnvironmentHealthReport["checks"][number]["name"], check: () => Promise<boolean>) => {
			try { checks.push({ name, passed: await check() }); }
			catch { checks.push({ name, passed: false }); }
		};
		const notApplicable = (name: EnvironmentHealthReport["checks"][number]["name"], detail: string) => checks.push({ name, passed: false, applicability: "not-applicable", detail });
		const limits = { maxProviderCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSdkEstimatedCost: 1, maxProbeCalls: 100, maxCpuMillis: 1000, maxWallMillis: 1000 };
		const labBudget = new SharedBudget(`cpu-health-${randomUUID()}`, limits);
		const lab = createCpuResponseEnvironment(c, labBudget);
		const sequence = referenceSequence(initial(), c.maxProbeCalls);
		const classification: EnvironmentHealthReport["classification"] = sequence === undefined ? "not-identifiable-within-budget" : sequence.length === 0 ? "initially-resolved" : sequence.length === 1 ? "one-step" : "multi-step";
		const anyProbeX = c.allowedProbeX[0]!;
		const wrong = c.hypotheses.find((h) => h.id !== truth.id && matches(h, initial(), c.tolerance));
		const runSequence = async (start: ExperimentStart, steps: number[]): Promise<boolean> => {
			for (const [index, x] of steps.entries()) if ((await lab.development.runProbe(start, { kind: "probe", actionId: `p${index}`, x }, labBudget.root)).status !== "observed") return false;
			return true;
		};
		if (classification === "initially-resolved") notApplicable("ambiguous", "Initial observations already identify one response.");
		else await add("ambiguous", async () => {
			const s = await lab.development.prepare("health-ambiguous");
			return (await lab.development.evaluateDevelopment(s, { kind: "submit", actionId: "ambiguous", hypothesisId: truth.id }, labBudget.root)).status === "underdetermined" && (await lab.protectedEvaluator.evaluate(s, truth.id)).status === "inconclusive";
		});
		if (!sequence?.length) notApplicable("discriminating-probe", sequence ? "Initial observations already resolve the task." : "No resolving sequence exists within the probe budget.");
		else await add("discriminating-probe", async () => {
			const s = await lab.development.prepare("health-probe");
			return (await lab.development.runProbe(s, { kind: "probe", actionId: "probe", x: sequence[0]! }, labBudget.root)).status === "observed";
		});
		if (!sequence) notApplicable("positive", "No resolving sequence exists within the probe budget.");
		else await add("positive", async () => {
			const s = await lab.development.prepare("health-positive");
			if (!await runSequence(s, sequence)) return false;
			return (await lab.development.evaluateDevelopment(s, { kind: "submit", actionId: "s", hypothesisId: truth.id }, labBudget.root)).status === "supported-by-observations" && (await lab.protectedEvaluator.evaluate(s, truth.id)).status === "accepted";
		});
		if (!sequence) notApplicable("negative", "A determinate wrong-answer contrast is unavailable within the probe budget.");
		else await add("negative", async () => {
			const incorrect = wrong ?? c.hypotheses.find((h) => h.id !== truth.id);
			if (!incorrect) return false;
			const s = await lab.development.prepare("health-negative");
			if (!await runSequence(s, sequence)) return false;
			return (await lab.development.evaluateDevelopment(s, { kind: "submit", actionId: "s", hypothesisId: incorrect.id }, labBudget.root)).status === "contradicted";
		});
		if (!sequence || !wrong) notApplicable("initially-plausible", "No initially viable wrong response can be contradicted within the probe budget.");
		else await add("initially-plausible", async () => {
			const s = await lab.development.prepare("health-initially-plausible");
			if (!await runSequence(s, sequence)) return false;
			return (await lab.development.evaluateDevelopment(s, { kind: "submit", actionId: "s", hypothesisId: wrong.id }, labBudget.root)).status === "contradicted";
		});
		if (!sequence) await add("unidentifiable-stop", async () => {
			const s = await lab.development.prepare("health-unknown");
			await lab.development.runProbe(s, { kind: "probe", actionId: "p", x: anyProbeX }, labBudget.root);
			await lab.development.stop(s, { kind: "stop", actionId: "s", reason: "available observations do not distinguish candidates" });
			const result = await lab.protectedEvaluator.evaluateStop(s);
			return result.status === "justified-unknown" && result.quality === "partial";
		});
		else await add("premature-stop", async () => {
			const s = await lab.development.prepare("health-premature");
			await lab.development.stop(s, { kind: "stop", actionId: "s", reason: "not sure yet" });
			return (await lab.protectedEvaluator.evaluateStop(s)).status === "premature-stop";
		});
		await add("reset", async () => {
			const s = await lab.development.prepare("health-reset");
			await lab.development.runProbe(s, { kind: "probe", actionId: "p", x: anyProbeX }, labBudget.root);
			const forked = await lab.development.fork(s);
			return forked.inputSnapshotId === s.inputSnapshotId && forked.id !== s.id && (await lab.development.runProbe(forked, { kind: "probe", actionId: "p", x: anyProbeX }, labBudget.root)).remainingProbeCalls === c.maxProbeCalls - 1;
		});
		await add("resource", async () => {
			const tight = new SharedBudget(`cpu-health-resource-${randomUUID()}`, { ...limits, maxProbeCalls: 0 });
			const e = createCpuResponseEnvironment(c, tight).development;
			const s = await e.prepare("health-resource");
			return (await e.runProbe(s, { kind: "probe", actionId: "p", x: c.allowedProbeX[0]! }, tight.root)).status === "resource-exhausted";
		});
		await add("invalid-action", async () => {
			const s = await lab.development.prepare("health-invalid");
			const outside = Math.max(...c.allowedProbeX) + 1;
			return (await lab.development.runProbe(s, { kind: "probe", actionId: "invalid", x: outside }, labBudget.root)).status === "invalid";
		});
		await add("timeout", async () => {
			const expired = new SharedBudget(`cpu-health-timeout-${randomUUID()}`, { ...limits, maxWallMillis: 0 });
			const e = createCpuResponseEnvironment(c, expired).development;
			const s = await e.prepare("health-timeout");
			return (await e.runProbe(s, { kind: "probe", actionId: "p", x: c.allowedProbeX[0]! }, expired.root)).status === "timed-out";
		});
		return { usable: checks.every((item) => item.passed || item.applicability === "not-applicable"), classification, checks };
	};
	const development: DevelopmentEnvironment = { healthCheck, prepare, fork, publicTask, runProbe, evaluateDevelopment, stop };
	const protectedEvaluator: ProtectedEvaluator = {
		async evaluate(start, hypothesisId) {
			const s = state(start);
			if (s.unresolved) return { status: "inconclusive", evidence: [] };
			const surviving = c.hypotheses.filter((h) => matches(h, s.observations, c.tolerance));
			if (!s.stopped || s.submitted !== hypothesisId || surviving.length !== 1) return { status: "inconclusive", evidence: [] };
			return { status: hypothesisId === truth.id ? "accepted" : "rejected", evidence: [] };
		},
			async evaluateStop(start, lease) {
				const s = state(start);
				if (s.unresolved) return { status: "inconclusive", quality: "none", evidence: [] };
				if (!s.stopped || s.submitted) return { status: "inconclusive", quality: "none", evidence: [] };
				const surviving = c.hypotheses.filter((h) => matches(h, s.observations, c.tolerance));
				if (surviving.length <= 1) return { status: "premature-stop", quality: "none", evidence: [] };
				const caseRemaining = Math.max(0, c.maxProbeCalls - s.probes);
				if (lease) {
					const own = budget.status(lease), root = budget.status(budget.root);
					if (own.settlement !== "settled" || root.settlement !== "settled") return { status: "inconclusive", quality: "none", evidence: [] };
					if (own.remaining.wallMillis <= 0 || root.remaining.wallMillis <= 0 || own.remaining.cpuMillis <= 0 || root.remaining.cpuMillis <= 0) return { status: "resource-exhausted", quality: "none", evidence: [] };
					if (own.remaining.probeCalls < caseRemaining || root.remaining.probeCalls < caseRemaining) {
						const affordable = Math.min(caseRemaining, own.remaining.probeCalls, root.remaining.probeCalls);
						if (referenceSequence(s.observations, caseRemaining) !== undefined && referenceSequence(s.observations, affordable) === undefined) return { status: "resource-exhausted", quality: "none", evidence: [] };
					}
				}
				const canResolve = referenceSequence(s.observations, caseRemaining) !== undefined;
				return canResolve ? { status: "premature-stop", quality: "none", evidence: [] } : { status: "justified-unknown", quality: "partial", evidence: [] };
		},
	};
	return { development, protectedEvaluator };
}
