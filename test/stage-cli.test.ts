import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import { readCurrentProcessIdentity } from "../src/runtime/process-identity.ts";

async function capture(action: () => Promise<number>): Promise<{ code: number; output: string }> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try { return { code: await action(), output: lines.join("\n") }; }
	finally { console.log = original; }
}

test("CLI M08 reads explicit JSON inputs and runs the real stage with the fake runner", async (t) => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-m08-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await capture(() => main(["init", "--workspace", root]));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "CLI 审查问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { reviewer: "fake/reviewer" }, concurrency: 1 })}\n`);
	const artifact = path.join(root, "artifact.md");
	await writeFile(artifact, "待审查成果\n");
	const materials = path.join(root, "materials.json"), checks = path.join(root, "checks.json"), reviewers = path.join(root, "reviewers.json");
	await writeFile(materials, `${JSON.stringify([{ label: "成果", path: artifact, sourceCategory: "result", providedScope: "全文" }])}\n`);
	await writeFile(checks, `${JSON.stringify([{ id: "scope", instruction: "核对目标同一性" }])}\n`);
	await writeFile(reviewers, `${JSON.stringify([{ id: "external", role: "reviewer" }])}\n`);
	const result = await capture(() => main(["m08", "--workspace", root, "--runner", "fake", "--materials", materials, "--self-checks", checks, "--reviewers", reviewers]));
	assert.equal(result.code, 0);
	assert.match(result.output, /M08 已结束：.*状态 completed/);
	assert.match(result.output, /review-bundle\.md/);
});

test("a CLI mutation takes the same workspace ownership as the extension service", async (t) => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-owner-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await capture(() => main(["init", "--workspace", root]));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/execution" }, concurrency: 1 })}\n`);
	const ownerDir = path.join(root, ".agent", "console");
	await mkdir(ownerDir, { recursive: true, mode: 0o700 });
	const identity = await readCurrentProcessIdentity();
	await writeFile(path.join(ownerDir, "owner.lock"), `${JSON.stringify({ version: 1, kind: "mutation",
		process: { ...identity, processStartToken: `${identity.processStartToken}-other` } })}\n`, { mode: 0o600 });
	await assert.rejects(main(["m01", "--workspace", root, "--runner", "fake"]), /already owned|owner is unknown/);
	const readOnly = await capture(() => main(["status", "--workspace", root]));
	assert.equal(readOnly.code, 0, "a read-only command never needs the mutation lock");
});

test("the CLI refuses a host candidate configuration it cannot trust", async (t) => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-host-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previous = process.env.PRE_RSI_LOCAL_OPERATOR_CONFIG;
	t.after(() => { if (previous === undefined) delete process.env.PRE_RSI_LOCAL_OPERATOR_CONFIG; else process.env.PRE_RSI_LOCAL_OPERATOR_CONFIG = previous; });
	await capture(() => main(["init", "--workspace", root]));
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/execution" }, concurrency: 1 })}\n`);
	process.env.PRE_RSI_LOCAL_OPERATOR_CONFIG = "relative/host.json";
	const task = path.join(root, "task.json");
	await writeFile(task, `${JSON.stringify({ objective: "x", inputs: [], expectedOutputs: ["a.txt"], checks: ["c"], mode: "execute" })}\n`);
	await assert.rejects(main(["goal", "delegate", "--workspace", root, "--run", "M07-0001", "--task", task, "--runner", "fake"]),
		/absolute host-owned configuration/);
});

test("one declarative spec file runs an M08 review and records its oracle strength", async (t) => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-spec-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await capture(() => main(["init", "--workspace", root]));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "规格化审查问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { reviewer: "fake/reviewer" }, concurrency: 1 })}\n`);
	const artifact = path.join(root, "artifact.md");
	await writeFile(artifact, "待审查成果\n");
	const spec = path.join(root, "review.spec.json");
	await writeFile(spec, `${JSON.stringify({ version: 1, stage: "M08",
		provenance: { oracleStrength: "weak", source: "本地固定材料", license: "internal" },
		materials: [{ label: "成果", path: artifact, sourceCategory: "result", providedScope: "全文" }],
		selfChecks: [{ id: "scope", instruction: "核对目标同一性" }],
		reviewers: [{ id: "external", role: "reviewer" }] })}\n`);
	const result = await capture(() => main(["m08", "--workspace", root, "--runner", "fake", "--spec", spec]));
	assert.equal(result.code, 0);
	assert.match(result.output, /oracle 强度：weak/);
	assert.match(result.output, /独立检查的结论强度受限/);
	assert.match(result.output, /M08 已结束：.*状态 completed/);
	const broken = path.join(root, "broken.spec.json");
	await writeFile(broken, `${JSON.stringify({ version: 1, stage: "M08", materials: [], selfChecks: [], reviewers: [] })}\n`);
	await assert.rejects(main(["m08", "--workspace", root, "--runner", "fake", "--spec", broken]), /provenance/);
	const wrongStage = path.join(root, "wrong.spec.json");
	await writeFile(wrongStage, `${JSON.stringify({ version: 1, stage: "M09", provenance: { oracleStrength: "strong", source: "s" },
		m08RunId: "a", m04RunId: "b", recipient: "c", purpose: "d" })}\n`);
	await assert.rejects(main(["m08", "--workspace", root, "--runner", "fake", "--spec", wrongStage]), /declares stage M09/);
});
