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

export async function resolveExpectedOutputFiles(workDir: string, expectedPaths: string[]): Promise<ExpectedOutputResolution[]> {
	const workReal = await realpath(workDir);
	const result: ExpectedOutputResolution[] = [];
	for (const declared of expectedPaths) {
		if (existsSync(declared) === false) {
			result.push({ declared, files: [], error: "预期产物未实际提交：" + path.relative(workDir, declared) });
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
			const entries = await readdir(actual, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				if (entry.isFile() === false) continue;
				const child = path.join(actual, entry.name);
				const childReal = await realpath(child);
				if (inside(workReal, childReal) === false) continue;
				files.push(childReal);
			}
			if (files.length === 0) result.push({ declared, files: [], error: "预期产物目录为空：" + path.relative(workDir, declared) });
			else result.push({ declared, files });
			continue;
		}
		result.push({ declared, files: [], error: "预期产物类型不支持：" + path.relative(workDir, declared) });
	}
	return result;
}
