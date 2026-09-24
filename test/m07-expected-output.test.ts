import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isSafeRelativeOutputPath, resolveExpectedOutputFiles } from "../src/m07/expected-output.ts";

test("expected output resolution expands directories and reports missing files", async (t) => {
const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-expected-"));
t.after(() => rm(root, { recursive: true, force: true }));
await mkdir(path.join(root, "raw"), { recursive: true });
await writeFile(path.join(root, "result.txt"), "result\n");
await writeFile(path.join(root, "raw", "evidence.txt"), "evidence\n");
const resolved = await resolveExpectedOutputFiles(root, [path.join(root, "result.txt"), path.join(root, "raw"), path.join(root, "missing.txt")]);
assert.equal(resolved.length, 3);
assert.ok(resolved[0].files.some((file) => file.endsWith("result.txt")));
assert.ok(resolved[1].files.some((file) => file.endsWith("evidence.txt")));
assert.match(resolved[2].error ?? "", /missing\.txt/);
});

test("expected output path guard accepts relative paths and rejects escapes or whitespace", () => {
  assert.equal(isSafeRelativeOutputPath("result.txt"), true);
  assert.equal(isSafeRelativeOutputPath("raw/evidence(1).txt"), true);
  assert.equal(isSafeRelativeOutputPath("raw/dir/"), true);
  assert.equal(isSafeRelativeOutputPath("raw/detail-<sid>.json"), false);
  assert.equal(isSafeRelativeOutputPath("raw/detail-{sid}.json"), false);
  assert.equal(isSafeRelativeOutputPath("raw/detail-*.json"), false);
  assert.equal(isSafeRelativeOutputPath("raw/detail-${sid}.json"), false);
  assert.equal(isSafeRelativeOutputPath("raw/detail-%s.json"), false);
  assert.equal(isSafeRelativeOutputPath("../escape.txt"), false);
  assert.equal(isSafeRelativeOutputPath(" raw/evidence.txt"), false);
  assert.equal(isSafeRelativeOutputPath("raw/evidence.txt\n"), false);
});
