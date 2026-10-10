import assert from "node:assert/strict";
import test from "node:test";
import { checkDeepSeekAvailability, isVerifiedDeepSeekAvailability,
	claimVerifiedDeepSeekAvailability } from
	"../../src/runner/deepseek-availability.ts";

const KEY = "synthetic-test-key";
const balance = (is_available: boolean, balance_infos: unknown = [{ currency: "USD",
	total_balance: "PRIVATE_AMOUNT", granted_balance: "PRIVATE_GRANT",
	topped_up_balance: "PRIVATE_TOPUP" }]): Response =>
	new Response(JSON.stringify({ is_available, balance_infos }), { status: 200 });

test("availability is branded only after an actual fixed read-only provider balance GET", async () => {
	let calls = 0;
	const checked = await checkDeepSeekAvailability({ apiKey: KEY, request: async (target, init) => {
		calls++;
		assert.equal(String(target), "https://api.deepseek.com/user/balance");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${KEY}`);
		assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
		assert.ok(init?.signal);
		return balance(true);
	} });
	assert.equal(calls, 1);
	assert.deepEqual(checked, { availability: "available" });
	assert.equal(isVerifiedDeepSeekAvailability(checked), true);
	assert.equal(isVerifiedDeepSeekAvailability({ ...checked }), false);
	assert.equal(claimVerifiedDeepSeekAvailability(checked), true);
	assert.equal(isVerifiedDeepSeekAvailability(checked), false);
	assert.equal(claimVerifiedDeepSeekAvailability(checked), false);
	assert.equal(claimVerifiedDeepSeekAvailability({ ...checked }), false);
	assert.doesNotMatch(JSON.stringify(checked), /PRIVATE_|synthetic-test-key/);
});

test("false availability and ambiguous provider replies fail closed without private data", async () => {
	const cases: Array<[string, typeof fetch, "unavailable" | "unknown"]> = [
		["false", async () => balance(false), "unavailable"],
		["empty true", async () => balance(true, []), "unknown"],
		["malformed balance", async () => balance(true, [{ currency: "USD" }]), "unknown"],
		["missing balance", async () => new Response(JSON.stringify({ is_available: true }),
			{ status: 200 }), "unknown"],
		["bad type", async () => new Response(JSON.stringify({ is_available: "true",
			balance_infos: [] }), { status: 200 }), "unknown"],
		["non-200", async () => new Response("PRIVATE_PROVIDER_BODY", { status: 402 }), "unknown"],
		["invalid JSON", async () => new Response("PRIVATE_PROVIDER_BODY", { status: 200 }), "unknown"],
		["duplicate availability", async () => new Response(
			'{"is_available":false,"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"PRIVATE_AMOUNT","granted_balance":"PRIVATE_GRANT","topped_up_balance":"PRIVATE_TOPUP"}]}',
			{ status: 200 }), "unknown"],
		["escaped duplicate availability", async () => new Response(
			'{"is_available":false,"is_\\u0061vailable":true,"balance_infos":[{"currency":"USD","total_balance":"PRIVATE_AMOUNT","granted_balance":"PRIVATE_GRANT","topped_up_balance":"PRIVATE_TOPUP"}]}',
			{ status: 200 }), "unknown"],
		["duplicate nested balance field", async () => new Response(
			'{"is_available":true,"balance_infos":[{"currency":"USD","currency":"CNY","total_balance":"PRIVATE_AMOUNT","granted_balance":"PRIVATE_GRANT","topped_up_balance":"PRIVATE_TOPUP"}]}',
			{ status: 200 }), "unknown"],
		["malformed UTF-8 inside valid JSON structure", async () => new Response(Buffer.concat([
			Buffer.from('{"is_available":true,"balance_infos":[{"currency":"U'),
			Buffer.from([0xff]),
			Buffer.from('SD","total_balance":"PRIVATE_AMOUNT","granted_balance":"PRIVATE_GRANT","topped_up_balance":"PRIVATE_TOPUP"}]}'),
		]), { status: 200 }), "unknown"],
		["oversized", async () => new Response("x".repeat(16_385), { status: 200 }), "unknown"],
		["network failure", async () => { throw Error(`PRIVATE_${KEY}`); }, "unknown"],
	];
	for (const [label, request, expected] of cases) {
		const checked = await checkDeepSeekAvailability({ apiKey: KEY, request });
		assert.equal(checked.availability, expected, label);
		assert.equal(isVerifiedDeepSeekAvailability(checked), true, label);
		assert.doesNotMatch(JSON.stringify(checked), /PRIVATE_|synthetic-test-key/, label);
	}
});

test("missing credential cannot mint an available or unknown runtime observation", async () => {
	let called = false;
	await assert.rejects(checkDeepSeekAvailability({ apiKey: "", request: async () => {
		called = true; return balance(true);
	} }), /availability credential absent/);
	assert.equal(called, false);
});
