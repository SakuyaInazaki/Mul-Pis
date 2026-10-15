import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runInit } from "../src/stages/init.ts";
import { runM04 } from "../src/stages/m04.ts";
import { runM08 } from "../src/stages/m08.ts";

import { Workspace } from "../src/workspace.ts";

describe("M08 fixed-version review", () => {
	const roots: string[] = [];
	afterEach(async () => { await Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });

	async function fixture(reply: (ctx: FakeReplyContext) => { text: string; reads?: string[]; stopReason?: string } | Promise<{ text: string; reads?: string[]; stopReason?: string }>) {
		const root = await mkdtemp(path.join(os.tmpdir(), "m08-")); roots.push(root);
		const ws = new Workspace(root); await mkdir(ws.rawDir, { recursive: true });
		await writeFile(ws.problemFile, "# 固定原问题\n\n问题版本一。\n");
		await writeFile(path.join(ws.rawDir, "scope.md"), "明确范围。\n");
		await writeFile(ws.configFile, JSON.stringify({ roles: { reviewer: "fake/reviewer", research: "fake/research", checker: "fake/checker" }, concurrency: 2 }));
		const material = path.join(root, "result.bin"); await writeFile(material, Buffer.from([0, 255, 4, 7]));
		const store = createFileKnowledgeStore(ws.knowledgeDir); await runInit(ws, store);
		const runner = new FakeSessionRunner(reply); const ctx: StageContext = { ws, runner, store, config: await ws.loadConfig() };
		return { root, ws, material, runner, ctx };
	}

	it("copies one disclosed version, isolates sessions, and feeds fixed evidence to fresh M04", async () => {
		const f = await fixture((c) => {
			if (c.spec.label.startsWith("M08-selfcheck")) return { text: "自查完整报告", reads: ["manifest.json", "materials/004-结果/result.bin"] };
			if (c.spec.label.startsWith("M08-reviewer")) return { text: "外审完整报告", reads: ["manifest.json", "materials/001-本轮固定原始问题/fixed-problem.md"] };
			if (c.spec.label === "M04-research") {
				const m08RunId = c.message.match(/"m08RunId":"([^"]+)"/)?.[1] ?? "missing";
				return { text: `处理审查意见。\n\n\`\`\`m08-disposition\n${JSON.stringify({ m08RunId, status: "partial", deliverablePaths: ["materials/004-结果/result.bin"], limitations: ["只交付二进制结果"], rationale: "审查支持局部交付" })}\n\`\`\``, reads: ["manifest.json", "materials/004-结果/result.bin"] };
			}
			throw new Error(c.spec.label);
		});
		const result = await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result", providedScope: "完整二进制" }], selfChecks: [{ id: "goal", instruction: "核对目标" }], reviewers: [{ id: "external-a", role: "reviewer" }], unprovidedScopes: ["训练日志未提供"] });
		assert.equal(result.record.status, "completed"); assert.equal(result.manifest.m08RunId, result.record.runId);
		assert.deepEqual([...await readFile(result.manifest.entries.find((x) => x.label === "结果")!.frozenPath)], [0, 255, 4, 7]);
		await writeFile(f.ws.problemFile, "已被后续修改的问题\n");
		const m04 = await runM04(f.ctx, { feedback: { kind: "M08", runId: result.record.runId } });
		assert.equal(m04.mode, "research-session"); assert.deepEqual(m04.record.failures, []);
		const m04Session = [...f.runner.sessions.values()].find((x) => x.spec.label === "M04-research")!;
		assert.ok(m04Session.transcript[0].text.includes("问题版本一")); assert.ok(!m04Session.transcript[0].text.includes("已被后续修改"));
		assert.equal(m04Session.spec.tools.kind, "read-dir");
		if (m04Session.spec.tools.kind === "read-dir") assert.deepEqual(m04Session.spec.tools.extraTools?.map((x) => x.name), ["render_pdf_page"]);
		const m04Coverage = JSON.parse(await readFile(m04.record.outputs.find((x) => x.label === "M08 处理实际读取范围")!.path, "utf8"));
		assert.deepEqual(m04Coverage.files, ["manifest.json", "materials/004-结果/result.bin"]);
		assert.match(m04Session.transcript[0].text, /【实际产物位置】[\s\S]*- materials\/004-结果\/result\.bin/);
		assert.doesNotMatch(m04Session.transcript[0].text, /- stages\/M08\/.*\/frozen\/materials\/004-结果\/result\.bin/);
		const disposition = JSON.parse(await readFile(m04.record.outputs.find((x) => x.label === "M08 用途处置")!.path, "utf8"));
		assert.equal(disposition.status, "partial"); assert.equal(disposition.m08RunId, result.record.runId);
		assert.equal(f.runner.created.filter((x) => x.label.startsWith("M08-")).length, 2);
		assert.ok(f.runner.created.every((x) => !x.label.startsWith("M08-reviewer") || !x.systemPrompt.includes("自查完整报告")));
		assert.ok(result.manifest.unprovidedScopes.includes("训练日志未提供"));
	});

	it("does not start reviewers when any selected self-check fails", async () => {
		const f = await fixture((c) => c.spec.label.includes("bad") ? { text: "", stopReason: "error" } : { text: "ok", reads: ["manifest.json"] });
		await assert.rejects(runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "good", instruction: "a" }, { id: "bad", instruction: "b" }], reviewers: [{ id: "never", role: "reviewer" }] }), /自查未全部成功/);
		assert.equal(f.runner.created.some((x) => x.label.includes("never")), false);
		const runId = (await f.ws.listRuns("M08")).at(-1)!; const failed = await f.ws.readRun("M08", runId);
		assert.ok(failed.outputs.some((x) => x.label === "自查 good 完整报告"));
		assert.ok(failed.outputs.some((x) => x.label === "自查 bad 实际读取范围"));
		const aggregate = failed.outputs.find((x) => x.label === "M08 失败批次汇总")!;
		assert.ok((await readFile(aggregate.path, "utf8")).includes('"notStartedReviewers": [\n    "never"'));
	});








	it("requires actual access to every ready or partial deliverable", async () => {
		const f = await fixture((c) => {
			if (c.spec.label.startsWith("M08-")) return { text: "ok", reads: ["manifest.json"] };
			const m08RunId = c.message.match(/"m08RunId":"([^"]+)"/)?.[1];
			return { text: `\`\`\`m08-disposition\n${JSON.stringify({ m08RunId, status: "ready", deliverablePaths: ["materials/004-结果/result.bin"], limitations: [], rationale: "可交付" })}\n\`\`\``, reads: ["manifest.json"] };
		});
		const m08 = await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] });
		const m04 = await runM04(f.ctx, { feedback: { kind: "M08", runId: m08.record.runId } });
		const disposition = JSON.parse(await readFile(m04.record.outputs.find((x) => x.label === "M08 用途处置")!.path, "utf8"));
		assert.equal(disposition.status, "unresolved");
		assert.match(disposition.limitations.join("\n"), /未实际读取或渲染/);
	});



});
