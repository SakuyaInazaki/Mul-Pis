import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

test("stage prompt timeout rejects instead of hanging", async (t) => {
const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-timeout-"));
t.after(() => rm(root, { recursive: true, force: true }));
await mkdir(path.join(root, "problem", "raw"), { recursive: true });
await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 }) + "\n");
const service = new ResearchService({
defaultWorkspace: root,
promptTimeoutMs: 20,
runnerFactory: () => new FakeSessionRunner(async () => {
await new Promise<void>(() => undefined);
return { text: "never", reads: [] };
}),
});
await service.init(root);
await assert.rejects(service.runStage({ stage: "M01", workspace: root }), /exceeded prompt timeout/);
});

test("stage stalled prompt aborts instead of waiting forever", async (t) => {
const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-stall-"));
t.after(() => rm(root, { recursive: true, force: true }));
await mkdir(path.join(root, "problem", "raw"), { recursive: true });
await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 }) + "\n");
const service = new ResearchService({
defaultWorkspace: root,
progressIntervalMs: 0,
promptTimeoutMs: 0,
stallTimeoutMs: 20,
stallCheckMs: 5,
runnerFactory: () => new FakeSessionRunner(async () => {
await new Promise<void>(() => undefined);
return { text: "never", reads: [] };
}),
});
await service.init(root);
await assert.rejects(service.runStage({ stage: "M01", workspace: root }), /made no progress/);
});
