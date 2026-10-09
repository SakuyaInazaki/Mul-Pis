import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

const evaluatorId = "test:two-owner-returned-evaluator";
const candidate = "A synthetic finite candidate with exact bytes.\n";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const value = await readFile(file, "utf8");
			if (value) events.push({ toolName, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1,
					endLine: value.split(/\r?\n/).length - Number(value.endsWith("\n")),
					truncated: false }, at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

function registerEvaluator(root: string, obstructReceipt: boolean): void {
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["file-sha256"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, candidate: files, observationOutputDir }) {
			await appendFile(path.join(root, "calls.log"), "evaluator\n");
			const observation = "observation-race.json";
			await writeFile(path.join(observationOutputDir, observation),
				`${JSON.stringify({ kind: "synthetic-race-observation", bytes: files[0]?.bytes })}\n`,
				{ flag: "wx", mode: 0o600 });
			if (obstructReceipt) await mkdir(path.join(path.dirname(observationOutputDir),
				"work", "local-evaluator-receipt.json"));
			return { observations: [{ name: observation, kind: "json" as const }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "passed" as const, evidenceRefs: [files[0]!.name, observation], limitations: [] })),
				limitations: ["Offline synthetic race test"] };
		} });
}

async function startFirst(root: string): Promise<void> {
	const ws = new Workspace(root);
	registerEvaluator(root, true);
	let missionId = "";
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label === "M04-research") return "Initial synthetic baseline; no proposal.";
		if (spec.label.startsWith("M07-")) {
			await appendFile(path.join(root, "calls.log"), "builder\n");
			return candidate;
		}
		if (spec.label.startsWith("local-original-objective-")) {
			await appendFile(path.join(root, "calls.log"), "assessor\n");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read grant missing");
			const ref = { sourceId: "original-problem.txt", startLine: 1, endLine: 1 };
			const issue = { id: "race-gap", claim: "The candidate needs a host check", status: "open",
				classification: "explicit-requirement", sourceRefs: [ref],
				implication: "An exact digest can settle this check" };
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "The candidate still needs measurement", evidenceRefs: ["original-problem.txt"],
				unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Produce the exact synthetic candidate", obligationIds: ["answer"],
						addresses: [issue.id], adapterScope: "local-m07-execute",
						decisionChangingHypothesis: "Exact bytes settle the check",
						expectedEvidence: "A digest checked candidate", sourceRefs: [ref] } } }),
				readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
		}
		throw new Error(`unexpected first-process session ${spec.label}`);
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config: await ws.loadConfig() });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Produce the exact synthetic candidate", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Produce exact synthetic bytes",
			type: "file-sha256", expectedSha256: digest(Buffer.from(candidate)) }],
		closure: "open-ended" });
	missionId = started.contract.id;
	await writeFile(path.join(root, "mission-id.txt"), missionId);
	try { await mission.step(missionId); }
	catch (error) {
		await writeFile(path.join(root, "first-error.txt"), (error as Error).message);
		return;
	}
	throw new Error("receipt obstruction failed to interrupt the first process");
}

async function runOwner(root: string, missionId: string, owner: string, barrier: boolean): Promise<void> {
	const ws = new Workspace(root);
	registerEvaluator(root, false);
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (!barrier && spec.label.startsWith("local-original-objective-"))
			return "Deliberately invalid fresh assessment";
		if (spec.label !== "M04-research")
			throw new Error(`old builder/evaluator or fresh assessor replayed: ${spec.label}`);
		await appendFile(path.join(root, "calls.log"), `m04:${owner}\n`);
		if (barrier) {
			await writeFile(path.join(root, "m04-entered"), `${owner}\n`, { flag: "wx" });
			for (let i = 0; i < 1000; i++) {
				try { await readFile(path.join(root, "release-m04")); break; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				await delay(20);
				if (i === 999) throw new Error("M04 barrier was never released");
			}
		}
		return { text: "Independent M04 read frozen synthetic evidence; no proposal.",
			readReturns: spec.tools.kind === "read-dir" ?
				await readEvents(spec.tools.root, "m07_evidence_read") : [] };
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config: await ws.loadConfig() });
	const result = await mission.step(missionId);
	await writeFile(path.join(root, `owner-${owner}.json`), `${JSON.stringify({
		stopReason: result.stopReason, boundedRuns: result.boundedRuns,
		unresolvedOperationIds: result.continuation.unresolvedOperationIds })}\n`);
}

const childOutput = new WeakMap<ChildProcess, string>();
function child(root: string, missionId: string, owner: string, barrier: boolean): ChildProcess {
	const proc = spawn(process.execPath, [import.meta.filename, "owner", root, missionId, owner,
		barrier ? "barrier" : "free"], { cwd: path.join(import.meta.dirname, ".."),
		stdio: ["ignore", "pipe", "pipe"] });
	childOutput.set(proc, "");
	for (const stream of [proc.stdout, proc.stderr])
		stream?.on("data", chunk => childOutput.set(proc, childOutput.get(proc)! + String(chunk)));
	return proc;
}

async function exited(proc: ChildProcess, label: string): Promise<void> {
	const exitCode = proc.exitCode ?? await new Promise<number | null>((resolve, reject) => {
		proc.once("error", reject);
		proc.once("exit", resolve);
	});
	assert.equal(exitCode, 0, `${label}: ${childOutput.get(proc) ?? ""}`);
}

async function waitFor(file: string, proc?: ChildProcess): Promise<void> {
	for (let i = 0; i < 600; i++) {
		try { await readFile(file); return; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (proc?.exitCode !== null && proc?.exitCode !== undefined)
			throw new Error(`child exited before ${path.basename(file)}: ${childOutput.get(proc) ?? ""}`);
		await delay(20);
	}
	throw new Error(`timed out waiting for ${path.basename(file)}`);
}

if (process.argv[2] === "first") {
	await startFirst(process.argv[3]!);
} else if (process.argv[2] === "owner") {
	await runOwner(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6] === "barrier");
} else {
	test("two fresh owner processes race one returned evaluator recovery", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-two-owner-race-"));
		t.after(() => process.env.MULPIS_TEST_KEEP_RECOVERY ? Promise.resolve() :
			rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Check a fixed synthetic candidate.\n");
		await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
			execution: "fake/execution" }, concurrency: 1, tools: {},
			localMission: { evaluatorId, execution: "task-root-bash" } }));
		const first = spawnSync(process.execPath, [import.meta.filename, "first", root],
			{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		assert.match(await readFile(path.join(root, "first-error.txt"), "utf8"), /receipt|bounded|regular|file/i);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const original = await LocalMissionHost.status(missionRoot);
		const oldCheckpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(oldCheckpoint);
		const [runId] = await ws.listRuns("M07");
		assert(runId);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId), "goal.json"), "utf8")) as
			{ tasks: Array<{ taskId: string; reportPath: string }> };
		const task = goal.tasks[0]!;
		const journal = path.join(ws.runDir("M07", runId), "tasks", task.taskId,
			"host-evaluator-attempt");
		const before = { report: await readFile(task.reportPath),
			entered: await readFile(path.join(journal, "entered.json")),
			returned: await readFile(path.join(journal, "returned.json")) };
		await rm(path.join(ws.runDir("M07", runId), "tasks", task.taskId, "work",
			"local-evaluator-receipt.json"), { recursive: true });
		const a = child(root, missionId, "a", true);
		t.after(() => { a.kill(); });
		await waitFor(path.join(root, "m04-entered"), a);
		assert.equal((await readFile(path.join(root, "m04-entered"), "utf8")).trim(), "a");
		const b = child(root, missionId, "b", true);
		t.after(() => { b.kill(); });
		const winner = "a";
		const loser = "b";
		await waitFor(path.join(root, `owner-${loser}.json`), b);
		const held = JSON.parse(await readFile(path.join(root, `owner-${loser}.json`), "utf8"));
		assert.equal(held.stopReason, "execution-interrupted");
		assert.equal(held.boundedRuns.length, 0);
		assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(missionRoot), oldCheckpoint);
		const mid = await LocalMissionHost.status(missionRoot);
		assert.equal(mid.latestCheckpoint?.sha256, original.latestCheckpoint?.sha256);
		assert.equal(mid.evaluatorRecoveryClaim?.owner.pid, a.pid);
		assert.equal((await readFile(path.join(root, "calls.log"), "utf8")).split("\n")
			.filter(row => row.startsWith("m04:")).length, 1);
		await writeFile(path.join(root, "release-m04"), "go\n");
		await Promise.all([exited(a, "owner a"), exited(b, "owner b")]);
		const won = JSON.parse(await readFile(path.join(root, `owner-${winner}.json`), "utf8"));
		assert.equal(won.stopReason, "objective-reassessment-pending");
		assert.deepEqual(won.unresolvedOperationIds, []);
		assert.equal(won.boundedRuns.length, 1);
		const final = await LocalMissionHost.status(missionRoot);
		assert.equal(final.checkpointReceipts.length, original.checkpointReceipts.length + 1);
		assert.equal(final.latestCheckpoint?.version, 4);
		assert.equal(final.latestCheckpoint?.evaluatorRecoveryReview?.evaluator.phase, "returned");
		assert.equal(final.evaluatorRecoveryClaim, null);
		assert.deepEqual(await readFile(task.reportPath), before.report);
		assert.deepEqual(await readFile(path.join(journal, "entered.json")), before.entered);
		assert.deepEqual(await readFile(path.join(journal, "returned.json")), before.returned);
		const calls = (await readFile(path.join(root, "calls.log"), "utf8")).trim().split("\n");
		for (const [call, count] of [["assessor", 1], ["builder", 1], ["evaluator", 1]] as const)
			assert.equal(calls.filter(row => row === call).length, count, call);
		assert.equal(calls.filter(row => row.startsWith("m04:")).length, 1);
		// The loser starts a new process after the winner exits. It must read the
		// one committed state instead of recovering the old evaluator again.
		const retry = child(root, missionId, loser, false);
		await exited(retry, "loser retry");
		const retried = JSON.parse(await readFile(path.join(root, `owner-${loser}.json`), "utf8"));
		assert.equal(retried.boundedRuns.length, 1);
		const afterRetry = await LocalMissionHost.status(missionRoot);
		assert.equal(afterRetry.checkpointReceipts.filter(row => row.version === 4).length, 1);
		assert.equal(afterRetry.checkpointReceipts.filter(row => row.evaluatorRecoveryReview?.intentId ===
			final.latestCheckpoint?.evaluatorRecoveryReview?.intentId).length, 1);
		assert.equal((await readFile(path.join(root, "calls.log"), "utf8")).split("\n")
			.filter(row => row.startsWith("m04:")).length, 1);
	});
}
