import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runInit } from "../src/stages/init.ts";
import { runM04 } from "../src/stages/m04.ts";
import { runM08 } from "../src/stages/m08.ts";
import { freezeArtifacts } from "../src/stages/artifacts.ts";
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

	it("loads the complete P08M prompt and keeps rendered pages outside frozen material", async () => {
		const f = await fixture(() => ({ text: "ok", reads: ["manifest.json"] }));
		await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "scope", instruction: "核对范围" }], reviewers: [{ id: "external", role: "reviewer" }] });
		const self = f.runner.created.find((x) => x.label === "M08-selfcheck-scope")!;
		const selfSession = [...f.runner.sessions.values()].find((x) => x.spec.label === "M08-selfcheck-scope")!;
		assert.match(selfSession.transcript[0].text, /第一条主线是目标同一性/);
		assert.match(selfSession.transcript[0].text, /第二条主线是主要结论的完整论证与证据/);
		assert.equal(self.tools.kind, "read-dir");
		if (self.tools.kind === "read-dir") {
			const page = self.tools.extraTools?.find((x) => x.name === "render_pdf_page")!;
			assert.match(page.description, /页/);
		}
	});

	it("rejects unsafe and duplicate member ids across both groups", async () => {
		const f = await fixture(() => ({ text: "ok", reads: ["manifest.json"] }));
		const base = { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], reviewers: [{ id: "r", role: "reviewer" as const }] };
		for (const id of ["../escape", "a/b", "a\\b"]) await assert.rejects(runM08(f.ctx, { ...base, selfChecks: [{ id, instruction: "x" }] }), /安全路径段/);
		await assert.rejects(runM08(f.ctx, { ...base, selfChecks: [{ id: "r", instruction: "x" }] }), /联合唯一/);
	});

	it("requires explicit re-review trace and refreezes changed material", async () => {
		const f = await fixture(() => ({ text: "ok", reads: ["manifest.json"] }));
		const opts = { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "a", instruction: "a" }], reviewers: [{ id: "r", role: "reviewer" as const }] };
		const first = await runM08(f.ctx, opts); await writeFile(f.material, Buffer.from([8, 9]));
		await assert.rejects(runM08(f.ctx, { ...opts, previousRunId: first.record.runId }), /changeSummary/);
		const second = await runM08(f.ctx, { ...opts, previousRunId: first.record.runId, changeSummary: "结果更新", affectedScope: "结果文件" });
		assert.deepEqual([...await readFile(second.manifest.entries.find((x) => x.label === "结果")!.frozenPath)], [8, 9]);
		assert.notEqual(second.manifest.rootDir, first.manifest.rootDir);
	});

	it("resolves caller material paths relative to the research workspace", async () => {
		const f = await fixture(() => ({ text: "ok", reads: ["manifest.json"] }));
		const result = await runM08(f.ctx, { materials: [{ label: "相对结果", path: "result.bin", sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] });
		assert.equal(result.manifest.entries.find((x) => x.label === "相对结果")?.originalPath, f.material);
		assert.equal(result.record.inputs.find((x) => x.label === "相对结果")?.path, f.material);
		await assert.rejects(runM08(f.ctx, { materials: [{ label: "相对结果", path: "result.bin", sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }], previousRunId: "../escape", changeSummary: "x", affectedScope: "x" }), /安全路径段/);
	});

	it("rejects symlinks and a target embedded in the selected source", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "m08-copy-")); roots.push(root);
		const source = path.join(root, "source"); await mkdir(source); await writeFile(path.join(source, "real.txt"), "x");
		await symlink(path.join(source, "real.txt"), path.join(source, "loop-link"));
		await assert.rejects(freezeArtifacts(path.join(root, "outside"), [{ label: "bad", path: source, sourceCategory: "result" }]), /符号链接/);
		await rm(path.join(source, "loop-link"));
		await assert.rejects(freezeArtifacts(path.join(source, "nested-target"), [{ label: "whole", path: source, sourceCategory: "result" }]), /目标位于所选源目录内部/);
	});

	it("fails closed on a manifest from another run or missing frozen input", async () => {
		const f = await fixture(() => ({ text: "ok", reads: ["manifest.json"] }));
		const result = await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] });
		const manifestRef = result.record.outputs.find((x) => x.label === "固定材料清单")!;
		const original = JSON.parse(await readFile(manifestRef.path, "utf8")); const tampered = structuredClone(original); tampered.m08RunId = "other"; await writeFile(manifestRef.path, JSON.stringify(tampered));
		await assert.rejects(runM04(f.ctx, { feedback: { kind: "M08", runId: result.record.runId } }), /不是指定 M08/);
		const escaped = structuredClone(original); escaped.entries[0].relativePath = "../escape"; await writeFile(manifestRef.path, JSON.stringify(escaped));
		await assert.rejects(runM04(f.ctx, { feedback: { kind: "M08", runId: result.record.runId } }), /相对路径非法/);
		await writeFile(manifestRef.path, JSON.stringify(original));
		await rm(original.entries.find((x: { sourceCategory: string }) => x.sourceCategory === "original-problem").frozenPath);
		await assert.rejects(runM04(f.ctx, { feedback: { kind: "M08", runId: result.record.runId } }), /固定材料缺失/);
	});

	it("turns invalid M04 dispositions into unresolved", async () => {
		const f = await fixture((c) => {
			if (c.spec.label.startsWith("M08-")) return { text: "ok", reads: ["manifest.json"] };
			const m08RunId = c.message.match(/"m08RunId":"([^"]+)"/)?.[1];
			return { text: `\`\`\`m08-disposition\n${JSON.stringify({ m08RunId, status: "ready", deliverablePaths: ["结果"], limitations: [], rationale: "" })}\n\`\`\``, reads: ["manifest.json"] };
		});
		const result = await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] });
		const m04 = await runM04(f.ctx, { feedback: { kind: "M08", runId: result.record.runId } });
		const disposition = JSON.parse(await readFile(m04.record.outputs.find((x) => x.label === "M08 用途处置")!.path, "utf8"));
		assert.equal(disposition.status, "unresolved"); assert.ok(m04.record.failures.some((x) => x.includes("不能供 M09")));
	});

	it("requires actual access to every ready or partial deliverable", async () => {
		for (const reads of [[], ["manifest.json"]]) {
			const f = await fixture((c) => {
				if (c.spec.label.startsWith("M08-")) return { text: "ok", reads: ["manifest.json"] };
				const m08RunId = c.message.match(/"m08RunId":"([^"]+)"/)?.[1];
				return { text: `\`\`\`m08-disposition\n${JSON.stringify({ m08RunId, status: "ready", deliverablePaths: ["materials/004-结果/result.bin"], limitations: [], rationale: "可交付" })}\n\`\`\``, reads };
			});
			const m08 = await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] });
			const m04 = await runM04(f.ctx, { feedback: { kind: "M08", runId: m08.record.runId } });
			const disposition = JSON.parse(await readFile(m04.record.outputs.find((x) => x.label === "M08 用途处置")!.path, "utf8"));
			assert.equal(disposition.status, "unresolved");
			assert.match(disposition.limitations.join("\n"), /未实际读取或渲染/);
		}
	});

	it("does not count listing a deliverable directory as reading a file inside it", async () => {
		let m04Calls = 0;
		const f = await fixture((c) => {
			if (c.spec.label.startsWith("M08-")) return { text: "ok", reads: ["manifest.json"] };
			m04Calls++;
			const m08RunId = c.message.match(/"m08RunId":"([^"]+)"/)?.[1];
			return { text: `\`\`\`m08-disposition\n${JSON.stringify({ m08RunId, status: "partial", deliverablePaths: ["materials/004-结果目录/result-dir"], limitations: [], rationale: "局部交付" })}\n\`\`\``, reads: m04Calls === 1 ? ["materials/004-结果目录/result-dir"] : ["materials/004-结果目录/result-dir/nested.txt"] };
		});
		const directory = path.join(f.root, "result-dir"); await mkdir(directory); await writeFile(path.join(directory, "nested.txt"), "evidence\n");
		const m08 = await runM08(f.ctx, { materials: [{ label: "结果目录", path: directory, sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] });
		const first = await runM04(f.ctx, { feedback: { kind: "M08", runId: m08.record.runId } });
		const firstDisposition = JSON.parse(await readFile(first.record.outputs.find((x) => x.label === "M08 用途处置")!.path, "utf8"));
		assert.equal(firstDisposition.status, "unresolved");
		const second = await runM04(f.ctx, { feedback: { kind: "M08", runId: m08.record.runId } });
		const secondDisposition = JSON.parse(await readFile(second.record.outputs.find((x) => x.label === "M08 用途处置")!.path, "utf8"));
		assert.equal(secondDisposition.status, "partial");
	});

	it("limits parallel members to configured concurrency", async () => {
		let active = 0; let maximum = 0;
		const f = await fixture(async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 15)); active--; return { text: "ok", reads: ["manifest.json"] }; });
		f.ctx.config.concurrency = 2;
		await runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [1, 2, 3, 4].map((x) => ({ id: `s${x}`, instruction: "x" })), reviewers: [1, 2, 3].map((x) => ({ id: `r${x}`, role: "reviewer" as const })) });
		assert.equal(maximum, 2);
	});

	it("rejects a knowledge pack from a snapshot different from the run record", async () => {
		const f = await fixture(() => ({ text: "ok", reads: ["manifest.json"] }));
		const original = f.ctx.store.buildPack.bind(f.ctx.store);
		f.ctx.store.buildPack = async (query) => ({ ...(await original(query)), snapshot: "G999" });
		await assert.rejects(runM08(f.ctx, { materials: [{ label: "结果", path: f.material, sourceCategory: "result" }], selfChecks: [{ id: "s", instruction: "x" }], reviewers: [{ id: "r", role: "reviewer" }] }), /知识快照在固定期间变化/);
	});
});
