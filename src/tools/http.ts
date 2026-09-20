/** Small HTTP helpers on top of Node's global fetch: timeouts, JSON, text, and file download. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

export const DEFAULT_USER_AGENT = "pre-rsi-research-harness/0.1 (+https://github.com/SakuyaInazaki/Pre-RSI)";

export interface HttpOptions {
	timeoutMs?: number;
	headers?: Record<string, string>;
	userAgent?: string;
}

async function fetchWithTimeout(url: string, options: HttpOptions = {}): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
	try {
		return await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT, ...(options.headers ?? {}) },
		});
	} catch (error) {
		throw new HarnessError("http.request", `请求失败 ${url}：${(error as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
	const response = await fetchWithTimeout(url, { ...options, headers: { accept: "application/json", ...(options.headers ?? {}) } });
	if (!response.ok) throw new HarnessError("http.status", `HTTP ${response.status} ${url}`);
	return (await response.json()) as T;
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<{ status: number; contentType: string; text: string; finalUrl: string }> {
	const response = await fetchWithTimeout(url, options);
	const text = await response.text();
	return { status: response.status, contentType: response.headers.get("content-type") ?? "", text, finalUrl: response.url || url };
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
	const response = await fetchWithTimeout(url, { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
	if (!response.ok) throw new HarnessError("http.status", `HTTP ${response.status} ${url}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	await mkdir(path.dirname(destPath), { recursive: true });
	await writeFile(destPath, buffer);
	return { url, finalUrl: response.url || url, status: response.status, contentType: response.headers.get("content-type") ?? "", bytes: buffer.length, path: destPath };
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
