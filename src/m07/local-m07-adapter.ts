import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { latestFormalBaseline } from "./controller.ts";
import type { LocalObjectiveAdapter } from "./local-original-objective.ts";
import type { CurrentGoal } from "./types.ts";
import { HarnessError } from "../types.ts";
import { evaluateLocalM07Task, verifyLocalEvaluatorReceipt } from "./local-evaluator-run.ts";
import { verifyDefaultM04Evidence } from "./local-selection-review.ts";

export const LOCAL_M07_REASON_SCOPE = "local-m07-reason";
export const LOCAL_M07_EXECUTE_SCOPE = "local-m07-execute";
/** Strict persisted marker for post-crash mission-to-M07 run census. */
export const LOCAL_M07_MISSION_BINDING_PREFIX = "Local original objective mission: ";

function fail(reason: string): never {
	throw new HarnessError("m07.local-adapter", reason);
}
function unresolvedRefs(goal: CurrentGoal, taskId: string): string[] {
	const operations = goal.executionState?.operations.filter(item =>
		["prepared", "issued", "unknown"].includes(item.status))
		.map(item => `${goal.runId}/${item.id}`) ?? [];
	return [...new Set([`${goal.runId}/${taskId}`, ...operations])];
}

/** One stateless, built-in local step. Model reports become frozen evidence;
 * only the ordinary M07/M04 review paths can give them scientific authority. */
export function createLocalM07Adapter(mode: "reason" | "execute" = "reason"): LocalObjectiveAdapter {
	const scope = mode === "execute" ? LOCAL_M07_EXECUTE_SCOPE : LOCAL_M07_REASON_SCOPE;
	return { scope, async advance(input) {
		const { ctx, controller, contract, frozen, task } = input;
		// A capability snapshot alone cannot opt the current workspace into native
		// task-root read/write/edit/bash tools. Bash is not an OS sandbox.
		if (mode === "execute" && ctx.config.localMission?.execution !== "task-root-bash")
			fail("local execute requires current workspace task-root-bash opt-in");
		if (task.adapterScope !== scope ||
			!frozen.capabilities.some(item => item.scope === scope && item.available) ||
			!Array.isArray(frozen.unresolvedOperationIds) || frozen.unresolvedOperationIds.length)
			fail("fresh work requires the trusted local capability and reconciled operations");
		if (!Array.isArray(task.addresses) || task.addresses.length === 0 ||
			new Set(task.addresses).size !== task.addresses.length ||
			task.addresses.some(id => !contract.obligations.some(item => item.id === id)))
			fail("next task must address named original obligations");
		const addressed = contract.obligations.filter(item => task.addresses.includes(item.id))
			.map(item => item.description);
		if (new Set(addressed).size !== addressed.length)
			fail("distinct original obligations have indistinguishable check text");
		const beforeProblem = await ctx.ws.readProblem();
		const beforeRaw = await ctx.ws.readRawInfo();
		const workspaceRoot = await realpath(ctx.ws.root);
		const insideWorkspace = (file: string): boolean => {
			const relative = path.relative(workspaceRoot, file);
			return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		};
		if (!Array.isArray(frozen.evidence) || !frozen.evidence.length ||
			frozen.evidence.some(item => !item || typeof item.file !== "string"))
			fail("host-frozen task evidence is absent");
		const evidenceFiles = await Promise.all(frozen.evidence.map(async item => realpath(item.file)));
		if (evidenceFiles.some(file => !insideWorkspace(file)))
			fail("host-frozen task evidence escaped the workspace");
		const baseline = await latestFormalBaseline(ctx);
		const goal = await controller.begin({ goal: task.objective,
			problemRelation: `${LOCAL_M07_MISSION_BINDING_PREFIX}${contract.id}\n${contract.goal}`,
			constraints: contract.obligations.map(item => item.description),
			successCriteria: addressed, plan: task.objective,
			exploratory: baseline === undefined });
		if (await readFile(goal.problemSnapshotPath, "utf8") !== beforeProblem.content)
			fail("original problem changed before M07 froze it");
		if (mode === "execute" && ctx.config.localMission?.execution !== "task-root-bash")
			fail("local execute requires current workspace task-root-bash opt-in");
		const report = await controller.delegate(goal.runId, {
			objective: mode === "execute" ? `${task.objective}\n\nSave tangible result files in the deliverable/ directory. The report is evidence only; it does not establish that the original checks passed.` : task.objective,
			mode, inputs: [...new Set([goal.problemSnapshotPath,
				...beforeRaw.items.map(item => item.path), ...evidenceFiles])],
			expectedOutputs: mode === "execute" ? ["deliverable"] : [], checks: addressed });
		for (const expected of [{ source: goal.problemSnapshotPath, content: beforeProblem.content },
			...beforeRaw.items.map(item => ({ source: item.path, content: item.content }))]) {
			const source = await realpath(expected.source);
			const copy = report.inputCopies.find(item => item.source === source);
			if (!copy || await readFile(copy.copy, "utf8") !== expected.content)
				fail("M07 task did not receive the frozen workspace materials");
		}
		const observed = await controller.status(goal.runId);
		if (report.status !== "returned" || !report.reportPath ||
			observed.executionState?.operations.some(item =>
				["prepared", "issued", "unknown"].includes(item.status))) {
			await controller.checkpoint(goal.runId, { taskIds: [report.taskId] });
			return { runId: goal.runId, outcome: "unknown", acceptedTaskIds: [],
				unresolvedOperationRefs: unresolvedRefs(observed, report.taskId) };
		}
		const evaluatorId = ctx.config.localMission?.evaluatorId;
		const evaluated = evaluatorId ? await evaluateLocalM07Task({ contract, goal: observed,
			task: report, evidence: frozen.evidence, evaluatorId,
			frozenOriginalInputs: frozen.frozenOriginalInputs ?? [],
			capabilities: frozen.capabilities }) : undefined;
		const reviewed = await controller.review(goal.runId, evaluated?.review ?? { taskId: report.taskId,
			artifacts: [report.reportPath],
			checks: addressed.map(criterion => ({ criterion, result: "not_run", evidence: [] })) });
		if (evaluated) await verifyLocalEvaluatorReceipt(evaluated.receipt, contract,
			await controller.status(goal.runId), report);
		const checkpoint = await controller.checkpoint(goal.runId, { taskIds: [report.taskId] });
		const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8")) as
			{ problemFile?: string; rawFiles?: Array<{ name: string; relativePath: string }>;
				skippedRaw?: string[] };
		if (await readFile(path.join(checkpoint.rootDir, manifest.problemFile ?? ""), "utf8") !==
			beforeProblem.content || !Array.isArray(manifest.rawFiles) ||
			manifest.rawFiles.length !== beforeRaw.items.length ||
			!Array.isArray(manifest.skippedRaw) ||
			JSON.stringify(manifest.skippedRaw) !== JSON.stringify(beforeRaw.skipped))
			fail("M07 checkpoint changed the frozen workspace materials");
		for (let index = 0; index < beforeRaw.items.length; index++) {
			const expected = beforeRaw.items[index];
			const actual = manifest.rawFiles[index];
			if (actual.name !== expected.name ||
				await readFile(path.join(checkpoint.rootDir, actual.relativePath), "utf8") !== expected.content)
				fail("M07 checkpoint changed the frozen workspace materials");
		}
		const passed = Boolean(evaluated && reviewed.status === "accepted" &&
			contract.obligations.filter(item => task.addresses.includes(item.id)).every(item =>
				evaluated.receipt.checks.some(check => check.obligationId === item.id && check.result === "passed")));
		const eligible = passed && !goal.exploratory && goal.formalBaseline;
		const snapshot = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as CurrentGoal;
		const snapTask = snapshot.tasks.find(item => item.taskId === report.taskId);
		const m07Outcome = eligible && snapshot.tasks.some(item => item.taskId !== report.taskId &&
			["rejected", "failed"].includes(item.status)) ? "partial" : eligible ? "fulfilled" : "partial";
		const requiredM07ReadPaths = evaluated ? [...new Set(["goal.json", "manifest.json", "m04-feedback.md",
			...(snapTask?.review?.artifacts ?? []).filter(item => item.mediaType === "text")
				.map(item => path.relative(checkpoint.rootDir, item.path).replaceAll("\\", "/"))])] : undefined;
		const m04 = await input.runM04(ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId,
			checkpointId: checkpoint.id }, freshSession: true,
			...(requiredM07ReadPaths ? { requiredM07ReadPaths } : {}) });
		if (evaluated) {
			const tx = JSON.parse(await readFile(path.join(ctx.ws.runDir("M04", m04.record.runId),
				"m04-transaction.json"), "utf8")) as { state?: string; m04RunId?: string };
			if (tx.m04RunId !== m04.record.runId || !["no-proposal", "merged"].includes(tx.state ?? ""))
				fail("M04 knowledge transaction is unresolved; M07 result cannot be finished");
			if (eligible) {
				await verifyDefaultM04Evidence(ctx, { runId: goal.runId, outcome: "fulfilled",
					acceptedTaskIds: [report.taskId], selectedTaskId: report.taskId,
					checkpointId: checkpoint.id, m04RunId: m04.record.runId,
					requiredM07ReadPaths }, checkpoint.rootDir);
				await controller.plan(goal.runId, goal.plan, { refreshBaseline: true,
					checkpointId: checkpoint.id, m04RunId: m04.record.runId });
			}
			await controller.finish(goal.runId, { outcome: m07Outcome,
				summary: eligible ? "Host evaluator checks and full independent M04 reading are recorded; mission selection remains a separate host decision." :
					"Bounded task remains partial or exploratory; evaluator observations do not grant mission selection.",
				returnPath: "M04", goalChecks: reviewed.review!.checks.map(check => ({ ...check })) });
		}
		return { runId: goal.runId, outcome: m07Outcome,
			acceptedTaskIds: reviewed.status === "accepted" ? [report.taskId] : [],
			...(eligible ? { selectedTaskId: report.taskId } : {}),
			m04RunId: m04.record.runId, checkpointId: checkpoint.id,
			...(evaluated ? { evaluatorReceiptPath: evaluated.receiptFile,
				requiredM07ReadPaths } : {}), unresolvedOperationRefs: [] };
	} };
}

export function createLocalM07Adapters(): LocalObjectiveAdapter[] {
	return [createLocalM07Adapter("reason"), createLocalM07Adapter("execute")];
}
