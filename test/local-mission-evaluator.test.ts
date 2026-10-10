import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { evaluateLocalM07Task } from "../src/m07/local-evaluator-run.ts";
import { LOCAL_M07_MISSION_BINDING_PREFIX } from "../src/m07/local-m07-adapter.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { recordDefaultSelectionReview } from "../src/m07/local-selection-review.ts";
import { registerTrustedLocalMissionEvaluator, type LocalEvaluationResult } from
	"../src/m07/local-mission-evaluator.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

const answer = "A synthetic finite answer with exact bytes.\n";
const digest = createHash("sha256").update(answer).digest("hex");
const syntheticTaskContract = {
	version: 1 as const, kind: "local-evaluator-task-input-contract" as const,
	instructions: "Write the declared JSON plan before submitting the candidate.",
	artifacts: [{ path: "task-input.json", format: "json" as const,
		schema: { type: "object", required: ["items", "checks"],
			properties: { items: { type: "array", items: { type: "string" } },
				checks: { type: "array", items: { type: "object" } } }, additionalProperties: false },
		example: { items: ["SyntheticItem"], checks: [] } }],
};
const sourceEditContract = { ...syntheticTaskContract,
	instructions: "Edit only the declared candidate source region and supply task-input.json; preserve all other original source bytes." };
const lineCount = (text: string) => text.split(/\r?\n/).length - Number(text.endsWith("\n"));
const selectedCandidate = (names: readonly string[]) => names.find(name =>
	/^candidate-001-[0-9a-f]{16}\.md$/.test(name));
const selectedDigest = (names: readonly string[]) => names.find(name =>
	/^observation-digests-[0-9a-f]{16}\.json$/.test(name));
function assertExactSelection(names: readonly string[]): void {
	assert.equal(names.length, 2);
	assert(selectedCandidate(names));
	assert(selectedDigest(names));
}

function reopenedInNewProcess(root: string, missionId: string, action: "status" | "step" | "run") {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const child = spawnSync(process.execPath, [path.join(import.meta.dirname,
		"fixtures", "local-evaluator-reopen-process.ts"), root, missionId, action],
		{ cwd: path.join(import.meta.dirname, ".."), env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim()) as { valid: boolean; outcome?: string; message?: string };
}

function cliWithTrustedPreload(root: string, action: "start" | "run" | "resume" | "status",
	argument: string, twoStep = false, expectedStatus = 0) {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	if (twoStep) env.MULPIS_SYNTHETIC_TWO_STEP = "1";
	const repo = path.join(import.meta.dirname, "..");
	const child = spawnSync(process.execPath, ["--import", path.join(import.meta.dirname,
		"fixtures", "trusted-cli-evaluator-preload.ts"), path.join(repo, "src", "cli.ts"),
		"mission", action, "--workspace", root,
		...(action === "status" ? [] : ["--runner", "fake"]),
		...(action === "start" ? ["--original", argument] : ["--mission", argument])],
		{ cwd: repo, env, encoding: "utf8" });
	assert.equal(child.status, expectedStatus, `${action}: ${child.stderr}\n${child.stdout}`);
	return JSON.parse(child.stdout.trim()) as Record<string, unknown>;
}

async function readMissionCheckpoint(root: string, missionId: string) {
	const bytes = await LocalMissionHost.readLatestCheckpoint(path.join(root, ".agent", "missions", missionId));
	assert(bytes);
	return JSON.parse(bytes.toString("utf8")) as {
		assessmentHistory: unknown[]; boundedRuns: Array<{ runId: string }>;
		continuation: { unresolvedOperationIds: string[] }; stopReason: string;
	};
}

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const text = await readFile(file, "utf8");
			if (!text.length) {
				events.push({ toolName, status: "no-content",
					path: path.relative(root, file).replaceAll("\\", "/"),
					requested: {}, returned: { kind: "text", truncated: false },
					at: new Date().toISOString() });
				continue;
			}
			events.push({ toolName, status: "returned", path: path.relative(root, file).replaceAll("\\", "/"),
				requested: {}, returned: { kind: "text", startLine: 1,
					endLine: lineCount(text), truncated: false }, at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

async function finiteFixture(t: TestContext, options: {
	candidate?: string; evaluatorId?: string | null; closure?: "finite-evidence" | "open-ended";
	partialObligations?: boolean; exploratory?: boolean; m04FullRead?: boolean;
	obligationType?: string; m04SkipObservation?: boolean;
	expectTaskContract?: boolean; forgeTaskContractAfterAssessment?: boolean;
	emptyAuxiliary?: boolean;
	distinctSecondAssessment?: boolean;
	skipProofGapRead?: boolean;
	repairSecondAssessment?: boolean; skipRepairFeedbackRead?: boolean;
	skipCommittedKnowledgeRead?: boolean;
	seedKnowledge?: boolean; taskContract?: typeof syntheticTaskContract;
	expectedRepairFeedbackSha256?: string; expectedEditContractSha256?: string;
	execution?: "task-root-bash";
} = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-finite-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Produce the exact synthetic finite answer.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	if (options.seedKnowledge) {
		const receipt = await store.submitProposal({ stage: "M04", runId: "synthetic-retained-knowledge",
			ops: [{ op: "create", type: "E", title: "Retained synthetic M04 evidence",
				body: "A synthetic evidence record remains visible to later local tasks.",
				usageDecision: "adopted" }] });
		await store.merge(receipt.proposalId);
	}
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		...(options.evaluatorId === null ? {} : { localMission: {
			evaluatorId: options.evaluatorId ?? "host:file-sha256",
			...(options.execution ? { execution: options.execution } : {}) } }), concurrency: 1, tools: {} };
	let missionId = "";
	let assessorCalls = 0, m04Calls = 0, builderCalls = 0;
	const runner = new FakeSessionRunner(async ({ spec, message }) => {
		if (spec.label === "M04-research") {
			m04Calls++;
			if (spec.tools.kind === "read-dir" &&
				(options.m04FullRead === false || options.m04SkipObservation) && m04Calls > 5)
				throw new DOMException("Synthetic stop after intentionally incomplete M04 reads", "AbortError");
			return spec.tools.kind === "read-dir" ? {
				text: "Independent synthetic M04 read the frozen review materials; no knowledge proposal.",
				readReturns: options.m04FullRead === false ? [] :
					(await readEvents(spec.tools.root, "m07_evidence_read")).filter(event =>
						!options.m04SkipObservation || !event.path.includes("observation-")) } :
				"Initial synthetic M04 baseline; no knowledge proposal.";
		}
		if (spec.label.startsWith("M07-")) {
			builderCalls++;
			if (options.emptyAuxiliary) {
				assert.equal(spec.tools.kind, "execution");
				const deliverable = path.join(spec.tools.root, "deliverable");
				await mkdir(deliverable);
				await writeFile(path.join(deliverable, "compile.log"), "", { mode: 0o600 });
			}
			if (options.expectTaskContract) {
				assert.match(message, /Before producing files, read the complete host-evaluator-task-input-/);
				assert.equal(spec.tools.kind, "read-dir");
				if (spec.tools.kind !== "read-dir") throw new Error("synthetic builder must have copied inputs");
				const inputs = path.join(spec.tools.root, "inputs");
				const name = (await readdir(inputs)).find(item => item.includes("host-evaluator-task-input-"));
				assert(name, "the frozen contract copy must exist before the builder reply");
				const delivered = JSON.parse(await readFile(path.join(inputs, name), "utf8")) as {
					binding: { missionId: string }; contract: unknown };
				assert.equal(delivered.binding.missionId, missionId);
				assert.deepEqual(delivered.contract, options.taskContract ?? syntheticTaskContract);
			}
			return options.candidate ?? answer;
		}
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if ((options.skipProofGapRead || options.skipRepairFeedbackRead ||
				options.skipCommittedKnowledgeRead) && assessorCalls > 4)
				throw new DOMException("Synthetic stop after intentionally incomplete read coverage", "AbortError");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks frozen evidence");
			const readReturns = (await readEvents(spec.tools.root, "objective_evidence_read"))
				.filter(item => !options.skipProofGapRead ||
					!item.path.startsWith("selection-proof-gap-"))
				.filter(item => !options.skipRepairFeedbackRead ||
					!item.path.startsWith("prior-run-1-feedback-"))
				.filter(item => !options.skipCommittedKnowledgeRead ||
					!item.path.startsWith("published-knowledge-") ||
					item.path.endsWith("-index.json"));
			if (options.forgeTaskContractAfterAssessment && assessorCalls === 1) {
				const dir = path.join(ws.agentDir, "missions", missionId, "evidence");
				const name = (await readdir(dir)).find(item => item.startsWith("host-evaluator-task-input-"));
				assert(name);
				await writeFile(path.join(dir, name), "{\"forged\":true}\n");
			}
			const candidateName = selectedCandidate(await readdir(spec.tools.root));
			const issue = { id: "finite-gap", claim: "Exact answer has not been checked", status: "open",
				classification: "explicit-requirement", sourceRefs: [{ sourceId: "original-problem.txt",
					startLine: 1, endLine: 1 }], implication: "A checked candidate can settle this task" };
			if (options.repairSecondAssessment && assessorCalls >= 2) {
				const names = await readdir(spec.tools.root);
				const feedbackName = names.find(item => item.startsWith("prior-run-1-feedback-"));
				const contractName = names.find(item => item.startsWith("host-evaluator-task-input-2-"));
				const knowledgeIndexName = names.find(item => item.startsWith("published-knowledge-") &&
					item.endsWith("-index.json"));
				assert(feedbackName && contractName, "repair feedback and edit contract must be frozen together");
				assert(knowledgeIndexName, "the current committed knowledge index must be frozen");
				const knowledgeIndex = JSON.parse(await readFile(path.join(spec.tools.root,
					knowledgeIndexName), "utf8")) as { snapshotId: string;
					records: Array<{ id: string; version: number }>;
					packSha256: string; parts: Array<{ name: string; sha256: string }> };
				assert.equal(knowledgeIndex.snapshotId, "G001");
				assert.deepEqual(knowledgeIndex.records.map(item => `${item.id}@${item.version}`), ["E001@1"]);
				const assessmentEvidenceRoot = spec.tools.root;
				const knowledgeParts = await Promise.all(knowledgeIndex.parts.map(async part => {
					const bytes = await readFile(path.join(assessmentEvidenceRoot, part.name));
					assert.equal(createHash("sha256").update(bytes).digest("hex"), part.sha256);
					return bytes;
				}));
				assert.equal(createHash("sha256").update(Buffer.concat(knowledgeParts)).digest("hex"),
					knowledgeIndex.packSha256);
				assert.match(Buffer.concat(knowledgeParts).toString("utf8"), /Retained synthetic M04 evidence/);
				assert(readReturns.some(item => item.path === knowledgeIndexName && item.status === "returned"));
				if (!options.skipCommittedKnowledgeRead)
					assert(knowledgeIndex.parts.every(part => readReturns.some(item =>
						item.path === part.name && item.status === "returned")),
						"the assessor must read the committed knowledge pack before dispatch");
				assert.equal(createHash("sha256").update(await readFile(path.join(spec.tools.root,
					feedbackName))).digest("hex"), options.expectedRepairFeedbackSha256);
				assert.equal(createHash("sha256").update(await readFile(path.join(spec.tools.root,
					contractName))).digest("hex"), options.expectedEditContractSha256);
				assert(readReturns.some(item => item.path === contractName && item.status === "returned"),
					"the assessor must read the edit contract before the next task");
				if (!options.skipRepairFeedbackRead)
					assert(readReturns.some(item => item.path === feedbackName && item.status === "returned"),
						"the assessor must read exact repair feedback before the next task");
				assert.equal((await store.current())?.id, "G001",
					"published M04 knowledge must remain visible during repair");
				return { text: JSON.stringify({ version: 1, decision: "continue",
					rationale: "The prior rejected task needs corrected source within the declared edit scope.",
					evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
					unresolvedDetails: [issue.claim], groundedAssessment: {
						version: 1, kind: "grounded-assessment-proposal", contractId: missionId,
						missionStatus: "open", issues: [issue], legacyOpenDetails: [issue.claim],
						nextTask: { objective: "Repair the candidate within the declared source edit scope",
							obligationIds: ["answer"], addresses: [issue.id],
							adapterScope: options.execution ? "local-m07-execute" : "local-m07-reason",
							decisionChangingHypothesis: "The corrected candidate can pass host validation",
							expectedEvidence: "A source-valid candidate and host evaluator receipt",
							sourceRefs: [...issue.sourceRefs,
								...(!options.skipCommittedKnowledgeRead ? [{ sourceId: knowledgeIndex.parts[0]!.name,
									startLine: 1, endLine: 1 }] : [])] } } }), readReturns };
			}
			if (options.distinctSecondAssessment && assessorCalls >= 2) {
				const gapName = (await readdir(spec.tools.root)).find(item =>
					item.startsWith("selection-proof-gap-"));
				assert(gapName, "the missing selection proof must be frozen for the next assessor");
				if (!options.skipProofGapRead)
					assert(readReturns.some(item => item.path === gapName && item.status === "returned"),
						"the next assessor must read the proof gap in full");
				return { text: JSON.stringify({ version: 1, decision: "continue",
					rationale: "The host observation did not cite candidate bytes; a distinct task must supply that proof.",
					evidenceRefs: ["original-problem.txt", gapName],
					unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
					groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
						contractId: missionId, missionStatus: "open", issues: [issue],
						legacyOpenDetails: [issue.claim], nextTask: {
							objective: "Independently cite exact candidate bytes for the host observation",
							obligationIds: ["answer"], addresses: [issue.id],
							adapterScope: options.execution ? "local-m07-execute" : "local-m07-reason",
							decisionChangingHypothesis: "Candidate linked observations can establish selection",
							expectedEvidence: "A passed observation with a candidate citation",
							sourceRefs: issue.sourceRefs } } }), readReturns };
			}
			return { text: JSON.stringify(assessorCalls === 1 ? {
				version: 1, decision: "continue", rationale: "The exact answer still needs a candidate.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [issue.claim], groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Produce the exact synthetic answer", obligationIds: ["answer"],
						addresses: [issue.id], adapterScope: options.execution ? "local-m07-execute" : "local-m07-reason",
						decisionChangingHypothesis: "An exact result can settle the finite obligation",
						expectedEvidence: "A digest checked candidate", sourceRefs: issue.sourceRefs } } } : {
				version: 1, decision: "fulfilled", rationale: "The selected byte-exact result closes the finite requirement.",
				evidenceRefs: [candidateName], unresolvedObligations: [], unresolvedDetails: [],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", legacyOpenDetails: [],
					issues: [{ ...issue, status: "resolved", resolution: {
						explanation: "The selected exact result resolves the original requirement.",
						evidenceRefs: [{ sourceId: candidateName, startLine: 1, endLine: 1 }] } }] } }),
				readReturns };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	if (!options.exploratory) await runM04({ ws, runner, store, config }, { feedback: { kind: "file",
		label: "Synthetic baseline", path: ws.problemFile }, freshSession: true });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Produce the exact synthetic finite answer", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Produce exact answer bytes",
			type: options.obligationType ?? "file-sha256", expectedSha256: digest },
			...(options.partialObligations ? [{ id: "second", description: "Produce a second exact artifact",
				type: "file-sha256", expectedSha256: digest }] : [])],
		closure: options.closure ?? "finite-evidence" });
	missionId = started.contract.id;
	return { root, ws, config, mission, missionId, runner,
		get assessorCalls() { return assessorCalls; },
		get m04Calls() { return m04Calls; }, get builderCalls() { return builderCalls; } };
}

test("default host completes a finite exact-file objective only after evaluator, M07 and full M04 review", async t => {
	const f = await finiteFixture(t);
	const first = await f.mission.step(f.missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assertExactSelection(first.selectedArtifacts);
	assert.equal(first.stopReason, "objective-reassessment-pending");
	assert.equal(first.pendingM04Review, undefined);
	assert.equal(f.assessorCalls, 1);
	assert.equal(f.builderCalls, 1);
	assert.equal(f.m04Calls, 2);
	const finished = await f.mission.step(f.missionId);
	assert.equal(finished.objectiveOutcome, "fulfilled", JSON.stringify({ stopReason: finished.stopReason,
		selected: finished.selectedArtifacts, bounded: finished.boundedRuns, assessmentHistory: finished.assessmentHistory,
		assessorCalls: f.assessorCalls, m04Calls: f.m04Calls, builderCalls: f.builderCalls }));
	assert.equal(finished.boundedRuns.length, 1);
	assert.equal(finished.boundedRuns[0]!.acceptedTaskIds?.length, 1);
	assert.equal(finished.boundedRuns[0]!.selectionProofGap, undefined);
	assertExactSelection(finished.selectedArtifacts);
	assert.equal(f.assessorCalls, 2);
	assert.equal(f.builderCalls, 1);
	assert.equal(f.m04Calls, 2);
	const reopened = openDefaultLocalMission({ workspaceRoot: f.root, runner: new FakeSessionRunner(() => {
		throw new Error("restart must not prompt"); }), config: f.config });
	assert.deepEqual(await reopened.status(f.missionId), finished);
	assert.deepEqual(await reopened.step(f.missionId), finished);
});

test("the next assessor cannot dispatch a task without reading the frozen selection proof gap", async t => {
	registerObservationOnlyEvaluator("test:observation-only-unread-gap");
	const f = await finiteFixture(t, { evaluatorId: "test:observation-only-unread-gap",
		distinctSecondAssessment: true, skipProofGapRead: true });
	const first = await f.mission.step(f.missionId);
	assert.equal(first.boundedRuns.length, 1);
	const second = await f.mission.step(f.missionId);
	assert.equal(second.boundedRuns.length, 1);
	assert.equal(f.builderCalls, 1);
	assert.equal((await f.ws.listRuns("M07")).length, 1);
	assert.equal(second.stopReason, "cancelled");
});

function registerObservationOnlyEvaluator(id: string): void {
	registerTrustedLocalMissionEvaluator({ id, version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-exact.json";
			await writeFile(path.join(observationOutputDir, name), "{\"exact\":true}\n",
				{ flag: "wx", mode: 0o600 });
			return { observations: [{ name, kind: "json" as const }], limitations: [],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "passed" as const, evidenceRefs: [name], limitations: [] })) };
		} });
}

test("observation-only pass remains unselected and advances to a distinct next task without replay", async t => {
	registerObservationOnlyEvaluator("test:observation-only-selection-gap");
	const f = await finiteFixture(t, { evaluatorId: "test:observation-only-selection-gap",
		distinctSecondAssessment: true });
	const first = await f.mission.step(f.missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assert.equal(first.boundedRuns.length, 1);
	assert.deepEqual(first.selectedArtifacts, []);
	assert.equal(first.boundedRuns[0]!.selectedTaskId, undefined);
	assert.equal(first.boundedRuns[0]!.outcome, "partial");
	assert.deepEqual(first.boundedRuns[0]!.acceptedTaskIds, ["T001"]);
	const gap = first.boundedRuns[0]!.selectionProofGap;
	assert(gap);
	assert.equal(gap.reasonCode, "passed-check-missing-candidate-reference");
	assert.deepEqual(gap.missingCandidateObligationIds, ["answer"]);
	assert.match(gap.evaluatorReceiptSha256, /^[0-9a-f]{64}$/);
	const firstRunId = first.boundedRuns[0]!.runId;
	const firstGoalFile = path.join(f.ws.runDir("M07", firstRunId), "goal.json");
	const firstGoalBytes = await readFile(firstGoalFile);
	const firstGoal = await createM07Controller({ ws: f.ws, runner: f.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config }).status(firstRunId);
	assert.equal(firstGoal.tasks[0]!.status, "accepted");
	assert.equal((await f.ws.readRun("M04", gap.m04RunId)).status, "completed");
	const second = await f.mission.step(f.missionId);
	assert.equal(second.boundedRuns.length, 2, JSON.stringify({ stopReason: second.stopReason,
		continuation: second.continuation, assessorCalls: f.assessorCalls,
		builderCalls: f.builderCalls }));
	assert.notEqual(second.boundedRuns[1]!.runId, firstRunId);
	const secondGoal = await createM07Controller({ ws: f.ws, runner: f.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config })
		.status(second.boundedRuns[1]!.runId);
	assert.equal(secondGoal.tasks[0]!.objective,
		"Independently cite exact candidate bytes for the host observation");
	assert.deepEqual(await readFile(firstGoalFile), firstGoalBytes,
		"the old accepted M07 run must not be replayed or rewritten");
	assert.equal(f.assessorCalls, 2);
	assert.equal(f.builderCalls, 2);
	assert.equal((await f.ws.listRuns("M07")).length, 2);
});

test("observation-only proof gap fails closed on receipt, M04 and external-operation tampering", async t => {
	registerObservationOnlyEvaluator("test:observation-only-tamper");
	for (const variant of ["receipt", "m04-incomplete", "m04-transaction", "m07-operation"] as const) {
		await t.test(variant, async sub => {
			const f = await finiteFixture(sub, { evaluatorId: "test:observation-only-tamper",
				distinctSecondAssessment: true });
			const first = await f.mission.step(f.missionId);
			const gap = first.boundedRuns[0]!.selectionProofGap;
			assert(gap);
			if (variant === "receipt") {
				const file = path.join(f.ws.runDir("M07", gap.runId), "tasks", gap.taskId,
					"work", "local-evaluator-receipt.json");
				await writeFile(file, "altered receipt\n");
			} else if (variant === "m04-incomplete") {
				const run = await f.ws.readRun("M04", gap.m04RunId);
				await writeFile(path.join(f.ws.runDir("M04", gap.m04RunId), "run.json"),
					`${JSON.stringify({ ...run, status: "running" }, null, 2)}\n`);
			} else if (variant === "m04-transaction") {
				const file = path.join(f.ws.runDir("M04", gap.m04RunId), "m04-transaction.json");
				const tx = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
				await writeFile(file, `${JSON.stringify({ ...tx, state: "pending" })}\n`);
			} else {
				const file = path.join(f.ws.runDir("M07", gap.runId), "goal.json");
				const goal = JSON.parse(await readFile(file, "utf8")) as {
					executionState: { operations: Array<{ status: string }> } };
				goal.executionState.operations.push({ status: "unknown" });
				await writeFile(file, `${JSON.stringify(goal, null, 2)}\n`);
			}
			await assert.rejects(f.mission.step(f.missionId),
				/receipt|selection|M04|transaction|operation|evidence|checkpoint|missing-proof/i);
			assert.equal(f.assessorCalls, 1, "tampered evidence must stop before assessment");
			assert.equal(f.builderCalls, 1, "tampered evidence must not start another M07 task");
		});
	}
});

test("a rejected task makes exact repair feedback and the edit contract mandatory before another M07 task", async t => {
	for (const variant of ["complete-repair-read", "missing-feedback-read", "missing-knowledge-read"] as const)
		await t.test(variant, async sub => {
			const skipRepairFeedbackRead = variant === "missing-feedback-read";
			const skipCommittedKnowledgeRead = variant === "missing-knowledge-read";
			const evaluatorId = `test:source-edit-repair-${variant}`;
			registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
				supportedObligationTypes: ["file-sha256"], taskInputContract: sourceEditContract,
				async preflight() { return { available: true }; },
				async evaluate({ contract }) { return { observations: [], limitations: [],
					checks: contract.obligations.map(item => ({ obligationId: item.id,
						result: "failed" as const, evidenceRefs: [], limitations: [], schemaErrors: [
							{ artifact: "task-input.json", path: "$.checks",
								message: "candidate source edit exceeded the declared scope" }] })) }; } });
			const options = { evaluatorId, taskContract: sourceEditContract,
				expectTaskContract: true, repairSecondAssessment: true,
				skipRepairFeedbackRead, skipCommittedKnowledgeRead, seedKnowledge: true,
				expectedRepairFeedbackSha256: "", expectedEditContractSha256: "" };
			const f = await finiteFixture(sub, options);
			const first = await f.mission.step(f.missionId);
			assert.equal(first.boundedRuns.length, 1);
			assert.deepEqual(first.selectedArtifacts, []);
			const firstRunId = first.boundedRuns[0]!.runId;
			const firstGoal = await createM07Controller({ ws: f.ws, runner: f.runner,
				store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config }).status(firstRunId);
			assert.equal(firstGoal.tasks[0]!.status, "rejected");
			const sourceFeedback = await readFile(path.join(f.ws.runDir("M07", firstRunId),
				"checkpoints", "C001", "m04-feedback.md"));
			options.expectedRepairFeedbackSha256 = createHash("sha256").update(sourceFeedback).digest("hex");
			const missionEvidence = path.join(f.ws.agentDir, "missions", f.missionId, "evidence");
			const firstContractName = (await readdir(missionEvidence)).find(name =>
				name.startsWith("host-evaluator-task-input-1-"));
			assert(firstContractName);
			options.expectedEditContractSha256 = createHash("sha256")
				.update(await readFile(path.join(missionEvidence, firstContractName))).digest("hex");
			const second = await f.mission.step(f.missionId);
			if (skipRepairFeedbackRead || skipCommittedKnowledgeRead) {
				assert.equal(second.boundedRuns.length, 1);
				assert.equal(f.builderCalls, 1);
				assert.equal((await f.ws.listRuns("M07")).length, 1);
				assert.equal(second.stopReason, "cancelled");
			} else {
				assert.equal(second.boundedRuns.length, 2, String(second.stopReason));
				assert.equal(f.assessorCalls, 2);
				assert.equal(f.builderCalls, 2);
				const goal = await createM07Controller({ ws: f.ws, runner: f.runner,
					store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config })
					.status(second.boundedRuns[1]!.runId);
				assert(goal.tasks[0]!.objective.startsWith(
					"Repair the candidate within the declared source edit scope\n"));
				assert.equal(goal.knowledgeSnapshot, "G001");
				assert.equal((await createFileKnowledgeStore(f.ws.knowledgeDir).current())?.id, "G001");
			}
		});
});

test("zero-byte auxiliary candidate survives receipt, review, checkpoint and selected-artifact verification", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:empty-selected-auxiliary", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate, observationOutputDir }) {
			const empty = candidate.find(item => item.sourceFile.endsWith("compile.log"));
			assert(empty);
			assert.equal(empty.bytes, 0);
			assert.equal(empty.sha256, createHash("sha256").update("").digest("hex"));
			const name = "observation-empty.json";
			await writeFile(path.join(observationOutputDir, name),
				`${JSON.stringify({ reportSha256: candidate[0]!.sha256,
					auxiliarySha256: empty.sha256 })}\n`, { flag: "wx", mode: 0o600 });
			return { observations: [{ name, kind: "json" as const }], limitations: [],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "passed" as const,
					evidenceRefs: [candidate[0]!.name, empty.name, name], limitations: [] })) };
		} });
	const f = await finiteFixture(t, { evaluatorId: "test:empty-selected-auxiliary",
		execution: "task-root-bash", emptyAuxiliary: true });
	const first = await f.mission.step(f.missionId);
	assert.equal(first.boundedRuns.length, 1);
	assert.equal(first.boundedRuns[0]!.acceptedTaskIds?.length, 1);
	assert(first.selectedArtifacts.some(name => name.endsWith(".log")));
	const reopened = openDefaultLocalMission({ workspaceRoot: f.root,
		runner: f.runner, config: f.config });
	assert.deepEqual(await reopened.status(f.missionId), first);
	const finished = await reopened.step(f.missionId);
	assert.equal(finished.objectiveOutcome, "fulfilled");
	assert.equal(finished.assessment?.unreadEvidence.length, 0);
	assert(finished.selectedArtifacts.some(name => name.endsWith(".log")));
	assert.equal(f.builderCalls, 1);
});

test("an empty returned report cannot become a candidate even when an auxiliary file exists", async t => {
	const f = await finiteFixture(t, { candidate: "", emptyAuxiliary: true,
		execution: "task-root-bash" });
	await assert.rejects(f.mission.step(f.missionId), /task report: empty/);
	assert.equal(f.builderCalls, 1);
	assert.equal((await f.ws.listRuns("M04")).length, 1);
});

test("a throwing evaluator leaves its partial observation and holds the committed mission dispatch", async t => {
	const partialBytes = Buffer.from("partial evaluator measurement before failure\n", "utf8");
	let preflights = 0, evaluations = 0;
	registerTrustedLocalMissionEvaluator({ id: "test:partial-observation-throw", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { preflights++; return { available: true }; },
		async evaluate({ observationOutputDir }) {
			evaluations++;
			await writeFile(path.join(observationOutputDir, "observation-partial.txt"), partialBytes,
				{ flag: "wx", mode: 0o600 });
			throw new Error("synthetic evaluator failed after partial observation");
		} });
	const f = await finiteFixture(t, { evaluatorId: "test:partial-observation-throw",
		execution: "task-root-bash" });
	const initialM04 = (await f.ws.listRuns("M04")).length;
	await assert.rejects(f.mission.step(f.missionId),
		/synthetic evaluator failed after partial observation/);
	assert.equal(f.assessorCalls, 1);
	assert.equal(f.builderCalls, 1);
	assert.equal(evaluations, 1);
	const m07Runs = await f.ws.listRuns("M07");
	assert.equal(m07Runs.length, 1);
	const runId = m07Runs[0]!;
	const goal = await createM07Controller({ ws: f.ws, runner: f.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config }).status(runId);
	assert.equal(goal.tasks.length, 1);
	assert.equal(goal.tasks[0]!.status, "returned");
	assert.equal(goal.executionState?.operations.length, 1);
	assert.equal(goal.executionState?.operations[0]!.status, "response-received");
	assert.equal(goal.checkpoints?.length ?? 0, 0, "evaluation did not reach C001");
	const observation = path.join(path.dirname(goal.tasks[0]!.workDir),
		"host-evaluator-output", "observation-partial.txt");
	assert.deepEqual(await readFile(observation), partialBytes);
	assert.equal((await stat(observation)).mode & 0o777, 0o600);
	assert.equal((await f.ws.listRuns("M04")).length, initialM04);
	const missionRuns = await f.ws.listRuns("MISSION");
	assert.equal(missionRuns.length, 1, "dispatch intent has a durable MISSION run");
	const intentId = missionRuns[0]!;
	assert.equal((await f.ws.readRun("MISSION", intentId)).status, "failed");
	assert.deepEqual((await readMissionCheckpoint(f.root, f.missionId)).continuation
		.unresolvedOperationIds, [intentId], "the no-replay dispatch intent was committed");

	const held = await f.mission.step(f.missionId);
	assert.equal(held.objectiveOutcome, "incomplete");
	assert.equal(held.stopReason, "execution-interrupted");
	assert.equal(held.boundedRuns.length, 0, "the M07 result was never represented in mission progress");
	assert(held.continuation.unresolvedOperationIds.includes(runId));
	assert(held.continuation.unresolvedOperationIds.includes(intentId));
	assert.equal(f.builderCalls, 1, "the builder was not replayed");
	assert.equal(evaluations, 1, "the evaluator was not replayed");
	assert.equal((await f.ws.listRuns("M07")).length, 1);
	assert.equal((await f.ws.listRuns("M04")).length, initialM04);
	assert.deepEqual(await readFile(observation), partialBytes,
		"the unclaimed partial observation bytes remain on disk");
	assert(preflights >= 2);
});

test("a preflight-declined evaluator never commits an M07 dispatch intent", async t => {
	let preflights = 0, evaluations = 0;
	registerTrustedLocalMissionEvaluator({ id: "test:preflight-declined-before-dispatch", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { preflights++; return { available: false,
			reason: "synthetic evaluator unavailable before dispatch" }; },
		async evaluate() { evaluations++; throw new Error("preflight-declined evaluator must not run"); } });
	const f = await finiteFixture(t, { evaluatorId: "test:preflight-declined-before-dispatch",
		execution: "task-root-bash" });
	const held = await f.mission.step(f.missionId);
	assert.equal(held.stopReason, "next-task-needs-capability");
	assert.equal(held.continuation.pendingAction?.kind, "supply-capability");
	assert.equal(f.assessorCalls, 0);
	assert.equal(f.builderCalls, 0);
	assert.equal(evaluations, 0);
	assert(preflights >= 1);
	assert.deepEqual(await f.ws.listRuns("M07"), []);
	assert.deepEqual(await f.ws.listRuns("MISSION"), []);
});

test("a second preflight decline after the builder returns freezes negative feedback without replay", async t => {
	let preflights = 0, evaluations = 0;
	registerTrustedLocalMissionEvaluator({ id: "test:preflight-declined-after-builder", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { preflights++; return preflights === 1 ? { available: true } :
			{ available: false, reason: "synthetic capacity changed after assessor" }; },
		async evaluate() { evaluations++; throw new Error("declined evaluator must not enter evaluate"); } });
	const f = await finiteFixture(t, { evaluatorId: "test:preflight-declined-after-builder",
		execution: "task-root-bash" });
	const baselineM04 = (await f.ws.listRuns("M04")).length;
	const first = await f.mission.step(f.missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assert.equal(first.boundedRuns.length, 1);
	assert.equal(first.boundedRuns[0]!.outcome, "partial");
	assert.deepEqual(first.boundedRuns[0]!.acceptedTaskIds, []);
	assert.deepEqual(first.selectedArtifacts, []);
	assert.equal(f.builderCalls, 1);
	assert.equal(evaluations, 0);
	assert.equal((await f.ws.listRuns("M04")).length, baselineM04);
	const runId = first.boundedRuns[0]!.runId;
	const goal = await createM07Controller({ ws: f.ws, runner: f.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config }).status(runId);
	assert.equal(goal.tasks[0]!.status, "rejected");
	assert.equal(goal.executionState?.operations[0]?.status, "response-received");
	assert.equal(goal.checkpoints?.length ?? 0, 1);
	assert.equal(goal.outcome, "partial");
	assert.equal(goal.tasks[0]!.review?.checks[0]?.result, "not_run");
	assert(goal.tasks[0]!.review?.failures.some(failure => failure.includes("before its host evaluation")));
	const second = await f.mission.step(f.missionId);
	assert.equal(second.stopReason, "next-task-needs-capability");
	assert.equal(f.builderCalls, 1, "the returned model task was never replayed");
	assert.equal(evaluations, 0);
	assert.equal((await f.ws.listRuns("M07")).length, 1);
});

test("future M07 task receives the exact trusted input shape before model work and keeps it on reopen", async t => {
	const declared = structuredClone(syntheticTaskContract);
	registerTrustedLocalMissionEvaluator({ id: "test:declared-task-shape", version: "1",
		supportedObligationTypes: ["file-sha256"], taskInputContract: declared,
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate, observationOutputDir }) {
			const name = "observation-task-shape.json";
			await writeFile(path.join(observationOutputDir, name), "{\"validated\":true}\n", { mode: 0o600 });
			return { observations: [{ name, kind: "json" as const }], limitations: [],
			checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "passed" as const, evidenceRefs: [candidate[0]!.name, name], limitations: [] })) }; } });
	const f = await finiteFixture(t, { evaluatorId: "test:declared-task-shape", expectTaskContract: true });
	const first = await f.mission.step(f.missionId);
	assert.equal(f.builderCalls, 1);
	const runId = first.boundedRuns[0]!.runId;
	const goal = await createM07Controller({ ws: f.ws, runner: f.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config }).status(runId);
	const copy = goal.tasks[0]!.inputCopies.find(item => path.basename(item.source).startsWith("host-evaluator-task-input-"));
	assert(copy, "task must receive a copied frozen contract");
	const delivered = JSON.parse(await readFile(copy.copy, "utf8")) as { binding: { missionId: string;
		evaluatorId: string; evaluatorVersion: string; contractSha256: string }; contract: unknown };
	assert.deepEqual(delivered.contract, declared);
	assert.equal(delivered.binding.missionId, f.missionId);
	assert.equal(delivered.binding.evaluatorId, "test:declared-task-shape");
	assert.equal(delivered.binding.evaluatorVersion, "1");
	assert.equal(delivered.binding.contractSha256,
		createHash("sha256").update(JSON.stringify(declared)).digest("hex"));
	const reopened = openDefaultLocalMission({ workspaceRoot: f.root, runner: f.runner, config: f.config });
	assert.deepEqual(await reopened.status(f.missionId), first);
	declared.instructions = "Altered without an evaluator version change.";
	await assert.rejects(reopened.step(f.missionId), /task input contract identity changed across reopen/);
	assert.equal(f.builderCalls, 1);
});

test("malformed declarations and forged frozen task contract fail closed", async t => {
	assert.throws(() => registerTrustedLocalMissionEvaluator({ id: "test:bad-task-shape", version: "1",
		supportedObligationTypes: ["file-sha256"],
		taskInputContract: { ...syntheticTaskContract, artifacts: [
			{ ...syntheticTaskContract.artifacts[0]!, path: "../outside.json" }] },
		async preflight() { return { available: true }; },
		async evaluate() { throw new Error("never evaluate"); } }), /task input contract is invalid/);
	const f = await finiteFixture(t, { evaluatorId: "test:declared-task-shape",
		forgeTaskContractAfterAssessment: true });
	await assert.rejects(f.mission.step(f.missionId), /task input contract bytes changed/);
	assert.equal(f.builderCalls, 0);
});

test("evaluator schema mismatch reaches bounded M07 repair feedback", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:schema-mismatch", version: "1",
		supportedObligationTypes: ["file-sha256"], taskInputContract: syntheticTaskContract,
		async preflight() { return { available: true }; },
		async evaluate({ contract }) { return { observations: [], limitations: [],
			checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "failed" as const, evidenceRefs: [], limitations: [], schemaErrors: [
					{ artifact: "task-input.json", path: "$.items",
						message: "required top-level array is missing" }] })) }; } });
	const f = await finiteFixture(t, { evaluatorId: "test:schema-mismatch", expectTaskContract: true });
	const first = await f.mission.step(f.missionId);
	const runId = first.boundedRuns[0]!.runId;
	const feedback = await readFile(path.join(f.ws.runDir("M07", runId), "m04-feedback.md"), "utf8");
	assert.match(feedback, /Schema error in task-input\.json at \$\.items: required top-level array is missing/);
});

test("finite mission without a registered evaluator reports a capability gap before assessment", async t => {
	const f = await finiteFixture(t, { evaluatorId: null });
	const result = await f.mission.step(f.missionId);
	assert.equal(result.objectiveOutcome, "incomplete");
	assert.equal(result.stopReason, "next-task-needs-capability");
	assert.equal(result.continuation.pendingAction?.kind, "supply-capability");
	assert.equal(f.assessorCalls, 0);
	assert.equal(f.builderCalls, 0);
});

test("a missing evaluator can be registered and the same mission resumes with both capability observations", async t => {
	const f = await finiteFixture(t, { evaluatorId: null });
	const held = await f.mission.step(f.missionId);
	assert.equal(held.stopReason, "next-task-needs-capability");
	assert.equal(held.continuation.pendingAction?.kind, "supply-capability");
	assert.equal(held.continuation.pendingAction?.humanRequired, undefined);
	assert.equal(f.assessorCalls, 0);
	const evidenceDir = path.join(f.ws.agentDir, "missions", f.missionId, "evidence");
	const before = (await readdir(evidenceDir)).filter(name => name.startsWith("host-capability-"));
	assert.equal(before.length, 1);
	const earlier = await readFile(path.join(evidenceDir, before[0]!));
	const recovered = openDefaultLocalMission({ workspaceRoot: f.root, runner: f.runner,
		config: { ...f.config, localMission: { evaluatorId: "host:file-sha256" } } });
	const first = await recovered.step(f.missionId);
	assertExactSelection(first.selectedArtifacts);
	assert.equal(f.assessorCalls, 1);
	const after = (await readdir(evidenceDir)).filter(name => name.startsWith("host-capability-"));
	assert.equal(after.length, 2);
	assert.deepEqual(await readFile(path.join(evidenceDir, before[0]!)), earlier);
});

test("finite and open objectives hold for unsupported and preflight-declined evaluators", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:declined-preflight", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: false, reason: "synthetic dependency unavailable" }; },
		async evaluate() { throw new Error("evaluation must not run after declined preflight"); } });
	for (const closure of ["finite-evidence", "open-ended"] as const) {
		for (const options of [{ evaluatorId: "host:file-sha256", obligationType: "unsupported-type" },
			{ evaluatorId: "test:declined-preflight" }, { evaluatorId: null }] as const) {
			const f = await finiteFixture(t, { ...options, closure });
			const held = await f.mission.step(f.missionId);
			assert.equal(held.stopReason, "next-task-needs-capability");
			assert.equal(held.continuation.pendingAction?.humanRequired, undefined);
			assert.equal(f.assessorCalls, 0);
			assert.equal(f.builderCalls, 0);
		}
	}
});

test("unsupported obligation type is a host capability gap before assessor work", async t => {
	const f = await finiteFixture(t, { obligationType: "test-unsupported" });
	const result = await f.mission.step(f.missionId);
	assert.equal(result.stopReason, "next-task-needs-capability");
	assert.equal(result.continuation.pendingAction?.kind, "supply-capability");
	assert.equal(f.assessorCalls, 0);
});

test("model-authored verification and stale post-evaluation candidate bytes cannot enter host observations", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:model-observation-claim", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate }) {
			return { observations: [{ name: "observation-model.txt", kind: "text" }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "passed" as const,
					evidenceRefs: [candidate[0]!.name, "observation-model.txt"], limitations: [] })),
				limitations: [] };
		} });
	const modelClaim = await finiteFixture(t, { evaluatorId: "test:model-observation-claim",
		candidate: "The model claims observation-model.txt proves success.\n" });
	await assert.rejects(modelClaim.mission.step(modelClaim.missionId),
		/observation members are missing or extra/);
	registerTrustedLocalMissionEvaluator({ id: "test:stale-candidate", version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate, observationOutputDir }) {
			const name = "observation-stale.json";
			await writeFile(path.join(observationOutputDir, name), "{\"measured\":true}\n",
				{ mode: 0o600 });
			await writeFile(candidate[0]!.sourceFile, "altered after evaluator snapshot\n");
			return { observations: [{ name, kind: "json" }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "passed" as const, evidenceRefs: [candidate[0]!.name, name], limitations: [] })),
				limitations: [] };
		} });
	const stale = await finiteFixture(t, { evaluatorId: "test:stale-candidate" });
	await assert.rejects(stale.mission.step(stale.missionId), /candidate bytes changed after evaluation/);
});

test("evaluator observation declaration rejects path escape and extra output members", async t => {
	for (const variant of ["escape", "extra"] as const) {
		const id = `test:observation-${variant}`;
		registerTrustedLocalMissionEvaluator({ id, version: "1",
			supportedObligationTypes: ["file-sha256"],
			async preflight() { return { available: true }; },
			async evaluate({ contract, candidate, observationOutputDir }) {
				const name = variant === "escape" ? "../observation-escape.txt" : "observation-declared.txt";
				if (variant === "extra") {
					await writeFile(path.join(observationOutputDir, name), "declared log\n", { mode: 0o600 });
					await writeFile(path.join(observationOutputDir, "observation-extra.txt"), "extra log\n",
						{ mode: 0o600 });
				}
				return { observations: [{ name, kind: "text" }],
					checks: contract.obligations.map(item => ({ obligationId: item.id,
						result: "passed" as const, evidenceRefs: [candidate[0]!.name, name],
						limitations: [] })), limitations: [] };
			} });
		const f = await finiteFixture(t, { evaluatorId: id });
		await assert.rejects(f.mission.step(f.missionId), /observation/i, variant);
	}
});

test("failed, not_run and unknown evaluator checks cannot accept or select a task", async t => {
	const wrongBytes = await finiteFixture(t, { candidate: "A different synthetic answer.\n" });
	const wrongResult = await wrongBytes.mission.step(wrongBytes.missionId);
	assert.deepEqual(wrongResult.selectedArtifacts, []);
	assert.deepEqual(wrongResult.boundedRuns[0]!.acceptedTaskIds, []);
	for (const result of ["failed", "not_run", "unknown"] as LocalEvaluationResult[]) {
		const id = `test:finite-${result}`;
		registerTrustedLocalMissionEvaluator({ id, version: "1",
			supportedObligationTypes: ["file-sha256"],
			async preflight() { return { available: true }; },
			async evaluate({ contract, observationOutputDir }) {
				const name = "observation-negative.json";
				await writeFile(path.join(observationOutputDir, name),
					`${JSON.stringify({ kind: "synthetic-negative-check", result })}\n`, { mode: 0o600 });
				return { checks: contract.obligations.map(item => ({
					obligationId: item.id, result, evidenceRefs: [name],
					limitations: [`synthetic ${result}`] })),
					observations: [{ name, kind: "json" }], limitations: [] };
			} });
		const f = await finiteFixture(t, { evaluatorId: id });
		const first = await f.mission.step(f.missionId);
		assert.deepEqual(first.selectedArtifacts, [], result);
		assert.deepEqual(first.boundedRuns[0]!.acceptedTaskIds, [], result);
		const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", first.boundedRuns[0]!.runId),
			"goal.json"), "utf8")) as { tasks: Array<{ status: string;
			review: { checks: Array<{ result: string; evidence: string[] }>; artifacts: Array<{ sourcePath: string }> } }> };
		assert.equal(goal.tasks[0]!.status, "rejected", result);
		assert.equal(goal.tasks[0]!.review.checks[0]!.result, result === "unknown" ? "not_run" : result);
		assert(goal.tasks[0]!.review.checks[0]!.evidence.length > 0, result);
		assert(goal.tasks[0]!.review.artifacts.some(item => item.sourcePath?.endsWith("observation-negative.json")), result);
	}
});

test("partial obligations, exploratory work and open-ended objectives stay open", async t => {
	const partial = await finiteFixture(t, { partialObligations: true });
	assertExactSelection((await partial.mission.step(partial.missionId)).selectedArtifacts);
	const exploratory = await finiteFixture(t, { exploratory: true });
	assert.deepEqual((await exploratory.mission.step(exploratory.missionId)).selectedArtifacts, []);
	const open = await finiteFixture(t, { closure: "open-ended" });
	const first = await open.mission.step(open.missionId);
	assertExactSelection(first.selectedArtifacts);
	const second = await open.mission.step(open.missionId);
	assert.equal(second.objectiveOutcome, "incomplete");
	assert.equal(second.stopReason, "model-closure-unverified");
});

test("two open-ended rounds select reviewed local incumbents while global optimality remains unknown", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-two-round-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Find a correct, measured local candidate; global optimality is open.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	let missionId = "", assessorCalls = 0, builderCalls = 0, evaluatorCalls = 0;
	let firstSelected: string[] = [];
	registerTrustedLocalMissionEvaluator({ id: "test:two-round-metrics", version: "1",
		supportedObligationTypes: ["test-correctness", "test-performance", "test-optimality"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate, frozenEvidence, observationOutputDir }) {
			evaluatorCalls++;
			if (evaluatorCalls === 2)
				assert(firstSelected.every(name => frozenEvidence.some(item => item.name === name)));
			const observation = "observation-metrics.json";
			await writeFile(path.join(observationOutputDir, observation),
				`${JSON.stringify({ candidateSha256: candidate[0]!.sha256, round: evaluatorCalls })}\n`,
				{ mode: 0o600 });
			return { observations: [{ name: observation, kind: "json" }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: item.id === "optimality" ? "unknown" as const : "passed" as const,
					evidenceRefs: [candidate[0]!.name, observation],
					limitations: item.id === "optimality" ? ["No global proof"] : [] })),
				limitations: ["Synthetic local measurements only"] };
		} });
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:two-round-metrics" }, concurrency: 1, tools: {} };
	const source = { sourceId: "original-problem.txt", startLine: 1, endLine: 1 };
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label === "M04-research") return spec.tools.kind === "read-dir" ?
			{ text: "Independent M04 read the frozen task and host observations.",
				readReturns: await readEvents(spec.tools.root, "m07_evidence_read") } :
			"Synthetic baseline review.";
		if (spec.label.startsWith("M07-")) return `candidate round ${++builderCalls}\n`;
		if (!spec.label.startsWith("local-original-objective-") || spec.tools.kind !== "read-dir")
			throw new Error(`unexpected fake session ${spec.label}`);
		assessorCalls++;
		const names = await readdir(spec.tools.root);
		const previousCandidate = selectedCandidate(names);
		const baseline = { id: "baseline", claim: "A local baseline needs checking", status: "open",
			classification: "explicit-requirement", sourceRefs: [source],
			implication: "A bounded candidate can establish local checks" };
		const global = { id: "global", claim: "Global optimality remains unproved", status: "open",
			classification: "explicit-requirement", sourceRefs: [source],
			implication: "Keep the original scientific proposition open" };
		const improvement = { id: "improvement", claim: "A new measured candidate may improve the incumbent",
			status: "open", classification: "explicit-requirement", sourceRefs: [source],
			implication: "A second bounded candidate could change the local incumbent" };
		const second = assessorCalls === 2;
		if (second) assert(firstSelected.every(name => names.includes(name)));
		const nextTask = { objective: second ? "Measure a second local candidate" :
			"Build and measure a correct local candidate",
			obligationIds: second ? ["performance"] : ["correctness", "performance"],
			addresses: [second ? "improvement" : "baseline"], adapterScope: "local-m07-reason",
			decisionChangingHypothesis: "A measured candidate can change the local selection",
			expectedEvidence: "A host-owned metric observation and candidate bytes", sourceRefs: [source] };
		return { text: JSON.stringify({ version: 1, decision: "continue",
			rationale: "The original remains open while local evidence can improve.",
			evidenceRefs: second ? [previousCandidate] : ["original-problem.txt"],
			unresolvedObligations: second ? ["performance", "optimality"] :
				["correctness", "performance", "optimality"],
			unresolvedDetails: second ? [global.claim, improvement.claim] : [baseline.claim, global.claim],
			groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
				contractId: missionId, missionStatus: "open", legacyOpenDetails: [],
				issues: second ? [{ ...baseline, status: "resolved", resolution: {
					explanation: "The prior local candidate was checked.",
					evidenceRefs: [{ sourceId: previousCandidate, startLine: 1, endLine: 1 }] } },
					global, improvement] : [baseline, global], nextTask } }),
			readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
	});
	await runM04({ ws, runner, store, config }, { feedback: { kind: "file",
		label: "Synthetic baseline", path: ws.problemFile }, freshSession: true });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Find a correct, measured local candidate and assess global optimality",
		goalSource: "verbatim-private-input", closure: "open-ended",
		obligations: [{ id: "correctness", description: "Establish local correctness", type: "test-correctness" },
			{ id: "performance", description: "Measure local performance", type: "test-performance" },
			{ id: "optimality", description: "Prove global optimality", type: "test-optimality" }] });
	missionId = started.contract.id;
	const first = await mission.step(missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assert.equal(first.boundedRuns.length, 1);
	assert.equal(first.boundedRuns[0]!.acceptedTaskIds?.length, 1);
	assert.equal(firstSelected.length, 0);
	firstSelected = [...first.selectedArtifacts];
	const second = await mission.step(missionId);
	assert.equal(second.objectiveOutcome, "incomplete");
	assert.equal(second.boundedRuns.length, 2);
	assert.equal(second.boundedRuns[1]!.acceptedTaskIds?.length, 1);
	assert(second.selectedArtifacts.every(name => !firstSelected.includes(name)));
	assert.equal(assessorCalls, 2);
	assert.equal(builderCalls, 2);
	assert.equal(evaluatorCalls, 2);
	for (const row of second.boundedRuns) {
		const selection = JSON.parse(await readFile(path.join(ws.agentDir, "missions", missionId,
			"evidence", `selection-review-${row.runId}.json`), "utf8")) as
			{ originalChecks: Array<{ obligationId: string; result: string; passed: boolean }> };
		assert.deepEqual(selection.originalChecks.map(item => [item.obligationId, item.result]),
			[["correctness", "passed"], ["performance", "passed"], ["optimality", "unknown"]]);
		assert.equal(selection.originalChecks[2]!.passed, false);
	}
});

test("a settled rejected M07 attempt does not hide a later reviewed local selection", async t => {
	const f = await finiteFixture(t);
	const contract = (await f.mission.status(f.missionId)).contract;
	const ctx = { ws: f.ws, runner: f.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir), config: f.config };
	const controller = createM07Controller(ctx);
	const criterion = contract.obligations[0]!.description;
	const goal = await controller.begin({ goal: "Select a checked local attempt",
		problemRelation: `${LOCAL_M07_MISSION_BINDING_PREFIX}${contract.id}\n${contract.goal}`,
		constraints: [criterion], successCriteria: [criterion], plan: "Review both attempts" });
	const first = await controller.delegate(goal.runId, { objective: "First attempt",
		mode: "reason", inputs: [goal.problemSnapshotPath], expectedOutputs: [], checks: [criterion] });
	assert(first.reportPath);
	const rejected = await controller.review(goal.runId, { taskId: first.taskId,
		artifacts: [first.reportPath], checks: [{ criterion, result: "failed",
			evidence: [first.reportPath] }] });
	assert.equal(rejected.status, "rejected");
	const second = await controller.delegate(goal.runId, { objective: "Second attempt",
		mode: "reason", inputs: [goal.problemSnapshotPath], expectedOutputs: [], checks: [criterion] });
	const evaluated = await evaluateLocalM07Task({ contract, goal: await controller.status(goal.runId),
		task: second, evidence: [], evaluatorId: "host:file-sha256",
		frozenOriginalInputs: [], capabilities: [] });
	const accepted = await controller.review(goal.runId, evaluated.review);
	assert.equal(accepted.status, "accepted");
	const checkpoint = await controller.checkpoint(goal.runId, { taskIds: [second.taskId] });
	const snapshot = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as {
		tasks: Array<{ taskId: string; review?: { artifacts: Array<{ path: string; mediaType: string }> } }> };
	const selectedTask = snapshot.tasks.find(item => item.taskId === second.taskId)!;
	const requiredM07ReadPaths = [...new Set(["goal.json", "manifest.json", "m04-feedback.md",
		...(selectedTask.review?.artifacts ?? []).filter(item => item.mediaType === "text")
			.map(item => path.relative(checkpoint.rootDir, item.path).replaceAll("\\", "/"))])];
	const m04 = await runM04(ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId,
		checkpointId: checkpoint.id }, freshSession: true, requiredM07ReadPaths });
	await controller.plan(goal.runId, goal.plan, { refreshBaseline: true,
		checkpointId: checkpoint.id, m04RunId: m04.record.runId });
	await controller.finish(goal.runId, { outcome: "partial", summary: "The second task passed locally",
		returnPath: "M04", goalChecks: accepted.review!.checks.map(item => ({ ...item })) });
	const finished = await controller.status(goal.runId);
	assert.equal(finished.formalBaseline, true, JSON.stringify({ exploratory: finished.exploratory,
		formalBaseline: finished.formalBaseline, lifecycle: finished.lifecycle, outcome: finished.outcome,
		tasks: finished.tasks.map(item => ({ taskId: item.taskId, status: item.status })) }));
	const selectionInput = { ctx, controller, contract,
		root: path.join(f.ws.agentDir, "missions", f.missionId),
		run: { runId: goal.runId, outcome: "partial", acceptedTaskIds: [second.taskId],
			selectedTaskId: second.taskId, m04RunId: m04.record.runId,
			checkpointId: checkpoint.id, evaluatorReceiptPath: evaluated.receiptFile,
			requiredM07ReadPaths } };
	const review = await recordDefaultSelectionReview(selectionInput);
	assert(review);
	assert.equal(review.taskId, second.taskId);
	assert.equal(review.originalChecks[0]!.result, "passed");
	assert.equal((await controller.status(goal.runId)).tasks[0]!.status, "rejected");
	const goalFile = path.join(f.ws.runDir("M07", goal.runId), "goal.json");
	for (const status of ["running", "unknown"] as const) {
		const unsettled = JSON.parse(await readFile(goalFile, "utf8")) as
			{ tasks: Array<{ status: string }> };
		unsettled.tasks[0]!.status = status;
		await writeFile(goalFile, `${JSON.stringify(unsettled, null, 2)}\n`);
		await assert.rejects(recordDefaultSelectionReview(selectionInput),
			/settled, formally reviewed mission task/, status);
	}
});

test("tampered selection identity or candidate bytes block restart before any new assessor", async t => {
	for (const variant of ["mission", "task", "m04", "source-bytes", "snapshot-bytes"] as const) {
		const f = await finiteFixture(t);
		const first = await f.mission.step(f.missionId);
		const before = f.assessorCalls;
		const selectionFile = path.join(f.ws.agentDir, "missions", f.missionId,
			"evidence", `selection-review-${first.boundedRuns[0]!.runId}.json`);
		const review = JSON.parse(await readFile(selectionFile, "utf8")) as {
			taskId: string; m04RunId: string; hostEvidence: { missionId: string };
			selectedArtifacts: Array<{ file: string }> };
		if (variant === "mission") review.hostEvidence.missionId = "wrong-mission";
		if (variant === "task") review.taskId = "T999";
		if (variant === "m04") review.m04RunId = "wrong-M04";
		if (["mission", "task", "m04"].includes(variant))
			await writeFile(selectionFile, `${JSON.stringify(review, null, 2)}\n`);
		if (variant === "source-bytes") {
			const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", first.boundedRuns[0]!.runId),
				"goal.json"), "utf8")) as { tasks: Array<{ reportPath: string }> };
			await writeFile(goal.tasks[0]!.reportPath, "changed after evaluation\n");
		}
		if (variant === "snapshot-bytes") {
			await chmod(review.selectedArtifacts[0]!.file, 0o600);
			await writeFile(review.selectedArtifacts[0]!.file, "changed frozen candidate\n");
		}
		await assert.rejects(f.mission.step(f.missionId), /selection|evaluator|M04|m04|candidate/i,
			variant);
		assert.equal(f.assessorCalls, before, variant);
	}
});

test("missing full M04 read and unresolved knowledge transaction cannot select", async t => {
	const unread = await finiteFixture(t, { m04FullRead: false });
	await assert.rejects(unread.mission.step(unread.missionId), error =>
		error instanceof Error && error.name === "AbortError");
	const unreadHeld = await unread.mission.status(unread.missionId);
	assert.equal(unreadHeld.stopReason, "m04-review-pending");
	assert.deepEqual(unreadHeld.selectedArtifacts, []);
	assert.deepEqual((await unread.mission.status(unread.missionId)).selectedArtifacts, []);
	const skippedHostObservation = await finiteFixture(t, { m04SkipObservation: true });
	await assert.rejects(skippedHostObservation.mission.step(skippedHostObservation.missionId), error =>
		error instanceof Error && error.name === "AbortError");
	const skippedHeld = await skippedHostObservation.mission.status(skippedHostObservation.missionId);
	assert.equal(skippedHeld.stopReason, "m04-review-pending");
	assert.deepEqual((await skippedHostObservation.mission.status(skippedHostObservation.missionId)).selectedArtifacts, []);
	const unresolved = await finiteFixture(t);
	const first = await unresolved.mission.step(unresolved.missionId);
	const selection = JSON.parse(await readFile(path.join(unresolved.ws.agentDir,
		"missions", unresolved.missionId, "evidence",
		`selection-review-${first.boundedRuns[0]!.runId}.json`), "utf8")) as
		{ m04RunId: string };
	const txFile = path.join(unresolved.ws.runDir("M04", selection.m04RunId), "m04-transaction.json");
	const tx = JSON.parse(await readFile(txFile, "utf8")) as { state: string };
	tx.state = "merge-intent";
	await writeFile(txFile, `${JSON.stringify(tx, null, 2)}\n`);
	await assert.rejects(unresolved.mission.step(unresolved.missionId), /transaction|M04|m04/i);
	assertExactSelection(first.selectedArtifacts);
});

test("a new process recovers selected bytes, M04 evidence and review before finite closure", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-process-restart-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const child = spawnSync(process.execPath, [path.join(import.meta.dirname,
		"fixtures", "local-evaluator-first-process.ts"), root],
		{ cwd: path.join(import.meta.dirname, ".."), env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const { missionId } = JSON.parse(child.stdout.trim()) as { missionId: string };
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1, tools: {} };
	let calls = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		calls++;
		assert(spec.label.startsWith("local-original-objective-"));
		assert.equal(spec.tools.kind, "read-dir");
		if (spec.tools.kind !== "read-dir") throw new Error("restart assessor lacks frozen grant");
		const candidateName = selectedCandidate(await readdir(spec.tools.root));
		const issue = { id: "finite-gap", claim: "Exact answer has not been checked",
			status: "resolved", classification: "explicit-requirement",
			sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
			implication: "A checked candidate can settle this task",
			resolution: { explanation: "The selected exact result resolves the original requirement.",
			evidenceRefs: [{ sourceId: candidateName!, startLine: 1, endLine: 1 }] } };
		return { text: JSON.stringify({ version: 1, decision: "fulfilled",
			rationale: "Selected exact bytes settle this finite task.",
			evidenceRefs: [candidateName!], unresolvedObligations: [], unresolvedDetails: [],
			groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
				contractId: missionId, missionStatus: "open", issues: [issue],
				legacyOpenDetails: [] } }),
			readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const final = await mission.step(missionId);
	assert.equal(final.objectiveOutcome, "fulfilled");
	assert.equal(calls, 1);
	assertExactSelection(final.selectedArtifacts);
});

test("a completed checkpoint remains historical when current candidate, receipt or M04 bytes fail fresh-process checks", async t => {
	const good = await finiteFixture(t);
	await good.mission.step(good.missionId);
	assert.equal((await good.mission.step(good.missionId)).objectiveOutcome, "fulfilled");
	for (const action of ["status", "step", "run"] as const)
		assert.deepEqual(reopenedInNewProcess(good.root, good.missionId, action),
			{ valid: true, outcome: "fulfilled" });
	for (const variant of ["candidate", "snapshot", "receipt", "m04"] as const) {
		const f = await finiteFixture(t);
		await f.mission.step(f.missionId);
		const completed = await f.mission.step(f.missionId);
		assert.equal(completed.objectiveOutcome, "fulfilled");
		const runId = completed.boundedRuns[0]!.runId;
		const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", runId),
			"goal.json"), "utf8")) as { tasks: Array<{ reportPath: string; workDir: string }> };
		const selection = JSON.parse(await readFile(path.join(f.ws.agentDir, "missions", f.missionId,
			"evidence", `selection-review-${runId}.json`), "utf8")) as {
			m04RunId: string; selectedArtifacts: Array<{ name: string; file: string }> };
		if (variant === "candidate") await writeFile(goal.tasks[0]!.reportPath, "changed candidate\n");
		if (variant === "snapshot") {
			const selected = selection.selectedArtifacts.find(item => item.name.startsWith("candidate-"))!;
			await chmod(selected.file, 0o600);
			await writeFile(selected.file, "changed selected snapshot\n");
		}
		if (variant === "receipt") await writeFile(path.join(goal.tasks[0]!.workDir,
			"local-evaluator-receipt.json"), "altered receipt\n");
		if (variant === "m04") await writeFile(path.join(f.ws.runDir("M04", selection.m04RunId),
			"m07-coverage.json"), "altered M04 coverage\n");
		for (const action of ["status", "step", "run"] as const) {
			const result = reopenedInNewProcess(f.root, f.missionId, action);
			assert.equal(result.valid, false, `${variant}/${action}`);
			assert.match(result.message ?? "", /fulfilled checkpoint was recorded.*current evidence is invalid/i);
		}
		const recorded = await readFile(path.join(f.ws.agentDir, "missions", f.missionId,
			"evidence", `selection-review-${runId}.json`), "utf8");
		assert.match(recorded, /local-objective-selection-review/);
	}
});

test("equal-length changes to M04 checkpoint candidate or observation copies invalidate completion", async t => {
	for (const kind of ["candidate", "observation"] as const) {
		const f = await finiteFixture(t);
		await f.mission.step(f.missionId);
		const completed = await f.mission.step(f.missionId);
		assert.equal(completed.objectiveOutcome, "fulfilled");
		const runId = completed.boundedRuns[0]!.runId;
		const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", runId),
			"goal.json"), "utf8")) as { tasks: Array<{ workDir: string;
			review: { artifacts: Array<{ path: string; sourcePath?: string }> } }>;
			checkpoints: Array<{ goalSnapshotPath: string }> };
		const task = goal.tasks[0]!;
		const receipt = JSON.parse(await readFile(path.join(task.workDir,
			"local-evaluator-receipt.json"), "utf8")) as {
			candidate: Array<{ sourceFile: string; sha256: string }>;
			observations: Array<{ file: string; sha256: string }> };
		const source = kind === "candidate" ? receipt.candidate[0]!.sourceFile :
			receipt.observations[0]!.file;
		const expectedDigest = kind === "candidate" ? receipt.candidate[0]!.sha256 :
			receipt.observations[0]!.sha256;
		const index = task.review.artifacts.findIndex(item => item.sourcePath === source);
		assert(index >= 0);
		const snapshot = JSON.parse(await readFile(goal.checkpoints[0]!.goalSnapshotPath,
			"utf8")) as { tasks: Array<{ review: { artifacts: Array<{ path: string }> } }> };
		const checkpointCopy = snapshot.tasks[0]!.review.artifacts[index]!.path;
		const bytes = await readFile(checkpointCopy);
		const altered = Buffer.from(bytes);
		altered[0] = altered[0] === 65 ? 66 : 65;
		await writeFile(checkpointCopy, altered);
		assert.equal((await readFile(checkpointCopy)).length, bytes.length);
		assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), expectedDigest);
		const result = reopenedInNewProcess(f.root, f.missionId, "status");
		assert.equal(result.valid, false, kind);
		assert.match(result.message ?? "", /checkpoint candidate or observation|current evidence is invalid/i);
	}
});

test("completed host observations reject changed, missing, extra and forged members on fresh-process status", async t => {
	for (const variant of ["source", "snapshot", "missing", "extra", "forged-binding",
		"wrong-evaluator-id", "wrong-evaluator-version"] as const) {
		const f = await finiteFixture(t);
		await f.mission.step(f.missionId);
		const completed = await f.mission.step(f.missionId);
		assert.equal(completed.objectiveOutcome, "fulfilled");
		const runId = completed.boundedRuns[0]!.runId;
		const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", runId),
			"goal.json"), "utf8")) as { tasks: Array<{ workDir: string }> };
		const receiptFile = path.join(goal.tasks[0]!.workDir, "local-evaluator-receipt.json");
		const receipt = JSON.parse(await readFile(receiptFile, "utf8")) as {
			evaluator: { id: string; version: string };
			observations: Array<{ sourceFile: string; file: string; binding: { evaluatorId: string } }> };
		const observation = receipt.observations[0]!;
		if (variant === "source") await writeFile(observation.sourceFile, "changed host log\n");
		if (variant === "snapshot") {
			await chmod(observation.file, 0o600);
			await writeFile(observation.file, "changed frozen host log\n");
		}
		if (variant === "missing") await rm(observation.sourceFile);
		if (variant === "extra") await writeFile(path.join(path.dirname(observation.sourceFile),
			"observation-unlisted.txt"), "undeclared member\n");
		if (variant === "forged-binding") {
			observation.binding.evaluatorId = "forged:other";
			await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
		}
		if (variant === "wrong-evaluator-id" || variant === "wrong-evaluator-version") {
			if (variant === "wrong-evaluator-id") receipt.evaluator.id = "forged:other";
			else receipt.evaluator.version = "999";
			await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
		}
		const result = reopenedInNewProcess(f.root, f.missionId, "status");
		assert.equal(result.valid, false, variant);
		assert.match(result.message ?? "", /current evidence is invalid/i);
	}
});

test("real CLI start, run and resume load trusted preloader and select a host-created non-CSR observation", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-cli-preload-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Produce a synthetic byte-count candidate.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:byte-observation" }, concurrency: 1, tools: {} };
	await writeFile(ws.configFile, `${JSON.stringify(config, null, 2)}\n`);
	const baselineRunner = new FakeSessionRunner(() => "Offline initial M04 baseline; no proposal.");
	await runM04({ ws, runner: baselineRunner, store, config }, { feedback: { kind: "file",
		label: "Synthetic baseline", path: ws.problemFile }, freshSession: true });
	const requestFile = path.join(root, "original-request.json");
	await writeFile(requestFile, `${JSON.stringify({ version: 1,
		kind: "local-original-objective-request", goal: "Produce a synthetic byte-count candidate",
		goalSource: "verbatim-private-input", obligations: [{ id: "answer",
			description: "Produce a measured synthetic candidate", type: "test-byte-count" }],
		closure: "finite-evidence" }, null, 2)}\n`);
	const started = cliWithTrustedPreload(root, "start", requestFile);
	const missionId = started.missionId as string;
	assert.match(missionId, /^[0-9a-f-]{36}$/);
	const finished = cliWithTrustedPreload(root, "run", missionId);
	assert.equal(finished.objectiveOutcome, "fulfilled", JSON.stringify(finished));
	assert.equal(cliWithTrustedPreload(root, "resume", missionId).objectiveOutcome, "fulfilled");
	assert.equal(cliWithTrustedPreload(root, "status", missionId).objectiveOutcome, "fulfilled");
	const storedBytes = await LocalMissionHost.readLatestCheckpoint(path.join(ws.agentDir,
		"missions", missionId));
	assert(storedBytes);
	const stored = JSON.parse(storedBytes.toString("utf8")) as { boundedRuns: Array<{ runId: string }> };
	const runId = stored.boundedRuns[0]!.runId;
	const selection = JSON.parse(await readFile(path.join(ws.agentDir, "missions", missionId,
		"evidence", `selection-review-${runId}.json`), "utf8")) as {
		selectedArtifacts: Array<{ name: string; file: string }>;
		hostEvidence: { requiredM07ReadPaths: string[]; m04CoverageSha256: string } };
	const observation = selection.selectedArtifacts.find(item => item.name.startsWith("observation-byte-count-"));
	assert(observation);
	const log = JSON.parse(await readFile(observation.file, "utf8")) as { kind: string;
		observed: Array<{ bytes: number }> };
	assert.equal(log.kind, "synthetic-byte-count-observation");
	assert(log.observed[0]!.bytes > 0);
	assert(selection.hostEvidence.requiredM07ReadPaths.some(item =>
		item.includes("observation-byte-count.json")));
	await chmod(observation.file, 0o600);
	await writeFile(observation.file, "changed selected host observation\n");
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const repo = path.join(import.meta.dirname, "..");
	const invalidStatus = spawnSync(process.execPath, ["--import", path.join(import.meta.dirname,
		"fixtures", "trusted-cli-evaluator-preload.ts"), path.join(repo, "src", "cli.ts"),
		"mission", "status", "--workspace", root, "--mission", missionId],
		{ cwd: repo, env, encoding: "utf8" });
	assert.notEqual(invalidStatus.status, 0);
	assert.match(invalidStatus.stderr, /fulfilled checkpoint was recorded.*current evidence is invalid/i);
});

test("fresh CLI resumes dispatch one settled M07/M04 at a time and hold on unknown effects", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-cli-steps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Produce two distinct synthetic candidates.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:byte-observation" }, concurrency: 1, tools: {} };
	await writeFile(ws.configFile, `${JSON.stringify(config, null, 2)}\n`);
	await runM04({ ws, runner: new FakeSessionRunner(() => "Offline baseline; no proposal."),
		store, config }, { feedback: { kind: "file", label: "Synthetic baseline",
			path: ws.problemFile }, freshSession: true });
	const requestFile = path.join(root, "original-request.json");
	await writeFile(requestFile, `${JSON.stringify({ version: 1,
		kind: "local-original-objective-request", goal: "Produce two distinct synthetic candidates",
		goalSource: "verbatim-private-input", obligations: [{ id: "answer",
			description: "Produce measured synthetic candidates", type: "test-byte-count" }],
		closure: "open-ended" }, null, 2)}\n`);
	const missionId = cliWithTrustedPreload(root, "start", requestFile, true).missionId as string;
	const baselineM04 = (await ws.listRuns("M04")).length;
	const first = cliWithTrustedPreload(root, "resume", missionId, true);
	const firstCheckpoint = await readMissionCheckpoint(root, missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assert.equal(firstCheckpoint.boundedRuns.length, 1);
	assert.equal((await ws.listRuns("M07")).length, 1);
	assert.equal((await ws.listRuns("M04")).length, baselineM04 + 1);
	assert.equal((await ws.listRuns("MISSION")).length, 1);
	const firstRunId = firstCheckpoint.boundedRuns[0]!.runId;
	const firstGoalFile = path.join(ws.runDir("M07", firstRunId), "goal.json");
	const firstGoalBytes = await readFile(firstGoalFile);
	const firstGoal = JSON.parse(firstGoalBytes.toString("utf8")) as {
		lifecycle: string; tasks: Array<{ objective: string; status: string }> };
	assert.equal(firstGoal.lifecycle, "finished");
	assert.equal(firstGoal.tasks[0]!.status, "accepted");

	const second = cliWithTrustedPreload(root, "resume", missionId, true);
	const secondCheckpoint = await readMissionCheckpoint(root, missionId);
	assert.equal(second.objectiveOutcome, "incomplete");
	assert.equal(secondCheckpoint.boundedRuns.length, 2);
	assert.equal(secondCheckpoint.boundedRuns[0]!.runId, firstRunId);
	assert.equal((await ws.listRuns("M07")).length, 2);
	assert.equal((await ws.listRuns("M04")).length, baselineM04 + 2);
	assert.equal((await ws.listRuns("MISSION")).length, 2);
	assert.deepEqual(await readFile(firstGoalFile), firstGoalBytes, "fresh owner did not replay first task");
	const secondRunId = secondCheckpoint.boundedRuns[1]!.runId;
	assert.notEqual(secondRunId, firstRunId);
	const secondGoal = JSON.parse(await readFile(path.join(ws.runDir("M07", secondRunId),
		"goal.json"), "utf8")) as { lifecycle: string;
			tasks: Array<{ objective: string; status: string }> };
	assert.equal(secondGoal.lifecycle, "finished");
	assert.equal(secondGoal.tasks[0]!.status, "accepted");
	assert.notEqual(secondGoal.tasks[0]!.objective, firstGoal.tasks[0]!.objective);
	for (const runId of await ws.listRuns("M04"))
		assert.equal((await ws.readRun("M04", runId)).status, "completed");

	const repo = path.join(import.meta.dirname, "..");
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const injected = spawnSync(process.execPath, [path.join(import.meta.dirname, "fixtures",
		"local-mission-record-unknown.ts"), root, missionId],
		{ cwd: repo, env, encoding: "utf8", timeout: 30_000 });
	assert.equal(injected.status, 0, injected.stderr);
	const held = cliWithTrustedPreload(root, "resume", missionId, true, 1);
	const heldCheckpoint = await readMissionCheckpoint(root, missionId);
	assert.equal(held.stopReason, "execution-interrupted");
	assert(heldCheckpoint.continuation.unresolvedOperationIds.includes("synthetic-unsettled-effect"));
	assert.equal(heldCheckpoint.assessmentHistory.length, secondCheckpoint.assessmentHistory.length);
	assert.equal(heldCheckpoint.boundedRuns.length, 2);
	assert.equal((await ws.listRuns("MISSION")).length, 2, "unknown effect blocked assessor");
	assert.equal((await ws.listRuns("M07")).length, 2, "unknown effect blocked dispatch");
	assert.equal((await ws.listRuns("M04")).length, baselineM04 + 2);
});
