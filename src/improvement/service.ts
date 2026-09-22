import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import type { SessionRunner, SessionSpec } from "../runner/types.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { nowIso, readTextIfExists, Workspace, writeFileAtomic } from "../workspace.ts";
import { evaluateCandidate } from "./evaluator.ts";
import { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy, validateActiveBudgetPointer, validateBudgetPolicy, type ActiveBudgetPointer, type BudgetPolicy } from "./policy.ts";
import type { AnonymousRunSample, ImprovementProtocol, ImprovementRun, ImprovementRunResult, ImprovementStatus } from "./types.ts";

export interface ImprovementServiceOptions {
	workspaceRoot: string;
	runner: SessionRunner;
	minimumReductionRatio?: number;
	maximumNewDeferredRatio?: number;
	minimumInlineCoverageRatio?: number;
	now?: () => Date;
}

interface PromotionReceipt {
	version: 1;
	runId: string;
	versionId: string;
	previousVersionId?: string;
	state: "prepared" | "active";
	preparedAt: string;
	activatedAt?: string;
	activePointerIsAuthority: true;
}

const IMPROVER_SYSTEM = `你是 research harness 的预算策略改进提议器。你只能输出一个 JSON 对象，不得输出 Markdown、解释或代码。对象必须且只能包含 version、maxPromptChars、maxInlineFileChars、maxAggregateInlineChars、maxFeedbackChars、overflowMode。你看到的只有匿名化运行规模和失败类别，不得猜测题面、身份或机密。目标是在保留 manifest 可追踪性的前提下降低历史样本中直接内联的字符量。不得扩大任何现有预算。当前协议只重放单文件与聚合内联决策，因此 maxPromptChars、maxFeedbackChars 和 overflowMode 必须与基线完全相同。`;
const activeImprovements = new Set<string>();

function runId(now: Date): string { return `${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomBytes(3).toString("hex")}`; }
function improvementRoot(root: string): string { return path.join(root, ".agent", "improvement"); }
function runRoot(root: string, id: string): string { return path.join(improvementRoot(root), "runs", id); }
function versionRoot(root: string, id: string): string { return path.join(improvementRoot(root), "versions", id); }

async function fileChars(file: string): Promise<number> {
	try { const info = await stat(file); return info.isFile() ? info.size : 0; } catch { return 0; }
}

function classifyFailures(record: StageRunRecord): string[] {
	if (!record.failures.length) return [];
	const classes = new Set<string>();
	for (const failure of record.failures) {
		const lower = failure.toLowerCase();
		if (/length|token|context|过长|超限/.test(lower)) classes.add("size-or-context-limit");
		else if (/timeout|超时|stall/.test(lower)) classes.add("timeout-or-stall");
		else if (/network|http|offline|网络/.test(lower)) classes.add("external-io");
		else classes.add("other-failure");
	}
	return [...classes].sort();
}

/** Read sizes and coarse failure classes only. Paths, file names and contents never enter the proposer prompt. */
export async function collectAnonymousRunSamples(workspace: Workspace): Promise<AnonymousRunSample[]> {
	const samples: AnonymousRunSample[] = [];
	for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"]) {
		for (const id of await workspace.listRuns(stage)) {
			const record = await workspace.readRun(stage, id);
			const inputFileChars = await Promise.all(record.inputs.map((entry) => fileChars(entry.path)));
			const inputChars = inputFileChars.reduce((sum, size) => sum + size, 0);
			const outputChars = (await Promise.all(record.outputs.map((entry) => fileChars(entry.path)))).reduce((sum, size) => sum + size, 0);
			samples.push({ stage, status: record.status, inputChars, inputFileChars, outputChars, failureClasses: classifyFailures(record) });
		}
	}
	return samples;
}

export class ImprovementService {
	private readonly root: string;
	private readonly runner: SessionRunner;
	private readonly minimumReductionRatio: number;
	private readonly maximumNewDeferredRatio: number;
	private readonly minimumInlineCoverageRatio: number;
	private readonly now: () => Date;
	constructor(options: ImprovementServiceOptions) {
		this.root = path.resolve(options.workspaceRoot);
		this.runner = options.runner;
		this.minimumReductionRatio = options.minimumReductionRatio ?? 0.10;
		this.maximumNewDeferredRatio = options.maximumNewDeferredRatio ?? 0.35;
		this.minimumInlineCoverageRatio = options.minimumInlineCoverageRatio ?? 0.35;
		if (!(this.minimumReductionRatio > 0 && this.minimumReductionRatio < 1)) throw new HarnessError("improvement.protocol", "minimumReductionRatio 必须在 0 与 1 之间");
		if (!(this.maximumNewDeferredRatio >= 0 && this.maximumNewDeferredRatio <= 1)) throw new HarnessError("improvement.protocol", "maximumNewDeferredRatio 必须在 0 与 1 之间");
		if (!(this.minimumInlineCoverageRatio > 0 && this.minimumInlineCoverageRatio <= 1)) throw new HarnessError("improvement.protocol", "minimumInlineCoverageRatio 必须在 0 与 1 之间");
		this.now = options.now ?? (() => new Date());
	}

	async run(): Promise<ImprovementRunResult> { return this.withMutation(() => this.runUnlocked()); }

	private async runUnlocked(): Promise<ImprovementRunResult> {
		const ws = new Workspace(this.root);
		await this.ensureBuiltinVersion();
		const config = await ws.loadConfig();
		const model = resolveRoleModel(config, "improver");
		const baseline = await loadActiveBudgetPolicy(this.root);
		const pointer = await this.readPointer();
		const id = runId(this.now());
		const dir = runRoot(this.root, id);
		await mkdir(path.join(dir, "candidate"), { recursive: true });
		const baselinePath = path.join(dir, "baseline-policy.json");
		const protocolPath = path.join(dir, "protocol.json");
		const statePath = path.join(dir, "run.json");
		const protocol: ImprovementProtocol = { version: 1, objective: "reduce-observed-inline-payload", minimumReductionRatio: this.minimumReductionRatio, maximumNewDeferredRatio: this.maximumNewDeferredRatio, minimumInlineCoverageRatio: this.minimumInlineCoverageRatio, requireManifestCoverage: true, allowedCandidate: "budget-policy-only", baselinePolicy: baseline, samples: await collectAnonymousRunSamples(ws), createdAt: nowIso() };
		await writeFileAtomic(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
		await writeFileAtomic(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`);
		const run: ImprovementRun = { version: 1, runId: id, status: "proposing", startedAt: nowIso(), baselineVersionId: pointer?.versionId ?? "builtin-default", protocolPath, baselinePath };
		await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
		const spec: SessionSpec = { label: `RSI-budget-${id}`, role: "improver", model, systemPrompt: IMPROVER_SYSTEM, tools: { kind: "none" }, persistDir: ws.sessionsDir };
		let handle;
		try {
			handle = await this.runner.create(spec);
			run.session = { id: handle.ref.id, label: handle.ref.label, model: handle.ref.model, file: handle.ref.file };
			const safePrompt = JSON.stringify({ objective: protocol.objective, minimumReductionRatio: protocol.minimumReductionRatio, maximumNewDeferredRatio: protocol.maximumNewDeferredRatio, minimumInlineCoverageRatio: protocol.minimumInlineCoverageRatio, baselinePolicy: baseline, samples: protocol.samples });
			const turn = await handle.prompt(safePrompt);
			let parsed: unknown;
			try { parsed = JSON.parse(turn.text); } catch { throw new HarnessError("improvement.candidate-json", "改进提议必须是单一合法 JSON 对象"); }
			const candidate = validateBudgetPolicy(parsed);
			const candidatePath = path.join(dir, "candidate", "policy.json");
			await writeFileAtomic(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
			run.candidatePath = candidatePath;
			run.status = "candidate-ready";
			await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
			const evaluation = evaluateCandidate(protocol, candidate);
			const evaluationPath = path.join(dir, "evaluation.json");
			await writeFileAtomic(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
			run.evaluationPath = evaluationPath;
			if (!evaluation.passed) {
				run.status = "rejected"; run.finishedAt = nowIso(); run.rejectionReason = evaluation.gates.filter((gate) => !gate.passed).map((gate) => gate.name).join(", ");
				await writeFileAtomic(path.join(dir, "rejection.json"), `${JSON.stringify({ version: 1, runId: id, at: run.finishedAt, reason: run.rejectionReason, evaluationPath }, null, 2)}\n`);
				await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
				return { run, evaluation, activeVersionId: pointer?.versionId };
			}
			const activeVersionId = await this.promote(id, candidate, pointer, run);
			run.status = "promoted"; run.finishedAt = nowIso();
			await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
			return { run, evaluation, activeVersionId };
		} catch (error) {
			const committed = await this.readPointer().catch(() => undefined);
			if (committed?.runId === id) {
				run.status = "promoted"; run.finishedAt = nowIso();
				await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`).catch(() => undefined);
				return { run, activeVersionId: committed.versionId };
			}
			run.status = "failed"; run.finishedAt = nowIso(); run.rejectionReason = (error as Error).message;
			await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`).catch(() => undefined);
			throw error;
		} finally { handle?.dispose(); }
	}

	async status(): Promise<ImprovementStatus> {
		const pointer = await this.readPointer();
		const runsDir = path.join(improvementRoot(this.root), "runs");
		const runs: ImprovementStatus["runs"] = [];
		if (existsSync(runsDir)) for (const name of (await readdir(runsDir)).sort()) {
			const text = await readTextIfExists(path.join(runsDir, name, "run.json")); if (!text) continue;
			const value = JSON.parse(text) as ImprovementRun;
			const effectiveStatus = pointer?.runId === value.runId ? "promoted" as const : value.status;
			runs.push({ runId: value.runId, status: effectiveStatus, startedAt: value.startedAt, finishedAt: value.finishedAt ?? (effectiveStatus === "promoted" ? pointer?.promotedAt : undefined) });
		}
		return { activeVersionId: pointer?.versionId, previousVersionId: pointer?.previousVersionId, runs };
	}

	async rollback(): Promise<ActiveBudgetPointer> { return this.withMutation(() => this.rollbackUnlocked()); }

	private async rollbackUnlocked(): Promise<ActiveBudgetPointer> {
		const pointer = await this.readPointer();
		if (!pointer?.previousVersionId) throw new HarnessError("improvement.rollback", "没有可回退的上一预算策略版本");
		if (!existsSync(path.join(versionRoot(this.root, pointer.previousVersionId), "policy.json"))) throw new HarnessError("improvement.rollback", "上一预算策略版本不存在");
		const next: ActiveBudgetPointer = { version: 1, versionId: pointer.previousVersionId, previousVersionId: pointer.versionId, promotedAt: nowIso(), runId: `rollback-${pointer.runId}` };
		await writeFileAtomic(path.join(improvementRoot(this.root), "active.json"), `${JSON.stringify(next, null, 2)}\n`);
		const rollbackId = `${this.now().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
		await writeFileAtomic(path.join(improvementRoot(this.root), "rollbacks", `${rollbackId}.json`), `${JSON.stringify({ version: 1, at: next.promotedAt, fromVersionId: pointer.versionId, toVersionId: next.versionId, activePointerIsAuthority: true }, null, 2)}\n`);
		return next;
	}

	private async promote(id: string, candidate: BudgetPolicy, previous: ActiveBudgetPointer | undefined, run: ImprovementRun): Promise<string> {
		const current = await this.readPointer();
		if ((current?.versionId ?? "builtin-default") !== (previous?.versionId ?? "builtin-default") || current?.runId !== previous?.runId) throw new HarnessError("improvement.stale-baseline", "活动策略已在本轮评估期间变化；候选未晋级，请基于新 baseline 重跑");
		const versionId = `budget-${id}`;
		const previousVersionId = previous?.versionId ?? "builtin-default";
		await mkdir(versionRoot(this.root, versionId), { recursive: true });
		await writeFileAtomic(path.join(versionRoot(this.root, versionId), "policy.json"), `${JSON.stringify(candidate, null, 2)}\n`);
		const receiptPath = path.join(runRoot(this.root, id), "promotion.json");
		const receipt: PromotionReceipt = { version: 1, runId: id, versionId, previousVersionId, state: "prepared", preparedAt: nowIso(), activePointerIsAuthority: true };
		await writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		run.promotionReceiptPath = receiptPath;
		const pointer: ActiveBudgetPointer = { version: 1, versionId, previousVersionId, promotedAt: nowIso(), runId: id };
		// This atomic pointer replacement is the sole activation commit point. A prepared receipt is recoverable by comparing it with active.json.
		await writeFileAtomic(path.join(improvementRoot(this.root), "active.json"), `${JSON.stringify(pointer, null, 2)}\n`);
		receipt.state = "active"; receipt.activatedAt = pointer.promotedAt;
		await writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		return versionId;
	}

	private async readPointer(): Promise<ActiveBudgetPointer | undefined> {
		const text = await readTextIfExists(path.join(improvementRoot(this.root), "active.json"));
		if (!text) return undefined;
		try { return validateActiveBudgetPointer(JSON.parse(text)); } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError("improvement.active", "active.json 不是合法 JSON"); }
	}

	private async ensureBuiltinVersion(): Promise<void> {
		const file = path.join(versionRoot(this.root, "builtin-default"), "policy.json");
		if (existsSync(file)) return;
		await writeFileAtomic(file, `${JSON.stringify(DEFAULT_BUDGET_POLICY, null, 2)}\n`);
	}

	private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
		const key = await realpath(this.root).catch(() => this.root);
		if (activeImprovements.has(key)) throw new HarnessError("improvement.busy", `工作区已有策略改进操作：${this.root}`);
		activeImprovements.add(key);
		const lockDir = path.join(improvementRoot(this.root), "mutation.lock");
		const ownerFile = path.join(lockDir, "owner.json");
		let acquired = false;
		try {
			await mkdir(improvementRoot(this.root), { recursive: true });
			try { await mkdir(lockDir); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("improvement.locked", `策略改进锁已存在：${lockDir}。可能有另一进程正在运行；若确认进程已崩溃，请检查 owner.json 后删除该精确 lock 目录再重试`);
				throw error;
			}
			acquired = true;
			await writeFileAtomic(ownerFile, `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: nowIso(), operation: "run-or-rollback" }, null, 2)}\n`);
			return await operation();
		} finally {
			activeImprovements.delete(key);
			if (acquired && existsSync(ownerFile)) await unlink(ownerFile).catch(() => undefined);
			if (acquired && existsSync(lockDir)) await rmdir(lockDir).catch(() => undefined);
		}
	}
}

export type { BudgetPolicy } from "./policy.ts";
export { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy, validateBudgetPolicy } from "./policy.ts";
