import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runResearchPreflight } from "../src/pi/preflight.ts";

test("research preflight records bounded read-only checks", async (t) => {
const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-preflight-"));
t.after(() => rm(root, { recursive: true, force: true }));
const calls: string[] = [];
const execFile = async (file: string, args: string[]) => {
calls.push(`${file} ${args.join(" ")}`);
if (file === "nvcc") throw new Error("nvcc missing");
return { stdout: `${file} ok` };
};
const result = await runResearchPreflight(root, { execFile: execFile as never });
assert.equal(result.version, 1);
assert.equal(result.workspace, root);
assert.ok(result.checks.some((check) => check.name === "node" && check.status === "available"));
assert.ok(result.checks.some((check) => check.name === "nvcc" && check.status === "unavailable"));
assert.ok(calls.some((entry) => entry.startsWith("nvidia-smi")));
assert.ok(result.checks.some((check) => check.name === "platform-material" && check.status === "unavailable"));
assert.ok(result.checks.some((check) => check.name === "platform-channel" && check.status === "unknown"));
const persisted = JSON.parse(await readFile(result.reportPath, "utf8"));
assert.equal(persisted.reportPath, result.reportPath);
});
