import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/workspace.ts";

test("raw info loader reads shared text formats and reports binary files", async (t) => {
const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-raw-"));
t.after(() => rm(root, { recursive: true, force: true }));
const ws = new Workspace(root);
await mkdir(ws.rawDir, { recursive: true });
await writeFile(path.join(ws.rawDir, "metadata.json"), "{\"ok\":true}\n");
await writeFile(path.join(ws.rawDir, "notes.md"), "note\n");
await writeFile(path.join(ws.rawDir, "image.png"), "not text");
const raw = await ws.readRawInfo();
assert.deepEqual(raw.items.map((item) => item.name).sort(), ["metadata.json", "notes.md"]);
assert.deepEqual(raw.skipped, ["image.png"]);
assert.equal(raw.items.find((item) => item.name === "metadata.json")?.content, "{\"ok\":true}\n");
});
