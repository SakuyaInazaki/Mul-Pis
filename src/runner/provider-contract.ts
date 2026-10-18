/**
 * Provider request contracts.
 *
 * The runner core must not know which vendor it is talking to. What it needs is
 * narrower: for some providers there is a static check that can refuse a
 * malformed request before it is sent, and a bound on the output-token field of
 * the serialized payload. Both are expressed here as a registry entry, so a
 * second provider is added by registering a contract rather than by adding a
 * provider name to a conditional inside the session builder.
 *
 * The rules themselves stay in the vendor module that owns them: reasoning
 * replay, signature requirements and tool-result pairing differ per provider and
 * are not generic knowledge.
 */
import { HarnessError } from "../types.ts";
import type { ProviderRequestViolation } from "./types.ts";

export type OutputTokenField = "max_tokens" | "max_completion_tokens" | "both" | "omitted";

/** A static, host-side refusal of one attempted payload. The request was not issued. */
export class ProviderRequestContractError extends HarnessError {
	readonly issued = false;
	readonly violation: ProviderRequestViolation;
	readonly messageIndex: number | null;
	constructor(code: string, message: string, violation: ProviderRequestViolation, messageIndex: number | null = null) {
		super(code, message);
		this.name = "ProviderRequestContractError";
		this.violation = violation;
		this.messageIndex = messageIndex;
	}
}

export interface ProviderRequestContract {
	provider: string;
	api: string;
	/** Validate the final serialized payload. Throws ProviderRequestContractError. */
	assertRequest(payload: string, options?: { sourceMessages?: readonly unknown[] }): void;
}

const contracts = new Map<string, ProviderRequestContract>();

export function registerProviderRequestContract(contract: ProviderRequestContract): void {
	const key = `${contract.provider}/${contract.api}`;
	const existing = contracts.get(key);
	if (existing && existing !== contract)
		throw new HarnessError("runner.provider-contract", `a different request contract is already registered for ${key}`);
	contracts.set(key, contract);
}

export function providerRequestContract(provider: string, api: string): ProviderRequestContract | undefined {
	return contracts.get(`${provider}/${api}`);
}

/**
 * Check the output-token bound of a serialized chat-completions payload without
 * changing the SDK's provider or context negotiation. The shape is defined by
 * the API, not by the vendor.
 */
export function inspectCompletionsOutputRequest(payload: unknown,
	expected: { provider: string; id: string; api: string; baseUrl: string; maxTokens: number },
	actual: typeof expected): { payload: Record<string, unknown>; outputTokens: number; outputField: OutputTokenField } {
	if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
		actual.provider !== expected.provider || actual.id !== expected.id ||
		actual.api !== expected.api || actual.baseUrl !== expected.baseUrl)
		throw new HarnessError("runner.model", "provider request changed model");
	const record = payload as Record<string, unknown>;
	if (record.model !== expected.id || !Number.isSafeInteger(expected.maxTokens) || expected.maxTokens < 1)
		throw new HarnessError("runner.model", "provider request changed model or resolved output maximum");
	const hasMax = record.max_tokens !== undefined;
	const hasCompletionMax = record.max_completion_tokens !== undefined;
	if ((hasMax && (!Number.isSafeInteger(record.max_tokens) || Number(record.max_tokens) < 1 ||
		Number(record.max_tokens) > expected.maxTokens)) ||
		(hasCompletionMax && (!Number.isSafeInteger(record.max_completion_tokens) ||
			Number(record.max_completion_tokens) < 1 || Number(record.max_completion_tokens) > expected.maxTokens)) ||
		(hasMax && hasCompletionMax && record.max_tokens !== record.max_completion_tokens))
		throw new HarnessError("runner.model", "provider request output bound is invalid or exceeds provider maximum");
	return { payload: record, outputTokens: (record.max_tokens ?? record.max_completion_tokens ?? expected.maxTokens) as number,
		outputField: hasMax && hasCompletionMax ? "both" : hasMax ? "max_tokens" :
			hasCompletionMax ? "max_completion_tokens" : "omitted" };
}
