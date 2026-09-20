/**
 * M01 独立初始认识.
 *
 * Boundary (foundation, M01 本轮已对齐): one independent session; only the original
 * problem and the necessary raw information; no external retrieval; the execution
 * model needs strong knowledge and reasoning but is chosen by the user through the
 * config. Output is kept verbatim and the session is kept for M03 answering and the
 * first M04 round. Nobody has to approve the output before M02.
 */
import { buildM01Message, systemPromptFor } from "../prompts.ts";
import type { StageRunRecord } from "../types.ts";
import { loadProblemMaterials, recordSession, sessionSpec, withRun, type StageContext } from "./context.ts";

export const M01_OUTPUT = "initial-understanding.md";

export interface M01Result {
	record: StageRunRecord;
	output: string;
}

export async function runM01(ctx: StageContext): Promise<M01Result> {
	const { materials, inputs, skipped } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const record = await ctx.ws.startRun("M01", inputs, snapshot?.id);
	for (const name of skipped) record.failures.push(`未纳入非文本原始信息 ${name}；需要先提取为文本`);
	record.remarks.push("本阶段不执行外部检索；会话未加载任何 context 文件、skills、extensions 或知识库。");

	return withRun(
		ctx,
		record,
		async () => {
			const message = await buildM01Message(materials);
			const handle = await ctx.runner.create(sessionSpec(ctx, "M01", "execution", systemPromptFor("execution"), { kind: "none" }));
			try {
				recordSession(record, handle);
				await ctx.ws.writeOutput(record, "message.md", message, "发送给 M01 会话的完整消息");
				const turn = await handle.prompt(message);
				await ctx.ws.writeOutput(record, M01_OUTPUT, turn.text, "初始认识");
				return { record, output: turn.text };
			} finally {
				handle.dispose();
			}
		},
		() => "新建 M01 执行会话，发送 P01 与原始问题、必要原始信息；原样保存回答。未做外部检索，未加载旧项目结论。完成标准是“具体到可以追问”，不代表正确性已确认。",
	);
}
