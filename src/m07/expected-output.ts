import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface ExpectedOutputResolution {
	declared: string;
	files: string[];
	error?: string;
}

function inside(root: string, candidate: string): boolean {
	if (candidate === root) return true;
	return candidate.startsWith(root + path.sep);
}

export function isSafeRelativeOutputPath(value: string): boolean {
	if (value.length === 0) return false;
	if (value.trim() !== value) return false;
	if (value.includes("\n") || value.includes("\r")) return false;
	if (path.isAbsolute(value)) return false;
	// The reviewer resolves a declared output literally. Placeholder and glob syntax
	// would otherwise create an obligation that no concrete output can satisfy.
	if (/[<>*?\[\]{}$`]/u.test(value) || /%[sd]/u.test(value)) return false;
	return value.split("/").includes("..") === false;
}

export async function resolveExpectedOutputFiles(workDir: string, expectedPaths: string[]): Promise<ExpectedOutputResolution[]> {
	const workReal = await realpath(workDir);
	const result: ExpectedOutputResolution[] = [];
	for (const declared of expectedPaths) {
		if (existsSync(declared) === false) {
			result.push({ declared, files: [], error: "预期产物未实际提交：" + path.relative(workDir, declared) });
			continue;
		}
		if ((await lstat(declared)).isSymbolicLink()) {
			result.push({ declared, files: [], error: "预期产物含链接或特殊文件：" + path.relative(workDir, declared) });
			continue;
		}
		const actual = await realpath(declared);
		if (inside(workReal, actual) === false) {
			result.push({ declared, files: [], error: "预期产物不在任务目录：" + path.relative(workDir, declared) });
			continue;
		}
		const stat = await lstat(actual);
		if (stat.isFile()) {
			result.push({ declared, files: [actual] });
			continue;
		}
		if (stat.isDirectory()) {
			const files: string[] = [];
			const pending = [actual];
			let error: string | undefined;
			while (pending.length && !error) {
				const directory = pending.pop()!;
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const child = path.join(directory, entry.name);
					const childStat = await lstat(child);
					if (!childStat.isFile() && !childStat.isDirectory()) {
						error = "预期产物含链接或特殊文件：" + path.relative(workDir, child);
						break;
					}
					const childReal = await realpath(child);
					if (!inside(workReal, childReal) || !inside(actual, childReal)) {
						error = "预期产物不在声明目录：" + path.relative(workDir, child);
						break;
					}
					if (childStat.isDirectory()) pending.push(childReal);
					else files.push(childReal);
				}
			}
			files.sort();
			if (error) result.push({ declared, files: [], error });
			else if (files.length === 0) result.push({ declared, files: [], error: "预期产物目录为空：" + path.relative(workDir, declared) });
			else result.push({ declared, files });
			continue;
		}
		result.push({ declared, files: [], error: "预期产物类型不支持：" + path.relative(workDir, declared) });
	}
	return result;
}
