/** Resolve committed knowledge without hiding a newer unsuccessful M04 judgment. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { StageContext } from "../stages/context.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { latestByStartOrder } from "../workspace.ts";
import type { M04BaselineFailure } from "./types.ts";

export interface FormalBaseline { run: StageRunRecord; knowledgeSnapshot?: string }
export interface M04BaselineResolution {
	baseline?: FormalBaseline;
	knowledgeSnapshot?: string;
	failedM04: M04BaselineFailure[];
}
/** A saved assessment may dispatch only against this exact captured M04 state. */
export interface M04BaselineIdentity {
	runs: Array<{ runId: string; runJsonSha256: string }>;
	formalRunId: string | null;
	knowledgeSnapshot: string | null;
	failedM04: M04BaselineFailure[];
}
function fail(message: string): never { throw new HarnessError("m07.baseline", message); }
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
async function present(file: string): Promise<boolean> {
	try { await lstat(file); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function publishedKnowledge(ctx: StageContext): Promise<string | undefined> {
	const file = path.join(ctx.ws.knowledgeDir, "CURRENT");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile()) fail("当前知识指针不是受信文件");
		const bytes = await handle.readFile();
		const id = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
		if (id && !/^G\d{3,}$/.test(id)) fail("当前知识指针无法确定已发布快照");
		const published = await ctx.store.current();
		const after = await lstat(file);
		if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs || published?.id !== (id || undefined))
			fail("当前知识指针在失败 M04 对账期间变化或无法读取");
		return id || undefined;
	} finally { await handle.close(); }
}
async function json(file: string, root: string, physicalByteBoundary?: number): Promise<Record<string, unknown>> {
	const resolved = await realpath(file);
	if (!resolved.startsWith(`${await realpath(root)}${path.sep}`)) fail("M04 transaction evidence escapes its host root");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || (physicalByteBoundary !== undefined && before.size > physicalByteBoundary))
			fail("M04 transaction evidence exceeds its existing host physical file boundary");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			fail("M04 transaction evidence changed while being read");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (!object(value)) fail("M04 transaction evidence is not an object");
		return value;
	} finally { await handle.close(); }
}

export async function settledM04Failure(ctx: StageContext, run: StageRunRecord): Promise<M04BaselineFailure> {
	try {
		const root = ctx.ws.runDir("M04", run.runId);
		const transactionFile = path.join(root, "m04-transaction.json");
		const declared = run.outputs.filter(item => item.label === "M04 知识事务状态");
		if (run.stage !== "M04" || run.status !== "failed" || !run.finishedAt ||
			!Number.isFinite(Date.parse(run.finishedAt)) || declared.length !== 1 ||
			path.resolve(declared[0]!.path) !== transactionFile)
			fail("failed M04 lacks an exact terminal host transaction binding");
		// These two control-file bounds are enforced by the existing M04 writer.
		const tx = await json(transactionFile, root, 1_000_000);
		if (tx.version !== 1 || tx.kind !== "m04-knowledge-transaction" || tx.m04RunId !== run.runId ||
			!["no-proposal", "rejected-draft"].includes(String(tx.state)) || !Array.isArray(tx.attempts) ||
			tx.snapshotId !== undefined || typeof tx.updatedAt !== "string" || !Number.isFinite(Date.parse(tx.updatedAt)))
			fail("failed M04 knowledge transaction is unknown or merge-pending");
		if (run.outputs.some(item => ["知识提案", "合入结果"].includes(item.label)) ||
			await present(path.join(root, "merge.json")) || await present(path.join(root, "proposal.json")))
			fail("failed M04 has unaccounted proposal or merge evidence");
		const attempts = tx.attempts;
		if ((tx.state === "no-proposal" && (attempts.length || tx.currentProposalId !== undefined)) ||
			(tx.state === "rejected-draft" && !attempts.length)) fail("failed M04 transaction and draft attempts disagree");
		const proposalIds = new Set<string>();
		for (const [index, attempt] of attempts.entries()) {
			if (!object(attempt) || attempt.ordinal !== index + 1 ||
				!/^P\d{4,}$/.test(String(attempt.proposalId)) ||
				attempt.state !== "rejected-draft" || attempt.structurallyValid !== false ||
				!Array.isArray(attempt.issues) || !attempt.issues.some(issue => object(issue) && issue.level === "error"))
				fail("failed M04 includes an unresolved draft attempt");
			const id = String(attempt.proposalId);
			if (proposalIds.has(id)) fail("failed M04 repeats a draft identity");
			proposalIds.add(id);
			const proposal = path.join(ctx.ws.knowledgeDir, "proposals", `${id}.json`);
			const relative = path.relative(ctx.ws.root, proposal).replaceAll("\\", "/");
			const receiptName = `proposal-validation-${String(index + 1).padStart(4, "0")}.json`;
			if (attempt.proposalFile !== relative || attempt.receiptFile !== receiptName)
				fail("failed M04 draft path is not its host-owned transaction path");
			const draft = await json(proposal, ctx.ws.knowledgeDir);
			const receipt = await json(path.join(root, receiptName), root, 1_000_000);
			if (draft.id !== id || draft.stage !== "M04" || draft.runId !== run.runId ||
				receipt.version !== 1 || receipt.kind !== "m04-proposal-validation" ||
				receipt.m04RunId !== run.runId || receipt.proposalId !== id ||
				receipt.proposalFile !== relative || receipt.structurallyValid !== false ||
				JSON.stringify(receipt.issues) !== JSON.stringify(attempt.issues) ||
				await present(path.join(ctx.ws.knowledgeDir, "proposals", `${id}.intent.json`)) ||
				await present(path.join(ctx.ws.knowledgeDir, "proposals", `${id}.result.json`)))
				fail("failed M04 rejected draft has unaccounted merge or validation evidence");
		}
		if (tx.state === "rejected-draft" && tx.currentProposalId !== attempts.at(-1)?.proposalId)
			fail("failed M04 current draft does not bind its last rejected attempt");
		for (const name of await readdir(path.join(ctx.ws.knowledgeDir, "proposals"))) {
			if (!/^P\d{4,}\.json$/.test(name)) continue;
			const draft = await json(path.join(ctx.ws.knowledgeDir, "proposals", name), ctx.ws.knowledgeDir);
			if (draft.stage === "M04" && draft.runId === run.runId && !proposalIds.has(String(draft.id)))
				fail("failed M04 has a submitted draft absent from its transaction");
		}
		return { runId: run.runId, transactionState: tx.state as M04BaselineFailure["transactionState"],
			failures: [...run.failures], remarks: [...run.remarks] };
	} catch (error) {
		fail(`最新 M04 运行 ${run.runId} 状态为 failed，未证明没有知识采用，不得回退：${(error as Error).message}`);
	}
}

async function completedBaseline(run: StageRunRecord): Promise<FormalBaseline> {
	if (run.status !== "completed") fail(`最新 M04 运行 ${run.runId} 状态为 ${run.status}，不得回退到更旧基线`);
	if (run.failures.length) fail(`最新 M04 运行 ${run.runId} 含未解决失败，不能作为正式基线：${run.failures.join("；")}`);
	const proposal = run.outputs.find(item => item.label === "知识提案");
	const merge = run.outputs.find(item => item.label === "合入结果");
	if (proposal && !merge) fail(`最新 M04 运行 ${run.runId} 产生了知识提案但未成功合入，不能作为正式基线`);
	let knowledgeSnapshot = run.knowledgeSnapshot;
	if (merge) {
		try {
			const parsed = await json(merge.path, path.dirname(merge.path));
			if (!object(parsed.snapshot) || typeof parsed.snapshot.id !== "string" || !parsed.snapshot.id)
				throw new Error("缺少 snapshot.id");
			knowledgeSnapshot = parsed.snapshot.id;
		} catch (error) { fail(`最新 M04 运行 ${run.runId} 的合入结果无法确定知识快照，不能作为正式基线：${(error as Error).message}`); }
	}
	return { run, knowledgeSnapshot };
}

/** A failed suffix is eligible only as explicit negative feedback, never as a successful M04. */
export async function resolveM04Baseline(ctx: StageContext): Promise<M04BaselineResolution> {
	const runs = await Promise.all((await ctx.ws.listRuns("M04")).map(id => ctx.ws.readRun("M04", id)));
	const failedM04: M04BaselineFailure[] = [];
	let baseline: FormalBaseline | undefined;
	try {
		while (runs.length) {
			const run = latestByStartOrder(runs, "M04")!;
			if (run.status !== "failed") { baseline = await completedBaseline(run); break; }
			failedM04.unshift(await settledM04Failure(ctx, run));
			runs.splice(runs.indexOf(run), 1);
		}
	} catch (error) {
		if (error instanceof HarnessError && error.code === "run.order")
			fail("无法确定最新正式基线；M04 创建顺序存在歧义，不得回退到任一候选");
		throw error;
	}
	if (!failedM04.length) return { baseline, knowledgeSnapshot: baseline?.knowledgeSnapshot, failedM04 };
	// A currently publishing or unreconciled merge can change live limits before CURRENT.
	for (const name of [".merge.lock", ".merge.recovery.lock"])
		if (await present(path.join(ctx.ws.knowledgeDir, name))) fail("知识合入尚未对账，不能从失败 M04 继续");
	for (const name of await readdir(path.join(ctx.ws.knowledgeDir, "proposals"))) {
		if (!/^P\d{4,}\.intent\.json$/.test(name)) continue;
		const intent = await json(path.join(ctx.ws.knowledgeDir, "proposals", name), ctx.ws.knowledgeDir);
		if (intent.version !== 1 || intent.status !== "committed" ||
			!/^P\d{4,}$/.test(String(intent.proposalId)) ||
			!await present(path.join(ctx.ws.knowledgeDir, "proposals", `${intent.proposalId}.result.json`)))
			fail("知识合入意图尚未对账，不能从失败 M04 继续");
	}
	const knowledgeSnapshot = await publishedKnowledge(ctx).catch(error =>
		fail(`无法核对当前已发布知识快照：${(error as Error).message}`));
	if (baseline && baseline.knowledgeSnapshot !== knowledgeSnapshot)
		fail("已完成 M04 基线与当前已发布知识快照不一致；不能回退或隐式改为探索性目标");
	return { baseline, knowledgeSnapshot, failedM04 };
}

export async function captureM04BaselineIdentity(ctx: StageContext): Promise<M04BaselineIdentity> {
	const captureRuns = async (): Promise<M04BaselineIdentity["runs"]> => {
		const ids = await ctx.ws.listRuns("M04");
		const directory = path.join(ctx.ws.stagesDir, "M04");
		const entries = await readdir(directory).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
			throw error;
		});
		if (JSON.stringify(entries.sort()) !== JSON.stringify([...ids].sort()))
			fail("M04 census includes incomplete or orphan state during retained assessment dispatch");
		return Promise.all(ids.map(async runId => {
			const file = path.join(ctx.ws.runDir("M04", runId), "run.json");
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const before = await handle.stat();
				if (!before.isFile()) fail("M04 census run record is not a regular host file");
				const bytes = await handle.readFile();
				const after = await lstat(file);
				if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
					after.size !== before.size || after.mtimeMs !== before.mtimeMs)
					fail("M04 census changed while its run record was read");
				return { runId, runJsonSha256: createHash("sha256").update(bytes).digest("hex") };
			} finally { await handle.close(); }
		}));
	};
	const before = await captureRuns();
	const resolved = await resolveM04Baseline(ctx);
	const after = await captureRuns();
	if (JSON.stringify(before) !== JSON.stringify(after))
		fail("M04 census changed while its baseline was resolved");
	return { runs: after, formalRunId: resolved.baseline?.run.runId ?? null,
		knowledgeSnapshot: resolved.knowledgeSnapshot ?? null, failedM04: resolved.failedM04 };
}

export function failedM04Feedback(failures: readonly M04BaselineFailure[]): string {
	return failures.map(item => `M04 ${item.runId} remains failed (${item.transactionState}); no draft or judgment from this run is adopted.\nFailures: ${item.failures.join("; ") || "unsuccessful judgment"}\nLimitations: ${item.remarks.join("; ") || "none recorded"}`).join("\n\n");
}
