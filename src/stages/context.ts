import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import type { KnowledgeStore } from "../knowledge/types.ts";
import type { ProblemMaterials } from "../prompts.ts";
import type { SessionHandle, SessionRunner, SessionSpec, ToolGrant } from "../runner/types.ts";
import { HarnessError, type HarnessConfig, type InputRef, type Role, type StageRunRecord } from "../types.ts";
import type { Workspace } from "../workspace.ts";

export interface StageContext {
	ws: Workspace;
	runner: SessionRunner;
	store: KnowledgeStore;
	config: HarnessConfig;
}

export async function loadProblemMaterials(ws: Workspace): Promise<{ materials: ProblemMaterials; inputs: InputRef[]; skipped: string[] }> {
	const problem = await ws.readProblem();
	const raw = await ws.readRawInfo();
	const inputs: InputRef[] = [{ label: "原始问题", path: problem.path }, ...raw.items.map((r) => ({ label: `必要原始信息 ${r.name}`, path: r.path }))];
	return {
		materials: { problem: problem.content, rawInfo: raw.items.map((r) => ({ name: r.name, content: r.content })) },
		inputs,
		skipped: raw.skipped,
	};
}

export function sessionSpec(ctx: StageContext, label: string, role: Role, systemPrompt: string, tools: ToolGrant): SessionSpec {
	return { label, role, model: resolveRoleModel(ctx.config, role), systemPrompt, tools, persistDir: ctx.ws.sessionsDir };
}

export function recordSession(record: StageRunRecord, handle: SessionHandle): void {
	record.sessions.push({ label: handle.ref.label, role: handle.ref.role, id: handle.ref.id, file: handle.ref.file, model: handle.ref.model });
}

export async function readOutput(record: StageRunRecord, label: string): Promise<{ path: string; text: string }> {
	const ref = record.outputs.find((o) => o.label === label);
	if (!ref) throw new HarnessError("output.missing", `${record.stage} 运行 ${record.runId} 没有产物 ${label}`);
	return { path: ref.path, text: await readFile(ref.path, "utf8") };
}

export async function requireCompletedRun(ctx: StageContext, stage: string, runId?: string): Promise<StageRunRecord> {
	if (runId) {
		const record = await ctx.ws.readRun(stage, runId);
		if (record.status !== "completed") throw new HarnessError("run.incomplete", `${stage} 运行 ${runId} 状态为 ${record.status}，不能作为输入`);
		return record;
	}
	const latest = await ctx.ws.latestCompletedRun(stage);
	if (!latest) throw new HarnessError("run.missing", `没有已完成的 ${stage} 运行；请先执行 ${stage.toLowerCase()}`);
	return latest;
}

export function relPath(ctx: StageContext, target: string): string {
	const rel = path.relative(ctx.ws.root, target);
	return rel.startsWith("..") ? target : rel;
}

/** Wrap a stage body so failures are always recorded in run.json and the note before rethrowing. */
export async function withRun<T>(ctx: StageContext, record: StageRunRecord, body: () => Promise<T>, noteBody: () => string): Promise<T> {
	try {
		const result = await body();
		await ctx.ws.finishRun(record, "completed");
		await ctx.ws.writeNote(record, noteBody());
		return result;
	} catch (error) {
		record.failures.push(`运行失败：${(error as Error).message}`);
		await ctx.ws.finishRun(record, "failed");
		await ctx.ws.writeNote(record, noteBody());
		throw error;
	}
}
