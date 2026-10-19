/**
 * The workflow bundle is documentation that the harness actually loads: the
 * runtime prompts live in workflow/v1.0/提示词/, the compendium quotes them,
 * and 文件清单.md records their identity. Those three drifted apart silently
 * before. Checking them mechanically is the only thing that keeps a prompt
 * edit from leaving the documented workflow describing a different system.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflow", "v1.0");
const ROW = /^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/;

test("文件清单 records the current size and digest of every listed bundle file", async () => {
	const manifest = await readFile(path.join(bundle, "文件清单.md"), "utf8");
	const rows = manifest.split("\n").map(line => ROW.exec(line.trim())).filter((row): row is RegExpExecArray => Boolean(row));
	assert.ok(rows.length >= 20, "清单行数异常，可能被改成了别的格式");
	for (const [, name, size, digest] of rows) {
		const bytes = await readFile(path.join(bundle, name));
		assert.equal(bytes.byteLength, Number(size), `${name} 的字节数与清单不符`);
		assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, `${name} 的内容与清单不符`);
	}
	const listed = new Set(rows.map(row => row[1]));
	for (const name of await readdir(path.join(bundle, "提示词")))
		assert.ok(listed.has(path.join("提示词", name)), `提示词 ${name} 没有出现在文件清单里`);
});

test("提示词全集 quotes every runtime prompt verbatim", async () => {
	const compendium = await readFile(path.join(bundle, "提示词全集.md"), "utf8");
	const sections = new Map<string, string>();
	const headings = [...compendium.matchAll(/^## (P[0-9A-Z]+)｜.*$/gm)];
	for (const [index, heading] of headings.entries()) {
		const start = heading.index!;
		const end = index + 1 < headings.length ? headings[index + 1].index! : compendium.length;
		const fenced = /```text\n([\s\S]*?)\n```/.exec(compendium.slice(start, end));
		if (fenced) sections.set(heading[1], fenced[1].replace(/\n+$/, ""));
	}
	const names = await readdir(path.join(bundle, "提示词"));
	assert.ok(names.length > 0);
	for (const name of names) {
		const code = name.split("_")[0];
		const text = (await readFile(path.join(bundle, "提示词", name), "utf8")).replace(/\n+$/, "");
		const quoted = sections.get(code);
		assert.ok(quoted !== undefined, `提示词全集 缺少 ${code} 小节`);
		assert.equal(quoted, text, `提示词全集 的 ${code} 小节与运行时提示词不一致`);
	}
});
