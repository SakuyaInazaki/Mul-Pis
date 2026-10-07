import { createHash } from "node:crypto";
import { HarnessError } from "../types.ts";
import type { SessionSpec, UsageEvent } from "./types.ts";
import { getConfinedCampaignFileGrantDescriptor } from "./confined-campaign-files.ts";
import { certifySettledTerminalResponse } from "./operation-disposition.ts";
import type { HostEffectScope, LocalAdmissionDecision } from "./operation-disposition.ts";
import { assertNativeCnyPricingCurrent,
	isVerifiedNativeCnyPricingProfile,
	nativeCnyPricingRecord, type NativeCnyPricingProfile } from "./deepseek-cny-pricing.ts";
import { isVerifiedDeepSeekProviderOutputLimit, providerOutputLimitRecord,
	type DeepSeekProviderOutputLimit } from "./deepseek-provider-limits.ts";
export { isSettledLocalAdmissionStop as isSettledLocalCampaignBudgetStop,
	settledLocalAdmissionStopDetails as settledLocalCampaignBudgetStopDetails } from "./operation-disposition.ts";

/**
 * In-process transport/accounting evidence for one DeepSeek research attempt.
 * The separate authenticated carry preserves earlier observations and uncertain
 * holds. This class does not limit spending; estimates are not provider invoices.
 */
export interface DeepSeekCampaignLimits {
	model: string;
	endpoint: "https://api.deepseek.com";
	/** Only valid live mode; old ceiling fields are decoded as historical data. */
	accountingMode?: "accounting-only";
	/** Historical caller field, accepted for compatibility but never a live gate. */
	maxCny?: number;
	/** Historical caller field; cumulative provenance is kept by the signed carry. */
	priorCommittedCny?: number;
	/** Retired historical input fields; accepted for record compatibility, never enforced. */
	maxProviderCalls?: number;
	maxProviderCallsPerPrompt?: number;
	maxOutputTokens?: number;
	/** Required live server-reported maximum, never selected to fit available money. */
	providerOutputLimit: DeepSeekProviderOutputLimit;
	/** Optional serialized request byte boundary for a fixed-size public input. */
	maxInputPayloadBytes?: number;
	outputAccountingMarginTokens: number;
	/** Retired planning rates; live CNY estimates use only a verified native profile. */
	estimatedInputCnyPerMillionTokens?: number;
	estimatedCacheReadCnyPerMillionTokens?: number;
	estimatedOutputCnyPerMillionTokens?: number;
	/** Retired USD conversion, never used as live CNY evidence. */
	estimatedCnyPerUsd?: number;
	/** A live host-verified CNY billing profile for new requests; never inherited from old carries. */
	nativeCnyPricing?: NativeCnyPricingProfile;
}

function count(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

/** An opaque, single-process capability for one prompt on one session. */
export interface PromptLease {
	readonly sessionId: string;
	readonly promptId: string;
}

/** A new assistant event, explicitly paired with the provider request it answers. */
export interface PromptUsageReceipt {
	readonly requestId: string;
	readonly event: UsageEvent;
}

interface LeaseState {
	readonly requests: RequestState[];
	active: boolean;
	terminalLengthRequestId?: string;
}

interface RequestState {
	readonly id: string;
	readonly sessionId: string;
	readonly inputPayloadBytes: number;
	readonly maxOutputTokens: number;
	worstCny: number;
	rates: { input: number; cacheRead: number; output: number };
	/** Whether the native CNY rate was verified when this transport was admitted. */
	nativeCnyVerified: boolean;
	responseReceived: boolean;
	status: "reserved" | "settled" | "unknown";
	settledCny?: number;
	unknownHeldCny?: number;
	reportedUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number;
		totalTokens: number; reportedUsdCost: number | null; costStatus: string | null };
	reportFingerprint?: string;
}

/** Opaque join key for private host effect receipts; never expose the Pi session ID. */
export function campaignSessionEffectId(sessionId: string): string {
	return createHash("sha256").update(`mul-pis-private-session-effect-v1\0${sessionId}`).digest("hex");
}

/** Host-only accounting evidence. Encrypt before persistence; never log or expose to a model. */
export interface CampaignRequestAudit {
	requestId: string; inputPayloadBytes: number; reservedCny: number;
	/** Absent only in older sealed carry rows. The actual HTTP output cap when present. */
	maxOutputTokens?: number;
	status: "reserved" | "settled" | "unknown";
	settledCny: number | null; unknownHeldCny: number | null;
	reportedUsage: RequestState["reportedUsage"] | null;
	/** Absent only in older sealed carry rows. */
	admissionDecision?: "full-output" | "reduced-output" | "provider-maximum";
}

/** Host-only facts about a request refused before HTTP transport. No prompt or identifiers. */
export interface CampaignAdmissionRejection {
	version: 1; kind: "campaign-admission-rejection";
	decision: LocalAdmissionDecision; requestNotSent: true;
	inputPayloadBytes: number; inputUpperCny: number;
	outputAllowanceTokens: number; minimumOutputTokens: 1; requestedOutputTokens: number;
	outputAccountingMarginTokens: number; marginUpperCny: number;
	availableCny: number; requiredAtMinimumOutputCny: number;
	globalMaxCny: number; committedBeforeCny: number;
	settledProviderRequestCount: number;
	pricingBasis: { source: "higher-of-configured-and-sdk-estimates" | "native-cny-peak-and-normalized-sdk-quotes";
		inputCnyPerMillionTokens: number; outputCnyPerMillionTokens: number };
}

export class DeepSeekCampaignBudget {
	readonly limits: Readonly<DeepSeekCampaignLimits>;
	private rates: { input: number; cacheRead: number; output: number };
	private readonly pricingProfile?: NativeCnyPricingProfile;
	private readonly outputProfile: DeepSeekProviderOutputLimit;
	private readonly outputBoundTokens: number;
	private reservations = 0;
	private grossReservedCny = 0;
	private settledCny = 0;
	private inFlightReservedCny = 0;
	private unknownReservedCny = 0;
	private readonly leases = new WeakMap<PromptLease, LeaseState>();
	private readonly promptKeys = new Set<string>();
	private readonly activeSessions = new Set<string>();
	private readonly requestIds = new Set<string>();
	private readonly usageEntryIds = new Set<string>();
	private readonly auditRequests: RequestState[] = [];
	private readonly admissionRejections: CampaignAdmissionRejection[] = [];
	private activePrompts = 0;
	private stopped = false;
	private stopReason?: "payload-boundary" | "usage-reconciliation" | "prompt-failure" | "output-limit";

	constructor(limits: DeepSeekCampaignLimits) {
		if (!/^deepseek\/[^/]+(?::(?:off|minimal|low|medium|high|max))?$/.test(limits.model) || limits.endpoint !== "https://api.deepseek.com" ||
			(limits.accountingMode !== undefined && limits.accountingMode !== "accounting-only") ||
			(limits.priorCommittedCny !== undefined && (!Number.isFinite(limits.priorCommittedCny) || limits.priorCommittedCny < 0)) ||
			!isVerifiedDeepSeekProviderOutputLimit(limits.providerOutputLimit) ||
			limits.providerOutputLimit.endpoint !== limits.endpoint ||
			limits.model.slice("deepseek/".length).split(":")[0] !== limits.providerOutputLimit.model ||
			(limits.maxInputPayloadBytes !== undefined && !count(limits.maxInputPayloadBytes)) ||
			!Number.isSafeInteger(limits.outputAccountingMarginTokens) || limits.outputAccountingMarginTokens < 0) {
			throw new HarnessError("runner.campaign", "invalid DeepSeek campaign limits");
		}
		const { maxProviderCalls: _retiredCalls, maxProviderCallsPerPrompt: _retiredPromptCalls,
			maxOutputTokens: _retiredOutputCap, ...activeLimits } = limits;
		this.limits = Object.freeze(activeLimits);
		this.pricingProfile = limits.nativeCnyPricing &&
			isVerifiedNativeCnyPricingProfile(limits.nativeCnyPricing) &&
			/^deepseek\/deepseek-flash(?::(?:off|minimal|low|medium|high|max))?$/.test(limits.model) &&
			limits.providerOutputLimit.modelVersion === limits.nativeCnyPricing.modelVersion
			? limits.nativeCnyPricing : undefined;
		this.outputProfile = limits.providerOutputLimit;
		this.outputBoundTokens = limits.providerOutputLimit.maxOutputTokens;
		// A once-verified profile can expire while research is running. Its expiry
		// makes later CNY observations unknown; it does not block transport.
		this.rates = { input: this.pricingProfile?.rates.inputMiss ?? 0,
			cacheRead: this.pricingProfile?.rates.cacheRead ?? 0,
			output: this.pricingProfile?.rates.output ?? 0 };
	}

	private nativePricingCurrent(): boolean {
		if (!this.pricingProfile) return false;
		try { assertNativeCnyPricingCurrent(this.pricingProfile); return true; }
		catch { return false; }
	}

	/** A price that expired while a request was still open cannot quantify it.
	 * An already disposed unknown or settled observation is historical and must
	 * never be rewritten merely because the clock later passed the cutoff.
	 */
	private expireUnsettledRequestPrice(request: RequestState): void {
		if (!request.nativeCnyVerified || request.status !== "reserved" || this.nativePricingCurrent()) return;
		request.nativeCnyVerified = false;
		request.worstCny = 0;
		request.rates = { input: 0, cacheRead: 0, output: 0 };
		this.grossReservedCny = this.auditRequests.reduce((sum, row) => sum + row.worstCny, 0);
		this.recountCommitments();
	}

	get strictRequest(): NonNullable<SessionSpec["strictRequest"]> {
		return {
			maxOutputTokens: this.outputBoundTokens,
			...(this.limits.maxInputPayloadBytes === undefined ? {} : { maxInputPayloadBytes: this.limits.maxInputPayloadBytes }),
		};
	}

	boundSpec(spec: SessionSpec): SessionSpec {
		if (spec.model !== this.limits.model ||
			(spec.strictRequest !== undefined && JSON.stringify(spec.strictRequest) !== JSON.stringify(this.strictRequest))) {
			throw new HarnessError("runner.campaign", "session model or request caps differ from the campaign");
		}
		// Native execution tools share the host UID. Bash can make unmetered network
		// calls; native file tools also accept paths outside their cwd. A campaign
		// must supply purpose-built confined custom tools instead.
		if (spec.tools.kind === "execution") throw new HarnessError("runner.campaign", "native execution tools are unsafe for a metered campaign; supply confined custom tools");
		const toolAuthority = spec.tools.kind === "custom" ? getConfinedCampaignFileGrantDescriptor(spec.tools.tools) : undefined;
		if (spec.tools.kind === "custom" && !toolAuthority) throw new HarnessError("runner.campaign", "campaign custom tools must be the audited confined file grant");
		if (spec.tools.kind === "read-dir" && spec.tools.extraTools?.length) throw new HarnessError("runner.campaign", "campaign read-dir cannot include arbitrary extra tools");
		// Take our own immutable grant snapshot so a caller cannot swap closures
		// while buildHandle awaits filesystem or SDK setup.
		const tools = spec.tools.kind === "custom"
			? Object.freeze({ kind: "custom" as const, tools: Object.freeze([...spec.tools.tools]) })
			: spec.tools.kind === "read-dir"
				? Object.freeze({ kind: "read-dir" as const, root: spec.tools.root, ...(spec.tools.toolName ? { toolName: spec.tools.toolName } : {}) })
				: Object.freeze({ kind: "none" as const });
		const { toolAuthority: _untrustedAuthority, ...withoutUntrustedAuthority } = spec;
		return { ...withoutUntrustedAuthority, tools: tools as SessionSpec["tools"], ...(toolAuthority ? { toolAuthority: { ...toolAuthority, writableFiles: [...toolAuthority.writableFiles] } } : {}), strictRequest: this.strictRequest };
	}

	assertResolved(model: { provider: string; id: string; api: string; baseUrl: string; maxTokens: number;
		contextWindow?: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number;
			tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> } }): void {
		const modelId = this.limits.model.slice("deepseek/".length).split(":")[0];
		if (model.provider !== "deepseek" || model.id !== modelId || model.api !== "openai-completions" ||
			model.baseUrl !== this.limits.endpoint || this.outputBoundTokens > model.maxTokens ||
			(model.maxTokens !== this.outputProfile.maxOutputTokens ||
				model.contextWindow !== this.outputProfile.contextWindow)) {
			throw new HarnessError("runner.campaign", "DeepSeek model, endpoint or provider output limit did not verify");
		}
	}

	beginPrompt(sessionId: string, promptId: string): PromptLease {
		if (this.stopped) throw new HarnessError("runner.campaign", "campaign is stopped");
		if (!sessionId || !promptId || typeof sessionId !== "string" || typeof promptId !== "string") {
			this.stop("prompt-failure");
			throw new HarnessError("runner.campaign", "campaign prompt ownership is unavailable");
		}
		const key = JSON.stringify([sessionId, promptId]);
		if (this.promptKeys.has(key) || this.activeSessions.has(sessionId)) {
			this.stop("prompt-failure");
			throw new HarnessError("runner.campaign", "campaign prompt ownership is duplicated");
		}
		const lease = Object.freeze({ sessionId, promptId });
		this.leases.set(lease, { requests: [], active: true });
		this.promptKeys.add(key);
		this.activeSessions.add(sessionId);
		this.activePrompts++;
		return lease;
	}

	/** Host-only proof of whether this exact prompt leased any provider request. */
	requestCount(lease: PromptLease): number {
		const state = this.leases.get(lease);
		if (!state) throw new HarnessError("runner.campaign", "prompt lease is unavailable");
		return state.requests.length;
	}

	/** Estimated upper exposure for this request when a native price profile is valid; observation only. */
	private worstCny(payloadBytes: number, maxOutputTokens: number): number {
		return (payloadBytes * Math.max(this.rates.input, this.rates.cacheRead) +
			(maxOutputTokens + this.limits.outputAccountingMarginTokens) * this.rates.output) / 1_000_000;
	}

	/** Called synchronously by onPayload, before the HTTP request can begin. */
	reserve(lease: PromptLease, payloadBytes: number, providerRequestId: string, maxOutputTokens = this.outputBoundTokens): void {
		const state = this.leases.get(lease);
		if (!state?.active || this.stopped || !count(payloadBytes) || !count(maxOutputTokens) ||
			maxOutputTokens !== this.outputBoundTokens || typeof providerRequestId !== "string" || !providerRequestId) {
			this.stop("payload-boundary");
			throw new HarnessError("runner.campaign", "provider payload byte count is unavailable");
		}
		// Reusing an ID must never authorize another transport attempt for free.
		if (this.requestIds.has(providerRequestId)) {
			this.stop("payload-boundary");
			throw new HarnessError("runner.campaign", "provider request ID was already reserved");
		}
		const next = this.reservations + 1;
		const projectedCny = this.worstCny(payloadBytes, maxOutputTokens);
		const priceFinite = Number.isFinite(projectedCny) && projectedCny >= 0;
		const nativeCnyVerified = priceFinite && this.nativePricingCurrent();
		const worstCny = nativeCnyVerified ? projectedCny : 0;
		this.reservations = next;
		this.grossReservedCny += worstCny;
		this.inFlightReservedCny += worstCny;
		this.requestIds.add(providerRequestId);
		const request = { id: providerRequestId, sessionId: lease.sessionId, responseReceived: false,
			inputPayloadBytes: payloadBytes, maxOutputTokens, worstCny,
			nativeCnyVerified,
			rates: nativeCnyVerified ? { ...this.rates } : { input: 0, cacheRead: 0, output: 0 },
			status: "reserved" as const };
		state.requests.push(request);
		this.auditRequests.push(request);
	}

	/** A received length response is incomplete, even when every provider charge is settled. */
	certifySettledTerminalResponse(lease: PromptLease, effectScope: HostEffectScope | undefined): HarnessError | undefined {
		const state = this.leases.get(lease);
		if (!effectScope || !state?.active || !state.terminalLengthRequestId || state.requests.length === 0 ||
			state.requests.at(-1)?.id !== state.terminalLengthRequestId ||
			state.requests.some((request) => !request.responseReceived)) return undefined;
		return certifySettledTerminalResponse({ settledProviderRequestCount: state.requests.length,
			responseReceived: true, terminalStopReason: "length", taskComplete: false, effectScope },
			"provider length response received and settled; research task remains incomplete");
	}

	private committedCny(): number { return (this.limits.priorCommittedCny ?? 0) + this.settledCny + this.inFlightReservedCny + this.unknownReservedCny; }
	/** Recompute from retained request facts: subtracting floating reservations can
	 * otherwise leave a negative epsilon after the last in-flight request settles.
	 */
	private recountCommitments(): void {
		this.settledCny = 0; this.inFlightReservedCny = 0; this.unknownReservedCny = 0;
		for (const request of this.auditRequests) {
			if (request.status === "reserved") this.inFlightReservedCny += request.worstCny;
			else if (request.status === "settled") this.settledCny += request.settledCny!;
			else this.unknownReservedCny += request.unknownHeldCny!;
		}
	}

	private reportFingerprint(event: UsageEvent): string {
		return JSON.stringify([event.provider, event.model, event.stopReason, event.status, event.costStatus,
			event.usage?.input, event.usage?.output, event.usage?.cacheRead, event.usage?.cacheWrite,
			event.usage?.totalTokens, event.usage?.cost]);
	}

	/** Settle one authoritative provider response before allowing another tool-loop request. */
	settleReported(lease: PromptLease, requestId: string, event: UsageEvent): void {
		const state = this.leases.get(lease);
		const request = state?.requests.find((item) => item.id === requestId);
		if (!state?.active || !request) {
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage has no active reserved request");
		}
		const fingerprint = this.reportFingerprint(event);
		const usage = event.usage;
		if (request.status === "unknown") {
			if (request.reportFingerprint === fingerprint) return;
			request.responseReceived = false;
			this.markUnknown(request, true);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage conflicts with an earlier settlement");
		}
		if (request.status === "settled") {
			if (request.reportFingerprint === fingerprint) return;
			request.responseReceived = false;
			this.markUnknown(request, true);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage conflicts with an earlier settlement");
		}
		this.expireUnsettledRequestPrice(request);
		if (usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
			.every(value => Number.isSafeInteger(value) && value! >= 0)) request.reportedUsage = {
			input: usage.input!, output: usage.output!, cacheRead: usage.cacheRead!,
			cacheWrite: usage.cacheWrite!, totalTokens: usage.totalTokens!,
			reportedUsdCost: Number.isFinite(usage.cost) && usage.cost! >= 0 ? usage.cost! : null,
			costStatus: typeof event.costStatus === "string" && event.costStatus.length <= 32
				? event.costStatus : null,
		};
		const input = (usage?.input ?? NaN) + (usage?.cacheRead ?? NaN) + (usage?.cacheWrite ?? NaN);
		const charge = (((usage?.input ?? NaN) + (usage?.cacheWrite ?? NaN)) * request.rates.input +
			(usage?.cacheRead ?? NaN) * request.rates.cacheRead +
			(usage?.output ?? NaN) * request.rates.output) / 1_000_000;
		if (event.kind !== "assistant" ||
			event.provider !== "deepseek" || event.model !== this.limits.model.slice("deepseek/".length).split(":")[0]) {
			this.markUnknown(request);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider identity differs from the verified DeepSeek transport");
		}
		if (!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
			.every((value) => Number.isSafeInteger(value) && value! >= 0) ||
			usage.totalTokens !== input + usage.output! || input <= 0 || usage.output! <= 0 ||
			input > request.inputPayloadBytes || usage.output! > request.maxOutputTokens + this.limits.outputAccountingMarginTokens ||
			!(["stop", "toolUse", "length"] as Array<string | undefined>).includes(event.stopReason)) {
			// Unreliable fee usage is retained as unknown; it cannot revoke future
			// transport authority or turn an uncertain charge into a free one.
			this.markUnknown(request);
			request.reportFingerprint = fingerprint;
			throw new HarnessError("runner.campaign.usage-unknown", "provider usage or call outcome is inconsistent");
		}
		// An unverifiable currency is an unknown fee observation, never a
		// zero-cost charge and never a reason to refuse later work.
		request.responseReceived = event.status === "reported";
		if (!request.nativeCnyVerified || event.status !== "reported" || !Number.isFinite(charge)) {
			this.markUnknown(request, false, 0);
		} else {
			request.status = "settled";
			request.settledCny = charge;
			this.recountCommitments();
		}
		request.reportFingerprint = fingerprint;
	}

	/** A known length response is charged at its reported bound, but cannot authorize another request. */
	stopAfterTerminalLength(lease: PromptLease, requestId: string, event: UsageEvent): void {
		if (event.stopReason !== "length") throw new HarnessError("runner.campaign", "terminal length stop requires a length response");
		this.settleReported(lease, requestId, event);
		const state = this.leases.get(lease);
		if (state?.active && state.requests.at(-1)?.id === requestId &&
			state.requests.every((request) => request.responseReceived)) {
			state.terminalLengthRequestId = requestId;
		}
	}

	private markUnknown(request: RequestState, includeSettled = false, additionalEstimateCny = 0): void {
		this.expireUnsettledRequestPrice(request);
		const conservativeUnknownCny = Math.max(request.worstCny, request.settledCny ?? 0,
			request.unknownHeldCny ?? 0, additionalEstimateCny);
		if (request.status === "settled") {
			if (!includeSettled) return;
		}
		request.status = "unknown";
		request.unknownHeldCny = conservativeUnknownCny;
		delete request.settledCny;
		delete request.reportFingerprint;
		this.recountCommitments();
	}

	finishPrompt(lease: PromptLease, receipts: readonly PromptUsageReceipt[]): void {
		const state = this.leases.get(lease);
		try {
			if (!state?.active) throw new HarnessError("runner.campaign", "campaign prompt lease is invalid or already finished");
			if (receipts.length !== state.requests.length || receipts.length === 0 ||
				new Set(receipts.map(({ event }) => event.entryId)).size !== receipts.length ||
				receipts.some(({ requestId, event }, index) => requestId !== state.requests[index].id ||
					this.usageEntryIds.has(event.entryId) || !event.entryId)) {
				throw new HarnessError("runner.campaign", "provider usage or call outcome is incomplete or exceeds the campaign reserve");
			}
			for (const { requestId, event } of receipts) this.settleReported(lease, requestId, event);
			if (receipts.some(({ event }) => event.stopReason !== "stop" && event.stopReason !== "toolUse")) {
				throw new HarnessError("runner.campaign", "provider usage or call outcome is incomplete or exceeds the campaign reserve");
			}
			for (const { event } of receipts) this.usageEntryIds.add(event.entryId);
		} catch (error) {
			if (!(error instanceof HarnessError && error.code === "runner.campaign.usage-unknown"))
				this.stop("usage-reconciliation");
			throw error;
		} finally {
			if (state?.active) {
				for (const request of state.requests) this.markUnknown(request);
				this.release(lease, state);
			}
		}
	}

	failPrompt(lease: PromptLease): void {
		const state = this.leases.get(lease);
		if (state?.active) {
			for (const request of state.requests) this.markUnknown(request);
			this.release(lease, state);
		}
	}

	private stop(reason: NonNullable<DeepSeekCampaignBudget["stopReason"]>): void {
		this.stopped = true;
		this.stopReason ??= reason;
	}

	private release(lease: PromptLease, state: LeaseState): void {
		state.active = false;
		this.activeSessions.delete(lease.sessionId);
		this.activePrompts--;
	}

	/** Prior, current, and mission commitments are distinct: only the mission total controls admission.
	 * settled/inFlight/unknown and grossReserved describe this process only; prior status is not inferred.
	 */
	snapshot(): { accountingMode: "observed-only"; unpricedRequestCount: number; reservedCny: number; grossReservedCny: number; priorCommittedCny: number; currentCommittedCny: number; missionCommittedCny: number; committedCny: number; settledCny: number; inFlightReservedCny: number; unknownReservedCny: number; reservations: number; stopped: boolean; active: boolean; activePrompts: number; stopReason?: string; admissionRejection?: { decision: LocalAdmissionDecision; requestNotSent: true }; pricingProfile?: NativeCnyPricingProfile; providerOutputLimit?: DeepSeekProviderOutputLimit } {
		return { reservedCny: this.grossReservedCny, grossReservedCny: this.grossReservedCny,
			accountingMode: "observed-only", unpricedRequestCount: this.auditRequests.filter((r) => !r.nativeCnyVerified).length,
			priorCommittedCny: this.limits.priorCommittedCny ?? 0,
			currentCommittedCny: this.settledCny + this.inFlightReservedCny + this.unknownReservedCny,
			missionCommittedCny: this.committedCny(),
			committedCny: this.committedCny(), settledCny: this.settledCny,
			inFlightReservedCny: this.inFlightReservedCny, unknownReservedCny: this.unknownReservedCny,
			reservations: this.reservations, stopped: this.stopped, active: this.activePrompts > 0,
			activePrompts: this.activePrompts,
			...(this.stopReason ? { stopReason: this.stopReason } : {}),
			...(this.pricingProfile ? { pricingProfile: nativeCnyPricingRecord(this.pricingProfile) } : {}),
			providerOutputLimit: providerOutputLimitRecord(this.outputProfile),
			...(this.admissionRejections.at(-1) ? { admissionRejection: { decision: this.admissionRejections.at(-1)!.decision,
				requestNotSent: true as const } } : {}) };
	}

	/** Read-only per-transport accounting; intended solely for the encrypted host carry. */
	requestAuditSnapshot(): { requests: CampaignRequestAudit[]; settledCny: number;
		unknownReservedCny: number; inFlightReservedCny: number; reservations: number;
		admissionRejections: CampaignAdmissionRejection[]; pricingProfile?: NativeCnyPricingProfile;
		providerOutputLimit?: DeepSeekProviderOutputLimit } {
		return { requests: this.auditRequests.map(request => ({
			requestId: request.id, inputPayloadBytes: request.inputPayloadBytes,
			maxOutputTokens: request.maxOutputTokens,
			admissionDecision: "provider-maximum" as const,
			reservedCny: request.worstCny, status: request.status,
			settledCny: request.settledCny ?? null,
			unknownHeldCny: request.unknownHeldCny ?? null,
			reportedUsage: request.reportedUsage ? { ...request.reportedUsage } : null,
		})), settledCny: this.settledCny, unknownReservedCny: this.unknownReservedCny,
			inFlightReservedCny: this.inFlightReservedCny, reservations: this.reservations,
			admissionRejections: this.admissionRejections.map(row => ({ ...row, pricingBasis: { ...row.pricingBasis } })),
			...(this.pricingProfile ? { pricingProfile: nativeCnyPricingRecord(this.pricingProfile) } : {}),
			providerOutputLimit: providerOutputLimitRecord(this.outputProfile) };
	}

	/** New-run observations. Null CNY means currency/pricing could not be verified. */
	requestAccountingAuditSnapshot(): {
		version: 3; kind: "accounting-only-request-audit";
		requests: Array<{ requestId: string; sessionId: string; responseReceived: boolean;
			inputPayloadBytes: number; maxOutputTokens: number;
			status: "settled" | "unknown" | "in-flight"; settledCny: number | null;
			unknownObservedCny: number | null; reportedUsage: NonNullable<RequestState["reportedUsage"]> | null }>;
		settledCny: number; unknownObservedCny: number; unpricedRequestCount: number;
		pricingProfile?: NativeCnyPricingProfile;
	} {
		const requests = this.auditRequests.map((request) => ({
			requestId: request.id, sessionId: campaignSessionEffectId(request.sessionId),
			responseReceived: request.responseReceived,
			inputPayloadBytes: request.inputPayloadBytes,
			maxOutputTokens: request.maxOutputTokens,
			status: request.status === "reserved" ? "in-flight" as const : request.status,
			settledCny: request.nativeCnyVerified && request.status === "settled" ? request.settledCny ?? null : null,
			unknownObservedCny: request.nativeCnyVerified && request.status !== "settled"
				? request.unknownHeldCny ?? request.worstCny : null,
			reportedUsage: request.reportedUsage ? { ...request.reportedUsage } : null,
		}));
		return { version: 3, kind: "accounting-only-request-audit", requests,
			settledCny: requests.reduce((sum, row) => sum + (row.settledCny ?? 0), 0),
			unknownObservedCny: requests.reduce((sum, row) => sum + (row.unknownObservedCny ?? 0), 0),
			unpricedRequestCount: requests.filter((row) => row.settledCny === null && row.unknownObservedCny === null).length,
			...(this.pricingProfile && this.auditRequests.some((r) => r.nativeCnyVerified)
				? { pricingProfile: nativeCnyPricingRecord(this.pricingProfile) } : {}) };
	}
}
