/**
 * M04 纠错、知识记录与状态更新.
 *
 * Boundary (foundation, M04 本轮已对齐): the main agent organises, the research
 * session does the substantive judgement. The first round may continue the M01
 * session; later rounds use a fresh research session that only receives the
 * current knowledge pack, the feedback and the artifact locations. One feedback
 * batch is the minimal unit. Proposals are validated structurally and merged
 * through the single serial entry; merging is never a truth certificate.
 */
import path from "node:path";
import type { ProposalOp } from "../knowledge/types.ts";
import { buildM04Message, extractKnowledgeProposals, systemPromptFor } from "../prompts.ts";
import { HarnessError, type InputRef, type StageRunRecord } from "../types.ts";
import { readTextIfExists } from "../workspace.ts";
import { loadProblemMaterials, readOutput, recordSession, relPath, requireCompletedRun, sessionSpec, withRun, type StageContext } from "./context.ts";
import { specFileFor } from "./m03.ts";

export type M04Feedback =
	| { kind: "M03"; runId?: string }
	| { kind: "M06"; runId?: string }
	| { kind: "M07"; runId?: string }
	| { kind: "file"; label: string; path: string };

export interface M04Options {
	feedback: M04Feedback;
	/** Force a fresh research session even if the first round could continue M01. */
	freshSession?: boolean;
	/** Purpose string recorded in the knowledge pack. */
	purpose?: string;
}

export interface M04Result {
	record: StageRunRecord;
	output: string;
	proposalId?: string;
	snapshotId?: string;
	mode: "continue-m01" | "research-session";
}

interface ResolvedFeedback {
	label: string;
	text: string;
	inputs: InputRef[];
	artifactPaths: string[];
}

async function resolveFeedback(ctx: StageContext, feedback: M04Feedback): Promise<ResolvedFeedback> {
	if (feedback.kind === "M03") {
		const run = await requireCompletedRun(ctx, "M03", feedback.runId);
		const evaluation = await readOutput(run, "逐题评价");
		const questions = await readOutput(run, "可转发问题");
		const answers = await readOutput(run, "执行会话完整回答");
		return {
			label: `M03 外部评价（运行 ${run.runId}）`,
			text: `${evaluation.text}\n\n【本轮质询问题（供定位）】\n${questions.text}`,
			inputs: [
				{ label: "M03 逐题评价", path: evaluation.path },
				{ label: "M03 可转发问题", path: questions.path },
				{ label: "M03 完整回答", path: answers.path },
			],
			artifactPaths: [relPath(ctx, evaluation.path), relPath(ctx, questions.path), relPath(ctx, answers.path)],
		};
	}
	if (feedback.kind === "M06") {
		const run = await requireCompletedRun(ctx, "M06", feedback.runId);
		const summary = await readOutput(run, "整批汇总");
		return {
			label: `M06 整批材料处理建议（运行 ${run.runId}）`,
			text: summary.text,
			inputs: [{ label: "M06 整批汇总", path: summary.path }, ...run.outputs.filter((o) => o.label !== "整批汇总").map((o) => ({ label: `M06 ${o.label}`, path: o.path }))],
			artifactPaths: run.outputs.map((o) => relPath(ctx, o.path)),
		};
	}
	if (feedback.kind === "M07") {
		let run: StageRunRecord;
		if (feedback.runId) run = await ctx.ws.readRun("M07", feedback.runId);
		else {
			const ids = await ctx.ws.listRuns("M07");
			if (!ids.length) throw new HarnessError("run.missing", "没有 M07 运行");
			run = await ctx.ws.readRun("M07", ids.at(-1)!);
		}
		if (run.status === "running") throw new HarnessError("run.incomplete", `M07 运行 ${run.runId} 尚未结束，不能作为输入`);
		const bundle = await readOutput(run, "M07 实际执行反馈包");
		return {
			label: `M07 实际执行反馈（运行 ${run.runId}）`,
			text: bundle.text,
			inputs: [{ label: "M07 实际执行反馈包", path: bundle.path }, ...run.outputs.filter((o) => o.label !== "M07 实际执行反馈包").map((o) => ({ label: `M07 ${o.label}`, path: o.path }))],
			artifactPaths: run.outputs.map((o) => relPath(ctx, o.path)),
		};
	}
	const text = await readTextIfExists(feedback.path);
	if (!text) throw new HarnessError("m04.feedback", `找不到意见文件 ${feedback.path}`);
	return { label: feedback.label, text, inputs: [{ label: feedback.label, path: feedback.path }], artifactPaths: [relPath(ctx, feedback.path)] };
}

export async function runM04(ctx: StageContext, options: M04Options): Promise<M04Result> {
	const feedback = await resolveFeedback(ctx, options.feedback);
	const { materials, inputs: problemInputs } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const previousM04 = await ctx.ws.latestCompletedRun("M04");
	const m01 = await ctx.ws.latestCompletedRun("M01");
	const m01Session = m01?.sessions.find((s) => s.label === "M01");
	const continueM01 = feedback.label.startsWith("M07 ") ? false : !options.freshSession && !previousM04 && !!m01Session?.file;
	const mode: M04Result["mode"] = continueM01 ? "continue-m01" : "research-session";

	const record = await ctx.ws.startRun("M04", [...problemInputs, ...feedback.inputs], snapshot?.id);
	record.remarks.push(mode === "continue-m01" ? "首轮 M04：续接 M01 原会话。" : "新建研究会话，只读取当前知识包、意见与实际产物位置。");

	return withRun(
		ctx,
		record,
		async () => {
			let knowledgePack: string | undefined;
			if (mode === "research-session") {
				const pack = await ctx.store.buildPack({ purpose: options.purpose ?? `M04 处理：${feedback.label}`, includeOpenQuestions: true, types: ["C", "K", "E", "J", "Q", "D", "X"], maxChars: 60_000 });
				knowledgePack = pack.markdown;
				await ctx.ws.writeOutput(record, "knowledge-pack.md", pack.markdown, "提供给研究会话的局部知识包");
				if (pack.truncated) record.remarks.push(`知识包按长度截断，未展开：${pack.omitted.join(", ")}`);
			}
			const message = await buildM04Message({ materials, feedbackLabel: feedback.label, feedback: feedback.text, artifactPaths: feedback.artifactPaths, knowledgePack, includeProblem: mode === "research-session" });
			await ctx.ws.writeOutput(record, "message.md", message, "发送给研究会话的完整消息");

			const handle =
				mode === "continue-m01" && m01Session?.file
					? await ctx.runner.resume({ label: "M01", role: "execution", id: m01Session.id, model: m01Session.model, file: m01Session.file, specFile: specFileFor(m01Session.file) })
					: await ctx.runner.create(sessionSpec(ctx, "M04-research", "research", systemPromptFor("research"), { kind: "none" }));
			let output: string;
			try {
				recordSession(record, handle);
				const turn = await handle.prompt(message);
				output = turn.text;
				await ctx.ws.writeOutput(record, "processing.md", output, "处理结果");
			} finally {
				handle.dispose();
			}

			const result: M04Result = { record, output, mode };
			const extracted = extractKnowledgeProposals(output);
			if (extracted.error) {
				record.failures.push(`知识提案未入库：${extracted.error}`);
			} else if (extracted.ops) {
				const receipt = await ctx.store.submitProposal({ stage: "M04", runId: record.runId, session: handle.ref.label, baseSnapshot: snapshot?.id, ops: extracted.ops as ProposalOp[], summary: feedback.label });
				result.proposalId = receipt.proposalId;
				record.outputs.push({ label: "知识提案", path: receipt.file });
				if (receipt.structurallyValid) {
					const merged = await ctx.store.merge(receipt.proposalId);
					result.snapshotId = merged.snapshot.id;
					await ctx.ws.writeOutput(record, "merge.json", JSON.stringify(merged, null, 2), "合入结果");
					record.remarks.push(`已经串行合入，快照 ${merged.snapshot.id}；受影响待复核 ${merged.impacts.length} 项；先行生效的限制 ${merged.limitsWrittenFirst.length} 项。合入不是科学认证。`);
					await ctx.store.regenerateViews();
				} else {
					record.failures.push(`知识提案未合入：结构校验未通过：${receipt.issues.filter((i) => i.level === "error").map((i) => i.message).join("；")}`);
				}
			} else {
				record.remarks.push("本轮没有知识提案；处理结果只以文本保存（没有知识变化也可完成）。");
			}
			return result;
		},
		() =>
			`按 P04 处理“${feedback.label}”。${mode === "continue-m01" ? "续接 M01 原会话" : "新建研究会话并提供局部知识包"}；保存处理结果；如有结构合法的知识提案则经单一串行入口合入并发布快照。意见来源：${feedback.inputs.map((i) => path.basename(i.path)).join("、")}。`,
	);
}
