import { HarnessError } from "../types.ts";
import type { SessionSpec, UsageEvent } from "./types.ts";
import { isConfinedCampaignFileGrant } from "./confined-campaign-files.ts";

/**
 * In-process, single-owner planning ceiling for one DeepSeek research campaign.
 * Reservations are never refunded: a timeout or lost response may still be billed.
 * This is a conservative local estimate, not a provider invoice or account limit.
 */
export interface DeepSeekCampaignLimits {
	model: string;
	endpoint: "https://api.deepseek.com";
	maxCny: number;
	maxProviderCalls: number;
	maxProviderCallsPerPrompt: number;
	maxOutputTokens: number;
	outputAccountingMarginTokens: number;
	maxInputCnyPerMillionTokens: number;
	maxOutputCnyPerMillionTokens: number;
	cnyPerUsdCeiling: number;
}

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function count(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

export class DeepSeekCampaignBudget {
	readonly limits: Readonly<DeepSeekCampaignLimits>;
	private reservations = 0;
	private reservedCny = 0;
	private active = false;
	private promptStart = 0;
	private readonly requestReservations: Array<{ inputPayloadBytes: number; reservedCny: number }> = [];
	private stopped = false;
	private stopReason?: "payload-boundary" | "ceiling" | "usage-reconciliation" | "prompt-failure";

	constructor(limits: DeepSeekCampaignLimits) {
		if (!/^deepseek\/[^/]+(?::(?:off|minimal|low|medium|high|max))?$/.test(limits.model) || limits.endpoint !== "https://api.deepseek.com" ||
			!positive(limits.maxCny) || !count(limits.maxProviderCalls) || !count(limits.maxProviderCallsPerPrompt) ||
			!count(limits.maxOutputTokens) ||
			!Number.isSafeInteger(limits.outputAccountingMarginTokens) || limits.outputAccountingMarginTokens < 0 ||
			!positive(limits.maxInputCnyPerMillionTokens) || !positive(limits.maxOutputCnyPerMillionTokens) || !positive(limits.cnyPerUsdCeiling)) {
			throw new HarnessError("runner.campaign", "invalid DeepSeek campaign limits");
		}
		this.limits = Object.freeze({ ...limits });
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
		if (spec.tools.kind === "custom" && !isConfinedCampaignFileGrant(spec.tools.tools)) throw new HarnessError("runner.campaign", "campaign custom tools must be the audited confined file grant");
		if (spec.tools.kind === "read-dir" && spec.tools.extraTools?.length) throw new HarnessError("runner.campaign", "campaign read-dir cannot include arbitrary extra tools");
		// Take our own immutable grant snapshot so a caller cannot swap closures
		// while buildHandle awaits filesystem or SDK setup.
		const tools = spec.tools.kind === "custom"
			? Object.freeze({ kind: "custom" as const, tools: Object.freeze([...spec.tools.tools]) })
			: spec.tools.kind === "read-dir"
				? Object.freeze({ kind: "read-dir" as const, root: spec.tools.root, ...(spec.tools.toolName ? { toolName: spec.tools.toolName } : {}) })
				: Object.freeze({ kind: "none" as const });
		return { ...spec, tools: tools as SessionSpec["tools"], strictRequest: this.strictRequest };
	}

	assertResolved(model: { provider: string; id: string; api: string; baseUrl: string; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> } }): void {
		const modelId = this.limits.model.slice("deepseek/".length).split(":")[0];
		const rates = [model.cost, ...(model.cost.tiers ?? [])];
		if (model.provider !== "deepseek" || model.id !== modelId || model.api !== "openai-completions" ||
			model.baseUrl !== this.limits.endpoint || this.limits.maxOutputTokens > model.maxTokens ||
			rates.some((rate) => [rate.input, rate.cacheRead, rate.cacheWrite].some((v) => !Number.isFinite(v) || v < 0 || v * this.limits.cnyPerUsdCeiling > this.limits.maxInputCnyPerMillionTokens) ||
				!Number.isFinite(rate.output) || rate.output < 0 || rate.output * this.limits.cnyPerUsdCeiling > this.limits.maxOutputCnyPerMillionTokens) ||
			model.cost.input <= 0 || model.cost.output <= 0) {
			throw new HarnessError("runner.campaign", "DeepSeek model, endpoint or price ceiling did not verify");
		}
	}

	beginPrompt(): void {
		if (this.stopped || this.active) throw new HarnessError("runner.campaign", "campaign is stopped or already has an active prompt");
		this.active = true;
		this.promptStart = this.reservations;
	}

	/** Called synchronously by onPayload, before the HTTP request can begin. */
	reserve(payloadBytes: number): void {
		if (!this.active || this.stopped || !count(payloadBytes)) {
			this.stopped = true;
			this.stopReason ??= "payload-boundary";
			throw new HarnessError("runner.campaign", "provider payload byte count is unavailable");
		}
		const next = this.reservations + 1;
		const worstCny = (payloadBytes * this.limits.maxInputCnyPerMillionTokens +
			(this.limits.maxOutputTokens + this.limits.outputAccountingMarginTokens) * this.limits.maxOutputCnyPerMillionTokens) / 1_000_000;
		if (!Number.isFinite(worstCny) || next > this.limits.maxProviderCalls || next - this.promptStart > this.limits.maxProviderCallsPerPrompt ||
			this.reservedCny + worstCny > this.limits.maxCny + 1e-9) {
			this.stopped = true;
			this.stopReason ??= "ceiling";
			throw new HarnessError("runner.campaign", "campaign call or CNY planning ceiling exhausted");
		}
		this.reservations = next;
		this.reservedCny += worstCny;
		this.requestReservations.push({ inputPayloadBytes: payloadBytes, reservedCny: worstCny });
	}

	finishPrompt(events: readonly UsageEvent[]): void {
		try {
			const assistant = events.filter((event) => event.kind === "assistant");
			const reserved = this.requestReservations.slice(this.promptStart);
			if (assistant.length !== this.reservations - this.promptStart || assistant.length === 0 ||
				assistant.some((event, index) => event.status !== "reported" || event.costStatus !== "priced" ||
					event.provider !== "deepseek" || event.model !== this.limits.model.slice("deepseek/".length).split(":")[0] ||
					!event.usage || ![event.usage.input, event.usage.output, event.usage.cacheRead, event.usage.cacheWrite, event.usage.totalTokens]
						.every((value) => Number.isSafeInteger(value) && value! >= 0) ||
					event.usage.totalTokens! !== event.usage.input! + event.usage.output! + event.usage.cacheRead! + event.usage.cacheWrite! ||
					(event.usage.input! + event.usage.cacheRead! + event.usage.cacheWrite!) > reserved[index].inputPayloadBytes ||
					event.usage.output! > this.limits.maxOutputTokens + this.limits.outputAccountingMarginTokens ||
					!Number.isFinite(event.usage.cost) || event.usage.cost! < 0 ||
					event.usage.cost! * this.limits.cnyPerUsdCeiling > reserved[index].reservedCny + 1e-9 ||
					!(["stop", "toolUse"] as Array<string | undefined>).includes(event.stopReason))) {
				throw new HarnessError("runner.campaign", "provider usage or call outcome is incomplete or exceeds the campaign reserve");
			}
		} catch (error) {
			this.stopped = true;
			this.stopReason ??= "usage-reconciliation";
			throw error;
		} finally {
			this.active = false;
		}
	}

	failPrompt(): void { this.stopped = true; this.active = false; this.stopReason ??= "prompt-failure"; }

	snapshot(): { reservedCny: number; reservations: number; stopped: boolean; active: boolean; stopReason?: string } {
		return { reservedCny: this.reservedCny, reservations: this.reservations, stopped: this.stopped, active: this.active,
			...(this.stopReason ? { stopReason: this.stopReason } : {}) };
	}
}
