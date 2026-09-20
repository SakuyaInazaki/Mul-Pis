import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDashboardState } from "./state.ts";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

export interface DashboardWorkspace {
	id: string;
	label: string;
	initialized: boolean;
}

interface RegisteredWorkspace extends DashboardWorkspace {
	root: string;
}

export interface DashboardServerOptions {
	/** A single explicitly selected research workspace. */
	workspace?: string;
	/** Project root whose immediate `workspaces/` children may be selected. */
	root?: string;
	port?: number;
	maxPortAttempts?: number;
	publicDir?: string;
}

export interface RunningDashboardServer {
	server: Server;
	port: number;
	host: typeof LOOPBACK;
	url: string;
	workspaces: DashboardWorkspace[];
	close(): Promise<void>;
}

function workspaceId(root: string): string {
	return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

async function isDirectory(target: string): Promise<boolean> {
	try { return (await stat(target)).isDirectory(); }
	catch { return false; }
}

async function registerWorkspace(target: string): Promise<RegisteredWorkspace> {
	const root = await realpath(path.resolve(target));
	if (!(await isDirectory(root))) throw new Error(`工作区不存在或不是目录：${target}`);
	return {
		id: workspaceId(root),
		label: path.basename(root) || "workspace",
		initialized: existsSync(path.join(root, "research.config.json")),
		root,
	};
}

async function safeDirectory(target: string): Promise<boolean> {
	try { const info = await lstat(target); return info.isDirectory() && !info.isSymbolicLink(); }
	catch { return false; }
}

async function assertRegularMetadataFile(file: string, root: string): Promise<void> {
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("面板元数据包含不允许的符号链接");
	const actual = await realpath(file);
	if (!actual.startsWith(`${root}${path.sep}`)) throw new Error("面板元数据超出工作区范围");
}

/** Validate exactly the metadata paths consumed by readDashboardState, without scanning artifacts or transcripts. */
async function assertDashboardMetadataConfined(root: string): Promise<void> {
	const stages = path.join(root, "stages");
	if (existsSync(stages)) {
		if (!(await safeDirectory(stages))) throw new Error("stages 元数据目录不能是符号链接");
		for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"]) {
			const stageDir = path.join(stages, stage);
			if (!existsSync(stageDir)) continue;
			if (!(await safeDirectory(stageDir))) throw new Error(`${stage} 元数据目录不能是符号链接`);
			for (const entry of await readdir(stageDir, { withFileTypes: true })) {
				if (!entry.isDirectory() || entry.isSymbolicLink()) {
					if (entry.isSymbolicLink()) throw new Error("运行元数据目录不能是符号链接");
					continue;
				}
				const runDir = path.join(stageDir, entry.name);
				for (const name of stage === "M07" ? ["run.json", "goal.json"] : ["run.json"]) {
					const file = path.join(runDir, name);
					if (existsSync(file)) await assertRegularMetadataFile(file, root);
				}
			}
		}
	}
	for (const [dir, suffix] of [[path.join(root, ".agent", "telemetry"), ".json"], [path.join(root, ".agent", "sessions"), ".spec.json"]] as const) {
		if (!existsSync(dir)) continue;
		if (!(await safeDirectory(dir))) throw new Error("面板会话元数据目录不能是符号链接");
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (!entry.name.endsWith(suffix)) continue;
			await assertRegularMetadataFile(path.join(dir, entry.name), root);
		}
	}
}

/** Discover only immediate children of <root>/workspaces; this never recursively scans the machine. */
export async function discoverDashboardWorkspaces(options: Pick<DashboardServerOptions, "root" | "workspace">): Promise<RegisteredWorkspace[]> {
	if (options.workspace) return [await registerWorkspace(options.workspace)];
	const scope = path.join(path.resolve(options.root ?? process.cwd()), "workspaces");
	if (!(await isDirectory(scope))) return [];
	const realScope = await realpath(scope);
	const entries = await readdir(scope, { withFileTypes: true });
	const found: RegisteredWorkspace[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const registered = await registerWorkspace(path.join(scope, entry.name));
		if (registered.root.startsWith(`${realScope}${path.sep}`)) found.push(registered);
	}
	return found;
}

function json(res: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
		return json(res, 413, { error: { code: "response.too_large", message: "状态快照超过面板的安全响应上限" } });
	}
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
}

function localAuthority(value: string | undefined, port: number): boolean {
	if (!value) return true;
	try {
		const url = value.includes("://") ? new URL(value) : new URL(`http://${value}`);
		return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (!url.port || Number(url.port) === port);
	} catch { return false; }
}

function mime(file: string): string {
	switch (path.extname(file)) {
		case ".html": return "text/html; charset=utf-8";
		case ".js": return "text/javascript; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".svg": return "image/svg+xml";
		case ".png": return "image/png";
		default: return "application/octet-stream";
	}
}

async function serveStatic(res: ServerResponse, pathname: string, publicDir: string): Promise<void> {
	let decoded: string;
	try { decoded = decodeURIComponent(pathname); }
	catch { json(res, 400, { error: { code: "request.path", message: "无效路径" } }); return; }
	const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
	if (!relative || relative.includes("\0")) { json(res, 404, { error: { code: "not_found", message: "资源不存在" } }); return; }
	const base = await realpath(publicDir).catch(() => path.resolve(publicDir));
	const candidate = path.resolve(base, relative);
	if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
		json(res, 403, { error: { code: "request.path", message: "路径不在静态资源目录内" } }); return;
	}
	try {
		const actual = await realpath(candidate);
		if (!actual.startsWith(`${base}${path.sep}`) || !(await stat(actual)).isFile()) throw new Error("outside");
		res.writeHead(200, {
			"Content-Type": mime(actual),
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
			"X-Content-Type-Options": "nosniff",
		});
		createReadStream(actual).pipe(res);
	} catch { json(res, 404, { error: { code: "not_found", message: "资源不存在" } }); }
}

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<RunningDashboardServer> {
	const registered = await discoverDashboardWorkspaces(options);
	const byId = new Map(registered.map((item) => [item.id, item]));
	const publicDir = path.resolve(options.publicDir ?? PUBLIC_DIR);
	let boundPort = 0;
	const server = createServer(async (req, res) => {
		try {
			if (!localAuthority(req.headers.host, boundPort) || !localAuthority(req.headers.origin, boundPort)) {
				json(res, 403, { error: { code: "request.origin", message: "只接受本机面板发出的请求" } }); return;
			}
			if (req.method !== "GET") {
				res.setHeader("Allow", "GET");
				json(res, 405, { error: { code: "request.method", message: "面板接口只读" } }); return;
			}
			try {
				const rawPath = decodeURIComponent((req.url ?? "/").split("?", 1)[0]);
				if (rawPath.split("/").includes("..")) { json(res, 403, { error: { code: "request.path", message: "路径不在静态资源目录内" } }); return; }
			} catch { json(res, 400, { error: { code: "request.path", message: "无效路径" } }); return; }
			const url = new URL(req.url ?? "/", `http://${LOOPBACK}:${boundPort}`);
			if (url.pathname === "/api/workspaces") {
				json(res, 200, {
					workspaces: registered.map(({ id, label, initialized }) => ({ id, label, initialized })),
					selected: registered.length === 1 ? registered[0].id : undefined,
				}); return;
			}
			if (url.pathname === "/api/state") {
				const id = url.searchParams.get("workspace");
				if (!id) { json(res, 400, { error: { code: "workspace.required", message: "缺少 workspace ID" } }); return; }
				const workspace = byId.get(id);
				if (!workspace) { json(res, 404, { error: { code: "workspace.unknown", message: "工作区未在此服务启动时登记" } }); return; }
				await assertDashboardMetadataConfined(workspace.root);
				const state = await readDashboardState(workspace.root);
				state.workspace = { id: workspace.id, label: workspace.label, initialized: workspace.initialized };
				json(res, 200, state); return;
			}
			if (url.pathname.startsWith("/api/")) { json(res, 404, { error: { code: "not_found", message: "接口不存在" } }); return; }
			await serveStatic(res, url.pathname, publicDir);
		} catch (error) {
			json(res, 500, { error: { code: "dashboard.internal", message: error instanceof Error ? error.message : "无法生成面板状态" } });
		}
	});

	const requested = options.port ?? DEFAULT_PORT;
	if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error("端口必须是 0 到 65535 的整数");
	const attempts = requested === 0 ? 1 : Math.max(1, options.maxPortAttempts ?? 20);
	let lastError: unknown;
	for (let offset = 0; offset < attempts; offset++) {
		const port = requested === 0 ? 0 : requested + offset;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
				const onListening = () => { server.off("error", onError); resolve(); };
				server.once("error", onError); server.once("listening", onListening); server.listen(port, LOOPBACK);
			});
			boundPort = (server.address() as { port: number }).port;
			break;
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		}
	}
	if (!boundPort) throw lastError instanceof Error ? lastError : new Error("没有可用的本机端口");
	return {
		server, port: boundPort, host: LOOPBACK, url: `http://${LOOPBACK}:${boundPort}/`,
		workspaces: registered.map(({ id, label, initialized }) => ({ id, label, initialized })),
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}
