import { HarnessError } from "../types.ts";
import type { DeepSeekRequestViolation } from "./deepseek-request-contract.ts";

/** Exact host-verified tool scope permitted to settle a whole prompt disposition. */
export type HostEffectScope = "no-tools" | "factory-attested-confined-file-tools";
export type LocalAdmissionDecision = "input-unaffordable" | "minimum-output-unaffordable" |
	"requested-output-cap-unaffordable" | "provider-maximum-unaffordable" | "provider-call-limit";

/** A whole prompt had no admitted provider transport and no tool-side effects in this scope. */
export interface LocalNotIssuedDetails {
	readonly settledProviderRequestCount: 0;
	readonly requestNotSent: true;
	readonly stopReason: "total-cny-ceiling" | "provider-call-limit";
	readonly admissionDecision: LocalAdmissionDecision;
	readonly effectScope: HostEffectScope;
}

/** Host-only evidence that a later subrequest was rejected before transport. */
export interface SettledLocalAdmissionStopDetails {
	readonly settledProviderRequestCount: number;
	readonly rejectedBeforeTransport: true;
	readonly stopReason: string;
	readonly effectScope: HostEffectScope;
}

/** Host-only evidence that a terminal provider response arrived and its
 * transport outcome was reconciled, but was truncated. CNY may remain unknown. */
export interface SettledTerminalResponseDetails {
	readonly settledProviderRequestCount: number;
	readonly responseReceived: true;
	readonly terminalStopReason: "length";
	readonly taskComplete: false;
	readonly effectScope: HostEffectScope;
}

/** A final serialized DeepSeek request failed a static host check before any
 * provider request in this prompt. This never settles an earlier issued call. */
export interface RequestNotSentDetails {
	readonly requestNotSent: true;
	readonly noProviderRequestsInPrompt: true;
	readonly effectScope: HostEffectScope;
	readonly violation: DeepSeekRequestViolation;
	readonly messageIndex: number | null;
}

const REQUEST_VIOLATIONS: ReadonlySet<string> = new Set([
	"request-shape", "message-shape", "tool-call-shape", "duplicate-tool-call",
	"orphan-tool-result", "duplicate-tool-result", "incomplete-tool-results",
	"thinking-tool-choice", "missing-reasoning", "unsigned-reasoning",
	"reasoning-replay-mismatch",
]);

const localStops = new WeakMap<object, SettledLocalAdmissionStopDetails>();
const terminalResponses = new WeakMap<object, SettledTerminalResponseDetails>();
const localNotIssued = new WeakMap<object, LocalNotIssuedDetails>();
const requestNotSent = new WeakMap<object, RequestNotSentDetails>();

/** Brand only the runner's verified zero-request preflight disposition. The
 * fixed message and copied control fields cannot disclose request contents. */
export function certifyRequestNotSent(details: RequestNotSentDetails): HarnessError {
	if (details.requestNotSent !== true || details.noProviderRequestsInPrompt !== true ||
		(details.effectScope !== "no-tools" &&
			details.effectScope !== "factory-attested-confined-file-tools") ||
		!REQUEST_VIOLATIONS.has(details.violation) ||
		(details.messageIndex !== null &&
			(!Number.isSafeInteger(details.messageIndex) || details.messageIndex < 0)))
		throw new HarnessError("runner.request-contract", "invalid host request preflight disposition");
	const error = new HarnessError("runner.request-contract.not-issued",
		"DeepSeek request contract rejected before provider transport");
	requestNotSent.set(error, Object.freeze({ requestNotSent: true,
		noProviderRequestsInPrompt: true, effectScope: details.effectScope,
		violation: details.violation, messageIndex: details.messageIndex }));
	return error;
}

export function requestNotSentDetails(error: unknown): RequestNotSentDetails | undefined {
	return error !== null && typeof error === "object" ? requestNotSent.get(error) : undefined;
}

/** Call only after the owning runner verifies the first request was refused before transport. */
export function certifyLocalNotIssued(details: LocalNotIssuedDetails, message: string): HarnessError {
	const error = new HarnessError("runner.campaign.not-issued", message);
	localNotIssued.set(error, Object.freeze({ ...details }));
	return error;
}

export function isLocalNotIssued(error: unknown): error is HarnessError {
	return error !== null && typeof error === "object" && localNotIssued.has(error);
}

export function localNotIssuedDetails(error: unknown): LocalNotIssuedDetails | undefined {
	return isLocalNotIssued(error) ? localNotIssued.get(error) : undefined;
}

/** Call only after the owning runner has verified every earlier request settled. */
export function certifySettledLocalAdmissionStop(details: SettledLocalAdmissionStopDetails,
	message: string): HarnessError {
	const error = new HarnessError("runner.campaign.partial-settled", message);
	localStops.set(error, Object.freeze({ ...details }));
	return error;
}

/** Call only after the owning runner has verified each response arrived and its
 * transport outcome is known; fee currency is a separate observation. */
export function certifySettledTerminalResponse(details: SettledTerminalResponseDetails,
	message: string): HarnessError {
	const error = new HarnessError("runner.response.length-settled", message);
	terminalResponses.set(error, Object.freeze({ ...details }));
	return error;
}

export function isSettledLocalAdmissionStop(error: unknown): error is HarnessError {
	return error !== null && typeof error === "object" && localStops.has(error);
}

export function settledLocalAdmissionStopDetails(error: unknown): SettledLocalAdmissionStopDetails | undefined {
	return isSettledLocalAdmissionStop(error) ? localStops.get(error) : undefined;
}

export function isSettledTerminalResponse(error: unknown): error is HarnessError {
	return error !== null && typeof error === "object" && terminalResponses.has(error);
}

export function settledTerminalResponseDetails(error: unknown): SettledTerminalResponseDetails | undefined {
	return isSettledTerminalResponse(error) ? terminalResponses.get(error) : undefined;
}
