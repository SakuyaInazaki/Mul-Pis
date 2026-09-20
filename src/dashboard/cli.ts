#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { startDashboardServer } from "./server.ts";

export async function main(argv: string[]): Promise<number> {
	let workspace: string | undefined;
	let root: string | undefined;
	let port: number | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help") {
			console.log("用法：node src/dashboard/cli.ts [--workspace <dir> | --root <project>] [--port <number>]\n默认只发现 <project>/workspaces/ 的直接子目录；服务仅绑定 127.0.0.1。");
			return 0;
		}
		if (arg === "--workspace" || arg === "--root" || arg === "--port") {
			const value = argv[++index];
			if (!value) throw new Error(`${arg} 缺少值`);
			if (arg === "--workspace") workspace = value;
			else if (arg === "--root") root = value;
			else port = Number(value);
			continue;
		}
		throw new Error(`未知参数：${arg}`);
	}
	if (workspace && root) throw new Error("--workspace 与 --root 不能同时使用");
	const running = await startDashboardServer({ workspace, root, port });
	console.log(`Research dashboard: ${running.url}`);
	console.log(`可选工作区：${running.workspaces.length}`);
	const stop = async () => { await running.close(); };
	process.once("SIGINT", () => void stop().then(() => process.exit(0)));
	process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
