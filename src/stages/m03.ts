/**
 * M03 外部质询、回答与评价 (automatic cross-session orchestration).
 *
 * Boundary (foundation, M03 本轮已对齐):
 * 1. a brand-new reviewer session receives the problem, raw info, and the complete
 *    M01/M02 outputs, generates forwardable questions and keeps its rationale;
 * 2. the original M01 session receives the complete M02 output together with the
 *    forwardable questions in one message and answers in full;
 * 3. the same reviewer session evaluates the full answers.
 * The rationale/expected answers never enter the answering session. Everything
 * is saved for M04; nothing here decides what is correct.
 */
import { buildM03AnswerMessage, buildM03EvaluationMessage, buildM03QuestionMessage, rationaleLeaks, splitM03Questions, systemPromptFor } from "../prompts.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { loadProblemMaterials, readOutput, recordSession, requireCompletedRun, sessionSpec, withRun, type StageContext } from "./context.ts";

export interface M03Options {
	m01RunId?: string;
	m02RunId?: string;
}

export interface M03Result {
	record: StageRunRecord;
	questions: string;
	answers: string;
	evaluation: string;
}

export async function runM03(ctx: StageContext, options: M03Options = {}): Promise<M03Result> {
	const m01 = await requireCompletedRun(ctx, "M01", options.m01RunId);
	const m02 = await requireCompletedRun(ctx, "M02", options.m02RunId);
	const m01Output = await readOutput(m01, "初始认识");
	const m02Output = await readOutput(m02, "候选判据");
	const m01Session = m01.sessions.find((s) => s.label === "M01");
	if (!m01Session?.file) throw new HarnessError("m03.input", "M01 运行没有可续接的会话记录");
	const m01File = m01Session.file;

	const { materials, inputs } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const record = await ctx.ws.startRun(
		"M03",
		[...inputs, { label: `M01 初始认识（运行 ${m01.runId}）`, path: m01Output.path }, { label: `M02 候选判据（运行 ${m02.runId}）`, path: m02Output.path }],
		snapshot?.id,
	);

	return withRun(
		ctx,
		record,
		async () => {
			// 1. reviewer generates questions
			const reviewer = await ctx.runner.create(sessionSpec(ctx, "M03-reviewer", "reviewer", systemPromptFor("reviewer"), { kind: "none" }));
			let questions: string;
			let rationale: string;
			try {
				recordSession(record, reviewer);
				const qMessage = await buildM03QuestionMessage(materials, m01Output.text, m02Output.text);
				await ctx.ws.writeOutput(record, "reviewer-question-message.md", qMessage, "发送给评审会话的出题消息");
				const qTurn = await reviewer.prompt(qMessage);
				await ctx.ws.writeOutput(record, "reviewer-question-output.md", qTurn.text, "评审会话出题原始输出");
				({ questions, rationale } = splitM03Questions(qTurn.text));
				await ctx.ws.writeOutput(record, "questions.md", questions, "可转发问题");
				await ctx.ws.writeOutput(record, "rationale.md", `> 本文件是评审会话保留的出题说明与判断依据，不进入作答会话。\n\n${rationale}`, "出题说明与判断依据（不转发）");
			} finally {
				reviewer.dispose();
			}

			// 2. original M01 session answers (M02 output + questions in one message)
			const answerMessage = buildM03AnswerMessage(m02Output.text, questions);
			if (rationaleLeaks(rationale, answerMessage)) {
				throw new HarnessError("m03.leak", "作答消息包含出题依据的整行内容，已中止转发");
			}
			const execution = await ctx.runner.resume({ label: "M01", role: "execution", id: m01Session.id, model: m01Session.model, file: m01File, specFile: specFileFor(m01File) });
			let answers: string;
			try {
				recordSession(record, execution);
				await ctx.ws.writeOutput(record, "answer-message.md", answerMessage, "发送给 M01 原会话的作答消息");
				const aTurn = await execution.prompt(answerMessage);
				answers = aTurn.text;
				await ctx.ws.writeOutput(record, "answers.md", answers, "执行会话完整回答");
			} finally {
				execution.dispose();
			}

			// 3. same reviewer session evaluates
			const reviewerRef = record.sessions[0];
			const reviewerAgain = await ctx.runner.resume({ ...reviewerRef, specFile: reviewerRef.file ? specFileFor(reviewerRef.file) : undefined });
			let evaluation: string;
			try {
				const eMessage = await buildM03EvaluationMessage(answers);
				await ctx.ws.writeOutput(record, "evaluation-message.md", eMessage, "发送给评审会话的评价消息");
				const eTurn = await reviewerAgain.prompt(eMessage);
				evaluation = eTurn.text;
				await ctx.ws.writeOutput(record, "evaluation.md", evaluation, "逐题评价");
			} finally {
				reviewerAgain.dispose();
			}

			record.remarks.push("出题、作答、评价三份产物统一进入 M04；本阶段不裁定对错，也不要求评审与执行一致。");
			return { record, questions, answers, evaluation };
		},
		() => "新建评审会话按 P03Q 出题并保留出题依据；把 M02 完整产出与可转发问题一次送回 M01 原会话作答；完整回答送回同一评审会话按 P03A 评价。出题依据未进入作答会话。",
	);
}

export function specFileFor(sessionFile: string): string {
	return sessionFile.replace(/\.jsonl$/, ".spec.json");
}
