/** Structured workflow commands delivered by one trusted terminal-console host. */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCurrentProcessIdentity } from "../runtime/process-identity.ts";
import { parseRunDescriptor, type RunDescriptorV1 } from "../runtime/run-descriptor.ts";
import type { ResearchService, StageRequest } from "./service.ts";
import type { CurrentGoal } from "../m07/types.ts";

export type ConsoleWorkflowAction =
	| { kind: "stage"; request: Omit<StageRequest, "workspace"> }
	| { kind: "status"; runId?: string }
	| { kind: "checkpoint"; runId: string; taskIds?: string[] }
	| { kind: "plan"; runId: string; plan: string; refreshBaseline?: boolean; checkpointId?: string; m04RunId?: string }
	| { kind: "decision"; runId: string; question: string; decision: string; relatedTaskIds?: string[] };

export interface ConsoleWorkflowRequest {
	version: 1;
	requestId: string;
	instanceId: string;
	workspaceId: string;
	workspace: string;
	attemptId: string;
	goalRunId?: string;
	action: ConsoleWorkflowAction;
}

export interface ConsoleWorkflowResponse {
	version: 1;
	requestId: string;
	ok: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

export interface ConsoleWorkflowCancelResponse {
	version: 1;
	requestId: string;
	ok: boolean;
	cancelled: boolean;
	error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set(["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09"]);
const STAGE_KEYS = new Set(["stage", "m01RunId", "m02RunId", "feedbackStage", "feedbackRunId", "feedbackCheckpointId", "feedbackFile", "feedbackLabel", "freshSession", "goal", "noBrowser", "sources", "fullText", "reprocessAll", "requirements", "processFeedback", "materials", "selfChecks", "reviewers", "unprovidedScopes", "previousRunId", "changeSummary", "affectedScope", "m08RunId", "m04RunId", "recipient", "purpose", "deliveryScope", "reproduction", "closureRequested"]);
const STRING_STAGE_KEYS = ["m01RunId", "m02RunId", "feedbackRunId", "feedbackCheckpointId", "feedbackFile", "feedbackLabel", "goal", "requirements", "previousRunId", "changeSummary", "affectedScope", "m08RunId", "m04RunId", "recipient", "purpose"] as const;
const BOOL_STAGE_KEYS = ["freshSession", "noBrowser", "fullText", "reprocessAll", "processFeedback", "closureRequested"] as const;
const STRING_ARRAY_STAGE_KEYS = ["sources", "unprovidedScopes"] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unexpected field: ${key}`);
}

function parseAction(value: unknown): ConsoleWorkflowAction {
	if (!object(value) || !string(value.kind)) throw new Error("invalid workflow action");
	if (value.kind === "stage") {
		fields(value, ["kind", "request"]);
		if (!object(value.request)) throw new Error("stage request missing");
		const request = value.request;
		for (const key of Object.keys(request)) if (!STAGE_KEYS.has(key)) throw new Error(`unexpected stage field: ${key}`);
		if (!STAGES.has(request.stage as string)) throw new Error("invalid workflow stage");
		for (const key of STRING_STAGE_KEYS) if (request[key] !== undefined && typeof request[key] !== "string") throw new Error(`invalid ${key}`);
		for (const key of BOOL_STAGE_KEYS) if (request[key] !== undefined && typeof request[key] !== "boolean") throw new Error(`invalid ${key}`);
		for (const key of STRING_ARRAY_STAGE_KEYS) if (request[key] !== undefined && !stringArray(request[key])) throw new Error(`invalid ${key}`);
		if (request.feedbackStage !== undefined && !["M03", "M06", "M07", "M08"].includes(request.feedbackStage as string)) throw new Error("invalid feedbackStage");
		for (const key of ["materials", "selfChecks", "reviewers"] as const) if (request[key] !== undefined && !Array.isArray(request[key])) throw new Error(`invalid ${key}`);
		if (request.materials !== undefined) for (const item of request.materials as unknown[]) {
			if (!object(item)) throw new Error("invalid material"); fields(item, ["label", "path", "sourceCategory", "providedScope"]);
			if (![item.label, item.path, item.sourceCategory].every(string) || (item.providedScope !== undefined && typeof item.providedScope !== "string")) throw new Error("invalid material");
		}
		if (request.selfChecks !== undefined) for (const item of request.selfChecks as unknown[]) {
			if (!object(item)) throw new Error("invalid selfCheck"); fields(item, ["id", "instruction", "mode"]);
			if (!string(item.id) || !string(item.instruction) || (item.mode !== undefined && !["read-only", "execute"].includes(item.mode as string))) throw new Error("invalid selfCheck");
		}
		if (request.reviewers !== undefined) for (const item of request.reviewers as unknown[]) {
			if (!object(item)) throw new Error("invalid reviewer"); fields(item, ["id", "role", "mode"]);
			if (!string(item.id) || !["execution", "reviewer", "research", "reader", "checker", "applicability", "acquisition"].includes(item.role as string) || (item.mode !== undefined && !["read-only", "execute"].includes(item.mode as string))) throw new Error("invalid reviewer");
		}
		if (request.deliveryScope !== undefined) {
			if (!object(request.deliveryScope)) throw new Error("invalid deliveryScope");
			fields(request.deliveryScope, ["included", "excluded", "limitations"]);
			if (![request.deliveryScope.included, request.deliveryScope.excluded, request.deliveryScope.limitations].every(stringArray)) throw new Error("invalid deliveryScope");
		}
		if (request.reproduction !== undefined) {
			if (!object(request.reproduction)) throw new Error("invalid reproduction");
			fields(request.reproduction, ["mode", "instructions", "authorizedExecution", "pdfPages"]);
			if (!["read-only", "specified-checks", "full-recomputation"].includes(request.reproduction.mode as string) || !stringArray(request.reproduction.instructions) || typeof request.reproduction.authorizedExecution !== "boolean") throw new Error("invalid reproduction");
			if (request.reproduction.pdfPages !== undefined) {
				if (!Array.isArray(request.reproduction.pdfPages)) throw new Error("invalid pdfPages");
				for (const item of request.reproduction.pdfPages) {
					if (!object(item)) throw new Error("invalid pdfPages");
					fields(item, ["path", "pages"]);
					if (!string(item.path) || !Array.isArray(item.pages) || !item.pages.every((n: unknown) => Number.isSafeInteger(n) && (n as number) > 0)) throw new Error("invalid pdfPages");
				}
			}
		}
		return { kind: "stage", request: request as unknown as Omit<StageRequest, "workspace"> };
	}
	if (value.kind === "status") { fields(value, ["kind", "runId"]); if (value.runId !== undefined && !string(value.runId)) throw new Error("invalid runId"); return value as ConsoleWorkflowAction; }
	if (value.kind === "checkpoint") { fields(value, ["kind", "runId", "taskIds"]); if (!string(value.runId) || (value.taskIds !== undefined && !stringArray(value.taskIds))) throw new Error("invalid checkpoint"); return value as ConsoleWorkflowAction; }
	if (value.kind === "plan") { fields(value, ["kind", "runId", "plan", "refreshBaseline", "checkpointId", "m04RunId"]); if (!string(value.runId) || !string(value.plan) || (value.refreshBaseline !== undefined && typeof value.refreshBaseline !== "boolean") || (value.checkpointId !== undefined && !string(value.checkpointId)) || (value.m04RunId !== undefined && !string(value.m04RunId))) throw new Error("invalid plan"); return value as ConsoleWorkflowAction; }
	if (value.kind === "decision") { fields(value, ["kind", "runId", "question", "decision", "relatedTaskIds"]); if (!string(value.runId) || !string(value.question) || !string(value.decision) || (value.relatedTaskIds !== undefined && !stringArray(value.relatedTaskIds))) throw new Error("invalid decision"); return value as ConsoleWorkflowAction; }
	throw new Error("unsupported workflow action");
}

export function parseConsoleWorkflowRequest(value: unknown): ConsoleWorkflowRequest {
	if (!object(value)) throw new Error("invalid workflow request");
	fields(value, ["version", "requestId", "instanceId", "workspaceId", "workspace", "attemptId", "goalRunId", "action"]);
	if (value.version !== 1 || !string(value.requestId) || !UUID.test(value.requestId) || !string(value.instanceId) || !string(value.workspaceId) || !string(value.workspace) || !path.isAbsolute(value.workspace) || !string(value.attemptId) || (value.goalRunId !== undefined && !string(value.goalRunId))) throw new Error("invalid workflow request identity");
	return { ...value, action: parseAction(value.action) } as ConsoleWorkflowRequest;
}

function metadata(value: unknown, kind: ConsoleWorkflowAction["kind"]): Record<string, unknown> {
	if (!object(value)) return { kind };
	const record = object(value.record) ? value.record : object(value.stage) && object(value.stage.record) ? value.stage.record : undefined;
	const result: Record<string, unknown> = { kind };
	if (record) for (const key of ["runId", "stage", "status"] as const) if (typeof record[key] === "string") result[key] = record[key];
	if (kind === "checkpoint") for (const key of ["id", "feedbackStatus", "feedbackPath", "manifestPath"] as const) if (typeof value[key] === "string") result[key] = value[key];
	if (["status", "plan", "decision"].includes(kind)) for (const key of ["runId", "lifecycle", "outcome", "feedbackStatus", "updatedAt"] as const) if (typeof value[key] === "string") result[key] = value[key];
	if (kind === "status") {
		for (const key of ["initialized", "configPresent"] as const) if (typeof value[key] === "boolean") result[key] = value[key];
		for (const key of ["knowledgeSnapshot", "activeLimits"] as const) if (typeof value[key] === "string" || typeof value[key] === "number") result[key] = value[key];
		if (object(value.stages)) {
			const stages: Record<string, unknown> = {};
			for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"]) {
				const item = value.stages[stage];
				if (!object(item)) continue;
				const latest = object(item.latest) ? item.latest : undefined;
				stages[stage] = { count: typeof item.count === "number" ? item.count : 0, ...(latest ? { latest: { ...(typeof latest.runId === "string" ? { runId: latest.runId } : {}), ...(typeof latest.status === "string" ? { status: latest.status } : {}) } } : {}) };
			}
			result.stages = stages;
		}
		if (Array.isArray(value.tasks)) result.taskCount = value.tasks.length;
		if (Array.isArray(value.decisions)) result.openDecisionCount = value.decisions.filter((item: unknown) => object(item) && item.status === "open").length;
		if (object(value.executionState) && string(value.executionState.activeAttemptId)) result.attemptId = value.executionState.activeAttemptId;
	}
	return result;
}

function secureDirectory(dir: string): boolean {
	try { const info = lstatSync(dir); return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(); }
	catch { return false; }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await rename(temp, file);
}

/** Bind a goal created by the current Pi session to its existing console descriptor. */
export async function bindConsoleDescriptorToGoal(goal: CurrentGoal, options: { controlDir?: string; descriptorFile?: string; processIdentity?: typeof readCurrentProcessIdentity; previousGoalRunId?: string } = {}): Promise<void> {
	const controlDir = options.controlDir ?? process.env.MUL_PIS_CONSOLE_CONTROL_DIR;
	const file = options.descriptorFile ?? process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	if (!controlDir || !file) return;
	if (!secureDirectory(controlDir) || path.resolve(path.dirname(file)) !== path.resolve(controlDir)) throw new Error("console descriptor location is invalid");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("console descriptor is untrusted");
	const descriptor = parseRunDescriptor(JSON.parse(await readFile(file, "utf8")));
	const attempt = goal.executionState?.attempts.find((item) => item.id === goal.executionState?.activeAttemptId);
	const target = attempt?.runDescriptor;
	const current = await (options.processIdentity ?? readCurrentProcessIdentity)();
	if (!target || goal.runId !== target.goalRunId || descriptor.controlDir !== controlDir || descriptor.instanceId !== target.instanceId || target.attemptId !== attempt?.id ||
		descriptor.process.hostId !== current.hostId || descriptor.process.bootId !== current.bootId || descriptor.process.pid !== current.pid || descriptor.process.processStartToken !== current.processStartToken ||
		target.process.hostId !== current.hostId || target.process.bootId !== current.bootId || target.process.pid !== current.pid || target.process.processStartToken !== current.processStartToken) throw new Error("new goal does not belong to this console process");
	if (descriptor.goalRunId && descriptor.goalRunId !== goal.runId && descriptor.goalRunId !== options.previousGoalRunId) throw new Error("console descriptor is already bound to another goal");
	const updated: RunDescriptorV1 = { ...descriptor, goalRunId: goal.runId, attemptId: target.attemptId };
	await writePrivateJson(file, updated);
}

export function registerConsoleWorkflowBridge(pi: ExtensionAPI, options: { service: Pick<ResearchService, "runStage" | "status" | "goalStatus" | "goalAction">; getBoundGoalRunId: () => string | undefined; controlDir?: string; descriptorFile?: string; processIdentity?: typeof readCurrentProcessIdentity }): void {
	const controlDir = options.controlDir ?? process.env.MUL_PIS_CONSOLE_CONTROL_DIR;
	const descriptorFile = options.descriptorFile ?? process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	if (!controlDir || !descriptorFile || !path.isAbsolute(controlDir) || path.resolve(path.dirname(descriptorFile)) !== path.resolve(controlDir) || !secureDirectory(controlDir) || !existsSync(descriptorFile)) return;
	const active = new Map<string, { abort: AbortController; request?: ConsoleWorkflowRequest }>();
	async function verifyRequestIdentity(request: ConsoleWorkflowRequest, ctx: ExtensionContext): Promise<string | undefined> {
		const descriptorInfo = await lstat(descriptorFile!);
		if (!descriptorInfo.isFile() || descriptorInfo.isSymbolicLink() || (descriptorInfo.mode & 0o077) !== 0) throw new Error("untrusted run descriptor");
		const descriptor = parseRunDescriptor(JSON.parse(await readFile(descriptorFile!, "utf8"))) as RunDescriptorV1;
		const current = await (options.processIdentity ?? readCurrentProcessIdentity)();
		if (descriptor.controlDir !== controlDir || descriptor.instanceId !== request.instanceId || descriptor.attemptId !== request.attemptId || descriptor.workspaceId !== request.workspaceId || path.resolve(ctx.cwd) !== path.resolve(request.workspace) || descriptor.process.hostId !== current.hostId || descriptor.process.bootId !== current.bootId || descriptor.process.pid !== current.pid || descriptor.process.processStartToken !== current.processStartToken) throw new Error("workflow session identity mismatch");
		const bound = options.getBoundGoalRunId();
		if (request.goalRunId !== descriptor.goalRunId || request.goalRunId !== bound) throw new Error("workflow goal binding mismatch");
		return bound;
	}
	pi.registerCommand("workflow-console", {
		description: "Execute one verified terminal-console workflow request by ID",
		handler: async (args: string, ctx: ExtensionContext) => {
			const requestId = args.trim();
			if (!UUID.test(requestId) || !secureDirectory(controlDir)) return;
			const requests = path.join(controlDir, "requests");
			const responses = path.join(controlDir, "responses");
			if (!secureDirectory(requests) || !secureDirectory(responses) || active.has(requestId)) return;
			const responseFile = path.join(responses, `${requestId}.json`);
			if (existsSync(responseFile)) return;
			const execution = { abort: new AbortController(), request: undefined as ConsoleWorkflowRequest | undefined };
			active.set(requestId, execution);
			let response: ConsoleWorkflowResponse;
			try {
				const requestFile = path.join(requests, `${requestId}.json`);
				const info = await lstat(requestFile);
				if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 256 * 1024 || info.uid !== process.getuid?.()) throw new Error("untrusted workflow request file");
				const request = parseConsoleWorkflowRequest(JSON.parse(await readFile(requestFile, "utf8")));
				if (request.requestId !== requestId) throw new Error("request ID mismatch");
				const bound = await verifyRequestIdentity(request, ctx);
				if (!ctx.isIdle()) throw new Error("Pi session is busy");
				execution.request = request;
				const action = request.action;
				let value: unknown;
				if (action.kind === "stage") {
					if (action.request.feedbackStage === "M07" && action.request.feedbackRunId !== bound) throw new Error("M07 feedback must use the bound goal");
					value = await options.service.runStage({ ...action.request, workspace: request.workspace }, execution.abort.signal);
				} else if (action.kind === "status") {
					if (bound && action.runId && action.runId !== bound) throw new Error("status runId is not bound");
					value = action.runId ? await options.service.goalStatus(action.runId, request.workspace) : await options.service.status(request.workspace);
				} else {
					if (!bound || !request.goalRunId || action.runId !== bound) throw new Error("no bound workflow goal");
					if (action.kind === "checkpoint") value = await options.service.goalAction("checkpoint", request.workspace, { runId: bound, taskIds: action.taskIds }, execution.abort.signal);
					if (action.kind === "plan") value = await options.service.goalAction("plan", request.workspace, { runId: bound, plan: action.plan, refreshBaseline: action.refreshBaseline, checkpointId: action.checkpointId, m04RunId: action.m04RunId }, execution.abort.signal);
					if (action.kind === "decision") value = await options.service.goalAction("decision", request.workspace, { runId: bound, action: "resolve", question: action.question, decision: action.decision, relatedTaskIds: action.relatedTaskIds ?? [] }, execution.abort.signal);
				}
				response = { version: 1, requestId, ok: true, data: metadata(value, action.kind) };
			} catch (error) { response = { version: 1, requestId, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "workflow command failed" }; }
			try { await writePrivateJson(responseFile, response); } finally { active.delete(requestId); }
		},
	});
	pi.registerCommand("workflow-console-cancel", {
		description: "Cancel one verified active terminal-console workflow request by ID",
		handler: async (args: string, ctx: ExtensionContext) => {
			const requestId = args.trim();
			if (!UUID.test(requestId) || !secureDirectory(controlDir)) return;
			const responses = path.join(controlDir, "responses");
			if (!secureDirectory(responses)) return;
			const receiptFile = path.join(responses, `${requestId}.cancel.json`);
			if (existsSync(receiptFile)) return;
			let receipt: ConsoleWorkflowCancelResponse;
			try {
				const execution = active.get(requestId);
				if (!execution?.request) throw new Error("workflow request is not active");
				await verifyRequestIdentity(execution.request, ctx);
				execution.abort.abort(new Error("terminal console requested cancellation"));
				receipt = { version: 1, requestId, ok: true, cancelled: true };
			} catch (error) { receipt = { version: 1, requestId, ok: false, cancelled: false, error: error instanceof Error ? error.message.slice(0, 200) : "cancellation rejected" }; }
			await writePrivateJson(receiptFile, receipt);
		},
	});
}
