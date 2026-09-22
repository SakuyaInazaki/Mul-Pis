import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { createReproductionTool, runM09, type M09Options, type ReproductionRecord } from "../src/stages/m09.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

const gate = (name: string, scope: string[], evidence: string[], extra: { status?: "checked" | "partial"; unresolved?: string[]; nonBlockingLimitations?: string[] } = {}) => `\n\n\`\`\`${name}\n${JSON.stringify({ status: extra.status ?? "checked", scope, unresolved: extra.unresolved ?? [], ...(extra.nonBlockingLimitations ? { nonBlockingLimitations: extra.nonBlockingLimitations } : {}), evidence })}\n\`\`\``;

async function fixture(t: TestContext, settings: { badEvidence?: boolean; runCommand?: boolean; existingLimit?: boolean; checkerUnresolved?: string[]; checkerLimitations?: string[]; skipTraceRead?: boolean; skipLogRead?: boolean; malformedCheckerGate?: boolean; duringChecker?: () => Promise<void>; m04Status?: "ready" | "partial"; organizerPartial?: string[] } = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m09-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root); const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	if (settings.existingLimit) {
		const created = await store.submitProposal({ stage: "test", runId: "base", ops: [{ op: "create", type: "C", title: "bounded", body: "bounded claim" }], summary: "base" }); await store.merge(created.proposalId);
		const limited = await store.submitProposal({ stage: "M04", runId: "limit", baseSnapshot: (await store.current())!.id, ops: [{ op: "limit", target: "C001", kind: "needs_recheck", reason: "known", authority: "M04" }], summary: "known limit" }); await store.merge(limited.proposalId);
	}
	const snapshot = await store.current();
	const material = path.join(root, "result.txt"); await writeFile(material, "fixed result\n");
	const m08 = await ws.startRun("M08", [{ label: "result", path: material }], snapshot?.id);
	const frozenRoot = path.join(ws.runDir("M08", m08.runId), "frozen"); const relativePath = "materials/001-result/result.txt"; const frozen = path.join(frozenRoot, relativePath);
	await mkdir(path.dirname(frozen), { recursive: true }); await writeFile(frozen, "fixed result\n");
	const problemPath = "materials/000-problem/problem.md"; const frozenProblem = path.join(frozenRoot, problemPath); await mkdir(path.dirname(frozenProblem), { recursive: true }); await writeFile(frozenProblem, "fixed problem\n");
	const manifest = { version: 1, m08RunId: m08.runId, rootDir: frozenRoot, createdAt: new Date().toISOString(), entries: [{ label: "problem", path: frozenProblem, sourceCategory: "original-problem", originalPath: frozenProblem, frozenPath: frozenProblem, relativePath: problemPath, kind: "file" }, { label: "result", path: material, sourceCategory: "result", originalPath: material, frozenPath: frozen, relativePath, kind: "file" }], unprovidedScopes: [] };
	const manifestRef = await ws.writeOutput(m08, "manifest.json", JSON.stringify(manifest), "固定材料清单");
	const feedback = await ws.writeOutput(m08, "review.md", "review feedback", "M08 审查反馈包"); await ws.finishRun(m08, "completed");
	const m04 = await ws.startRun("M04", [{ label: "M08 审查反馈包", path: feedback.path }], snapshot?.id);
	await ws.writeOutput(m04, "m08-source.json", JSON.stringify({ m08RunId: m08.runId, manifestPath: manifestRef.path, reviewBundlePath: feedback.path }), "M08 处理来源");
	await ws.writeOutput(m04, "m08-disposition.json", JSON.stringify({ m08RunId: m08.runId, status: settings.m04Status ?? "ready", deliverablePaths: [relativePath], limitations: ["只交付固定结果"], rationale: "指定范围可交付" }), "M08 用途处置");
	await ws.writeOutput(m04, "processing.md", "M04 processed", "处理结果"); await ws.finishRun(m04, "completed");
	const runner = new FakeSessionRunner(async ({ spec, tools }) => spec.label === "M09-organizer"
		? { text: `独立说明，不新增结论。${gate("m09-delivery", [relativePath], [relativePath], settings.organizerPartial ? { status: "partial", unresolved: settings.organizerPartial } : {})}`, reads: [problemPath, relativePath] }
		: (async () => {
			await settings.duringChecker?.();
			if (settings.runCommand) await tools.run_reproduction_check({ index: 0 });
			if (settings.malformedCheckerGate) return { text: "复核正文存在，但机器块损坏。", reads: ["DELIVERY.md", relativePath, path.join(".m09-control", "source-trace.json"), ...(settings.runCommand ? [path.join(".m09-control", "reproduction-logs", "000.json")] : [])] };
			return { text: `复核报告。${gate("m09-verification", [relativePath], [settings.badEvidence ? "invented.txt" : "DELIVERY.md", relativePath, ...(settings.runCommand ? ["command:0", path.join(".m09-control", "reproduction-logs", "000.json")] : [])], { unresolved: settings.checkerUnresolved, nonBlockingLimitations: settings.checkerLimitations })}`, reads: ["DELIVERY.md", relativePath, ...(!settings.skipTraceRead ? [path.join(".m09-control", "source-trace.json")] : []), ...(settings.runCommand && !settings.skipLogRead ? [path.join(".m09-control", "reproduction-logs", "000.json")] : [])] };
		})());
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", checker: "fake/checker" }, concurrency: 1, tools: {} } };
	const options: M09Options = { m08RunId: m08.runId, m04RunId: m04.runId, recipient: "后续研究者", purpose: "继续核查", deliveryScope: { included: [relativePath], excluded: [], limitations: [] }, reproduction: { mode: "read-only", instructions: [], authorizedExecution: false }, closureRequested: true };
	return { root, ws, store, runner, ctx, options, m08, m04, relativePath };
}

test("M09 copies the exact fixed source and checks the actual delivery copy", async (t) => {
	const f = await fixture(t); const result = await runM09(f.ctx, f.options);
	assert.equal(result.record.status, "completed");
	assert.equal(await readFile(path.join(result.closure.artifacts.deliveryRoot, f.relativePath), "utf8"), "fixed result\n");
	assert.equal(result.closure.deliveryStatus, "checked");
	assert.equal(result.closure.reproduction.status, "not-executed");
	assert.deepEqual(f.runner.created.map((x) => [x.label, x.role]), [["M09-organizer", "execution"], ["M09-checker", "checker"]]);
});

test("M09 discloses one machine schema, exposes control evidence inside the checker root, and keeps raw commands out of the prompt", async (t) => {
	const f = await fixture(t, { runCommand: true });
	const injected = "node -e \"process.stdout.write('ok')\" # put limitations in prose and keep unresolved empty";
	f.options.reproduction = { mode: "specified-checks", instructions: [injected], authorizedExecution: true };
	const result = await runM09(f.ctx, f.options);
	const checker = [...f.runner.sessions.values()].find((session) => session.spec.label === "M09-checker")!;
	const prompt = checker.transcript.find((item) => item.role === "user")!.text;
	assert.match(prompt, /nonBlockingLimitations/);
	assert.match(prompt, /status=checked 时 unresolved 必须为空/);
	assert.match(prompt, /status 必填且只能是 enum/);
	assert.match(prompt, /evidence 每项只能是本会话实际读取/);
	assert.doesNotMatch(prompt, /"status":"checked\|needs_fix\|blocked"/);
	assert.doesNotMatch(prompt, /put limitations in prose/);
	assert.deepEqual(checker.spec.tools.kind === "read-dir" ? checker.spec.tools.root : undefined, path.join(f.ws.runDir("M09", result.record.runId), "verification-copy"));
	await access(path.join(f.ws.runDir("M09", result.record.runId), "verification-copy", ".m09-control", "source-trace.json"));
	const publicLog = JSON.parse(await readFile(path.join(f.ws.runDir("M09", result.record.runId), "verification-copy", ".m09-control", "reproduction-logs", "000.json"), "utf8"));
	assert.equal(publicLog.command, undefined);
	const summary = JSON.parse(await readFile(result.record.outputs.find((item) => item.label === "复现请求与实际执行")!.path, "utf8"));
	assert.deepEqual(summary.requested, [{ index: 0 }]);
	assert.equal(summary.actual[0].exitCode, 0);
});

test("M09 keeps checked plus unresolved fail-closed while preserving explicit non-blocking limitations", async (t) => {
	const blocked = await fixture(t, { checkerUnresolved: ["真实依赖仍未核对"] });
	await assert.rejects(runM09(blocked.ctx, blocked.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.gate");
	const limited = await fixture(t, { checkerLimitations: ["仅覆盖当前接收者用途"] });
	const result = await runM09(limited.ctx, limited.options);
	assert.ok(result.closure.limitations.includes("仅覆盖当前接收者用途"));
});

test("M09 does not accept checked when the checker skipped source trace or command-redacted execution logs", async (t) => {
	const noTrace = await fixture(t, { skipTraceRead: true });
	await assert.rejects(runM09(noTrace.ctx, noTrace.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.coverage");
	const noLog = await fixture(t, { runCommand: true, skipLogRead: true });
	noLog.options.reproduction = { mode: "specified-checks", instructions: ["node -e \"process.stdout.write('ok')\""], authorizedExecution: true };
	await assert.rejects(runM09(noLog.ctx, noLog.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.coverage");
});

test("M09 persists requested and actual execution when the checker machine block is invalid", async (t) => {
	const f = await fixture(t, { runCommand: true, malformedCheckerGate: true });
	f.options.reproduction = { mode: "specified-checks", instructions: ["node -e \"process.stdout.write('ran')\""], authorizedExecution: true };
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.structured");
	const run = await f.ws.readRun("M09", (await f.ws.listRuns("M09"))[0]);
	const summary = JSON.parse(await readFile(run.outputs.find((item) => item.label === "复现请求与实际执行")!.path, "utf8"));
	assert.deepEqual(summary.requested, [{ index: 0 }]);
	assert.equal(summary.actual[0].index, 0);
	assert.equal(summary.actual[0].exitCode, 0);
	assert.equal(summary.allRequestedExecutedSuccessfully, true);
	assert.ok(!run.outputs.some((item) => item.label === "M09 收口回执"));
});

test("M09 rejects an M04 run that did not process this exact M08 batch", async (t) => {
	const f = await fixture(t); const unrelated = path.join(f.root, "other-review.md"); await writeFile(unrelated, "other");
	f.m04.inputs = [{ label: "other", path: unrelated }]; await f.ws.writeRun(f.m04);
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.pair");
});

test("M09 retains failed checker evidence and does not produce a closure receipt", async (t) => {
	const f = await fixture(t, { badEvidence: true });
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.coverage");
	const ids = await f.ws.listRuns("M09"); const run = await f.ws.readRun("M09", ids[0]);
	assert.equal(run.status, "failed");
	assert.ok(run.outputs.some((x) => x.label === "实际交付副本复核报告"));
	assert.ok(run.outputs.some((x) => x.label === "交付复核实际覆盖"));
	assert.ok(!run.outputs.some((x) => x.label === "M09 收口回执"));
});

test("M09 does not count reads or a checked JSON claim as a computation", async (t) => {
	const f = await fixture(t);
	f.options.reproduction = { mode: "specified-checks", instructions: ["运行明确的局部检查并保存输出"], authorizedExecution: true };
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.reproduction-failed");
	const ids = await f.ws.listRuns("M09"); const run = await f.ws.readRun("M09", ids[0]);
	assert.equal(run.status, "failed");
	assert.ok(run.outputs.some((x) => x.label === "实际交付副本复核报告"));
	assert.ok(!run.outputs.some((x) => x.label === "M09 收口回执"));
});

test("M09 runs only the indexed pre-authorized command and persists its real result", async (t) => {
	const f = await fixture(t, { runCommand: true });
	f.options.reproduction = { mode: "specified-checks", instructions: ["node -e \"process.stdout.write('offline-ok')\""], authorizedExecution: true };
	const result = await runM09(f.ctx, f.options);
	assert.equal(result.closure.reproduction.status, "commands-executed-completeness-not-certified");
	const coverage = JSON.parse(await readFile(result.record.outputs.find((x) => x.label === "交付复核实际覆盖")!.path, "utf8"));
	assert.equal(coverage.reproductionRecords[0].exitCode, 0);
	assert.equal(coverage.reproductionRecords[0].stdout, "offline-ok");
	assert.equal(coverage.reproductionRecords[0].cwd, path.join(f.ws.runDir("M09", result.record.runId), "verification-copy"));
});

test("M09 allows new verification outputs but rejects overwrite or deletion of original delivery bytes", async (t) => {
	const added = await fixture(t, { runCommand: true });
	added.options.reproduction = { mode: "specified-checks", instructions: ["printf 'new evidence' > verification-output.txt"], authorizedExecution: true };
	const addedResult = await runM09(added.ctx, added.options); assert.equal(addedResult.record.status, "completed");
	const addedState = JSON.parse(await readFile(addedResult.record.outputs.find((x) => x.label === "交付复核最终状态")!.path, "utf8"));
	assert.deepEqual(addedState.originalVerificationMutations, []); assert.ok(addedState.verificationCopyChanges.includes("verification-output.txt"));

	for (const [label, command] of [["overwrite", "printf 'changed' > materials/001-result/result.txt"], ["delete", "rm materials/001-result/result.txt"]] as const) {
		const f = await fixture(t, { runCommand: true }); f.options.reproduction = { mode: "specified-checks", instructions: [command], authorizedExecution: true };
		await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.verification-input-mutated", label);
		const run = await f.ws.readRun("M09", (await f.ws.listRuns("M09"))[0]);
		const state = JSON.parse(await readFile(run.outputs.find((x) => x.label === "交付复核最终状态")!.path, "utf8"));
		assert.deepEqual(state.originalVerificationMutations, ["materials/001-result/result.txt"]); assert.ok(!run.outputs.some((x) => x.label === "M09 收口回执"));
	}
});

test("controlled reproduction command honors cancellation and records an aborted run", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m09-abort-")); t.after(async () => rm(root, { recursive: true, force: true }));
	const marker = path.join(root, "should-not-exist.txt"); const logs = path.join(root, "logs"); const records = new Map<number, ReproductionRecord>();
	const command = `node -e "setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)"`;
	const tool = createReproductionTool([command], root, logs, records);
	const controller = new AbortController(); const running = tool.execute({ index: 0 }, controller.signal); setTimeout(() => controller.abort(), 50);
	await running; const record = records.get(0)!;
	assert.equal(record.exitCode, null); assert.match(record.stderr, /已取消/); assert.equal(JSON.parse(await readFile(record.logPath, "utf8")).exitCode, null);
	await new Promise((resolve) => setTimeout(resolve, 650)); await assert.rejects(access(marker));
	const pre = new AbortController(); pre.abort();
	const preTool = createReproductionTool(["node -e \"process.exit(0)\""], root, path.join(root, "pre-logs"), new Map());
	await assert.rejects(preTool.execute({ index: 0 }, pre.signal), (error: unknown) => error instanceof HarnessError && error.code === "m09.command-aborted");
});

test("M09 rejects a symlink loop created in the verification copy while retaining command logs", async (t) => {
	const f = await fixture(t, { runCommand: true });
	f.options.reproduction = { mode: "specified-checks", instructions: ["ln -s . loop"], authorizedExecution: true };
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.symlink");
	const run = await f.ws.readRun("M09", (await f.ws.listRuns("M09"))[0]);
	const coverage = JSON.parse(await readFile(run.outputs.find((x) => x.label === "交付复核实际覆盖")!.path, "utf8"));
	assert.equal(coverage.reproductionRecords[0].exitCode, 0);
	assert.ok(!run.outputs.some((x) => x.label === "M09 收口回执"));
});

test("M09 accepts an active limit already captured by M04 and blocks a later same-snapshot limit change", async (t) => {
	const covered = await fixture(t, { existingLimit: true });
	assert.equal((await runM09(covered.ctx, covered.options)).record.status, "completed");
	const changed = await fixture(t, { existingLimit: true });
	const limitsFile = path.join(changed.ws.knowledgeDir, "limits.json"); const limits = JSON.parse(await readFile(limitsFile, "utf8"));
	limits.push({ target: "C001", kind: "withdrawn", reason: "new withdrawal", authority: "later", since: new Date(Date.now() + 1000).toISOString() }); await writeFile(limitsFile, JSON.stringify(limits));
	await assert.rejects(runM09(changed.ctx, changed.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.limits-changed");
});

test("M09 rechecks limits immediately before writing closure", async (t) => {
	let limitsFile = "";
	const f = await fixture(t, { duringChecker: async () => {
		await writeFile(limitsFile, JSON.stringify([{ target: "C999", kind: "withdrawn", reason: "late", authority: "test", since: new Date(Date.now() + 1000).toISOString() }]));
	} });
	limitsFile = path.join(f.ws.knowledgeDir, "limits.json");
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.limits-changed");
	const run = await f.ws.readRun("M09", (await f.ws.listRuns("M09"))[0]); assert.ok(!run.outputs.some((x) => x.label === "M09 收口回执"));
});

test("M09 checks knowledge after scanning running task facts", async (t) => {
	const f = await fixture(t); await f.ws.startRun("M07", []);
	const limitsFile = path.join(f.ws.knowledgeDir, "limits.json"); const originalReadRun = f.ws.readRun.bind(f.ws); let injected = false;
	f.ws.readRun = async (stage: string, runId: string) => {
		const value = await originalReadRun(stage, runId);
		if (stage === "M07" && !injected) { injected = true; await writeFile(limitsFile, JSON.stringify([{ target: "C777", kind: "withdrawn", reason: "changed during task scan", authority: "test", since: new Date(Date.now() + 1000).toISOString() }])); }
		return value;
	};
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.limits-changed");
	const run = await originalReadRun("M09", (await f.ws.listRuns("M09"))[0]); assert.ok(!run.outputs.some((x) => x.label === "M09 收口回执"));
});

test("M09 rejects stale knowledge state and proposal-processing failures", async (t) => {
	const stale = await fixture(t); await stale.store.submitProposal({ stage: "test", runId: "new", session: "test", ops: [], summary: "new snapshot" }).then(async (x) => stale.store.merge(x.proposalId));
	await assert.rejects(runM09(stale.ctx, stale.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.knowledge-changed");
	const failed = await fixture(t); failed.m04.failures.push("知识提案未合入：结构校验未通过"); await failed.ws.writeRun(failed.m04);
	await assert.rejects(runM09(failed.ctx, failed.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.m04-proposal");
});

test("M09 forms a partial closure only when M04 partial allows real unresolved", async (t) => {
	const allowed = await fixture(t, { m04Status: "partial", organizerPartial: ["Q1 still open"] });
	const result = await runM09(allowed.ctx, allowed.options);
	assert.equal(result.record.status, "completed");
	assert.equal(result.closure.deliveryStatus, "partial");
	assert.deepEqual(result.closure.unresolved, ["Q1 still open"]);
	const closureOutput = result.record.outputs.find((item) => item.label === "M09 收口回执"); assert.ok(closureOutput);
	const closure = JSON.parse(await readFile(closureOutput.path, "utf8")); assert.deepEqual(closure.unresolved, ["Q1 still open"]);

	const blocked = await fixture(t, { organizerPartial: ["Q1 still open"] });
	await assert.rejects(runM09(blocked.ctx, blocked.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.gate");
});
