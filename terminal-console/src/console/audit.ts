/**
 * Deterministic audit projection of one workspace.
 *
 * The execution tree shows one node at a time. This module answers the two
 * questions a tree of nodes cannot: "why was this candidate refused" and
 * "where did the budget go". Every number here is derived mechanically from
 * durable control records; nothing is a model statement, a judgement about
 * research quality, or a claim that a measured candidate is actually faster.
 */
import type { CandidateObservationV1, M07TaskRecord } from "../../../src/m07/types.ts";
import { summarizeCandidateDiagnostics, type CandidateDiagnosticSummaryV1 } from "../../../src/m07/candidate-diagnostics.ts";
import type { WorkflowAuditV1, WorkflowNode } from "./model.ts";

/** Verification gates, ordered from "nothing was established" to "measured". */
const GATES: ReadonlyArray<CandidateDiagnosticSummaryV1["stage"]> = ["source-unverified", "pending-or-unknown",
	"compile-failure", "numerical-failure", "runtime-failure", "mixed-failure", "correctness-failure",
	"correct-unmeasured", "correct-measured"];

/**
 * Infrastructure failures are failures of the harness or of the external
 * operation; policy failures are failures of the submitted work. The split
 * matters because only the second kind is a signal the agent should act on.
 */
const INFRASTRUCTURE_GATES: ReadonlySet<string> = new Set(["source-unverified", "pending-or-unknown"]);
const SUCCESS_GATES: ReadonlySet<string> = new Set(["correct-measured", "correct-unmeasured"]);

/** One persisted assessor transport observation, already classified by the runner. */
export interface AuditTransportObservation {
	failureClass?: string;
	failureReason?: string;
}

export interface AuditGoalInput {
	runId: string;
	tasks: readonly M07TaskRecord[];
	/** Transport observations recorded under this run, newest last. */
	transport?: readonly AuditTransportObservation[];
	/** True when the reader stopped short of every recorded observation. */
	transportTruncated?: boolean;
}

const GUARDS = ["reject", "keep", "accept", "revert"] as const;
const STATUSES = ["unverified", "verified", "admissible", "promoted"] as const;
const BRANCHES = ["continue", "merge", "archive", "abandon"] as const;
const LANES = ["repair", "optimization"] as const;
const PHASES = ["bootstrap", "tuning"] as const;
const ROUTES = ["continue", "repair-in-place", "restructure", "replan"] as const;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const median = (values: readonly number[]): number | null => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

class Tally {
	private readonly counts = new Map<string, number>();
	add(value: string): void { this.counts.set(value, (this.counts.get(value) ?? 0) + 1); }
	rows(order?: ReadonlyArray<string>): Array<{ name: string; count: number }> {
		const entries = [...this.counts].map(([name, count]) => ({ name, count }));
		if (!order) return entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
		return entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
	}
}

interface Accumulators {
	gates: Tally;
	changeKinds: Tally;
	intents: Tally;
	profilerEvidence: Tally;
	guards: Tally;
	statuses: Tally;
	branches: Tally;
	lanes: Tally;
	phases: Tally;
	routes: Tally;
	signals: Tally;
	stops: Tally;
	reasons: Tally;
}

function countObservation(audit: WorkflowAuditV1, totals: Accumulators, observation: CandidateObservationV1): void {
	const summary = summarizeCandidateDiagnostics(observation);
	totals.gates.add(summary.stage);
	totals.profilerEvidence.add(summary.profilerInterpretation);
	audit.judgement.candidates++;
	if (observation.sourceBinding === "verified" && observation.correctness === "passed") audit.judgement.verifiedPassed++;
	else if (observation.sourceBinding === "verified" && observation.correctness === "failed") audit.judgement.verifiedFailed++;
	else audit.judgement.unjudged++;
	if (INFRASTRUCTURE_GATES.has(summary.stage)) audit.failures.infrastructure++;
	else if (!SUCCESS_GATES.has(summary.stage)) audit.failures.policy++;
}

/**
 * Build the audit from the typed goal records plus the usage already attached
 * to session nodes. It never opens a report, a receipt or a model transcript.
 */
export function buildWorkflowAudit(goals: readonly AuditGoalInput[], nodes: readonly WorkflowNode[],
	generatedAt: string): WorkflowAuditV1 {
	const audit: WorkflowAuditV1 = {
		version: 1, generatedAt,
		tasks: { total: 0, running: 0, returned: 0, accepted: 0, rejected: 0, failed: 0, unknown: 0 },
		gates: [],
		selfAccepted: { declaredByAgent: 0, hostPassed: 0, hostRefused: 0, hostUnjudged: 0, controllerRejected: 0 },
		judgement: { candidates: 0, verifiedPassed: 0, verifiedFailed: 0, unjudged: 0 },
		failures: { infrastructure: 0, policy: 0, unclassified: 0 },
		classifiedFailures: { tools: { infrastructure: 0, policy: 0, unjudged: 0, unrecorded: 0 },
			transport: { infrastructure: 0, policy: 0, unjudged: 0, unrecorded: 0 },
			unjudgedShare: null, reasons: [], truncated: false },
		policy: { guards: [], statuses: [], branches: [], lanes: [], phases: [],
			updatesBest: 0, scored: 0, scoreMedian: null, scoreMax: null, undecided: 0 },
		search: { tasks: 0, maxStagnation: 0, forcedDirectionChanges: 0, routes: [], signals: [], bannedDirections: 0 },
		searchBudget: { tasks: 0, evaluations: 0, rejected: 0, remaining: null, stops: [] },
		budget: { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
			usageComplete: true, costComplete: true, unknownEvents: 0 },
		profile: { changeKinds: [], intents: [], profilerEvidence: [],
			candidatesPerVerifiedPass: null, candidatesPerMillionTokens: null },
		notes: [],
	};
	const totals: Accumulators = { gates: new Tally(), changeKinds: new Tally(), intents: new Tally(),
		profilerEvidence: new Tally(), guards: new Tally(), statuses: new Tally(), branches: new Tally(),
		lanes: new Tally(), phases: new Tally(), routes: new Tally(), signals: new Tally(),
		stops: new Tally(), reasons: new Tally() };
	const scores: number[] = [];
	for (const goal of goals) {
	audit.classifiedFailures.truncated ||= goal.transportTruncated === true;
	for (const observation of goal.transport ?? []) {
		const failureClass = observation.failureClass;
		if (failureClass === "infrastructure" || failureClass === "policy" || failureClass === "unjudged")
			audit.classifiedFailures.transport[failureClass]++;
		else audit.classifiedFailures.transport.unrecorded++;
		if (observation.failureReason) totals.reasons.add(observation.failureReason);
	}
	for (const task of goal.tasks) {
		audit.tasks.total++;
		if (task.status === "running") audit.tasks.running++;
		else if (task.status === "returned") audit.tasks.returned++;
		else if (task.status === "accepted") audit.tasks.accepted++;
		else if (task.status === "rejected") audit.tasks.rejected++;
		else if (task.status === "failed") audit.tasks.failed++;
		else audit.tasks.unknown++;
		const reviewFailures = (task.review?.failures ?? []).filter(item => item.trim().length > 0);
		if (task.executionFailure) audit.failures.infrastructure++;
		audit.failures.policy += reviewFailures.length;
		if (task.status === "failed" && !task.executionFailure && !reviewFailures.length) audit.failures.unclassified++;
		if (task.candidate) {
			audit.selfAccepted.declaredByAgent++;
			const correctness = task.candidateObservation?.correctness;
			if (correctness === "passed") audit.selfAccepted.hostPassed++;
			else if (correctness === "failed") audit.selfAccepted.hostRefused++;
			else audit.selfAccepted.hostUnjudged++;
			if (task.status === "rejected") audit.selfAccepted.controllerRejected++;
		}
		for (const candidate of task.episode?.candidates ?? []) {
			countObservation(audit, totals, candidate.observation);
			totals.changeKinds.add(candidate.changeKind);
			totals.intents.add(candidate.intent);
			const policy = candidate.policy;
			if (!policy) { audit.policy.undecided++; continue; }
			totals.guards.add(policy.guard);
			totals.statuses.add(policy.status);
			totals.branches.add(policy.branch);
			totals.lanes.add(policy.lane);
			totals.phases.add(policy.phase);
			if (policy.updatesBest) audit.policy.updatesBest++;
			if (Number.isFinite(policy.score)) scores.push(policy.score);
		}
		const search = task.episode?.search;
		if (search) {
			audit.search.tasks++;
			audit.search.maxStagnation = Math.max(audit.search.maxStagnation, search.stagnation);
			if (search.forcedDirectionChange) audit.search.forcedDirectionChanges++;
			totals.routes.add(search.route);
			for (const signal of search.signals) totals.signals.add(signal);
			audit.search.bannedDirections += search.bannedDirections.length;
		}
		const budget = task.episode?.budget;
		if (budget) {
			audit.searchBudget.tasks++;
			audit.searchBudget.evaluations += budget.evaluations;
			audit.searchBudget.rejected += budget.rejected;
			audit.searchBudget.remaining = Math.min(audit.searchBudget.remaining ?? budget.remaining, budget.remaining);
			if (budget.stop) totals.stops.add(budget.stop);
		}
		// Tool calls carry the runner's own failure class; the audit counts them,
		// it never reclassifies a failure the runner already judged.
		for (const raw of task.toolLog) {
			const entry = asObject(raw);
			if (!entry || entry.ok !== false) continue;
			const failureClass = entry.failureClass;
			if (failureClass === "infrastructure" || failureClass === "policy" || failureClass === "unjudged")
				audit.classifiedFailures.tools[failureClass]++;
			else audit.classifiedFailures.tools.unrecorded++;
			const reason = typeof entry.failureReason === "string" ? entry.failureReason : undefined;
			if (reason) totals.reasons.add(reason);
		}
		// A final declared candidate that reuses an episode observation is already
		// counted above; only an independently frozen one adds a judgement.
		const final = task.candidateObservation;
		if (final && !(task.episode?.candidates ?? []).some(item => item.observationPath === final.observationPath))
			countObservation(audit, totals, final);
	}
	}
	for (const node of nodes) {
		if (node.kind !== "session" || !node.usage) continue;
		audit.budget.sessions++;
		audit.budget.input += node.usage.input;
		audit.budget.output += node.usage.output;
		audit.budget.cacheRead += node.usage.cacheRead;
		audit.budget.cacheWrite += node.usage.cacheWrite;
		audit.budget.cost += node.usage.cost;
		audit.budget.unknownEvents += node.usage.unknownEvents;
		audit.budget.usageComplete &&= node.usage.complete;
		audit.budget.costComplete &&= node.usage.costComplete;
	}
	audit.gates = totals.gates.rows(GATES).map(row => ({ gate: row.name, count: row.count }));
	audit.policy.guards = totals.guards.rows(GUARDS).map(row => ({ guard: row.name, count: row.count }));
	audit.policy.statuses = totals.statuses.rows(STATUSES).map(row => ({ status: row.name, count: row.count }));
	audit.policy.branches = totals.branches.rows(BRANCHES).map(row => ({ branch: row.name, count: row.count }));
	audit.policy.lanes = totals.lanes.rows(LANES).map(row => ({ lane: row.name, count: row.count }));
	audit.policy.phases = totals.phases.rows(PHASES).map(row => ({ phase: row.name, count: row.count }));
	audit.policy.scored = scores.length;
	audit.policy.scoreMedian = median(scores);
	audit.policy.scoreMax = scores.length ? Math.max(...scores) : null;
	audit.search.routes = totals.routes.rows(ROUTES).map(row => ({ route: row.name, count: row.count }));
	audit.search.signals = totals.signals.rows().map(row => ({ signal: row.name, count: row.count }));
	audit.searchBudget.stops = totals.stops.rows().map(row => ({ stop: row.name, count: row.count }));
	audit.classifiedFailures.reasons = totals.reasons.rows().map(row => ({ reason: row.name, count: row.count }));
	const classified = audit.classifiedFailures;
	const judged = classified.tools.infrastructure + classified.tools.policy + classified.tools.unjudged +
		classified.transport.infrastructure + classified.transport.policy + classified.transport.unjudged;
	classified.unjudgedShare = judged ? (classified.tools.unjudged + classified.transport.unjudged) / judged : null;
	audit.profile.changeKinds = totals.changeKinds.rows().map(row => ({ changeKind: row.name, count: row.count }));
	audit.profile.intents = totals.intents.rows().map(row => ({ intent: row.name, count: row.count }));
	audit.profile.profilerEvidence = totals.profilerEvidence.rows().map(row => ({ evidence: row.name, count: row.count }));
	audit.profile.candidatesPerVerifiedPass = audit.judgement.verifiedPassed
		? audit.judgement.candidates / audit.judgement.verifiedPassed : null;
	const tokens = audit.budget.input + audit.budget.output;
	audit.profile.candidatesPerMillionTokens = tokens ? audit.judgement.candidates / (tokens / 1_000_000) : null;
	if (!audit.budget.usageComplete || !audit.budget.costComplete)
		audit.notes.push("会话用量或计费记录不完整；预算数字是已读记录的下界，不是实际花费。");
	if (audit.judgement.unjudged)
		audit.notes.push("未判定候选既不算失败也不算通过，不进入最佳与搜索前沿；它的占比是 harness 健康指标。");
	if (!audit.judgement.candidates)
		audit.notes.push("本工作区还没有冻结候选观测；判决分布与反馈密度暂无分母。");
	audit.notes.push("失败分账按确定性规则计：源码未绑定与未终态外部操作记为基础设施失败，编译/数值/运行/正确性失败与复核失败记为策略失败。");
	if (classified.tools.unrecorded || classified.transport.unrecorded)
		audit.notes.push("有失败记录没有带运行层的分类标记（旧记录或未分类路径）；它们单列为「未记录分类」，不并入任何一类。");
	if (classified.truncated)
		audit.notes.push("传输观测超出读取窗口，只统计了最近的一段；可在 .agent/console-limits.json 调大 transportObservationWindow。");
	if (audit.policy.undecided)
		audit.notes.push("有候选没有宿主判定记录；它们不进入 guard、状态、分支与评分分布。");
	return audit;
}

/** Fixed-order text rendering; the console and the audit command share it. */
export function renderWorkflowAudit(audit: WorkflowAuditV1): string[] {
	const gates = audit.gates.filter(row => row.count > 0);
	const share = (value: number, total: number) => total ? `${((value / total) * 100).toFixed(1)}%` : "无分母";
	const ratio = (value: number | null) => value === null ? "无分母" : value.toFixed(2);
	return [
		`审计投影生成于 ${audit.generatedAt}`,
		`任务判决：共 ${audit.tasks.total}（执行中 ${audit.tasks.running}、已返回 ${audit.tasks.returned}、已接受 ${audit.tasks.accepted}、未接受 ${audit.tasks.rejected}、失败 ${audit.tasks.failed}、未知 ${audit.tasks.unknown}）`,
		`候选判决：共 ${audit.judgement.candidates}（宿主核验通过 ${audit.judgement.verifiedPassed}、宿主核验失败 ${audit.judgement.verifiedFailed}、未判定 ${audit.judgement.unjudged}；未判定占比 ${share(audit.judgement.unjudged, audit.judgement.candidates)}）`,
		`停在哪一级验证门：${gates.length ? gates.map(row => `${row.gate} ${row.count}`).join("、") : "暂无候选观测"}`,
		`引擎与 agent 自述的差：agent 声明候选 ${audit.selfAccepted.declaredByAgent}，其中宿主核验通过 ${audit.selfAccepted.hostPassed}、宿主判失败 ${audit.selfAccepted.hostRefused}、宿主未判定 ${audit.selfAccepted.hostUnjudged}；控制器另行驳回 ${audit.selfAccepted.controllerRejected}（驳回占比 ${share(audit.selfAccepted.hostRefused + audit.selfAccepted.hostUnjudged, audit.selfAccepted.declaredByAgent)}）`,
		`失败分账：基础设施 ${audit.failures.infrastructure}、策略 ${audit.failures.policy}、未分类 ${audit.failures.unclassified}`,
		`预算：会话 ${audit.budget.sessions}、输入 ${audit.budget.input}、输出 ${audit.budget.output}、缓存读取 ${audit.budget.cacheRead}、缓存写入 ${audit.budget.cacheWrite}、计费 ${audit.budget.cost}${audit.budget.usageComplete && audit.budget.costComplete ? "" : "（记录不完整，为下界）"}；未知用量事件 ${audit.budget.unknownEvents}`,
		`反馈密度：每个宿主核验通过需 ${ratio(audit.profile.candidatesPerVerifiedPass)} 个候选；每百万 token 产出 ${ratio(audit.profile.candidatesPerMillionTokens)} 个候选观测`,
		`运行层分类的失败：工具调用——基础设施 ${audit.classifiedFailures.tools.infrastructure}、策略 ${audit.classifiedFailures.tools.policy}、未判定 ${audit.classifiedFailures.tools.unjudged}、未记录分类 ${audit.classifiedFailures.tools.unrecorded}；传输——基础设施 ${audit.classifiedFailures.transport.infrastructure}、策略 ${audit.classifiedFailures.transport.policy}、未判定 ${audit.classifiedFailures.transport.unjudged}、未记录分类 ${audit.classifiedFailures.transport.unrecorded}；未判定占比 ${audit.classifiedFailures.unjudgedShare === null ? "无分母" : `${(audit.classifiedFailures.unjudgedShare * 100).toFixed(1)}%`}`,
		`失败原因分布：${audit.classifiedFailures.reasons.length ? audit.classifiedFailures.reasons.map(row => `${row.reason} ${row.count}`).join("、") : "暂无"}`,
		`候选 guard 判决：${audit.policy.guards.length ? audit.policy.guards.map(row => `${row.guard} ${row.count}`).join("、") : "暂无"}（更新最佳 ${audit.policy.updatesBest} 次，无判定 ${audit.policy.undecided} 个）`,
		`候选晋级状态：${audit.policy.statuses.length ? audit.policy.statuses.map(row => `${row.status} ${row.count}`).join("、") : "暂无"}`,
		`分支决策：${audit.policy.branches.length ? audit.policy.branches.map(row => `${row.branch} ${row.count}`).join("、") : "暂无"}`,
		`车道与相位：${audit.policy.lanes.map(row => `${row.lane} ${row.count}`).join("、") || "暂无"}；${audit.policy.phases.map(row => `${row.phase} ${row.count}`).join("、") || "暂无"}`,
		`候选评分：已评分 ${audit.policy.scored} 个，中位数 ${ratio(audit.policy.scoreMedian)}，最高 ${ratio(audit.policy.scoreMax)}（排名用，不是收益）`,
		`搜索状态：登记 ${audit.search.tasks} 个任务，最大停滞 ${audit.search.maxStagnation}，强制换向 ${audit.search.forcedDirectionChanges} 次，禁用方向 ${audit.search.bannedDirections} 条；路线 ${audit.search.routes.map(row => `${row.route} ${row.count}`).join("、") || "暂无"}；停滞信号 ${audit.search.signals.map(row => `${row.signal} ${row.count}`).join("、") || "暂无"}`,
		`搜索预算：登记 ${audit.searchBudget.tasks} 个任务，已用评估 ${audit.searchBudget.evaluations}（其中前置驳回 ${audit.searchBudget.rejected}），最小剩余 ${audit.searchBudget.remaining === null ? "未登记" : audit.searchBudget.remaining}；停止原因 ${audit.searchBudget.stops.map(row => `${row.stop} ${row.count}`).join("、") || "无"}`,
		`改动类别分布：${audit.profile.changeKinds.length ? audit.profile.changeKinds.map(row => `${row.changeKind} ${row.count}`).join("、") : "暂无"}`,
		`候选意图分布：${audit.profile.intents.length ? audit.profile.intents.map(row => `${row.intent} ${row.count}`).join("、") : "暂无"}`,
		`性能画像证据：${audit.profile.profilerEvidence.length ? audit.profile.profilerEvidence.map(row => `${row.evidence} ${row.count}`).join("、") : "暂无"}`,
		...audit.notes.map(note => `说明：${note}`),
	];
}
