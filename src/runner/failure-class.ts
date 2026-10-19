/**
 * Infrastructure failures and policy failures, kept apart.
 *
 * A timed-out device, a dropped request or a crashed compiler says nothing about
 * the candidate; a wrong result or a rejected contract does. Counting them
 * together produces two specific harms: the agent starts "fixing" correct code
 * against environment noise, and a report attributes harness breakage to the
 * optimisation strategy.
 *
 * The infrastructure list is closed and small. Anything that does not match it
 * exactly, and is not clearly the candidate's own failure, is `unjudged`: it is
 * never retried automatically, never counted as a strategy failure, and the
 * share of unjudged outcomes is itself the signal that the harness is unwell.
 */
export type FailureClass = "infrastructure" | "policy" | "unjudged";

export interface FailureJudgementV1 {
	class: FailureClass;
	/** Short, stable reason id; never provider or candidate text. */
	reason: string;
	/** Only an infrastructure failure may be retried without changing anything. */
	retryable: boolean;
}

/** Host-side faults that are known not to be caused by the candidate. */
const INFRASTRUCTURE_ERROR_CODES = new Set([
	"ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH",
	"ENOSPC", "EMFILE", "ENFILE", "EAGAIN", "EBUSY",
]);

const INFRASTRUCTURE_HARNESS_CODES = new Set([
	"runner.device-lease", "platform.device-lease", "runner.sandbox", "runner.sandbox-path",
]);

const INFRASTRUCTURE_PROVIDER_CODES = new Set(["rate_limit_exceeded", "server_error"]);

export interface ToolFailureInput {
	/** Tool that failed. */
	name: string;
	/** Node or harness error code already extracted by the runner. */
	errorCode?: string;
	errorClass?: "harness" | "filesystem" | "tool-error";
	/** Managed process outcome when the host owned the child. */
	exit?: { exitCode: number | null; abortSource?: "signal" | "timeout" | null };
	/** Failure class decided by the platform profile from the tool's own output. */
	platformClass?: "syntax" | "hardware" | "numeric" | "infrastructure";
}

export function classifyToolFailure(input: ToolFailureInput): FailureJudgementV1 {
	if (input.platformClass === "infrastructure")
		return { class: "infrastructure", reason: "platform-reported-environment-fault", retryable: true };
	if (input.platformClass) return { class: "policy", reason: `candidate-${input.platformClass}`, retryable: false };
	if (input.exit?.abortSource === "timeout") return { class: "infrastructure", reason: "tool-timeout", retryable: true };
	if (input.exit?.abortSource === "signal") return { class: "unjudged", reason: "tool-killed", retryable: false };
	if (input.errorCode && INFRASTRUCTURE_HARNESS_CODES.has(input.errorCode))
		return { class: "infrastructure", reason: input.errorCode, retryable: true };
	if (input.errorCode === "runner.platform-contract")
		return { class: "policy", reason: "platform-contract-violation", retryable: false };
	if (input.errorCode && INFRASTRUCTURE_ERROR_CODES.has(input.errorCode))
		return { class: "infrastructure", reason: input.errorCode, retryable: true };
	// A command that ran and returned a non-zero status is the candidate's own
	// result, whatever it printed.
	if (typeof input.exit?.exitCode === "number" && input.exit.exitCode !== 0)
		return { class: "policy", reason: "nonzero-exit", retryable: false };
	return { class: "unjudged", reason: input.errorCode ?? "unclassified", retryable: false };
}

export interface TransportFailureInput {
	transportInterrupted?: true;
	httpStatus: number | null;
	providerErrorCode: string | null;
	providerErrorReasonClass?: "context-window" | "input-schema" | "tool-reasoning" | "insufficient-balance" | "unknown";
	abortSource: "host-signal" | "handle" | "sdk-signal" | null;
	attemptedRequestNotSent?: true;
	errorCodes: readonly string[];
}

export function classifyTransportFailure(input: TransportFailureInput): FailureJudgementV1 {
	if (input.abortSource === "handle" || input.abortSource === "host-signal")
		return { class: "unjudged", reason: "aborted-by-host", retryable: false };
	if (input.attemptedRequestNotSent)
		return { class: "policy", reason: "request-contract-violation", retryable: false };
	if (input.providerErrorReasonClass === "context-window")
		return { class: "policy", reason: "context-window-exceeded", retryable: false };
	if (input.providerErrorReasonClass === "insufficient-balance")
		return { class: "infrastructure", reason: "insufficient-balance", retryable: false };
	if (input.providerErrorCode && INFRASTRUCTURE_PROVIDER_CODES.has(input.providerErrorCode))
		return { class: "infrastructure", reason: input.providerErrorCode, retryable: true };
	if (typeof input.httpStatus === "number" && input.httpStatus >= 500)
		return { class: "infrastructure", reason: "provider-5xx", retryable: true };
	if (input.transportInterrupted || input.errorCodes.some(code => INFRASTRUCTURE_ERROR_CODES.has(code)))
		return { class: "infrastructure", reason: "transport-interrupted", retryable: true };
	return { class: "unjudged", reason: "unclassified-provider-failure", retryable: false };
}

export interface FailureTallyV1 {
	infrastructure: number;
	policy: number;
	unjudged: number;
	/** Share of outcomes nobody could judge; a health signal for the harness itself. */
	unjudgedShare: number;
}

export function tallyFailures(judgements: readonly FailureJudgementV1[]): FailureTallyV1 {
	const tally = { infrastructure: 0, policy: 0, unjudged: 0, unjudgedShare: 0 };
	for (const judgement of judgements) tally[judgement.class]++;
	const total = judgements.length;
	tally.unjudgedShare = total === 0 ? 0 : tally.unjudged / total;
	return tally;
}

