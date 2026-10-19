import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runInit } from "../src/stages/init.ts";
import { runM08 } from "../src/stages/m08.ts";
import { runM09, type M09Options } from "../src/stages/m09.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

const blocked = { id: "fallback", pattern: "fall\\s*back to the reference implementation",
	appliesTo: ["**/*.py"], reason: "交付物不得在运行时回落参考实现" };

async function m08Fixture(t: TestContext, body: string): Promise<{ ctx: StageContext; ws: Workspace; material: string; hidden: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m08-policy-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "# 固定原问题\n\n把实现做对。\n");
	await writeFile(ws.configFile, JSON.stringify({ roles: { reviewer: "fake/reviewer", checker: "fake/checker" }, concurrency: 1 }));
	const material = path.join(root, "kernel.py");
	await writeFile(material, body);
	const hidden = path.join(root, "hidden-cases.json");
	await writeFile(hidden, JSON.stringify({ cases: 3 }));
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const runner = new FakeSessionRunner((call) => ({ text: `${call.spec.label} 报告`, reads: ["manifest.json"] }));
	return { ctx: { ws, runner, store, config: await ws.loadConfig() }, ws, material, hidden };
}

const m08Call = (material: string, extra: Record<string, unknown> = {}) => ({
	materials: [{ label: "实现", path: material, sourceCategory: "result" as const, providedScope: "全文" }],
	selfChecks: [{ id: "goal", instruction: "核对目标" }],
	reviewers: [{ id: "external-a", role: "reviewer" as const }],
	...extra,
});

test("M08 refuses a submission that hits a declared pattern, before any session starts", async (t) => {
	const f = await m08Fixture(t, "def run(x):\n    return fall back to the reference implementation\n");
	await assert.rejects(runM08(f.ctx, m08Call(f.material, { antiCheat: { blocked: [blocked] } })),
		(error: unknown) => error instanceof HarnessError && error.code === "m08.anti-cheat" && /fallback/.test(error.message));
	const run = await f.ws.readRun("M08", (await f.ws.listRuns("M08")).at(-1)!);
	const report = JSON.parse(await readFile(run.outputs.find(item => item.label === "反作弊模式检查")!.path, "utf8")) as
		{ verdict: string; findings: Array<{ patternId: string; line: number }> };
	assert.equal(report.verdict, "reject");
	assert.equal(report.findings[0].line, 2);
	// No session ran: rejection is decided by the host on the frozen bytes.
	assert.equal((f.ctx.runner as FakeSessionRunner).created.length, 0);
});

test("M08 freezes certification material outside every session's tool root and only says how much there is", async (t) => {
	const f = await m08Fixture(t, "def run(x):\n    raise RuntimeError('todo')\n");
	const result = await runM08(f.ctx, m08Call(f.material, {
		antiCheat: { required: [{ id: "raises", pattern: "raise\\s+RuntimeError", appliesTo: ["**/*.py"], reason: "失败路径必须抛错" }] },
		certification: { materials: [{ label: "隐藏用例", path: f.hidden, sourceCategory: "result" as const }], notes: "交付前认证用" },
	}));
	assert.equal(result.record.status, "completed");
	assert.equal(result.antiCheat.verdict, "pass");
	assert.equal(result.certification?.fileCount, 1);
	// The hidden tree is a sibling of the review root, never inside it.
	assert.ok(!path.relative(result.manifest.rootDir, result.certification!.rootDir).startsWith("materials"));
	assert.ok(path.relative(result.manifest.rootDir, result.certification!.rootDir).startsWith(".."));
	const messages = (f.ctx.runner as FakeSessionRunner).created.map(item => item.label);
	assert.ok(messages.some(label => label.startsWith("M08-selfcheck")) && messages.some(label => label.startsWith("M08-reviewer")));
	assert.equal(result.record.outputs.some(item => item.label === "认证材料清单"), true);
	for (const member of [...result.selfChecks, ...result.reviews])
		assert.ok(!member.coverage.some(file => file.includes("hidden-cases")), "no session read the hidden material");
});

/** Shell-safe: the payload travels as base64 so quoting cannot corrupt it. */
const writeFileCommand = (file: string, content: string): string =>
	`node -e "require('fs').writeFileSync('${file}', Buffer.from('${Buffer.from(content).toString("base64")}', 'base64').toString())"`;

const gate = (name: string, scope: string[], evidence: string[]) =>
	`\n\n\`\`\`${name}\n${JSON.stringify({ status: "checked", scope, unresolved: [], evidence })}\n\`\`\``;

interface M09Fixture { ctx: StageContext; ws: Workspace; options: M09Options; relativePath: string; m08RunId: string }

/** One frozen M08 run plus its paired M04 disposition, written directly: this
 * test is about the host's own verdicts, not about re-running two stages. */
async function m09Fixture(t: TestContext, options: { certification?: boolean; observations?: string }): Promise<M09Fixture> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m09-policy-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const snapshot = await store.current();
	const material = path.join(root, "result.txt");
	await writeFile(material, "fixed result\n");
	const m08 = await ws.startRun("M08", [{ label: "result", path: material }], snapshot?.id);
	const frozenRoot = path.join(ws.runDir("M08", m08.runId), "frozen");
	const relativePath = "materials/001-result/result.txt";
	const problemPath = "materials/000-problem/problem.md";
	for (const [relative, content] of [[relativePath, "fixed result\n"], [problemPath, "fixed problem\n"]] as const) {
		await mkdir(path.dirname(path.join(frozenRoot, relative)), { recursive: true });
		await writeFile(path.join(frozenRoot, relative), content);
	}
	const entry = (label: string, relative: string, category: string) => ({ label, path: path.join(frozenRoot, relative),
		sourceCategory: category, originalPath: path.join(frozenRoot, relative), frozenPath: path.join(frozenRoot, relative),
		relativePath: relative, kind: "file" });
	const manifest = { version: 1, m08RunId: m08.runId, rootDir: frozenRoot, createdAt: new Date().toISOString(),
		entries: [entry("problem", problemPath, "original-problem"), entry("result", relativePath, "result")], unprovidedScopes: [] };
	const manifestRef = await ws.writeOutput(m08, "manifest.json", JSON.stringify(manifest), "固定材料清单");
	if (options.certification) {
		const certificationRoot = path.join(ws.runDir("M08", m08.runId), "certification");
		await mkdir(path.join(certificationRoot, "materials/001-hidden"), { recursive: true });
		await writeFile(path.join(certificationRoot, "materials/001-hidden/hidden-cases.json"), JSON.stringify({ cases: 3 }));
		await ws.writeOutput(m08, "certification-manifest.json", JSON.stringify({ version: 1, m08RunId: m08.runId,
			rootDir: certificationRoot, createdAt: new Date().toISOString(), visibility: "hidden-from-sessions",
			entries: [{ label: "隐藏用例", path: path.join(certificationRoot, "materials/001-hidden/hidden-cases.json"),
				sourceCategory: "result", originalPath: "x", frozenPath: path.join(certificationRoot, "materials/001-hidden/hidden-cases.json"),
				relativePath: "materials/001-hidden/hidden-cases.json", kind: "file" }], unprovidedScopes: [] }), "认证材料清单");
	}
	const feedback = await ws.writeOutput(m08, "review.md", "review feedback", "M08 审查反馈包");
	await ws.finishRun(m08, "completed");
	const m04 = await ws.startRun("M04", [{ label: "M08 审查反馈包", path: feedback.path }], snapshot?.id);
	await ws.writeOutput(m04, "m08-source.json", JSON.stringify({ m08RunId: m08.runId, manifestPath: manifestRef.path, reviewBundlePath: feedback.path }), "M08 处理来源");
	await ws.writeOutput(m04, "m08-disposition.json", JSON.stringify({ m08RunId: m08.runId, status: "ready",
		deliverablePaths: [relativePath], limitations: [], rationale: "指定范围可交付" }), "M08 用途处置");
	await ws.writeOutput(m04, "processing.md", "M04 processed", "处理结果");
	await ws.finishRun(m04, "completed");
	const evidenceLog = path.join(".m09-control", "reproduction-logs", "000.json");
	const runner = new FakeSessionRunner(async ({ spec, tools }) => {
		if (spec.label === "M09-organizer")
			return { text: `独立说明。${gate("m09-delivery", [relativePath], [relativePath])}`, reads: [problemPath, relativePath] };
		if (tools.run_reproduction_check) await tools.run_reproduction_check({ index: 0 });
		return { text: `复核报告。${gate("m09-verification", [relativePath], ["DELIVERY.md", relativePath, "command:0"])}`,
			reads: ["DELIVERY.md", relativePath, path.join(".m09-control", "source-trace.json"), evidenceLog] };
	});
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", checker: "fake/checker" }, concurrency: 1, tools: {} } };
	const write = options.observations ?? JSON.stringify({ "relative-error": 0.002 });
	const base: M09Options = { m08RunId: m08.runId, m04RunId: m04.runId, recipient: "后续研究者", purpose: "继续核查",
		deliveryScope: { included: [relativePath], excluded: [], limitations: [] },
		reproduction: { mode: "specified-checks", authorizedExecution: true,
			instructions: [writeFileCommand("obs.json", write)],
			observationsFile: "obs.json",
			tolerances: [{ id: "err", metric: "relative-error", comparison: "at_most", value: 0.01,
				basis: "按本机噪声标定", declaredBy: "caller:main-agent" }] } };
	return { ctx, ws, options: base, relativePath, m08RunId: m08.runId };
}

test("M09 judges the caller's tolerances against the commands' own observations", async (t) => {
	const pass = await m09Fixture(t, {});
	const result = await runM09(pass.ctx, pass.options);
	assert.equal(result.closure.tolerance?.verdict, "pass");
	assert.deepEqual(result.closure.tolerance?.declaredBy, ["caller:main-agent"]);
	assert.equal(result.closure.antiCheat.verdict, "not-declared");

	const fail = await m09Fixture(t, { observations: JSON.stringify({ "relative-error": 0.5 }) });
	await assert.rejects(runM09(fail.ctx, fail.options),
		(error: unknown) => error instanceof HarnessError && error.code === "m09.tolerance" && /caller:main-agent/.test(error.message));

	// A session cannot introduce the threshold it will be judged by: an
	// observations file with no declaration is inconclusive, not a pass.
	const missing = await m09Fixture(t, { observations: JSON.stringify({ "other-metric": 0.1 }) });
	await assert.rejects(runM09(missing.ctx, missing.options),
		(error: unknown) => error instanceof HarnessError && error.code === "m09.tolerance" && /inconclusive/.test(error.message));
});

test("M09 reruns the hidden certification material itself and records refusing an accepted delivery", async (t) => {
	const f = await m09Fixture(t, { certification: true });
	const material = "materials/001-hidden/hidden-cases.json";
	f.options.certification = {
		commands: [`node -e "const fs=require('fs');const hidden=JSON.parse(fs.readFileSync('.certification-material/${material}','utf8'));fs.writeFileSync('cert.json', JSON.stringify({'hidden-cases': hidden.cases}))"`],
		observationsFile: "cert.json",
		tolerances: [{ id: "cases", metric: "hidden-cases", comparison: "at_least", value: 3,
			basis: "认证集必须覆盖全部隐藏用例", declaredBy: "caller:main-agent" }],
	};
	const result = await runM09(f.ctx, f.options);
	assert.equal(result.closure.certification?.verdict, "pass");
	assert.equal(result.closure.certification?.hiddenMaterialFiles, 1);
	assert.equal(result.closure.certification?.engineRejectedSessionAcceptance, false);
	const report = JSON.parse(await readFile(result.record.outputs.find(item => item.label === "交付前认证重跑")!.path, "utf8")) as
		{ commands: Array<{ exitCode: number }>; tolerance: { verdict: string } };
	assert.equal(report.commands[0].exitCode, 0);
	assert.equal(report.tolerance.verdict, "pass");
	// The checker never saw the hidden material; it was told only that it exists.
	const checkerSpec = (f.ctx.runner as FakeSessionRunner).created.find(item => item.label === "M09-checker")!;
	assert.ok(!JSON.stringify(checkerSpec).includes("hidden-cases"));

	const refused = await m09Fixture(t, { certification: true });
	refused.options.certification = { commands: [writeFileCommand("cert.json", JSON.stringify({ "hidden-cases": 1 }))],
		observationsFile: "cert.json",
		tolerances: [{ id: "cases", metric: "hidden-cases", comparison: "at_least", value: 3,
			basis: "认证集必须覆盖全部隐藏用例", declaredBy: "caller:main-agent" }] };
	await assert.rejects(runM09(refused.ctx, refused.options),
		(error: unknown) => error instanceof HarnessError && error.code === "m09.certification-failed" && /引擎驳回会话已接受的交付/.test(error.message));
	const refusedRun = await refused.ws.readRun("M09", (await refused.ws.listRuns("M09")).at(-1)!);
	const refusedReport = JSON.parse(await readFile(refusedRun.outputs.find(item => item.label === "交付前认证重跑")!.path, "utf8")) as
		{ verdict: string; engineRejectedSessionAcceptance: boolean };
	assert.equal(refusedReport.verdict, "fail");
	assert.equal(refusedReport.engineRejectedSessionAcceptance, true);
});

test("M09 refuses a delivery copy that hits a declared pattern before the explanation session reads it", async (t) => {
	const f = await m09Fixture(t, {});
	await writeFile(path.join(f.ws.runDir("M08", f.m08RunId), "frozen", f.relativePath), "fall back to the reference implementation\n");
	f.options.antiCheat = { blocked: [{ ...blocked, appliesTo: ["**/*.txt"] }] };
	await assert.rejects(runM09(f.ctx, f.options),
		(error: unknown) => error instanceof HarnessError && error.code === "m09.anti-cheat");
	assert.equal((f.ctx.runner as FakeSessionRunner).created.length, 0);
});
