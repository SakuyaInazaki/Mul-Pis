/** A host-configured command adapter for candidate execution; candidate input never selects an executable. */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, realpath } from "node:fs/promises";
import path from "node:path";
import type {
	CandidateExecutionBackend, CandidateExecutionCheck, CandidateExecutionContext,
	CandidateExecutionStage, CandidateExecutionStageResult,
} from "./candidate-runner.ts";

export interface CandidateStageCommand {
	/** Fixed by the host. argv[0] and cwd must be absolute; no shell or interpolation is used. */
	argv: readonly [string, ...string[]];
	cwd: string;
	/** Optional fixed process environment. Omitted means ordinary inherited environment. */
	env?: Readonly<Record<string, string>>;
}
export interface CandidateCommandStage extends CandidateExecutionStage {
	execute: CandidateStageCommand;
	/** Query the original external ID only; never submit a new candidate. */
	query?: CandidateStageCommand;
}
export interface CandidateCommandBackendOptions {
	id: string;
	version: string;
	configurationHelp?: string;
	protocolIds?: readonly string[];
	stages: readonly CandidateCommandStage[];
}

type CommandEvent = Record<string, unknown>;
type CommandResult = {
	status: CandidateExecutionStageResult["status"];
	performedChecks: CandidateExecutionCheck[];
	receiptPaths: string[];
	evaluationReceiptPaths?: string[];
	externalId?: string;
	summary?: string;
};
const checkOrder: CandidateExecutionCheck[] = ["contract", "compile", "correctness", "measurement"];
const within = (root: string, file: string) => file.startsWith(root + path.sep);
function fail(message: string): never { throw new Error(`candidate command backend: ${message}`); }

function fixedCommand(command: CandidateStageCommand, label: string): CandidateStageCommand {
	if (!Array.isArray(command?.argv) || !command.argv.length || command.argv.some(arg => typeof arg !== "string" || !arg || arg.includes("\0")) ||
		!path.isAbsolute(command.argv[0]) || typeof command.cwd !== "string" || !path.isAbsolute(command.cwd) || command.cwd.includes("\0") ||
		(command.env !== undefined && (!object(command.env) || Object.entries(command.env).some(([name, value]) =>
			!(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) || typeof value !== "string" || value.includes("\0")))))
		fail(`${label} needs a fixed absolute executable, argv and cwd`);
	return { argv: [...command.argv] as [string, ...string[]], cwd: command.cwd,
		...(command.env !== undefined ? { env: { ...command.env } } : {}) };
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function parseResult(value: CommandEvent, stage: CandidateExecutionStage, originalId?: string): CommandResult {
	const status = value.status;
	if (!["passed", "failed", "pending", "unknown"].includes(String(status)) || !Array.isArray(value.performedChecks) ||
		value.performedChecks.some(check => !checkOrder.includes(check as CandidateExecutionCheck)) ||
		value.performedChecks.some((check, index) => stage.checks[index] !== check))
		fail(`invalid result or performedChecks for ${stage.id}`);
	const performedChecks = value.performedChecks as CandidateExecutionCheck[];
	if (status === "passed" && performedChecks.length !== stage.checks.length) fail(`passed ${stage.id} omitted declared checks`);
	if (status === "failed" && !performedChecks.length) fail(`failed ${stage.id} did not identify a checked stage`);
	if (!Array.isArray(value.receiptPaths) || value.receiptPaths.some(p => !nonempty(p)) ||
		(value.evaluationReceiptPaths !== undefined && (!Array.isArray(value.evaluationReceiptPaths) || value.evaluationReceiptPaths.some(p => !nonempty(p)))))
		fail(`invalid receipt paths for ${stage.id}`);
	const receiptPaths = value.receiptPaths as string[];
	const evaluationReceiptPaths = (value.evaluationReceiptPaths ?? []) as string[];
	if (new Set(receiptPaths).size !== receiptPaths.length || new Set(evaluationReceiptPaths).size !== evaluationReceiptPaths.length ||
		receiptPaths.some(p => p === "stdout.ndjson" || p === "stderr.txt") ||
		evaluationReceiptPaths.some(p => !receiptPaths.includes(p))) fail(`evaluation receipts must be original stage receipts for ${stage.id}`);
	if (status === "passed" && !receiptPaths.length) fail(`passed ${stage.id} has no original result receipt`);
	if (["passed", "failed"].includes(String(status)) && performedChecks.some(check => check === "correctness" || check === "measurement") &&
		!evaluationReceiptPaths.length) fail(`${stage.id} reported an evaluation check without an evaluation receipt`);
	if (value.externalId !== undefined && !nonempty(value.externalId)) fail(`invalid external ID for ${stage.id}`);
	if (originalId && value.externalId !== undefined && value.externalId !== originalId) fail(`query changed original external ID for ${stage.id}`);
	if (status === "pending" && stage.mode === "delegated" && !nonempty(value.externalId ?? originalId))
		fail(`pending delegated ${stage.id} lacks its original external ID`);
	if (value.summary !== undefined && (typeof value.summary !== "string" || value.summary.length > 4000)) fail(`invalid summary for ${stage.id}`);
	return { status: status as CommandResult["status"], performedChecks, receiptPaths, evaluationReceiptPaths,
		...(value.externalId !== undefined ? { externalId: value.externalId as string } : {}),
		...(value.summary !== undefined ? { summary: value.summary as string } : {}) };
}

async function originalReceipt(invocationDir: string, relative: string, workDir: string): Promise<string> {
	if (path.isAbsolute(relative) || relative === "." || relative === ".." || relative.split(/[\\/]/).some(part => !part || part === "." || part === ".."))
		fail(`invalid command receipt path: ${relative}`);
	const file = path.resolve(invocationDir, relative);
	if (!within(invocationDir, file) || !(await lstat(file)).isFile() || !within(invocationDir, await realpath(file)))
		fail(`command receipt is not a regular invocation file: ${relative}`);
	return path.relative(workDir, file);
}

/**
 * stdin starts with one JSON line: {version:1,kind,identity,protocolId,stage,sourcePaths,sources,
 * config,outputDir,externalId?}. Each sources entry has declaredPath, absolutePath (the
 * compatible work copy), and frozenPath (the host-owned execution bytes). Commands must
 * execute frozenPath. stdout is NDJSON with optional {version:1,kind:"external-id",
 * externalId} followed by exactly one {version:1,kind:"result",status,performedChecks,
 * receiptPaths,evaluationReceiptPaths?,externalId?,summary?}. Receipt paths are relative to
 * the fresh outputDir. After an external-id event, the command must wait for stdin
 * {version:1,kind:"external-id-recorded",externalId} before further external I/O. The adapter
 * sends that acknowledgement only after the runner durably records the ID. stdout/stderr
 * are also retained byte-for-byte as stage receipts.
 */
export function createCandidateCommandBackend(options: CandidateCommandBackendOptions): CandidateExecutionBackend {
	if (!nonempty(options.id) || !nonempty(options.version) || !Array.isArray(options.stages) || !options.stages.length)
		fail("backend needs id, version and stages");
	const definitions = options.stages.map(stage => ({ id: stage.id, mode: stage.mode, checks: [...stage.checks],
		execute: fixedCommand(stage.execute, `${stage.id}.execute`),
		...(stage.query ? { query: fixedCommand(stage.query, `${stage.id}.query`) } : {}) }));
	const stages: CandidateExecutionStage[] = definitions.map(({ id, mode, checks }) => ({ id, mode, checks }));
	for (let i = 0, prior = -1; i < stages.length; i++) {
		const stage = stages[i];
		if (!nonempty(stage.id) || stages.findIndex(item => item.id === stage.id) !== i || !["local", "delegated"].includes(stage.mode) || !stage.checks.length)
			fail("invalid stage identity or mode");
		for (const check of stage.checks) {
			const order = checkOrder.indexOf(check);
			if (order <= prior) fail("stage checks must follow contract, compile, correctness, measurement order");
			prior = order;
		}
	}
	async function invoke(context: CandidateExecutionContext, kind: "execute" | "query", externalId?: string): Promise<CandidateExecutionStageResult> {
		const definition = definitions.find(item => item.id === context.stage.id);
		if (!definition || JSON.stringify({ id: definition.id, mode: definition.mode, checks: definition.checks }) !== JSON.stringify(context.stage))
			fail("stage does not match the host backend binding");
		const command = kind === "query" ? definition.query : definition.execute;
		if (!command) fail(`no original-ID query command for ${context.stage.id}`);
		const invocationDir = await mkdtemp(path.join(context.outputDir, `${kind}-`));
		const stdoutPath = path.join(invocationDir, "stdout.ndjson"), stderrPath = path.join(invocationDir, "stderr.txt");
		const stdout = await open(stdoutPath, "wx"), stderr = await open(stderrPath, "wx");
		const request = { version: 1, kind, identity: { goalRunId: context.goalRunId, taskId: context.taskId,
			operationId: context.operationId, runId: context.runId, ...(context.subjectId ? { subjectId: context.subjectId } : {}) },
			protocolId: context.protocolId, stage: context.stage, workDir: context.workDir, outputDir: invocationDir,
			sourcePaths: context.sourcePaths, sources: context.sources.map(({ declaredPath, absolutePath, frozenPath }) => ({ declaredPath, absolutePath, frozenPath })),
			config: context.config, ...(externalId ? { externalId } : {}) };
		let learnedId = externalId, acknowledgedId = false, result: CommandResult | undefined;
		if (context.signal?.aborted) { await Promise.all([stdout.close(), stderr.close()]); context.signal.throwIfAborted(); }
		const child = spawn(command.argv[0], command.argv.slice(1), { cwd: command.cwd, shell: false,
			...(command.env !== undefined ? { env: { ...command.env } } : {}),
			detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
		// The fixed adapter may spawn compilers or workers holding its output pipes.
		// Cancel the whole invocation so an exited wrapper cannot leave the tool hung.
		let terminationTimer: NodeJS.Timeout | undefined, invocationClosed = false;
		const signalInvocation = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		};
		const terminate = () => {
			if (invocationClosed || terminationTimer) return;
			signalInvocation("SIGTERM");
			terminationTimer = setTimeout(() => signalInvocation("SIGKILL"), 2_000);
		};
		const cleanup = () => { invocationClosed = true; clearTimeout(terminationTimer); context.signal?.removeEventListener("abort", terminate); };
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", error => { cleanup(); reject(error); });
			child.once("close", (code, signal) => { cleanup(); resolve({ code, signal }); });
		});
		context.signal?.addEventListener("abort", terminate, { once: true });
		if (context.signal?.aborted) terminate();
		const send = (value: unknown) => new Promise<void>((resolve, reject) => {
			child.stdin.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve());
		});
		async function line(bytes: Buffer): Promise<void> {
			if (!bytes.length) return;
			let event: unknown;
			try { event = JSON.parse(bytes.toString("utf8")); } catch { return fail("stdout contains non-JSON control output"); }
			if (!object(event) || event.version !== 1) fail("invalid command protocol event");
			if (event.kind === "external-id") {
				if (result || !nonempty(event.externalId) || (learnedId && learnedId !== event.externalId)) fail("invalid or changed external ID event");
				learnedId = event.externalId;
				await context.recordExternalId(learnedId);
				await send({ version: 1, kind: "external-id-recorded", externalId: learnedId });
				acknowledgedId = true;
			} else if (event.kind === "result") {
				if (result) fail("command emitted more than one terminal result");
				result = parseResult(event, context.stage, learnedId);
				if (kind === "execute" && context.stage.mode === "delegated" && result.status === "pending" && !acknowledgedId)
					fail("pending delegated result requires an acknowledged external ID event");
				if (result.externalId && !learnedId) { learnedId = result.externalId; await context.recordExternalId(learnedId); }
				child.stdin.end();
			} else fail("unknown command protocol event");
		}
		const readStdout = (async () => {
			let pending = Buffer.alloc(0);
			try {
				for await (const raw of child.stdout) {
					const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
					await stdout.write(chunk);
					pending = Buffer.concat([pending, chunk]);
					let end: number;
					while ((end = pending.indexOf(10)) >= 0) {
						const bytes = pending.subarray(0, end); pending = pending.subarray(end + 1);
						if (bytes.length > 1_000_000) fail("command control line exceeds 1 MB; raw stdout retained");
						await line(bytes);
					}
					if (pending.length > 1_000_000) fail("command control line exceeds 1 MB; raw stdout retained");
				}
				if (pending.length) await line(pending);
			} finally { await stdout.close(); }
		})().catch(error => { terminate(); throw error; });
		const readStderr = (async () => {
			try { for await (const raw of child.stderr) await stderr.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)); }
			finally { await stderr.close(); }
		})().catch(error => { terminate(); throw error; });
		child.stdin.on("error", () => { /* A wrapper that exited before reading remains unresolved below. */ });
		try { await send(request); }
		catch (error) {
			terminate(); await Promise.allSettled([readStdout, readStderr, closed]);
			fail(`command could not receive its request; raw output retained in ${invocationDir}: ${String(error)}`);
		}
		const settled = await Promise.allSettled([readStdout, readStderr, closed]);
		context.signal?.throwIfAborted();
		for (const item of settled) if (item.status === "rejected") fail(`command did not complete; raw output retained in ${invocationDir}: ${String(item.reason)}`);
		const exit = (settled[2] as PromiseFulfilledResult<{ code: number | null; signal: NodeJS.Signals | null }>).value;
		const finalResult = result as CommandResult | undefined;
		if (!finalResult) fail(`command produced no terminal result; raw output retained in ${invocationDir}`);
		if (exit.signal || (exit.code !== 0 && finalResult.status !== "failed"))
			fail(`command exited before a valid ${finalResult.status} stage result; raw output retained in ${invocationDir}`);
		const originals = await Promise.all(finalResult.receiptPaths.map(p => originalReceipt(invocationDir, p, context.workDir)));
		const evaluations = await Promise.all(finalResult.evaluationReceiptPaths?.map(p => originalReceipt(invocationDir, p, context.workDir)) ?? []);
		return { status: finalResult.status, performedChecks: finalResult.performedChecks,
			receiptPaths: [...originals, path.relative(context.workDir, stdoutPath), path.relative(context.workDir, stderrPath)],
			evaluationReceiptPaths: evaluations, ...(learnedId ? { externalId: learnedId } : {}),
			...(finalResult.summary ? { summary: finalResult.summary } : {}) };
	}
	return { id: options.id, version: options.version, stages,
		...(options.configurationHelp ? { configurationHelp: options.configurationHelp } : {}),
		...(options.protocolIds ? { protocolIds: [...options.protocolIds] } : {}),
		canQueryStage: (stageId: string) => Boolean(definitions.find(item => item.id === stageId)?.query),
		executeStage: context => invoke(context, "execute"),
		queryStage: context => invoke(context, "query", context.externalId) };
}
