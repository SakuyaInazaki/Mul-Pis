import { HarnessError } from "../types.ts";

const BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const MAX_BALANCE_RESPONSE_BYTES = 16_384;

export type VerifiedDeepSeekAvailability = Readonly<{
	availability: "available" | "unavailable" | "unknown";
}>;

const verified = new WeakSet<object>();

/** A serialized value cannot assert that the Actions credential was probed. */
export function isVerifiedDeepSeekAvailability(value: unknown): value is VerifiedDeepSeekAvailability {
	return value !== null && typeof value === "object" && verified.has(value);
}

/** One provider read may authorize only one current Actions carry entry. */
export function claimVerifiedDeepSeekAvailability(value: unknown): value is VerifiedDeepSeekAvailability {
	if (!isVerifiedDeepSeekAvailability(value)) return false;
	verified.delete(value);
	return true;
}

function observation(availability: VerifiedDeepSeekAvailability["availability"]): VerifiedDeepSeekAvailability {
	const value = Object.freeze({ availability });
	verified.add(value);
	return value;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON.parse keeps the last duplicate member. Reject all duplicate object
 * keys, including escape-equivalent spellings, before trusting availability. */
function hasDuplicateObjectKeys(source: string): boolean {
	const stack: Array<{ kind: "array" } | { kind: "object"; keys: Set<string>; expectsKey: boolean }> = [];
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (character === '"') {
			const start = index++;
			for (; index < source.length; index++) {
				if (source[index] === "\\") { index++; continue; }
				if (source[index] === '"') break;
			}
			const frame = stack.at(-1);
			if (frame?.kind === "object" && frame.expectsKey) {
				const key = JSON.parse(source.slice(start, index + 1)) as string;
				if (frame.keys.has(key)) return true;
				frame.keys.add(key);
				frame.expectsKey = false;
			}
		} else if (character === "{") stack.push({ kind: "object", keys: new Set(), expectsKey: true });
		else if (character === "[") stack.push({ kind: "array" });
		else if (character === "}" || character === "]") stack.pop();
		else if (character === ",") {
			const frame = stack.at(-1);
			if (frame?.kind === "object") frame.expectsKey = true;
		}
	}
	return false;
}

/** Read a small JSON body without retaining an account balance or provider text. */
async function boundedAvailability(response: Response): Promise<VerifiedDeepSeekAvailability["availability"]> {
	if (!response.body) return "unknown";
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_BALANCE_RESPONSE_BYTES) return "unknown";
			parts.push(next.value);
		}
	} catch { return "unknown"; }
	finally { await reader.cancel().catch(() => undefined); }
	let parsed: unknown;
	try {
		const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
		parsed = JSON.parse(source);
		if (hasDuplicateObjectKeys(source)) return "unknown";
	}
	catch { return "unknown"; }
	if (!object(parsed) || typeof parsed.is_available !== "boolean" ||
		!Array.isArray(parsed.balance_infos) ||
		parsed.balance_infos.some(item => !object(item) || typeof item.currency !== "string" ||
			!item.currency || ![item.total_balance, item.granted_balance, item.topped_up_balance]
				.every(value => typeof value === "string"))) return "unknown";
	if (!parsed.is_available) return "unavailable";
	return parsed.balance_infos.length > 0 ? "available" : "unknown";
}

/** Actions-only read-only probe. Amounts, bodies, and credentials never leave this function. */
export async function checkDeepSeekAvailability(input: { apiKey: string; request?: typeof fetch }):
	Promise<VerifiedDeepSeekAvailability> {
	if (typeof input.apiKey !== "string" || !input.apiKey.trim())
		throw new HarnessError("runner.provider-availability", "DeepSeek availability credential absent");
	let response: Response;
	try {
		response = await (input.request ?? fetch)(BALANCE_ENDPOINT, {
			method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
			headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
		});
	} catch { return observation("unknown"); }
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => undefined);
		return observation("unknown");
	}
	return observation(await boundedAvailability(response));
}
