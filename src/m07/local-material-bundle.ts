/** Local, byte-exact evidence freeze. Selection and extraction metadata describe
 * provenance, not reading, scientific validity, or semantic coverage. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isTextFile } from "../media.ts";
import type { SourceFile } from "../references.ts";
import { readFrozenArtifactManifest } from "../stages/artifacts.ts";

const PART_BYTES = 900_000;
const CONTROL_BYTES = 64 * 1024 * 1024;
const SOURCE_ID = /^S[0-9]{3,}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;
type Role = SourceFile["role"] | "unknown";
type Provenance = SourceFile["provenance"];

export type LocalMaterialSelection =
	| Readonly<{ kind: "declared-file"; label: string; path: string;
		role?: SourceFile["role"]; providedScope?: string; provenance?: Provenance }>
	| Readonly<{ kind: "registered-source"; workspaceRoot: string; sourceId: string;
		files?: readonly SourceFile[]; obtainedRange?: string; completeness?: string }>
	| Readonly<{ kind: "m08-manifest"; label: string; manifestFile: string;
		entryRelativePaths?: readonly string[] }>;
export type LocalMaterialGap = Readonly<{
	code: "not-read" | "nontext" | "invalid-text-projection" | "projection-only" | "coverage-unverified" |
		"partial-coverage" | "unprovided" | "registration-prose-only" | "empty";
	itemId?: string; detail: string;
}>;
export type LocalMaterialPart = Readonly<{
	file: string; bytes: number; sha256: string; text: boolean;
}>;
export type LocalMaterialItem = Readonly<{
	id: string; label: string; sourceIdentity: string; role: Role;
	originalName: string; providedScope: string | null; provenance: Provenance | null;
	bytes: number; sha256: string; text: boolean; textProjectionInvalid: boolean;
	parts: readonly LocalMaterialPart[];
}>;
export type LocalMaterialManifest = Readonly<{
	version: 1; kind: "local-material-bundle"; root: string;
	items: readonly LocalMaterialItem[]; gaps: readonly LocalMaterialGap[];
	indexFiles: readonly string[]; unprovidedScopes: readonly string[];
	semanticCoverage: "unverified"; assessorRead: false;
}>;
export type LocalMaterialBundle = Readonly<{
	manifestFile: string; indexFile: string; indexFiles: readonly string[];
	manifest: LocalMaterialManifest; gaps: readonly LocalMaterialGap[];
	assessorEvidence: readonly Readonly<{ name: string; file: string;
		sourceIdentity: string; role: Role | "index" }>[];
}>;

type Resolved = { label: string; file: string; role: Role; sourceIdentity: string;
	providedScope: string | null; provenance: Provenance | null; forceText?: boolean };
function reject(message: string): never { throw new Error(`local material bundle refused: ${message}`); }
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, fields: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...fields].sort().join("|");
}
function boundedText(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.trim().length > 0 &&
		value.length <= max && !/[\0]/.test(value);
}
function validProvenance(value: unknown): value is NonNullable<Provenance> {
	return record(value) && keys(value, ["url", "title", "capturedAt", "contentType",
		"kind", "derivedFrom"].filter(key => value[key] !== undefined)) &&
		Object.values(value).every(part => boundedText(part, 4096));
}
function validRole(value: unknown): value is SourceFile["role"] {
	return ["original", "extracted", "page-image", "other"].includes(String(value));
}
function validSourceFile(value: unknown): value is SourceFile {
	return record(value) && keys(value, ["path", "role",
		...(value.note === undefined ? [] : ["note"]),
		...(value.provenance === undefined ? [] : ["provenance"])]) &&
		boundedText(value.path) && validRole(value.role) &&
		(value.note === undefined || boundedText(value.note)) &&
		(value.provenance === undefined || validProvenance(value.provenance));
}
export function validateLocalMaterialSelections(value: unknown): value is LocalMaterialSelection[] {
	if (!Array.isArray(value) || value.length === 0) return false;
	return value.every(item => {
		if (!record(item)) return false;
		if (item.kind === "declared-file") return keys(item, ["kind", "label", "path",
			...(item.role === undefined ? [] : ["role"]),
			...(item.providedScope === undefined ? [] : ["providedScope"]),
			...(item.provenance === undefined ? [] : ["provenance"])]) &&
			boundedText(item.label, 400) && boundedText(item.path) &&
			(item.role === undefined || validRole(item.role)) &&
			(item.providedScope === undefined || boundedText(item.providedScope)) &&
			(item.provenance === undefined || validProvenance(item.provenance));
		if (item.kind === "registered-source") return keys(item, ["kind", "workspaceRoot", "sourceId",
			...(item.files === undefined ? [] : ["files"]),
			...(item.obtainedRange === undefined ? [] : ["obtainedRange"]),
			...(item.completeness === undefined ? [] : ["completeness"])]) &&
			boundedText(item.workspaceRoot) && typeof item.sourceId === "string" &&
			SOURCE_ID.test(item.sourceId) &&
			(item.files === undefined || Array.isArray(item.files) && item.files.length > 0 &&
				item.files.every(validSourceFile)) &&
			(item.obtainedRange === undefined || boundedText(item.obtainedRange)) &&
			(item.completeness === undefined || boundedText(item.completeness));
		if (item.kind === "m08-manifest") return keys(item, ["kind", "label", "manifestFile",
			...(item.entryRelativePaths === undefined ? [] : ["entryRelativePaths"])]) &&
			boundedText(item.label, 400) && boundedText(item.manifestFile) &&
			(item.entryRelativePaths === undefined || Array.isArray(item.entryRelativePaths) &&
				item.entryRelativePaths.length > 0 &&
				item.entryRelativePaths.every((part: unknown) =>
					boundedText(part) && SAFE_RELATIVE.test(part)) &&
				new Set(item.entryRelativePaths).size === item.entryRelativePaths.length);
		return false;
	});
}
function resolvedPath(baseDir: string, file: string): string {
	return path.isAbsolute(file) ? path.resolve(file) : path.resolve(baseDir, file);
}
async function safeRegular(file: string): Promise<void> {
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size))
		reject("selected material is not a regular byte-readable file");
}
async function filesUnder(directory: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (current: string): Promise<void> => {
		for (const name of (await readdir(current)).sort()) {
			const candidate = path.join(current, name);
			const info = await lstat(candidate);
			if (info.isSymbolicLink()) reject("selected material tree contains a symlink");
			if (info.isFile()) files.push(candidate);
			else if (info.isDirectory()) await walk(candidate);
			else reject("selected material tree contains a non-file entry");
		}
	};
	await walk(directory);
	return files;
}
async function resolveSelections(selections: readonly LocalMaterialSelection[], baseDir: string):
	Promise<{ files: Resolved[]; gaps: LocalMaterialGap[]; unprovided: string[] }> {
	const files: Resolved[] = [];
	const gaps: LocalMaterialGap[] = [];
	const unprovided: string[] = [];
	for (const selection of selections) {
		if (selection.kind === "declared-file") {
			const file = resolvedPath(baseDir, selection.path);
			await safeRegular(file);
			files.push({ label: selection.label, file, role: selection.role ?? "unknown",
				sourceIdentity: `declared:${selection.label}`, providedScope: selection.providedScope ?? null,
				provenance: selection.provenance ?? null });
			continue;
		}
		if (selection.kind === "registered-source") {
			const workspace = resolvedPath(baseDir, selection.workspaceRoot);
			const directory = path.join(workspace, "references", "sources", selection.sourceId);
			const info = await lstat(directory);
			if (!info.isDirectory() || info.isSymbolicLink()) reject("registered source directory is invalid");
			const recordFile = path.join(directory, "source.md");
			await safeRegular(recordFile);
			files.push({ label: `${selection.sourceId} registered source record`, file: recordFile,
				role: "other", sourceIdentity: `registered:${selection.sourceId}:source.md`,
				providedScope: selection.obtainedRange ?? null, provenance: null, forceText: true });
			const copied = (await readdir(directory)).filter(name => name !== "source.md").sort();
			if (!copied.length) reject("registered source has no actual copied files");
			if (selection.files) {
				const seen = new Set<string>();
				for (const row of selection.files) {
					const file = resolvedPath(directory, row.path);
					if (path.dirname(file) !== directory || seen.has(file) || !copied.includes(path.basename(file)))
						reject("registered SourceFile is not an exact copied source file");
					seen.add(file);
					await safeRegular(file);
					files.push({ label: `${selection.sourceId} ${path.basename(file)}`, file,
						role: row.role, sourceIdentity: `registered:${selection.sourceId}:${path.basename(file)}`,
						providedScope: selection.obtainedRange ?? null,
						provenance: row.provenance ?? null });
				}
			} else {
				for (const name of copied) {
					const file = path.join(directory, name);
					await safeRegular(file);
					files.push({ label: `${selection.sourceId} ${name}`, file, role: "unknown",
						sourceIdentity: `registered:${selection.sourceId}:${name}`,
						providedScope: null, provenance: null });
				}
				gaps.push({ code: "registration-prose-only",
					detail: `${selection.sourceId}: source.md has no machine-readable SourceFile role/provenance map` });
			}
			continue;
		}
		const manifestFile = resolvedPath(baseDir, selection.manifestFile);
		const m08 = await readFrozenArtifactManifest(manifestFile);
		const expected = new Set(selection.entryRelativePaths ?? m08.entries.map(row => row.relativePath));
		if (expected.size !== (selection.entryRelativePaths?.length ?? m08.entries.length) ||
			[...expected].some(name => !m08.entries.some(row => row.relativePath === name)))
			reject("M08 material selection is missing or ambiguous");
		for (const entry of m08.entries.filter(row => expected.has(row.relativePath))) {
			const selected = entry.kind === "file" ? [entry.frozenPath] : await filesUnder(entry.frozenPath);
			for (const file of selected) {
				await safeRegular(file);
				files.push({ label: `${selection.label}: ${entry.label}${selected.length > 1 ?
					`/${path.relative(entry.frozenPath, file)}` : ""}`, file, role: "unknown",
					sourceIdentity: `m08:${m08.m08RunId}:${entry.relativePath}${selected.length > 1 ?
						`/${path.relative(entry.frozenPath, file)}` : ""}`,
					providedScope: entry.providedScope ?? null, provenance: null });
			}
		}
		unprovided.push(...m08.unprovidedScopes);
	}
	return { files, gaps, unprovided };
}

async function privateDirectory(directory: string, create: boolean): Promise<void> {
	if (create) await mkdir(directory, { mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
		reject("bundle directory is not private");
}
async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}
async function save(file: string, bytes: Buffer): Promise<void> {
	const handle = await open(file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	await syncDirectory(path.dirname(file));
}
async function readPrivate(file: string, maximum: number): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
			before.size < 0 || before.size > maximum) reject("private material part is unsafe");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs) reject("private material part changed during read");
		return bytes;
	} finally { await handle.close(); }
}
async function copyInParts(root: string, id: string, original: Resolved):
	Promise<LocalMaterialItem> {
	const source = await open(original.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await source.stat();
		if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) ||
			before.size < 0) reject("selected material source is unsafe");
		const requestedText = original.forceText === true || original.role === "extracted" ||
			original.role !== "page-image" && original.role !== "original" && isTextFile(original.file) ||
			original.role === "original" && (original.provenance?.contentType?.startsWith("text/") ||
				isTextFile(original.file));
		let text = Boolean(requestedText);
		if (text) {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			let checked = 0;
			while (checked < before.size) {
				const size = Math.min(PART_BYTES, before.size - checked);
				const block = Buffer.alloc(size);
				const { bytesRead } = await source.read(block, 0, size, checked);
				if (bytesRead !== size) reject("selected text changed during UTF-8 check");
				try { decoder.decode(block, { stream: true }); }
				catch { text = false; break; }
				checked += size;
			}
			if (text) try { decoder.decode(); }
			catch { text = false; }
		}
		const directory = path.join(root, "files", id);
		await privateDirectory(directory, true);
		await syncDirectory(path.dirname(directory));
		const parts: LocalMaterialPart[] = [];
		const whole = createHash("sha256");
		let position = 0;
		for (let ordinal = 1; position < before.size; ordinal++) {
			const requested = Math.min(PART_BYTES, before.size - position);
			const candidate = Buffer.alloc(requested);
			const { bytesRead } = await source.read(candidate, 0, requested, position);
			if (bytesRead !== requested) reject("selected material changed during freeze");
			let length = bytesRead;
			if (text) {
				let valid = false;
				for (let trim = 0; trim <= 3 && length - trim > 0; trim++) {
					try {
						new TextDecoder("utf-8", { fatal: true }).decode(candidate.subarray(0, length - trim));
						length -= trim; valid = true; break;
					} catch { /* Only an incomplete trailing code point may be trimmed. */ }
				}
				if (!valid) reject("declared text projection is not exact UTF-8");
			}
			const bytes = candidate.subarray(0, length);
			const file = path.join(directory, `part-${String(ordinal).padStart(6, "0")}.${text ? "txt" : "bin"}`);
			await save(file, bytes);
			whole.update(bytes);
			parts.push({ file: path.relative(root, file), bytes: bytes.length,
				sha256: sha(bytes), text });
			position += length;
		}
		const after = await source.stat();
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs || position !== before.size)
			reject("selected material source changed during freeze");
		return { id, label: original.label, sourceIdentity: original.sourceIdentity,
			role: original.role, originalName: path.basename(original.file),
			providedScope: original.providedScope, provenance: original.provenance,
			bytes: position, sha256: whole.digest("hex"), text,
			textProjectionInvalid: Boolean(requestedText && !text), parts };
	} finally { await source.close(); }
}
function scopePartial(scope: string | null): boolean {
	if (!scope) return true;
	return !/^(?:full|complete|全文|全部)(?:\b|$)/i.test(scope.trim());
}
function indexText(items: readonly LocalMaterialItem[], gaps: readonly LocalMaterialGap[]): string {
	const lines = ["# Frozen local material evidence index", "",
		"This is a byte-preserving locator. Frozen, extracted, or listed does not mean read, checked, or scientifically complete.",
		"Binary originals require an appropriate reader. Text extraction and page images may omit diagrams, pages, formulas, or context.", ""];
	for (const item of items) {
		lines.push(`## ${item.id}: ${JSON.stringify(item.label)}`,
			`- source identity: ${JSON.stringify(item.sourceIdentity)}`,
			`- role: ${item.role}; declared scope: ${JSON.stringify(item.providedScope)}`,
			`- original frozen bytes: ${item.bytes}; sha256: ${item.sha256}`,
			`- format: ${item.text ? "UTF-8 projection" : "binary/nontext"}`,
			...item.parts.map((part, index) =>
				`- part ${index + 1}: ${part.file} (${part.bytes} bytes, sha256 ${part.sha256})`), "");
	}
	lines.push("## Explicit coverage gaps", "");
	for (const gap of gaps)
		lines.push(`- ${gap.code}${gap.itemId ? ` [${gap.itemId}]` : ""}: ${JSON.stringify(gap.detail)}`);
	return `${lines.join("\n")}\n`;
}
async function saveIndexParts(root: string, text: string): Promise<string[]> {
	const files: string[] = [];
	const bytes = Buffer.from(text, "utf8");
	let offset = 0;
	for (let index = 1; offset < bytes.length; index++) {
		let end = Math.min(offset + PART_BYTES, bytes.length);
		if (end < bytes.length) {
			while (end > offset) {
				try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)); break; }
				catch { end--; }
			}
		}
		if (end <= offset) reject("evidence index cannot be split as UTF-8");
		const file = path.join(root, `evidence-index.part-${String(index).padStart(6, "0")}.md`);
		await save(file, bytes.subarray(offset, end));
		files.push(file); offset = end;
	}
	return files;
}

export async function freezeLocalMaterialBundle(input: Readonly<{
	root: string; selections: readonly LocalMaterialSelection[];
	baseDir?: string; unprovidedScopes?: readonly string[];
}>): Promise<LocalMaterialBundle> {
	if (!path.isAbsolute(input.root) || !validateLocalMaterialSelections(input.selections) ||
		input.unprovidedScopes?.some(scope => !boundedText(scope)))
		reject("bundle source or selection is invalid");
	const root = path.resolve(input.root);
	const baseDir = path.resolve(input.baseDir ?? process.cwd());
	const resolved = await resolveSelections(input.selections, baseDir);
	const unprovided = [...(input.unprovidedScopes ?? []), ...resolved.unprovided];
	await privateDirectory(root, true);
	await syncDirectory(path.dirname(root));
	if ((await readdir(root)).length) reject("bundle root is already occupied");
	await privateDirectory(path.join(root, "files"), true);
	await syncDirectory(root);
	const items: LocalMaterialItem[] = [];
	const gaps: LocalMaterialGap[] = [...resolved.gaps];
	for (const [index, file] of resolved.files.entries()) {
		const id = `M${String(index + 1).padStart(4, "0")}`;
		const item = await copyInParts(root, id, file);
		items.push(item);
		gaps.push({ code: "not-read", itemId: id,
			detail: "Freezing a file does not establish that an assessor read it" });
		gaps.push({ code: "coverage-unverified", itemId: id,
			detail: "Byte preservation or extraction does not prove semantic full coverage" });
		if (!item.text) gaps.push({ code: "nontext", itemId: id,
			detail: "Binary material is frozen but no textual or visual reading was performed" });
		if (item.textProjectionInvalid) gaps.push({ code: "invalid-text-projection", itemId: id,
			detail: "Selected text projection was not exact UTF-8; original bytes were retained as binary" });
		if (item.role === "extracted" || item.role === "page-image")
			gaps.push({ code: "projection-only", itemId: id,
				detail: "This derived projection does not establish coverage of its original source" });
		if (scopePartial(item.providedScope)) gaps.push({ code: "partial-coverage", itemId: id,
			detail: `Declared scope ${JSON.stringify(item.providedScope)} does not establish full source coverage` });
		if (item.bytes === 0) gaps.push({ code: "empty", itemId: id,
			detail: "Selected file has zero bytes" });
	}
	for (const scope of unprovided) gaps.push({ code: "unprovided",
		detail: `Declared scope was not provided: ${scope}` });
	const indexFiles = await saveIndexParts(root, indexText(items, gaps));
	const manifest: LocalMaterialManifest = { version: 1, kind: "local-material-bundle",
		root, items, gaps, indexFiles: indexFiles.map(file => path.relative(root, file)),
		unprovidedScopes: unprovided, semanticCoverage: "unverified", assessorRead: false };
	const manifestFile = path.join(root, "manifest.json");
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
	if (manifestBytes.length > CONTROL_BYTES) reject("bundle manifest exceeds physical file bound");
	await save(manifestFile, manifestBytes); // Publication marker, always last.
	return { manifestFile, indexFile: indexFiles[0] ?? "", indexFiles,
		manifest, gaps,
		assessorEvidence: [
			...indexFiles.map((file, index) => ({ name: `material-index-${index + 1}.md`,
				file, sourceIdentity: "bundle:index", role: "index" as const })),
			...items.flatMap(item => item.text ? item.parts.map((part, index) => ({
				name: `${item.id}-part-${index + 1}.txt`, file: path.join(root, part.file),
				sourceIdentity: item.sourceIdentity, role: item.role })) : [])] };
}

export async function readLocalMaterialBundle(root: string): Promise<LocalMaterialManifest> {
	if (!path.isAbsolute(root)) reject("bundle root is invalid");
	await privateDirectory(root, false);
	const raw = await readPrivate(path.join(root, "manifest.json"), CONTROL_BYTES);
	let manifest: unknown;
	try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
	catch { return reject("bundle manifest JSON is invalid"); }
	if (!record(manifest) || manifest.version !== 1 || manifest.kind !== "local-material-bundle" ||
		manifest.root !== path.resolve(root) || !Array.isArray(manifest.items) ||
		!Array.isArray(manifest.gaps) || !Array.isArray(manifest.indexFiles) ||
		manifest.semanticCoverage !== "unverified" || manifest.assessorRead !== false)
		reject("bundle manifest fields are invalid");
	for (const [position, item] of manifest.items.entries()) {
		if (!record(item) || item.id !== `M${String(position + 1).padStart(4, "0")}` ||
			!Array.isArray(item.parts) || !Number.isSafeInteger(item.bytes) ||
			typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))
			reject("bundle item identity is invalid");
		const whole = createHash("sha256");
		let length = 0;
		for (const [ordinal, part] of item.parts.entries()) {
			if (!record(part) || part.file !== path.join("files", item.id,
				`part-${String(ordinal + 1).padStart(6, "0")}.${item.text ? "txt" : "bin"}`) ||
				typeof part.bytes !== "number" || !Number.isSafeInteger(part.bytes) ||
				part.bytes < 1 || part.bytes > PART_BYTES ||
				typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256))
				reject("bundle part descriptor is invalid");
			const bytes = await readPrivate(path.join(root, part.file), PART_BYTES);
			if (bytes.length !== part.bytes || sha(bytes) !== part.sha256)
				reject("bundle part bytes changed");
			if (item.text) {
				try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
				catch { return reject("bundle UTF-8 part changed"); }
			}
			whole.update(bytes); length += bytes.length;
		}
		if (length !== item.bytes || whole.digest("hex") !== item.sha256)
			reject("bundle source bytes changed");
	}
	const indexParts: Buffer[] = [];
	for (const [index, file] of manifest.indexFiles.entries()) {
		if (file !== `evidence-index.part-${String(index + 1).padStart(6, "0")}.md`)
			reject("bundle index path is invalid");
		const bytes = await readPrivate(path.join(root, file), PART_BYTES);
		try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { return reject("bundle index is not UTF-8"); }
		indexParts.push(bytes);
	}
	if (!Buffer.concat(indexParts).equals(Buffer.from(indexText(
		manifest.items as LocalMaterialItem[], manifest.gaps as LocalMaterialGap[]), "utf8")))
		reject("bundle index differs from frozen gaps and sources");
	return manifest as LocalMaterialManifest;
}
