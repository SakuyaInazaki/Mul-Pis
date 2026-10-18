import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

export interface ArtifactSelection {
	label: string;
	path: string;
	sourceCategory: string;
	providedScope?: string;
}

export interface FrozenArtifactEntry extends ArtifactSelection {
	originalPath: string;
	frozenPath: string;
	relativePath: string;
	kind: "file" | "directory";
}

export interface FrozenArtifactManifest {
	version: 1;
	m08RunId: string;
	rootDir: string;
	createdAt: string;
	entries: FrozenArtifactEntry[];
	unprovidedScopes: string[];
}

/** Stage-neutral frozen source batch. Existing M08 manifests retain their original shape. */
export interface StageArtifactManifest extends Omit<FrozenArtifactManifest, "m08RunId"> {
	stage: "M04" | "M06";
	runId: string;
}

function safeName(value: string): string {
	return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "material";
}

async function copyTree(source: string, target: string): Promise<void> {
	const info = await lstat(source);
	if (info.isSymbolicLink()) throw new HarnessError("artifacts.symlink", `固定材料不接受符号链接：${source}`);
	if (info.isFile()) {
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(source, target);
		return;
	}
	if (!info.isDirectory()) throw new HarnessError("artifacts.kind", `固定材料必须是普通文件或目录：${source}`);
	await mkdir(target, { recursive: true });
	for (const name of (await readdir(source)).sort()) await copyTree(path.join(source, name), path.join(target, name));
}

/** Copy explicitly selected material into an immutable-by-convention run directory. No hashes are made. */
async function copySelections(rootDir: string, selections: ArtifactSelection[]): Promise<FrozenArtifactEntry[]> {
	await mkdir(rootDir, { recursive: true });
	const entries: FrozenArtifactEntry[] = [];
	for (let i = 0; i < selections.length; i++) {
		const item = selections[i];
		const source = path.resolve(item.path);
		let info;
		try { info = await lstat(source); } catch { throw new HarnessError("artifacts.missing", `固定材料不存在：${source}`); }
		if (info.isSymbolicLink()) throw new HarnessError("artifacts.symlink", `固定材料不接受符号链接：${source}`);
		if (!info.isFile() && !info.isDirectory()) throw new HarnessError("artifacts.kind", `固定材料必须是普通文件或目录：${source}`);
		const relativePath = path.join("materials", `${String(i + 1).padStart(3, "0")}-${safeName(item.label)}`, path.basename(source));
		const frozenPath = path.join(rootDir, relativePath);
		const targetFromSource = path.relative(source, frozenPath);
		if (!targetFromSource.startsWith("..") && !path.isAbsolute(targetFromSource)) throw new HarnessError("artifacts.recursive", `固定目标位于所选源目录内部，无法安全复制：${source}；请选择不包含本次阶段输出的更具体材料目录`);
		await copyTree(source, frozenPath);
		entries.push({ ...item, originalPath: source, frozenPath, relativePath, kind: info.isFile() ? "file" : "directory" });
	}
	return entries;
}

export async function freezeArtifacts(rootDir: string, selections: ArtifactSelection[], unprovidedScopes: string[] = [], m08RunId = "unspecified"): Promise<FrozenArtifactManifest> {
	const entries = await copySelections(rootDir, selections);
	const manifest: FrozenArtifactManifest = { version: 1, m08RunId, rootDir, createdAt: new Date().toISOString(), entries, unprovidedScopes: [...unprovidedScopes] };
	await writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

export async function freezeStageArtifacts(rootDir: string, selections: ArtifactSelection[], stage: StageArtifactManifest["stage"], runId: string, unprovidedScopes: string[] = []): Promise<StageArtifactManifest> {
	const entries = await copySelections(rootDir, selections);
	const manifest: StageArtifactManifest = { version: 1, stage, runId, rootDir, createdAt: new Date().toISOString(), entries, unprovidedScopes: [...unprovidedScopes] };
	await writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

export interface ManifestExpectation { m08RunId: string; rootDir: string }
async function verifyFrozenTree(target: string, label: string): Promise<void> {
	let info;
	try { info = await lstat(target); } catch { throw new HarnessError("artifacts.manifest-missing", `固定材料缺失：${label}`); }
	if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new HarnessError("artifacts.manifest-missing", `固定材料类型非法：${label}`);
	if (info.isDirectory()) for (const name of await readdir(target)) await verifyFrozenTree(path.join(target, name), `${label}/${name}`);
}
async function verifyManifest(parsed: FrozenArtifactManifest | StageArtifactManifest, file: string, rootExpected?: string): Promise<void> {
	if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new HarnessError("artifacts.manifest", `无效的固定材料清单：${file}`);
	const root = path.resolve(parsed.rootDir);
	if (rootExpected && root !== path.resolve(rootExpected)) throw new HarnessError("artifacts.manifest-root", `固定材料根目录与指定运行不一致：${parsed.rootDir}`);
	for (const entry of parsed.entries) {
		if (!entry.relativePath || path.isAbsolute(entry.relativePath) || entry.relativePath.split(path.sep).includes("..")) throw new HarnessError("artifacts.manifest-path", `固定材料相对路径非法：${entry.relativePath}`);
		const expectedPath = path.resolve(root, entry.relativePath);
		if (path.resolve(entry.frozenPath) !== expectedPath || (!path.relative(root, expectedPath) || path.relative(root, expectedPath).startsWith(".."))) throw new HarnessError("artifacts.manifest-path", `固定材料路径不属于清单根目录：${entry.frozenPath}`);
		await verifyFrozenTree(expectedPath, entry.relativePath);
	}
	return;
}
export async function readFrozenArtifactManifest(file: string, expected?: ManifestExpectation): Promise<FrozenArtifactManifest> {
	const parsed = JSON.parse(await readFile(file, "utf8")) as FrozenArtifactManifest;
	if (expected && parsed.m08RunId !== expected.m08RunId) throw new HarnessError("artifacts.manifest-run", `固定材料清单属于 ${parsed.m08RunId}，不是指定 M08 ${expected.m08RunId}`);
	await verifyManifest(parsed, file, expected?.rootDir);
	return parsed;
}

export async function readStageArtifactManifest(file: string, expected: { stage: StageArtifactManifest["stage"]; runId: string; rootDir: string }): Promise<StageArtifactManifest> {
	const rootInfo = await lstat(expected.rootDir);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new HarnessError("artifacts.manifest-root", "阶段冻结材料根目录非法");
	const parsed = JSON.parse(await readFile(file, "utf8")) as StageArtifactManifest;
	if (parsed.stage !== expected.stage || parsed.runId !== expected.runId) throw new HarnessError("artifacts.manifest-run", "固定材料清单的阶段或运行身份不匹配");
	await verifyManifest(parsed, file, expected.rootDir);
	return parsed;
}
