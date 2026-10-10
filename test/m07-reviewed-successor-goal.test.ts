import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

test("reviewed reject-both goal stays partial while a linked fresh goal repairs and fulfills", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-reviewed-successor-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Find a checked synthetic candidate without adopting failed attempts.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	let executionPrompts = 0;
	const outputs = ["old parent fails", "old fork fails", "fresh repair passes"];
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind !== "execution") return `${spec.label} returned`;
		const output = outputs[executionPrompts++];
		assert.ok(output, "synthetic driver must make exactly three execution attempts");
		await writeFile(path.join(spec.tools.root, "candidate.txt"), `${output}\n`);
		return `${spec.label}: ${output}`;
	});
	const ctx: StageContext = { ws, store, runner, config: {
		roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {},
	} };
	const controller = createM07Controller(ctx);
	const successCriterion = "A selected candidate passes the frozen check";
	const taskCheck = "The candidate has independent synthetic verification";
	const taskSpec = { objective: "Produce the checked candidate", inputs: [], expectedOutputs: ["candidate.txt"],
		checks: [taskCheck], mode: "execute" as const };
	// The fake runner supplies candidate bytes; this separate host-owned observation
	// supplies the review verdict. A model/session return alone never passes review.
	const hostVerified = async (workDir: string): Promise<boolean> =>
		(await readFile(path.join(workDir, "candidate.txt"), "utf8")) === "fresh repair passes\n";
	const initial = await controller.begin({ goal: "Choose a verified candidate", problemRelation: "Directly answers the problem",
		constraints: ["Keep the frozen check"], successCriteria: [successCriterion], plan: "Review both branches, then repair if needed" });
	const parent = await controller.delegate(initial.runId, taskSpec);
	assert.equal(parent.status, "returned", parent.executionFailure ?? "parent failed to return");
	assert.ok(parent.branchSource, parent.branchUnavailableReason ?? "parent lacked frozen checkpoint");
	const forkContext = { mode: "fork" as const, parentRunId: initial.runId, parentTaskId: parent.taskId,
		checkpointId: parent.branchSource!.checkpoint.id };
	const fork = await controller.delegate(initial.runId, { ...taskSpec, context: forkContext });
	assert.equal(fork.status, "returned", fork.executionFailure ?? "fork failed to return");
	assert.ok(fork.session?.lineageFile, "the old candidate really is a frozen-history fork");
	const initialRun = await ws.readRun("M07", initial.runId);
	assert.deepEqual(initialRun.sessions.map(session => session.boundary?.mode), ["fresh", "fork"]);
	for (const attempt of [parent, fork]) {
		assert.equal(await hostVerified(attempt.workDir), false);
		const reviewed = await controller.review(initial.runId, { taskId: attempt.taskId,
			checks: [{ criterion: taskCheck, result: "failed", evidence: [] }],
			artifacts: [path.join(attempt.workDir, "candidate.txt")],
			failures: ["Synthetic checker rejected this candidate"] });
		assert.equal(reviewed.status, "rejected");
		assert.deepEqual(reviewed.review?.checks.map(check => check.result), ["failed"]);
	}
	await assert.rejects(controller.selectBranch(initial.runId, { parentTaskId: parent.taskId,
		selectedTaskId: fork.taskId, rationale: "Do not adopt an unaccepted branch" }), /reviewed and accepted/);
	const noWinner = await controller.selectBranch(initial.runId, { parentTaskId: parent.taskId,
		rationale: "Both ordinary M07 reviews rejected the candidates" });
	assert.equal(noWinner.branchSelections?.[0]?.selectedTaskId, undefined);
	await assert.rejects(controller.finish(initial.runId, { outcome: "fulfilled", summary: "Cannot adopt either attempt",
		returnPath: "user", goalChecks: [{ criterion: successCriterion, result: "passed",
			evidence: [path.join(fork.workDir, "candidate.txt")] }] }), /目标验收证据不来自已接受任务/);
	const partial = await controller.finish(initial.runId, { outcome: "partial", summary: "Both reviewed candidates failed",
		returnPath: "user", goalChecks: [{ criterion: successCriterion, result: "not_run", evidence: [] }] });
	assert.equal(partial.outcome, "partial");
	assert.deepEqual(partial.tasks.map(task => task.status), ["rejected", "rejected"]);
	assert.equal(partial.branchSelections?.[0]?.selectedTaskId, undefined);
	assert.ok(partial.feedbackPath);
	assert.match(await readFile(partial.feedbackPath!, "utf8"), /Synthetic checker rejected this candidate/);
	const originalGoalPath = path.join(ws.runDir("M07", initial.runId), "goal.json");
	const originalGoalBytes = await readFile(originalGoalPath, "utf8");

	const feedbackFile = path.join(root, "review-repair.json");
	await writeFile(feedbackFile, `${JSON.stringify({ version: 1, kind: "m07-rejected-review-feedback",
		predecessorGoalRunId: initial.runId, taskIds: [parent.taskId, fork.taskId],
		checks: partial.tasks.map(task => task.review?.checks.map(check => ({ criterion: check.criterion,
			result: check.result }))), interpretation: "Development evidence only; no prior candidate adopted" })}\n`);
	const fresh = await controller.begin({ goal: partial.goal,
		problemRelation: `Linked fresh repair of rejected goal ${initial.runId}; ${partial.problemRelation}`,
		constraints: partial.constraints, successCriteria: partial.successCriteria,
		plan: `${partial.plan}\nRead the rejected ordinary reviews and failed candidate files as untrusted development evidence; satisfy the same frozen checks.`,
		exploratory: true });
	assert.notEqual(fresh.runId, initial.runId);
	assert.match(fresh.problemRelation, new RegExp(initial.runId));
	assert.deepEqual(fresh.successCriteria, initial.successCriteria);
	assert.deepEqual(fresh.constraints, initial.constraints);
	assert.deepEqual(fresh.tasks, [], "rejected tasks remain in the original goal");
	assert.equal(await readFile(originalGoalPath, "utf8"), originalGoalBytes);
	const repairSpec = { ...taskSpec, inputs: [feedbackFile, path.join(parent.workDir, "candidate.txt"),
		path.join(fork.workDir, "candidate.txt")] };
	const repair = await controller.delegate(fresh.runId, repairSpec);
	assert.equal(repair.status, "returned", repair.executionFailure ?? "repair failed to return");
	assert.deepEqual(repair.inputCopies.map(copy => copy.source), repairSpec.inputs);
	assert.equal(await readFile(repair.inputCopies[0].copy, "utf8"), await readFile(feedbackFile, "utf8"));
	assert.equal(await readFile(repair.inputCopies[1].copy, "utf8"), "old parent fails\n");
	assert.equal(await readFile(repair.inputCopies[2].copy, "utf8"), "old fork fails\n");
	assert.equal(await hostVerified(repair.workDir), true);
	const accepted = await controller.review(fresh.runId, { taskId: repair.taskId,
		checks: [{ criterion: taskCheck, result: "passed", evidence: [path.join(repair.workDir, "candidate.txt")] }],
		artifacts: [path.join(repair.workDir, "candidate.txt")] });
	assert.equal(accepted.status, "accepted", JSON.stringify(accepted.review));
	const finished = await controller.finish(fresh.runId, { outcome: "fulfilled",
		summary: "Reviewed fresh repair satisfies the inherited goal", returnPath: "user",
		goalChecks: [{ criterion: successCriterion, result: "passed",
			evidence: [accepted.review!.frozenReportPath] }] });
	assert.equal(finished.outcome, "fulfilled");
	assert.deepEqual(finished.tasks.map(task => task.status), ["accepted"]);
	assert.equal(finished.branchSelections?.length ?? 0, 0);
	assert.equal(await readFile(originalGoalPath, "utf8"), originalGoalBytes,
		"finishing the successor must not rewrite the partial rejected history");
	assert.equal((await controller.status(initial.runId)).outcome, "partial");
	assert.equal(executionPrompts, 3, "fresh repair must not replay the old sessions");
	const freshRun = await ws.readRun("M07", fresh.runId);
	assert.deepEqual(freshRun.sessions.map(session => session.boundary?.mode), ["fresh"]);
});

test("no-fork rejected parent can feed a linked accepted goal eligible for M04", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-no-fork-successor-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Find a host-checked repair of the rejected parent.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	let prompts = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind !== "execution") return `${spec.label} returned`;
		const output = ["rejected parent", "host-verified repair"][prompts++];
		assert.ok(output, "no-fork repair must make only two execution attempts");
		await writeFile(path.join(spec.tools.root, "candidate.txt"), `${output}\n`);
		return `${spec.label}: ${output}`;
	});
	const ctx: StageContext = { ws, store, runner, config: {
		roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {},
	} };
	const controller = createM07Controller(ctx);
	const criterion = "A reviewed candidate passes the host check";
	const check = "Candidate bytes match the host-owned expected result";
	const spec = { objective: "Produce checked candidate", inputs: [], expectedOutputs: ["candidate.txt"],
		checks: [check], mode: "execute" as const };
	const hostVerified = async (workDir: string): Promise<boolean> =>
		(await readFile(path.join(workDir, "candidate.txt"), "utf8")) === "host-verified repair\n";
	const original = await controller.begin({ goal: "Select a checked candidate", problemRelation: "Answer the frozen problem",
		constraints: ["Use the same criterion"], successCriteria: [criterion], plan: "Review parent, then repair if rejected" });
	const parent = await controller.delegate(original.runId, spec);
	assert.equal(parent.status, "returned", parent.executionFailure ?? "parent did not return");
	assert.equal(await hostVerified(parent.workDir), false);
	const rejected = await controller.review(original.runId, { taskId: parent.taskId,
		checks: [{ criterion: check, result: "failed", evidence: [] }],
		artifacts: [path.join(parent.workDir, "candidate.txt")], failures: ["Host check rejected parent bytes"] });
	assert.equal(rejected.status, "rejected");
	assert.equal((await ws.readRun("M07", original.runId)).sessions.length, 1,
		"no fork was dispatched for the rejected parent");
	const partial = await controller.finish(original.runId, { outcome: "partial",
		summary: "No accepted parent candidate", returnPath: "user",
		goalChecks: [{ criterion, result: "not_run", evidence: [] }] });
	assert.equal(partial.outcome, "partial");
	assert.deepEqual(partial.tasks.map(task => task.status), ["rejected"]);
	assert.equal(partial.branchSelections?.length ?? 0, 0);
	assert.equal(offlineChecks.selectedGoalBranchSatisfied(original.runId, original.runId, false), false,
		"a rejected original run without a true fork cannot pass the original branch gate");
	const originalGoalPath = path.join(ws.runDir("M07", original.runId), "goal.json");
	const originalGoalBytes = await readFile(originalGoalPath, "utf8");

	const feedbackFile = path.join(root, "rejected-review-feedback.json");
	await writeFile(feedbackFile, `${JSON.stringify({ version: 1, kind: "m07-rejected-review-feedback",
		goalRunId: original.runId, taskId: rejected.taskId,
		checks: rejected.review!.checks.map(item => ({ criterion: item.criterion, result: item.result })),
		failures: rejected.review!.failures, interpretation: "Untrusted failed development evidence" })}\n`);
	const successor = await controller.begin({ goal: partial.goal,
		problemRelation: `Linked fresh repair of rejected goal ${original.runId}; ${partial.problemRelation}`,
		constraints: [...partial.constraints], successCriteria: [...partial.successCriteria],
		plan: `${partial.plan}\nRead the exact rejected review as untrusted evidence; retain every check.`,
		exploratory: true });
	assert.notEqual(successor.runId, original.runId);
	assert.deepEqual(successor.successCriteria, original.successCriteria);
	assert.deepEqual(successor.constraints, original.constraints);
	assert.equal(await readFile(originalGoalPath, "utf8"), originalGoalBytes);
	const repair = await controller.delegate(successor.runId, { ...spec,
		inputs: [feedbackFile, path.join(parent.workDir, "candidate.txt")] });
	assert.equal(repair.status, "returned", repair.executionFailure ?? "repair did not return");
	assert.deepEqual(repair.inputCopies.map(copy => copy.source),
		[feedbackFile, path.join(parent.workDir, "candidate.txt")]);
	assert.equal(await readFile(repair.inputCopies[0].copy, "utf8"), await readFile(feedbackFile, "utf8"));
	assert.equal(await readFile(repair.inputCopies[1].copy, "utf8"), "rejected parent\n");
	assert.equal(await hostVerified(repair.workDir), true);
	const accepted = await controller.review(successor.runId, { taskId: repair.taskId,
		checks: [{ criterion: check, result: "passed", evidence: [path.join(repair.workDir, "candidate.txt")] }],
		artifacts: [path.join(repair.workDir, "candidate.txt")] });
	assert.equal(accepted.status, "accepted", JSON.stringify(accepted.review));
	const finished = await controller.finish(successor.runId, { outcome: "fulfilled",
		summary: "Fresh host-verified repair met the inherited criterion", returnPath: "M04",
		goalChecks: [{ criterion, result: "passed", evidence: [accepted.review!.frozenReportPath] }] });
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(offlineChecks.selectedGoalBranchSatisfied(successor.runId, original.runId, false), true);
	assert.equal(offlineChecks.firstM07Accepted(accepted.status === "accepted", finished.outcome), true,
		"the linked accepted goal can supply M04 even though its rejected predecessor had no fork");
	assert.equal(await readFile(originalGoalPath, "utf8"), originalGoalBytes);
	assert.equal((await controller.status(original.runId)).outcome, "partial");
	assert.equal(prompts, 2);
	assert.deepEqual((await ws.readRun("M07", successor.runId)).sessions.map(session => session.boundary?.mode),
		["fresh"]);
});
