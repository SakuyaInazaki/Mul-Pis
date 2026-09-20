import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { failureSignature } from "../src/pi/retry-guard.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";

test("same stage obligation and same failure is bounded after one correction retry", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-retry-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(() => { throw new Error("same offline failure"); }) });
	await service.init(root);
	await assert.rejects(service.runStage({ stage: "M01" }), /same offline failure/);
	await assert.rejects(service.runStage({ stage: "M01" }), /same offline failure/);
	await assert.rejects(service.runStage({ stage: "M01" }), (error: unknown) => {
		assert.equal((error as { code?: string }).code, "control.retry-loop");
		return true;
	});
	assert.equal((await service.status(root)).stages.M01.count, 2);
});

test("completed run records with failures count as failed attempts", () => {
	assert.ok(failureSignature({ record: { status: "completed", failures: ["knowledge merge failed"] } }));
	assert.equal(failureSignature({ record: { status: "completed", failures: [] } }), undefined);
	assert.equal(
		failureSignature({ record: { stage: "M09", status: "failed", failures: ["未实际读取 /tmp/run-a/source.json"] } }),
		failureSignature({ record: { stage: "M09", status: "failed", failures: ["没有读取 /tmp/run-b/trace.json，coverage 不完整"] } }),
	);
});

test("normal shutdown marks only the owned active run failed and late completion cannot overwrite it", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-interrupt-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const service = new ResearchService({ defaultWorkspace: path.join(root, "different-pi-cwd"), runnerFactory: () => new FakeSessionRunner(async () => { await blocked; return "late answer"; }) });
	await service.init(root);
	const pending = service.runStage({ stage: "M01", workspace: root });
	while ((await service.status(root)).stages.M01.count === 0) await new Promise((resolve) => setTimeout(resolve, 2));
	const ws = new Workspace(root);
	const foreign = await ws.startRun("M01", []);
	await service.interruptAllActive("test shutdown");
	release();
	await assert.rejects(pending, /不能覆盖为 completed/);
	const records = await Promise.all((await ws.listRuns("M01")).map((runId) => ws.readRun("M01", runId)));
	const owned = records.find((record) => record.runId !== foreign.runId)!;
	assert.equal(owned.status, "failed");
	assert.match(owned.failures.join("\n"), /host-shutdown/);
	assert.equal((await ws.readRun("M01", foreign.runId)).status, "running");
});
