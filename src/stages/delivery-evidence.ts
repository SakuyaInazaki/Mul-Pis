/**
 * Deterministic link between what M09 actually copies into the delivery and
 * the best candidate the trajectory ever verified.
 *
 * The delivery scope is chosen by a main agent and approved by M04. Nothing in
 * that chain compares the chosen artifact with the archived candidates, so a
 * delivery could silently ship a superseded version. This module reads the
 * frozen candidate archive, matches exact bytes, and reports what is missing.
 * It states facts about identity and recorded measurement bases only; it never
 * claims a candidate is faster, correct for the goal, or scientifically valid.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { candidateSearchSnapshot, candidateSubjectId, type CandidateArchiveEntry } from "../m07/candidate-archive.ts";
import type { CandidateMetricV1, CurrentGoal } from "../m07/types.ts";
import { HarnessError } from "../types.ts";
import type { Workspace } from "../workspace.ts";

export interface DeliveryBestRowV1 {
	goalRunId: string;
	candidateRef: string;
	subjectId: string;
	metric: CandidateMetricV1;
	delivered: boolean;
	/** Frozen source files of that candidate and whether each one's bytes were delivered. */
	sourceFiles: Array<{ path: string; delivered: boolean }>;
}

export interface DeliverySupersededRowV1 {
	goalRunId: string;
	/** An archived candidate whose exact bytes are in the delivery. */
	deliveredCandidateRef: string;
	subjectId: string;
	/** The host-verified best candidate for that subject which is absent from the delivery. */
	bestCandidateRef: string;
	metric: CandidateMetricV1;
}

/** What the delivered measurements can and cannot be compared against. */
export interface DeliveryMeasurementDisclosureV1 {
	/** Distinct measurement bases behind the delivered candidates' top-level metrics. */
	basisIds: string[];
	/** Metrics that have a recorded reference measurement on the same basis: these have a denominator. */
	metricsWithReference: number;
	/** Metrics with no recorded reference on their basis: no denominator, not a speedup. */
	metricsWithoutReference: number;
	terminalEvaluations: number;
	nonterminalEvaluations: number;
	cases: { passed: number; failed: number; unknown: number };
}

export interface DeliveryEvidenceV1 {
	version: 1;
	scope: "archived-host-verified-candidates";
	goalRunIds: string[];
	archivedCandidates: number;
	deliveredCandidateRefs: string[];
	best: DeliveryBestRowV1[];
	superseded: DeliverySupersededRowV1[];
	measurement: DeliveryMeasurementDisclosureV1;
	limitations: string[];
}

async function sha256(file: string): Promise<string> {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** Every regular file under the delivery copy, keyed by content digest. */
async function deliveredDigests(root: string): Promise<Set<string>> {
	const digests = new Set<string>();
	async function walk(dir: string): Promise<void> {
		for (const name of (await readdir(dir)).sort()) {
			const target = path.join(dir, name);
			const info = await lstat(target);
			if (info.isSymbolicLink()) throw new HarnessError("m09.delivery-evidence", `交付副本不接受符号链接：${target}`);
			if (info.isDirectory()) await walk(target);
			else if (info.isFile()) digests.add(await sha256(target));
		}
	}
	await walk(root);
	return digests;
}

async function candidateDelivery(entry: CandidateArchiveEntry, delivered: ReadonlySet<string>): Promise<Array<{ path: string; delivered: boolean }>> {
	const rows: Array<{ path: string; delivered: boolean }> = [];
	for (const file of entry.observation.sourceFiles) {
		try { rows.push({ path: file, delivered: delivered.has(await sha256(file)) }); }
		catch { rows.push({ path: file, delivered: false }); }
	}
	return rows;
}

function disclosure(entries: readonly CandidateArchiveEntry[]): DeliveryMeasurementDisclosureV1 {
	const basisIds = new Set<string>();
	const cases = { passed: 0, failed: 0, unknown: 0 };
	let metricsWithReference = 0, metricsWithoutReference = 0, terminalEvaluations = 0, nonterminalEvaluations = 0;
	for (const entry of entries) {
		const references = new Set((entry.observation.executionFacts?.evaluations ?? [])
			.flatMap(evaluation => evaluation.cases.flatMap(item => (item.referenceMeasurements ?? []).map(reference => reference.basisId))));
		for (const metric of entry.observation.metrics) {
			basisIds.add(metric.basisId);
			if (references.has(metric.basisId)) metricsWithReference++;
			else metricsWithoutReference++;
		}
		for (const evaluation of entry.observation.executionFacts?.evaluations ?? []) {
			if (evaluation.terminal) terminalEvaluations++; else nonterminalEvaluations++;
			for (const item of evaluation.cases) cases[item.correctness]++;
		}
	}
	return { basisIds: [...basisIds].sort(), metricsWithReference, metricsWithoutReference,
		terminalEvaluations, nonterminalEvaluations, cases };
}

/**
 * Compare one delivery copy against every readable M07 goal in the workspace.
 * A goal with no archived candidates contributes nothing, so deliveries that
 * are not candidate artifacts at all keep working unchanged.
 */
export async function collectDeliveryEvidence(ws: Workspace, deliveryRoot: string): Promise<DeliveryEvidenceV1> {
	const delivered = await deliveredDigests(deliveryRoot);
	const evidence: DeliveryEvidenceV1 = { version: 1, scope: "archived-host-verified-candidates", goalRunIds: [],
		archivedCandidates: 0, deliveredCandidateRefs: [], best: [], superseded: [],
		measurement: { basisIds: [], metricsWithReference: 0, metricsWithoutReference: 0,
			terminalEvaluations: 0, nonterminalEvaluations: 0, cases: { passed: 0, failed: 0, unknown: 0 } },
		limitations: [] };
	const deliveredEntries: CandidateArchiveEntry[] = [];
	for (const runId of await ws.listRuns("M07")) {
		let goal: CurrentGoal;
		try { goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as CurrentGoal; }
		catch { evidence.limitations.push(`M07 ${runId} 的目标控制记录不可读取；其候选不参与交付对照`); continue; }
		if (goal.runId !== runId || !Array.isArray(goal.tasks)) continue;
		evidence.goalRunIds.push(runId);
		const archive = await candidateSearchSnapshot(goal);
		evidence.archivedCandidates += archive.available.length;
		if (archive.all.length > archive.available.length)
			evidence.limitations.push(`M07 ${runId} 有 ${archive.all.length - archive.available.length} 个候选的冻结证据不可读取；它们不参与最佳对照`);
		const deliveredHere = new Map<string, CandidateArchiveEntry>();
		for (const entry of archive.available) {
			const rows = await candidateDelivery(entry, delivered);
			if (rows.length && rows.every(row => row.delivered)) {
				deliveredHere.set(entry.ref, entry);
				evidence.deliveredCandidateRefs.push(`${runId}/${entry.ref}`);
				deliveredEntries.push(entry);
			}
		}
		for (const row of archive.best) {
			if (!row.subjectId) continue;
			const entry = archive.available.find(item => item.ref === row.candidateRef);
			const sourceFiles = entry ? await candidateDelivery(entry, delivered) : [];
			const isDelivered = sourceFiles.length > 0 && sourceFiles.every(item => item.delivered);
			evidence.best.push({ goalRunId: runId, candidateRef: row.candidateRef, subjectId: row.subjectId,
				metric: row.metric, delivered: isDelivered, sourceFiles });
			if (isDelivered) continue;
			for (const [ref, candidate] of deliveredHere) {
				if (ref === row.candidateRef) continue;
				if (candidateSubjectId(candidate.subjectId, candidate.observation) !== row.subjectId) continue;
				evidence.superseded.push({ goalRunId: runId, deliveredCandidateRef: ref, subjectId: row.subjectId,
					bestCandidateRef: row.candidateRef, metric: row.metric });
			}
		}
	}
	evidence.measurement = disclosure(deliveredEntries);
	if (!evidence.measurement.terminalEvaluations && evidence.deliveredCandidateRefs.length)
		evidence.limitations.push("交付的候选没有任何终态外部评测记录；交付前的认证范围只有迭代期间的记录");
	if (evidence.measurement.metricsWithoutReference)
		evidence.limitations.push(`${evidence.measurement.metricsWithoutReference} 个交付指标在同一口径上没有参考测量；它们没有分母，不能当作相对任何基线的收益`);
	evidence.limitations.push("交付对照只比较冻结源码字节与已记录的测量口径；它不判断性能、正确性或科研结论。");
	return evidence;
}

/** Fail closed: a delivery that ships a superseded candidate is refused. */
export function assertDeliversHistoricalBest(evidence: DeliveryEvidenceV1): void {
	if (!evidence.superseded.length) return;
	const rows = evidence.superseded.map(row =>
		`目标 ${row.goalRunId} 的对象 ${row.subjectId}：交付了 ${row.deliveredCandidateRef}，但同口径历史最佳是 ${row.bestCandidateRef}（${row.metric.name}=${row.metric.value} ${row.metric.unit}，${row.metric.basisId}）`);
	throw new HarnessError("m09.superseded-delivery",
		`交付范围里的候选不是轨迹内历史最佳；请改为交付最佳候选，或先用新的 M08/M04 记录说明为什么不交付它。\n${rows.join("\n")}`);
}

export function renderDeliveryEvidence(evidence: DeliveryEvidenceV1): string[] {
	return [
		`候选对照范围：M07 目标 ${evidence.goalRunIds.length} 个、可读归档候选 ${evidence.archivedCandidates} 个`,
		`交付中识别出的归档候选：${evidence.deliveredCandidateRefs.length ? evidence.deliveredCandidateRefs.join("、") : "无（本次交付不含归档候选源码）"}`,
		...evidence.best.map(row => `同口径历史最佳：${row.goalRunId}/${row.candidateRef} · 对象 ${row.subjectId} · ${row.metric.name}=${row.metric.value} ${row.metric.unit}（${row.metric.basisId}，${row.metric.direction} 更优）· ${row.delivered ? "已在交付范围内" : "不在交付范围内"}`),
		`测量口径披露：口径 ${evidence.measurement.basisIds.join("、") || "无"}；有参考测量的指标 ${evidence.measurement.metricsWithReference} 个、没有参考测量的 ${evidence.measurement.metricsWithoutReference} 个`,
		`认证范围：终态外部评测 ${evidence.measurement.terminalEvaluations}、未终态 ${evidence.measurement.nonterminalEvaluations}；逐例通过 ${evidence.measurement.cases.passed}、失败 ${evidence.measurement.cases.failed}、未知 ${evidence.measurement.cases.unknown}`,
		...evidence.limitations.map(item => `限制：${item}`),
	];
}
