import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { readLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { publicLocalMissionStatus } from "../src/m07/local-original-objective.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import { readCurrentProcessIdentity } from "../src/runtime/process-identity.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

function lines(bytes: Buffer): number {
	const text = bytes.toString("utf8");
	return text.split("\n").length - Number(text.endsWith("\n"));
}

test("local mission freezes authored inputs, reviews a bounded reason result, and reopens without replay", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:unselected-open-report", version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-unverified.json";
			await writeFile(path.join(observationOutputDir, name), "{\"verified\":false}\n", { mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Unverified report"] })),
				observations: [{ name, kind: "json" }], limitations: ["Synthetic report only"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-workflow-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	const problemBytes = Buffer.from("Synthetic original question remains open.\n", "utf8");
	const rawBytes = Buffer.from("Original supplied observation, not a selected answer.\n", "utf8");
	await writeFile(ws.problemFile, problemBytes);
	await writeFile(path.join(ws.rawDir, "observation.txt"), rawBytes);
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const goal = "Find a supported answer to the synthetic original question";
	const obligation = "Show evidence that answers the complete original question";
	const claim = "The complete original answer remains unverified";
	const issue = { id: "original-gap", claim, status: "open", classification: "explicit-requirement",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
		implication: "A bounded reason task could identify missing evidence" };
	let missionId = "";
	let originalContractBytes = Buffer.alloc(0);
	let assessorCalls = 0, m07Calls = 0, m04Calls = 0;
	let m04ReadRoot = "";
	const observedReadBytes: Array<Map<string, Buffer>> = [];
	const runner = new FakeSessionRunner(async ({ spec, message }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (assessorCalls > 4)
				throw new DOMException("Synthetic stop after a repeated blocked verdict", "AbortError");
			assert.equal(spec.role, "research");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks frozen read grant");
			const files = new Map<string, Buffer>();
			for (const name of await readdir(spec.tools.root)) {
				const file = path.join(spec.tools.root, name);
				if ((await stat(file)).isFile()) files.set(name, await readFile(file));
			}
			observedReadBytes.push(files);
			assert(files.get("original-objective.json")?.equals(originalContractBytes));
			assert(files.get("original-problem.txt")?.equals(problemBytes));
			assert(files.get("original-input-1.txt")?.equals(rawBytes));
			const readReturns: ReadReturnEvent[] = [...files].map(([name, bytes]) => ({
				toolName: "objective_evidence_read", status: "returned", path: name, requested: {},
				returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
				at: new Date().toISOString() }));
			if (assessorCalls === 1) return { text: JSON.stringify({ version: 1,
				decision: "continue", rationale: "The original criterion is still open.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [claim], groundedAssessment: {
					version: 1, kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Inspect the original question and its missing evidence",
						obligationIds: ["answer"], addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "Reasoning can identify whether the supplied material settles the question",
						expectedEvidence: "A reviewed report on the unresolved original criterion",
						sourceRefs: issue.sourceRefs } } }), readReturns };
			assert(files.has("prior-run-1-feedback-1.txt"), "second assessor must receive frozen bounded feedback");
			return { text: JSON.stringify({ version: 1, decision: "blocked",
				rationale: "The reviewed bounded report remains unselected and does not settle the original criterion.",
				evidenceRefs: ["prior-run-1-feedback-1.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [claim], groundedAssessment: {
					version: 1, kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [claim] } }), readReturns };
		}
		if (spec.label.startsWith("M07-")) {
			m07Calls++;
			assert.notEqual(spec.tools.kind, "execution");
			return "Synthetic bounded reasoning found a negative, unselected result.";
		}
		if (spec.label === "M04-research") {
			m04Calls++;
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			const readRoot = spec.tools.root;
			m04ReadRoot = readRoot;
			const readReturns: ReadReturnEvent[] = [];
			async function visit(folder: string): Promise<void> {
				for (const name of await readdir(folder)) {
					const file = path.join(folder, name);
					if ((await stat(file)).isDirectory()) { await visit(file); continue; }
					const bytes = await readFile(file);
					if (bytes.length) readReturns.push({ toolName: "m07_evidence_read", status: "returned",
						path: path.relative(readRoot, file).replaceAll("\\", "/"), requested: {},
						returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
						at: new Date().toISOString() });
				}
			}
			await visit(readRoot);
			return { text: "The negative bounded report is unselected; no original criterion was verified.",
				readReturns };
		}
		throw new Error(`unexpected model-free session ${spec.label}`);
	});
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:unselected-open-report" },
		concurrency: 1, tools: {} };
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const initial = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal, goalSource: "verbatim-private-input", obligations: [{ id: "answer", description: obligation,
			type: "synthetic-open" }],
		closure: "open-ended" });
	missionId = initial.contract.id;
	originalContractBytes = await readFile(path.join(ws.agentDir, "missions", missionId,
		"evidence", "original-objective.json"));
	assert.deepEqual(initial.contract.inputNames, ["problem.md", "observation.txt"]);
	assert.deepEqual(initial.contract.obligations, [{ id: "answer", description: obligation,
		type: "synthetic-open" }]);
	assert.equal(initial.contract.goal, goal);
	const final = await mission.run(missionId);
	assert(assessorCalls >= 2, JSON.stringify({ stopReason: final.stopReason,
		assessmentHistory: final.assessmentHistory.length, boundedRuns: final.boundedRuns.length,
		pending: final.continuation.pendingAction?.kind }));
	assert.equal(m07Calls, 1);
	assert.equal(m04Calls, 1);
	assert.equal(final.assessmentHistory.length, 2);
	assert.equal(final.assessmentHistory[0]?.assessment?.decision, "continue");
	assert.equal(final.assessmentHistory[1]?.assessment?.decision, "blocked");
	assert.equal(final.stopReason, "cancelled",
		"only the fixture's explicit abort can end an actionable original criterion");
	assert.equal(final.objectiveOutcome, "incomplete");
	assert.deepEqual(final.selectedArtifacts, []);
	assert.deepEqual(final.continuation.unresolvedObligations, ["answer"]);
	assert.equal(final.boundedRuns.length, 1);
	assert.deepEqual(final.boundedRuns[0]!.acceptedTaskIds, []);
	assert.equal((await ws.listRuns("M07")).length, 1);
	assert.equal((await ws.listRuns("M04")).length, 1);
	const m07Dir = ws.runDir("M07", final.boundedRuns[0]!.runId);
	const linkedRaw = JSON.parse(await readFile(path.join(m07Dir, "mission-dispatch-link.json"), "utf8")) as
		{ intentId: string; taskId: string; m07RunId: string };
	const linked = await readLocalDispatchLineage({ missionRoot: path.join(ws.agentDir, "missions", missionId),
		m07Dir, intentId: linkedRaw.intentId });
	assert.equal(linked.lineage.m07RunId, final.boundedRuns[0]!.runId);
	assert.equal(linked.lineage.taskId, "T001");
	assert.equal(linked.lineage.intentId, linkedRaw.intentId);
	const goalRecord = JSON.parse(await readFile(path.join(ws.runDir("M07", final.boundedRuns[0]!.runId),
		"goal.json"), "utf8")) as { tasks: Array<{ mode: string; status: string;
		checks: string[]; review?: { checks: Array<{ result: string }> } }>;
		checkpoints: Array<{ feedbackPath: string; rootDir: string }> };
	assert.equal(goalRecord.tasks[0]!.mode, "reason");
	assert.equal(goalRecord.tasks[0]!.status, "rejected");
	assert.deepEqual(goalRecord.tasks[0]!.checks, [obligation]);
	assert.deepEqual(goalRecord.tasks[0]!.review?.checks.map(check => check.result), ["not_run"]);
	assert.equal(m04ReadRoot, goalRecord.checkpoints.at(-1)!.rootDir);
	const feedbackBytes = await readFile(goalRecord.checkpoints.at(-1)!.feedbackPath);
	assert(feedbackBytes.equals(observedReadBytes[1]!.get("prior-run-1-feedback-1.txt")!));
	assert.equal(runner.resumed.length, 0, "M04 and both assessors used fresh sessions");
	const reopened = openDefaultLocalMission({ workspaceRoot: root });
	assert.deepEqual(await reopened.status(missionId), final);
	assert.equal((await ws.listRuns("M07")).length, 1, "status never replays a bounded task");
	const publicStatus = JSON.stringify(publicLocalMissionStatus(final));
	assert(!publicStatus.includes(goal));
	assert(!publicStatus.includes(obligation));
	assert(!publicStatus.includes(claim));
	assert(!publicStatus.includes(problemBytes.toString("utf8").trim()));
	assert(!publicStatus.includes("negative, unselected"));
});

for (const failureKind of ["ordinary-cancel-word", "runner-length"] as const)
test(`live failed no-proposal M04 ${failureKind} becomes frozen feedback and dispatches distinct work`, async t => {
	const evaluatorId = `test:live-failed-m04-${failureKind}`;
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-result.txt";
			await writeFile(path.join(observationOutputDir, name), "No original closure was proved.\n",
				{ mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Unselected"] })),
				observations: [{ name, kind: "text" }], limitations: ["Unselected"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-live-failed-m04-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original problem stays open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let missionId = "", assessorCalls = 0, builderCalls = 0, m04Calls = 0;
	let failureEvidence = "";
	const events = async (folder: string, toolName: string): Promise<ReadReturnEvent[]> => {
		const returned: ReadReturnEvent[] = [];
		async function visit(dir: string): Promise<void> {
			for (const name of await readdir(dir)) {
				const file = path.join(dir, name);
				if ((await stat(file)).isDirectory()) { await visit(file); continue; }
				const bytes = await readFile(file);
				if (bytes.length) returned.push({ toolName, status: "returned",
					path: path.relative(folder, file).replaceAll("\\", "/"), requested: {},
					returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
					at: new Date().toISOString() });
			}
		}
		await visit(folder);
		return returned;
	};
	const sourceRefs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
	const issue = { id: "open-question", claim: "The original problem is unresolved", status: "open",
		classification: "explicit-requirement", sourceRefs,
		implication: "Another bounded investigation can supply different evidence" };
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (assessorCalls > 6)
				throw new DOMException("Synthetic stop after repeated blocked verdicts", "AbortError");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read boundary missing");
			const files = await readdir(spec.tools.root);
			if (assessorCalls === 2) {
				const name = files.find(item => item === "prior-run-1-m04-failure-1.txt");
				assert(name, "failed M04 must be frozen for the next assessor");
				failureEvidence = await readFile(path.join(spec.tools.root, name), "utf8");
				assert.match(failureEvidence, failureKind === "runner-length" ?
					/stopReason=length/ : /line offset beyond end of file/);
				assert.match(failureEvidence, /"transactionState": "no-proposal"/);
			}
			const iteration = Number(spec.label.match(/-(\d+)$/)?.[1]);
			const decision = iteration <= 2 ? "continue" : "blocked";
			return { text: JSON.stringify({ version: 1, decision,
				rationale: "The original criterion remains open; use a different bounded task after failure.",
				evidenceRefs: iteration === 1 ? ["original-problem.txt"] :
					[iteration === 2 ? "prior-run-1-m04-failure-1.txt" : "prior-run-2-feedback-1.txt"],
				unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", issues: [issue],
					legacyOpenDetails: iteration === 1 ? [] : [issue.claim],
					...(decision === "continue" ? { nextTask: {
						objective: iteration === 1 ? "Investigate avenue one" : "Investigate avenue two",
						obligationIds: ["answer"], addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: iteration === 1 ? "Avenue one might resolve it" :
							"Avenue two might resolve it after the failed read",
						expectedEvidence: "A reviewed bounded report", sourceRefs } } : {}) } }),
				readReturns: await events(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) { builderCalls++; return `Builder result ${builderCalls}`; }
		if (spec.label === "M04-research") {
			m04Calls++;
			if (m04Calls === 1) throw failureKind === "runner-length" ?
				new HarnessError("runner.stop", "session M04-research did not stop normally (stopReason=length)") :
				new Error("line offset beyond end of file; provider prose said cancelled");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read boundary missing");
			return { text: "Second bounded result was considered; no proposal.",
				readReturns: await events(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected session ${spec.label}`);
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId }, concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original problem", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Resolve original question", type: "synthetic-open" }],
		closure: "open-ended" });
	missionId = started.contract.id;
	const result = await mission.run(missionId);
	assert(assessorCalls >= 3);
	assert.equal(builderCalls, 2);
	assert.equal(m04Calls, 2);
	assert.equal(result.boundedRuns.length, 2);
	assert.notEqual(result.boundedRuns[0]!.runId, result.boundedRuns[1]!.runId);
	assert(result.boundedRuns[0]!.failedM04RunId);
	assert.equal((await ws.readRun("M04", result.boundedRuns[0]!.failedM04RunId!)).status, "failed");
	assert.equal(result.boundedRuns[0]!.outcome, "partial");
	assert.equal(result.continuation.unresolvedOperationIds.length, 0);
	assert.deepEqual(result.selectedArtifacts, []);
	assert.match(failureEvidence, /"selected": false/);
	assert.equal((await ws.listRuns("MISSION")).length, 3);
	assert.deepEqual(await openDefaultLocalMission({ workspaceRoot: root }).status(missionId), result);
});

for (const variant of ["accepted-candidate", "accepted-pending-merge", "accepted-host-abort",
	"accepted-claim-before-rename", "accepted-claim-after-rename",
	"accepted-feedback-tamper", "accepted-release-failure",
	"accepted-missing-execution", "accepted-execute-missing-operation",
	"accepted-execute-returned-operation",
	"pending-merge", "checkpoint-failure", "runner-abort", "dom-abort"] as const)
	test(`live failed M04 holds ${variant} without replaying its M07 builder`, async t => {
		const evaluatorId = `test:live-failed-m04-${variant}`;
		let evaluatorCalls = 0;
		registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
			supportedObligationTypes: ["synthetic-open"],
			async preflight() { return { available: true }; },
			async evaluate({ contract, observationOutputDir }) {
				evaluatorCalls++;
				const name = "observation-boundary.txt";
				await writeFile(path.join(observationOutputDir, name), "A bounded host observation.\n",
					{ mode: 0o600 });
				return { checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: variant.startsWith("accepted-") ? "passed" as const : "not_run" as const,
					evidenceRefs: variant.startsWith("accepted-") ? ["candidate-001.md", name] : [name],
					limitations: [] })),
					observations: [{ name, kind: "text" }], limitations: [] };
			} });
		const root = await mkdtemp(path.join(os.tmpdir(), `local-m04-${variant}-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "A bounded synthetic question.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		if (variant.startsWith("accepted-")) {
			const baseline = await ws.startRun("M04", []);
			await ws.finishRun(baseline, "completed");
		}
		let missionId = "", builderCalls = 0, assessorCalls = 0, m04Calls = 0;
		let acceptedReads: string[] = [];
		const refs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
		const issue = { id: "open", claim: "The question remains open", status: "open",
			classification: "explicit-requirement", sourceRefs: refs,
			implication: "A bounded observation may change the answer" };
		const runner = new FakeSessionRunner(async ({ spec, message }) => {
			if (spec.label.startsWith("local-original-objective-")) {
				assessorCalls++;
				assert.equal(spec.tools.kind, "read-dir");
				if (spec.tools.kind !== "read-dir") throw new Error("assessor read boundary missing");
				if ((variant === "accepted-candidate" ||
					variant === "accepted-execute-returned-operation") && assessorCalls > 1) {
					throw new Error("synthetic next assessment unavailable after selection");
				}
				const readReturns: ReadReturnEvent[] = [];
				for (const name of await readdir(spec.tools.root)) {
					const bytes = await readFile(path.join(spec.tools.root, name));
					if (bytes.length) readReturns.push({ toolName: "objective_evidence_read",
						status: "returned", path: name, requested: {},
						returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
						at: new Date().toISOString() });
				}
				return { text: JSON.stringify({ version: 1, decision: "continue",
					rationale: "Try one bounded observation.", evidenceRefs: ["original-problem.txt"],
					unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
					groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
						contractId: missionId, missionStatus: "open", issues: [issue], legacyOpenDetails: [],
						nextTask: { objective: "Test the bounded observation", obligationIds: ["answer"],
							addresses: [issue.id], adapterScope:
								variant.startsWith("accepted-execute-") ?
									"local-m07-execute" : "local-m07-reason",
							decisionChangingHypothesis: "The observation may settle the bounded check",
							expectedEvidence: "A reviewed host observation", sourceRefs: refs } } }),
					readReturns };
			}
			if (spec.label.startsWith("M07-")) {
				builderCalls++;
				if (variant.startsWith("accepted-execute-")) {
					assert.equal(spec.tools.kind, "execution");
					if (spec.tools.kind !== "execution") throw new Error("execution grant missing");
					const output = path.join(spec.tools.root, "deliverable");
					await mkdir(output, { recursive: true });
					await writeFile(path.join(output, "candidate-001.md"),
						"A synthetic candidate artifact.\n");
				}
				return "One returned builder report.";
			}
			if (spec.label === "M04-research") {
				if (variant.startsWith("accepted-")) {
					const durable = await mission.status(missionId);
					assert.equal(durable.stopReason, "m04-review-pending");
					assert.equal(durable.pendingM04Review?.taskId,
						durable.boundedRuns.at(-1)?.acceptedTaskIds?.[0]);
					assert.deepEqual(durable.selectedArtifacts, []);
				}
				m04Calls++;
				if (variant === "accepted-host-abort")
					throw Object.assign(new Error("synthetic host stop"), { name: "AbortError" });
				if ((variant === "accepted-candidate" ||
					variant === "accepted-execute-returned-operation") && m04Calls === 1)
					throw new Error("line offset beyond end of file");
				if ((variant === "accepted-candidate" ||
					variant === "accepted-execute-returned-operation") && m04Calls === 2) {
					assert.match(message, /m04-read-offset-beyond-eof/);
					assert.match(message, /line offset beyond end of file/);
					assert.match(message, /retainedEvidenceRefs/);
					assert.match(message, /Read required M07 evidence again/);
					assert.equal(spec.tools.kind, "read-dir");
					if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
					const readRoot = spec.tools.root;
					return { text: "Accepted candidate and host observation reviewed; no proposal.",
						readReturns: await Promise.all(acceptedReads.map(async name => {
							const bytes = await readFile(path.join(readRoot, name));
							return { toolName: "m07_evidence_read", status: "returned" as const,
								path: name, requested: {}, returned: { kind: "text" as const,
									startLine: 1, endLine: lines(bytes), truncated: false },
								at: new Date().toISOString() };
						})) };
				}
				if (variant.endsWith("pending-merge")) {
					const running = (await Promise.all((await ws.listRuns("M04"))
						.map(id => ws.readRun("M04", id)))).filter(run => run.status === "running");
					assert.equal(running.length, 1);
					const id = running[0]!.runId;
					const file = path.join(ws.runDir("M04", id), "m04-transaction.json");
					const tx = JSON.parse(await readFile(file, "utf8")) as { state: string };
					tx.state = "merge-intent";
					await writeFile(file, `${JSON.stringify(tx, null, 2)}\n`);
				}
				if (variant === "runner-abort")
					throw new HarnessError("runner.aborted", "session M04-research was aborted during prompt");
				if (variant === "dom-abort")
					throw new DOMException("The operation was aborted", "AbortError");
				throw new Error("synthetic M04 read transport failure");
			}
			throw new Error(`unexpected session ${spec.label}`);
		});
		const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
			config: { roles: { research: "fake/research", execution: "fake/execution" },
				localMission: { evaluatorId,
					...(variant.startsWith("accepted-execute-") ?
						{ execution: "task-root-bash" as const } : {}) },
				concurrency: 1, tools: {} } });
		if (variant === "checkpoint-failure") {
			const original = LocalMissionHost.prototype.recordCheckpoint;
			let interrupted = false;
			LocalMissionHost.prototype.recordCheckpoint = async function(input) {
				const progress = JSON.parse(input.bytes.toString("utf8")) as { boundedRuns?: Array<{
					failedM04RunId?: string }> };
				if (!interrupted && progress.boundedRuns?.some(item => item.failedM04RunId)) {
					interrupted = true;
					throw new Error("synthetic final checkpoint interruption");
				}
				return original.call(this, input);
			};
			t.after(() => { LocalMissionHost.prototype.recordCheckpoint = original; });
		}
		const begun = await mission.begin({ version: 1, kind: "local-original-objective-request",
			goal: "Answer the bounded question", goalSource: "verbatim-private-input",
			obligations: [{ id: "answer", description: "Resolve the question", type: "synthetic-open" }],
			closure: "open-ended" });
		missionId = begun.contract.id;
		if (variant === "accepted-candidate") {
			const pending = await mission.step(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			assert.deepEqual(pending.boundedRuns[0]?.acceptedTaskIds?.length, 1);
			assert.deepEqual(pending.selectedArtifacts, []);
			assert.equal(m04Calls, 1);
			assert.equal(builderCalls, 1);
			assert.equal(evaluatorCalls, 1);
			acceptedReads = pending.pendingM04Review!.requiredM07ReadPaths;
			const afterFailure = await mission.step(missionId);
			assert.equal(afterFailure.stopReason, "m04-review-pending");
			assert.equal((await ws.listRuns("M04")).length, 2);
			assert.equal(builderCalls, 1);
			const resumed = openDefaultLocalMission({ workspaceRoot: root, runner,
				config: { roles: { research: "fake/research", execution: "fake/execution" },
					localMission: { evaluatorId }, concurrency: 1, tools: {} } });
			assert.equal((await resumed.status(missionId)).stopReason, "m04-review-pending");
			assert.equal((await ws.listRuns("M04")).length, 2);
			const originalCheckpoint = LocalMissionHost.prototype.recordCheckpoint;
			let interrupted = false;
			LocalMissionHost.prototype.recordCheckpoint = async function(input) {
				const next = JSON.parse(input.bytes.toString("utf8")) as {
					boundedRuns?: Array<{ selectedTaskId?: string }> };
				if (!interrupted && next.boundedRuns?.at(-1)?.selectedTaskId) {
					interrupted = true;
					throw new Error("synthetic crash after host selection before mission checkpoint");
				}
				return originalCheckpoint.call(this, input);
			};
			try { await assert.rejects(resumed.run(missionId)); }
			finally { LocalMissionHost.prototype.recordCheckpoint = originalCheckpoint; }
			assert(interrupted);
			assert.equal((await mission.status(missionId)).stopReason, "m04-review-pending");
			const reopened = openDefaultLocalMission({ workspaceRoot: root, runner,
				config: { roles: { research: "fake/research", execution: "fake/execution" },
					localMission: { evaluatorId }, concurrency: 1, tools: {} } });
			const selected = await reopened.run(missionId);
			assert.equal(m04Calls, 2);
			assert.equal((await ws.listRuns("M04")).length, 3);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 2);
			assert.equal(selected.stopReason, "assessment-failed");
			assert.equal(selected.boundedRuns[0]?.selectedTaskId,
				selected.boundedRuns[0]?.acceptedTaskIds?.[0]);
			assert(selected.selectedArtifacts.length > 0);
			return;
		}
		if (variant === "accepted-pending-merge") {
			await assert.rejects(mission.step(missionId), /unknown|merge-pending/);
			const pending = await mission.status(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			assert.deepEqual(pending.selectedArtifacts, []);
			const heldStep = async () => {
				try { assert.equal((await mission.step(missionId)).stopReason, "m04-review-pending"); }
				catch (error) { assert.match(String(error), /unknown|merge-pending/); }
			};
			await heldStep();
			assert.equal((await mission.status(missionId)).stopReason, "m04-review-pending");
			assert.equal((await ws.listRuns("M04")).length, 2);
			await heldStep();
			assert.equal((await ws.listRuns("M04")).length, 2);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 1);
			return;
		}
		if (variant === "accepted-host-abort") {
			await assert.rejects(mission.step(missionId), /synthetic host stop/);
			const pending = await mission.status(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			assert.equal((await ws.listRuns("M04")).length, 2);
			assert.equal(m04Calls, 1);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 1);
			assert.deepEqual((await mission.status(missionId)).selectedArtifacts, []);
			return;
		}
		if (variant === "accepted-claim-before-rename" ||
			variant === "accepted-claim-after-rename") {
			const pending = await mission.step(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			const review = pending.pendingM04Review!;
			const status = await LocalMissionHost.status(path.join(ws.agentDir, "missions", missionId));
			const current = await readCurrentProcessIdentity();
			await assert.rejects(LocalMissionHost.claimPendingM04Review({
				root: path.join(ws.agentDir, "missions", missionId), missionId,
				checkpointSha256: status.latestCheckpoint!.sha256,
				runId: review.runId, taskId: review.taskId,
				checkpointId: review.checkpointId,
				evaluatorReceiptSha256: review.evaluatorReceiptSha256,
				currentIdentity: async () => ({ ...current, pid: 999999,
					processStartToken: "synthetic-departed-owner" }),
				testCrashAt: variant === "accepted-claim-before-rename" ?
					"after-prepare" : "after-rename" }), /synthetic crash/);
			assert.equal((await LocalMissionHost.status(path.join(ws.agentDir,
				"missions", missionId))).writerLockPresent, true);
			const resumed = openDefaultLocalMission({ workspaceRoot: root, runner,
				config: { roles: { research: "fake/research", execution: "fake/execution" },
					localMission: { evaluatorId }, concurrency: 1, tools: {} } });
			assert.equal((await resumed.step(missionId)).stopReason, "m04-review-pending");
			assert.equal((await ws.listRuns("M04")).length, 2);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 1);
			return;
		}
		if (variant === "accepted-feedback-tamper") {
			const pending = await mission.step(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			const review = pending.pendingM04Review!;
			const feedbackFile = path.join(ws.runDir("M07", review.runId),
				"checkpoints", review.checkpointId, "m04-feedback.md");
			const original = await readFile(feedbackFile);
			const changed = Buffer.from(original);
			changed[0] = changed[0] === 65 ? 66 : 65;
			assert.equal(changed.length, original.length);
			await writeFile(feedbackFile, changed);
			await assert.rejects(mission.step(missionId), /pending checkpoint read bytes changed/);
			assert.equal((await ws.listRuns("M04")).length, 2);
			assert.deepEqual((await mission.status(missionId)).selectedArtifacts, []);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 1);
			return;
		}
		if (variant === "accepted-release-failure") {
			assert.equal((await mission.step(missionId)).stopReason, "m04-review-pending");
			const release = LocalMissionHost.releasePendingM04Review;
			let interrupted = false;
			LocalMissionHost.releasePendingM04Review = async (...args) => {
				if (!interrupted) {
					interrupted = true;
					throw new Error("synthetic claim release failure");
				}
				return release(...args);
			};
			try { await assert.rejects(mission.step(missionId), /synthetic claim release failure/); }
			finally { LocalMissionHost.releasePendingM04Review = release; }
			assert(interrupted);
			assert.equal((await ws.listRuns("M04")).length, 2);
			const retried = await mission.step(missionId);
			assert.equal(retried.stopReason, "m04-review-pending");
			assert.equal(retried.pendingM04Review?.m04RunIds.length, 1);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 1);
			return;
		}
		if (variant === "accepted-missing-execution" ||
			variant === "accepted-execute-missing-operation") {
			const pending = await mission.step(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			const goalFile = path.join(ws.runDir("M07", pending.pendingM04Review!.runId), "goal.json");
			const goal = JSON.parse(await readFile(goalFile, "utf8")) as {
				executionState?: { operations: unknown[] } };
			if (variant === "accepted-missing-execution") {
				assert.deepEqual(goal.executionState?.operations, []);
				delete goal.executionState;
			} else {
				assert.equal(goal.executionState?.operations.length, 1);
				goal.executionState!.operations = [];
			}
			await writeFile(goalFile, `${JSON.stringify(goal, null, 2)}\n`);
			await assert.rejects(mission.step(missionId), /returned-operation/);
			assert.equal((await ws.listRuns("M04")).length, 2);
			assert.deepEqual((await mission.status(missionId)).selectedArtifacts, []);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 1);
			return;
		}
		if (variant === "accepted-execute-returned-operation") {
			const pending = await mission.step(missionId);
			assert.equal(pending.stopReason, "m04-review-pending");
			acceptedReads = pending.pendingM04Review!.requiredM07ReadPaths;
			const goal = JSON.parse(await readFile(path.join(ws.runDir("M07",
				pending.pendingM04Review!.runId), "goal.json"), "utf8")) as {
				executionState?: { operations: Array<{ status: string }> } };
			assert.deepEqual(goal.executionState?.operations.map(item => item.status),
				["response-received"]);
			assert.equal((await mission.step(missionId)).stopReason, "m04-review-pending");
			assert.equal((await ws.listRuns("M04")).length, 2);
			const selected = await mission.run(missionId);
			assert.equal(selected.boundedRuns[0]?.selectedTaskId,
				selected.boundedRuns[0]?.acceptedTaskIds?.[0]);
			assert(selected.selectedArtifacts.length > 0);
			assert.equal(selected.stopReason, "assessment-failed");
			assert.equal(m04Calls, 2);
			assert.equal((await ws.listRuns("M04")).length, 3);
			assert.equal(builderCalls, 1);
			assert.equal(assessorCalls, 2);
			assert.equal(evaluatorCalls, 1);
			return;
		}
		await assert.rejects(variant === "runner-abort" || variant === "dom-abort" ?
			mission.run(missionId) : mission.step(missionId));
		const held = await mission.status(missionId);
		assert.equal(held.stopReason, "execution-interrupted");
		assert.equal(held.boundedRuns.length, 0);
		assert.equal(builderCalls, 1);
		assert.equal(assessorCalls, 1);
		assert.equal((await ws.listRuns("M07")).length, 1);
		assert.equal((await ws.listRuns("M04")).length, 1);
		assert.equal((await ws.readRun("M04", (await ws.listRuns("M04"))[0]!)).status, "failed");
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07",
			(await ws.listRuns("M07"))[0]!), "goal.json"), "utf8")) as
			{ tasks: Array<{ status: string }> };
		assert.equal(goal.tasks[0]?.status, "rejected");
		const again = await mission.step(missionId);
		assert.equal(again.stopReason, "execution-interrupted");
		assert.equal(builderCalls, 1);
		assert.equal((await ws.listRuns("M07")).length, 1);
	});

test("default assessor can pass a bounded task check while the original open-ended obligation remains unresolved", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:bounded-task-open-goal", version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			await writeFile(path.join(observationOutputDir, "observation-bounded.txt"),
				"The declared bounded check passed; the broader question remains open.\n", { mode: 0o600 });
			return { observations: [{ name: "observation-bounded.txt", kind: "text" }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: item.id === "bounded" ? "passed" as const : "unknown" as const,
					evidenceRefs: ["observation-bounded.txt"],
					limitations: ["No result establishes the broader question"] })),
				limitations: ["The broad obligation remains unverified"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-bounded-check-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Check one bounded fact while a broad question remains open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const bounded = "Verify the declared bounded fact against the supplied observation";
	const broad = "Find the strongest answer across the open search space";
	let missionId = "";
	let prompts = 0;
	const readAll = async (directory: string, toolName: string): Promise<ReadReturnEvent[]> => {
		const events: ReadReturnEvent[] = [];
		const visit = async (folder: string): Promise<void> => {
			for (const name of await readdir(folder)) {
				const file = path.join(folder, name);
				if ((await stat(file)).isDirectory()) { await visit(file); continue; }
				const bytes = await readFile(file);
				if (bytes.length) events.push({ toolName, status: "returned",
					path: path.relative(directory, file).replaceAll("\\", "/"), requested: {},
					returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
					at: new Date().toISOString() });
			}
		};
		await visit(directory); return events;
	};
	const runner = new FakeSessionRunner(async ({ spec, message }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			prompts++;
			assert(message.includes("each selected original obligation becomes a mandatory check"));
			assert(message.includes("You may choose a strict subset"));
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read grant missing");
			const refs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
			const issues = [
				{ id: "bounded-issue", claim: "The bounded fact is not yet verified", status: "open",
					classification: "explicit-requirement", sourceRefs: refs,
					implication: "A local observation can settle this check" },
				{ id: "broad-issue", claim: "The broad search remains open", status: "open",
					classification: "explicit-requirement", sourceRefs: refs,
					implication: "Finite local evidence cannot close the search" },
			];
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "Test the bounded fact and retain the broader question as open.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["bounded", "broad"],
				unresolvedDetails: issues.map(item => item.claim), groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues, legacyOpenDetails: [],
					nextTask: { objective: "Test only the declared bounded fact",
						obligationIds: ["bounded"], addresses: ["bounded-issue"],
						adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "The local observation can pass the bounded check",
						expectedEvidence: "A host result for the bounded fact", sourceRefs: refs } } }),
				readReturns: await readAll(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) return "A bounded result with a remaining broad gap.";
		if (spec.label === "M04-research") {
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			return { text: "The bounded check passed; the broad search stays open.",
				readReturns: await readAll(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId: "test:bounded-task-open-goal" }, concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Resolve the original bounded and broad questions", goalSource: "verbatim-private-input",
		obligations: [{ id: "bounded", description: bounded, type: "synthetic-open" },
			{ id: "broad", description: broad, type: "synthetic-open" }], closure: "open-ended" });
	missionId = started.contract.id;
	const progress = await mission.step(missionId);
	assert.equal(prompts, 1);
	assert.equal(progress.objectiveOutcome, "incomplete");
	assert.deepEqual(progress.assessment?.unresolvedObligations, ["bounded", "broad"]);
	assert.equal(progress.boundedRuns.length, 1);
	const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", progress.boundedRuns[0]!.runId),
		"goal.json"), "utf8")) as { successCriteria: string[]; tasks: Array<{ checks: string[];
		status: string }> };
	assert.deepEqual(goal.successCriteria, [bounded]);
	assert.deepEqual(goal.tasks[0]?.checks, [bounded]);
	assert.equal(goal.tasks[0]?.status, "accepted");
	const receipt = JSON.parse(await readFile(path.join(ws.runDir("M07", progress.boundedRuns[0]!.runId),
		"tasks/T001/work/local-evaluator-receipt.json"), "utf8")) as
		{ checks: Array<{ obligationId: string; result: string }> };
	assert.deepEqual(receipt.checks.map(item => [item.obligationId, item.result]),
		[["bounded", "passed"], ["broad", "unknown"]]);
});

test("local host repair evidence refuses assessment before the first model prompt", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original question\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; return "No task"; });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the synthetic question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Support the answer" }], closure: "open-ended" });
	const lock = path.join(ws.agentDir, "missions", started.contract.id, ".writer.lock");
	await writeFile(lock, "synthetic incomplete prior mutation\n", { mode: 0o600 });
	await assert.rejects(mission.step(started.contract.id), /unresolved durable-write repair/);
	assert.equal(prompts, 0);
	assert.equal((await ws.listRuns("MISSION")).length, 0);
});

test("changed frozen original bytes cannot silently alter a restarted mission", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-original-change-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Original fixed task\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let prompts = 0;
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: new FakeSessionRunner(() => { prompts++; return "unused"; }),
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original fixed task", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Prove the original answer" }],
		closure: "open-ended" });
	const frozen = path.join(ws.agentDir, "missions", started.contract.id,
		"evidence", "original-problem.txt");
	await writeFile(frozen, "Different fixed task\n");
	await assert.rejects(mission.step(started.contract.id), /original input differs from committed host evidence/);
	assert.equal(prompts, 0);
});

test("binary original input is refused before a local mission gains host authority", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-binary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original question\n");
	await writeFile(path.join(ws.rawDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const mission = openDefaultLocalMission({ workspaceRoot: root });
	await assert.rejects(mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the synthetic question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Support the answer" }], closure: "open-ended" }),
		error => { assert.doesNotMatch(String(error), /image\.png|PNG/); return true; });
	const missionsRoot = path.join(ws.agentDir, "missions");
	const missions = await readdir(missionsRoot).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	assert.deepEqual(missions, [], "no mission is committed for unreadable original input");
});
