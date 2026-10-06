import { HarnessError } from "../types.ts";
import type { SessionSpec, UsageEvent } from "./types.ts";
import { getConfinedCampaignFileGrantDescriptor } from "./confined-campaign-files.ts";
import { certifyLocalNotIssued, certifySettledLocalAdmissionStop, certifySettledTerminalResponse } from "./operation-disposition.ts";
import type { HostEffectScope, LocalAdmissionDecision } from "./operation-disposition.ts";
import { DEEPSEEK_FLASH_PUBLISHED_USD_TO_CNY_QUOTE_RATIO, assertNativeCnyPricingCurrent,
	isVerifiedNativeCnyPricingProfile,
	nativeCnyPricingRecord, type NativeCnyPricingProfile } from "./deepseek-cny-pricing.ts";
import { isVerifiedDeepSeekProviderOutputLimit, providerOutputLimitRecord,
	type DeepSeekProviderOutputLimit } from "./deepseek-provider-limits.ts";
export { isSettledLocalAdmissionStop as isSettledLocalCampaignBudgetStop,
	settledLocalAdmissionStopDetails as settledLocalCampaignBudgetStopDetails } from "./operation-disposition.ts";

/**
 * In-process accounting for one DeepSeek research attempt under a global total.
 * The caller must carry all earlier attempts' settled and unknown commitments in
 * priorCommittedCny. Unknown reservations are never refunded: a timeout or lost
 * response may still be billed. Estimates are not provider invoices. This class
 * is neither a cross-process lock nor a persistent accounting ledger.
 */
export interface DeepSeekCampaignLimits {
	model: string;
	endpoint: "https://api.deepseek.com";
	/** The single overall campaign ceiling, including every earlier attempt. */
	maxCny: number;
	/** Trusted conservative commitments from earlier processes, never model-supplied. */
	priorCommittedCny: number;
	/** Retired historical input fields; accepted for record compatibility, never enforced. */
	maxProviderCalls?: number;
	maxProviderCallsPerPrompt?: number;
	maxOutputTokens?: number;
	/** Required live server-reported maximum, never selected to fit available money. */
	providerOutputLimit: DeepSeekProviderOutputLimit;
	/** Optional serialized request byte boundary for a fixed-size public input. */
	maxInputPayloadBytes?: number;
	outputAccountingMarginTokens: number;
	/** Planning estimates for the global total, dynamically raised if SDK model rates are higher. */
	estimatedInputCnyPerMillionTokens: number;
	estimatedCacheReadCnyPerMillionTokens?: number;
	estimatedOutputCnyPerMillionTokens: number;
	/** Legacy USD estimate conversion only; forbidden with a native CNY profile. */
	estimatedCnyPerUsd?: number;
	/** A live host-verified CNY billing profile for new requests; never inherited from old carries. */
	nativeCnyPricing?: NativeCnyPricingProfile;
}

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
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
	localRejectionReason?: "total-cny-ceiling" | "provider-call-limit";
	localAdmissionRejection?: CampaignAdmissionRejection;
	terminalLengthRequestId?: string;
}

interface RequestState {
	readonly id: string;
	readonly inputPayloadBytes: number;
	readonly maxOutputTokens: number;
	readonly worstCny: number;
	readonly rates: { input: number; cacheRead: number; output: number };
	status: "reserved" | "settled" | "unknown";
	settledCny?: number;
	unknownHeldCny?: number;
	reportedUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number;
		totalTokens: number; reportedUsdCost: number | null; costStatus: string | null };
	reportFingerprint?: string;
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
	private readonly usdEstimateToCnyQuote: number;
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
	private stopReason?: "payload-boundary" | "total-cny-ceiling" | "provider-call-limit" | "price-assumption-invalid" | "usage-reconciliation" | "prompt-failure" | "output-limit";

	constructor(limits: DeepSeekCampaignLimits) {
		if (!/^deepseek\/[^/]+(?::(?:off|minimal|low|medium|high|max))?$/.test(limits.model) || limits.endpoint !== "https://api.deepseek.com" ||
			!positive(limits.maxCny) || !Number.isFinite(limits.priorCommittedCny) || limits.priorCommittedCny < 0 ||
			!isVerifiedDeepSeekProviderOutputLimit(limits.providerOutputLimit) ||
			limits.providerOutputLimit.endpoint !== limits.endpoint ||
			limits.model.slice("deepseek/".length).split(":")[0] !== limits.providerOutputLimit.model ||
			(limits.maxInputPayloadBytes !== undefined && !count(limits.maxInputPayloadBytes)) ||
			(limits.nativeCnyPricing !== undefined &&
				limits.providerOutputLimit.modelVersion !== limits.nativeCnyPricing.modelVersion) ||
			!Number.isSafeInteger(limits.outputAccountingMarginTokens) || limits.outputAccountingMarginTokens < 0 ||
			!positive(limits.estimatedInputCnyPerMillionTokens) ||
			(limits.estimatedCacheReadCnyPerMillionTokens !== undefined && !positive(limits.estimatedCacheReadCnyPerMillionTokens)) ||
			!positive(limits.estimatedOutputCnyPerMillionTokens) ||
			(limits.nativeCnyPricing ?
				(!isVerifiedNativeCnyPricingProfile(limits.nativeCnyPricing) ||
					!/^deepseek\/deepseek-flash(?::(?:off|minimal|low|medium|high|max))?$/.test(limits.model) ||
					limits.estimatedCnyPerUsd !== undefined ||
					limits.estimatedInputCnyPerMillionTokens !== limits.nativeCnyPricing.rates.inputMiss ||
					limits.estimatedCacheReadCnyPerMillionTokens !== limits.nativeCnyPricing.rates.cacheRead ||
					limits.estimatedOutputCnyPerMillionTokens !== limits.nativeCnyPricing.rates.output) :
				!positive(limits.estimatedCnyPerUsd ?? NaN))) {
			throw new HarnessError("runner.campaign", "invalid DeepSeek campaign limits");
		}
		const { maxProviderCalls: _retiredCalls, maxProviderCallsPerPrompt: _retiredPromptCalls,
			maxOutputTokens: _retiredOutputCap, ...activeLimits } = limits;
		this.limits = Object.freeze(activeLimits);
		this.pricingProfile = limits.nativeCnyPricing;
		this.outputProfile = limits.providerOutputLimit;
		this.outputBoundTokens = limits.providerOutputLimit.maxOutputTokens;
		if (this.pricingProfile) assertNativeCnyPricingCurrent(this.pricingProfile);
		this.usdEstimateToCnyQuote = limits.nativeCnyPricing ?
			DEEPSEEK_FLASH_PUBLISHED_USD_TO_CNY_QUOTE_RATIO : limits.estimatedCnyPerUsd!;
		this.rates = { input: limits.estimatedInputCnyPerMillionTokens,
			cacheRead: limits.estimatedCacheReadCnyPerMillionTokens ?? limits.estimatedInputCnyPerMillionTokens,
			output: limits.estimatedOutputCnyPerMillionTokens };
	}

	private requireCurrentPricing(): void {
		if (!this.pricingProfile) return;
		try { assertNativeCnyPricingCurrent(this.pricingProfile); }
		catch (error) { this.stop("price-assumption-invalid"); throw error; }
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
		this.requireCurrentPricing();
		const modelId = this.limits.model.slice("deepseek/".length).split(":")[0];
		const rates = [model.cost, ...(model.cost.tiers ?? [])];
		if (model.provider !== "deepseek" || model.id !== modelId || model.api !== "openai-completions" ||
			model.baseUrl !== this.limits.endpoint || this.outputBoundTokens > model.maxTokens ||
			(model.maxTokens !== this.outputProfile.maxOutputTokens ||
				model.contextWindow !== this.outputProfile.contextWindow) ||
			rates.some((rate) => [rate.input, rate.cacheWrite, rate.cacheRead, rate.output].some((v) => !Number.isFinite(v) || v < 0)) ||
			model.cost.input <= 0 || model.cost.output <= 0) {
			throw new HarnessError("runner.campaign", "DeepSeek model, endpoint or pricing data did not verify");
		}
		// Higher model rates consume more of the same global total; they are not a
		// separate reason to reject an otherwise affordable request.
		this.rates = {
			input: Math.max(this.rates.input, ...rates.map((rate) => Math.max(rate.input, rate.cacheWrite) * this.usdEstimateToCnyQuote)),
			cacheRead: Math.max(this.rates.cacheRead, ...rates.map((rate) => rate.cacheRead * this.usdEstimateToCnyQuote)),
			output: Math.max(this.rates.output, ...rates.map((rate) => rate.output * this.usdEstimateToCnyQuote)),
		};
	}

	beginPrompt(sessionId: string, promptId: string): PromptLease {
		this.requireCurrentPricing();
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

	/** Largest cap this exact serialized payload can afford, including the margin and all prior holds. */
	affordableOutputTokens(payloadBytes: number): number {
		if (!count(payloadBytes)) throw new HarnessError("runner.campaign", "provider payload byte count is unavailable");
		const available = this.limits.maxCny - this.committedCny();
		const inputCny = payloadBytes * Math.max(this.rates.input, this.rates.cacheRead) / 1_000_000;
		const marginCny = this.limits.outputAccountingMarginTokens * this.rates.output / 1_000_000;
		const raw = Math.floor((available - inputCny - marginCny) * 1_000_000 / this.rates.output);
		let cap = Math.min(this.outputBoundTokens, Math.max(0, raw));
		// A decimal rounding edge may make the floor one token too high. Admission
		// also accounts for the encrypted carry's upward nanocurrency rounding.
		while (cap > 0 && !this.withinCeiling(this.worstCny(payloadBytes, cap))) cap--;
		return cap;
	}

	private withinCeiling(nextCny: number): boolean {
		const nano = (amount: number): number => Math.ceil(amount * 1_000_000_000);
		const pieces = [this.limits.priorCommittedCny, this.settledCny, this.inFlightReservedCny,
			this.unknownReservedCny, nextCny].map(nano);
		return pieces.every(Number.isSafeInteger) && Number.isSafeInteger(nano(this.limits.maxCny)) &&
			pieces.reduce((sum, amount) => sum + amount, 0) <= nano(this.limits.maxCny) &&
			this.committedCny() + nextCny <= this.limits.maxCny;
	}

	private worstCny(payloadBytes: number, maxOutputTokens: number): number {
		return (payloadBytes * Math.max(this.rates.input, this.rates.cacheRead) +
			(maxOutputTokens + this.limits.outputAccountingMarginTokens) * this.rates.output) / 1_000_000;
	}

	private recordAdmissionRejection(state: LeaseState, payloadBytes: number,
		requestedOutputTokens: number, decision: LocalAdmissionDecision): void {
		const inputRate = Math.max(this.rates.input, this.rates.cacheRead);
		const diagnostic: CampaignAdmissionRejection = Object.freeze({
			version: 1, kind: "campaign-admission-rejection", decision, requestNotSent: true,
			inputPayloadBytes: payloadBytes, inputUpperCny: payloadBytes * inputRate / 1_000_000,
			outputAllowanceTokens: this.affordableOutputTokens(payloadBytes), minimumOutputTokens: 1,
			requestedOutputTokens, outputAccountingMarginTokens: this.limits.outputAccountingMarginTokens,
			marginUpperCny: this.limits.outputAccountingMarginTokens * this.rates.output / 1_000_000,
			availableCny: this.limits.maxCny - this.committedCny(),
			requiredAtMinimumOutputCny: this.worstCny(payloadBytes, 1),
			globalMaxCny: this.limits.maxCny, committedBeforeCny: this.committedCny(),
			settledProviderRequestCount: state.requests.filter((request) => request.status === "settled").length,
			pricingBasis: Object.freeze({ source: this.pricingProfile ?
				"native-cny-peak-and-normalized-sdk-quotes" : "higher-of-configured-and-sdk-estimates",
				inputCnyPerMillionTokens: inputRate, outputCnyPerMillionTokens: this.rates.output }),
		});
		state.localAdmissionRejection = diagnostic;
		this.admissionRejections.push(diagnostic);
	}

	/** Called synchronously by onPayload, before the HTTP request can begin. */
	reserve(lease: PromptLease, payloadBytes: number, providerRequestId: string, maxOutputTokens = this.outputBoundTokens): void {
		this.requireCurrentPricing();
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
		const worstCny = this.worstCny(payloadBytes, maxOutputTokens);
		if (!Number.isFinite(worstCny) || !this.withinCeiling(worstCny)) {
			state.localRejectionReason = "total-cny-ceiling";
			const inputUpperCny = payloadBytes * Math.max(this.rates.input, this.rates.cacheRead) / 1_000_000;
			const decision: LocalAdmissionDecision = inputUpperCny > this.limits.maxCny - this.committedCny()
				? "input-unaffordable" : this.affordableOutputTokens(payloadBytes) < 1
					? "minimum-output-unaffordable" : "provider-maximum-unaffordable";
			this.recordAdmissionRejection(state, payloadBytes, maxOutputTokens, decision);
			this.stop("total-cny-ceiling");
			throw new HarnessError("runner.campaign", "campaign global CNY total exhausted");
		}
		this.reservations = next;
		this.grossReservedCny += worstCny;
		this.inFlightReservedCny += worstCny;
		this.requestIds.add(providerRequestId);
		const request = { id: providerRequestId, inputPayloadBytes: payloadBytes, maxOutputTokens, worstCny,
			rates: { ...this.rates }, status: "reserved" as const };
		state.requests.push(request);
		this.auditRequests.push(request);
	}

	/** Certified only for an unsent first request in a live prompt and safe tool scope. */
	certifyLocalNotIssued(lease: PromptLease, effectScope: HostEffectScope | undefined): HarnessError | undefined {
		const state = this.leases.get(lease);
		if (!effectScope || !state?.active || !state.localRejectionReason ||
			state.requests.length !== 0 || !state.localAdmissionRejection?.requestNotSent) return undefined;
		return certifyLocalNotIssued({ settledProviderRequestCount: 0, requestNotSent: true,
			stopReason: state.localRejectionReason,
			admissionDecision: state.localAdmissionRejection.decision, effectScope },
			`${state.localRejectionReason === "total-cny-ceiling" ? "campaign global CNY total exhausted" : "campaign provider call limit exhausted"} before first transport; prompt not issued`);
	}

	/** Evidence is limited to this live lease; no caller-created status can certify it. */
	certifySettledLocalBudgetStop(lease: PromptLease, effectScope: HostEffectScope | undefined): HarnessError | undefined {
		const state = this.leases.get(lease);
		if (!effectScope || !state?.active || !state.localRejectionReason || state.requests.length === 0 ||
			state.requests.some((request) => request.status !== "settled")) return undefined;
		return certifySettledLocalAdmissionStop({ settledProviderRequestCount: state.requests.length,
			rejectedBeforeTransport: true, stopReason: state.localRejectionReason, effectScope },
			`${state.localRejectionReason === "total-cny-ceiling" ? "campaign global CNY total exhausted" : "campaign provider call limit exhausted"} after settled provider requests; next request was rejected before transport`);
	}

	/** A received length response is incomplete, even when every provider charge is settled. */
	certifySettledTerminalResponse(lease: PromptLease, effectScope: HostEffectScope | undefined): HarnessError | undefined {
		const state = this.leases.get(lease);
		if (!effectScope || !state?.active || !state.terminalLengthRequestId || state.requests.length === 0 ||
			state.requests.at(-1)?.id !== state.terminalLengthRequestId ||
			state.requests.some((request) => request.status !== "settled")) return undefined;
		return certifySettledTerminalResponse({ settledProviderRequestCount: state.requests.length,
			responseReceived: true, terminalStopReason: "length", taskComplete: false, effectScope },
			"provider length response received and settled; research task remains incomplete");
	}

	private committedCny(): number { return this.limits.priorCommittedCny + this.settledCny + this.inFlightReservedCny + this.unknownReservedCny; }
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
		const observedEstimateCny = typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
			? Math.min(Number.MAX_VALUE, usage.cost * this.usdEstimateToCnyQuote) : 0;
		if (request.status === "unknown") {
			if (request.reportFingerprint === fingerprint) return;
			this.markUnknown(request, true, observedEstimateCny);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage conflicts with an earlier settlement");
		}
		if (request.status === "settled") {
			if (request.reportFingerprint === fingerprint) return;
			this.markUnknown(request, true, observedEstimateCny);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage conflicts with an earlier settlement");
		}
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
			event.provider !== "deepseek" || event.model !== this.limits.model.slice("deepseek/".length).split(":")[0] ||
			!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
				.every((value) => Number.isSafeInteger(value) && value! >= 0) ||
			usage.totalTokens !== input + usage.output! || input <= 0 || usage.output! <= 0 ||
			input > request.inputPayloadBytes || usage.output! > request.maxOutputTokens + this.limits.outputAccountingMarginTokens ||
			!(["stop", "toolUse", "length"] as Array<string | undefined>).includes(event.stopReason)) {
			this.markUnknown(request, false, observedEstimateCny);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage or call outcome is inconsistent");
		}
		if (event.status !== "reported" || event.costStatus !== "priced" ||
			!Number.isFinite(usage.cost) || usage.cost! < 0 || !Number.isFinite(charge)) {
			// A successful call with no trustworthy price keeps its conservative
			// reservation. Unknown price must never be reported as settled cost.
			this.markUnknown(request, false, Math.max(Number.isFinite(charge) ? charge : 0, observedEstimateCny));
			request.reportFingerprint = fingerprint;
			if (this.committedCny() > this.limits.maxCny) this.stop("total-cny-ceiling");
			else if (charge > request.worstCny || observedEstimateCny > request.worstCny) this.stop("price-assumption-invalid");
			return;
		}
		const sdkEstimateCny = observedEstimateCny;
		if (!Number.isFinite(sdkEstimateCny) || charge > request.worstCny || sdkEstimateCny > request.worstCny) {
			// The request's pre-HTTP reservation no longer protects the sole
			// mission total. Preserve the larger observation, but do not allow
			// another request on pricing assumptions that just proved too low.
			this.markUnknown(request, false, Math.max(charge, sdkEstimateCny));
			request.reportFingerprint = fingerprint;
			this.stop(this.committedCny() > this.limits.maxCny ? "total-cny-ceiling" : "price-assumption-invalid");
			return;
		}
		request.status = "settled";
		request.settledCny = Math.max(charge, sdkEstimateCny);
		request.reportFingerprint = fingerprint;
		this.recountCommitments();
		if (this.committedCny() > this.limits.maxCny) this.stop("total-cny-ceiling");
	}

	/** A known length response is charged at its reported bound, but cannot authorize another request. */
	stopAfterTerminalLength(lease: PromptLease, requestId: string, event: UsageEvent): void {
		if (event.stopReason !== "length") throw new HarnessError("runner.campaign", "terminal length stop requires a length response");
		this.settleReported(lease, requestId, event);
		const state = this.leases.get(lease);
		if (state?.active && state.requests.at(-1)?.id === requestId &&
			state.requests.every((request) => request.status === "settled")) {
			state.terminalLengthRequestId = requestId;
			this.stop("output-limit");
		} else this.stop("prompt-failure");
	}

	private markUnknown(request: RequestState, includeSettled = false, additionalEstimateCny = 0): void {
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
		this.stop("prompt-failure");
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
	snapshot(): { reservedCny: number; grossReservedCny: number; priorCommittedCny: number; currentCommittedCny: number; missionCommittedCny: number; committedCny: number; settledCny: number; inFlightReservedCny: number; unknownReservedCny: number; reservations: number; stopped: boolean; active: boolean; activePrompts: number; stopReason?: string; admissionRejection?: { decision: LocalAdmissionDecision; requestNotSent: true }; pricingProfile?: NativeCnyPricingProfile; providerOutputLimit?: DeepSeekProviderOutputLimit } {
		return { reservedCny: this.grossReservedCny, grossReservedCny: this.grossReservedCny,
			priorCommittedCny: this.limits.priorCommittedCny,
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
}
