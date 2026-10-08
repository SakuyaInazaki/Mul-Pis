import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createLocalOriginalObjectiveCaller, publicLocalMissionStatus,
	validateLocalObjectiveRequest, type LocalObjectiveHostPort,
	type LocalObjectiveAdapter, type LocalObjectiveSelectionReviewV1 } from
	"../src/m07/local-original-objective.ts";
import type { ObjectiveProgressV1, OriginalObjectiveContractV1 } from "../src/m07/objective-progress.ts";
import type { LocalMaterialSelection } from "../src/m07/local-material-bundle.ts";
import { freezeLocalMaterialBundle } from "../src/m07/local-material-bundle.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { Workspace } from "../src/workspace.ts";

const request = { version: 1, kind: "local-original-objective-request",
	goal: "Original private synthetic mission", goalSource: "verbatim-private-input",
	obligations: [{ id: "work", description: "Check the complete synthetic original goal" }],
	closure: "open-ended" } as const;

function lineCount(value: string): number {
	return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-local-objective-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Frozen synthetic original task\n");
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(path.join(ws.rawDir, "original.cpp"), "// original synthetic source\n");
	const states = new Map<string, { contract?: OriginalObjectiveContractV1;
		contractFile?: string; progress?: ObjectiveProgressV1; writes: number;
		feedback?: { runId: string; file: string }; failFinal?: boolean;
		externalUnknown?: string[]; unrepresented?: string[]; suppressFeedback?: boolean;
		selectedFile?: string; review?: LocalObjectiveSelectionReviewV1;
		selectedMaterials?: readonly LocalMaterialSelection[];
		selectionPolicy?: NonNullable<LocalObjectiveHostPort["reviewSelection"]> }>();
	const hostFor = (missionId: string): LocalObjectiveHostPort => {
		let state = states.get(missionId);
		if (!state) { state = { writes: 0 }; states.set(missionId, state); }
		const current = state;
		return {
			async createContract(contract, request) {
				assert.equal(contract.id, missionId);
				const dir = path.join(root, "missions", missionId);
				await mkdir(dir, { recursive: true });
				const file = path.join(dir, "original-objective.json");
				await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`);
				current.contract = contract; current.contractFile = file;
				current.selectedMaterials = request.materials;
				const bundle = request.materials ? await freezeLocalMaterialBundle({
					root: path.join(dir, "materials"), baseDir: root,
					selections: request.materials }) : undefined;
				return { contractFile: file,
					...(bundle ? { materialBundleRoot: path.dirname(bundle.manifestFile) } : {}) };
			},
			async readCheckpoint() { return current.progress; },
			async recordCheckpoint(progress) {
				current.writes++;
				if (current.failFinal && current.writes === 4) throw new Error("synthetic final checkpoint write failed");
				current.progress = structuredClone(progress);
			},
			async currentUnknownOperationIds() {
				return [...(current.externalUnknown ?? current.progress?.continuation.unresolvedOperationIds ?? [])];
			},
			async currentUnrepresentedM07RunIds() { return [...(current.unrepresented ?? [])]; },
			async reviewSelection(input) {
				const review = await current.selectionPolicy?.(input);
				if (review) current.review = review;
				return review;
			},
			async freeze({ progress, iteration }) {
				assert.equal(progress.contract.id, missionId);
				const evidence = [{ name: "original-problem.txt", file: ws.problemFile },
					{ name: "original-input-1.txt", file: path.join(ws.rawDir, "original.cpp") }];
				const boundedRunEvidence: Record<string, string[]> = {};
				if (current.feedback && !current.suppressFeedback) {
					evidence.push({ name: "prior-bounded-feedback.txt", file: current.feedback.file });
					boundedRunEvidence[current.feedback.runId] = ["prior-bounded-feedback.txt"];
				}
				if (current.selectedFile && progress.selectedArtifacts.includes("selected-result.txt"))
					evidence.push({ name: "selected-result.txt", file: current.selectedFile });
				return { contractFile: current.contractFile!, evidence,
					evidenceRoot: path.join(root, "missions", missionId, `assessment-${iteration}`),
					capabilities: [{ scope: "local-m07-reason", available: true,
						description: "Synthetic local reason task", limits: [] }],
					selectedArtifacts: [...progress.selectedArtifacts], boundedRunEvidence,
					selectionReview: current.review,
					unresolvedOperationIds: [...progress.continuation.unresolvedOperationIds] };
			},
		};
	};
	return { root, ws, states, hostFor };
}

function fakeAssessor() {
	let calls = 0;
	return { runner: new FakeSessionRunner(async ({ spec }) => {
		calls++;
		const grant = spec.tools;
		assert.equal(grant.kind, "read-dir");
		if (grant.kind !== "read-dir") throw new Error("unexpected fake tool grant");
		const files = await readdir(grant.root);
		const readReturns: ReadReturnEvent[] = await Promise.all(files.map(async name => {
			const body = await readFile(path.join(grant.root, name), "utf8");
			return { toolName: "objective_evidence_read", status: "returned" as const,
				path: name, requested: {}, returned: { kind: "text" as const,
					startLine: 1, endLine: lineCount(body), truncated: false },
				at: new Date().toISOString() };
		}));
		return { text: JSON.stringify(calls === 1 ? { version: 1, decision: "continue",
			rationale: "A bounded synthetic check can change the result.",
			evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["work"],
			unresolvedDetails: ["One synthetic check remains"],
			nextTask: { objective: "Run one synthetic local reason task", addresses: ["work"],
				adapterScope: "local-m07-reason" } } : { version: 1, decision: "fulfilled",
			rationale: "The synthetic bounded task was observed; closure still needs host checks.",
			evidenceRefs: ["original-problem.txt"], unresolvedObligations: [], unresolvedDetails: [] }),
			readReturns };
	}), calls: () => calls };
}

test("local caller validates authored request and exposes only safe status", async t => {
	const f = await fixture(t);
	assert.throws(() => validateLocalObjectiveRequest({ ...request, inventedRule: "skip checks" }),
		/local original objective request is invalid/);
	const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor });
	const initial = await caller.begin(request);
	assert.equal(initial.contract.inputNames.length, 2);
	assert.equal(initial.boundedRuns.length, 0);
	assert.equal((await caller.status(initial.contract.id)).contract.id, initial.contract.id);
	const status = publicLocalMissionStatus(initial);
	assert.equal(status.missionId, initial.contract.id);
	assert.ok(!JSON.stringify(status).includes(request.goal));
	await assert.rejects(caller.step(initial.contract.id), /configured runner/);
});

test("declared material names, not incidental raw files, bind the original contract", async t => {
	const f = await fixture(t);
	await writeFile(path.join(f.ws.rawDir, "incidental.txt"), "Unselected incidental text\n");
	await writeFile(path.join(f.ws.rawDir, "incidental.png"), Buffer.from([0, 1, 2, 3]));
	const materials: LocalMaterialSelection[] = [
		{ kind: "declared-file", label: "chosen-source", path: "problem/raw/original.cpp",
			role: "original" }];
	assert.equal(validateLocalObjectiveRequest({ ...request, materials: [
		...materials,
		{ kind: "registered-source", workspaceRoot: "other-workspace", sourceId: "S001" },
		{ kind: "m08-manifest", label: "frozen-evaluation", manifestFile: "evidence/manifest.json" }
	] }).materials?.length, 3);
	assert.throws(() => validateLocalObjectiveRequest({ ...request,
		materials: [{ kind: "declared-file", label: "chosen", path: "x", unknown: true }] }),
		/local original objective request is invalid/);
	const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor });
	const initial = await caller.begin({ ...request, materials });
	assert.deepEqual(initial.contract.inputNames, ["chosen-source"]);
	assert.deepEqual(f.states.get(initial.contract.id)?.selectedMaterials, materials);
	assert.equal((await caller.status(initial.contract.id)).objectiveOutcome, "incomplete");
	const ignored = await fixture(t);
	const unsafeCaller = createLocalOriginalObjectiveCaller({ ws: ignored.ws,
		hostFor: id => {
			const host = ignored.hostFor(id);
			return { ...host, createContract: contract => host.createContract(contract, {}) };
		} });
	await assert.rejects(unsafeCaller.begin({ ...request, materials }),
		/host did not freeze the declared material bundle/);
});

test("model-free local begin, assess, advance and restart retain original authority and feedback", async t => {
	const f = await fixture(t);
	const model = fakeAssessor();
	let advances = 0;
	const adapter: LocalObjectiveAdapter = { scope: "local-m07-reason", async advance({ contract, task }) {
		advances++;
		assert.equal(contract.goal, request.goal);
		assert.equal(task.adapterScope, "local-m07-reason");
		const runId = "synthetic-reviewed-run";
		const file = path.join(f.root, "feedback.txt");
		await writeFile(file, "Bounded synthetic attempt remains unselected\n");
		f.states.get(contract.id)!.feedback = { runId, file };
		return { runId, outcome: "partial", acceptedTaskIds: [] };
	} };
	const ctx = { ws: f.ws, runner: model.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir),
		config: { roles: { research: "fake/research" }, concurrency: 1, tools: {} } };
	const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor,
		ctx, adapters: [adapter] });
	const initial = await caller.begin(request);
	const finished = await caller.run(initial.contract.id);
	assert.equal(advances, 1);
	assert.equal(model.calls(), 2);
	assert.equal(finished.boundedRuns.length, 1);
	assert.deepEqual(finished.selectedArtifacts, []);
	assert.equal(finished.contract.id, initial.contract.id);
	assert.equal(finished.objectiveOutcome, "incomplete");
	const restarted = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor });
	assert.deepEqual(await restarted.status(initial.contract.id), finished);
});

test("completed adapter work with failed final checkpoint stays held against replay", async t => {
	const f = await fixture(t);
	const model = fakeAssessor();
	let advances = 0;
	const adapter: LocalObjectiveAdapter = { scope: "local-m07-reason", async advance() {
		advances++;
		return { runId: "bounded-run-before-crash", outcome: "partial", acceptedTaskIds: [] };
	} };
	const ctx = { ws: f.ws, runner: model.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir),
		config: { roles: { research: "fake/research" }, concurrency: 1, tools: {} } };
	const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor,
		ctx, adapters: [adapter] });
	const initial = await caller.begin(request);
	f.states.get(initial.contract.id)!.failFinal = true;
	await assert.rejects(caller.step(initial.contract.id), /synthetic final checkpoint write failed/);
	const saved = await caller.status(initial.contract.id);
	assert.equal(saved.stopReason, "execution-interrupted");
	assert.equal(saved.continuation.pendingAction?.safety, "no-replay-until-reconciled");
	assert.equal(advances, 1);
	const held = await caller.step(initial.contract.id);
	assert.equal(held.stopReason, "execution-interrupted");
	assert.equal(advances, 1, "unreconciled completed work is never dispatched again");
});

test("unknown task outcome retains exact operation refs and stops further work", async t => {
	const f = await fixture(t);
	const model = fakeAssessor();
	let advances = 0;
	const refs = Array.from({ length: 5 }, (_, i) => `R1/O00${i + 1}`);
	const adapter: LocalObjectiveAdapter = { scope: "local-m07-reason", async advance() {
		advances++;
		return { runId: "R1", outcome: "unknown", acceptedTaskIds: [],
			unresolvedOperationRefs: refs };
	} };
	const ctx = { ws: f.ws, runner: model.runner,
		store: createFileKnowledgeStore(f.ws.knowledgeDir),
		config: { roles: { research: "fake/research" }, concurrency: 1, tools: {} } };
	const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor,
		ctx, adapters: [adapter] });
	const initial = await caller.begin(request);
	const held = await caller.run(initial.contract.id);
	assert.equal(held.stopReason, "execution-interrupted");
	assert.deepEqual(held.continuation.unresolvedOperationIds, refs);
	assert.equal(held.continuation.pendingAction?.safety, "no-replay-until-reconciled");
	assert.equal(model.calls(), 1);
	assert.equal(advances, 1);
	assert.equal((await caller.step(initial.contract.id)).stopReason, "execution-interrupted");
	assert.equal(advances, 1);
});

test("fresh host census after assessment blocks a newly unknown or unrepresented task", async t => {
	for (const kind of ["externalUnknown", "unrepresented"] as const) {
		const f = await fixture(t);
		let missionId = "";
		let prompts = 0, advances = 0;
		const runner = new FakeSessionRunner(async ({ spec }) => {
			prompts++;
			f.states.get(missionId)![kind] = ["new-local-effect"];
			const grant = spec.tools;
			assert.equal(grant.kind, "read-dir");
			if (grant.kind !== "read-dir") throw new Error("unexpected fake grant");
			const reads: ReadReturnEvent[] = await Promise.all((await readdir(grant.root))
				.map(async name => ({ toolName: "objective_evidence_read", status: "returned" as const,
					path: name, requested: {}, returned: { kind: "text" as const, startLine: 1,
						endLine: lineCount(await readFile(path.join(grant.root, name), "utf8")),
						truncated: false }, at: new Date().toISOString() })));
			return { text: JSON.stringify({ version: 1, decision: "continue", rationale: "A bounded check remains.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["work"],
				unresolvedDetails: ["A check remains"], nextTask: { objective: "Run a check",
					addresses: ["work"], adapterScope: "local-m07-reason" } }), readReturns: reads };
		});
		const adapter: LocalObjectiveAdapter = { scope: "local-m07-reason", async advance() {
			advances++;
			return { runId: "should-not-run", outcome: "partial", acceptedTaskIds: [] };
		} };
		const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor,
			ctx: { ws: f.ws, runner, store: createFileKnowledgeStore(f.ws.knowledgeDir),
				config: { roles: { research: "fake/research" }, concurrency: 1, tools: {} } },
			adapters: [adapter] });
		const initial = await caller.begin(request);
		missionId = initial.contract.id;
		const held = await caller.step(missionId);
		assert.equal(held.stopReason, "execution-interrupted");
		assert.deepEqual(held.continuation.unresolvedOperationIds, ["new-local-effect"]);
		assert.equal(advances, 0);
		assert.equal(prompts, 1);
	}
});

test("missing prior bounded feedback prevents a new paid assessment", async t => {
	const f = await fixture(t);
	const model = fakeAssessor();
	const adapter: LocalObjectiveAdapter = { scope: "local-m07-reason", async advance({ contract }) {
		const runId = "feedback-required-run";
		const file = path.join(f.root, "prior-feedback.txt");
		await writeFile(file, "A bounded unselected attempt was reviewed\n");
		f.states.get(contract.id)!.feedback = { runId, file };
		return { runId, outcome: "partial", acceptedTaskIds: [] };
	} };
	const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor,
		ctx: { ws: f.ws, runner: model.runner, store: createFileKnowledgeStore(f.ws.knowledgeDir),
			config: { roles: { research: "fake/research" }, concurrency: 1, tools: {} } },
		adapters: [adapter] });
	const initial = await caller.begin(request);
	assert.equal((await caller.step(initial.contract.id)).boundedRuns.length, 1);
	f.states.get(initial.contract.id)!.suppressFeedback = true;
	await assert.rejects(caller.step(initial.contract.id), /prior bounded-run feedback/);
	assert.equal(model.calls(), 1);
});

test("finite closure needs pinned host-reviewed M07/M04 selection and original checks", async t => {
	for (const scenario of [
		{ closure: "finite-evidence" as const, candidate: "correct", expected: "fulfilled" },
		{ closure: "finite-evidence" as const, candidate: "incorrect", expected: "incomplete" },
		{ closure: "open-ended" as const, candidate: "correct", expected: "incomplete" },
		{ closure: "finite-evidence" as const, candidate: "correct", expected: "held", badDigest: true },
		{ closure: "finite-evidence" as const, candidate: "correct", expected: "held", dropReview: true },
		{ closure: "finite-evidence" as const, candidate: "correct", expected: "held", corruptPersisted: true },
	]) {
		const f = await fixture(t);
		let calls = 0;
		const runner = new FakeSessionRunner(async ({ spec }) => {
			calls++;
			const grant = spec.tools;
			if (grant.kind !== "read-dir") throw new Error("unexpected fake grant");
			const readReturns: ReadReturnEvent[] = await Promise.all((await readdir(grant.root))
				.map(async name => ({ toolName: "objective_evidence_read", status: "returned" as const,
					path: name, requested: {}, returned: { kind: "text" as const, startLine: 1,
						endLine: lineCount(await readFile(path.join(grant.root, name), "utf8")),
						truncated: false }, at: new Date().toISOString() })));
			return { text: JSON.stringify(calls === 1 ? { version: 1, decision: "continue",
				rationale: "A fresh bounded result could answer the original check.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["work"],
				unresolvedDetails: ["The original check remains open"],
				nextTask: { objective: "Check synthetic candidate", addresses: ["work"],
					adapterScope: "local-m07-reason" } } : {
					version: 1, decision: "fulfilled", rationale: "Bounded evidence is ready for host closure review.",
					evidenceRefs: scenario.candidate === "correct" ? ["selected-result.txt"] :
						["original-problem.txt"], unresolvedObligations: [], unresolvedDetails: [] }),
				readReturns };
		});
		const adapter: LocalObjectiveAdapter = { scope: "local-m07-reason", async advance({ contract }) {
			const state = f.states.get(contract.id)!;
			const feedback = path.join(f.root, "reviewed-feedback.txt");
			await writeFile(feedback, "M07/M04 synthetic review evidence\n");
			state.feedback = { runId: "R1", file: feedback };
			const file = path.join(f.root, "candidate-result.txt");
			await writeFile(file, `${scenario.candidate}\n`);
			state.selectedFile = file;
			return { runId: "R1", outcome: "fulfilled", acceptedTaskIds: ["T1"],
				selectedTaskId: "T1", m04RunId: "M1" };
		} };
		const caller = createLocalOriginalObjectiveCaller({ ws: f.ws, hostFor: f.hostFor,
			ctx: { ws: f.ws, runner, store: createFileKnowledgeStore(f.ws.knowledgeDir),
				config: { roles: { research: "fake/research" }, concurrency: 1, tools: {} } },
			adapters: [adapter] });
		const initial = await caller.begin({ ...request, closure: scenario.closure });
		const state = f.states.get(initial.contract.id)!;
		state.selectionPolicy = async ({ run }) => {
			const bytes = await readFile(state.selectedFile!);
			if (bytes.toString("utf8") !== "correct\n") return undefined;
			return { version: 1, kind: "local-objective-selection-review",
				runId: run.runId, taskId: run.selectedTaskId!, m04RunId: run.m04RunId!,
				selectedArtifacts: [{ name: "selected-result.txt",
					file: state.selectedFile!,
					sha256: "badDigest" in scenario && scenario.badDigest ? "0".repeat(64) :
						createHash("sha256").update(bytes).digest("hex") }],
				originalChecks: [{ obligationId: "work", passed: true,
					evidenceRefs: ["selected-result.txt"] }] };
		};
		if ("badDigest" in scenario && scenario.badDigest) {
			await assert.rejects(caller.run(initial.contract.id), /differs from pinned review bytes/);
			const held = await caller.status(initial.contract.id);
			assert.equal(held.stopReason, "execution-interrupted");
			assert.deepEqual(held.selectedArtifacts, []);
			assert.equal(calls, 1);
			continue;
		}
		if ("dropReview" in scenario && scenario.dropReview) {
			const first = await caller.step(initial.contract.id);
			assert.deepEqual(first.selectedArtifacts, ["selected-result.txt"]);
			state.review = undefined;
			const before = await f.ws.listRuns("MISSION");
			await assert.rejects(caller.step(initial.contract.id), /lacks its host review receipt/);
			assert.deepEqual(await f.ws.listRuns("MISSION"), before,
				"invalid prior review cannot create a new running assessor record");
			assert.equal(calls, 1, "lost review authority blocks before a second model turn");
			continue;
		}
		if ("corruptPersisted" in scenario && scenario.corruptPersisted) {
			const first = await caller.step(initial.contract.id);
			assert.deepEqual(first.selectedArtifacts, ["selected-result.txt"]);
			await writeFile(state.selectedFile!, "changed after host review\n");
			const before = await f.ws.listRuns("MISSION");
			await assert.rejects(caller.step(initial.contract.id), /differs from pinned review bytes/);
			assert.deepEqual(await f.ws.listRuns("MISSION"), before);
			assert.equal(calls, 1);
			continue;
		}
		const outcome = await caller.run(initial.contract.id);
		assert.equal(calls, 2);
		assert.equal(outcome.objectiveOutcome, scenario.expected);
		assert.deepEqual(outcome.selectedArtifacts,
			scenario.candidate === "correct" ? ["selected-result.txt"] : []);
		assert.equal(outcome.contract.closure, scenario.closure);
	}
});
