import { randomUUID } from "node:crypto";
import type { UsageSummary } from "../runner/types.ts";
import type { BudgetLease, BudgetLimits, BudgetStatus, PromptReservation } from "./contracts.ts";

type Counts = BudgetStatus["committed"];
type Node = { lease: BudgetLease; limits: BudgetLimits; started: number; committed: Counts; reservedInput: number; reservedOutput: number; reservedCost: number; unknown: boolean; exceeded: boolean };
type Reservation = PromptReservation & { nodes: Node[]; open: boolean };
const zero = (): Counts => ({ providerCalls: 0, inputTokens: 0, outputTokens: 0, sdkEstimatedCost: 0, probeCalls: 0, cpuMillis: 0 });
const nonnegative = (value: number, name: string): void => {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
};
function checkLimits(limits: BudgetLimits): void {
	for (const [name, value] of Object.entries(limits)) nonnegative(value, name);
}

/** Controller-owned pre-reservation ledger. One instance owns every nested arm. */
export class SharedBudget {
	readonly root: BudgetLease;
	private readonly nodes = new Map<string, Node>();
	private readonly reservations = new Map<string, Reservation>();
	private serial = 0;

	constructor(rootCampaignId: string, limits: BudgetLimits) {
		if (!rootCampaignId.trim()) throw new Error("rootCampaignId is required");
		checkLimits(limits);
		this.root = { id: `${rootCampaignId}:root`, rootCampaignId };
		this.nodes.set(this.root.id, { lease: this.root, limits: { ...limits }, started: Date.now(), committed: zero(), reservedInput: 0, reservedOutput: 0, reservedCost: 0, unknown: false, exceeded: false });
	}

	createLease(parent: BudgetLease, limits?: BudgetLimits): BudgetLease {
		const parentNode = this.node(parent);
		const cap = limits ?? parentNode.limits;
		checkLimits(cap);
		const lease: BudgetLease = { id: `${this.root.rootCampaignId}:lease:${++this.serial}`, rootCampaignId: this.root.rootCampaignId, parentLeaseId: parent.id };
		this.nodes.set(lease.id, { lease, limits: { ...cap }, started: Date.now(), committed: zero(), reservedInput: 0, reservedOutput: 0, reservedCost: 0, unknown: false, exceeded: false });
		return lease;
	}

	private node(lease: BudgetLease): Node {
		const node = this.nodes.get(lease.id);
		if (!node || JSON.stringify(node.lease) !== JSON.stringify(lease)) throw new Error("unknown or mismatched budget lease");
		return node;
	}

	private lineage(lease: BudgetLease): Node[] {
		const nodes: Node[] = [];
		for (let node: Node | undefined = this.node(lease); node; node = node.lease.parentLeaseId ? this.nodes.get(node.lease.parentLeaseId) : undefined) nodes.push(node);
		return nodes;
	}

	status(lease: BudgetLease = this.root): BudgetStatus {
		const n = this.node(lease);
		const c = n.committed;
		const l = n.limits;
		return {
			limits: { ...l }, committed: { ...c }, reserved: { inputTokens: n.reservedInput, outputTokens: n.reservedOutput, sdkEstimatedCost: n.reservedCost },
			remaining: {
				providerCalls: Math.max(0, l.maxProviderCalls - c.providerCalls),
				inputTokens: Math.max(0, l.maxInputTokens - c.inputTokens - n.reservedInput),
				outputTokens: Math.max(0, l.maxOutputTokens - c.outputTokens - n.reservedOutput),
				sdkEstimatedCost: Math.max(0, l.maxSdkEstimatedCost - c.sdkEstimatedCost - n.reservedCost),
				probeCalls: Math.max(0, l.maxProbeCalls - c.probeCalls),
				cpuMillis: Math.max(0, l.maxCpuMillis - c.cpuMillis),
				wallMillis: Math.max(0, l.maxWallMillis - (Date.now() - n.started)),
			},
			settlement: n.exceeded ? "exceeded" : n.unknown || [...this.reservations.values()].some((r) => r.open && r.nodes.includes(n)) ? "pending-or-unknown" : "settled",
		};
	}

	reservePrompt(lease: BudgetLease, request: { maxInputTokens: number; maxOutputTokens: number; maxSdkEstimatedCost: number }): PromptReservation {
		nonnegative(request.maxInputTokens, "maxInputTokens");
		nonnegative(request.maxOutputTokens, "maxOutputTokens");
		nonnegative(request.maxSdkEstimatedCost, "maxSdkEstimatedCost");
		if (!Number.isInteger(request.maxInputTokens) || !Number.isInteger(request.maxOutputTokens) || request.maxInputTokens === 0 || request.maxOutputTokens === 0 || request.maxSdkEstimatedCost === 0) throw new Error("prompt caps must be positive");
		const nodes = this.lineage(lease);
		for (const n of nodes) {
			const s = this.status(n.lease);
			if (s.settlement !== "settled") throw new Error("budget has pending or unknown usage");
			if (s.remaining.providerCalls < 1 || s.remaining.inputTokens < request.maxInputTokens || s.remaining.outputTokens < request.maxOutputTokens || s.remaining.wallMillis <= 0 || s.remaining.sdkEstimatedCost < request.maxSdkEstimatedCost) throw new Error("prompt budget exhausted");
		}
		for (const n of nodes) { n.committed.providerCalls++; n.reservedInput += request.maxInputTokens; n.reservedOutput += request.maxOutputTokens; n.reservedCost += request.maxSdkEstimatedCost; }
		const reservation: Reservation = { id: randomUUID(), leaseId: lease.id, ...request, nodes, open: true };
		this.reservations.set(reservation.id, reservation);
		return { id: reservation.id, leaseId: reservation.leaseId, maxInputTokens: reservation.maxInputTokens, maxOutputTokens: reservation.maxOutputTokens, maxSdkEstimatedCost: reservation.maxSdkEstimatedCost };
	}

	settlePrompt(reservation: PromptReservation, usage: UsageSummary): void {
		const r = this.reservations.get(reservation.id);
		if (!r || !r.open || r.leaseId !== reservation.leaseId || r.maxInputTokens !== reservation.maxInputTokens || r.maxOutputTokens !== reservation.maxOutputTokens || r.maxSdkEstimatedCost !== reservation.maxSdkEstimatedCost) throw new Error("invalid or settled prompt reservation");
		r.open = false;
		const finiteUsage = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost, usage.reportedEvents, usage.unknownEvents].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
		const known = finiteUsage && usage.complete && usage.costComplete && usage.reportedEvents > 0 && usage.unknownEvents === 0;
		const input = known ? usage.input + usage.cacheRead + usage.cacheWrite : r.maxInputTokens;
		const output = known ? usage.output : r.maxOutputTokens;
		const cost = known ? usage.cost : 0;
		for (const n of r.nodes) {
			n.reservedInput -= r.maxInputTokens;
			n.reservedOutput -= r.maxOutputTokens;
			n.reservedCost -= r.maxSdkEstimatedCost;
			n.committed.inputTokens += input;
			n.committed.outputTokens += output;
			n.committed.sdkEstimatedCost += cost;
			if (!known) n.unknown = true;
			if ((known && (input > r.maxInputTokens || output > r.maxOutputTokens || cost > r.maxSdkEstimatedCost)) || n.committed.inputTokens > n.limits.maxInputTokens || n.committed.outputTokens > n.limits.maxOutputTokens || n.committed.sdkEstimatedCost > n.limits.maxSdkEstimatedCost) n.exceeded = true;
		}
	}

	markUnknown(reservation: PromptReservation): void {
		this.settlePrompt(reservation, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, reportedEvents: 0, unknownEvents: 1, complete: false, costComplete: false });
	}

	/** Probe is charged before CPU work; a failed probe does not restore quota. */
	reserveProbe(lease: BudgetLease): void {
		for (const n of this.lineage(lease)) {
			const s = this.status(n.lease);
			if (s.settlement !== "settled" || s.remaining.probeCalls < 1 || s.remaining.wallMillis <= 0 || s.remaining.cpuMillis <= 0) throw new Error("probe budget exhausted");
		}
		for (const n of this.lineage(lease)) n.committed.probeCalls++;
	}

	debitCpuMillis(lease: BudgetLease, millis: number): void {
		nonnegative(millis, "cpuMillis");
		for (const n of this.lineage(lease)) {
			n.committed.cpuMillis += millis;
			if (n.committed.cpuMillis > n.limits.maxCpuMillis) n.exceeded = true;
		}
	}
}
