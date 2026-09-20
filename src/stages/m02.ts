/**
 * M02 候选判据首次准备.
 *
 * Boundary (foundation, M02 本轮已对齐): same execution model as M01, a new
 * independent session that inherits no history; inputs are the original problem,
 * the necessary raw information, the complete visible M01 output and P02. The
 * candidate criteria are stored verbatim and, when the session emits them as
 * K proposals, merged into the knowledge store as candidates only.
 */
import type { ProposalOp } from "../knowledge/types.ts";
import { buildM02Message, extractKnowledgeProposals, join, KNOWLEDGE_PROPOSALS_FENCE, systemPromptFor } from "../prompts.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { M01_OUTPUT } from "./m01.ts";
import { loadProblemMaterials, readOutput, recordSession, relPath, requireCompletedRun, sessionSpec, withRun, type StageContext } from "./context.ts";

export const M02_OUTPUT = "criteria-candidates.md";

export interface M02Options {
	m01RunId?: string;
}

export interface M02Result {
	record: StageRunRecord;
	output: string;
	proposalId?: string;
	snapshotId?: string;
}

export function m02ProposalInstructions(): string {
	return `保存方式：在文字候选判据之后，追加一个 \`\`\`${KNOWLEDGE_PROPOSALS_FENCE} 代码块，内容为 JSON 数组，把每条候选判据写成一个 {"op":"create","type":"K","title":"简短名称","body":"检查对象、判据内容、依据、成立条件、检查办法、满足或违反分别说明什么、不能说明什么","fields":{"category":"定义类型量纲|必要约束|特例退化极限|适用边界区分|数量级标度界","nature":"必要约束|条件性约束|诊断性预期"},"usageDecision":"candidate","evidenceStatus":"本轮推导或题设"} 操作。全部是候选，不写成正式采用状态。`;
}

export async function runM02(ctx: StageContext, options: M02Options = {}): Promise<M02Result> {
	const m01 = await requireCompletedRun(ctx, "M01", options.m01RunId);
	const m01Output = await readOutput(m01, "初始认识");
	const m01Session = m01.sessions.find((s) => s.label === "M01");
	if (!m01Session) throw new HarnessError("m02.input", "M01 运行没有记录执行会话");

	const { materials, inputs, skipped } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const record = await ctx.ws.startRun("M02", [...inputs, { label: `M01 初始认识（运行 ${m01.runId}）`, path: m01Output.path }], snapshot?.id);
	for (const name of skipped) record.failures.push(`未纳入非文本原始信息 ${name}`);

	return withRun(
		ctx,
		record,
		async () => {
			const spec = sessionSpec(ctx, "M02", "execution", systemPromptFor("execution"), { kind: "none" });
			if (spec.model !== m01Session.model) {
				throw new HarnessError("m02.model", `M02 必须使用与 M01 相同的模型：M01 用 ${m01Session.model}，当前配置为 ${spec.model}`);
			}
			const message = join(await buildM02Message(materials, m01Output.text), m02ProposalInstructions());
			const handle = await ctx.runner.create(spec);
			let result: M02Result;
			try {
				recordSession(record, handle);
				await ctx.ws.writeOutput(record, "message.md", message, "发送给 M02 会话的完整消息");
				const turn = await handle.prompt(message);
				await ctx.ws.writeOutput(record, M02_OUTPUT, turn.text, "候选判据");
				result = { record, output: turn.text };
			} finally {
				handle.dispose();
			}

			const extracted = extractKnowledgeProposals(result.output);
			if (extracted.error) record.failures.push(`候选判据未入库：${extracted.error}`);
			if (extracted.ops) {
				const ops = extracted.ops as ProposalOp[];
				const bad = ops.filter((op) => !(op && (op as { op?: string }).op === "create" && (op as { type?: string }).type === "K"));
				if (bad.length) {
					record.failures.push(`候选判据未入库：M02 只允许 create K 操作，收到 ${bad.length} 个其他操作`);
				} else {
					const normalised = ops.map((op) => ({ ...(op as Extract<ProposalOp, { op: "create" }>), usageDecision: "candidate" as const }));
					const receipt = await ctx.store.submitProposal({ stage: "M02", runId: record.runId, session: "M02", baseSnapshot: snapshot?.id, ops: normalised, summary: "M02 候选判据首次准备" });
					result.proposalId = receipt.proposalId;
					record.remarks.push(`知识提案 ${receipt.proposalId}：${relPath(ctx, receipt.file)}`);
					if (receipt.structurallyValid) {
						const merged = await ctx.store.merge(receipt.proposalId);
						result.snapshotId = merged.snapshot.id;
						record.remarks.push(`已合入为候选判据，快照 ${merged.snapshot.id}（入库不等于验收）`);
						await ctx.store.regenerateViews();
					} else {
						record.failures.push(`候选判据未入库：结构校验未通过：${receipt.issues.map((i) => i.message).join("；")}`);
					}
				}
			} else {
				record.remarks.push("M02 输出没有 knowledge-proposals 代码块，候选判据只以文本保存。");
			}
			return result;
		},
		() => "新建 M02 执行会话（与 M01 相同模型，不继承 M01 历史），发送 P02、原始问题、必要原始信息与 M01 完整产出；原样保存候选判据；如有 K 提案则以 candidate 状态经串行合入入库。",
	);
}
