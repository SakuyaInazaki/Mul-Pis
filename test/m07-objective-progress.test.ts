import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import test, { type TestContext } from "node:test";
import { assessAndAdvanceOriginalObjective, createOriginalObjective, objectiveProgress, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";

import type { ModelObjectiveAssessmentV1, ObjectiveNextTaskV1 } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent, SessionSpec } from "../src/runner/types.ts";

import { Workspace } from "../src/workspace.ts";

import type { GroundedAssessmentProposal } from "../src/m07/assessor-grounding.ts";


const originalInputs: Record<string, string> = {
	"original-problem.txt": "Original mission allows more than the finite pilot.\n",
	"original-source.cpp": "// Synthetic original source\n",
	"second-text.txt": "Synthetic additional original constraints.\n",
	"candidate.cpp": "// Synthetic accepted pilot candidate\n",
	"verification.json": '{"status":"passed","scope":"finite"}\n',
};
const lines = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);





async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "m07-original-objective-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	const sourceDir = path.join(root, "source");
	await mkdir(sourceDir);
	const evidence = await Promise.all(Object.entries(originalInputs).map(async ([name, body]) => {
		const file = path.join(sourceDir, name);
		await writeFile(file, body);
		return { name, file };
	}));
	const contract = createOriginalObjective({ goal: "Find the strongest attainable answer to the full supplied task",
		goalSource: "user-intent-summary", inputNames: ["source.cpp", "task.txt", "additional.txt"],
		obligations: [{ id: "original-task", description: "Satisfy all original supplied requirements" }],
		closure: "open-ended" });
	const contractFile = path.join(root, "original-objective.json");
	await writeOriginalObjectiveContract(contractFile, contract);
	const runRecord = await ws.startRun("M07Objective", []);
	const sessionSpec: Omit<SessionSpec, "tools"> = { label: "objective-assessor", role: "research", model: "fake/research",
		systemPrompt: "Read frozen evidence and assess the original goal.", persistDir: ws.sessionsDir };
	return { root, ws, contract, contractFile, runRecord, sessionSpec, evidence, evidenceRoot: path.join(root, "assessment-evidence") };
}

function assessment(decision: "continue" | "fulfilled" | "blocked", adapterScope: ObjectiveNextTaskV1["adapterScope"] = "two-target-existing"): ModelObjectiveAssessmentV1 {
	const unresolved = decision === "fulfilled" ? [] : ["original-task"];
	return { version: 1, decision, rationale: "The finite pilot does not settle the original mission.",
		evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: unresolved,
		unresolvedDetails: decision === "fulfilled" ? [] : ["Other permitted directions remain unassessed."],
		...(decision === "continue" ? { nextTask: { objective: "Investigate the remaining original requirements",
			addresses: ["original-task"], adapterScope } } : {}) };
}

function ranges(f: Awaited<ReturnType<typeof fixture>>, omitted: string[] = []): ReadReturnEvent[] {
	const contents = { "original-objective.json": `${JSON.stringify(f.contract, null, 2)}\n`, ...originalInputs };
	return Object.entries(contents).filter(([name]) => !omitted.includes(name)).map(([name, body]) => ({
		toolName: "objective_evidence_read", status: "returned", path: name, requested: {},
		returned: { kind: "text", startLine: 1, endLine: lines(body), truncated: false }, at: new Date().toISOString(),
	}));
}

const groundingKinds = {
	"original-problem.txt": "supplied-task" as const,
	"original-source.cpp": "supplied-task" as const,
	"second-text.txt": "supplied-task" as const,
	"candidate.cpp": "selected-evidence" as const,
	"verification.json": "selected-evidence" as const,
};

function groundedReply(f: Awaited<ReturnType<typeof fixture>>, decision: "continue" | "blocked",
	classification: "explicit-requirement" | "optional-method") {
	const base = assessment(decision);
	const claim = base.unresolvedDetails[0]!;
	const issue = classification === "explicit-requirement" ? {
		id: "strategy-gap", claim, status: "open" as const, classification,
		implication: "The requested strategy still needs support.",
		sourceRefs: [{ sourceId: "current-user-overrides", startLine: 1, endLine: 1 }],
	} : {
		id: "method-limit", claim, status: "open" as const, classification,
		implication: "A suggested method remains unavailable.",
		optionalBasis: "The supplied material presents it as a possible method.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
	};
	const groundedAssessment: GroundedAssessmentProposal = {
		version: 1, kind: "grounded-assessment-proposal", contractId: f.contract.id,
		missionStatus: "open", issues: [issue], legacyOpenDetails: ["Preserved old detail"],
		...(decision === "continue" ? { nextTask: {
			objective: base.nextTask!.objective,
			obligationIds: ["original-task"], addresses: ["strategy-gap"], adapterScope: "two-target-existing",
			decisionChangingHypothesis: "A new comparison could change the strategy recommendation.",
			expectedEvidence: "A correctness result and measured comparison.",
			sourceRefs: [{ sourceId: "current-user-overrides", startLine: 1, endLine: 1 }],
		} } : {}),
		deliverableReady: { status: "proposed", ready: false, rationale: "Evidence remains incomplete.",
			evidenceRefs: [{ sourceId: "verification.json", startLine: 1, endLine: 1 }],
			remainingIssueIds: [issue.id] },
	};
	return { ...base, groundedAssessment };
}

test("grounded live proposal needs full frozen reads before its decision-changing task dispatches", async t => {
	const f = await fixture(t);
	let turns = 0, dispatched = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		turns++;
		if (turns === 1) assert.match(message, /groundedAssessment|Grounded assessment/);
		return { text: JSON.stringify(groundedReply(f, "continue", "explicit-requirement")),
			readReturns: turns === 1 ? ranges(f, ["second-text.txt"]) : ranges(f, ["original-objective.json",
				"original-problem.txt", "original-source.cpp", "candidate.cpp", "verification.json"]) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true, sourceKinds: groundingKinds,
			legacyOpenDetails: ["Preserved old detail"] },
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic runner", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; return "advanced"; } });
	assert.equal(turns, 2);
	assert.equal(dispatched, 1);
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(result.assessment?.groundedAssessment?.missionStatus, "open");
});




test("finite objective closure still requires original checks and complete selected evidence", async t => {
	const f = await fixture(t);
	const finite = createOriginalObjective({ goal: "Satisfy a finite synthetic acceptance target",
		goalSource: "user-intent-summary", inputNames: ["task.txt"],
		obligations: [{ id: "original-task", description: "Pass the exact original acceptance target" }],
		closure: "finite-evidence" });
	const checked = [{ obligationId: "original-task", passed: true,
		evidenceRefs: ["candidate.cpp", "verification.json"] }];
	const accepted = { ...assessment("fulfilled"), sessionId: "fresh-session", model: "fake/research",
		evidenceRead: ["original-objective.json", "candidate.cpp", "verification.json"], unreadEvidence: [] };
	const input = { boundedRuns: [{ runId: f.runRecord.runId, outcome: "fulfilled", selectedTaskId: "T001" }],
		selectedArtifacts: ["candidate.cpp", "verification.json"], assessment: accepted,
		stopReason: "original-checks-unverified" as const, originalChecks: checked };
	assert.equal(objectiveProgress(finite, { ...input, originalChecks: [] }).objectiveOutcome, "incomplete");
	assert.equal(objectiveProgress(finite, { ...input, assessment: { ...accepted,
		unreadEvidence: ["verification.json"], evidenceRead: ["original-objective.json", "candidate.cpp"] } }).objectiveOutcome, "incomplete");
	const fulfilled = objectiveProgress(finite, { ...input, pendingActionFacts: {} });
	assert.equal(fulfilled.objectiveOutcome, "fulfilled");
	assert.equal(fulfilled.continuation.pendingAction, undefined);
});
