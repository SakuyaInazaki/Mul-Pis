/** Small HTTP helpers on top of Node's global fetch: bounded, idle-aware transfers. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

export const DEFAULT_USER_AGENT = "pre-rsi-research-harness/0.1 (+https://github.com/SakuyaInazaki/Pre-RSI)";
export const MAX_HTTP_TEXT_BYTES = 20_000_000;
export const MAX_HTTP_DOWNLOAD_BYTES = 250_000_000;

export interface HttpOptions {
	/** Connection or consecutive byte-idle time, not a whole-transfer deadline. */
	timeoutMs?: number;
	signal?: AbortSignal;
	headers?: Record<string, string>;
	userAgent?: string;
}

/** Headers and body share one network-idle watchdog, reset whenever bytes arrive. */
export async function fetchWithIdleTimeout(url: string, options: HttpOptions = {}, maxBytes = MAX_HTTP_TEXT_BYTES): Promise<{ response: Response; body: Buffer }> {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	const idleMs = options.timeoutMs ?? 30_000;
	let timer: NodeJS.Timeout | undefined;
	const resetIdle = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new Error("network idle timeout")), idleMs);
		timer.unref();
	};
	try {
		resetIdle();
		const response = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT, ...(options.headers ?? {}) },
		});
		const reader = response.body?.getReader();
		if (!reader) return { response, body: Buffer.alloc(0) };
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			resetIdle();
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) { await reader.cancel(); throw new HarnessError("http.size", `响应超过 ${maxBytes} 字节文件大小上限：${url}`); }
			chunks.push(value);
		}
		return { response, body: Buffer.concat(chunks, bytes) };
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		if (error instanceof HarnessError) throw error;
		throw new HarnessError("http.request", `请求失败 ${url}：${(error as Error).message}`);
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function fetchJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
	const { response, body } = await fetchWithIdleTimeout(url, { ...options, headers: { accept: "application/json", ...(options.headers ?? {}) } });
	if (!response.ok) throw new HarnessError("http.status", `HTTP ${response.status} ${url}`);
	return JSON.parse(body.toString("utf8")) as T;
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<{ status: number; contentType: string; text: string; finalUrl: string }> {
	const { response, body } = await fetchWithIdleTimeout(url, options);
	return { status: response.status, contentType: response.headers.get("content-type") ?? "", text: body.toString("utf8"), finalUrl: response.url || url };
}

export interface DownloadResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	bytes: number;
	path: string;
}

export async function downloadToFile(url: string, destPath: string, options: HttpOptions = {}): Promise<DownloadResult> {
	const { response, body } = await fetchWithIdleTimeout(url, { ...options, timeoutMs: options.timeoutMs ?? 120_000 }, MAX_HTTP_DOWNLOAD_BYTES);
	if (!response.ok) throw new HarnessError("http.status", `HTTP ${response.status} ${url}`);
	await mkdir(path.dirname(destPath), { recursive: true });
	await writeFile(destPath, body);
	return { url, finalUrl: response.url || url, status: response.status, contentType: response.headers.get("content-type") ?? "", bytes: body.length, path: destPath };
}

/** Minimal HTML → text: drop scripts/styles, convert block tags to newlines, strip the rest, decode a few entities. */
export function htmlToText(html: string): { title: string; text: string } {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
	let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
	s = s.replace(/<\s*(br|p|div|li|tr|h[1-6]|section|article|header|footer|table|blockquote|pre)[^>]*>/gi, "\n");
	s = s.replace(/<[^>]+>/g, " ");
	s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
	s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
	return { title, text: s };
}

export function extensionForContentType(contentType: string, url: string): string {
	const ct = contentType.toLowerCase();
	if (ct.includes("pdf")) return ".pdf";
	if (ct.includes("html")) return ".html";
	if (ct.includes("json")) return ".json";
	if (ct.includes("xml")) return ".xml";
	if (ct.startsWith("text/")) return ".txt";
	const fromUrl = path.extname(new URL(url).pathname);
	return fromUrl || ".bin";
}
