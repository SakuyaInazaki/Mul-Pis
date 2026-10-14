/** Fixed parent-side evaluation of real M07→M04 outcomes. No selected source imports this file. */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import type { M04KnowledgeTransactionV1 } from "../stages/m04.ts";
import type { StageRunRecord } from "../types.ts";
import { Workspace } from "../workspace.ts";
import type { WorkflowArmReceiptV1, WorkflowCaseV2, WorkflowOutcomeV2, WorkflowQualityCheckV2 } from "./workflow-types.ts";

type ArmReceipt = WorkflowArmReceiptV1 & { childPid: number };
export interface WorkflowEvaluationContextV2 {
	groundTruth: unknown;
	workspace: Workspace;
	report: string;
	m04: StageRunRecord;
	transaction: M04KnowledgeTransactionV1;
	knowledgeBeforeSnapshot: string | undefined;
	knowledgeAfterSnapshot: string | undefined;
	/** Exact frozen checkpoint files whose full text reached this M04 session. */
	readEvidence: Array<{ input: string; frozenPath: string; text: string }>;
}
/** Injected only in the trusted parent process; cases cannot select executable evaluator code. */
export type WorkflowTrustedEvaluatorV2 = (context: WorkflowEvaluationContextV2) => Promise<WorkflowQualityCheckV2[]>;

async function boundedText(file: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(`evaluation file is absent, indirect or too large: ${file}`);
	return readFile(file, "utf8");
}
function inside(root: string, file: string): boolean { return file.startsWith(`${root}${path.sep}`); }
function output(run: StageRunRecord, root: string, label: string): string {
	const item = run.outputs.find((entry) => entry.label === label);
	if (!item || !inside(root, item.path)) throw new Error(`M04 output ${label} is missing or escapes its run`);
	return item.path;
}
interface ReturnRange { toolName?: string; path?: string; status?: string; returned?: { kind?: string; startLine?: number; endLine?: number; truncated?: boolean } }
function readInFull(relative: string, content: string, message: string, ranges: ReturnRange[]): boolean {
	// A report paraphrase, or even a full quote elsewhere in the prompt, is not an
	// original-evidence read. The inline bytes must occur in this artifact's section.
	const heading = `### ${relative}\n\n`;
	const at = message.indexOf(heading);
	if (content.length > 0 && at >= 0) {
		const start = at + heading.length;
		// The inline artifact can contain its own Markdown headings. Match its
		// bytes at the body start, after the controller's optional inventory line.
		const inventoryEnd = message.startsWith(`- ${relative}；`, start) ? message.indexOf("\n\n", start) : -1;
		const bodyStart = inventoryEnd < 0 ? start : inventoryEnd + 2;
		if (message.startsWith(content, bodyStart)) return true;
	}
	const lines = content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
	if (lines === 0) return ranges.some((event) => event.toolName === "m07_evidence_read" && event.path === relative && event.status === "no-content" && event.returned?.kind === "text" && !event.returned.truncated);
	const spans = ranges.filter((event) => event.toolName === "m07_evidence_read" && event.path === relative && event.status === "returned" && event.returned?.kind === "text" && event.returned.truncated === false &&
		Number.isSafeInteger(event.returned.startLine) && Number.isSafeInteger(event.returned.endLine) && event.returned.startLine! >= 1 && event.returned.endLine! >= event.returned.startLine! && event.returned.endLine! <= lines)
		.map((event) => ({ start: event.returned!.startLine!, end: event.returned!.endLine!, terminal: event.returned!.endLine === lines && event.returned!.truncated === false }))
		.sort((a, b) => a.start - b.start);
	let covered = 0;
	for (const span of spans) if (span.start <= covered + 1) covered = Math.max(covered, span.end);
	return covered >= lines && spans.some((span) => span.terminal);
}
const check = (criterion: string, passed: boolean, evidence: string[], reason: string): WorkflowQualityCheckV2 => ({ criterion, passed, evidence, reason });

export async function evaluateWorkflowOutcomeV2(caseInput: WorkflowCaseV2, receipt: ArmReceipt,
	evaluator: WorkflowTrustedEvaluatorV2, expectedBefore?: string): Promise<WorkflowOutcomeV2> {
	const result: WorkflowOutcomeV2 = { version: 2, caseId: caseInput.visible.id, executionComplete: receipt.status === "complete" && receipt.usage.complete,
		checked: false, quality: [], cost: receipt.usage };
	if (!result.executionComplete || receipt.protocolVersion !== 2 || !receipt.m07RunId || !receipt.m04RunId || !receipt.checkpointId) {
		result.reason = receipt.reason ?? "M07→M04 execution or usage is incomplete";
		return result;
	}
	try {
		const ws = new Workspace(receipt.workspaceRoot);
		const checkpointRoot = path.join(ws.runDir("M07", receipt.m07RunId), "checkpoints", receipt.checkpointId);
		const frozen = JSON.parse(await boundedText(path.join(checkpointRoot, "goal.json"), 256_000)) as {
			tasks?: Array<{ taskId?: string; review?: { artifacts?: Array<{ path: string }> }; reportPath?: string }>;
		};
		if (frozen.tasks?.length !== 1 || !frozen.tasks[0]?.review?.artifacts) throw new Error("checkpoint does not contain exactly the evaluated task and its frozen review");
		const artifacts = frozen.tasks[0].review!.artifacts!;
		const reportPath = frozen.tasks[0].reportPath;
		if (!reportPath || await realpath(reportPath) !== await realpath(receipt.frozenReportPath!)) throw new Error("frozen M07 report identity differs from arm receipt");
		const report = await boundedText(reportPath, 100_000);
		const m04 = await ws.readRun("M04", receipt.m04RunId);
		const liveGoal = JSON.parse(await boundedText(path.join(ws.runDir("M07", receipt.m07RunId), "goal.json"), 256_000)) as {
			checkpoints?: Array<{ id?: string; feedbackStatus?: string }>;
			tasks?: Array<{ reportPath?: string; inputCopies?: Array<{ source: string; copy: string }>;
				review?: { artifacts?: Array<{ sourcePath?: string }> } }>;
		};
		const liveTask = liveGoal.tasks?.[0];
		if (!liveTask?.reportPath || await boundedText(liveTask.reportPath, 100_000) !== report)
			throw new Error("M07 report bytes differ from the frozen checkpoint report");
		const feedbackStatus = liveGoal.checkpoints?.find((item) => item.id === receipt.checkpointId)?.feedbackStatus;
		if (feedbackStatus !== receipt.feedbackStatus || !["complete", "indexed"].includes(String(feedbackStatus))) throw new Error("M07 checkpoint has no complete or indexed evidence handoff");
		const m04Root = ws.runDir("M04", receipt.m04RunId);
		const transactionPath = output(m04, m04Root, "M04 知识事务状态");
		const transaction = JSON.parse(await boundedText(transactionPath, 256_000)) as M04KnowledgeTransactionV1;
		const knowledgeAfter = (await createFileKnowledgeStore(ws.knowledgeDir).current())?.id;
		const settled = m04.status === "completed" && m04.failures.length === 0 && transaction.m04RunId === receipt.m04RunId &&
			["no-proposal", "rejected-draft", "merged"].includes(transaction.state) && knowledgeAfter === receipt.knowledgeAfterSnapshot &&
			receipt.knowledgeBeforeSnapshot === expectedBefore && (transaction.state !== "merged" || transaction.snapshotId === knowledgeAfter);
		result.quality.push(check("M04 transaction and knowledge state settled", settled, [transactionPath, ws.knowledgeDir],
			settled ? "M04 completed and the published knowledge pointer matches the settled transaction" : "M04 or its knowledge transition is incomplete or differs from the frozen baseline"));
		const coverageFile = output(m04, m04Root, "M07 回流证据实际访问范围");
		const coverage = JSON.parse(await boundedText(coverageFile, 128_000)) as { promptOutcome?: string; returnedRanges?: ReturnRange[] };
		const messageFile = output(m04, m04Root, "发送给研究会话的完整消息");
		const message = await boundedText(messageFile, 8 * 1024 * 1024);
		const relativeReport = path.relative(checkpointRoot, reportPath);
		if (coverage.promptOutcome !== "returned" || !readInFull(relativeReport, report, message, coverage.returnedRanges ?? []))
			throw new Error("M04 did not receive the current frozen M07 report bytes");
		const readEvidence: WorkflowEvaluationContextV2["readEvidence"] = [];
		for (const [index, input] of caseInput.visible.requiredEvidence.entries()) {
			const artifact = artifacts[index + 1];
			if (!artifact?.path || !inside(await realpath(checkpointRoot), await realpath(artifact.path))) throw new Error(`required evidence ${input} is absent from frozen review artifacts`);
			const originalPath = await realpath(path.join(ws.root, input));
			const taskCopy = liveTask.inputCopies?.find(item => item.source === originalPath);
			if (!taskCopy || !liveTask.review?.artifacts?.[index + 1]?.sourcePath ||
				await realpath(liveTask.review.artifacts[index + 1]!.sourcePath!) !== await realpath(taskCopy.copy))
				throw new Error(`required evidence ${input} has no exact task-input to frozen-artifact identity`);
			const original = await boundedText(path.join(ws.root, input));
			const copied = await boundedText(taskCopy.copy);
			const frozenText = await boundedText(artifact.path);
			if (original !== copied || original !== frozenText) throw new Error(`required evidence ${input} differs from its frozen source input`);
			const relative = path.relative(checkpointRoot, artifact.path);
			const read = coverage.promptOutcome === "returned" && readInFull(relative, frozenText, message, coverage.returnedRanges ?? []);
			result.quality.push(check(`M04 read required evidence: ${input}`, read, [artifact.path, coverageFile, messageFile],
				read ? "The current M04 session received the full frozen text" : "The current M04 session did not receive the full frozen text"));
			if (read) readEvidence.push({ input, frozenPath: artifact.path, text: frozenText });
		}
		if (!settled || readEvidence.length !== caseInput.visible.requiredEvidence.length) {
			result.reason = "settled M04 and complete current-session source reading are required before semantic G";
			return result;
		}
		const semantic = await evaluator({ groundTruth: caseInput.evaluation.groundTruth, workspace: ws, report, m04, transaction,
			knowledgeBeforeSnapshot: receipt.knowledgeBeforeSnapshot, knowledgeAfterSnapshot: knowledgeAfter, readEvidence });
		if (!Array.isArray(semantic) || semantic.length < 1 || semantic.some((item) => typeof item.criterion !== "string" || !item.criterion ||
			![true, false, null].includes(item.passed) || !Array.isArray(item.evidence) || !item.evidence.every((x) => typeof x === "string") || typeof item.reason !== "string" || !item.reason))
			throw new Error("trusted evaluator returned invalid structured checks");
		result.quality.push(...semantic);
		result.checked = semantic.every((item) => item.passed !== null);
	} catch (error) { result.reason = (error as Error).message; }
	return result;
}
