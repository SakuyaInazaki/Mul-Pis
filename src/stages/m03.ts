/** M03 independent external question, serial answer, and same-session evaluation batch. */
import { buildM03AnswerMessage, buildM03EvaluationMessage, buildM03QuestionMessage, rationaleLeaks, splitM03Questions, systemPromptFor } from "../prompts.ts";
import type { SessionRef, SessionSpec } from "../runner/types.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { loadProblemMaterials, readOutput, recordSession, requireCompletedRun, sessionSpec, withRun, type StageContext } from "./context.ts";

export interface M03Options { m01RunId?: string; m02RunId?: string }
export interface M03MemberResult {
	id: string; model: string; session?: SessionRef;
	status: "pending" | "questions-completed" | "answered" | "completed" | "failed";
	questions?: string; rationale?: string; answer?: string; evaluation?: string; failure?: string;
}
export interface M03Result { record: StageRunRecord; questions: string; answers: string; evaluation: string; members: M03MemberResult[] }

function reviewers(ctx: StageContext): Array<{ id: string; model: string; legacy: boolean }> {
	if (ctx.config.m03Reviewers?.length) return ctx.config.m03Reviewers.map((item) => ({ ...item, legacy: false }));
	const base = sessionSpec(ctx, "M03-reviewer", "reviewer", systemPromptFor("reviewer"), { kind: "none" });
	return [{ id: "R1", model: base.model, legacy: true }];
}

function memberSpec(ctx: StageContext, member: { id: string; model: string; legacy: boolean }): SessionSpec {
	if (member.legacy) return sessionSpec(ctx, "M03-reviewer", "reviewer", systemPromptFor("reviewer"), { kind: "none" });
	return { label: `M03-reviewer-${member.id}`, role: "reviewer", model: member.model, systemPrompt: systemPromptFor("reviewer"), tools: { kind: "none" }, persistDir: ctx.ws.sessionsDir };
}

function aggregate(title: string, members: M03MemberResult[], field: "questions" | "rationale" | "answer" | "evaluation"): string {
	if (members.length === 1) return members[0][field] ?? "未完成";
	return members.map((member) => `## ${title} ${member.id}（${member.model}；独立会话 ${member.session?.id ?? "未创建"}）\n\n${member[field] ?? "未完成"}`).join("\n\n");
}

function manifest(members: M03MemberResult[]): string {
	return JSON.stringify({ members: members.map(({ id, model, session, status, failure }) => ({ id, model, sessionId: session?.id, status, failure })) }, null, 2);
}

export async function runM03(ctx: StageContext, options: M03Options = {}): Promise<M03Result> {
	const m01 = await requireCompletedRun(ctx, "M01", options.m01RunId);
	const m02 = await requireCompletedRun(ctx, "M02", options.m02RunId);
	const m01Output = await readOutput(m01, "初始认识");
	const m02Output = await readOutput(m02, "候选判据");
	const m01Session = m01.sessions.find((session) => session.label === "M01");
	if (!m01Session?.file) throw new HarnessError("m03.input", "M01 运行没有可续接的会话记录");
	const m01File = m01Session.file;
	const { materials, inputs } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const record = await ctx.ws.startRun("M03", [...inputs, { label: `M01 初始认识（运行 ${m01.runId}）`, path: m01Output.path }, { label: `M02 候选判据（运行 ${m02.runId}）`, path: m02Output.path }], snapshot?.id);
	const configured = reviewers(ctx);
	const members: M03MemberResult[] = configured.map(({ id, model }) => ({ id, model, status: "pending" }));

	return withRun(ctx, record, async () => {
		try {
			for (let index = 0; index < configured.length; index++) {
				const configuredMember = configured[index]; const member = members[index];
				let handle;
				try {
					handle = await ctx.runner.create(memberSpec(ctx, configuredMember));
					recordSession(record, handle); member.session = handle.ref;
					const message = await buildM03QuestionMessage(materials, m01Output.text, m02Output.text);
					await ctx.ws.writeOutput(record, `reviewer-${member.id}-question-message.md`, message, `发送给评审 ${member.id} 的出题消息`);
					const turn = await handle.prompt(message);
					await ctx.ws.writeOutput(record, `reviewer-${member.id}-question-output.md`, turn.text, `评审 ${member.id} 出题原始输出`);
					const split = splitM03Questions(turn.text); member.questions = split.questions; member.rationale = split.rationale;
					await ctx.ws.writeOutput(record, `reviewer-${member.id}-questions.md`, split.questions, `评审 ${member.id} 可转发问题`);
					await ctx.ws.writeOutput(record, `reviewer-${member.id}-rationale.md`, `> 本文件是评审 ${member.id} 保留的出题说明与判断依据，不进入作答会话。\n\n${split.rationale}`, `评审 ${member.id} 出题说明与判断依据（不转发）`);
					member.status = "questions-completed";
				} catch (error) { member.status = "failed"; member.failure = (error as Error).message; throw error; }
				finally { handle?.dispose(); }
			}
			await ctx.ws.writeOutput(record, "rationale.md", aggregate("评审出题说明与判断依据", members, "rationale"), "出题说明与判断依据（不转发）");

			const execution = await ctx.runner.resume({ label: "M01", role: "execution", id: m01Session.id, model: m01Session.model, file: m01File, specFile: specFileFor(m01File) });
			try {
				recordSession(record, execution);
				for (let index = 0; index < members.length; index++) {
					const member = members[index];
					try {
						const message = buildM03AnswerMessage(index === 0 ? m02Output.text : undefined, member.questions!);
						if (rationaleLeaks(member.rationale!, message)) throw new HarnessError("m03.leak", `评审 ${member.id} 的作答消息包含出题依据，已中止转发`);
						await ctx.ws.writeOutput(record, `reviewer-${member.id}-answer-message.md`, message, `发送给 M01 原会话的 ${member.id} 作答消息`);
						const answer = (await execution.prompt(message)).text; member.answer = answer; member.status = "answered";
						await ctx.ws.writeOutput(record, `reviewer-${member.id}-answer.md`, answer, `执行会话对评审 ${member.id} 的完整回答`);
					} catch (error) { member.status = "failed"; member.failure = (error as Error).message; throw error; }
				}
			} finally { execution.dispose(); }

			for (const member of members) {
				if (!member.session) throw new HarnessError("m03.session", `评审 ${member.id} 缺少会话记录`);
				const handle = await ctx.runner.resume({ ...member.session, specFile: member.session.file ? specFileFor(member.session.file) : undefined });
				try {
					handle.setRunContext?.({ stage: record.stage, runId: record.runId });
					const message = await buildM03EvaluationMessage(member.answer!);
					await ctx.ws.writeOutput(record, `reviewer-${member.id}-evaluation-message.md`, message, `发送给评审 ${member.id} 的评价消息`);
					member.evaluation = (await handle.prompt(message)).text; member.status = "completed";
					await ctx.ws.writeOutput(record, `reviewer-${member.id}-evaluation.md`, member.evaluation, `评审 ${member.id} 逐题评价`);
				} catch (error) { member.status = "failed"; member.failure = (error as Error).message; throw error; }
				finally { handle.dispose(); }
			}

			const questions = aggregate("评审问题", members, "questions");
			const answers = aggregate("对应回答", members, "answer");
			const evaluation = aggregate("逐题评价", members, "evaluation");
			await ctx.ws.writeOutput(record, "questions.md", questions, "可转发问题");
			await ctx.ws.writeOutput(record, "answers.md", answers, "执行会话完整回答");
			await ctx.ws.writeOutput(record, "evaluation.md", evaluation, "逐题评价");
			await ctx.ws.writeOutput(record, "members.json", manifest(members), "M03 成员清单");
			record.remarks.push(`${members.length} 个独立评审会话全部完成；重复模型只表示同模型多会话模拟，不表示多个不同 AI。回答由原 M01 会话逐组串行完成，各评审只收到自己的回答。`);
			return { record, questions, answers, evaluation, members };
		} catch (error) {
			await ctx.ws.writeOutput(record, "members.json", manifest(members), "M03 成员清单");
			throw error;
		}
	}, () => "各独立评审先基于同一输入出题；原 M01 会话逐组串行作答；每名评审只在自己的原会话中收到并评价自己的回答。全部成员完成后才聚合送往 M04。" );
}

export function specFileFor(sessionFile: string): string { return sessionFile.replace(/\.jsonl$/, ".spec.json"); }
