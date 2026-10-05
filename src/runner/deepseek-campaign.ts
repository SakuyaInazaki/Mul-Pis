import { HarnessError } from "../types.ts";
import type { SessionSpec, UsageEvent } from "./types.ts";
import { getConfinedCampaignFileGrantDescriptor } from "./confined-campaign-files.ts";

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
	maxProviderCalls: number;
	maxProviderCallsPerPrompt: number;
	maxOutputTokens: number;
	outputAccountingMarginTokens: number;
	/** Planning estimates for the global total, dynamically raised if SDK model rates are higher. */
	estimatedInputCnyPerMillionTokens: number;
	estimatedCacheReadCnyPerMillionTokens?: number;
	estimatedOutputCnyPerMillionTokens: number;
	estimatedCnyPerUsd: number;
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
}

interface RequestState {
	readonly id: string;
	readonly inputPayloadBytes: number;
	readonly worstCny: number;
	readonly rates: { input: number; cacheRead: number; output: number };
	status: "reserved" | "settled" | "unknown";
	settledCny?: number;
	reportFingerprint?: string;
}

export class DeepSeekCampaignBudget {
	readonly limits: Readonly<DeepSeekCampaignLimits>;
	private rates: { input: number; cacheRead: number; output: number };
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
	private activePrompts = 0;
	private stopped = false;
	private stopReason?: "payload-boundary" | "total-cny-ceiling" | "provider-call-limit" | "price-assumption-invalid" | "usage-reconciliation" | "prompt-failure";

	constructor(limits: DeepSeekCampaignLimits) {
		if (!/^deepseek\/[^/]+(?::(?:off|minimal|low|medium|high|max))?$/.test(limits.model) || limits.endpoint !== "https://api.deepseek.com" ||
			!positive(limits.maxCny) || !Number.isFinite(limits.priorCommittedCny) || limits.priorCommittedCny < 0 ||
			!count(limits.maxProviderCalls) || !count(limits.maxProviderCallsPerPrompt) ||
			!count(limits.maxOutputTokens) ||
			!Number.isSafeInteger(limits.outputAccountingMarginTokens) || limits.outputAccountingMarginTokens < 0 ||
			!positive(limits.estimatedInputCnyPerMillionTokens) ||
			(limits.estimatedCacheReadCnyPerMillionTokens !== undefined && !positive(limits.estimatedCacheReadCnyPerMillionTokens)) ||
			!positive(limits.estimatedOutputCnyPerMillionTokens) || !positive(limits.estimatedCnyPerUsd)) {
			throw new HarnessError("runner.campaign", "invalid DeepSeek campaign limits");
		}
		this.limits = Object.freeze({ ...limits });
		this.rates = { input: limits.estimatedInputCnyPerMillionTokens,
			cacheRead: limits.estimatedCacheReadCnyPerMillionTokens ?? limits.estimatedInputCnyPerMillionTokens,
			output: limits.estimatedOutputCnyPerMillionTokens };
	}

	get strictRequest(): NonNullable<SessionSpec["strictRequest"]> {
		return {
			maxProviderCallsPerPrompt: this.limits.maxProviderCallsPerPrompt,
			maxOutputTokens: this.limits.maxOutputTokens,
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

	assertResolved(model: { provider: string; id: string; api: string; baseUrl: string; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> } }): void {
		const modelId = this.limits.model.slice("deepseek/".length).split(":")[0];
		const rates = [model.cost, ...(model.cost.tiers ?? [])];
		if (model.provider !== "deepseek" || model.id !== modelId || model.api !== "openai-completions" ||
			model.baseUrl !== this.limits.endpoint || this.limits.maxOutputTokens > model.maxTokens ||
			rates.some((rate) => [rate.input, rate.cacheWrite, rate.cacheRead, rate.output].some((v) => !Number.isFinite(v) || v < 0)) ||
			model.cost.input <= 0 || model.cost.output <= 0) {
			throw new HarnessError("runner.campaign", "DeepSeek model, endpoint or pricing data did not verify");
		}
		// Higher model rates consume more of the same global total; they are not a
		// separate reason to reject an otherwise affordable request.
		this.rates = {
			input: Math.max(this.rates.input, ...rates.map((rate) => Math.max(rate.input, rate.cacheWrite) * this.limits.estimatedCnyPerUsd)),
			cacheRead: Math.max(this.rates.cacheRead, ...rates.map((rate) => rate.cacheRead * this.limits.estimatedCnyPerUsd)),
			output: Math.max(this.rates.output, ...rates.map((rate) => rate.output * this.limits.estimatedCnyPerUsd)),
		};
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

	/** Called synchronously by onPayload, before the HTTP request can begin. */
	reserve(lease: PromptLease, payloadBytes: number, providerRequestId: string): void {
		const state = this.leases.get(lease);
		if (!state?.active || this.stopped || !count(payloadBytes) || typeof providerRequestId !== "string" || !providerRequestId) {
			this.stop("payload-boundary");
			throw new HarnessError("runner.campaign", "provider payload byte count is unavailable");
		}
		// Reusing an ID must never authorize another transport attempt for free.
		if (this.requestIds.has(providerRequestId)) {
			this.stop("payload-boundary");
			throw new HarnessError("runner.campaign", "provider request ID was already reserved");
		}
		const next = this.reservations + 1;
		const worstCny = (payloadBytes * Math.max(this.rates.input, this.rates.cacheRead) +
			(this.limits.maxOutputTokens + this.limits.outputAccountingMarginTokens) * this.rates.output) / 1_000_000;
		if (next > this.limits.maxProviderCalls || state.requests.length + 1 > this.limits.maxProviderCallsPerPrompt) {
			this.stop("provider-call-limit");
			throw new HarnessError("runner.campaign", "campaign provider call limit exhausted");
		}
		if (!Number.isFinite(worstCny) || this.committedCny() + worstCny > this.limits.maxCny) {
			this.stop("total-cny-ceiling");
			throw new HarnessError("runner.campaign", "campaign global CNY total exhausted");
		}
		this.reservations = next;
		this.grossReservedCny += worstCny;
		this.inFlightReservedCny += worstCny;
		this.requestIds.add(providerRequestId);
		state.requests.push({ id: providerRequestId, inputPayloadBytes: payloadBytes, worstCny, rates: { ...this.rates }, status: "reserved" });
	}

	private committedCny(): number { return this.limits.priorCommittedCny + this.settledCny + this.inFlightReservedCny + this.unknownReservedCny; }

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
		if (request.status === "unknown") {
			if (request.reportFingerprint === fingerprint) return;
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage conflicts with an earlier settlement");
		}
		if (request.status === "settled") {
			if (request.reportFingerprint === fingerprint) return;
			this.markUnknown(request, true);
			this.stop("usage-reconciliation");
			throw new HarnessError("runner.campaign", "provider usage conflicts with an earlier settlement");
		}
		const usage = event.usage;
		const input = (usage?.input ?? NaN) + (usage?.cacheRead ?? NaN) + (usage?.cacheWrite ?? NaN);
		const charge = (((usage?.input ?? NaN) + (usage?.cacheWrite ?? NaN)) * request.rates.input +
			(usage?.cacheRead ?? NaN) * request.rates.cacheRead +
			(usage?.output ?? NaN) * request.rates.output) / 1_000_000;
		const observedEstimateCny = typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
			? Math.min(Number.MAX_VALUE, usage.cost * this.limits.estimatedCnyPerUsd) : 0;
		if (event.kind !== "assistant" ||
			event.provider !== "deepseek" || event.model !== this.limits.model.slice("deepseek/".length).split(":")[0] ||
			!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
				.every((value) => Number.isSafeInteger(value) && value! >= 0) ||
			usage.totalTokens !== input + usage.output! || input <= 0 || usage.output! <= 0 ||
			input > request.inputPayloadBytes || usage.output! > this.limits.maxOutputTokens + this.limits.outputAccountingMarginTokens ||
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
		this.inFlightReservedCny -= request.worstCny;
		this.settledCny += request.settledCny;
		if (this.committedCny() > this.limits.maxCny) this.stop("total-cny-ceiling");
	}

	/** A known length response is charged at its reported bound, but cannot authorize another request. */
	stopAfterTerminalLength(lease: PromptLease, requestId: string, event: UsageEvent): void {
		if (event.stopReason !== "length") throw new HarnessError("runner.campaign", "terminal length stop requires a length response");
		this.settleReported(lease, requestId, event);
		this.stop("prompt-failure");
	}

	private markUnknown(request: RequestState, includeSettled = false, additionalEstimateCny = 0): void {
		const conservativeUnknownCny = Math.max(request.worstCny, request.settledCny ?? 0, additionalEstimateCny);
		if (request.status === "settled") {
			if (!includeSettled) return;
			this.settledCny -= request.settledCny!;
		} else if (request.status === "reserved") {
			this.inFlightReservedCny -= request.worstCny;
		} else return;
		request.status = "unknown";
		delete request.settledCny;
		delete request.reportFingerprint;
		this.unknownReservedCny += conservativeUnknownCny;
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
	snapshot(): { reservedCny: number; grossReservedCny: number; priorCommittedCny: number; currentCommittedCny: number; missionCommittedCny: number; committedCny: number; settledCny: number; inFlightReservedCny: number; unknownReservedCny: number; reservations: number; stopped: boolean; active: boolean; activePrompts: number; stopReason?: string } {
		return { reservedCny: this.grossReservedCny, grossReservedCny: this.grossReservedCny,
			priorCommittedCny: this.limits.priorCommittedCny,
			currentCommittedCny: this.settledCny + this.inFlightReservedCny + this.unknownReservedCny,
			missionCommittedCny: this.committedCny(),
			committedCny: this.committedCny(), settledCny: this.settledCny,
			inFlightReservedCny: this.inFlightReservedCny, unknownReservedCny: this.unknownReservedCny,
			reservations: this.reservations, stopped: this.stopped, active: this.activePrompts > 0,
			activePrompts: this.activePrompts,
			...(this.stopReason ? { stopReason: this.stopReason } : {}) };
	}
}
