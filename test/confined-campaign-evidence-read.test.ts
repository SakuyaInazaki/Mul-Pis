import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";

test("confined full evidence read does not truncate large machine feedback or enlarge write authority", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "confined-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const evidence = JSON.stringify({ samples: "x".repeat(250_000), terminal: "complete-host-result" });
	await writeFile(path.join(root, "machine-feedback.json"), evidence);
	const tools = await createConfinedCampaignFileTools(root, { writableFiles: ["candidate.txt"] });
	const read = tools.find(tool => tool.name === "read")!, write = tools.find(tool => tool.name === "write")!;
	assert.equal((await read.execute({ path: "machine-feedback.json" })).text, evidence);
	await assert.rejects(write.execute({ path: "machine-feedback.json", content: "forged" }), /allowlist/);
	await assert.rejects(write.execute({ path: "candidate.txt", content: "x".repeat(128_001) }), /limit/);
	await writeFile(path.join(root, "oversized.json"), "x".repeat(1_000_001));
	await assert.rejects(read.execute({ path: "oversized.json" }), /read limit/);
});
