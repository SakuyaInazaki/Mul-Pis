import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOCUMENT_PAGE_BYTES, DocumentReader } from "../src/console/documents.ts";

async function pages(reader: DocumentReader, file: string): Promise<string[]> {
  const result: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await reader.read(file, offset);
    assert.equal(page.offset, offset);
    assert.equal(page.lines.join(""), page.text);
    result.push(page.text);
    if (page.nextOffset === undefined) return result;
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
  }
}

test("document pages reconstruct long UTF-8 reports without losing newlines or changing the file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-document-"));
  try {
    const file = path.join(root, "report.md");
    const original = `${"甲乙丙\n".repeat(24_000)}尾行\n`;
    await writeFile(file, original);
    const before = await readFile(file);
    const reader = new DocumentReader(root);
    const first = await reader.read(file);
    assert.equal(first.totalBytes, before.length);
    assert(first.nextOffset);
    const chunks = await pages(reader, file);
    assert(chunks.length > 1);
    assert.equal(chunks.join(""), original);
    assert.deepEqual(await readFile(file), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reader removes escape, OSC and bidi text even when control sequences cross pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-document-"));
  try {
    const file = path.join(root, "run.log");
    const prefix = "a".repeat(DOCUMENT_PAGE_BYTES - 1);
    const original = `${prefix}\x1b]0;hidden title\x1b\\\n可见\x1b[31m红色\x1b[0m\u202e文字\n${"后".repeat(25_000)}`;
    await writeFile(file, original);
    const chunks = await pages(new DocumentReader(root), file);
    const rendered = chunks.join("");
    assert(chunks.length > 1);
    assert.equal(rendered, `${prefix}\n可见红色文字\n${"后".repeat(25_000)}`);
    assert(!rendered.includes("hidden title"));
    assert(!rendered.includes("\x1b"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a long OSC stays hidden across multiple bounded pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-document-"));
  try {
    const file = path.join(root, "long-osc.log");
    await writeFile(file, `start\x1b]8;;${"secret".repeat(25_000)}\x07end\n`);
    const chunks = await pages(new DocumentReader(root), file);
    assert(chunks.length >= 3);
    assert.equal(chunks.join(""), "startend\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects outside symlinks, binary files, raw sessions and invalid or stale offsets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-document-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "console-document-outside-"));
  try {
    const reader = new DocumentReader(root);
    const secret = path.join(outside, "secret.md");
    await writeFile(secret, "outside\n");
    await symlink(secret, path.join(root, "link.md"));
    await assert.rejects(reader.read("link.md"), /outside workspace/);
    await assert.rejects(reader.read(secret), /outside workspace/);
    const pdf = path.join(root, "report.pdf");
    await writeFile(pdf, "%PDF-1.7\n");
    await assert.rejects(reader.read(pdf), /PDF.*report\.pdf/);
    const binary = path.join(root, "unknown.txt");
    await writeFile(binary, Buffer.from([65, 0, 66]));
    await assert.rejects(reader.read(binary), /binary data.*unknown\.txt/);
    const session = path.join(root, "session.jsonl");
    await writeFile(session, '{"message":{"role":"assistant"}}\n');
    await assert.rejects(reader.read(session), /Raw JSONL\/session/);
    const report = path.join(root, "report.txt");
    await writeFile(report, "x".repeat(DOCUMENT_PAGE_BYTES + 10));
    await assert.rejects(reader.read(report, 1), /Invalid document page boundary/);
    await assert.rejects(reader.read(report, -1), /Invalid document offset/);
    const first = await reader.read(report);
    assert(first.nextOffset);
    await writeFile(report, "short");
    await assert.rejects(reader.read(report, first.nextOffset), /exceeds/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});


test("registered absolute paths through a workspace alias remain confined and readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "console-document-alias-"));
  try {
    const workspace = path.join(root, "workspace"), alias = path.join(root, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias);
    await writeFile(path.join(workspace, "report.md"), "完整内容\n");
    assert.equal((await new DocumentReader(workspace).read(path.join(alias, "report.md"))).text, "完整内容\n");
    assert.equal((await new DocumentReader(alias).read(path.join(workspace, "report.md"))).text, "完整内容\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
