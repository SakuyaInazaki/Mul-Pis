import { HarnessError } from "../types.ts";

const MODELS_ENDPOINT = "https://api.deepseek.com/models";
const MODELS_SOURCE = "https://api-docs.deepseek.com/api/list-models/";
const CHAT_SOURCE = "https://api-docs.deepseek.com/api/create-chat-completion/";
const MAX_RESPONSE_BYTES = 64 * 1024;
// Current examples say 393216/1048576, but these are evidence of today's
// server values, never permanent workflow ceilings. The live response wins.

export interface DeepSeekProviderOutputLimit {
	readonly version: 1;
	readonly kind: "deepseek-provider-output-limit";
	readonly model: "deepseek-flash";
	readonly endpoint: "https://api.deepseek.com";
	readonly modelVersion: "DeepSeek-V4.1-Flash";
	readonly maxOutputTokens: number;
	readonly contextWindow: number;
	readonly verifiedAt: string;
	readonly sourceUrls: Readonly<{ models: typeof MODELS_SOURCE; chat: typeof CHAT_SOURCE }>;
}

const verified = new WeakSet<object>();
export function isVerifiedDeepSeekProviderOutputLimit(value: unknown): value is DeepSeekProviderOutputLimit {
	return value !== null && typeof value === "object" && verified.has(value);
}

function fail(reason: string): never { throw new HarnessError("runner.provider-limit", reason); }
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
	if (!response.body) fail("DeepSeek model-limit verification returned no body");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) fail("DeepSeek model-limit verification response was oversized");
			parts.push(value);
		}
	} finally { await reader.cancel().catch(() => undefined); }
	try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
	catch { return fail("DeepSeek model-limit verification returned invalid JSON"); }
}

/** Read-only, exact-model preflight. No key or raw response is retained. */
export async function verifyDeepSeekProviderOutputLimit(input: { apiKey: string;
	request?: typeof fetch; now?: () => Date }): Promise<DeepSeekProviderOutputLimit> {
	if (typeof input.apiKey !== "string" || !input.apiKey.trim()) fail("DeepSeek model-limit verification lacks a credential");
	let response: Response;
	try {
		response = await (input.request ?? fetch)(MODELS_ENDPOINT, {
			method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
			headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
		});
	} catch { return fail("DeepSeek model-limit verification was unavailable"); }
	if (!response.ok) fail(`DeepSeek model-limit verification failed with HTTP ${response.status}`);
	const value = await boundedJson(response);
	if (!object(value) || value.object !== "list" || !Array.isArray(value.data) || value.data.length < 1)
		fail("DeepSeek model-limit metadata was incomplete");
	const matching = value.data.filter(item => object(item) && item.id === "deepseek-flash");
	if (matching.length !== 1 || !object(matching[0]) || matching[0].object !== "model" ||
		matching[0].name !== "DeepSeek-V4.1-Flash" ||
		!Number.isSafeInteger(matching[0].context_window) ||
		Number(matching[0].context_window) < 1 ||
		!Number.isSafeInteger(matching[0].max_output_tokens) ||
		Number(matching[0].max_output_tokens) < 1 ||
		Number(matching[0].max_output_tokens) > Number(matching[0].context_window))
		fail("DeepSeek Flash provider output maximum was unavailable or contradicted reviewed documentation");
	const verifiedAt = (input.now?.() ?? new Date()).toISOString();
	const profile: DeepSeekProviderOutputLimit = Object.freeze({ version: 1,
		kind: "deepseek-provider-output-limit", model: "deepseek-flash",
		endpoint: "https://api.deepseek.com",
		modelVersion: "DeepSeek-V4.1-Flash",
		maxOutputTokens: matching[0].max_output_tokens as number,
		contextWindow: matching[0].context_window as number, verifiedAt,
		sourceUrls: Object.freeze({ models: MODELS_SOURCE, chat: CHAT_SOURCE }) });
	verified.add(profile);
	return profile;
}

/** Historical record validator; expiry is a live authorization concern only. */
export function isDeepSeekProviderOutputLimitRecord(value: unknown): value is DeepSeekProviderOutputLimit {
	if (!object(value) || !object(value.sourceUrls)) return false;
	const exact = (item: Record<string, unknown>, keys: string[]): boolean =>
		Object.keys(item).sort().join("|") === keys.sort().join("|");
	return exact(value, ["version", "kind", "model", "endpoint", "modelVersion", "maxOutputTokens",
		"contextWindow", "verifiedAt", "sourceUrls"]) && value.version === 1 &&
		value.kind === "deepseek-provider-output-limit" && value.model === "deepseek-flash" &&
		value.endpoint === "https://api.deepseek.com" &&
		value.modelVersion === "DeepSeek-V4.1-Flash" &&
		Number.isSafeInteger(value.maxOutputTokens) && Number(value.maxOutputTokens) >= 1 &&
		Number.isSafeInteger(value.contextWindow) && Number(value.contextWindow) >= Number(value.maxOutputTokens) &&
		typeof value.verifiedAt === "string" && !Number.isNaN(Date.parse(value.verifiedAt)) &&
		exact(value.sourceUrls, ["models", "chat"]) &&
		value.sourceUrls.models === MODELS_SOURCE && value.sourceUrls.chat === CHAT_SOURCE;
}

export function providerOutputLimitRecord(profile: DeepSeekProviderOutputLimit): DeepSeekProviderOutputLimit {
	if (!isVerifiedDeepSeekProviderOutputLimit(profile)) fail("DeepSeek provider output maximum was not live-verified");
	return { ...profile, sourceUrls: { ...profile.sourceUrls } };
}
