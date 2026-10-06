import assert from "node:assert/strict";
import test from "node:test";
import { verifyDeepSeekCnyBilling, isVerifiedNativeCnyPricingProfile,
	nativeCnyPricingRecord } from "../../src/runner/deepseek-cny-pricing.ts";
import { DeepSeekCampaignBudget } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";

const KEY = "synthetic-only-key-never-sent";
const NOW = () => new Date("2026-10-06T10:30:00.000Z");
const account = (currencies: string[], available = true): typeof fetch => async () => new Response(JSON.stringify({
	is_available: available,
	balance_infos: currencies.map(currency => ({ currency, total_balance: "PRIVATE-BALANCE-AMOUNT",
		granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" })),
}), { status: 200, headers: { "content-type": "application/json" } });
const outputProfile = (bound = 393_216) => verifyDeepSeekProviderOutputLimit({ apiKey: KEY, now: NOW,
	request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
		object: "model", name: "DeepSeek-V4.1-Flash", context_window: 1_048_576,
		max_output_tokens: bound }] }), { status: 200 }) });

test("read-only CNY probe returns a live peak price profile without balances or credentials", async () => {
	let target = "";
	let method = "";
	let authorization = "";
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY,
		now: NOW,
		request: async (url, init) => {
			target = String(url); method = init?.method ?? "";
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return account(["CNY"])(url, init);
		} });
	assert.equal(target, "https://api.deepseek.com/user/balance");
	assert.equal(method, "GET");
	assert.equal(authorization, `Bearer ${KEY}`);
	assert.equal(profile.currency, "CNY");
	assert.equal(profile.modelVersion, "DeepSeek-V4.1-Flash");
	assert.equal(profile.priceReviewedAt, "2026-10-06T10:26:00.000Z");
	assert.equal(profile.profileValidUntil, "2026-10-07T00:00:00.000Z");
	assert.equal(profile.currencyVerifiedAt, NOW().toISOString());
	assert.deepEqual(profile.rates, { inputMiss: 2, cacheRead: 0.04, output: 8 });
	assert.deepEqual(profile.usdQuoteRates, { inputMiss: 0.3, cacheRead: 0.006, output: 1.2 });
	assert.equal(isVerifiedNativeCnyPricingProfile(profile), true);
	assert.equal(isVerifiedNativeCnyPricingProfile(nativeCnyPricingRecord(profile)), false);
	assert.doesNotMatch(JSON.stringify(profile), /PRIVATE-|synthetic-only-key/);
});

test("USD, mixed, empty, unknown, unavailable and failed probes block before a paid request", async () => {
	for (const currencies of [["USD"], ["CNY", "USD"], [], ["JPY"]]) {
		await assert.rejects(verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(currencies), now: NOW }),
			(error: unknown) => error instanceof Error && /billing currenc|bills in USD/.test(error.message) &&
				!error.message.includes(KEY) && !error.message.includes("PRIVATE-"));
	}
	await assert.rejects(verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"], false), now: NOW }),
		/billing currency could not be verified/);
	await assert.rejects(verifyDeepSeekCnyBilling({ apiKey: KEY, request: async () => { throw new Error(`SECRET ${KEY}`); }, now: NOW }),
		(error: unknown) => error instanceof Error && /verification was unavailable/.test(error.message) &&
			!error.message.includes(KEY));
});

test("a price profile outside its reviewed UTC day stops before even the balance probe", async () => {
	let requests = 0;
	const request: typeof fetch = async () => { requests++; return account(["CNY"])("https://api.deepseek.com/user/balance"); };
	for (const time of ["2026-10-06T10:25:59.999Z", "2026-10-07T00:00:00.000Z"]) {
		await assert.rejects(verifyDeepSeekCnyBilling({ apiKey: KEY, request,
			now: () => new Date(time) }), /profile review has expired or is not yet valid/);
	}
	assert.equal(requests, 0);
});

test("a profile expires before a later model call even if its account probe was earlier", async () => {
	let clock = NOW();
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: () => clock });
	const providerOutputLimit = await outputProfile();
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", maxCny: 30, priorCommittedCny: 0,
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 2, estimatedCacheReadCnyPerMillionTokens: 0.04,
		estimatedOutputCnyPerMillionTokens: 8, nativeCnyPricing: profile });
	clock = new Date("2026-10-07T00:00:00.000Z");
	assert.throws(() => budget.beginPrompt("synthetic", "expired"), /profile review has expired/);
	assert.equal(budget.snapshot().reservations, 0);
	assert.equal(budget.snapshot().stopReason, "price-assumption-invalid");
});

test("native CNY profile prices new reservations without legacy FX while preserving old commitments", async () => {
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: NOW });
	const providerOutputLimit = await outputProfile();
	const limits = { model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com" as const,
		maxCny: 30, priorCommittedCny: 3.307312,
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 2, estimatedCacheReadCnyPerMillionTokens: 0.04,
		estimatedOutputCnyPerMillionTokens: 8, nativeCnyPricing: profile };
	assert.throws(() => new DeepSeekCampaignBudget({ ...limits, estimatedCnyPerUsd: 10 }), /invalid DeepSeek campaign limits/);
	assert.equal(new DeepSeekCampaignBudget({ ...limits, maxProviderCalls: 1,
		maxProviderCallsPerPrompt: 1, maxOutputTokens: 1 }).strictRequest.maxOutputTokens,
		providerOutputLimit.maxOutputTokens,
		"retired caller fields cannot lower the live provider bound or impose a request quota");
	assert.throws(() => new DeepSeekCampaignBudget({ ...limits, nativeCnyPricing: nativeCnyPricingRecord(profile) }),
		/invalid DeepSeek campaign limits/);
	const budget = new DeepSeekCampaignBudget(limits);
	budget.assertResolved({ provider: "deepseek", id: "deepseek-flash", api: "openai-completions",
		baseUrl: "https://api.deepseek.com", maxTokens: providerOutputLimit.maxOutputTokens,
		contextWindow: providerOutputLimit.contextWindow,
		cost: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 } });
	const lease = budget.beginPrompt("synthetic", "one");
	budget.reserve(lease, 100, "one", providerOutputLimit.maxOutputTokens);
	assert.equal(budget.requestAuditSnapshot().requests[0].reservedCny,
		(100 * 2 + (providerOutputLimit.maxOutputTokens + 32) * 8) / 1_000_000);
	assert.equal(budget.snapshot().priorCommittedCny, 3.307312);
	assert.equal(budget.snapshot().pricingProfile?.currency, "CNY");
	assert.equal(budget.requestAuditSnapshot().pricingProfile?.priceReviewedAt, "2026-10-06T10:26:00.000Z");
	assert.doesNotMatch(JSON.stringify(budget.requestAuditSnapshot()), /PRIVATE-|synthetic-only-key/);
	const response = { entryId: "provider-one", kind: "assistant" as const, promptIndex: 1,
		at: "2026-10-06T10:31:00.000Z", provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "reported" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
			cost: 0.0000078 } };
	budget.settleReported(lease, "one", response);
	assert(Math.abs(budget.snapshot().settledCny - (10 * 2 + 4 * 8) / 1_000_000) < 1e-12);
	budget.finishPrompt(lease, [{ requestId: "one", event: response }]);
	const raised = new DeepSeekCampaignBudget(limits);
	raised.assertResolved({ provider: "deepseek", id: "deepseek-flash", api: "openai-completions",
		baseUrl: "https://api.deepseek.com", maxTokens: providerOutputLimit.maxOutputTokens,
		contextWindow: providerOutputLimit.contextWindow,
		cost: { input: 0.6, cacheRead: 0.012, cacheWrite: 0, output: 2.4 } });
	const next = raised.beginPrompt("synthetic", "higher-sdk-quote");
	raised.reserve(next, 100, "two", providerOutputLimit.maxOutputTokens);
	assert.equal(raised.requestAuditSnapshot().requests[0].reservedCny,
		(100 * 4 + (providerOutputLimit.maxOutputTokens + 32) * 16) / 1_000_000,
		"a higher normalized SDK quote raises the reserve instead of lowering the official CNY floor");
});

test("native budget reserves the exact live provider maximum even when it differs from today's example", async () => {
	const price = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]), now: NOW });
	for (const bound of [100_000, 500_000]) {
		const providerOutputLimit = await outputProfile(bound);
		const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
			endpoint: "https://api.deepseek.com", maxCny: 30, priorCommittedCny: 0,
			outputAccountingMarginTokens: 32, estimatedInputCnyPerMillionTokens: 2,
			estimatedCacheReadCnyPerMillionTokens: 0.04, estimatedOutputCnyPerMillionTokens: 8,
			nativeCnyPricing: price, providerOutputLimit });
		assert.equal(budget.strictRequest.maxOutputTokens, bound);
		const lease = budget.beginPrompt(`synthetic-${bound}`, "one");
		budget.reserve(lease, 100, `request-${bound}`);
		assert.equal(budget.requestAuditSnapshot().requests[0].maxOutputTokens, bound);
		assert.equal(budget.requestAuditSnapshot().requests[0].admissionDecision, "provider-maximum");
		assert.equal(budget.requestAuditSnapshot().requests[0].reservedCny,
			(100 * 2 + (bound + 32) * 8) / 1_000_000);
		if (bound === 100_000) {
			budget.reserve(lease, 100, "second-request");
			assert.equal(budget.snapshot().reservations, 2,
				"a new native campaign counts requests for audit without an artificial call quota");
			assert.equal(budget.snapshot().stopped, false);
		}
		budget.failPrompt(lease);
	}
});
