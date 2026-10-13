import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { verifyLoadedSource } from "../src/runtime/loaded-source.ts";
import type { RunDescriptorV1 } from "../src/runtime/run-descriptor.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

async function writableAgain(target: string): Promise<void> {
	await chmod(target, 0o700);
	for (const name of await readdir(target, { withFileTypes: true })) {
		if (name.isDirectory()) await writableAgain(path.join(target, name.name));
	}
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(path.join(tmpdir(), "workflow-source-binding-"));
	const canonicalRoot = await realpath(root);
	t.after(async () => { await writableAgain(root); await rm(root, { recursive: true, force: true }); });
	for (const dir of ["src/runtime", "src/pi", "extensions", "workflow", "tools"]) await mkdir(path.join(root, dir), { recursive: true });
	await copyFile(new URL("../src/runtime/loaded-source.ts", import.meta.url), path.join(root, "src/runtime/loaded-source.ts"));
	await writeFile(path.join(root, "src/pi/extension.ts"), "export const loaded = true;\n");
	await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
	await writeFile(path.join(root, ".workflow-source.json"), JSON.stringify({ version: 1, sourceRoot: canonicalRoot, sourceCommit: A, preparedAt: new Date().toISOString() }));
	for (const file of ["src/runtime/loaded-source.ts", "src/pi/extension.ts", "package.json", ".workflow-source.json"]) await chmod(path.join(root, file), 0o400);
	for (const dir of ["src/runtime", "src/pi", "src", "extensions", "workflow", "tools", ""]) await chmod(path.join(root, dir), 0o500);
	const loaded = await import(pathToFileURL(path.join(root, "src/runtime/loaded-source.ts")).href);
	return { root: canonicalRoot, loaded: loaded as typeof import("../src/runtime/loaded-source.ts"), entry: pathToFileURL(path.join(canonicalRoot, "src/pi/extension.ts")).href };
}

test("fixed source proof follows the actually imported module and rejects another claimed commit", async t => {
	const f = await fixture(t);
	assert.deepEqual(await f.loaded.verifyLoadedSource(f.entry, f.root), { sourceRoot: f.root, sourceCommit: A });
	const descriptor = { version: 1, instanceId: "i", attemptId: "A001", workspaceId: "w", codeRevision: B,
		loadedSource: { sourceRoot: f.root, sourceCommit: B } } as RunDescriptorV1;
	await assert.rejects(f.loaded.verifyDescriptorLoadedSource(descriptor, f.entry, f.root), /differs from the actually loaded source/);
	await assert.rejects(verifyLoadedSource(f.entry, f.root), /verifier is outside/);
});

test("fixed source requires a descriptor proof and a read-only receipt", async t => {
	const f = await fixture(t);
	const legacy = { version: 1, instanceId: "i", attemptId: "A001", workspaceId: "w", codeRevision: "unrecorded" } as RunDescriptorV1;
	await assert.rejects(f.loaded.verifyDescriptorLoadedSource(legacy, f.entry, f.root), /requires a loadedSource proof/);
	await chmod(path.join(f.root, ".workflow-source.json"), 0o600);
	await assert.rejects(f.loaded.verifyLoadedSource(f.entry, f.root), /receipt is missing, indirect, or writable/);
	assert.equal(await verifyLoadedSource(import.meta.url, ""), undefined);
});
