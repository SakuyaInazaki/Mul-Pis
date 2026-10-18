import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCandidateCommandBackend } from "../src/m07/candidate-command-backend.ts";
import { createCandidateExecutionTools } from "../src/m07/candidate-runner.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }, script: string) {
	const root = await mkdtemp(path.join(tmpdir(), "candidate-command-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workDir = path.join(root, "work"); await mkdir(workDir);
	await writeFile(path.join(workDir, "kernel.txt"), "original source\n");
	const executable = path.join(root, "stage.mjs"); await writeFile(executable, script);
	return { root, workDir, command: { argv: [process.execPath, executable] as [string, string], cwd: root } };
}
const request = { runId: "run1", sourcePaths: ["kernel.txt"], protocolId: "fixture-v1",
	configJson: '{"command":"/not/a/host-command"}', hypothesis: "inspect stage evidence", changeKind: "repair", intent: "solution" };

test("fixed host command environment is copied and cannot be overridden by model config", async t => {
	const h = await fixture(t, `
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const req = JSON.parse((await lines.next()).value);
await writeFile(path.join(req.outputDir, "environment.json"), JSON.stringify({
  selected: process.env.PRE_RSI_ENV_MARKER, supplied: req.config.env?.PRE_RSI_ENV_MARKER
}));
process.stdout.write(JSON.stringify({ version: 1, kind: "result", status: "passed",
  performedChecks: req.stage.checks, receiptPaths: ["environment.json"] }) + "\\n");
`);
	const selected = { PRE_RSI_ENV_MARKER: "host" };
	const backend = createCandidateCommandBackend({ id: "fixed-environment", version: "1", stages: [
		{ id: "contract", checks: ["contract"], mode: "local", execute: { ...h.command, env: selected } },
	] });
	selected.PRE_RSI_ENV_MARKER = "changed-after-binding";
	const tool = createCandidateExecutionTools({ goalRunId: "goal", taskId: "T001", operationId: "O001", workDir: h.workDir,
		journalDir: path.join(h.root, "journals"), backend, evaluate: async () => ({ text: "observed" }) })[0];
	const result = JSON.parse((await tool.execute({ ...request,
		configJson: '{"env":{"PRE_RSI_ENV_MARKER":"model"}}' })).text);
	const saved = JSON.parse(await readFile(result.journalPath, "utf8"));
	const receipt = saved.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/environment.json"));
	assert.deepEqual(JSON.parse(await readFile(receipt.frozenPath, "utf8")), { selected: "host", supplied: "model" });
});

test("fixed host command preserves original compile failure receipts and stops the cascade", async t => {
	const h = await fixture(t, `
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const req = JSON.parse((await lines.next()).value);
const failed = req.stage.id === "compile";
await writeFile(path.join(req.outputDir, "stage.json"), JSON.stringify({ stage: req.stage.id, failed, source: await readFile(req.sources[0].frozenPath, "utf8") }));
process.stdout.write(JSON.stringify({ version: 1, kind: "result", status: failed ? "failed" : "passed",
  performedChecks: req.stage.checks, receiptPaths: ["stage.json"], summary: req.stage.id }) + "\\n");
if (failed) process.exitCode = 2;
`);
	const backend = createCandidateCommandBackend({ id: "host-pipeline", version: "1", stages: [
		{ id: "contract", checks: ["contract"], mode: "local", execute: h.command },
		{ id: "compile", checks: ["compile"], mode: "local", execute: h.command },
		{ id: "correct", checks: ["correctness"], mode: "local", execute: h.command },
	] });
	assert.equal(backend.canQueryStage?.("compile"), false);
	let evaluations = 0;
	const tool = createCandidateExecutionTools({ goalRunId: "goal", taskId: "T001", operationId: "O001", workDir: h.workDir,
		journalDir: path.join(h.root, "journals"), backend, evaluate: async () => { evaluations++; return { text: "evaluated" }; } })[0];
	const result = JSON.parse((await tool.execute(request)).text);
	assert.equal(result.status, "failed");
	assert.deepEqual(result.stages.map((entry: { stage: { id: string } }) => entry.stage.id), ["contract", "compile"]);
	assert.deepEqual(result.stages[1].performedChecks, ["compile"]);
	assert.equal(evaluations, 0, "a compiler failure is evidence, not a made-up correctness verdict");
	const frozen = JSON.parse(await readFile(result.journalPath, "utf8")).stages[1].receiptSnapshots;
	assert.equal(JSON.parse(await readFile(frozen[0].frozenPath, "utf8")).source, "original source\n");
	assert.match(await readFile(frozen[1].frozenPath, "utf8"), /"status":"failed"/);
	assert.equal((await readFile(frozen[2].frozenPath)).length, 0, "raw stderr is retained even when empty");
});

test("delegated command retains original ID, queries it, and evaluates only its explicit receipt", async t => {
	const h = await fixture(t, `
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const req = JSON.parse((await lines.next()).value);
if (req.kind === "execute") {
  process.stdout.write(JSON.stringify({ version: 1, kind: "external-id", externalId: "SID-1" }) + "\\n");
  const ack = JSON.parse((await lines.next()).value);
  if (ack.kind !== "external-id-recorded" || ack.externalId !== "SID-1") throw Error("original ID was not durably acknowledged");
  await writeFile(path.join(req.outputDir, "pending.json"), JSON.stringify({ externalId: "SID-1", status: "pending" }));
  process.stdout.write(JSON.stringify({ version: 1, kind: "result", status: "pending", performedChecks: [],
    receiptPaths: ["pending.json"], externalId: "SID-1" }) + "\\n");
} else {
  if (req.externalId !== "SID-1") throw Error("query must use original ID");
  await writeFile(path.join(req.outputDir, "evaluation.json"), JSON.stringify({ externalId: req.externalId, score: 17 }));
  process.stdout.write(JSON.stringify({ version: 1, kind: "result", status: "passed",
    performedChecks: req.stage.checks, receiptPaths: ["evaluation.json"],
    evaluationReceiptPaths: ["evaluation.json"], externalId: req.externalId }) + "\\n");
}
`);
	const backend = createCandidateCommandBackend({ id: "delegated-host", version: "1", stages: [
		{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated", execute: h.command, query: h.command },
	] });
	assert.equal(backend.canQueryStage?.("judge"), true);
	let observed: unknown;
	const tool = createCandidateExecutionTools({ goalRunId: "goal", taskId: "T001", operationId: "O001", workDir: h.workDir,
		journalDir: path.join(h.root, "journals"), backend, evaluate: async args => {
			const receiptPaths = args.receiptPaths as string[];
			assert.equal(receiptPaths.length, 1, "stdout protocol and stderr are not evaluation receipts");
			observed = JSON.parse(await readFile(path.join(h.workDir, receiptPaths[0]), "utf8"));
			return { text: "independently observed" };
		} })[0];
	const first = JSON.parse((await tool.execute(request)).text);
	assert.equal(first.status, "pending"); assert.equal(first.stages[0].externalId, "SID-1");
	const second = JSON.parse((await tool.execute({ runId: "run1", resume: true })).text);
	assert.equal(second.status, "completed"); assert.equal(second.evaluation, "independently observed");
	assert.deepEqual(observed, { externalId: "SID-1", score: 17 });
	const saved = JSON.parse(await readFile(first.journalPath, "utf8"));
	assert.equal(JSON.parse(await readFile(saved.stages[0].receiptSnapshots[0].frozenPath, "utf8")).status, "pending");
});

test("cancellation and stderr archive errors close command child pipes and retain issued IDs", async t => {
	for (const failure of ["cancellation", "stderr-error"] as const) await t.test(failure, { timeout: 10_000 }, async t => {
		const h = await fixture(t, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const req = JSON.parse((await lines.next()).value);
process.on("SIGTERM", () => {
  writeFileSync(path.join(req.outputDir, "canceled.json"), '{"error":"cancelled"}');
  process.stderr.write("stderr termination tail\\n", () => process.stdout.write(JSON.stringify({ version: 1, kind: "result", status: "failed",
    performedChecks: req.stage.checks, receiptPaths: ["canceled.json"],
    evaluationReceiptPaths: ["canceled.json"] }) + "\\n", () => process.exit(0)));
});
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write(JSON.stringify({ version: 1, kind: "external-id", externalId: "SID-cancel" }) + "\\n");
await lines.next();
process.stderr.write("stderr retained prefix\\n");
if (process.env.PRE_RSI_STDERR_ARCHIVE_FAILURE === "1") process.stderr.write("FAIL-STDERR-ARCHIVE\\n");
setInterval(() => {}, 1000);
	`);
		if (failure === "stderr-error") {
			const probe = await open(path.join(h.root, "handle-probe"), "wx");
			const prototype: FileHandle = Object.getPrototypeOf(probe);
			const originalWrite = prototype.write;
			await probe.close();
			// Inject an archive I/O failure after any preceding bytes. No abort is
			// sent: the stderr error path itself must stop the wrapper and child.
			t.mock.method(prototype, "write", async function(this: FileHandle, bytes: Buffer) {
				const marker = bytes.indexOf("FAIL-STDERR-ARCHIVE");
				if (marker < 0) return originalWrite.bind(this)(bytes);
				if (marker > 0) await originalWrite.bind(this)(bytes.subarray(0, marker));
				throw Object.assign(new Error("injected stderr archive EIO"), { code: "EIO" });
			});
		}
		const signal = new AbortController();
		t.after(() => signal.abort());
		const command = createCandidateCommandBackend({ id: "cancel-host", version: "1", stages: [
			{ id: "judge", checks: ["correctness"], mode: "delegated", execute: {
				...h.command, env: { PRE_RSI_STDERR_ARCHIVE_FAILURE: failure === "stderr-error" ? "1" : "0" },
			} },
		] });
		const tool = createCandidateExecutionTools({ goalRunId: "goal", taskId: "T001", operationId: "O001", workDir: h.workDir,
			journalDir: path.join(h.root, "journals"), backend: { ...command,
				async executeStage(ctx) { return command.executeStage({ ...ctx, async recordExternalId(id) {
					await ctx.recordExternalId(id);
					if (failure === "cancellation") setTimeout(() => signal.abort(), 10);
				} }); } }, evaluate: async () => { throw new Error("canceled execution cannot be evaluated"); } })[0];
		const result = JSON.parse((await tool.execute(request, signal.signal)).text);
		assert.equal(result.status, "unknown");
		assert.equal(result.stages[0].externalId, "SID-cancel");
		const saved = JSON.parse(await readFile(result.journalPath, "utf8"));
		const stageRoot = path.join(h.workDir, ".candidate-runs", "run1", "stages", "judge");
		const invocations = await readdir(stageRoot);
		assert.equal(invocations.length, 1);
		const stderr = await readFile(path.join(stageRoot, invocations[0], "stderr.txt"), "utf8");
		if (failure === "stderr-error") {
			assert.equal(signal.signal.aborted, false, "archive failure must trigger cleanup without external cancellation");
			assert.match(saved.stages[0].error, /injected stderr archive EIO/);
			assert.equal(stderr, "stderr retained prefix\n", "bytes preceding the archive failure remain available");
		} else assert.match(stderr, /stderr termination tail\n$/, "normal stderr is drained through the termination tail");
		assert.equal(JSON.parse((await tool.execute({ runId: "run1", resume: true })).text).status, "unknown");
	});
});
