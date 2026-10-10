import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { objectiveProgress, type ObjectiveProgressV1 } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import { probeProcessIdentity } from "../src/runtime/process-identity.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

const evaluatorId = "test:durable-return-recovery";
const throwingEvaluatorId = "test:durable-throw-recovery";
const liveEvaluatorId = "test:durable-throw-live-child";
const orphanEvaluatorId = "test:pre-entry-orphan-recovery";
const candidateText = "Synthetic returned candidate with fixed bytes.\n";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const lineCount = (value: string) => value.split(/\r?\n/).length - Number(value.endsWith("\n"));

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const value = await readFile(file, "utf8");
			if (value) events.push({ toolName, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1, endLine: lineCount(value),
					truncated: false }, at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

function registerEvaluator(log: string, obstructReceipt: boolean, id = evaluatorId): void {
	registerTrustedLocalMissionEvaluator({ id, version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate, observationOutputDir }) {
			await appendFile(log, "evaluator\n");
			const emptySchemaErrors = await readFile(path.join(path.dirname(log), "empty-schema-errors"))
				.then(() => true, error => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					return false;
				});
			const observation = "observation-recovery.json";
			await writeFile(path.join(observationOutputDir, observation),
				`${JSON.stringify({ kind: "synthetic-recovery-observation", candidateBytes: candidate[0]?.bytes })}\n`,
				{ flag: "wx", mode: 0o600 });
			if (obstructReceipt) {
				// The evaluator has returned, but host receipt finalization fails. This
				// deterministically creates the after-return crash window in another process.
				await mkdir(path.join(path.dirname(observationOutputDir), "work",
					"local-evaluator-receipt.json"));
			}
			return { observations: [{ name: observation, kind: "json" as const }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "passed" as const,
					evidenceRefs: [candidate[0]!.name, observation], limitations: [],
					...(emptySchemaErrors ? { schemaErrors: [] } : {}) })),
				limitations: ["Offline synthetic recovery test"] };
		} });
}

function registerThrowingEvaluator(root: string, reconcile: boolean, liveChildMs = 0,
	id = throwingEvaluatorId): void {
	const log = path.join(root, "calls.log");
	registerTrustedLocalMissionEvaluator({ id, version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ observationOutputDir }) {
			await appendFile(log, "evaluator\n");
			await writeFile(path.join(observationOutputDir, "observation-partial.txt"),
				"Synthetic private partial observation.\n", { flag: "wx", mode: 0o600 });
			const identityModule = pathToFileURL(path.join(import.meta.dirname, "..", "src",
				"runtime", "process-identity.ts")).href;
			if (liveChildMs > 0) {
				const code = `import { readCurrentProcessIdentity } from ${JSON.stringify(identityModule)}; import { writeFile, access } from 'node:fs/promises'; await writeFile(${JSON.stringify(path.join(root, "owned-child.json"))}, JSON.stringify(await readCurrentProcessIdentity())); for(let i=0;i<${Math.ceil(liveChildMs / 25)};i++){try{await access(${JSON.stringify(path.join(root, "release-child"))});break}catch{} await new Promise(resolve=>setTimeout(resolve,25));}`;
				const child = spawn(process.execPath, ["--input-type=module", "-e", code],
					{ detached: true, stdio: "ignore" });
				child.unref();
				let observed = false;
				for (let index = 0; index < 100; index++) {
					try { observed = Boolean(await readFile(path.join(root, "owned-child.json"))); }
					catch { await delay(20); }
					if (observed) break;
				}
				assert(observed, "owned evaluator child did not publish its process identity");
			} else {
				const child = spawnSync(process.execPath, ["--input-type=module", "-e",
					`import { readCurrentProcessIdentity } from ${JSON.stringify(identityModule)}; process.stdout.write(JSON.stringify(await readCurrentProcessIdentity()));`],
					{ encoding: "utf8", timeout: 10_000 });
				assert.equal(child.status, 0, child.stderr);
				await writeFile(path.join(root, "owned-child.json"), child.stdout);
			}
			throw new Error("synthetic opaque evaluator throw after a private partial output");
		},
		async reconcileEvaluation(attempt) {
			if (!reconcile) return { state: "pending" } as const;
			try {
				await readFile(path.join(root, "pause-reconcile"));
				await writeFile(path.join(root, "reconcile-entered"), "entered\n");
				let released = false;
				for (let index = 0; index < 400; index++) {
					try { released = Boolean(await readFile(path.join(root, "release-reconcile"))); }
					catch { await delay(10); }
					if (released) break;
				}
				assert(released, "synthetic reconciliation barrier was never released");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const child = JSON.parse(await readFile(path.join(root, "owned-child.json"), "utf8")) as
				{ hostId: string; bootId: string; pid: number; processStartToken: string };
			return { state: "settled-failure" as const, proof: {
				attemptId: attempt.attemptId, process: attempt.process,
				operationId: attempt.attemptId, childProcesses: [child],
				settledEffect: "contained" as const,
				evidence: "The synthetic owned subprocess exited and only the partial local output remains." } };
		} });
}

function createRunner(log: string, assessment: "first" | "second" | "invalid") {
	let invalidAssessmentCount = 0;
	return new FakeSessionRunner(async ({ spec }) => {
		if (spec.label === "M04-research") {
			if (spec.tools.kind === "read-dir") {
				const root = path.dirname(log);
				try {
					await readFile(path.join(root, "m04-pause"));
					await writeFile(path.join(root, "m04-entered"), String(process.pid));
					let released = false;
					for (let index = 0; index < 1000; index++) {
						try { released = Boolean(await readFile(path.join(root, "m04-release"))); }
						catch { await delay(10); }
						if (released) break;
					}
					assert(released, "synthetic M04 barrier was never released");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			await appendFile(log, "m04\n");
			return { text: "Synthetic M04 considered the frozen checkpoint; no proposal.",
				readReturns: spec.tools.kind === "read-dir" ?
					await readEvents(spec.tools.root, "m07_evidence_read") : [] };
		}
		if (spec.label.startsWith("M07-")) {
			await appendFile(log, "builder\n");
			if (spec.tools.kind !== "execution" && spec.tools.kind !== "read-dir")
				throw new Error("synthetic M07 builder lacks a task root");
			try {
				await readFile(path.join(path.dirname(log), "empty-auxiliary-case"));
				const deliverable = path.join(spec.tools.root, "deliverable");
				await mkdir(deliverable);
				await writeFile(path.join(deliverable, "answer.txt"), candidateText);
				await writeFile(path.join(deliverable, "compile.log"), "");
				await chmod(path.join(deliverable, "compile.log"), 0o600);
				const observationRoot = path.join(path.dirname(spec.tools.root), "host-evaluator-output");
				await mkdir(observationRoot, { mode: 0o700 });
				await writeFile(path.join(observationRoot, "unclaimed.txt"), "block pre-entry\n");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				await readFile(path.join(path.dirname(log), "pre-entry-orphan"));
				const taskRoot = path.dirname(spec.tools.root);
				for (const part of ["host-evaluator-output", "host-evaluator-snapshot"])
					await mkdir(path.join(taskRoot, part), { mode: 0o700 });
				const journal = path.join(taskRoot, "host-evaluator-attempt");
				await mkdir(journal, { mode: 0o700 });
				await writeFile(path.join(journal, "prepared.json.pending"),
					"{\"synthetic\":", { flag: "wx", mode: 0o400 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return candidateText;
		}
		if (spec.label.startsWith("local-original-objective-")) {
			await appendFile(log, "assessor\n");
			if (assessment === "invalid") {
				invalidAssessmentCount++;
				if (invalidAssessmentCount > 4)
					throw new DOMException("Synthetic assessor abort after repeated invalid replies", "AbortError");
				return "Deliberately invalid fresh assessment";
			}
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor input is unavailable");
			const contract = JSON.parse(await readFile(path.join(spec.tools.root,
				"original-objective.json"), "utf8")) as { id: string };
			const ref = { sourceId: "original-problem.txt", startLine: 1, endLine: 1 };
			const issue = { id: "synthetic-gap", claim: "A fixed candidate requires a host check",
				status: "open", classification: "explicit-requirement", sourceRefs: [ref],
				implication: "The evaluator can measure the candidate" };
			const second = { id: "second-gap", claim: "A distinct candidate requires a new host check",
				status: "open", classification: "explicit-requirement", sourceRefs: [ref],
				implication: "The follow-up candidate can be measured separately" };
			if (assessment === "second") {
				const feedbackName = (await readdir(spec.tools.root)).find(name =>
					/^prior-run-1-feedback-[1-9][0-9]*\.txt$/.test(name));
				assert(feedbackName, "the negative M07 feedback was not frozen for reassessment");
				const feedbackRef = { sourceId: feedbackName, startLine: 1, endLine: 1 };
				return { text: JSON.stringify({ version: 1,
				decision: "continue", rationale: "The first candidate failed; test a distinct candidate.",
				evidenceRefs: ["original-problem.txt", feedbackName], unresolvedObligations: ["answer"],
				unresolvedDetails: [issue.claim, second.claim], groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: contract.id,
					missionStatus: "open", issues: [issue, { ...second,
						sourceRefs: [ref, feedbackRef] }], legacyOpenDetails: [issue.claim],
					nextTask: { objective: "Produce a distinct second synthetic candidate",
						obligationIds: ["answer"], addresses: [second.id],
						adapterScope: "local-m07-execute",
						decisionChangingHypothesis: "A distinct candidate can change the result",
						expectedEvidence: "A new host observation", sourceRefs: [ref, feedbackRef] } } }),
				readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
			}
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "The synthetic candidate still needs measurement.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [issue.claim], groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: contract.id,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Produce the fixed synthetic candidate",
						obligationIds: ["answer"], addresses: [issue.id],
						adapterScope: "local-m07-execute",
						decisionChangingHypothesis: "Exact bytes can settle the check",
						expectedEvidence: "A host digest observation", sourceRefs: [ref] } } }),
				readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
}

async function childStart(root: string): Promise<void> {
	const ws = new Workspace(root);
	const log = path.join(root, "calls.log");
	const config = await ws.loadConfig();
	if (config.localMission?.evaluatorId === throwingEvaluatorId ||
		config.localMission?.evaluatorId === liveEvaluatorId)
		registerThrowingEvaluator(root, false, Number(process.env.MULPIS_LIVE_CHILD_MS ?? 0),
			config.localMission.evaluatorId);
	else registerEvaluator(log, config.localMission?.evaluatorId !== orphanEvaluatorId,
		config.localMission?.evaluatorId ?? evaluatorId);
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: createRunner(log, "first"), config });
	const initial = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Produce and check a fixed synthetic candidate", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Produce exact synthetic bytes",
			type: "file-sha256", expectedSha256: hash(Buffer.from(candidateText)) }],
		closure: "open-ended" });
	await writeFile(path.join(root, "mission-id.txt"), initial.contract.id);
	try { await mission.step(initial.contract.id); }
	catch (error) {
		await writeFile(path.join(root, "first-error.txt"), (error as Error).message);
		return;
	}
	throw new Error("synthetic receipt obstruction did not interrupt the first process");
}

async function childPending(root: string, missionId: string): Promise<void> {
	const ws = new Workspace(root);
	// Reproduce the historical held A002 checkpoint written before the new
	// recovery claim existed. Its target has only operationRefs, no goalRunId.
	const missionRoot = path.join(ws.agentDir, "missions", missionId);
	const status = await LocalMissionHost.status(missionRoot);
	const previousBytes = await LocalMissionHost.readLatestCheckpoint(missionRoot);
	if (!previousBytes || !status.latestCheckpoint)
		throw new Error("historical intent checkpoint is missing");
	const previous = JSON.parse(previousBytes.toString("utf8")) as ObjectiveProgressV1;
	const [intentId] = previous.continuation.unresolvedOperationIds;
	const [runId] = await ws.listRuns("M07");
	if (!intentId || !runId) throw new Error("historical dispatch IDs are missing");
	const host = await LocalMissionHost.begin({ root: missionRoot, missionId,
		attemptId: "A002", codeRevision: "local-harness-v1" });
	const held = objectiveProgress(previous.contract, {
		boundedRuns: previous.boundedRuns, selectedArtifacts: previous.selectedArtifacts,
		availableArtifacts: previous.availableArtifacts, assessment: previous.assessment,
		assessmentHistory: previous.assessmentHistory, stopReason: "execution-interrupted",
		unresolvedOperationIds: [intentId, runId].sort(),
		pendingActionFacts: { unresolvedOperationRefs: [intentId, runId].sort() } });
	await host.recordCheckpoint({ attemptId: "A002",
		sequence: status.latestCheckpoint.sequence + 1,
		previousSha256: status.latestCheckpoint.sha256,
		bytes: Buffer.from(`${JSON.stringify(held, null, 2)}\n`) });
}

async function childRaceRecover(root: string, missionId: string, label: string,
	action: "step" | "run" = "step"): Promise<void> {
	const ws = new Workspace(root);
	const log = path.join(root, "calls.log");
	registerEvaluator(log, false);
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
	const result = action === "run" ? await mission.run(missionId) : await mission.step(missionId);
	await writeFile(path.join(root, `race-${label}.json`),
		JSON.stringify({ stopReason: result.stopReason, boundedRunCount: result.boundedRuns.length }));
}

async function childCrashRecover(root: string, missionId: string,
	crashAt: "after-prepare" | "after-rename"): Promise<void> {
	const ws = new Workspace(root);
	const log = path.join(root, "calls.log");
	registerEvaluator(log, false);
	const original = LocalMissionHost.commitReviewedSuccessor;
	LocalMissionHost.commitReviewedSuccessor = input => original({ ...input, testCrashAt: crashAt });
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
	try { await mission.step(missionId); }
	catch (error) {
		if (!/synthetic crash/.test((error as Error).message)) throw error;
		await writeFile(path.join(root, `crash-${crashAt}`), (error as Error).message);
		return;
	}
	throw new Error(`synthetic ${crashAt} injection did not interrupt the V4 writer`);
}

async function childCrashWithDelegateLock(root: string, missionId: string): Promise<void> {
	const ws = new Workspace(root);
	const log = path.join(root, "calls.log");
	registerEvaluator(log, false);
	const original = LocalMissionHost.claimEvaluatorRecovery;
	LocalMissionHost.claimEvaluatorRecovery = async input => {
		const claimed = await original(input);
		if (claimed.state !== "claimed") throw new Error("synthetic recovery claim was not acquired");
		const [runId] = await ws.listRuns("M07");
		if (!runId) throw new Error("synthetic recovery has no M07 run");
		// Model the durable state just after P2 published the controller lock and
		// before its review body ran. P2 then exits without releasing either claim.
		const lock = path.join(ws.runDir("M07", runId), ".delegate-lock");
		await writeFile(lock, `${JSON.stringify({ version: 1, kind: "m07-goal-dispatch-lock",
			goalRunId: runId, owner: claimed.claim.owner })}\n`, { flag: "wx", mode: 0o600 });
		throw new Error("synthetic crash after P2 delegate-lock publication");
	};
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
	await assert.rejects(mission.step(missionId), /synthetic crash after P2 delegate-lock/);
	await writeFile(path.join(root, "p2-lock-crash"), "crashed\n");
}

async function childCrashAfterEvidenceValidation(root: string, missionId: string): Promise<void> {
	const ws = new Workspace(root);
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() {
			await writeFile(path.join(root, "source-validated"), "verified\n");
			throw new Error("synthetic crash after frozen source validation");
		},
		async evaluate() { throw new Error("returned evaluator must not be replayed"); } });
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: createRunner(path.join(root, "calls.log"), "invalid"), config: await ws.loadConfig() });
	await mission.step(missionId);
}

async function childHoldRecoveryClaim(root: string, missionId: string): Promise<void> {
	const ws = new Workspace(root);
	const missionRoot = path.join(ws.agentDir, "missions", missionId);
	const status = await LocalMissionHost.status(missionRoot);
	const bytes = await LocalMissionHost.readLatestCheckpoint(missionRoot);
	assert(bytes && status.latestCheckpoint);
	const progress = JSON.parse(bytes.toString("utf8")) as
		{ continuation: { unresolvedOperationIds: string[] } };
	const claim = await LocalMissionHost.claimEvaluatorRecovery({ root: missionRoot, missionId,
		intentId: progress.continuation.unresolvedOperationIds[0]!,
		oldCheckpointSequence: status.latestCheckpoint.sequence,
		oldCheckpointSha256: status.latestCheckpoint.sha256 });
	assert.equal(claim.state, "claimed");
	await writeFile(path.join(root, "claim-held"), "held\n");
	for (let index = 0; index < 3000; index++) {
		try { await readFile(path.join(root, "release-claim")); return; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await delay(10);
	}
	throw new Error("synthetic recovery claim was not released");
}

async function publishedReturnedFixture(t: TestContext): Promise<{
	root: string; ws: Workspace; missionId: string; missionRoot: string;
	journal: string; receiptFile: string; returnedBytes: Buffer;
	knowledgeIndex: string; knowledgePack: string; checkpointBytes: Buffer; log: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-published-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Check one synthetic candidate with retained knowledge.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const proposal = await store.submitProposal({ stage: "M04", runId: "synthetic-knowledge-source",
		ops: [{ op: "create", type: "E", title: "Retained synthetic evidence",
			body: "A committed observation remains available to the next assessor.",
			usageDecision: "adopted" }] });
	await store.merge(proposal.proposalId);
	await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
		execution: "fake/execution" }, concurrency: 1, tools: {},
		localMission: { evaluatorId, execution: "task-root-bash" } }));
	await writeFile(path.join(root, "empty-schema-errors"), "enabled\n");
	const started = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
		{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
	assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
	const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
	const missionRoot = path.join(ws.agentDir, "missions", missionId);
	const checkpointBytes = (await LocalMissionHost.readLatestCheckpoint(missionRoot))!;
	assert(checkpointBytes);
	const [runId] = await ws.listRuns("M07");
	assert(runId);
	const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
		{ tasks: Array<{ taskId: string; workDir: string }> };
	const task = goal.tasks[0]!;
	const journal = path.join(path.dirname(task.workDir), "host-evaluator-attempt");
	const receiptFile = path.join(task.workDir, "local-evaluator-receipt.json");
	const returnedBytes = await readFile(path.join(journal, "returned.json"));
	const evidenceDir = path.join(missionRoot, "evidence");
	const evidenceNames = await readdir(evidenceDir);
	const knowledgeIndex = evidenceNames.find(name => /^published-knowledge-.+-index\.json$/.test(name));
	const knowledgePack = evidenceNames.find(name => /^published-knowledge-.+-pack-1\.txt$/.test(name));
	assert(knowledgeIndex && knowledgePack);
	const log = path.join(root, "calls.log");
	assert.equal((await readFile(log, "utf8")).trim().split("\n").filter(x => x === "evaluator").length, 1);
	return { root, ws, missionId, missionRoot, journal, receiptFile, returnedBytes,
		knowledgeIndex: path.join(evidenceDir, knowledgeIndex),
		knowledgePack: path.join(evidenceDir, knowledgePack), checkpointBytes, log };
}

if (process.argv[2] === "child-start") {
	await childStart(process.argv[3]!);
} else if (process.argv[2] === "child-pending") {
	await childPending(process.argv[3]!, process.argv[4]!);
} else if (process.argv[2] === "child-race-recover") {
	await childRaceRecover(process.argv[3]!, process.argv[4]!, process.argv[5]!,
		process.argv[6] === "run" ? "run" : "step");
} else if (process.argv[2] === "child-crash-recover") {
	await childCrashRecover(process.argv[3]!, process.argv[4]!,
		process.argv[5] === "after-rename" ? "after-rename" : "after-prepare");
} else if (process.argv[2] === "child-crash-delegate-lock") {
	await childCrashWithDelegateLock(process.argv[3]!, process.argv[4]!);
} else if (process.argv[2] === "child-crash-after-source") {
	await childCrashAfterEvidenceValidation(process.argv[3]!, process.argv[4]!);
} else if (process.argv[2] === "child-hold-recovery-claim") {
	await childHoldRecoveryClaim(process.argv[3]!, process.argv[4]!);
} else {
	test("published knowledge and a dead recovery claim commit the sealed receipt before any new model call", async t => {
		const f = await publishedReturnedFixture(t);
		const crash = spawnSync(process.execPath,
			[import.meta.filename, "child-crash-after-source", f.root, f.missionId],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.notEqual(crash.status, 0);
		assert.match(crash.stderr, /synthetic crash after frozen source validation/);
		assert.equal(await readFile(path.join(f.root, "source-validated"), "utf8"), "verified\n");
		const claimed = await LocalMissionHost.status(f.missionRoot);
		assert(claimed.evaluatorRecoveryClaim);
		assert.equal((await probeProcessIdentity(claimed.evaluatorRecoveryClaim.owner)).status, "dead");
		assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.missionRoot), f.checkpointBytes);
		assert.deepEqual(await readFile(path.join(f.journal, "returned.json")), f.returnedBytes);
		await assert.rejects(readFile(f.receiptFile), { code: "EISDIR" });
		await rm(f.receiptFile, { recursive: true });
		await writeFile(path.join(f.root, "m04-pause"), "pause\n");
		const recover = spawn(process.execPath,
			[import.meta.filename, "child-race-recover", f.root, f.missionId, "published"],
			{ cwd: path.join(import.meta.dirname, ".."), stdio: "pipe" });
		let output = "";
		recover.stdout?.on("data", chunk => { output += String(chunk); });
		recover.stderr?.on("data", chunk => { output += String(chunk); });
		let atM04 = false;
		for (let index = 0; index < 400; index++) {
			try { atM04 = Boolean(await readFile(path.join(f.root, "m04-entered"))); }
			catch { await delay(10); }
			if (atM04) break;
		}
		if (!atM04) { recover.kill(); assert.fail(`receipt recovery did not enter M04: ${output}`); }
		const receipt = JSON.parse(await readFile(f.receiptFile, "utf8")) as
			{ checks: Array<{ result: string; schemaErrors?: unknown[] }> };
		assert.equal(receipt.checks[0]?.result, "passed");
		assert.deepEqual(receipt.checks[0]?.schemaErrors, []);
		assert.deepEqual(await readFile(path.join(f.journal, "returned.json")), f.returnedBytes);
		const beforeM04 = (await readFile(f.log, "utf8")).trim().split("\n");
		for (const name of ["assessor", "builder", "evaluator"])
			assert.equal(beforeM04.filter(item => item === name).length, 1, `${name} was replayed`);
		assert.equal(beforeM04.filter(item => item === "m04").length, 0,
			"receipt was committed without a new model response");
		await writeFile(path.join(f.root, "m04-release"), "release\n");
		assert.equal(await new Promise<number | null>(resolve => recover.once("exit", resolve)), 0, output);
		const final = await LocalMissionHost.status(f.missionRoot);
		assert.equal(final.latestCheckpoint?.version, 4);
		assert(final.latestCheckpoint.evaluatorRecoveryReview?.recoveryClaim.predecessors.some(item =>
			item.claimId === claimed.evaluatorRecoveryClaim!.claimId),
			"the successor must carry the dead claim in its audit chain");
		assert.equal(final.evaluatorRecoveryClaim, null);
		const progress = await LocalMissionHost.readLatestCheckpoint(f.missionRoot);
		assert.deepEqual(JSON.parse(progress!.toString("utf8")).selectedArtifacts, [],
			"a recovered receipt does not select a scientific candidate");
	});

	test("a live recovery claim blocks a published returned journal", async t => {
		const f = await publishedReturnedFixture(t);
		const holder = spawn(process.execPath,
			[import.meta.filename, "child-hold-recovery-claim", f.root, f.missionId],
			{ cwd: path.join(import.meta.dirname, ".."), stdio: "pipe" });
		let output = "";
		holder.stdout?.on("data", chunk => { output += String(chunk); });
		holder.stderr?.on("data", chunk => { output += String(chunk); });
		let held = false;
		for (let index = 0; index < 400; index++) {
			try { held = Boolean(await readFile(path.join(f.root, "claim-held"))); }
			catch { await delay(10); }
			if (held) break;
		}
		if (!held) { holder.kill(); assert.fail(`claim holder did not start: ${output}`); }
		try {
			const concurrent = spawnSync(process.execPath,
				[import.meta.filename, "child-race-recover", f.root, f.missionId, "live-claim"],
				{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
			assert.equal(concurrent.status, 0, `${concurrent.stderr}\n${concurrent.stdout}`);
			const result = JSON.parse(await readFile(path.join(f.root, "race-live-claim.json"), "utf8")) as
				{ stopReason: string; boundedRunCount: number };
			assert.equal(result.stopReason, "execution-interrupted");
			assert.equal(result.boundedRunCount, 0);
			assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.missionRoot), f.checkpointBytes);
			assert.deepEqual(await readFile(path.join(f.journal, "returned.json")), f.returnedBytes);
			await assert.rejects(readFile(f.receiptFile), { code: "EISDIR" });
			const calls = (await readFile(f.log, "utf8")).trim().split("\n");
			for (const name of ["builder", "evaluator"])
				assert.equal(calls.filter(item => item === name).length, 1);
			assert.equal(calls.filter(item => item === "m04").length, 0);
		} finally {
			await writeFile(path.join(f.root, "release-claim"), "release\n");
			assert.equal(await new Promise<number | null>(resolve => holder.once("exit", resolve)), 0, output);
		}
	});

	test("missing or changed published knowledge blocks returned-journal recovery", async t => {
		for (const variant of ["missing-index", "changed-pack"] as const)
			await t.test(variant, async sub => {
				const f = await publishedReturnedFixture(sub);
				if (variant === "missing-index") await rm(f.knowledgeIndex);
				else await writeFile(f.knowledgePack, "changed published pack\n");
				const attempt = spawnSync(process.execPath,
					[import.meta.filename, "child-race-recover", f.root, f.missionId, variant],
					{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
				assert.notEqual(attempt.status, 0);
				assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.missionRoot), f.checkpointBytes);
				assert.deepEqual(await readFile(path.join(f.journal, "returned.json")), f.returnedBytes);
				await assert.rejects(readFile(f.receiptFile), { code: "EISDIR" });
				const calls = (await readFile(f.log, "utf8")).trim().split("\n");
				for (const name of ["builder", "evaluator"])
					assert.equal(calls.filter(item => item === name).length, 1);
				assert.equal(calls.filter(item => item === "m04").length, 0);
			});
	});

	test("P3 recovers P2's dead delegate lock through the verified recovery claim chain", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-third-owner-lock-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Recover a fixed synthetic candidate.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId, execution: "task-root-bash" } }));
		const first = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const oldCheckpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		const second = spawnSync(process.execPath,
			[import.meta.filename, "child-crash-delegate-lock", root, missionId],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
		assert.equal(await readFile(path.join(root, "p2-lock-crash"), "utf8"), "crashed\n");
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		assert((await readdir(ws.runDir("M07", runId))).includes(".delegate-lock"));
		assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(missionRoot), oldCheckpoint);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ taskId: string }> };
		assert(goal.tasks[0]);
		await rm(path.join(ws.runDir("M07", runId), "tasks", goal.tasks[0]!.taskId,
			"work", "local-evaluator-receipt.json"), { recursive: true });
		const third = spawnSync(process.execPath,
			[import.meta.filename, "child-race-recover", root, missionId, "third-owner"],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(third.status, 0, `${third.stderr}\n${third.stdout}`);
		const result = JSON.parse(await readFile(path.join(root, "race-third-owner.json"), "utf8")) as
			{ boundedRunCount: number; stopReason: string };
		assert.equal(result.boundedRunCount, 1);
		assert.equal(result.stopReason, "objective-reassessment-pending");
		assert.equal((await readdir(ws.runDir("M07", runId))).includes(".delegate-lock"), false);
		const status = await LocalMissionHost.status(missionRoot);
		assert.equal(status.latestCheckpoint?.version, 4);
		assert.equal(status.checkpointReceipts.filter(item => item.version === 4).length, 1);
		const calls = (await readFile(path.join(root, "calls.log"), "utf8")).trim().split("\n");
		for (const name of ["builder", "evaluator", "m04"])
			assert.equal(calls.filter(item => item === name).length, 1, `${name} was replayed`);
	});

	test("dead returned task resumes host evaluation with an empty auxiliary candidate and no journal", async t => {
		const localEvaluatorId = "test:empty-auxiliary-positive";
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-empty-auxiliary-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check one synthetic candidate and its auxiliary log.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId: localEvaluatorId, execution: "task-root-bash" } }));
		await writeFile(path.join(root, "empty-auxiliary-case"), "enabled\n");
		const first = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		assert.match(await readFile(path.join(root, "first-error.txt"), "utf8"),
			/observation members are missing or extra/);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const oldCheckpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(oldCheckpoint);
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ taskId: string; workDir: string; reportPath: string }> };
		const task = goal.tasks[0]!;
		const taskRoot = path.dirname(task.workDir);
		const snapshot = path.join(taskRoot, "evaluator-snapshot");
		const snapshotNames = (await readdir(snapshot)).sort();
		assert.equal(snapshotNames.length, 3);
		await rm(path.join(snapshot, snapshotNames[2]!));
		await rm(path.join(taskRoot, "host-evaluator-output", "unclaimed.txt"));
		assert.equal((await stat(path.join(task.workDir, "deliverable", "compile.log"))).size, 0);
		assert.equal((await stat(path.join(task.workDir, "deliverable", "compile.log"))).mode & 0o777, 0o600);
		assert.deepEqual(await readdir(path.join(taskRoot, "host-evaluator-attempt")).catch(error =>
			(error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error)), []);
		const log = path.join(root, "calls.log");
		registerEvaluator(log, false, localEvaluatorId);
		const resumed = openDefaultLocalMission({ workspaceRoot: root,
			runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
		const recovered = await resumed.step(missionId);
		assert.equal(recovered.stopReason, "objective-reassessment-pending");
		assert.equal(recovered.boundedRuns.length, 1);
		assert.deepEqual(recovered.selectedArtifacts, []);
		const committed = await LocalMissionHost.status(missionRoot);
		assert.equal(committed.checkpointReceipts.at(-2)?.version, 4);
		assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot,
			committed.latestCheckpoint!.sequence - 2), oldCheckpoint);
		const afterGoal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ taskId: string; status: string }> };
		assert.equal(afterGoal.tasks.length, 1);
		assert.equal(afterGoal.tasks[0]!.taskId, task.taskId);
		assert.equal(afterGoal.tasks[0]!.status, "accepted");
		const calls = (await readFile(log, "utf8")).trim().split("\n");
		for (const label of ["assessor", "builder", "evaluator", "m04"])
			assert.equal(calls.filter(item => item === label).length, 1, `${label} was replayed`);
		const later = await resumed.step(missionId);
		assert.equal(later.stopReason, "cancelled");
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, false);
		const goalFile = path.join(ws.runDir("M07", runId), "goal.json");
		const tamperedGoal = JSON.parse(await readFile(goalFile, "utf8")) as
			{ knowledgeSnapshot: unknown };
		tamperedGoal.knowledgeSnapshot = { forged: true };
		await writeFile(goalFile, `${JSON.stringify(tamperedGoal, null, 2)}\n`);
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, true,
			"an unchanged baseline cannot silently gain a different knowledge snapshot");
	});

	test("recovered M04 completion survives a host checkpoint interruption without replay", async t => {
		const localEvaluatorId = "test:empty-auxiliary-m04-checkpoint-interruption";
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-m04-interruption-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check one synthetic candidate and its auxiliary log.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId: localEvaluatorId, execution: "task-root-bash" } }));
		await writeFile(path.join(root, "empty-auxiliary-case"), "enabled\n");
		const first = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ workDir: string }> };
		const taskRoot = path.dirname(goal.tasks[0]!.workDir);
		const snapshot = path.join(taskRoot, "evaluator-snapshot");
		await rm(path.join(snapshot, (await readdir(snapshot)).sort()[2]!));
		await rm(path.join(taskRoot, "host-evaluator-output", "unclaimed.txt"));
		const log = path.join(root, "calls.log");
		registerEvaluator(log, false, localEvaluatorId);
		const config = await ws.loadConfig();
		const runner = createRunner(log, "invalid");
		const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
		const record = LocalMissionHost.prototype.recordCheckpoint;
		let interrupted = false;
		LocalMissionHost.prototype.recordCheckpoint = async function(input) {
			const progress = JSON.parse(input.bytes.toString("utf8")) as
				{ stopReason?: string; boundedRuns?: unknown[] };
			if (!interrupted && progress.stopReason === "objective-reassessment-pending" &&
				progress.boundedRuns?.length === 1) {
				interrupted = true;
				throw new Error("synthetic post-M04 checkpoint interruption");
			}
			return record.call(this, input);
		};
		try { await assert.rejects(mission.step(missionId), /synthetic post-M04 checkpoint interruption/); }
		finally { LocalMissionHost.prototype.recordCheckpoint = record; }
		assert(interrupted);
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, false);
		assert.equal((await mission.status(missionId)).stopReason, "m04-review-pending");
		const reopened = openDefaultLocalMission({ workspaceRoot: root, runner, config });
		const selected = await reopened.step(missionId);
		assert.equal(selected.stopReason, "objective-reassessment-pending");
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, false);
		const calls = (await readFile(log, "utf8")).trim().split("\n");
		for (const label of ["assessor", "builder", "evaluator", "m04"])
			assert.equal(calls.filter(item => item === label).length, 1, `${label} was replayed`);
	});

	test("recovered accepted M04 refresh binds its formal baseline to the completed run", async t => {
		const localEvaluatorId = "test:empty-auxiliary-formal-baseline";
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-m04-baseline-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check one synthetic candidate and its auxiliary log.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		const baseline = await ws.startRun("M04", []);
		await ws.finishRun(baseline, "completed");
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId: localEvaluatorId, execution: "task-root-bash" } }));
		await writeFile(path.join(root, "empty-auxiliary-case"), "enabled\n");
		const first = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ workDir: string }> };
		const taskRoot = path.dirname(goal.tasks[0]!.workDir);
		const snapshot = path.join(taskRoot, "evaluator-snapshot");
		await rm(path.join(snapshot, (await readdir(snapshot)).sort()[2]!));
		await rm(path.join(taskRoot, "host-evaluator-output", "unclaimed.txt"));
		const log = path.join(root, "calls.log");
		registerEvaluator(log, false, localEvaluatorId);
		const mission = openDefaultLocalMission({ workspaceRoot: root,
			runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
		const advanced = await mission.step(missionId);
		assert.equal(advanced.stopReason, "objective-reassessment-pending");
		assert(advanced.selectedArtifacts.length > 0);
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, false);
		const goalFile = path.join(ws.runDir("M07", runId), "goal.json");
		const finishedBytes = await readFile(goalFile);
		const finished = JSON.parse(finishedBytes.toString("utf8")) as {
			m04BaselineRunId: string; knowledgeSnapshot: unknown;
			baselineHistory: Array<{ m04RunId: string; knowledgeSnapshot?: unknown }> };
		assert.notEqual(finished.m04BaselineRunId, baseline.runId);
		assert.equal(finished.baselineHistory.at(-1)?.m04RunId, finished.m04BaselineRunId);
		finished.knowledgeSnapshot = "forged-snapshot";
		finished.baselineHistory.at(-1)!.knowledgeSnapshot = "forged-snapshot";
		await writeFile(goalFile, `${JSON.stringify(finished, null, 2)}\n`);
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, true,
			"matched but forged live/history snapshots must not replace the M04 transaction authority");
		await writeFile(goalFile, finishedBytes);
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, false);
		const selectionFile = path.join(missionRoot, "evidence",
			`selection-review-${runId}.json`);
		const selection = JSON.parse(await readFile(selectionFile, "utf8")) as { m04RunId: string };
		selection.m04RunId = baseline.runId;
		await writeFile(selectionFile, `${JSON.stringify(selection, null, 2)}\n`);
		assert.equal((await LocalMissionHost.status(missionRoot)).repairRequired, true,
			"the selected successor must retain its exact M04 review receipt");
	});

	test("untrusted snapshot, assessor evidence, and unknown effects block journal-absent recovery", async t => {
		for (const cause of ["snapshot-symlink", "orphan-extra", "uncopied-source",
			"foreign-assessor-evidence", "unknown-effect"] as const)
			await t.test(cause, async t => {
				const localEvaluatorId = `test:empty-auxiliary-${cause}`;
				const root = await mkdtemp(path.join(os.tmpdir(), `local-evaluator-empty-negative-${cause}-`));
				t.after(() => rm(root, { recursive: true, force: true }));
				const ws = new Workspace(root);
				await mkdir(path.dirname(ws.problemFile), { recursive: true });
				await writeFile(ws.problemFile, "Check one synthetic candidate.\n");
				await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
				await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
					execution: "fake/execution" }, concurrency: 1, tools: {},
					localMission: { evaluatorId: localEvaluatorId, execution: "task-root-bash" } }));
				await writeFile(path.join(root, "empty-auxiliary-case"), "enabled\n");
				const first = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
					{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
				assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
				const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
				const missionRoot = path.join(ws.agentDir, "missions", missionId);
				const original = await LocalMissionHost.readLatestCheckpoint(missionRoot);
				const originalSequence = (await LocalMissionHost.status(missionRoot)).latestCheckpoint!.sequence;
				const [runId] = await ws.listRuns("M07");
				assert(runId);
				const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
					{ tasks: Array<{ taskId: string; workDir: string; reportPath: string }> };
				const task = goal.tasks[0]!;
				const taskRoot = path.dirname(task.workDir);
				const snapshot = path.join(taskRoot, "evaluator-snapshot");
				const names = (await readdir(snapshot)).sort();
				await rm(path.join(snapshot, names.at(-1)!));
				await rm(path.join(taskRoot, "host-evaluator-output", "unclaimed.txt"));
				if (cause === "snapshot-symlink") {
					await rm(path.join(snapshot, names[0]!));
					await symlink(task.reportPath, path.join(snapshot, names[0]!));
				} else if (cause === "orphan-extra") {
					await writeFile(path.join(snapshot, "candidate-999.txt"), "foreign snapshot\n");
				} else if (cause === "uncopied-source") {
					await writeFile(path.join(task.workDir, "deliverable", "compile.log"), "changed after return\n");
				} else if (cause === "foreign-assessor-evidence") {
					const mission = await ws.readRun("MISSION", (await ws.listRuns("MISSION"))[0]!);
					const evidenceRoot = mission.sessions.find(row => row.role === "research")?.boundary?.capability?.root;
					assert(evidenceRoot);
					await writeFile(path.join(evidenceRoot, "original-problem.txt"), "forged assessor evidence\n");
				} else {
					const host = await LocalMissionHost.begin({ root: missionRoot, missionId,
						attemptId: "A002", codeRevision: "local-harness-v1" });
					await host.recordUnknownOperation({ attemptId: "A002", operationId: "synthetic-unknown-effect" });
				}
				const log = path.join(root, "calls.log");
				registerEvaluator(log, false, localEvaluatorId);
				const resumed = openDefaultLocalMission({ workspaceRoot: root,
					runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
				if (cause !== "foreign-assessor-evidence") {
					const held = await resumed.step(missionId);
					assert.equal(held.stopReason, "execution-interrupted");
				} else await assert.rejects(resumed.step(missionId), /assessor evidence source differs/);
				assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot, originalSequence), original);
				const calls = (await readFile(log, "utf8")).trim().split("\n");
				assert.equal(calls.filter(item => item === "assessor").length, 1);
				assert.equal(calls.filter(item => item === "builder").length, 1);
				assert.equal(calls.filter(item => item === "evaluator").length, 0);
				assert.equal((await ws.listRuns("M04")).length, 0);
			});
	});

	test("a fresh process commits V4 for an exact returned evaluator without replaying the builder or evaluator", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-mission-recovery-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check a fixed synthetic candidate.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" },
			concurrency: 1, tools: {}, localMission: { evaluatorId,
				execution: "task-root-bash" } }));
		const child = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		assert.match(await readFile(path.join(root, "first-error.txt"), "utf8"), /receipt|bounded|regular|file/i);
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const oldCheckpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(oldCheckpoint);
		const old = JSON.parse(oldCheckpoint.toString("utf8")) as {
			assessmentHistory: unknown[]; boundedRuns: unknown[]; selectedArtifacts: string[];
			continuation: { unresolvedOperationIds: string[] } };
		assert.equal(old.boundedRuns.length, 0);
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ taskId: string; reportPath: string }> };
		const task = goal.tasks[0]!;
		const journal = path.join(ws.runDir("M07", runId), "tasks", task.taskId,
			"host-evaluator-attempt");
		const oldBytes = {
			checkpoint: Buffer.from(oldCheckpoint),
			report: await readFile(task.reportPath),
			entered: await readFile(path.join(journal, "entered.json")),
			returned: await readFile(path.join(journal, "returned.json")),
		};
		await rm(path.join(ws.runDir("M07", runId), "tasks", task.taskId, "work",
			"local-evaluator-receipt.json"), { recursive: true });
		const log = path.join(root, "calls.log");
		registerEvaluator(log, false);
		const reopened = openDefaultLocalMission({ workspaceRoot: root,
			runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
		const recovered = await reopened.step(missionId);
		assert.equal(recovered.stopReason, "objective-reassessment-pending");
		assert.deepEqual(recovered.assessmentHistory, old.assessmentHistory);
		assert.deepEqual(recovered.selectedArtifacts, old.selectedArtifacts);
		assert.equal(recovered.boundedRuns.length, 1);
		assert.equal(recovered.boundedRuns[0]!.runId, runId);
		assert.deepEqual(recovered.continuation.unresolvedOperationIds, []);
		const status = await LocalMissionHost.status(missionRoot);
		assert.equal(status.currentAttempt?.attemptId, "A002");
		assert.equal(status.latestCheckpoint?.version, 4);
		assert.equal(status.latestCheckpoint?.evaluatorRecoveryReview?.intentId,
			old.continuation.unresolvedOperationIds[0]);
		assert.deepEqual(await readFile(task.reportPath), oldBytes.report);
		assert.deepEqual(await readFile(path.join(journal, "entered.json")), oldBytes.entered);
		assert.deepEqual(await readFile(path.join(journal, "returned.json")), oldBytes.returned);
		assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot,
			status.latestCheckpoint!.sequence - 1), oldBytes.checkpoint);
		const calls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(calls.filter(item => item === "assessor").length, 1);
		assert.equal(calls.filter(item => item === "builder").length, 1);
		assert.equal(calls.filter(item => item === "evaluator").length, 1);
		assert.equal(calls.filter(item => item === "m04").length, 1);
		await reopened.step(missionId);
		const nextCalls = (await readFile(log, "utf8")).trim().split("\n");
		assert(nextCalls.filter(item => item === "assessor").length > 1,
			"a separate next step can begin a fresh original-objective assessment");
		assert.equal(nextCalls.filter(item => item === "builder").length, 1);
		assert.equal(nextCalls.filter(item => item === "evaluator").length, 1);
	});

	test("opaque throw stays UNKNOWN until a later owner proves the child is dead, then permits distinct work", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-throw-recovery-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check a fixed synthetic candidate and keep going.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId: throwingEvaluatorId, execution: "task-root-bash" } }));
		const start = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);
		assert.match(await readFile(path.join(root, "first-error.txt"), "utf8"), /opaque evaluator throw/);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const [oldRunId] = await ws.listRuns("M07");
		assert(oldRunId);
		const oldGoal = JSON.parse(await readFile(path.join(ws.runDir("M07", oldRunId),
			"goal.json"), "utf8")) as { tasks: Array<{ taskId: string; reportPath: string }> };
		const oldTask = oldGoal.tasks[0]!;
		const partial = path.join(ws.runDir("M07", oldRunId), "tasks", oldTask.taskId,
			"host-evaluator-output", "observation-partial.txt");
		const partialBytes = await readFile(partial);
		assert.equal((await stat(partial)).mode & 0o777, 0o600);
		const oldReport = await readFile(oldTask.reportPath);
		const pending = spawnSync(process.execPath,
			[import.meta.filename, "child-pending", root, missionId],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(pending.status, 0, `${pending.stderr}\n${pending.stdout}`);
		const heldStatus = await LocalMissionHost.status(missionRoot);
		assert.equal(heldStatus.currentAttempt?.attemptId, "A002");
		assert.equal(heldStatus.latestCheckpoint?.source.attemptId, "A002");
		const heldBytes = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(heldBytes);
		const held = JSON.parse(heldBytes.toString("utf8")) as {
			continuation: { unresolvedOperationIds: string[] }; selectedArtifacts: string[];
			assessmentHistory: unknown[]; boundedRuns: unknown[] };
		const [intentId] = (await ws.listRuns("MISSION"));
		assert(intentId);
		assert.deepEqual(held.continuation.unresolvedOperationIds.sort(), [intentId, oldRunId].sort());
		assert.equal(held.boundedRuns.length, 0);
		registerThrowingEvaluator(root, true);
		const log = path.join(root, "calls.log");
		const mission = openDefaultLocalMission({ workspaceRoot: root,
			runner: createRunner(log, "second"), config: await ws.loadConfig() });
		const settled = await mission.step(missionId);
		assert.equal(settled.stopReason, "objective-reassessment-pending");
		assert.deepEqual(settled.assessmentHistory, held.assessmentHistory);
		assert.deepEqual(settled.selectedArtifacts, held.selectedArtifacts);
		assert.deepEqual(settled.continuation.unresolvedOperationIds, []);
		assert.equal(settled.boundedRuns.length, 1);
		assert.deepEqual(settled.boundedRuns[0]!.acceptedTaskIds, []);
		const reviewed = await LocalMissionHost.status(missionRoot);
		assert.equal(reviewed.latestCheckpoint?.version, 4);
		assert.equal(reviewed.currentAttempt?.attemptId, "A003");
		const recovery = reviewed.latestCheckpoint?.evaluatorRecoveryReview;
		assert(recovery);
		assert.equal(recovery.evaluator.phase, "settled-failure");
		assert.equal(recovery.dispatchOriginAttempt.attemptId, "A001");
		assert.equal(recovery.oldAttempt.attemptId, "A002");
		assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot,
			reviewed.latestCheckpoint!.sequence - 1), heldBytes);
		assert.deepEqual(await readFile(partial), partialBytes);
		assert.deepEqual(await readFile(oldTask.reportPath), oldReport);
		let calls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(calls.filter(item => item === "builder").length, 1);
		assert.equal(calls.filter(item => item === "evaluator").length, 1);
		try { await mission.step(missionId); }
		catch (error) { assert.match((error as Error).message, /opaque evaluator throw/); }
		calls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(calls.filter(item => item === "builder").length, 2);
		const m07Runs = await ws.listRuns("M07");
		assert.equal(m07Runs.length, 2);
		const newRunId = m07Runs.find(id => id !== oldRunId)!;
		const newGoal = JSON.parse(await readFile(path.join(ws.runDir("M07", newRunId),
			"goal.json"), "utf8")) as { goal: string };
		assert.equal(newGoal.goal, "Produce a distinct second synthetic candidate");
	});

	test("an active recovery claim keeps concurrent and child-live checks on the same old checkpoint", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-claim-pending-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Measure a synthetic candidate once.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId: liveEvaluatorId, execution: "task-root-bash" } }));
		const start = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000,
				env: { ...process.env, MULPIS_LIVE_CHILD_MS: "10000" } });
		assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const before = await LocalMissionHost.status(missionRoot);
		const beforeBytes = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(beforeBytes);
		const childProcess = JSON.parse(await readFile(path.join(root, "owned-child.json"), "utf8")) as
			{ hostId: string; bootId: string; pid: number; processStartToken: string };
		assert.equal((await probeProcessIdentity(childProcess)).status, "alive");
		registerThrowingEvaluator(root, true, 0, liveEvaluatorId);
		const log = path.join(root, "calls.log");
		const mission = openDefaultLocalMission({ workspaceRoot: root,
			runner: createRunner(log, "invalid"), config: await ws.loadConfig() });
		await writeFile(path.join(root, "pause-reconcile"), "pause\n");
		const first = mission.step(missionId);
		let entered = false;
		for (let index = 0; index < 200; index++) {
			try { entered = Boolean(await readFile(path.join(root, "reconcile-entered"))); }
			catch { await delay(10); }
			if (entered) break;
		}
		assert(entered, "the first recoverer never reached the reconciliation barrier");
		const overlapping = await mission.step(missionId);
		assert.equal(overlapping.stopReason, "execution-interrupted");
		assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(missionRoot), beforeBytes);
		await writeFile(path.join(root, "release-reconcile"), "release\n");
		const pending = await first;
		assert.equal(pending.stopReason, "execution-interrupted");
		const claimed = await LocalMissionHost.status(missionRoot);
		assert.equal(claimed.currentAttempt?.attemptId, "A001");
		assert.equal(claimed.latestCheckpoint?.sha256, before.latestCheckpoint?.sha256);
		assert(claimed.evaluatorRecoveryClaim);
		const pendingCalls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(pendingCalls.filter(item => item === "builder").length, 1);
		assert.equal(pendingCalls.filter(item => item === "evaluator").length, 1);
		await writeFile(path.join(root, "release-child"), "release\n");
		let dead = false;
		for (let index = 0; index < 300; index++) {
			dead = (await probeProcessIdentity(childProcess)).status === "dead";
			if (dead) break;
			await delay(20);
		}
		assert(dead, "owned evaluator child did not exit after release");
		const settled = await mission.step(missionId);
		assert.equal(settled.stopReason, "objective-reassessment-pending");
		const finalStatus = await LocalMissionHost.status(missionRoot);
		assert.equal(finalStatus.currentAttempt?.attemptId, "A002");
		assert.equal(finalStatus.latestCheckpoint?.version, 4);
		assert.equal(finalStatus.evaluatorRecoveryClaim, null);
		const calls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(calls.filter(item => item === "builder").length, 1);
		assert.equal(calls.filter(item => item === "evaluator").length, 1);
	});

	test("two new processes race one returned journal and only the claimed owner enters M04", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-two-process-race-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check one returned synthetic candidate.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId, execution: "task-root-bash" } }));
		const first = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const oldCheckpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(oldCheckpoint);
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ taskId: string; reportPath: string }> };
		const task = goal.tasks[0]!;
		const journal = path.join(ws.runDir("M07", runId), "tasks", task.taskId,
			"host-evaluator-attempt");
		const reportBytes = await readFile(task.reportPath);
		const enteredBytes = await readFile(path.join(journal, "entered.json"));
		const returnedBytes = await readFile(path.join(journal, "returned.json"));
		await rm(path.join(ws.runDir("M07", runId), "tasks", task.taskId, "work",
			"local-evaluator-receipt.json"), { recursive: true });
		await writeFile(path.join(root, "m04-pause"), "pause\n");
		const winner = spawn(process.execPath,
			[import.meta.filename, "child-race-recover", root, missionId, "winner"],
			{ cwd: path.join(import.meta.dirname, ".."), stdio: "pipe" });
		let winnerOutput = "";
		winner.stdout?.on("data", chunk => { winnerOutput += String(chunk); });
		winner.stderr?.on("data", chunk => { winnerOutput += String(chunk); });
		let atM04 = false;
		for (let index = 0; index < 400; index++) {
			try { atM04 = Boolean(await readFile(path.join(root, "m04-entered"))); }
			catch { await delay(10); }
			if (atM04) break;
		}
		if (!atM04) {
			winner.kill();
			assert.fail(`winner did not enter M04 after claim: ${winnerOutput}`);
		}
		const loser = spawnSync(process.execPath,
			[import.meta.filename, "child-race-recover", root, missionId, "loser"],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(loser.status, 0, `${loser.stderr}\n${loser.stdout}`);
		const loserResult = JSON.parse(await readFile(path.join(root, "race-loser.json"), "utf8")) as
			{ stopReason: string; boundedRunCount: number };
		assert.equal(loserResult.stopReason, "execution-interrupted");
		assert.equal(loserResult.boundedRunCount, 0);
		assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(missionRoot), oldCheckpoint);
		await writeFile(path.join(root, "m04-release"), "release\n");
		const winnerExit = await new Promise<number | null>(resolve => winner.once("exit", resolve));
		assert.equal(winnerExit, 0, winnerOutput);
		const winnerResult = JSON.parse(await readFile(path.join(root, "race-winner.json"), "utf8")) as
			{ stopReason: string; boundedRunCount: number };
		assert.equal(winnerResult.stopReason, "objective-reassessment-pending");
		assert.equal(winnerResult.boundedRunCount, 1);
		const status = await LocalMissionHost.status(missionRoot);
		assert.equal(status.latestCheckpoint?.version, 4);
		assert.equal(status.currentAttempt?.attemptId, "A002");
		assert.equal(status.checkpointReceipts.filter(item => item.version === 4).length, 1);
		assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot,
			status.latestCheckpoint!.sequence - 1), oldCheckpoint);
		assert.deepEqual(await readFile(task.reportPath), reportBytes);
		assert.deepEqual(await readFile(path.join(journal, "entered.json")), enteredBytes);
		assert.deepEqual(await readFile(path.join(journal, "returned.json")), returnedBytes);
		const calls = (await readFile(path.join(root, "calls.log"), "utf8")).trim().split("\n");
		for (const name of ["assessor", "builder", "evaluator", "m04"])
			assert.equal(calls.filter(item => item === name).length, 1, `${name} was duplicated by the loser`);
	});

	test("facade retries a dead V4 writer after prepare or after atomic rename", async t => {
		for (const crashAt of ["after-prepare", "after-rename"] as const) {
			await t.test(crashAt, async t => {
				const root = await mkdtemp(path.join(os.tmpdir(), `local-evaluator-${crashAt}-`));
				t.after(() => rm(root, { recursive: true, force: true }));
				const ws = new Workspace(root);
				await mkdir(path.dirname(ws.problemFile), { recursive: true });
				await writeFile(ws.problemFile, "Recover one synthetic V4 writer crash.\n");
				await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
				await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
					execution: "fake/execution" }, concurrency: 1, tools: {},
					localMission: { evaluatorId, execution: "task-root-bash" } }));
				const start = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
					{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
				assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);
				const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
				const missionRoot = path.join(ws.agentDir, "missions", missionId);
				const oldStatus = await LocalMissionHost.status(missionRoot);
				const oldCheckpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
				assert(oldCheckpoint && oldStatus.latestCheckpoint);
				const [runId] = await ws.listRuns("M07");
				assert(runId);
				const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
					{ tasks: Array<{ taskId: string; reportPath: string }> };
				const task = goal.tasks[0]!;
				const journal = path.join(ws.runDir("M07", runId), "tasks", task.taskId,
					"host-evaluator-attempt");
				const reportBytes = await readFile(task.reportPath);
				const enteredBytes = await readFile(path.join(journal, "entered.json"));
				const returnedBytes = await readFile(path.join(journal, "returned.json"));
				await rm(path.join(ws.runDir("M07", runId), "tasks", task.taskId, "work",
					"local-evaluator-receipt.json"), { recursive: true });
				const crash = spawnSync(process.execPath,
					[import.meta.filename, "child-crash-recover", root, missionId, crashAt],
					{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
				assert.equal(crash.status, 0, `${crash.stderr}\n${crash.stdout}`);
				assert.match(await readFile(path.join(root, `crash-${crashAt}`), "utf8"), /synthetic crash/);
				const interrupted = await LocalMissionHost.status(missionRoot);
				assert(interrupted.writerLockPresent);
				assert.equal(interrupted.latestCheckpoint?.version, crashAt === "after-prepare" ? 1 : 4);
				const retry = spawnSync(process.execPath,
					[import.meta.filename, "child-race-recover", root, missionId, "retry",
						crashAt === "after-prepare" ? "run" : "step"],
					{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
				assert.equal(retry.status, 0, `${retry.stderr}\n${retry.stdout}`);
				const retried = JSON.parse(await readFile(path.join(root, "race-retry.json"), "utf8")) as
					{ stopReason: string; boundedRunCount: number };
				assert.equal(retried.boundedRunCount, 1);
				if (crashAt === "after-prepare")
					assert.equal(retried.stopReason, "cancelled",
						"mission.run continued to a fresh assessor after V4 recovery");
				const final = await LocalMissionHost.status(missionRoot);
				assert.equal(final.writerLockPresent, false);
				assert.equal(final.preparedReviewPending, false);
				assert.equal(final.checkpointReceipts.filter(item => item.version === 4).length, 1);
				assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot,
					oldStatus.latestCheckpoint.sequence), oldCheckpoint);
				assert.deepEqual(await readFile(task.reportPath), reportBytes);
				assert.deepEqual(await readFile(path.join(journal, "entered.json")), enteredBytes);
				assert.deepEqual(await readFile(path.join(journal, "returned.json")), returnedBytes);
				const calls = (await readFile(path.join(root, "calls.log"), "utf8")).trim().split("\n");
				for (const name of ["builder", "evaluator", "m04"])
					assert.equal(calls.filter(item => item === name).length, 1, `${name} was replayed`);
			});
		}
	});

	test("a partial pre-entry journal becomes negative V4 evidence without an evaluator call", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-pre-entry-orphan-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check one synthetic candidate, then continue after a failed host preparation.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId: orphanEvaluatorId, execution: "task-root-bash" } }));
		await writeFile(path.join(root, "pre-entry-orphan"), "inject\n");
		const start = spawnSync(process.execPath, [import.meta.filename, "child-start", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const oldBytes = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(oldBytes);
		const old = JSON.parse(oldBytes.toString("utf8")) as {
			assessmentHistory: unknown[]; selectedArtifacts: string[];
			continuation: { unresolvedOperationIds: string[] } };
		const [oldRunId] = await ws.listRuns("M07");
		assert(oldRunId);
		const goalFile = path.join(ws.runDir("M07", oldRunId), "goal.json");
		const goal = JSON.parse(await readFile(goalFile, "utf8")) as
			{ tasks: Array<{ taskId: string; reportPath: string }> };
		const task = goal.tasks[0]!;
		const oldReport = await readFile(task.reportPath);
		const orphan = path.join(ws.runDir("M07", oldRunId), "tasks", task.taskId,
			"host-evaluator-attempt", "prepared.json.pending");
		const orphanBytes = await readFile(orphan);
		assert.equal((await stat(orphan)).mode & 0o777, 0o400);
		const log = path.join(root, "calls.log");
		assert.equal((await readFile(log, "utf8")).trim().split("\n").filter(item =>
			item === "evaluator").length, 0);
		registerEvaluator(log, false, orphanEvaluatorId);
		const mission = openDefaultLocalMission({ workspaceRoot: root,
			runner: createRunner(log, "second"), config: await ws.loadConfig() });
		const recovered = await mission.step(missionId);
		assert.equal(recovered.stopReason, "objective-reassessment-pending");
		assert.deepEqual(recovered.assessmentHistory, old.assessmentHistory);
		assert.deepEqual(recovered.selectedArtifacts, old.selectedArtifacts);
		assert.deepEqual(recovered.continuation.unresolvedOperationIds, []);
		assert.equal(recovered.boundedRuns.length, 1);
		assert.deepEqual(recovered.boundedRuns[0]!.acceptedTaskIds, []);
		const status = await LocalMissionHost.status(missionRoot);
		assert.equal(status.latestCheckpoint?.version, 4);
		assert.equal(status.latestCheckpoint?.evaluatorRecoveryReview?.evaluator.phase,
			"pre-entry-unlocated");
		assert.equal(status.latestCheckpoint?.evaluatorRecoveryReview?.m04, undefined);
		assert.equal(status.currentAttempt?.attemptId, "A002");
		assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(missionRoot,
			status.latestCheckpoint!.sequence - 1), oldBytes);
		assert.deepEqual(await readFile(orphan), orphanBytes);
		assert.deepEqual(await readFile(task.reportPath), oldReport);
		assert.equal((await ws.listRuns("M04")).length, 0);
		const calls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(calls.filter(item => item === "builder").length, 1);
		assert.equal(calls.filter(item => item === "evaluator").length, 0);
		await rm(path.join(root, "pre-entry-orphan"));
		await mission.step(missionId);
		const nextCalls = (await readFile(log, "utf8")).trim().split("\n");
		assert.equal(nextCalls.filter(item => item === "builder").length, 2,
			"the follow-up task is distinct from the recovered old builder run");
		const runIds = await ws.listRuns("M07");
		assert.equal(runIds.length, 2);
		const nextGoal = JSON.parse(await readFile(path.join(ws.runDir("M07",
			runIds.find(id => id !== oldRunId)!), "goal.json"), "utf8")) as { goal: string };
		assert.equal(nextGoal.goal, "Produce a distinct second synthetic candidate");
	});
}
