import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VisibleSessionReader } from "../src/console/session-output.ts";

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-session-"));
  const file = path.join(root, ".agent", "sessions", "one.jsonl");
  const run = path.join(root, "stages", "M04", "one");
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(run, { recursive: true });
  await writeFile(path.join(run, "run.json"), JSON.stringify({ stage: "M04", runId: "one", sessions: [{ id: "s1", file }] }));
  return { root, file };
}

test("reads every registered visible message without exposing prompts, thinking, or raw records", async () => {
  const { root, file } = await fixture();
  try {
    const rows: unknown[] = [
      { type: "session", secret: "raw-secret" },
      { type: "message", message: { role: "system", content: [{ type: "text", text: "system-secret" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "prompt-secret" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden-secret" }, { type: "text", text: "首段\n次行" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "工具\x1b]0;title\x07正文\u202e" }, { type: "image", data: "image-secret" }] } },
      { type: "message", message: { role: "assistant", type: "text", text: "旧格式" } },
      { type: "message", message: { role: "assistant", type: "thinking", text: "typed-thinking-secret" } },
    ];
    for (let i = 0; i < 30; i++) rows.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `第${i}条` }] } });
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const before = await readFile(file);
    const messages = await new VisibleSessionReader(root).read(file);
    assert.equal(messages.length, 33);
    assert.deepEqual(messages.slice(0, 3), ["首段\n次行", "工具正文", "旧格式"]);
    assert.equal(messages.at(-1), "第29条");
    assert(!messages.join("\n").includes("secret"));
    assert.deepEqual(await readFile(file), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects unregistered sessions and symlinks outside the workspace", async () => {
  const { root, file } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "console-session-outside-"));
  try {
    await writeFile(file, '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}\n');
    const reader = new VisibleSessionReader(root);
    assert.deepEqual(await reader.read(file), ["ok"]);
    const other = path.join(root, "unregistered.jsonl");
    await writeFile(other, await readFile(file));
    await assert.rejects(reader.read(other), /not registered/);
    const external = path.join(outside, "private.jsonl");
    await writeFile(external, "{}\n");
    await symlink(external, path.join(root, "outside.jsonl"));
    await assert.rejects(reader.read("outside.jsonl"), /outside workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("malformed or oversized sessions fail explicitly", async () => {
  const { root, file } = await fixture();
  try {
    const reader = new VisibleSessionReader(root);
    await writeFile(file, "{bad}\n");
    await assert.rejects(reader.read(file), /Invalid session JSONL line 1/);
    await writeFile(file, "x".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(reader.read(file), /line exceeds/);
    await truncate(file, 64 * 1024 * 1024 + 1);
    await assert.rejects(reader.read(file), /JSONL exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
