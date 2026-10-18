import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorkflowAudit, renderWorkflowAudit } from "../src/console/audit.ts";
import { WorkflowReader } from "../src/console/read-model.ts";
import type { CandidateObservationV1, M07TaskRecord } from "../../src/m07/types.ts";
import type { WorkflowNode } from "../src/console/model.ts";

function observation(input: Partial<CandidateObservationV1>): CandidateObservationV1 {
	return {
		version: 1, kind: "candidate-observation", verifier: { id: "host", version: "1" },
		sourceBinding: "verified", correctness: "passed", stage: "measurement",
		checks: [], goalChecks: [], metrics: [], limitations: [], sourceFiles: [], receiptFiles: [],
		...input,
	};
}
function episodeCandidate(id: string, observed: CandidateObservationV1, changeKind: "repair" | "structure" | "parameters" = "structure") {
	return { id, sourcePaths: [], receiptPaths: [], hypothesis: `h-${id}`, changeKind,
		intent: "solution" as const, observation: observed, observationPath: `/frozen/${id}.json` };
}
function task(input: Partial<M07TaskRecord> & Pick<M07TaskRecord, "taskId" | "status">): M07TaskRecord {
	return { objective: "任务", createdAt: "2026-01-01T00:00:00Z", workDir: "/work", toolLog: [], ...input } as M07TaskRecord;
}

test("audit separates host verdicts, failure accounting and budget from the node tree", () => {
	const measured = observation({ metrics: [{ name: "wall", value: 1, unit: "s", basisId: "b1", direction: "lower" }] });
	const compileFailure = observation({ correctness: "failed", executionFacts: { evaluations: [{
		externalId: "e1", subjectId: "s1", status: "done", terminal: true, capturedAt: "2026-01-01T00:00:00Z",
		receiptIndex: 0, cases: [], diagnostics: [{ category: "compile", fieldPath: "log", rawText: "error" }] }] } });
	const pending = observation({ correctness: "unknown" });
	const unbound = observation({ sourceBinding: "unknown", correctness: "passed" });
	const goals = [{ runId: "g", tasks: [
		task({ taskId: "T001", status: "accepted",
			candidate: { intent: "solution", changeKind: "structure", sourcePaths: [], receiptPaths: [] },
			candidateObservation: { ...measured, observationPath: "/frozen/c1.json" },
			episode: { version: 1, candidates: [episodeCandidate("c1", measured), episodeCandidate("c2", compileFailure, "repair")], incumbents: [] } }),
		task({ taskId: "T002", status: "rejected",
			candidate: { intent: "solution", changeKind: "parameters", sourcePaths: [], receiptPaths: [] },
			candidateObservation: { ...compileFailure, observationPath: "/frozen/T002.json" },
			review: { at: "2026-01-01T01:00:00Z", frozenReportPath: "/frozen/T002-review.md", checks: [],
				artifacts: [], failures: ["复核未通过"], unexecuted: [], limitations: [] } }),
		task({ taskId: "T003", status: "failed", executionFailure: "沙箱启动失败",
			episode: { version: 1, candidates: [episodeCandidate("c3", pending), episodeCandidate("c4", unbound)], incumbents: [] } }),
	] as M07TaskRecord[] }];
	const nodes: WorkflowNode[] = [{ id: "session:a", label: "s", kind: "session", status: "completed", sessionId: "a",
		usage: { input: 400_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cost: 2, complete: true, costComplete: false, reportedEvents: 3, unknownEvents: 1 },
		detail: [], outputRefs: [], artifactRefs: [], checks: [] }];

	const audit = buildWorkflowAudit(goals, nodes, "2026-01-01T02:00:00Z");

	assert.deepEqual(audit.tasks, { total: 3, running: 0, returned: 0, accepted: 1, rejected: 1, failed: 1, unknown: 0 });
	// Two agent declarations, one of which the host verifier refused.
	assert.deepEqual(audit.selfAccepted, { declaredByAgent: 2, hostPassed: 1, hostRefused: 1, hostUnjudged: 0, controllerRejected: 1 });
	// T001's final observation reuses the episode observation path and is not double counted.
	assert.deepEqual(audit.judgement, { candidates: 5, verifiedPassed: 1, verifiedFailed: 2, unjudged: 2 });
	assert.deepEqual(audit.gates.map(row => `${row.gate}:${row.count}`),
		["source-unverified:1", "pending-or-unknown:1", "compile-failure:2", "correct-measured:1"]);
	// Unbound source and a pending external operation are infrastructure, not policy;
	// the execution failure adds one more. Compile failures and the review failure are policy.
	assert.deepEqual(audit.failures, { infrastructure: 3, policy: 3, unclassified: 0 });
	assert.equal(audit.budget.cost, 2);
	assert.equal(audit.budget.costComplete, false);
	assert.equal(audit.budget.usageComplete, true);
	assert.equal(audit.profile.candidatesPerVerifiedPass, 5);
	assert.equal(audit.profile.candidatesPerMillionTokens, 10);
	assert.deepEqual(audit.profile.changeKinds, [{ changeKind: "structure", count: 3 }, { changeKind: "repair", count: 1 }]);

	const rendered = renderWorkflowAudit(audit).join("\n");
	assert.match(rendered, /未判定 2/);
	assert.match(rendered, /compile-failure 2/);
	assert.match(rendered, /基础设施 3、策略 3/);
	assert.match(rendered, /记录不完整，为下界/);
});

test("an empty workspace reports no denominator instead of a fabricated ratio", () => {
	const audit = buildWorkflowAudit([], [], "2026-01-01T00:00:00Z");
	assert.equal(audit.profile.candidatesPerVerifiedPass, null);
	assert.equal(audit.profile.candidatesPerMillionTokens, null);
	const rendered = renderWorkflowAudit(audit).join("\n");
	assert.match(rendered, /无分母/);
	assert.match(rendered, /还没有冻结候选观测/);
});

test("the reader audits every readable goal, not only the selected one", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "console-audit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "research.config.json"), "{}\n");
	const refused = observation({ correctness: "failed" });
	for (const [runId, taskId] of [["g1", "T001"], ["g2", "T002"]]) {
		await mkdir(path.join(root, "stages/M07", runId), { recursive: true });
		await writeFile(path.join(root, "stages/M07", runId, "run.json"), JSON.stringify({ stage: "M07", runId,
			status: "completed", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T01:00:00Z",
			inputs: [], sessions: [], outputs: [], failures: [], remarks: [] }));
		await writeFile(path.join(root, "stages/M07", runId, "goal.json"), JSON.stringify({ runId, lifecycle: "closed",
			goal: "目标", decisions: [], goalChecks: [], tasks: [{ taskId, objective: "o", status: "rejected",
				createdAt: "2026-01-01T00:00:00Z", workDir: path.join(root, "work"), toolLog: [],
				candidate: { intent: "solution", changeKind: "repair", sourcePaths: [], receiptPaths: [] },
				candidateObservation: { ...refused, observationPath: `/frozen/${taskId}.json` } }] }));
	}
	const snapshot = await new WorkflowReader(root).read({ goalRunId: "g1" });
	assert.equal(snapshot.audit.selfAccepted.declaredByAgent, 2);
	assert.equal(snapshot.audit.selfAccepted.hostRefused, 2);
	assert.equal(snapshot.audit.tasks.rejected, 2);
});
