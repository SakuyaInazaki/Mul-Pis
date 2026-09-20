import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { HarnessError } from "../types.ts";
import type { StageRequest } from "./service.ts";

interface FailureState { fingerprint: string; signature: string; consecutive: number; updatedAt: string }
interface Ledger { version: 1; failures: FailureState[] }

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value);
}

function opaque(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

function classifyFailure(message: string): string {
	if (/知识提案.*(?:未入库|未合入|失败|校验)|proposal/i.test(message)) return "proposal-merge";
	if (/实际读取|未实际读取|没有读取|read coverage|coverage/i.test(message)) return "actual-read-coverage";
	if (/机器可读块|结构无效|schema|合法 JSON|字段.*类型|structured/i.test(message)) return "structured-output";
	if (/unresolved|未决|needs_fix|blocked|门禁|gate/i.test(message)) return "unresolved-gate";
	return message
		.replace(/\b\d{8}T\d{6}Z-[a-z0-9]+\b/gi, "<run>")
		.replace(/(?:\/[^\s:：,，;；]+)+/g, "<path>")
		.replace(/\b\d+\b/g, "<n>")
		.trim();
}

export function stageFingerprint(request: StageRequest, inputVersion?: unknown): string {
	let obligation: unknown;
	switch (request.stage) {
		case "M04": obligation = { feedbackStage: request.feedbackStage, feedbackRunId: request.feedbackRunId, feedbackFile: request.feedbackFile, freshSession: request.freshSession }; break;
		case "M05": obligation = { goal: request.goal, noBrowser: request.noBrowser }; break;
		case "M06": obligation = { sources: request.sources, fullText: request.fullText, requirements: request.requirements }; break;
		case "M08": obligation = { materials: request.materials, selfChecks: request.selfChecks, reviewers: request.reviewers, unprovidedScopes: request.unprovidedScopes, previousRunId: request.previousRunId, affectedScope: request.affectedScope }; break;
		case "M09": obligation = { m08RunId: request.m08RunId, m04RunId: request.m04RunId, deliveryScope: request.deliveryScope, reproduction: request.reproduction, closureRequested: request.closureRequested }; break;
		default: obligation = Object.fromEntries(Object.entries(request).filter(([key]) => !["workspace", "purpose", "recipient"].includes(key)));
	}
	// Persist only an opaque control key: exact commands/goals may contain private data.
	return opaque({ stage: request.stage, obligation, inputVersion });
}

async function fileVersion(target: string): Promise<unknown> {
	try { const info = await stat(target); return { path: path.resolve(target), size: info.size, modifiedMs: info.mtimeMs }; }
	catch { return { path: target, unavailable: true }; }
}

/** Byte-independent version facts: this is retry input identity, not a file-integrity/hash workflow. */
export async function stageInputVersion(workspace: string, request: StageRequest): Promise<unknown> {
	const files: string[] = [path.join(workspace, "problem", "problem.md")];
	try { for (const name of (await readdir(path.join(workspace, "problem", "raw"))).sort()) files.push(path.join(workspace, "problem", "raw", name)); } catch { /* optional */ }
	if (request.feedbackFile) files.push(path.resolve(workspace, request.feedbackFile));
	for (const source of request.sources ?? []) if (!/^https?:\/\//i.test(source)) files.push(path.resolve(workspace, source));
	for (const material of request.materials ?? []) files.push(path.resolve(workspace, material.path));
	return Promise.all([...new Set(files)].map(fileVersion));
}

export function failureSignature(value: unknown): string | undefined {
	const seen: Array<{ stage?: unknown; status: unknown; failures: string[] }> = [];
	const visit = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") return;
		const item = candidate as Record<string, unknown>;
		if (item.record && typeof item.record === "object") {
			const record = item.record as Record<string, unknown>;
			const failures = Array.isArray(record.failures) ? record.failures.filter((entry): entry is string => typeof entry === "string") : [];
			if (record.status !== "completed" || failures.length) seen.push({ stage: record.stage, status: record.status, failures: failures.map(classifyFailure) });
		}
		visit(item.stage);
		visit(item.feedback);
	};
	visit(value);
	return seen.length ? opaque(seen) : undefined;
}

export function thrownSignature(error: unknown): string {
	const value = error as { code?: unknown; message?: unknown };
	if (typeof value?.code === "string") return opaque({ code: value.code });
	return opaque({ code: "error", category: classifyFailure(typeof value?.message === "string" ? value.message : String(error)) });
}

export class RetryGuard {
	private readonly file: string;
	constructor(workspace: string) { this.file = path.join(workspace, ".agent", "control", "retry-guard.json"); }

	private async read(): Promise<Ledger> {
		try { return JSON.parse(await readFile(this.file, "utf8")) as Ledger; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, failures: [] }; throw error; }
	}

	private async write(ledger: Ledger): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		await writeFile(this.file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
	}

	async assertAllowed(fingerprint: string): Promise<void> {
		const state = (await this.read()).failures.find((entry) => entry.fingerprint === fingerprint);
		if (state && state.consecutive >= 2) throw new HarnessError("control.retry-loop", "相同研究义务已连续得到同一失败两次；请提供新的证据、修正实际输入/命令或改变处理方案后再试，不能原样盲重试");
	}

	async success(fingerprint: string): Promise<void> {
		const ledger = await this.read();
		const failures = ledger.failures.filter((entry) => entry.fingerprint !== fingerprint);
		if (failures.length !== ledger.failures.length) await this.write({ version: 1, failures });
	}

	async failure(fingerprint: string, signature: string): Promise<void> {
		const ledger = await this.read();
		const prior = ledger.failures.find((entry) => entry.fingerprint === fingerprint);
		const next: FailureState = { fingerprint, signature, consecutive: prior?.signature === signature ? prior.consecutive + 1 : 1, updatedAt: new Date().toISOString() };
		await this.write({ version: 1, failures: [...ledger.failures.filter((entry) => entry.fingerprint !== fingerprint), next] });
	}
}
