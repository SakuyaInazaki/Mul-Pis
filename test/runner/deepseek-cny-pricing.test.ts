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

test("native CNY profile quantifies requests without a fee cap or legacy FX", async () => {
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: NOW });
	const providerOutputLimit = await outputProfile();
	const limits = { model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com" as const,
		maxCny: 0.000001, priorCommittedCny: 3.307312,
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 2, estimatedCacheReadCnyPerMillionTokens: 0.04,
		estimatedOutputCnyPerMillionTokens: 8, nativeCnyPricing: profile };
	assert.equal(new DeepSeekCampaignBudget({ ...limits, estimatedCnyPerUsd: 10,
		estimatedInputCnyPerMillionTokens: 999, estimatedOutputCnyPerMillionTokens: 999 }).strictRequest.maxOutputTokens,
		providerOutputLimit.maxOutputTokens, "retired caller prices cannot prevent a provider-max request");
	assert.equal(new DeepSeekCampaignBudget({ ...limits, maxProviderCalls: 1,
		maxProviderCallsPerPrompt: 1, maxOutputTokens: 1 }).strictRequest.maxOutputTokens,
		providerOutputLimit.maxOutputTokens,
		"retired caller fields cannot lower the live provider bound or impose a request quota");
	assert.equal(new DeepSeekCampaignBudget({ ...limits, nativeCnyPricing: nativeCnyPricingRecord(profile) })
		.strictRequest.maxOutputTokens, providerOutputLimit.maxOutputTokens);
	const budget = new DeepSeekCampaignBudget(limits);
	budget.assertResolved({ provider: "deepseek", id: "deepseek-flash", api: "openai-completions",
		baseUrl: "https://api.deepseek.com", maxTokens: providerOutputLimit.maxOutputTokens,
		contextWindow: providerOutputLimit.contextWindow,
		cost: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 } });
	const lease = budget.beginPrompt("synthetic", "one");
	budget.reserve(lease, 100, "one", providerOutputLimit.maxOutputTokens);
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "in-flight");
	assert.equal(budget.snapshot().priorCommittedCny, 3.307312);
	assert.equal(budget.snapshot().pricingProfile?.currency, "CNY");
	assert.doesNotMatch(JSON.stringify(budget.requestAccountingAuditSnapshot()), /PRIVATE-|synthetic-only-key/);
	const response = { entryId: "provider-one", kind: "assistant" as const, promptIndex: 1,
		at: "2026-10-06T10:31:00.000Z", provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "reported" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
			cost: 0.0000078 } };
	budget.settleReported(lease, "one", response);
	assert(Math.abs(budget.requestAccountingAuditSnapshot().requests[0].settledCny! - (10 * 2 + 4 * 8) / 1_000_000) < 1e-12);
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 0);
	budget.finishPrompt(lease, [{ requestId: "one", event: response }]);
	const raised = new DeepSeekCampaignBudget(limits);
	raised.assertResolved({ provider: "deepseek", id: "deepseek-flash", api: "openai-completions",
		baseUrl: "https://api.deepseek.com", maxTokens: providerOutputLimit.maxOutputTokens,
		contextWindow: providerOutputLimit.contextWindow,
		cost: { input: 0.6, cacheRead: 0.012, cacheWrite: 0, output: 2.4 } });
	const next = raised.beginPrompt("synthetic", "higher-sdk-quote");
	raised.reserve(next, 100, "two", providerOutputLimit.maxOutputTokens);
	assert.equal(raised.requestAccountingAuditSnapshot().requests[0].status, "in-flight");
	assert.equal(raised.requestAccountingAuditSnapshot().requests[0].maxOutputTokens,
		providerOutputLimit.maxOutputTokens);
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
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].maxOutputTokens, bound);
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "in-flight");
		if (bound === 100_000) {
			budget.reserve(lease, 100, "second-request");
			assert.equal(budget.snapshot().reservations, 2,
				"a new native campaign counts requests for audit without an artificial call quota");
			assert.equal(budget.snapshot().stopped, false);
		}
		budget.failPrompt(lease);
	}
});

test("a once-verified CNY profile becomes unpriced after expiry without blocking another request", async () => {
	let clock = NOW();
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: () => clock });
	const providerOutputLimit = await outputProfile();
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", maxCny: 0.000001, priorCommittedCny: 20,
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 2, estimatedCacheReadCnyPerMillionTokens: 0.04,
		estimatedOutputCnyPerMillionTokens: 8, nativeCnyPricing: profile });
	clock = new Date("2026-10-07T00:00:00.000Z");
	const lease = budget.beginPrompt("synthetic", "expired");
	budget.reserve(lease, 100, "request", providerOutputLimit.maxOutputTokens);
	assert.equal(budget.snapshot().grossReservedCny, 0);
	assert.equal(budget.snapshot().inFlightReservedCny, 0);
	const event = { entryId: "response", kind: "assistant" as const, promptIndex: 1,
		at: clock.toISOString(), provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "reported" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
			cost: 0.0000078 } };
	budget.finishPrompt(lease, [{ requestId: "request", event }]);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests[0].settledCny, null);
	assert.equal(audit.requests[0].unknownObservedCny, null);
	assert.equal(audit.requests[0].reportedUsage?.totalTokens, 14);
	assert.equal(audit.unpricedRequestCount, 1);
	assert.equal(budget.snapshot().stopped, false);
});

test("a request crossing the price-review boundary retains received usage without a stale CNY charge", async () => {
	let clock = new Date("2026-10-06T23:59:59.000Z");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: () => clock });
	const providerOutputLimit = await outputProfile();
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit,
		outputAccountingMarginTokens: 32, nativeCnyPricing: profile });
	const lease = budget.beginPrompt("crossing", "received");
	budget.reserve(lease, 100, "crossing-request");
	assert(budget.snapshot().inFlightReservedCny > 0);
	clock = new Date("2026-10-07T00:00:00.000Z");
	const response = { entryId: "crossing-response", kind: "assistant" as const, promptIndex: 1,
		at: clock.toISOString(), provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "reported" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
			cost: 0.0000078 } };
	budget.finishPrompt(lease, [{ requestId: "crossing-request", event: response }]);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests[0].responseReceived, true);
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[0].settledCny, null);
	assert.equal(audit.requests[0].unknownObservedCny, null);
	assert.equal(audit.requests[0].reportedUsage?.totalTokens, 14);
	assert.equal(audit.unpricedRequestCount, 1);
	assert.equal(budget.snapshot().grossReservedCny, 0);
	assert.equal(budget.snapshot().unknownReservedCny, 0);
	assert.equal(budget.snapshot().stopped, false);
});

test("a request crossing the price-review boundary retains unknown transport without a stale CNY hold", async () => {
	let clock = new Date("2026-10-06T23:59:59.000Z");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: () => clock });
	const providerOutputLimit = await outputProfile();
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit,
		outputAccountingMarginTokens: 32, nativeCnyPricing: profile });
	const lease = budget.beginPrompt("crossing", "lost");
	budget.reserve(lease, 100, "lost-request");
	assert(budget.snapshot().inFlightReservedCny > 0);
	clock = new Date("2026-10-07T00:00:00.000Z");
	budget.failPrompt(lease);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests[0].responseReceived, false);
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[0].settledCny, null);
	assert.equal(audit.requests[0].unknownObservedCny, null);
	assert.equal(audit.unpricedRequestCount, 1);
	assert.equal(budget.snapshot().grossReservedCny, 0);
	assert.equal(budget.snapshot().unknownReservedCny, 0);
	assert.equal(budget.snapshot().stopped, false);
	const next = budget.beginPrompt("crossing", "later");
	budget.reserve(next, 100, "later-request");
	assert.equal(budget.snapshot().reservations, 2);
});

test("a response settled before expiry stays priced when only a later request is unpriced", async () => {
	let clock = new Date("2026-10-06T23:59:59.000Z");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: () => clock });
	const providerOutputLimit = await outputProfile();
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit,
		outputAccountingMarginTokens: 32, nativeCnyPricing: profile });
	const first = budget.beginPrompt("priced", "first");
	budget.reserve(first, 100, "priced-request");
	const response = { entryId: "priced-response", kind: "assistant" as const, promptIndex: 1,
		at: clock.toISOString(), provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "reported" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
			cost: 0.0000078 } };
	budget.finishPrompt(first, [{ requestId: "priced-request", event: response }]);
	const priorCharge = budget.requestAccountingAuditSnapshot().requests[0].settledCny;
	assert(typeof priorCharge === "number" && priorCharge > 0);
	const priorGross = budget.snapshot().grossReservedCny;
	clock = new Date("2026-10-07T00:00:00.000Z");
	const second = budget.beginPrompt("priced", "second");
	budget.reserve(second, 100, "unpriced-request");
	budget.failPrompt(second);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests[0].settledCny, priorCharge);
	assert.equal(audit.requests[0].status, "settled");
	assert.equal(audit.requests[1].settledCny, null);
	assert.equal(audit.requests[1].unknownObservedCny, null);
	assert.equal(audit.unpricedRequestCount, 1);
	assert.equal(budget.snapshot().settledCny, priorCharge);
	assert.equal(budget.snapshot().grossReservedCny, priorGross);
});

test("an unknown fee observed before price expiry keeps its historical hold after later cleanup", async () => {
	let clock = new Date("2026-10-06T23:59:59.000Z");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]),
		now: () => clock });
	const providerOutputLimit = await outputProfile();
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit,
		outputAccountingMarginTokens: 32, nativeCnyPricing: profile });
	const lease = budget.beginPrompt("historical", "unknown");
	budget.reserve(lease, 100, "historical-unknown");
	const unresolved = {
		entryId: "unresolved-usage", kind: "assistant" as const, promptIndex: 1,
		at: clock.toISOString(), provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "unknown" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0,
			totalTokens: 14, cost: 0.0000078 },
	};
	budget.settleReported(lease, "historical-unknown", unresolved);
	const prior = budget.requestAccountingAuditSnapshot();
	const hold = prior.requests[0].unknownObservedCny;
	assert(typeof hold === "number" && hold > 0);
	clock = new Date("2026-10-07T00:00:00.000Z");
	// The duplicate receipt is legal; finishPrompt will revisit the old unknown
	// during lease cleanup after the price review expired.
	budget.finishPrompt(lease, [{ requestId: "historical-unknown", event: unresolved }]);
	const after = budget.requestAccountingAuditSnapshot();
	assert.equal(after.requests[0].unknownObservedCny, hold);
	assert.equal(after.unknownObservedCny, prior.unknownObservedCny);
	assert.equal(after.unpricedRequestCount, 0);
	assert.equal(budget.snapshot().unknownReservedCny, hold);
});

test("an unverified supplied CNY profile leaves currency unpriced and does not stop research", async () => {
	const verified = await verifyDeepSeekCnyBilling({ apiKey: KEY, request: account(["CNY"]), now: NOW });
	const providerOutputLimit = await outputProfile();
	const unverifiedCopy = nativeCnyPricingRecord(verified);
	assert.equal(isVerifiedNativeCnyPricingProfile(unverifiedCopy), false);
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", maxCny: 0.000001,
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 2, estimatedOutputCnyPerMillionTokens: 8,
		nativeCnyPricing: unverifiedCopy });
	const first = budget.beginPrompt("synthetic", "one");
	budget.reserve(first, 100, "one");
	const response = { entryId: "response-one", kind: "assistant" as const, promptIndex: 1,
		at: NOW().toISOString(), provider: "deepseek", model: "deepseek-flash",
		stopReason: "stop", status: "reported" as const, costStatus: "priced" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
			cost: 0.0000078 } };
	budget.finishPrompt(first, [{ requestId: "one", event: response }]);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[0].settledCny, null);
	assert.equal(audit.requests[0].unknownObservedCny, null);
	assert.equal(audit.requests[0].reportedUsage?.totalTokens, 14);
	assert.equal(audit.unpricedRequestCount, 1);
	assert.equal(budget.snapshot().stopped, false);
	const next = budget.beginPrompt("synthetic", "two");
	budget.reserve(next, 100, "two");
	assert.equal(budget.snapshot().reservations, 2);
});
