import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CurrentGoal, M07OperationV1 } from "./types.ts";

export type LocalReconciliationAssessment =
	| { eligible: true; operationId: string; taskId: string; restoredStatus: "response-received"; auditIssue: NonNullable<M07OperationV1["auditIssue"]>; evidencePaths: string[]; reason: string }
	| { eligible: false; operationId: string; reason: string };

export type RemoteReadAvailabilityAssessment =
	| { eligible: true; operationId: string; taskId: string; resultAvailability: "unavailable"; reason: string }
	| { eligible: false; operationId: string; reason: string };

/** Record a lost read result without asserting whether the external read was issued. */
export function assessRemoteReadResultAvailability(goal: CurrentGoal, operationId: string): RemoteReadAvailabilityAssessment {
	const reject = (reason: string): RemoteReadAvailabilityAssessment => ({ eligible: false, operationId, reason });
	const operation = goal.executionState?.operations.find((item) => item.id === operationId);
	if (!operation || operation.status !== "unknown" || operation.sideEffectClass !== "remote-read") return reject("operation is not an unknown remote read");
	const task = goal.tasks.find((item) => item.taskId === operation.taskId);
	if (!task || task.mode !== "execute" || task.sideEffectClass !== "remote-read" || task.status !== "failed" || !task.executionFailure) return reject("remote read does not have a failed execution record");
	if (task.reportPath || task.review) return reject("returned report or review exists; inspect that evidence instead");
	const actions = goal.executionState?.actions?.filter((item) => item.operationId === operationId) ?? [];
	if (actions.some((item) => item.sideEffect === "remote-write")) return reject("remote write action requires independent reconciliation");
	return { eligible: true, operationId, taskId: task.taskId, resultAvailability: "unavailable", reason: "the task failed without a returned report; issuance and scientific result remain undetermined" };
}

/** Inspect durable local evidence only. The caller owns any subsequent state mutation. */
export async function assessLocalOperationReconciliation(goal: CurrentGoal, operationId: string, runDir: string): Promise<LocalReconciliationAssessment> {
	const reject = (reason: string): LocalReconciliationAssessment => ({ eligible: false, operationId, reason });
	const operation = goal.executionState?.operations.find((item) => item.id === operationId);
	if (!operation || operation.status !== "unknown" || operation.sideEffectClass !== "local-only") return reject("operation is not an unknown local-only execution");
	const task = goal.tasks.find((item) => item.taskId === operation.taskId);
	if (!task || task.mode !== "execute" || task.sideEffectClass !== "local-only" || !["accepted", "rejected"].includes(task.status)) return reject("task has no completed local review");
	if (!task.returnedAt || !task.reportPath || !task.review?.frozenReportPath) return reject("task return or frozen review report is missing");
	const actions = goal.executionState?.actions?.filter((item) => item.operationId === operationId) ?? [];
	if (actions.some((item) => item.sideEffect === "remote-write" || item.status === "unknown")) return reject("reported remote action requires independent reconciliation");
	if (actions.length > 0) return reject("reported remote actions require separate review");
	const root = await realpath(runDir).catch(() => undefined);
	if (!root) return reject("run directory cannot be verified");
	const evidencePaths = [task.reportPath, task.review.frozenReportPath];
	for (const candidate of evidencePaths) {
		try {
			const info = await lstat(candidate);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return reject("report evidence is not a bounded regular file");
			const resolved = await realpath(candidate);
			if (!resolved.startsWith(root + path.sep)) return reject("report evidence is outside the run directory");
		} catch { return reject("report evidence is missing or unreadable"); }
	}
	const [report, frozen] = await Promise.all(evidencePaths.map((candidate) => readFile(candidate)));
	if (!report.equals(frozen)) return reject("returned report differs from frozen review report");
	const lines = report.toString("utf8").split(/\r?\n/).filter((line) => line.includes("M07-ACTIONS:"));
	let auditIssue: NonNullable<M07OperationV1["auditIssue"]> = "ledger-missing";
	let reportLedgerValid = false;
	if (lines.length > 0) {
		try {
			const line = lines[lines.length - 1];
			const ledger = JSON.parse(line.slice(line.indexOf("M07-ACTIONS:") + "M07-ACTIONS:".length).trim()) as { version?: unknown; actions?: unknown };
			if (ledger.version !== 1 || !Array.isArray(ledger.actions)) auditIssue = "ledger-invalid";
			else if (ledger.actions.length === 0) { auditIssue = "ledger-empty"; reportLedgerValid = true; }
			else return reject("report declares remote actions; independent reconciliation is required");
		} catch { auditIssue = "ledger-invalid"; }
	}
	// The runner may have written a separate ledger when the report omitted or malformed it.
	if (!task.workDir) return reject("task work directory is missing");
	const workRoot = await realpath(task.workDir).catch(() => undefined);
	if (!workRoot || !workRoot.startsWith(root + path.sep)) return reject("task work directory is outside the run directory");
	const ledgerPath = path.join(task.workDir, "m07-actions.json");
	let ledgerInfo;
	try { ledgerInfo = await lstat(ledgerPath); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return reject("local action ledger cannot be inspected"); }
	if (ledgerInfo) {
		if (!ledgerInfo.isFile() || ledgerInfo.isSymbolicLink() || ledgerInfo.size > 64 * 1024) return reject("local action ledger is not a bounded regular file");
		const resolvedLedger = await realpath(ledgerPath);
		if (!resolvedLedger.startsWith(root + path.sep)) return reject("local action ledger is outside the run directory");
		let ledger: { version?: unknown; actions?: unknown };
		try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")); }
		catch { return reject("local action ledger is invalid"); }
		if (ledger.version !== 1 || !Array.isArray(ledger.actions)) return reject("local action ledger is invalid");
		if (ledger.actions.length > 0) return reject("local action ledger declares remote actions; independent reconciliation is required");
		if (!reportLedgerValid) auditIssue = "ledger-empty";
		evidencePaths.push(ledgerPath);
	}
	return { eligible: true, operationId, taskId: task.taskId, restoredStatus: "response-received", auditIssue, evidencePaths, reason: "a returned local task and matching frozen review report establish receipt; remote effects are not certified" };
}
