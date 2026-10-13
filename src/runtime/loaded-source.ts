import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunDescriptorV1 } from "./run-descriptor.ts";

export interface LoadedSourceV1 { sourceRoot: string; sourceCommit: string }

const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SOURCE_DIRS = ["src", "extensions", "workflow", "tools"];

async function readonlyTree(target: string): Promise<void> {
	const info = await lstat(target);
	if (info.isSymbolicLink() || (info.mode & 0o222) !== 0 || (!info.isDirectory() && !info.isFile()))
		throw new Error(`fixed source tree has a writable or indirect entry: ${target}`);
	if (info.isDirectory()) for (const name of await readdir(target)) await readonlyTree(path.join(target, name));
}

/** A proof is available only in the explicit prepared-source launch mode. */
export async function verifyLoadedSource(entryUrl: string | URL, expectedRoot = process.env.PRE_RSI_SOURCE_ROOT,
	expectedRevision = process.env.PRE_RSI_CODE_REVISION): Promise<LoadedSourceV1 | undefined> {
	if (!expectedRoot) return undefined;
	const sourceRoot = await realpath(expectedRoot);
	if ((await lstat(expectedRoot)).isSymbolicLink()) throw new Error("fixed source root must be a real directory, not a symlink");
	const ownModule = fileURLToPath(import.meta.url);
	if (path.resolve(sourceRoot, "src/runtime/loaded-source.ts") !== ownModule || await realpath(ownModule) !== ownModule)
		throw new Error("loaded source verifier is outside the selected source tree");
	const entry = fileURLToPath(entryUrl);
	if (await realpath(entry) !== entry || !entry.startsWith(`${sourceRoot}${path.sep}`))
		throw new Error("loaded entry is outside the selected source tree or is a symlink");
	const receiptPath = path.join(sourceRoot, ".workflow-source.json");
	const receiptInfo = await lstat(receiptPath);
	if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || (receiptInfo.mode & 0o222) !== 0)
		throw new Error("fixed source receipt is missing, indirect, or writable");
	const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Partial<LoadedSourceV1> & { version?: number };
	if (receipt.version !== 1 || receipt.sourceRoot !== sourceRoot || typeof receipt.sourceCommit !== "string" || !COMMIT.test(receipt.sourceCommit))
		throw new Error("fixed source receipt does not identify the loaded source tree and full commit");
	if (expectedRevision && expectedRevision !== receipt.sourceCommit)
		throw new Error("launcher source revision differs from the actually loaded source");
	const rootInfo = await lstat(sourceRoot);
	if (!rootInfo.isDirectory() || (rootInfo.mode & 0o222) !== 0)
		throw new Error("fixed source root is writable or is not a directory");
	for (const dir of SOURCE_DIRS) await readonlyTree(path.join(sourceRoot, dir));
	await readonlyTree(path.join(sourceRoot, "package.json"));
	return { sourceRoot, sourceCommit: receipt.sourceCommit };
}

export async function verifyDescriptorLoadedSource(descriptor: RunDescriptorV1, entryUrl: string | URL,
	expectedRoot = process.env.PRE_RSI_SOURCE_ROOT,
	expectedRevision = process.env.PRE_RSI_CODE_REVISION): Promise<void> {
	if (!expectedRoot && !descriptor.loadedSource) return;
	if (!descriptor.loadedSource) throw new Error("fixed source launch requires a loadedSource proof in the run descriptor");
	const binding = await verifyLoadedSource(entryUrl, expectedRoot ?? descriptor.loadedSource.sourceRoot, expectedRevision);
	if (!binding || descriptor.loadedSource.sourceRoot !== binding.sourceRoot ||
		descriptor.loadedSource.sourceCommit !== binding.sourceCommit || descriptor.codeRevision !== binding.sourceCommit)
		throw new Error("run descriptor source claim differs from the actually loaded source");
}
