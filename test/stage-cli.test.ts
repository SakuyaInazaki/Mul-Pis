import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";

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
