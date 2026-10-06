import { HarnessError } from "../types.ts";

/** Exact host-verified tool scope permitted to settle a whole prompt disposition. */
export type HostEffectScope = "no-tools" | "factory-attested-confined-file-tools";

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
