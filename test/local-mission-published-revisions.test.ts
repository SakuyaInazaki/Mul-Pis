import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

const evaluatorId = "test:published-revision-chain";
const config = { roles: { research: "fake/research", execution: "fake/execution" },
	localMission: { evaluatorId }, concurrency: 1, tools: {} };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const text = await readFile(file, "utf8");
			if (text) events.push({ toolName, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1,
					endLine: text.split("\n").length - Number(text.endsWith("\n")), truncated: false },
				at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

let evaluatorRegistered = false;
function registerEvaluator(): void {
	if (evaluatorRegistered) return;
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			await writeFile(path.join(observationOutputDir, "observation-open.txt"),
				"The original question remains open.\n", { mode: 0o600 });
			return { observations: [{ name: "observation-open.txt", kind: "text" }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: "not_run" as const, evidenceRefs: ["observation-open.txt"],
					limitations: ["No complete original answer"] })),
				limitations: ["The bounded report cannot establish the original answer"] };
		} });
	evaluatorRegistered = true;
}

async function step(root: string, missionId: string): Promise<void> {
	registerEvaluator();
	const ws = new Workspace(root);
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			await appendFile(path.join(root, "calls.log"), "assessor\n");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read grant missing");
			const names = await readdir(spec.tools.root);
			const feedback = names.find(name => /^prior-run-1-feedback-1\.txt$/.test(name));
			const index = names.find(name => /^published-knowledge-G002-.*-index\.json$/.test(name));
			const pack = names.find(name => /^published-knowledge-G002-.*-pack-1\.txt$/.test(name));
			const second = Boolean(feedback);
			if (second) {
				assert(index && pack, "all committed revisions must reach the next assessor");
				const handoff = JSON.parse(await readFile(path.join(spec.tools.root, index), "utf8")) as
					{ records: Array<{ id: string; version: number }> };
				assert.deepEqual(handoff.records.filter(row => row.id === "K001").map(row => row.version), [2, 3]);
				const text = await readFile(path.join(spec.tools.root, pack), "utf8");
				assert(text.includes("K001@2") && text.includes("K001@3"));
				const frozen = await readFile(path.join(spec.tools.root, feedback!));
				const [runId] = await ws.listRuns("M07");
				const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", runId!), "goal.json"), "utf8")) as
					{ checkpoints: Array<{ feedbackPath: string }> };
				assert(frozen.equals(await readFile(goal.checkpoints.at(-1)!.feedbackPath)));
			}
			const issueRefs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
			const refs = [...issueRefs,
				...(second ? [feedback!, index!, pack!].map(sourceId =>
					({ sourceId, startLine: 1, endLine: 1 })) : [])];
			const issue = { id: "original-gap", claim: "The original answer remains unverified",
				status: "open", classification: "explicit-requirement", sourceRefs: issueRefs,
				implication: "A bounded reason task can identify another gap" };
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "The original criterion remains open after a bounded report.",
				evidenceRefs: refs.map(row => row.sourceId), unresolvedObligations: ["answer"],
				unresolvedDetails: [issue.claim], groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: second ? [issue.claim] : [],
					nextTask: { objective: second ? "Inspect a second bounded question" :
						"Inspect the first bounded question", obligationIds: ["answer"],
						addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "A distinct report may identify the missing evidence",
						expectedEvidence: "A reviewed bounded report", sourceRefs: refs } } }),
				readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) {
			await appendFile(path.join(root, "calls.log"), "task\n");
			return "Synthetic bounded report; no original answer is selected.";
		}
		if (spec.label === "M04-research") {
			await appendFile(path.join(root, "calls.log"), "m04\n");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			return { text: "The bounded result remains unselected and the original question is open.",
				readReturns: await readEvents(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	await openDefaultLocalMission({ workspaceRoot: root, runner, config }).step(missionId);
}

async function seed(root: string): Promise<void> {
	registerEvaluator();
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "Original synthetic question remains open.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const first = await store.submitProposal({ stage: "M04", runId: "synthetic-first-merge",
		ops: [{ op: "create", type: "K", title: "Bounded method", body: "Initial local method.",
			usageDecision: "candidate" }] });
	assert.equal(first.proposalId, "P0001");
	assert.equal((await store.merge(first.proposalId)).snapshot.id, "G001");
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: new FakeSessionRunner(() => { throw new Error("seed assessor must use the step runner"); }), config });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original synthetic question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Verify the complete answer",
			type: "synthetic-open" }], closure: "open-ended" });
	await writeFile(path.join(root, "mission-id.txt"), `${started.contract.id}\n`);
	await step(root, started.contract.id);
	assert.equal((await ws.listRuns("M07")).length, 1);
	const publishedRun = await ws.startRun("M04", [], "G001");
	const second = await store.submitProposal({ stage: "M04", runId: publishedRun.runId,
		ops: [
			{ op: "revise", id: "K001", title: "Bounded method after failure",
				body: "Keep the failed local result and explicit limits.", reason: "Record the failed bounded result" },
			{ op: "decide", id: "K001", usageDecision: "adopted",
				reason: "Adopt only the bounded method", context: "Synthetic local question" },
		] });
	assert.equal(second.proposalId, "P0002");
	const merged = await store.merge(second.proposalId);
	assert.equal(merged.snapshot.id, "G002");
	await ws.writeOutput(publishedRun, "proposal.json",
		await readFile(path.join(ws.knowledgeDir, "proposals/P0002.json"), "utf8"), "知识提案");
	await ws.writeOutput(publishedRun, "merge.json", `${JSON.stringify(merged)}\n`, "合入结果");
	await ws.writeOutput(publishedRun, "m04-transaction.json", `${JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: publishedRun.runId, state: "merged",
		currentProposalId: second.proposalId, snapshotId: "G002", attempts: [],
		updatedAt: new Date().toISOString() })}\n`, "M04 知识事务状态");
	await ws.finishRun(publishedRun, "completed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
	process.argv[2]) {
	const root = process.argv[3]!;
	if (process.argv[2] === "seed") await seed(root);
	else await step(root, (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim());
} else {
	test("default next assessment reads rejected feedback and every P0002 revision after a no-issued retry", async t => {
		const root = await mkdtemp(path.join(os.tmpdir(), "mission-published-revisions-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const runChild = (mode: string) => spawnSync(process.execPath,
			[import.meta.filename, mode, root], { encoding: "utf8", timeout: 60_000 });
		const seeded = runChild("seed");
		assert.equal(seeded.status, 0, seeded.stderr);
		const ws = new Workspace(root);
		const missionId = (await readFile(path.join(root, "mission-id.txt"), "utf8")).trim();
		const missionRoot = path.join(ws.agentDir, "missions", missionId);
		const initialStatus = await LocalMissionHost.status(missionRoot);
		const checkpoint = await LocalMissionHost.readLatestCheckpoint(missionRoot);
		assert(checkpoint);
		const calls = await readFile(path.join(root, "calls.log"));
		const intentFile = path.join(ws.knowledgeDir, "proposals/P0002.intent.json");
		const recordFile = path.join(ws.knowledgeDir, "records/K001/v2.md");
		const intentBytes = await readFile(intentFile), recordBytes = await readFile(recordFile);
		const intent = JSON.parse(intentBytes.toString("utf8")) as
			{ records: Array<{ id: string; version: number }> };
		const history = intent.records.filter(row => row.id === "K001");
		assert.deepEqual(history.map(row => row.version), [2, 3]);
		for (const defect of ["missing", "reordered", "tampered"] as const) {
			if (defect === "tampered") await writeFile(recordFile,
				recordBytes.toString("utf8").replace("Keep the failed local result", "Hide the failed local result"));
			else {
				const changed = structuredClone(intent);
				if (defect === "missing") changed.records.splice(changed.records.findIndex(row =>
					row.id === "K001" && row.version === 2), 1);
				else {
					const index = changed.records.findIndex(row => row.id === "K001" && row.version === 2);
					[changed.records[index], changed.records[index + 1]] =
						[changed.records[index + 1]!, changed.records[index]!];
				}
				await writeFile(intentFile, `${JSON.stringify(changed)}\n`);
			}
			const rejected = runChild("retry");
			assert.notEqual(rejected.status, 0, defect);
			assert.match(rejected.stderr, /committed knowledge record|published knowledge record/, defect);
			assert((await LocalMissionHost.readLatestCheckpoint(missionRoot))?.equals(checkpoint));
			assert((await readFile(path.join(root, "calls.log"))).equals(calls), defect);
			assert.equal((await ws.listRuns("M07")).length, 1, defect);
			assert.equal((await ws.listRuns("M04")).length, 2, defect);
			await writeFile(intentFile, intentBytes);
			await writeFile(recordFile, recordBytes);
		}
		const resumed = runChild("retry");
		assert.equal(resumed.status, 0, resumed.stderr);
		const finalStatus = await LocalMissionHost.status(missionRoot);
		const progress = await openDefaultLocalMission({ workspaceRoot: root }).status(missionId);
		assert.notEqual(finalStatus.currentAttempt?.attemptId, initialStatus.currentAttempt?.attemptId);
		assert.equal((await ws.listRuns("M07")).length, 2, "the prior task was not replayed");
		assert.equal(progress.assessmentHistory.length, 2);
		assert.equal((await ws.listRuns("M04")).length, 3, "the prior M04 was not replayed");
		assert.equal((await readFile(path.join(root, "calls.log"), "utf8")),
			"assessor\ntask\nm04\nassessor\ntask\nm04\n");
		const evidence = path.join(missionRoot, "evidence");
		const names = await readdir(evidence);
		const index = names.find(name => /^published-knowledge-G002-.*-index\.json$/.test(name));
		const pack = names.find(name => /^published-knowledge-G002-.*-pack-1\.txt$/.test(name));
		assert(index && pack);
		const handoff = JSON.parse(await readFile(path.join(evidence, index), "utf8")) as
			{ records: Array<{ id: string; version: number; sha256: string }> };
		assert.deepEqual(handoff.records.filter(row => row.id === "K001").map(row => row.version), [2, 3]);
		assert.equal(handoff.records.find(row => row.id === "K001" && row.version === 2)?.sha256,
			sha(recordBytes));
		assert(checkpoint && !(await LocalMissionHost.readLatestCheckpoint(missionRoot))?.equals(checkpoint));
	});
}
