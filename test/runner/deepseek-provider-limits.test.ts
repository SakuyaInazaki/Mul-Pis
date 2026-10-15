import assert from "node:assert/strict";
import test from "node:test";
import { verifyDeepSeekProviderOutputLimit, isVerifiedDeepSeekProviderOutputLimit,
	providerOutputLimitRecord } from "../../src/runner/deepseek-provider-limits.ts";

const KEY = "synthetic-provider-probe-key";
const model = (maxOutputTokens: number, contextWindow = 1_048_576) => ({
	id: "deepseek-flash", object: "model", owned_by: "deepseek", name: "DeepSeek-V4.1-Flash",
	max_output_tokens: maxOutputTokens, context_window: contextWindow,
});
const response = (items: unknown[]): typeof fetch => async () =>
	new Response(JSON.stringify({ object: "list", data: items }), { status: 200 });

test("read-only model metadata provides the live server maximum without retained key or response", async () => {
	let target = "";
	let auth = "";
	const profile = await verifyDeepSeekProviderOutputLimit({ apiKey: KEY,
		now: () => new Date("2026-10-06T11:10:00.000Z"),
		request: async (url, init) => {
			target = String(url); auth = new Headers(init?.headers).get("authorization") ?? "";
			assert.equal(init?.method, "GET");
			return response([model(393_216)])(url, init);
		} });
	assert.equal(target, "https://api.deepseek.com/models");
	assert.equal(auth, `Bearer ${KEY}`);
	assert.equal(profile.maxOutputTokens, 393_216);
	assert.equal(profile.contextWindow, 1_048_576);
	assert.equal(isVerifiedDeepSeekProviderOutputLimit(profile), true);
	assert.equal(isVerifiedDeepSeekProviderOutputLimit(providerOutputLimitRecord(profile)), false);
	assert.doesNotMatch(JSON.stringify(profile), /synthetic-provider-probe-key/);
});
