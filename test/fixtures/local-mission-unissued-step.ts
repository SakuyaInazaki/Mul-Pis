import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";
import { LocalMissionHost } from "../../src/runner/local-mission-host.ts";
import type { ReadReturnEvent } from "../../src/runner/types.ts";
import { runInit } from "../../src/stages/init.ts";
import { HarnessError } from "../../src/types.ts";
import { Workspace } from "../../src/workspace.ts";

export const config = { roles: { research: "fake/research", execution: "fake/execution" },
	localMission: { evaluatorId: "test:unissued-assessment" }, concurrency: 1, tools: {} };
async function readEvents(root: string, tool: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const text = await readFile(file, "utf8");
			if (text) events.push({ toolName: tool, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1,
					endLine: text.split("\n").length - Number(text.endsWith("\n")), truncated: false },
				at: new Date().toISOString() });
		}
	}
	await visit(root); return events;
}
let evaluatorRegistered = false;
function registerEvaluator(): void {
	if (evaluatorRegistered) return;
	registerTrustedLocalMissionEvaluator({ id: config.localMission.evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-unissued"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			await writeFile(path.join(observationOutputDir, "observation-open.txt"), "Original claim stays open\n", { mode: 0o600 });
			return { observations: [{ name: "observation-open.txt", kind: "text" }],
				checks: contract.obligations.map(row => ({ obligationId: row.id,
					result: "not_run" as const, evidenceRefs: ["observation-open.txt"], limitations: ["Unselected candidate"] })),
				limitations: ["Synthetic original claim remains open"] };
		} });
	evaluatorRegistered = true;
}
export async function seedUnissued(root: string, declaredMaterials = false): Promise<string> {
	registerEvaluator();
	const ws = new Workspace(root); await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "The synthetic original claim remains open.\n");
	await writeFile(path.join(ws.rawDir, "observation.txt"), "Original synthetic observation\n");
	const selected = path.join(root, "declared-material.txt");
	if (declaredMaterials) await writeFile(selected, "Authenticated declared material\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const old = await ws.startRun("M04", []);
	old.failures.push("A previous independent judgment failed; no candidate was selected.");
	await ws.writeOutput(old, "m04-transaction.json", JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: old.runId, state: "no-proposal",
		attempts: [], updatedAt: new Date().toISOString() }), "M04 知识事务状态");
	await ws.finishRun(old, "failed");
	let rejectBaseline = false, missionId = "";
	const originalList = Workspace.prototype.listRuns;
	Workspace.prototype.listRuns = async function(stage) {
		if (stage === "M04" && rejectBaseline)
			throw new HarnessError("m07.baseline", "Synthetic frozen resolver rejected the failed latest M04 before M07 begin");
		return originalList.call(this, stage);
	};
	try {
		const runner = new FakeSessionRunner(async ({ spec }) => {
			if (!spec.label.startsWith("local-original-objective-")) throw new Error("No task should be issued during the failed preflight");
			await appendFile(path.join(root, "calls.log"), "assessor\n");
			if (spec.tools.kind !== "read-dir") throw new Error("Missing assessor read grant");
			const readReturns = await readEvents(spec.tools.root, "objective_evidence_read");
			rejectBaseline = true;
			const sourceRefs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "A bounded task can investigate the unchanged original evidence.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["claim"],
				unresolvedDetails: ["The original claim is unverified"], groundedAssessment: {
					version: 1, kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", legacyOpenDetails: [], issues: [{ id: "claim-gap",
						claim: "The original claim is unverified", status: "open", classification: "explicit-requirement",
						sourceRefs, implication: "A bounded evidence task can change the decision" }],
					nextTask: { objective: "Investigate the retained original evidence", obligationIds: ["claim"],
						addresses: ["claim-gap"], adapterScope: "local-m07-reason", sourceRefs,
						decisionChangingHypothesis: "The supplied evidence may identify the missing check",
						expectedEvidence: "An independent report of the original gap" } } }), readReturns };
		});
		const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
		const initial = await mission.begin({ version: 1, kind: "local-original-objective-request",
			goal: "Resolve the complete synthetic claim", goalSource: "verbatim-private-input",
			obligations: [{ id: "claim", description: "Verify the original claim", type: "synthetic-unissued" }],
			closure: "open-ended", ...(declaredMaterials ? { materials: [{ kind: "declared-file" as const,
				label: "Declared original evidence", path: selected, role: "original" as const,
				providedScope: "complete" }] } : {}) });
		missionId = initial.contract.id;
		await mission.step(missionId).then(() => { throw new Error("Expected frozen baseline failure"); }, error => {
			if (!(error instanceof HarnessError) || error.code !== "m07.baseline") throw error;
		});
		await writeFile(path.join(root, "mission-id.txt"), missionId);
		return missionId;
	} finally { Workspace.prototype.listRuns = originalList; }
}
export async function retryUnissued(root: string, missionId: string) {
	registerEvaluator();
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			await appendFile(path.join(root, "calls.log"), "unexpected-assessor\n");
			throw new Error("A saved admitted assessment must never be prompted again");
		}
		if (spec.label.startsWith("M07-")) {
			await appendFile(path.join(root, "calls.log"), "task\n");
			return "The retained bounded task leaves the original claim unverified.";
		}
		if (spec.label === "M04-research") {
			await appendFile(path.join(root, "calls.log"), "m04\n");
			if (spec.tools.kind !== "read-dir") throw new Error("Missing new M04 evidence grant");
			return { text: "Independent fresh M04 judgment; the candidate remains unselected and no proposal is made.",
				readReturns: await readEvents(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`Unexpected synthetic session ${spec.label}`);
	});
	return openDefaultLocalMission({ workspaceRoot: root, runner, config }).step(missionId);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [mode, root] = process.argv.slice(2);
	if (!root) throw new Error("Missing synthetic root");
	if (mode === "seed") process.stdout.write(`${await seedUnissued(root)}\n`);
	else {
		const id = await readFile(path.join(root, "mission-id.txt"), "utf8");
		if (mode === "kill-after-reowner") {
			const originalRecord = LocalMissionHost.prototype.recordCheckpoint;
			LocalMissionHost.prototype.recordCheckpoint = async function(input) {
				const result = await originalRecord.call(this, input);
				await writeFile(path.join(root, "reowned-checkpoint.txt"), String(result.sequence));
				process.kill(process.pid, "SIGKILL");
				return result;
			};
		}
		process.stdout.write(`${JSON.stringify(await retryUnissued(root, id))}\n`);
	}
}
