/** The model's own understanding of the task, frozen for reuse in later stages.
 *
 * M01 builds an independent initial understanding and M03 challenges it. Both
 * are documents the workflow already produces; what was missing is that later
 * stages could only see them indirectly, through whatever M04 chose to carry.
 * This module reads those two outputs, bounds them, and renders one block that
 * belongs near the front of a prompt: it is stable for the whole goal, so it
 * keeps the prefix identical between rounds instead of moving with the round's
 * own material.
 *
 * Nothing here judges the understanding. A bounded excerpt is an excerpt: the
 * exact source paths travel with it so a session can read the whole thing. */
import path from "node:path";
import { section } from "./prompts.ts";
import { readOutput } from "./stages/context.ts";
import type { Workspace } from "./workspace.ts";
import { writeFileAtomic } from "./workspace.ts";

/** Character allowances for the block. Generous enough for a real
 * understanding document, bounded so a prompt cannot be swallowed by it. */
export const UNDERSTANDING_LIMITS = Object.freeze({ understanding: 12_000, evaluation: 6_000 });

export interface FrozenUnderstandingV1 {
	version: 1;
	kind: "m07-understanding-snapshot";
	/** The M01 run whose initial understanding was frozen. */
	m01RunId: string;
	m01Path: string;
	understandingChars: number;
	understandingOmitted: number;
	/** The M03 run whose per-question evaluation was frozen, when one exists. */
	m03RunId?: string;
	m03Path?: string;
	evaluationChars?: number;
	evaluationOmitted?: number;
	/** Frozen copy of the rendered block; the bytes a prompt uses. */
	snapshotPath: string;
}

const bounded = (text: string, limit: number): { text: string; omitted: number } => {
	const trimmed = text.trim();
	return trimmed.length <= limit
		? { text: trimmed, omitted: 0 }
		: { text: trimmed.slice(0, limit), omitted: trimmed.length - limit };
};

export interface UnderstandingSource {
	m01RunId: string;
	m01Path: string;
	understanding: string;
	understandingOmitted: number;
	m03RunId?: string;
	m03Path?: string;
	evaluation?: string;
	evaluationOmitted?: number;
}

/** Read the latest completed M01 understanding and, when present, the latest
 * completed M03 evaluation. Absent or unreadable material yields nothing: an
 * invented understanding would be worse than none. */
export async function latestUnderstanding(ws: Workspace): Promise<UnderstandingSource | undefined> {
	const m01 = await ws.latestCompletedRun("M01").catch(() => undefined);
	if (!m01) return undefined;
	let understanding;
	try { understanding = await readOutput(m01, "初始认识"); }
	catch { return undefined; }
	const initial = bounded(understanding.text, UNDERSTANDING_LIMITS.understanding);
	if (!initial.text) return undefined;
	const source: UnderstandingSource = { m01RunId: m01.runId, m01Path: understanding.path,
		understanding: initial.text, understandingOmitted: initial.omitted };
	const m03 = await ws.latestCompletedRun("M03").catch(() => undefined);
	if (m03) {
		try {
			const evaluation = await readOutput(m03, "逐题评价");
			const challenged = bounded(evaluation.text, UNDERSTANDING_LIMITS.evaluation);
			if (challenged.text) Object.assign(source, { m03RunId: m03.runId, m03Path: evaluation.path,
				evaluation: challenged.text, evaluationOmitted: challenged.omitted });
		} catch { /* An M03 run without a usable evaluation simply contributes none. */ }
	}
	return source;
}

/** Render the block. Paths are workspace-relative so the text does not change
 * with the absolute location of the workspace. */
export function understandingBlock(source: UnderstandingSource, root: string): string {
	const display = (file: string) => path.relative(root, file);
	const parts = [
		section("本任务的已有认识（M01 初始认识，冻结自目标开始时）",
			[`来源：${display(source.m01Path)}（M01 运行 ${source.m01RunId}）${source.understandingOmitted
				? `；此处为前 ${source.understanding.length} 字符，另有 ${source.understandingOmitted} 字符未显示，需要时读原文`
				: ""}`,
				"这是模型自己此前形成的认识，不是已核验事实；与实测证据冲突时以证据为准，并在报告里说明认识的变化。",
				source.understanding].join("\n\n")),
	];
	if (source.evaluation) parts.push(section("对该认识的质询与评价要点（M03）",
		[`来源：${display(source.m03Path!)}（M03 运行 ${source.m03RunId}）${source.evaluationOmitted
			? `；此处为前 ${source.evaluation.length} 字符，另有 ${source.evaluationOmitted} 字符未显示`
			: ""}`,
			"质询意见同样不是结论；它标出的薄弱处需要本轮用实际证据处理或明确记为未决。",
			source.evaluation].join("\n\n")));
	return parts.join("\n\n");
}

/** Freeze the block for one M07 goal. The frozen file is what later rounds
 * read, so the prefix stays byte-identical even if M01 or M03 run again. */
export async function freezeUnderstanding(ws: Workspace, source: UnderstandingSource,
	snapshotPath: string): Promise<FrozenUnderstandingV1> {
	await writeFileAtomic(snapshotPath, `${understandingBlock(source, ws.root)}\n`);
	return { version: 1, kind: "m07-understanding-snapshot", m01RunId: source.m01RunId,
		m01Path: source.m01Path, understandingChars: source.understanding.length,
		understandingOmitted: source.understandingOmitted,
		...(source.m03RunId ? { m03RunId: source.m03RunId, m03Path: source.m03Path,
			evaluationChars: source.evaluation!.length, evaluationOmitted: source.evaluationOmitted ?? 0 } : {}),
		snapshotPath };
}
