import { HarnessError } from "../types.ts";

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

/** Host-only evidence that a terminal provider response arrived and settled, but was truncated. */
export interface SettledTerminalResponseDetails {
	readonly settledProviderRequestCount: number;
	readonly responseReceived: true;
	readonly terminalStopReason: "length";
	readonly taskComplete: false;
	readonly effectScope: HostEffectScope;
}

const localStops = new WeakMap<object, SettledLocalAdmissionStopDetails>();
const terminalResponses = new WeakMap<object, SettledTerminalResponseDetails>();
const localNotIssued = new WeakMap<object, LocalNotIssuedDetails>();

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

/** Call only after the owning runner has verified terminal usage and all prior settlements. */
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
