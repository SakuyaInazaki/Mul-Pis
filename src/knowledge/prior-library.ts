/**
 * The frozen layered prior: the knowledge a new backend needs before any online
 * learning can help at all.
 *
 * Six layers, each a plain file under `.agent/knowledge/prior/<layer>/`:
 *   L0 programming model · L1 pattern guide · L2 hardware constraints ·
 *   L3 tiling strategy · L4 API reference · L5 verified examples.
 *
 * Entries are written by hand (or produced by M06 extraction) and never by an
 * automatic write-back: this library is the stable part of the knowledge, the
 * store holds what the project learned afterwards. Every entry must declare the
 * backend and toolchain it holds for and cite a local source, because a
 * constraint copied from the wrong chip or the wrong CANN version fails
 * silently and is the hardest failure to diagnose.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isLocalCitation } from "./optimization-card.ts";
import { RETRIEVAL_SCALAR_KEYS, isKnowledgeRetrievalContext, type KnowledgeRetrievalContext } from "./retrieval.ts";

export const PRIOR_LAYERS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type PriorLayer = (typeof PRIOR_LAYERS)[number];

export const PRIOR_LAYER_TITLES: Record<PriorLayer, string> = {
	L0: "编程模型", L1: "模式指南", L2: "硬件约束", L3: "tiling 策略", L4: "API 参考", L5: "已验证范例",
};

export interface PriorEntry {
	layer: PriorLayer;
	title: string;
	applicability: KnowledgeRetrievalContext;
	/** Local citation: registered source id or workspace-relative path. */
	source: string;
	body: string;
	file: string;
}

export interface PriorLibrary {
	entries: PriorEntry[];
	/** Files that were present but unusable. They are never guessed into entries. */
	rejected: Array<{ file: string; reason: string }>;
}

const MAX_ENTRY_BODY = 4000;

function parseEntry(text: string, file: string): { entry?: PriorEntry; reason?: string } {
	const lines = text.split(/\r?\n/u);
	if (lines[0] !== "---") return { reason: "缺少前置信息块" };
	const end = lines.indexOf("---", 1);
	if (end < 0) return { reason: "前置信息未闭合" };
	const metadata: Record<string, unknown> = {};
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(":");
		if (separator < 1) return { reason: "前置信息格式错误" };
		try { metadata[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1)); }
		catch { return { reason: "前置信息不是每行 key: JSON" }; }
	}
	const body = lines.slice(end + 1).join("\n").trim();
	if (!body) return { reason: "正文为空" };
	if (body.length > MAX_ENTRY_BODY) return { reason: `正文超过 ${MAX_ENTRY_BODY} 字符；先压缩成约束或范例` };
	if (typeof metadata.layer !== "string" || !PRIOR_LAYERS.includes(metadata.layer as PriorLayer)) return { reason: "layer 必须是 L0–L5" };
	if (typeof metadata.title !== "string" || !metadata.title.trim()) return { reason: "title 必须是非空字符串" };
	if (!isKnowledgeRetrievalContext(metadata.applicability)) return { reason: "applicability 必须是合法检索情境对象" };
	const applicability = metadata.applicability;
	if (!applicability.backend || !applicability.toolchain) return { reason: "applicability 必须写明 backend 与 toolchain" };
	if (!isLocalCitation(metadata.source)) return { reason: "source 必须是已登记来源 ID 或工作区相对路径" };
	return { entry: { layer: metadata.layer as PriorLayer, title: metadata.title.trim(), applicability,
		source: metadata.source, body, file } };
}

/** Read the library. A missing directory is an empty library, not an error:
 * the project may not have written its prior yet. */
export async function loadPriorLibrary(root: string): Promise<PriorLibrary> {
	const entries: PriorEntry[] = [];
	const rejected: PriorLibrary["rejected"] = [];
	for (const layer of PRIOR_LAYERS) {
		const dir = path.join(root, layer);
		let names: string[];
		try { names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort(); }
		catch { continue; }
		for (const name of names) {
			const file = path.join(layer, name);
			const parsed = parseEntry(await readFile(path.join(dir, name), "utf8"), file);
			if (parsed.entry && parsed.entry.layer !== layer) rejected.push({ file, reason: "layer 与所在目录不一致" });
			else if (parsed.entry) entries.push(parsed.entry);
			else rejected.push({ file, reason: parsed.reason ?? "无法解析" });
		}
	}
	return { entries, rejected };
}

export interface PriorSelection {
	markdown: string;
	included: Array<{ layer: PriorLayer; title: string; file: string }>;
	omitted: Array<{ file: string; reason: string }>;
}

/** Hard filter first, then bound. An entry whose declared backend or toolchain
 * conflicts with the current context is dropped, never ranked down. */
export function selectPrior(library: PriorLibrary, request: { layers: readonly PriorLayer[];
	context: KnowledgeRetrievalContext; maxEntries: number; maxChars: number }): PriorSelection {
	const wanted = new Set<PriorLayer>(request.layers);
	const included: PriorSelection["included"] = [];
	const omitted: PriorSelection["omitted"] = [...library.rejected];
	const blocks: string[] = [];
	let used = 0;
	for (const layer of PRIOR_LAYERS) {
		if (!wanted.has(layer)) continue;
		for (const entry of library.entries.filter((item) => item.layer === layer)) {
			const conflict = RETRIEVAL_SCALAR_KEYS.find((key) => {
				const declared = entry.applicability[key], observed = request.context[key];
				return declared !== undefined && observed !== undefined && declared !== observed;
			});
			if (conflict) { omitted.push({ file: entry.file, reason: `情境不匹配：${conflict}` }); continue; }
			if (included.length >= request.maxEntries) { omitted.push({ file: entry.file, reason: "超出本阶段条数上限" }); continue; }
			const block = `### [${entry.layer} ${PRIOR_LAYER_TITLES[entry.layer]}] ${entry.title}\n- 适用：${JSON.stringify(entry.applicability)}；出处：${entry.source}\n${entry.body}\n`;
			if (used + block.length > request.maxChars) { omitted.push({ file: entry.file, reason: "超出本阶段字符上限" }); continue; }
			used += block.length;
			blocks.push(block);
			included.push({ layer: entry.layer, title: entry.title, file: entry.file });
		}
	}
	const markdown = blocks.length
		? `## 冻结分层先验（L0–L5，按阶段装配）\n\n${blocks.join("\n")}\n先验条目是固定前提，不随本轮结论改写；数值以其登记出处为准。\n`
		: "";
	return { markdown, included, omitted };
}
