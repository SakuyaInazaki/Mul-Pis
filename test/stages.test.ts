/**
 * Stage contract tests with the scripted runner. They assert which session saw what,
 * that the reviewer rationale never reaches the answering session, that M02 uses the
 * M01 model in a new session, that proposals are merged as candidates, and that M06
 * assembles a whole batch (including failures) before anything goes to M04.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { buildM03AnswerMessage, loadPrompt, rationaleLeaks, ROLE_SYSTEM_PROMPTS, splitM03Questions } from "../src/prompts.ts";
import { FakeSessionRunner, type FakeReply, type FakeReplyContext } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runInit } from "../src/stages/init.ts";
import { runM01 } from "../src/stages/m01.ts";
import { runM02 } from "../src/stages/m02.ts";
import { runM03 } from "../src/stages/m03.ts";
import { runM04 } from "../src/stages/m04.ts";
import { runM06 } from "../src/stages/m06.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

const SECRET = "SECRET-RATIONALE-DO-NOT-FORWARD";

const CONFIG = {
	roles: {
		execution: "fake/model-a:high",
		reviewer: "fake/model-b",
		research: "fake/model-c",
		reader: "fake/model-r",
		checker: "fake/model-r",
		applicability: "fake/model-r",
	},
	concurrency: 2,
};

function reply(ctx: FakeReplyContext): FakeReply {
	const { spec, turnIndex } = ctx;
	if (spec.label === "M01") {
		if (turnIndex === 1) return { text: "初始认识 ALPHA：对象是 X，关系是 Y。\n\n不确定：Z。" };
		if (turnIndex === 2) return { text: "完整回答 ANSWER：问1 的回答……" };
		return {
			text: `处理结果：接受纠正 1 项。\n\n\`\`\`knowledge-proposals\n${JSON.stringify([
				{ op: "create", type: "C", title: "对象 X 的定义", body: "X 定义为……", usageDecision: "working_assumption", evidenceStatus: "本轮推导", reason: "M03 评价指出定义需明确", handle: "$1" },
				{ op: "create", type: "Q", title: "Y 关系是否在条件 W 下成立", body: "评审认为条件不足", refs: [{ rel: "questions", target: "$1" }], reason: "待补证" },
				{ op: "decide", id: "K001", usageDecision: "adopted", reason: "作为本轮检查办法", context: "默认情境" },
				{ op: "limit", target: "K002", kind: "needs_recheck", reason: "评价指出量纲说明不完整", authority: "M03 评价第 2 条" },
			])}\n\`\`\``,
		};
	}
	if (spec.label === "M02") {
		return {
			text: `候选判据草案……\n\n\`\`\`knowledge-proposals\n${JSON.stringify([
				{ op: "create", type: "K", title: "量纲检查", body: "对象：方程；依据：题设；检查办法：逐项核对单位", fields: { category: "定义类型量纲", nature: "必要约束" }, usageDecision: "candidate", evidenceStatus: "题设" },
				{ op: "create", type: "K", title: "极限情形", body: "取 t→0 …", fields: { category: "特例退化极限", nature: "诊断性预期" }, usageDecision: "candidate", evidenceStatus: "本轮推导" },
			])}\n\`\`\``,
		};
	}
	if (spec.label === "M03-reviewer") {
		if (turnIndex === 1) return { text: `# 可转发问题\n\n问1：在条件 W 下 Y 是否仍成立？\n\n# 出题说明与判断依据\n\n${SECRET}` };
		return { text: "逐题评价：问1 回答需补条件；未发现明确错误。" };
	}
	if (spec.label === "M04-research") {
		return { text: "研究会话处理结果：无需修改，保持原状态。" };
	}
	if (spec.label.startsWith("M06-")) {
		if (spec.label.endsWith("-reader")) {
			if (spec.label.includes("S002")) return { text: "", stopReason: "error" };
			return { text: "阅读记录：材料研究……\n\n## 实际阅读范围\n\npaper.md 全文\n\n## 疑点与缺口\n\n无", reads: ["paper.md"] };
		}
		if (spec.label.endsWith("-checker")) return { text: "核对：忠实。\n\n## 实际核对范围\n\n公式 (1)", reads: ["paper.md"] };
		return { text: "适用性：支持当前认识。\n\n## 处理建议\n\n- 建议采纳 K001 的条件" };
	}
	throw new Error(`unexpected session ${spec.label}`);
}

describe("stages with the scripted runner", () => {
	let root: string;
	let ws: Workspace;
	let runner: FakeSessionRunner;
	let ctx: StageContext;

	before(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "harness-stages-"));
		ws = new Workspace(root);
		await mkdir(ws.rawDir, { recursive: true });
		await writeFile(ws.problemFile, "# 原始问题\n\n研究机制 A 是否解释现象 B。\n");
		await writeFile(path.join(ws.rawDir, "data-note.md"), "观测数据说明：……\n");
		await writeFile(path.join(ws.rawDir, "scan.pdf"), "not text");
		await writeFile(ws.configFile, JSON.stringify(CONFIG));
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		await runInit(ws, store);
		runner = new FakeSessionRunner(reply);
		ctx = { ws, runner, store, config: await ws.loadConfig() };
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("M01 uses one tool-less execution session with only the problem and raw text", async () => {
		const result = await runM01(ctx);
		assert.equal(runner.created.length, 1);
		const spec = runner.created[0];
		assert.equal(spec.label, "M01");
		assert.equal(spec.role, "execution");
		assert.equal(spec.model, "fake/model-a:high");
		assert.deepEqual(spec.tools, { kind: "none" });
		assert.ok(spec.systemPrompt.includes(ROLE_SYSTEM_PROMPTS.execution), "M01 保留 execution 角色隔离契约");
		if (spec.systemPrompt !== ROLE_SYSTEM_PROMPTS.execution) assert.match(spec.systemPrompt, /输入信任边界|不可信数据/);
		const message = runner.sessions.values().next().value!.transcript[0].text;
		assert.ok(message.includes(await loadPrompt("P01")));
		assert.ok(message.includes("研究机制 A 是否解释现象 B"));
		assert.ok(message.includes("观测数据说明"));
		assert.ok(result.output.startsWith("初始认识 ALPHA"));
		assert.equal(result.record.status, "completed");
		assert.ok(result.record.failures.some((f) => f.includes("scan.pdf")), "non-text raw info is reported, not silently skipped");
		const note = (await readFile(path.join(ws.notesDir, `${result.record.startedAt.slice(0, 10)}-M01-${result.record.runId}.md`), "utf8"));
		assert.ok(note.includes("初始认识"));
	});

	it("M02 is a new session with the M01 model and merges K candidates", async () => {
		const result = await runM02(ctx);
		assert.equal(runner.created.length, 2);
		const spec = runner.created[1];
		assert.equal(spec.label, "M02");
		assert.equal(spec.model, runner.created[0].model);
		assert.deepEqual(spec.tools, { kind: "none" });
		const m02State = [...runner.sessions.values()].find((s) => s.spec.label === "M02")!;
		assert.ok(m02State.transcript[0].text.includes("初始认识 ALPHA"));
		assert.ok(m02State.transcript[0].text.includes(await loadPrompt("P02")));
		assert.match(m02State.transcript[0].text, /只是叙述标签/);
		assert.equal(result.snapshotId, "G001");
		const ks = await ctx.store.list({ type: "K" });
		assert.equal(ks.length, 2);
		assert.ok(ks.every((k) => k.usageDecision === "candidate"));
		assert.deepEqual(result.record.failures.filter((f) => !f.includes("scan.pdf")), [], "only the non-text raw file is reported");
	});

	it("M02 refuses a model different from M01", async () => {
		const other: StageContext = { ...ctx, config: { ...ctx.config, roles: { ...ctx.config.roles, execution: "fake/other" } } };
		await assert.rejects(runM02(other), (e: unknown) => e instanceof HarnessError && e.code === "m02.model");
	});

	it("M03 forwards only the questions to the original M01 session and evaluates in the reviewer session", async () => {
		const result = await runM03(ctx);
		const reviewerSpec = runner.created.find((s) => s.label === "M03-reviewer")!;
		assert.equal(reviewerSpec.role, "reviewer");
		assert.equal(reviewerSpec.model, "fake/model-b");
		const m01State = [...runner.sessions.values()].find((s) => s.spec.label === "M01")!;
		assert.equal(runner.resumed.filter((r) => r.label === "M01").length, 1, "M01 session resumed for answering");
		const answerMessage = m01State.transcript.filter((m) => m.role === "user")[1].text;
		assert.ok(answerMessage.includes("候选判据草案"), "M02 output forwarded in full");
		assert.ok(answerMessage.includes("问1：在条件 W 下"), "questions forwarded");
		assert.ok(!answerMessage.includes(SECRET), "rationale must not reach the answering session");
		const rationaleFile = result.record.outputs.find((o) => o.label.startsWith("出题说明"))!;
		assert.ok((await readFile(rationaleFile.path, "utf8")).includes(SECRET));
		assert.ok(result.answers.includes("完整回答 ANSWER：问1 的回答……"));
		assert.ok(result.evaluation.startsWith("逐题评价"));
		const reviewerState = [...runner.sessions.values()].find((s) => s.spec.label === "M03-reviewer")!;
		assert.equal(reviewerState.transcript.filter((m) => m.role === "user").length, 2, "same reviewer session evaluated");
		assert.ok(reviewerState.transcript.at(-2)!.text.includes(await loadPrompt("P03A")));
	});

	it("rationaleLeaks flags verbatim rationale lines but ignores trivial fragments", () => {
		assert.ok(rationaleLeaks("这里故意设置了错误前提：X 在条件 W 下不成立。", "问1……\n这里故意设置了错误前提：X 在条件 W 下不成立。\n问2"));
		assert.ok(!rationaleLeaks("（fake）", "问1（fake）：请说明关键假设。"));
		assert.ok(!rationaleLeaks("# 出题说明与判断依据\n短句", "短句 出现在问题里"));
	});

	it("rationaleLeaks ignores overlap in explicitly forwarded questions and M02 but still detects rationale in the skeleton", () => {
		const shared = "这是一段足够长、会同时出现在问题或候选判据中的评审表述。";
		const questions = `问题：请核对以下表述是否成立：${shared}`;
		const m02 = `候选判据引用：${shared}`;
		const message = buildM03AnswerMessage(m02, questions);
		assert.equal(rationaleLeaks(shared, message, [questions, m02]), false, "question substring and M02 quote are allowed inputs");
		assert.equal(rationaleLeaks(shared, `${shared}\n${message}`, [questions, m02]), true, "an extra rationale copy in the message skeleton remains blocked");
		assert.equal(rationaleLeaks("左侧骨架文字与右侧骨架文字不应在移除后被拼接成同一行", `左侧骨架文字${questions}右侧骨架文字`, [questions]), false, "removing an allowed block preserves line boundaries");
	});

	it("splitM03Questions rejects output without both headers", () => {
		assert.throws(() => splitM03Questions("# 可转发问题\n\n问1"), (e: unknown) => e instanceof HarnessError && e.code === "m03.format");
	});

	it("first M04 continues the M01 session and merges proposals through the serial entry", async () => {
		const result = await runM04(ctx, { feedback: { kind: "M03" } });
		assert.equal(result.mode, "continue-m01");
		assert.equal(runner.resumed.filter((r) => r.label === "M01").length, 2);
		const m01State = [...runner.sessions.values()].find((s) => s.spec.label === "M01")!;
		const m04Message = m01State.transcript.filter((m) => m.role === "user")[2].text;
		assert.ok(m04Message.includes(await loadPrompt("P04")));
		assert.ok(m04Message.includes("逐题评价：问1"));
		assert.ok(m04Message.includes("knowledge-proposals"));
		assert.equal(result.snapshotId, "G002");
		const c = await ctx.store.get("C001");
		assert.ok(c && c.usageDecision === "working_assumption");
		const q = await ctx.store.get("Q001");
		assert.ok(q && q.qStatus?.open === true);
		assert.ok(q!.refs.some((r) => r.target.startsWith("C001")), "handle $1 resolved to C001");
		const k1 = await ctx.store.get("K001");
		assert.equal(k1?.usageDecision, "adopted");
		assert.equal(k1?.version, 2, "decide creates a new version");
		const availability = await ctx.store.availability("K002");
		assert.equal(availability.availability, "needs_recheck");
		assert.deepEqual(result.record.failures, []);
	});

	it("later M04 rounds use a fresh research session with the knowledge pack", async () => {
		const feedbackPath = path.join(root, "user-feedback.md");
		await writeFile(feedbackPath, "用户修正：现象 B 的口径是日平均值。\n");
		const result = await runM04(ctx, { feedback: { kind: "file", label: "用户修正", path: feedbackPath } });
		assert.equal(result.mode, "research-session");
		const spec = runner.created.find((s) => s.label === "M04-research")!;
		assert.equal(spec.role, "research");
		assert.equal(spec.model, "fake/model-c");
		assert.deepEqual(spec.tools, { kind: "none" });
		const state = [...runner.sessions.values()].find((s) => s.spec.label === "M04-research")!;
		assert.match(state.transcript[0].text, /知识记录身份契约/);
		assert.match(state.transcript[0].text, /"target":"\$claim"/);
		const message = state.transcript[0].text;
		assert.ok(message.includes("研究机制 A 是否解释现象 B"), "fresh session gets the problem again");
		assert.ok(message.includes("C001"), "knowledge pack included");
		assert.ok(message.includes("日平均值"));
		assert.equal(result.snapshotId, undefined, "no proposals means no new snapshot");
		assert.ok(result.record.remarks.some((r) => r.includes("没有知识提案")));
	});

	it("M03 reviewer pool isolates three sessions, serializes M01 answers, and aggregates all sources for M04", async () => {
		const poolRunner = new FakeSessionRunner(({ spec, turnIndex, message }) => {
			if (spec.label.startsWith("M03-reviewer-")) {
				const id = spec.label.slice("M03-reviewer-".length);
				if (turnIndex === 1) return { text: `# 可转发问题\n\n问题-${id}\n\n# 出题说明与判断依据\n\n依据-${id}` };
				assert.ok(message.includes(`回答-${id}`), `${id} only receives its own answer`);
				for (const other of ["R1", "R2", "R3"].filter((value) => value !== id)) assert.ok(!message.includes(`回答-${other}`));
				return { text: `评价-${id}` };
			}
			if (spec.label === "M01") {
				const id = ["R1", "R2", "R3"].find((value) => message.includes(`问题-${value}`))!;
				return { text: `回答-${id}` };
			}
			if (spec.label === "M04-research") return { text: "pool processed" };
			throw new Error(`unexpected ${spec.label}`);
		});
		const poolConfig = { ...ctx.config, m03Reviewers: [
			{ id: "R1", model: "fake/shared" }, { id: "R2", model: "fake/shared" }, { id: "R3", model: "fake/other" },
		] };
		const result = await runM03({ ...ctx, runner: poolRunner, config: poolConfig });
		assert.deepEqual(poolRunner.created.map((spec) => [spec.label, spec.model]), [
			["M03-reviewer-R1", "fake/shared"], ["M03-reviewer-R2", "fake/shared"], ["M03-reviewer-R3", "fake/other"],
		]);
		assert.equal(poolRunner.resumed.filter((ref) => ref.label === "M01").length, 1);
		const m01 = [...poolRunner.sessions.values()].find((state) => state.spec.label === "M01")!;
		const answerMessages = m01.transcript.filter((message) => message.role === "user").slice(-3);
		assert.equal(answerMessages.length, 3);
		assert.ok(answerMessages[0].text.includes("候选判据草案"));
		assert.ok(!answerMessages[1].text.includes("候选判据草案"));
		assert.ok(!answerMessages[2].text.includes("候选判据草案"));
		for (const id of ["R1", "R2", "R3"]) {
			const reviewer = [...poolRunner.sessions.values()].find((state) => state.spec.label === `M03-reviewer-${id}`)!;
			assert.equal(reviewer.transcript.filter((message) => message.role === "user").length, 2);
		}
		assert.ok(result.members.every((member) => member.status === "completed"));
		assert.match(result.evaluation, /评价-R1/); assert.match(result.evaluation, /评价-R2/); assert.match(result.evaluation, /评价-R3/);
		const m04 = await runM04({ ...ctx, runner: poolRunner, config: poolConfig }, { feedback: { kind: "M03", runId: result.record.runId }, freshSession: true });
		const m04State = [...poolRunner.sessions.values()].find((state) => state.spec.label === "M04-research")!;
		assert.match(m04State.transcript[0].text, /评价-R1/); assert.match(m04State.transcript[0].text, /评价-R2/); assert.match(m04State.transcript[0].text, /评价-R3/);
		assert.equal(m04.record.status, "completed");
	});

	it("M03 completes when R2 rationale repeats a long question substring without forwarding rationale-only text", async () => {
		const rationaleOnly = "这是只属于出题依据且绝对不能进入执行会话的独有长句。";
		const shared = "这段足够长的共同表述会同时出现在问题与出题依据中。";
		const overlapRunner = new FakeSessionRunner(({ spec, turnIndex, message }) => {
			if (spec.label.startsWith("M03-reviewer-")) {
				const id = spec.label.slice("M03-reviewer-".length);
				if (turnIndex === 1) return { text: `# 可转发问题\n\n问题-${id}：请核对 ${id === "R2" ? shared : "本组条件"}\n\n# 出题说明与判断依据\n\n${id === "R2" ? `${shared}\n${rationaleOnly}` : `依据-${id}`}` };
				return { text: `评价-${id}` };
			}
			if (spec.label === "M01") {
				assert.equal(message.includes(rationaleOnly), false);
				return { text: "执行会话回答" };
			}
			throw new Error(`unexpected ${spec.label}`);
		});
		const result = await runM03({ ...ctx, runner: overlapRunner, config: { ...ctx.config, m03Reviewers: [
			{ id: "R1", model: "fake/shared" }, { id: "R2", model: "fake/shared" }, { id: "R3", model: "fake/shared" },
		] } });
		assert.equal(result.record.status, "completed");
		assert.ok(result.members.every((member) => member.status === "completed"));
	});

	it("M03 fails the whole batch and records the member when one reviewer fails", async () => {
		const beforeRuns = new Set(await ws.listRuns("M03"));
		const failingRunner = new FakeSessionRunner(({ spec, turnIndex }) => {
			if (spec.label.startsWith("M03-reviewer-")) {
				const id = spec.label.slice("M03-reviewer-".length);
				if (turnIndex === 1) return { text: `# 可转发问题\n\n问题-${id}\n\n# 出题说明与判断依据\n\n依据-${id}` };
				if (id === "R2") throw new Error("reviewer offline");
				return { text: `评价-${id}` };
			}
			if (spec.label === "M01") return { text: "回答" };
			throw new Error(`unexpected ${spec.label}`);
		});
		const failingCtx = { ...ctx, runner: failingRunner, config: { ...ctx.config, m03Reviewers: [{ id: "R1", model: "fake/shared" }, { id: "R2", model: "fake/shared" }] } };
		await assert.rejects(runM03(failingCtx), /reviewer offline/);
		const newId = (await ws.listRuns("M03")).find((id) => !beforeRuns.has(id))!; const failed = await ws.readRun("M03", newId);
		assert.equal(failed.status, "failed");
		assert.ok(!failed.outputs.some((output) => output.label === "逐题评价"), "partial success is not exposed as a complete aggregate");
		const memberFile = failed.outputs.find((output) => output.label === "M03 成员清单")!;
		const saved = JSON.parse(await readFile(memberFile.path, "utf8")) as { members: Array<{ id: string; status: string; failure?: string }> };
		assert.equal(saved.members.find((member) => member.id === "R2")?.status, "failed");
		assert.match(saved.members.find((member) => member.id === "R2")?.failure ?? "", /reviewer offline/);
	});

	it("M06 runs read → check → applicability per source, keeps failures, and assembles the whole batch", async () => {
		for (const id of ["S001", "S002"]) {
			const dir = path.join(ws.referencesDir, "sources", id);
			await mkdir(dir, { recursive: true });
			await writeFile(path.join(dir, "source.md"), `# 论文 ${id}\n\n- 版本：v1\n`);
			await writeFile(path.join(dir, "paper.md"), "论文正文……\n");
		}
		const result = await runM06(ctx, { requirements: "关注公式 (1) 的条件" });
		assert.equal(result.record.status, "completed");
		assert.equal(result.groups.length, 2);
		const s1 = result.groups.find((g) => g.sourceId === "S001")!;
		const s2 = result.groups.find((g) => g.sourceId === "S002")!;
		assert.equal(s1.status, "completed");
		assert.deepEqual(s1.readCoverage, ["paper.md"]);
		assert.equal(s2.status, "failed");
		assert.ok(s2.failure);
		assert.ok(result.record.failures.some((f) => f.includes("S002")));
		const readerSpec = runner.created.find((s) => s.label === "M06-S001-reader")!;
		assert.equal(readerSpec.role, "reader");
		assert.equal(readerSpec.tools.kind, "read-dir");
		if (readerSpec.tools.kind === "read-dir") {
			assert.equal(readerSpec.tools.root, s1.dir);
			assert.equal(readerSpec.tools.toolName, "material_read");
			assert.deepEqual((readerSpec.tools.extraTools ?? []).map((t) => t.name), ["render_pdf_page"]);
		}
		const readerMsg = [...runner.sessions.values()].find((s) => s.spec.label === "M06-S001-reader")!.transcript[0].text;
		assert.ok(readerMsg.includes("关注公式 (1) 的条件"));
		assert.ok(!readerMsg.includes("初始认识 ALPHA"), "reader gets no project expectations");
		const applSpec = runner.created.find((s) => s.label === "M06-S001-applicability")!;
		assert.deepEqual(applSpec.tools, { kind: "none" });
		const applMsg = [...runner.sessions.values()].find((s) => s.spec.label === "M06-S001-applicability")!.transcript[0].text;
		assert.ok(applMsg.includes("研究机制 A 是否解释现象 B"));
		assert.ok(applMsg.includes("C001"), "applicability sessions get the shared project state");
		const summary = await readFile(result.summaryPath, "utf8");
		assert.ok(summary.includes("S001") && summary.includes("S002"));
		assert.ok(summary.includes("失败"));
		assert.ok(!existsSync(path.join(ws.stagesDir, "M06", result.record.runId, "S002", "reading.md")));
		// the batch feeds one M04 round
		const m04 = await runM04(ctx, { feedback: { kind: "M06" } });
		assert.equal(m04.mode, "research-session");
		const state = [...runner.sessions.values()].filter((s) => s.spec.label === "M04-research").at(-1)!;
		assert.ok(state.transcript[0].text.includes("适用性：支持当前认识"));
		assert.ok(state.transcript[0].text.includes("S002"), "failed group is visible to M04");
	});
});
