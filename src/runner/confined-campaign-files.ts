import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import type { CustomToolSpec } from "./types.ts";

const MAX_READ_BYTES = 128_000;
const MAX_WRITE_BYTES = 128_000;
const approved = new WeakMap<CustomToolSpec, string>();

function requestedPath(root: string, requested: unknown): string {
	if (typeof requested !== "string" || !requested || requested.length > 240 || requested.includes("\0") || path.isAbsolute(requested) ||
		requested.split(/[\\/]/).some((segment) => segment === ".." || segment === "")) {
		throw new HarnessError("runner.campaign-files", "expected a bounded relative file path");
	}
	const target = path.resolve(root, requested);
	if (!target.startsWith(`${root}${path.sep}`)) throw new HarnessError("runner.campaign-files", "file path escapes the campaign work directory");
	return target;
}

async function existingFile(root: string, requested: unknown): Promise<string> {
	const target = requestedPath(root, requested);
	const [resolved, stat] = await Promise.all([realpath(target), lstat(target)]);
	if (!resolved.startsWith(`${root}${path.sep}`) || !stat.isFile() || stat.isSymbolicLink()) {
		throw new HarnessError("runner.campaign-files", "file is not a regular file inside the campaign work directory");
	}
	return target;
}

async function writableFile(root: string, requested: unknown): Promise<string> {
	const target = requestedPath(root, requested);
	const parent = await realpath(path.dirname(target));
	if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new HarnessError("runner.campaign-files", "file parent escapes the campaign work directory");
	try {
		const stat = await lstat(target);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new HarnessError("runner.campaign-files", "file target must be a regular file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return target;
}

function textField(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new HarnessError("runner.campaign-files", `${label} exceeds the campaign file limit`);
	return value;
}

/**
 * An allowlisted no-subprocess/no-network tool grant for a campaign M07 builder.
 * The factory root must be the controller-created task work directory. The tools
 * reject absolute, escaping, and symlinked file paths. This is not an OS sandbox;
 * use a private single-owner work directory with no concurrent hostile writer.
 */
export async function createConfinedCampaignFileTools(root: string, options: { writableFiles: string[] }): Promise<CustomToolSpec[]> {
	const rootReal = await realpath(root);
	if (!(await lstat(rootReal)).isDirectory()) throw new HarnessError("runner.campaign-files", "work root is not a directory");
	if (!Array.isArray(options.writableFiles) || options.writableFiles.length < 1 || options.writableFiles.length > 16) throw new HarnessError("runner.campaign-files", "explicit writable file allowlist is required");
	const writable = new Set(options.writableFiles.map((name) => requestedPath(rootReal, name)));
	if (writable.size !== options.writableFiles.length) throw new HarnessError("runner.campaign-files", "duplicate writable file path");
	const allowedWrite = (requested: unknown): string => {
		const target = requestedPath(rootReal, requested);
		if (!writable.has(target)) throw new HarnessError("runner.campaign-files", "file is not on the campaign write allowlist");
		return target;
	};
	const read: CustomToolSpec = {
		name: "read", description: "Read one UTF-8 text file inside the task work directory (128 KB maximum).",
		params: { path: { type: "string", description: "Relative file path" } },
		async execute(args) {
			const target = await existingFile(rootReal, args.path);
			const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				if ((await handle.stat()).size > MAX_READ_BYTES) throw new HarnessError("runner.campaign-files", "file exceeds the read limit");
				return { text: (await handle.readFile()).toString("utf8") };
			} finally { await handle.close(); }
		},
	};
	const write: CustomToolSpec = {
		name: "write", description: "Create or replace one UTF-8 text file inside an existing task-work-directory folder (128 KB maximum).",
		params: { path: { type: "string", description: "Relative file path" }, content: { type: "string", description: "Complete UTF-8 file content" } },
		async execute(args) {
			const content = textField(args.content, "write content", MAX_WRITE_BYTES);
			allowedWrite(args.path);
			const target = await writableFile(rootReal, args.path);
			const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
			try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
			return { text: "Wrote the requested task file." };
		},
	};
	const edit: CustomToolSpec = {
		name: "edit", description: "Replace one unique exact text span in an existing task file (128 KB maximum).",
		params: {
			path: { type: "string", description: "Relative file path" },
			oldText: { type: "string", description: "Existing exact text to replace" },
			newText: { type: "string", description: "Replacement text" },
		},
		async execute(args) {
			const oldText = textField(args.oldText, "oldText", MAX_WRITE_BYTES);
			const newText = textField(args.newText, "newText", MAX_WRITE_BYTES);
			if (!oldText) throw new HarnessError("runner.campaign-files", "oldText must not be empty");
			allowedWrite(args.path);
			const target = await existingFile(rootReal, args.path);
			const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
			try {
				if ((await handle.stat()).size > MAX_READ_BYTES) throw new HarnessError("runner.campaign-files", "file exceeds the edit limit");
				const original = (await handle.readFile()).toString("utf8");
				const first = original.indexOf(oldText);
				if (first < 0 || original.indexOf(oldText, first + oldText.length) >= 0) throw new HarnessError("runner.campaign-files", "oldText must occur exactly once");
				const updated = original.slice(0, first) + newText + original.slice(first + oldText.length);
				if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) throw new HarnessError("runner.campaign-files", "edited file exceeds the write limit");
				await handle.truncate(0);
				const bytes = Buffer.from(updated, "utf8");
				for (let position = 0; position < bytes.length;) {
					const result = await handle.write(bytes, position, bytes.length - position, position);
					if (result.bytesWritten < 1) throw new HarnessError("runner.campaign-files", "short edit write");
					position += result.bytesWritten;
				}
			} finally { await handle.close(); }
			return { text: "Edited the requested task file." };
		},
	};
	for (const tool of [read, write, edit]) {
		Object.freeze(tool.params);
		Object.freeze(tool);
		approved.set(tool, rootReal);
	}
	return Object.freeze([read, write, edit]) as unknown as CustomToolSpec[];
}

export function isConfinedCampaignFileGrant(tools: readonly CustomToolSpec[]): boolean {
	return tools.length === 3 && ["read", "write", "edit"].every((name, index) => tools[index]?.name === name) &&
		approved.has(tools[0]) && tools.every((tool) => approved.get(tool) === approved.get(tools[0]));
}
