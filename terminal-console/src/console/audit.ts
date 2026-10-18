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

export interface AuditGoalInput {
	runId: string;
	tasks: readonly M07TaskRecord[];
}

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
		budget: { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
			usageComplete: true, costComplete: true, unknownEvents: 0 },
		profile: { changeKinds: [], intents: [], profilerEvidence: [],
			candidatesPerVerifiedPass: null, candidatesPerMillionTokens: null },
		notes: [],
	};
	const totals: Accumulators = { gates: new Tally(), changeKinds: new Tally(), intents: new Tally(), profilerEvidence: new Tally() };
	for (const goal of goals) for (const task of goal.tasks) {
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
		}
		// A final declared candidate that reuses an episode observation is already
		// counted above; only an independently frozen one adds a judgement.
		const final = task.candidateObservation;
		if (final && !(task.episode?.candidates ?? []).some(item => item.observationPath === final.observationPath))
			countObservation(audit, totals, final);
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
		`改动类别分布：${audit.profile.changeKinds.length ? audit.profile.changeKinds.map(row => `${row.changeKind} ${row.count}`).join("、") : "暂无"}`,
		`候选意图分布：${audit.profile.intents.length ? audit.profile.intents.map(row => `${row.intent} ${row.count}`).join("、") : "暂无"}`,
		`性能画像证据：${audit.profile.profilerEvidence.length ? audit.profile.profilerEvidence.map(row => `${row.evidence} ${row.count}`).join("、") : "暂无"}`,
		...audit.notes.map(note => `说明：${note}`),
	];
}
