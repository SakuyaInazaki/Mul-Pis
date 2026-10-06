import { HarnessError } from "../types.ts";

const BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const PRICING_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const USD_PRICING_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";
const BALANCE_SOURCE = "https://api-docs.deepseek.com/zh-cn/api/get-user-balance/";
// V1 historical constants are immutable. A later price review needs a new
// profile version/validator branch, never a replacement that breaks old carries.
const PRICE_EFFECTIVE_AT = "2026-09-10T04:00:00.000Z";
const PRICE_REVIEWED_AT = "2026-10-06T10:26:00.000Z";
const PROFILE_VALID_UNTIL = "2026-10-07T00:00:00.000Z";
const MAX_BALANCE_RESPONSE_BYTES = 16_384;

/** Official published peak CNY quotes for DeepSeek-V4.1-Flash, per million tokens.
 * USD SDK quotes are normalized by the published price-table ratio, not FX.
 */
export const DEEPSEEK_FLASH_PUBLISHED_USD_TO_CNY_QUOTE_RATIO = 20 / 3;

export interface NativeCnyPricingProfile {
	readonly version: 1;
	readonly kind: "deepseek-native-cny-peak";
	readonly model: "deepseek-flash";
	readonly modelVersion: "DeepSeek-V4.1-Flash";
	readonly currency: "CNY";
	/** From the live balance probe; it says nothing about current tariffs. */
	readonly currencyVerifiedAt: string;
	readonly priceEffectiveAt: typeof PRICE_EFFECTIVE_AT;
	/** Human-reviewed primary pricing pages, pinned to this UTC calendar day only. */
	readonly priceReviewedAt: typeof PRICE_REVIEWED_AT;
	readonly profileValidUntil: typeof PROFILE_VALID_UNTIL;
	readonly rates: Readonly<{ inputMiss: 2; cacheRead: 0.04; output: 8 }>;
	readonly usdQuoteRates: Readonly<{ inputMiss: 0.3; cacheRead: 0.006; output: 1.2 }>;
	readonly sourceUrls: Readonly<{ pricing: typeof PRICING_SOURCE; pricingUsd: typeof USD_PRICING_SOURCE;
		balance: typeof BALANCE_SOURCE }>;
}

const verifiedProfiles = new WeakSet<object>();
const profileClocks = new WeakMap<object, () => Date>();
export function isVerifiedNativeCnyPricingProfile(value: unknown): value is NativeCnyPricingProfile {
	return value !== null && typeof value === "object" && verifiedProfiles.has(value);
}

/** Recheck before every model transport: a cached profile cannot outlive its review day. */
export function assertNativeCnyPricingCurrent(profile: NativeCnyPricingProfile): void {
	if (!isVerifiedNativeCnyPricingProfile(profile)) fail("DeepSeek CNY price profile was not verified in this process");
	const now = profileClocks.get(profile)?.() ?? new Date();
	if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(PRICE_REVIEWED_AT) ||
		now.getTime() >= Date.parse(PROFILE_VALID_UNTIL))
		fail("DeepSeek published CNY pricing profile review has expired or is not yet valid");
}

/** Structural validation for a previously encrypted audit record, never live authorization. */
export function isNativeCnyPricingRecord(value: unknown): value is NativeCnyPricingProfile {
	if (!object(value) || !object(value.rates) || !object(value.usdQuoteRates) || !object(value.sourceUrls)) return false;
	const exact = (item: Record<string, unknown>, keys: string[]): boolean =>
		Object.keys(item).sort().join("|") === keys.sort().join("|");
	return exact(value, ["version", "kind", "model", "modelVersion", "currency", "currencyVerifiedAt",
		"priceEffectiveAt", "priceReviewedAt", "profileValidUntil", "rates", "usdQuoteRates", "sourceUrls"]) &&
		value.version === 1 && value.kind === "deepseek-native-cny-peak" &&
		value.model === "deepseek-flash" && value.modelVersion === "DeepSeek-V4.1-Flash" &&
		value.currency === "CNY" && value.priceEffectiveAt === PRICE_EFFECTIVE_AT &&
		value.priceReviewedAt === PRICE_REVIEWED_AT && value.profileValidUntil === PROFILE_VALID_UNTIL &&
		typeof value.currencyVerifiedAt === "string" &&
		Date.parse(value.currencyVerifiedAt) >= Date.parse(PRICE_REVIEWED_AT) &&
		Date.parse(value.currencyVerifiedAt) < Date.parse(PROFILE_VALID_UNTIL) &&
		exact(value.rates, ["inputMiss", "cacheRead", "output"]) &&
		value.rates.inputMiss === 2 && value.rates.cacheRead === 0.04 && value.rates.output === 8 &&
		exact(value.usdQuoteRates, ["inputMiss", "cacheRead", "output"]) &&
		value.usdQuoteRates.inputMiss === 0.3 && value.usdQuoteRates.cacheRead === 0.006 &&
		value.usdQuoteRates.output === 1.2 &&
		exact(value.sourceUrls, ["pricing", "pricingUsd", "balance"]) &&
		value.sourceUrls.pricing === PRICING_SOURCE &&
		value.sourceUrls.pricingUsd === USD_PRICING_SOURCE && value.sourceUrls.balance === BALANCE_SOURCE;
}

function fail(reason: string): never {
	throw new HarnessError("runner.billing-currency", reason);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
	if (!response.body) return fail("DeepSeek billing currency verification returned no body");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BALANCE_RESPONSE_BYTES) return fail("DeepSeek billing currency verification response was oversized");
			parts.push(value);
		}
	} finally { await reader.cancel().catch(() => undefined); }
	try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
	catch { return fail("DeepSeek billing currency verification returned invalid JSON"); }
}

/** A read-only preflight. Never return, persist, or log any balance amount or credential. */
export async function verifyDeepSeekCnyBilling(input: { apiKey: string; request?: typeof fetch;
	now?: () => Date }): Promise<NativeCnyPricingProfile> {
	const at = input.now?.() ?? new Date();
	if (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(PRICE_REVIEWED_AT) ||
		at.getTime() >= Date.parse(PROFILE_VALID_UNTIL))
		fail("DeepSeek published CNY pricing profile review has expired or is not yet valid");
	if (typeof input.apiKey !== "string" || !input.apiKey.trim()) fail("DeepSeek billing currency verification lacks a credential");
	let response: Response;
	try {
		response = await (input.request ?? fetch)(BALANCE_ENDPOINT, {
			method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
			headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
		});
	} catch { return fail("DeepSeek billing currency verification was unavailable"); }
	if (!response.ok) fail(`DeepSeek billing currency verification failed with HTTP ${response.status}`);
	const decoded = await boundedJson(response);
	if (!object(decoded) || decoded.is_available !== true || !Array.isArray(decoded.balance_infos))
		fail("DeepSeek billing currency could not be verified from the account response");
	const infos = decoded.balance_infos;
	if (infos.length !== 1 || !object(infos[0]) || typeof infos[0].currency !== "string" ||
		![infos[0].total_balance, infos[0].granted_balance, infos[0].topped_up_balance]
			.every(value => typeof value === "string"))
		fail("DeepSeek account has multiple or unknown billing currencies");
	if (infos[0].currency !== "CNY")
		fail(infos[0].currency === "USD" ? "DeepSeek account bills in USD; CNY campaign is blocked" :
			"DeepSeek account billing currency is unknown; CNY campaign is blocked");
	const currencyVerifiedAt = at.toISOString();
	const profile: NativeCnyPricingProfile = Object.freeze({ version: 1,
		kind: "deepseek-native-cny-peak", model: "deepseek-flash",
		modelVersion: "DeepSeek-V4.1-Flash", currency: "CNY", currencyVerifiedAt,
		priceEffectiveAt: PRICE_EFFECTIVE_AT, priceReviewedAt: PRICE_REVIEWED_AT,
		profileValidUntil: PROFILE_VALID_UNTIL,
		rates: Object.freeze({ inputMiss: 2, cacheRead: 0.04, output: 8 }),
		usdQuoteRates: Object.freeze({ inputMiss: 0.3, cacheRead: 0.006, output: 1.2 }),
		sourceUrls: Object.freeze({ pricing: PRICING_SOURCE, pricingUsd: USD_PRICING_SOURCE,
			balance: BALANCE_SOURCE }) });
	verifiedProfiles.add(profile);
	profileClocks.set(profile, input.now ?? (() => new Date()));
	return profile;
}

/** Serializable host record without account amounts, response body, or API key. */
export function nativeCnyPricingRecord(profile: NativeCnyPricingProfile): NativeCnyPricingProfile {
	if (!isVerifiedNativeCnyPricingProfile(profile)) fail("DeepSeek CNY price profile was not verified in this process");
	return { ...profile, rates: { ...profile.rates }, usdQuoteRates: { ...profile.usdQuoteRates },
		sourceUrls: { ...profile.sourceUrls } };
}
