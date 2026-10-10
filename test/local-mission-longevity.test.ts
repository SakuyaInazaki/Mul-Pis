import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

async function readEveryFile(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(folder: string): Promise<void> {
		for (const name of await readdir(folder)) {
			const file = path.join(folder, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const content = await readFile(file, "utf8");
			if (!content) continue;
			events.push({ toolName, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1,
					endLine: content.split("\n").length - Number(content.endsWith("\n")),
					truncated: false }, at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

test("default mission.run preserves an open objective through many fresh bounded rounds", async t => {
	const rounds = 8; // Fixture length, never a production admission or stop limit.
	const evaluatorId = "test:mission-longevity-unselected";
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-unknown.txt";
			await writeFile(path.join(observationOutputDir, name), "Synthetic observation does not resolve the original question.\n", { mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Still unknown"] })),
				observations: [{ name, kind: "text" }], limitations: ["Synthetic only"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-longevity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "The original scientific question remains open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let missionId = "", assessorCalls = 0, firstAssessmentAttempts = 0;
	let builderCalls = 0, m04Calls = 0;
	const sourceRefs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
	const issue = { id: "open-question", claim: "The original question remains unresolved",
		status: "open", classification: "explicit-requirement", sourceRefs,
		implication: "A distinct bounded report might supply decision-changing evidence" };
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks read grant");
			const iteration = Number(spec.label.match(/-(\d+)$/)?.[1]);
			if (iteration === 1 && ++firstAssessmentAttempts <= 4)
				return { text: "synthetic malformed assessor reply",
					readReturns: await readEveryFile(spec.tools.root, "objective_evidence_read") };
			if (iteration > rounds)
				throw Object.assign(new Error("synthetic intentional assessor abort after bounded rounds"),
					{ name: "AbortError" });
			const nextTask = {
				objective: `Investigate independent avenue ${iteration}`,
				obligationIds: ["answer"], addresses: [issue.id], adapterScope: "local-m07-reason",
				decisionChangingHypothesis: `Avenue ${iteration} might provide evidence`,
				expectedEvidence: `A reviewed avenue ${iteration} report`, sourceRefs };
			return { text: JSON.stringify({ version: 1,
				decision: "continue",
				rationale: "The original question remains open.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", issues: [issue],
					legacyOpenDetails: iteration === 1 ? [] : [issue.claim], nextTask } }),
				readReturns: await readEveryFile(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) return `Distinct synthetic report ${++builderCalls}`;
		if (spec.label === "M04-research") {
			m04Calls++;
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 lacks read grant");
			return { text: "The bounded result remains unselected.",
				readReturns: await readEveryFile(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId }, concurrency: 1, tools: {} };
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original scientific question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Establish the complete answer",
			type: "synthetic-open" }], closure: "open-ended" });
	missionId = started.contract.id;
	const result = await mission.run(missionId);
	const final = await mission.status(missionId);
	assert.deepEqual(result, final);
	assert.equal(firstAssessmentAttempts, 5,
		"four identical invalid verdicts must not prevent an eventual valid bounded proposal");
	assert.equal(final.assessmentHistory.length, rounds);
	assert.equal(assessorCalls, rounds + 5);
	assert.equal(builderCalls, rounds);
	assert.equal(m04Calls, rounds);
	assert.equal(final.boundedRuns.length, rounds);
	assert.equal(new Set(final.boundedRuns.map(item => item.runId)).size, rounds);
	assert.equal(final.objectiveOutcome, "incomplete");
	assert.equal(final.stopReason, "cancelled",
		"the deliberate abort remains incomplete after the valid bounded rounds");
	assert.deepEqual(final.selectedArtifacts, []);
	assert.deepEqual(final.continuation.unresolvedObligations, ["answer"]);
	assert.deepEqual(await openDefaultLocalMission({ workspaceRoot: root }).status(missionId), final);
});
