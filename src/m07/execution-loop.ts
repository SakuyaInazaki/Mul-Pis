import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import { nowIso, writeFileAtomic } from "../workspace.ts";
import { systemPromptFor } from "../prompts.ts";
import { sessionSpec, type StageContext } from "../stages/context.ts";
import { openBoundedSession } from "../context/boundary.ts";
import { writeProjectionEvent, type ProjectionEventV1 } from "../improvement/observations.ts";
import type { BudgetPolicy } from "../improvement/policy.ts";
import type { SessionHandle } from "../runner/types.ts";
import type { CurrentGoal, M07OperationV1, M07TaskRecord, TaskSpecInput } from "./types.ts";

export interface RoundReview {
	verdict: "ready" | "revise" | "replan" | "blocked";
	feedback: string;
}

/** Repair only literal line breaks/tabs inside a quoted JSON string. Never infer a verdict from prose. */
function escapeLiteralStringControls(input: string): string {
	let quoted = false, escaped = false, output = "";
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (!quoted) { if (char === '"') quoted = true; output += char; continue; }
		if (escaped) { output += char; escaped = false; continue; }
		if (char === "\\") { output += char; escaped = true; continue; }
		if (char === '"') { output += char; quoted = false; continue; }
		if (char === "\r") { output += "\\r"; continue; }
		if (char === "\n") { output += "\\n"; continue; }
		if (char === "\t") { output += "\\t"; continue; }
		output += char;
	}
	return output;
}

export function parseRoundReview(raw: string): RoundReview {
	const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch {
		const recovered = escapeLiteralStringControls(text);
		if (recovered === text) throw new HarnessError("m07.loop-review", "fresh reviewer must return a JSON verdict");
		try { parsed = JSON.parse(recovered); }
		catch { throw new HarnessError("m07.loop-review", "fresh reviewer must return a JSON verdict"); }
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HarnessError("m07.loop-review", "fresh reviewer returned no verdict");
	const result = parsed as Record<string, unknown>;
	if (typeof result.verdict !== "string" || !["ready", "revise", "replan", "blocked"].includes(result.verdict) ||
		typeof result.feedback !== "string" || !result.feedback.trim())
		throw new HarnessError("m07.loop-review", "fresh reviewer verdict must include nonempty feedback");
	return { verdict: result.verdict as RoundReview["verdict"], feedback: result.feedback.trim() };
}

export interface UntilReadyLoopInput {
	ctx: StageContext;
	goal: CurrentGoal;
	task: M07TaskRecord;
	spec: TaskSpecInput;
	policy: BudgetPolicy;
	runId: string;
	taskId: string;
	/** Task directory; the work directory is snapshotted for each reviewer. */
	dir: string;
	workDir: string;
	message: string;
	pack?: string;
	/** Frozen upper bound on rounds; the task returns for replanning at the bound. */
	maxRounds: number;
	deadlineAt?: string;
	handle: SessionHandle;
	operation: M07OperationV1;
	event: ProjectionEventV1;
	branchParent?: M07TaskRecord;
	save(): Promise<void>;
	verifyDispatchKnowledge(): Promise<void>;
	verifyFrozenInputs(): Promise<void>;
	setActiveOperation(operation: M07OperationV1): void;
	markPromptIssued(): void;
	/** The controller's file-bound gate; returns its failure text, if any. */
	validateReadyFiles(reviewerRoot: string): Promise<string | undefined>;
}

/** Copy the builder's work directory for an independent reviewer grant. */
async function snapshotRoundForReviewer(workDir: string, destination: string): Promise<number> {
	let bytes = 0;
	await cp(workDir, destination, { recursive: true, filter: async (source) => {
		const info = await lstat(source);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new HarnessError("m07.loop-snapshot", "round snapshot contains a symlink or special file");
		if (info.isFile()) bytes += info.size;
		return true;
	} });
	return bytes;
}

/** Preserve a long builder report as exact, readable UTF-8 segments in the reviewer's frozen grant. */
async function freezeBuilderReportForReviewer(report: string, reviewerRoot: string): Promise<{ message: string; folder: string }> {
	const reportBytes = Buffer.byteLength(report, "utf8");
	const folder = `.m07-builder-report-${randomUUID()}`;
	const reportDir = path.join(reviewerRoot, folder);
	await mkdir(reportDir);
	const segments: string[] = [];
	let current = "", currentBytes = 0;
	for (const character of report) {
		const size = Buffer.byteLength(character, "utf8");
		if (currentBytes + size > 8_000 && current) { segments.push(current); current = ""; currentBytes = 0; }
		current += character; currentBytes += size;
	}
	if (current) segments.push(current);
	for (const [index, segment] of segments.entries())
		await writeFileAtomic(path.join(reportDir, `part-${String(index + 1).padStart(3, "0")}.md`), segment);
	return { message: `The builder report is ${reportBytes} UTF-8 bytes and was frozen into your read-only snapshot at ${folder}/part-001.md ... part-${String(segments.length).padStart(3, "0")}.md. Read those files in order before judging; a missing part means you have not read the report.`, folder };
}

/** One authorized task, repaired in its own live builder session until a fresh
 * reviewer and the controller's file checks agree, the task needs replanning,
 * or it is blocked. The reviewer never accepts a task: it only ends a round. */
export async function runUntilReadyRounds(input: UntilReadyLoopInput): Promise<void> {
	const transcript: string[] = [];
	input.task.executionRounds = [];
	let nextMessage = input.message;
	for (let index = 1; ; index++) {
		if (!Number.isSafeInteger(index)) throw new HarnessError("m07.loop", "round identity overflow");
		// Hard bounds, checked before a round is issued: a task that keeps revising
		// has to hand control back to the planner instead of running forever.
		if (index > input.maxRounds) { input.task.loopStopReason = "max-rounds"; break; }
		if (input.deadlineAt !== undefined && Date.now() >= Date.parse(input.deadlineAt)) {
			input.task.loopStopReason = "deadline"; break;
		}
		const currentOperation: M07OperationV1 = index === 1 ? input.operation : { version: 1, id: `O${String(input.goal.executionState!.operations.length + 1).padStart(3, "0")}`, taskId: input.taskId, status: "prepared", issuedAt: nowIso() };
		input.setActiveOperation(currentOperation);
		if (index > 1) { input.goal.executionState!.operations.push(currentOperation); await input.save(); }
		await input.verifyDispatchKnowledge();
		if (index === 1) { input.event.deliveryStatus = "submitted"; input.event.providerUsageSessionId = input.handle.ref.id; await writeProjectionEvent(input.ctx.ws, input.event); }
		currentOperation.status = "issued"; await input.save();
		input.markPromptIssued();
		const report = (await input.handle.prompt(nextMessage)).text;
		currentOperation.status = "response-received";
		await input.verifyFrozenInputs();
		if (input.task.experienceSelection) input.task.experienceSelection.loadedAt = nowIso();
		const builderReportPath = path.join(input.dir, `round-${index}-builder.md`);
		await writeFileAtomic(builderReportPath, report);
		const round: NonNullable<M07TaskRecord["executionRounds"]>[number] = { index, operationId: currentOperation.id, builderContext: index === 1 ? input.branchParent ? { mode: "fork", reason: `same task explored from ${input.branchParent.branchSource!.checkpoint.id}` } : { mode: "fresh", reason: "new M07 task" } : { mode: "continue", reason: "same builder repairs the same frozen task in its live session" }, builderReportPath, completedAt: nowIso() };
		input.task.executionRounds.push(round);
		transcript.push(`## Round ${index} builder\n\n${report}`);
		await input.save();
		const reviewerRoot = path.join(input.dir, `round-${index}-snapshot`);
		const reviewerSnapshotBytes = await snapshotRoundForReviewer(input.workDir, reviewerRoot);
		round.reviewerSnapshotBytes = reviewerSnapshotBytes;
		round.reviewerSnapshotPath = reviewerRoot;
		let reviewerPrompt = `Review only this M07 task round and the copied work-directory snapshot. Goal: ${input.goal.goal}\nProblem relation: ${input.goal.problemRelation}\nFrozen goal constraints: ${input.goal.constraints.join("; ")}\nFrozen success criteria: ${input.goal.successCriteria.join("; ")}\nGoal plan at task creation: ${input.goal.plan}\nTask objective: ${input.spec.objective}\nChecks: ${input.spec.checks.join("; ")}\nExpected outputs: ${input.spec.expectedOutputs.join("; ")}\nFrozen plan input: ${input.task.planCopy ? path.relative(input.workDir, input.task.planCopy) : "none"}\n${input.pack ? `The builder's frozen knowledge and selected experience follow. Check relevant records' scope, availability and limits; selection and loading do not establish scientific truth or task success.\n\n${input.pack}\n\n` : ""}The builder report follows. Inspect the copied files only as needed. Before asserting that a field or block is absent, inspect the exact file and its complete relevant field or object range; if that cannot be done, report the gap as unverified. Reply with only JSON {"verdict":"ready|revise|replan|blocked","feedback":"specific evidence-grounded reason"}, without extra prose or code fences. Escape paragraph breaks inside the feedback JSON string as \\n, never raw line breaks inside quotes. Identify decisive checked files, measurements, failures and limitations. For operator optimization, distinguish compilation, interface and numerical correctness from performance or score feedback; compare performance only among candidates actually passing this task's correctness checks under a comparable measurement basis, then assess the choice against the frozen original input.goal. Ground diagnosis in observed measurements; do not require a particular profiler or metric. The goal plan, task objective and builder hypotheses are proposals to evaluate under the frozen goal, user constraints and success criteria; do not promote them into independent user requirements or evidence of impossibility. Verify the substantive task objective as well as its checks against the frozen goal and constraints. Completed actions, saved files or exhausted self-imposed attempts do not satisfy an unmet attainment objective. A local negative result may satisfy an observation task but does not prove the parent goal impossible or exhaust untested routes. Use revise while work remains within this task; replan when the task definition conflicts with frozen obligations, needs a plan change, or claims route exhaustion beyond its evidence; blocked for an evidenced external impediment. ready requires the task objective and checks to be met and still needs the controller's separate final review. Keep the original goal and authorized task scope; use replan for conflicts instead of silently changing obligations.\n\n${report}`;
		reviewerPrompt = `The authorized task deliverable and the parent goal are separate. A documented negative experiment can be ready for a diagnostic or bounded-attempt task when its own objective and checks are met; it does not pass an unmet original goal criterion. Do not demand another submission, evaluation, or new kernel beyond this task's authorization or exhausted external quota. If this task itself required attainment and failed, use replan instead of revise demanding unauthorized work.\n\n${reviewerPrompt}`;
		if (reviewerPrompt.length + systemPromptFor("reviewer").length > input.policy.maxPromptChars) {
			const handoff = await freezeBuilderReportForReviewer(report, reviewerRoot);
			round.builderReportHandoffDir = handoff.folder;
			reviewerPrompt = reviewerPrompt.slice(0, reviewerPrompt.length - report.length) + handoff.message;
		}
		if (reviewerPrompt.length + systemPromptFor("reviewer").length > input.policy.maxPromptChars) throw new HarnessError("context.budget", "reviewer control input exceeds the frozen prompt handoff size");
		const reviewerSpec = sessionSpec(input.ctx, `M07-${input.taskId}-round-${index}-reviewer`, "reviewer", systemPromptFor("reviewer"), { kind: "read-dir", root: reviewerRoot });
		if (input.goal.methodBinding) reviewerSpec.methodBinding = input.goal.methodBinding;
		// The reviewer shares the task's wall-clock horizon so a long review does
		// not run past the deadline the builder was working against.
		if (input.deadlineAt) reviewerSpec.runDeadline = input.deadlineAt;
		const reviewRunRecord = await input.ctx.ws.readRun("M07", input.runId);
		const reviewer = await openBoundedSession(input.ctx.runner, reviewRunRecord, { mode: "fresh", intent: "independent-judgment", reason: `M07 round ${index} reviewer must independently inspect the frozen candidate snapshot`, evidence: [{ version: 1, label: `M07 ${input.taskId} round ${index} snapshot`, path: reviewerRoot, status: "frozen-copy", sourceVersion: `${input.runId}/${input.taskId}/round-${index}` }], spec: reviewerSpec }, () => input.ctx.ws.writeRun(reviewRunRecord));
		round.reviewerSession = reviewer.ref;
		await input.save();
		let rawReview!: string;
		let verdict!: ReturnType<typeof parseRoundReview>;
		try {
			let request = reviewerPrompt;
			for (let attempt = 1; ; attempt++) {
				if (!Number.isSafeInteger(attempt)) throw new HarnessError("m07.loop-review", "reviewer attempt identity overflow");
				await input.verifyDispatchKnowledge();
				rawReview = (await reviewer.prompt(request)).text;
				if (Buffer.byteLength(rawReview, "utf8") > 512_000)
					throw new HarnessError("m07.file-size", "reviewer report file exceeds 512,000 UTF-8 bytes");
				const attemptPath = path.join(input.dir, `round-${index}-reviewer-attempt-${attempt}.md`);
				await writeFileAtomic(attemptPath, rawReview);
				try { verdict = parseRoundReview(rawReview); break; }
				catch (error) {
					if (!(error instanceof HarnessError) || error.code !== "m07.loop-review") throw error;
					transcript.push(`## Round ${index} reviewer attempt ${attempt}\n\nInvalid structured verdict; see ${path.basename(attemptPath)}. ${error.message}`);
					request = `Your preceding response was not a usable structured verdict: ${error.message}. Continue in this SAME independent read-only reviewer session against the SAME frozen round snapshot and unchanged task checks. Inspect the files as needed, then return only strict JSON {"verdict":"ready|revise|replan|blocked","feedback":"specific evidence-grounded reason"}. Do not infer ready from malformed text, change task obligations, or request builder work before a valid verdict.`;
				}
			}
		} finally { input.task.toolLog.push(...reviewer.toolLog().map((entry) => ({ ...entry, reviewerSessionId: reviewer.ref.id }))); reviewer.dispose(); }
		const reviewerReportPath = path.join(input.dir, `round-${index}-reviewer.md`);
		await writeFileAtomic(reviewerReportPath, rawReview);
		round.reviewerReportPath = reviewerReportPath;
		let fileCheckFailure: string | undefined;
		if (verdict.verdict === "ready") {
			fileCheckFailure = await input.validateReadyFiles(reviewerRoot);
			if (fileCheckFailure) verdict = { verdict: "revise" as const,
				feedback: `Reviewer reported ready, but the controller's final-review file checks failed: ${fileCheckFailure}. Repair the same candidate and let a fresh reviewer inspect it.` };
		}
		round.verdict = verdict.verdict; round.feedback = verdict.feedback;
		transcript.push(`## Round ${index} reviewer\n\n${rawReview}${fileCheckFailure ? `\n\nController file-bound check changed this ready verdict to revise: ${fileCheckFailure}` : ""}`);
		await input.save();
		if (verdict.verdict === "ready" || verdict.verdict === "replan" || verdict.verdict === "blocked") { input.task.loopStopReason = verdict.verdict; break; }
		nextMessage = `Continue the same authorized task under the original goal, user constraints and success criteria. The recorded plan and route hypotheses may be revised in light of evidence; they are not additional user requirements. Fresh reviewer feedback from round ${index}: ${verdict.feedback}\nAddress the observed gap within this task, then report concrete changes and verification. Repair an actual implementation or numerical defect; if the evidence instead calls for a different structure or plan outside this task, explain that need and return replan rather than repeating parameter changes. Where the task compares candidates, keep the verified best distinct from the current exploration point; report the hypothesis, exact change, observed feedback, and whether this attempt is retained, rejected, or still uncertain. Do not repeat a rejected candidate without new evidence. Do not expand scope or silently restart an external action whose outcome is unknown.`;
	}
	const reportPath = path.join(input.dir, "report.md");
	const renderReport = () => `# M07 execution\n\nStop: ${input.task.loopStopReason ?? "incomplete"}\n\n${transcript.join("\n\n")}\n`;
	await writeFileAtomic(reportPath, renderReport());
	input.task.reportPath = reportPath; input.task.status = "returned";
}
