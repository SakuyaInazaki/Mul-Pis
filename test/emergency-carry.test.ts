import assert from "node:assert/strict";
import test from "node:test";
import { sealCampaignCarry } from "../src/runner/emergency-carry.ts";
import type { AccountingCarrySealInput } from "../src/runner/ledger-continuation.ts";
import { nativeCnyPricingRecord, verifyDeepSeekCnyBilling } from "../src/runner/deepseek-cny-pricing.ts";

const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
	now: () => new Date("2026-10-06T10:30:00.000Z"),
	request: async () => new Response(JSON.stringify({ is_available: true,
		balance_infos: [{ currency: "CNY", total_balance: "synthetic",
			granted_balance: "synthetic", topped_up_balance: "synthetic" }] }), { status: 200 }) });

function observation(): AccountingCarrySealInput {
	return { settledCny: 0.02, unknownObservedCny: 0.01, unpricedRequestCount: 0,
		requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [{ requestId: "synthetic-settled", inputPayloadBytes: 100,
				sessionId: "a".repeat(64), responseReceived: true, status: "settled",
				settledCny: 0.02, unknownObservedCny: null,
				reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
					totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" } },
				{ requestId: "synthetic-unknown", inputPayloadBytes: 100,
					sessionId: "b".repeat(64), responseReceived: false, status: "unknown",
					settledCny: null, unknownObservedCny: 0.01, reportedUsage: null }],
			settledCny: 0.02, unknownObservedCny: 0.01,
			unpricedRequestCount: 0, pricingProfile: nativeCnyPricingRecord(profile) } };
}
const output = { envelopeB64: "synthetic", observedSettledCny: 0.02,
	observedUnknownHeldCny: 0.01, unpricedRequestCount: 0 };

test("successful normal carry never calls the emergency sealer", () => {
	const input = observation();
	const result = sealCampaignCarry({ sealCurrent: seen => {
		assert.equal(seen, input); return output;
	}, sealEmergencyCurrent: () => { throw Error("unexpected emergency call"); } }, input);
	assert.equal(result.mode, "normal");
	assert.equal(result.carry, output);
});
test("failed normal carry invokes the emergency sealer with the exact same audit", () => {
	const input = observation();
	let seen = 0;
	const result = sealCampaignCarry({ sealCurrent: received => {
		assert.equal(received, input); seen++; throw Error("normal scientific seal unavailable");
	}, sealEmergencyCurrent: (received, reason) => {
		assert.equal(received, input); assert.equal(reason, "effect-review-incomplete"); seen++; return output;
	} }, input);
	assert.equal(seen, 2);
	assert.equal(result.mode, "emergency-effects-unreviewed");
	assert.equal(result.carry.observedSettledCny, input.settledCny);
	assert.equal(result.carry.observedUnknownHeldCny, input.unknownObservedCny);
});
test("changed audit or failed emergency seal cannot yield a carry", () => {
	const input = observation();
	assert.throws(() => sealCampaignCarry({ sealCurrent: received => {
		received.requestAudit.requests.push({ requestId: "synthetic", inputPayloadBytes: 1,
			status: "unknown", settledCny: null, unknownObservedCny: null, reportedUsage: null });
		throw Error("normal failed");
	}, sealEmergencyCurrent: () => output }, input), /changed the audited observation/);
	assert.throws(() => sealCampaignCarry({ sealCurrent: () => { throw Error("normal failed"); },
		sealEmergencyCurrent: () => { throw Error("emergency failed"); } }, observation()), /emergency failed/);
});
