import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithIdleTimeout } from "../src/tools/http.ts";

test("a progressing transfer can exceed one idle interval", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]));
			setTimeout(() => controller.enqueue(new Uint8Array([2])), 15);
			setTimeout(() => controller.enqueue(new Uint8Array([3])), 30);
			setTimeout(() => controller.close(), 45);
		},
	}));
	const { body } = await fetchWithIdleTimeout("https://example.invalid/data", { timeoutMs: 25 }, 10);
	assert.deepEqual([...body], [1, 2, 3]);
});

test("an idle network body is aborted as a transport failure", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
		},
	}));
	await assert.rejects(fetchWithIdleTimeout("https://example.invalid/idle", { timeoutMs: 20 }, 10), (error: any) => error.code === "http.request" && /network idle timeout/.test(error.message));
});

test("the response byte guard remains active", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]));
	await assert.rejects(fetchWithIdleTimeout("https://example.invalid/large", { timeoutMs: 20 }, 3), (error: any) => error.code === "http.size");
});

test("explicit cancellation is propagated distinctly from network idle", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	const external = new AbortController();
	globalThis.fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
		},
	}));
	const pending = fetchWithIdleTimeout("https://example.invalid/cancel", { timeoutMs: 1_000, signal: external.signal }, 10);
	setTimeout(() => external.abort(new Error("explicit stop")), 10);
	await assert.rejects(pending, /explicit stop/);
});
