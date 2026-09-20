/**
 * references/ workspace records (手册 第八章): search logs, source registration and the index.
 * Registration is the only way material enters `sources/`; nothing is registered unless a
 * file was actually obtained, and the record states exactly what was obtained.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "./types.ts";
import { nowIso, writeFileAtomic, type Workspace } from "./workspace.ts";

export type SourceKind = "paper" | "preprint" | "webpage" | "forum" | "dataset" | "book" | "code" | "documentation" | "other";

export interface SourceFile {
	path: string;
	role: "original" | "extracted" | "page-image" | "other";
	note?: string;
}

export interface SourceRegistration {
	title: string;
	kind: SourceKind;
	authors?: string;
	identifier?: string;
	url?: string;
	version?: string;
	accessedAt?: string;
	/** What was actually obtained: 全文 / 摘要 / 部分页 / 仅元数据 ... */
	obtainedRange: string;
	files: SourceFile[];
	completeness?: string;
	notes?: string;
	/** Why it was registered (relevance to the current gap). Not a judgement of validity. */
	relevance?: string;
	registeredBy: { stage: string; runId: string; session?: string };
}

export interface RegisteredSource {
	id: string;
	dir: string;
	sourceFile: string;
	files: string[];
}

export async function nextSourceId(ws: Workspace): Promise<string> {
	const dir = path.join(ws.referencesDir, "sources");
	await mkdir(dir, { recursive: true });
	let max = 0;
	for (const name of await readdir(dir)) {
		const m = /^S(\d{3,})/.exec(name);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `S${String(max + 1).padStart(3, "0")}`;
}

export async function registerSource(ws: Workspace, reg: SourceRegistration): Promise<RegisteredSource> {
	if (!reg.title.trim()) throw new HarnessError("references.register", "登记需要标题");
	if (!reg.files.length) throw new HarnessError("references.register", "没有实际取得的文件，不能登记；未取得的材料只能记为线索或缺口");
	for (const f of reg.files) {
		if (!existsSync(f.path) || !(await stat(f.path)).isFile()) throw new HarnessError("references.register", `文件不存在：${f.path}`);
	}
	const id = await nextSourceId(ws);
	const dir = path.join(ws.referencesDir, "sources", id);
	await mkdir(dir, { recursive: true });
	const copied: string[] = [];
	const used = new Set<string>();
	const fileRows: string[] = [];
	for (const f of reg.files) {
		let name = path.basename(f.path);
		if (name === "source.md") name = "source.original.md";
		let candidate = name;
		let n = 2;
		while (used.has(candidate)) candidate = `${path.parse(name).name}-${n++}${path.parse(name).ext}`;
		used.add(candidate);
		const dest = path.join(dir, candidate);
		await copyFile(f.path, dest);
		copied.push(dest);
		fileRows.push(`- ${candidate}（${f.role}${f.note ? `；${f.note}` : ""}）`);
	}
	const accessedAt = reg.accessedAt ?? nowIso();
	const sourceMd = `# ${reg.title.trim()}

- 来源编号：${id}
- 类型：${reg.kind}
- 作者/机构：${reg.authors ?? "未记录"}
- 标识：${reg.identifier ?? "无"}
- 地址：${reg.url ?? "无"}
- 版本：${reg.version ?? "未记录"}
- 获取日期：${accessedAt}
- 实际取得范围：${reg.obtainedRange}
- 完整性与缺失：${reg.completeness ?? "未单独核对"}
- 登记者：${reg.registeredBy.stage} 运行 ${reg.registeredBy.runId}${reg.registeredBy.session ? `（会话 ${reg.registeredBy.session}）` : ""}

## 文件

${fileRows.join("\n")}

## 与当前缺口的关系（登记理由，不是有效性判断）

${reg.relevance?.trim() || "未记录"}

## 备注

${reg.notes?.trim() || "无"}

> 取得状态以本文件为准；实际阅读与核对以 reading/${id}.md 为准；是否用于项目及条件以知识记录为准。找到、取得、读过、摘录准确、适用不能自动升级。
`;
	const sourceFile = path.join(dir, "source.md");
	await writeFileAtomic(sourceFile, sourceMd);
	await appendIndexRow(ws, id, reg.title.trim(), reg.relevance?.split(/\r?\n/)[0]?.slice(0, 80) ?? "", `sources/${id}/source.md`);
	return { id, dir, sourceFile, files: copied };
}

async function appendIndexRow(ws: Workspace, id: string, title: string, topic: string, location: string): Promise<void> {
	const indexPath = path.join(ws.referencesDir, "INDEX.md");
	const existing = existsSync(indexPath) ? await readFile(indexPath, "utf8") : "# 来源索引\n\n| 来源 | 名称 | 主题 | 记录位置 |\n|---|---|---|---|\n";
	const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	await writeFileAtomic(indexPath, `${existing.endsWith("\n") ? existing : `${existing}\n`}| ${id} | ${cell(title)} | ${cell(topic)} | ${location} |\n`);
}

export async function listSources(ws: Workspace): Promise<Array<{ id: string; title: string; dir: string }>> {
	const dir = path.join(ws.referencesDir, "sources");
	if (!existsSync(dir)) return [];
	const out: Array<{ id: string; title: string; dir: string }> = [];
	for (const name of (await readdir(dir)).filter((n) => /^S\d{3,}/.test(n)).sort()) {
		const sourceMd = path.join(dir, name, "source.md");
		if (!existsSync(sourceMd)) continue;
		const heading = (await readFile(sourceMd, "utf8")).split(/\r?\n/).find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "").trim() ?? name;
		out.push({ id: name, title: heading, dir: path.join(dir, name) });
	}
	return out;
}

export async function readIndex(ws: Workspace): Promise<string> {
	const indexPath = path.join(ws.referencesDir, "INDEX.md");
	return existsSync(indexPath) ? readFile(indexPath, "utf8") : "";
}

/** One search log per M05 run: `references/search/R<seq>-<runId>.md`. */
export class SearchLog {
	readonly file: string;
	private constructor(file: string) {
		this.file = file;
	}

	static async create(ws: Workspace, runId: string, goal: string): Promise<SearchLog> {
		const dir = path.join(ws.referencesDir, "search");
		await mkdir(dir, { recursive: true });
		let max = 0;
		for (const name of await readdir(dir)) {
			const m = /^R(\d{3,})-/.exec(name);
			if (m) max = Math.max(max, Number(m[1]));
		}
		const file = path.join(dir, `R${String(max + 1).padStart(3, "0")}-${runId}.md`);
		await writeFileAtomic(file, `# 检索记录 ${runId}\n\n- 开始：${nowIso()}\n- 本轮知识需求：${goal.trim().replace(/\r?\n/g, " ")}\n\n## 检索\n\n`);
		return new SearchLog(file);
	}

	async append(entry: { at: string; provider: string; query: string; limit: number; endpoint: string; hits: Array<{ title: string; url: string; date?: string }>; warnings: string[] }): Promise<void> {
		const rows = entry.hits.map((h, i) => `   ${i + 1}. ${h.title.replace(/\r?\n/g, " ")} — ${h.url}${h.date ? `（${h.date}）` : ""}`).join("\n");
		const block = `### ${entry.at} ${entry.provider}\n\n- 检索式：${entry.query}\n- 上限：${entry.limit}；实际返回：${entry.hits.length}\n- 来源端点：${entry.endpoint}\n- 限制/警告：${entry.warnings.length ? entry.warnings.join("；") : "无"}\n- 命中：\n${rows || "   无"}\n\n`;
		const current = await readFile(this.file, "utf8");
		await writeFileAtomic(this.file, current + block);
	}

	async appendNote(text: string): Promise<void> {
		const current = await readFile(this.file, "utf8");
		await writeFileAtomic(this.file, `${current}${text.trim()}\n\n`);
	}
}
