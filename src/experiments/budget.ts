import { randomUUID } from "node:crypto";
import type { UsageSummary } from "../runner/types.ts";
import type { BudgetLease, BudgetLimits, BudgetStatus, PromptReservation } from "./contracts.ts";

type Counts = BudgetStatus["committed"];
type Node = { lease: BudgetLease; limits: BudgetStatus["limits"]; active: boolean; clockMode: "continuous" | "active"; closed: boolean; committed: Counts; reservedInput: number; reservedCost: number; unknown: boolean; exceeded: boolean };
type Reservation = PromptReservation & { nodes: Node[]; open: boolean; kind: "prompt" | "turn" };
export type ObservedTurnReservation = Pick<PromptReservation, "id" | "leaseId">;
const zero = (): Counts => ({ providerCalls: 0, inputTokens: 0, outputTokens: 0, sdkEstimatedCost: 0, probeCalls: 0, cpuMillis: 0 });
const nonnegative = (value: number, name: string): void => {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
};
function activeLimits(limits: BudgetLimits): BudgetStatus["limits"] {
	nonnegative(limits.maxSdkEstimatedCost, "maxSdkEstimatedCost");
	return { maxSdkEstimatedCost: limits.maxSdkEstimatedCost };
}
function knownUsage(usage: UsageSummary): boolean {
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost, usage.reportedEvents, usage.unknownEvents].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) && usage.complete && usage.costComplete && Number.isSafeInteger(usage.reportedEvents) && usage.reportedEvents > 0 && usage.unknownEvents === 0;
}

/** Controller-owned monetary ledger with observable usage for every nested arm. */
export class SharedBudget {
	readonly root: BudgetLease;
	private readonly nodes = new Map<string, Node>();
	private readonly reservations = new Map<string, Reservation>();
	private serial = 0;
	private phaseSealed = false;

	constructor(rootCampaignId: string, limits: BudgetLimits) {
		if (!rootCampaignId.trim()) throw new Error("rootCampaignId is required");
		this.root = { id: `${rootCampaignId}:root`, rootCampaignId };
		this.nodes.set(this.root.id, { lease: this.root, limits: activeLimits(limits), active: true, clockMode: "continuous", closed: false, committed: zero(), reservedInput: 0, reservedCost: 0, unknown: false, exceeded: false });
	}

	createLease(parent: BudgetLease, _historicalLimits?: BudgetLimits, options?: { clockMode?: "continuous" | "active" }): BudgetLease {
		if (this.phaseSealed) throw new Error("phase allocation is sealed");
		const parentNode = this.node(parent);
		if (parentNode.closed) throw new Error("cannot allocate beneath a closed lease");
		const lease: BudgetLease = { id: `${this.root.rootCampaignId}:lease:${++this.serial}`, rootCampaignId: this.root.rootCampaignId, parentLeaseId: parent.id };
		// A child is an accounting namespace. Its historical limit argument cannot
		// create a second monetary gate or reserve a slice of the shared root cap.
		this.nodes.set(lease.id, { lease, limits: { ...this.node(this.root).limits }, active: false, clockMode: options?.clockMode ?? "continuous", closed: false, committed: zero(), reservedInput: 0, reservedCost: 0, unknown: false, exceeded: false });
		return lease;
	}

	/** Prevent direct root spend or unplanned new leases after phase preflight. */
	sealRootToPhases(): void {
		if (this.phaseSealed) throw new Error("phase allocation is already sealed");
		this.phaseSealed = true;
	}

	/** Record branch lifecycle without introducing a workflow duration ceiling. */
	activateLease(lease: BudgetLease): void {
		const lineage = this.lineage(lease);
		if (lineage.some((n) => n.closed)) throw new Error("closed budget lease cannot resume");
		for (const n of lineage) n.active = true;
	}

	/** Seal a completed branch after every descendant and request has settled. */
	closeLease(lease: BudgetLease): BudgetStatus {
		const n = this.node(lease);
		if (lease.id === this.root.id || n.closed) throw new Error("only an open child lease may close");
		if ([...this.nodes.values()].some((child) => child.lease.parentLeaseId === lease.id && !child.closed)) throw new Error("cannot close a lease with an open child");
		if (this.status(lease).settlement !== "settled") throw new Error("cannot close a lease with pending, unknown, or exceeded usage");
		n.closed = true;
		return this.status(lease);
	}

	/** Retained lifecycle API for phases that are explicitly paused between uses. */
	pauseLease(lease: BudgetLease): void {
		const n = this.node(lease);
		if (n.closed) throw new Error("closed budget lease cannot pause");
		if (n.clockMode !== "active") throw new Error("only active-time leases may pause");
		if ([...this.reservations.values()].some((r) => r.open && r.nodes.includes(n))) throw new Error("cannot pause a lease with an in-flight prompt");
		n.active = false;
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
		const root = this.node(this.root);
		return {
			lifecycle: n.closed ? "closed" : n.active ? "running" : "allocated",
			limits: { ...root.limits }, committed: { ...n.committed }, reserved: { inputTokens: n.reservedInput, sdkEstimatedCost: n.reservedCost },
			// Remaining money is shared across every child, including siblings.
			remaining: { sdkEstimatedCost: Math.max(0, root.limits.maxSdkEstimatedCost - root.committed.sdkEstimatedCost - root.reservedCost) },
			settlement: root.exceeded ? "exceeded" : root.unknown || [...this.reservations.values()].some((r) => r.open && r.nodes.includes(root)) ? "pending-or-unknown" : "settled",
		};
	}

	private requestNodes(lease: BudgetLease, requiredCost: number): Node[] {
		if (this.phaseSealed && lease.id === this.root.id) throw new Error("direct root spend is forbidden after phase allocation");
		this.activateLease(lease);
		const nodes = this.lineage(lease);
		for (const n of nodes) {
			const s = this.status(n.lease);
			if (s.settlement !== "settled") throw new Error("budget has pending, unknown, or exceeded usage");
		}
		const remaining = this.status(this.root).remaining.sdkEstimatedCost;
		if (remaining <= 0 || remaining < requiredCost) throw new Error("prompt monetary budget exhausted");
		return nodes;
	}

	reservePrompt(lease: BudgetLease, request: { maxInputTokens: number; maxSdkEstimatedCost: number }): PromptReservation {
		nonnegative(request.maxInputTokens, "maxInputTokens");
		nonnegative(request.maxSdkEstimatedCost, "maxSdkEstimatedCost");
		if (!Number.isSafeInteger(request.maxInputTokens) || request.maxInputTokens === 0 || request.maxSdkEstimatedCost === 0) throw new Error("prompt reservations must be positive");
		const nodes = this.requestNodes(lease, request.maxSdkEstimatedCost);
		for (const n of nodes) { n.committed.providerCalls++; n.reservedInput += request.maxInputTokens; n.reservedCost += request.maxSdkEstimatedCost; }
		const reservation: Reservation = { id: randomUUID(), leaseId: lease.id, ...request, nodes, open: true, kind: "prompt" };
		this.reservations.set(reservation.id, reservation);
		return { id: reservation.id, leaseId: reservation.leaseId, maxInputTokens: reservation.maxInputTokens, maxSdkEstimatedCost: reservation.maxSdkEstimatedCost };
	}

	/** Research requests settle actual usage without input/output token or call quotas. */
	reserveObservedPrompt(lease: BudgetLease, request: { maxInputTokens: number }): PromptReservation {
		if (!Number.isSafeInteger(request.maxInputTokens) || request.maxInputTokens < 1) throw new Error("input accounting estimate must be positive");
		const nodes = this.requestNodes(lease, 0);
		for (const n of nodes) { n.committed.providerCalls++; n.reservedInput += request.maxInputTokens; }
		const reservation: Reservation = { id: randomUUID(), leaseId: lease.id, maxInputTokens: request.maxInputTokens, maxSdkEstimatedCost: 0, nodes, open: true, kind: "prompt" };
		this.reservations.set(reservation.id, reservation);
		return { id: reservation.id, leaseId: reservation.leaseId, maxInputTokens: reservation.maxInputTokens, maxSdkEstimatedCost: 0 };
	}

	/** Pi may make any number of calls within a tool-using turn; settle what it reports. */
	reserveObservedTurn(lease: BudgetLease): ObservedTurnReservation {
		const nodes = this.requestNodes(lease, 0);
		const reservation: Reservation = { id: randomUUID(), leaseId: lease.id, maxInputTokens: 0, maxSdkEstimatedCost: 0, nodes, open: true, kind: "turn" };
		this.reservations.set(reservation.id, reservation);
		return { id: reservation.id, leaseId: reservation.leaseId };
	}

	settleObservedTurn(reservation: ObservedTurnReservation, usage: UsageSummary): void {
		const r = this.reservations.get(reservation.id);
		if (!r || !r.open || r.kind !== "turn" || r.leaseId !== reservation.leaseId) throw new Error("invalid or settled turn reservation");
		this.settle(r, usage);
	}

	markObservedTurnUnknown(reservation: ObservedTurnReservation): void {
		this.settleObservedTurn(reservation, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, reportedEvents: 0, unknownEvents: 1, complete: false, costComplete: false });
	}

	settlePrompt(reservation: PromptReservation, usage: UsageSummary): void {
		const r = this.reservations.get(reservation.id);
		if (!r || !r.open || r.kind !== "prompt" || r.leaseId !== reservation.leaseId || r.maxInputTokens !== reservation.maxInputTokens || r.maxSdkEstimatedCost !== reservation.maxSdkEstimatedCost) throw new Error("invalid or settled prompt reservation");
		this.settle(r, usage);
	}

	private settle(r: Reservation, usage: UsageSummary): void {
		r.open = false;
		const known = knownUsage(usage);
		const observed = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;
		const input = observed(usage.input) + observed(usage.cacheRead) + observed(usage.cacheWrite);
		const output = observed(usage.output);
		const cost = observed(usage.cost);
		const calls = Number.isSafeInteger(usage.reportedEvents) && usage.reportedEvents >= 0 ? usage.reportedEvents : 0;
		for (const n of r.nodes) {
			n.reservedInput -= r.maxInputTokens;
			n.reservedCost -= r.maxSdkEstimatedCost;
			// A prompt counted one started call at reservation; turns only count reports.
			n.committed.providerCalls += r.kind === "prompt" ? Math.max(1, calls) - 1 : calls;
			n.committed.inputTokens += input;
			n.committed.outputTokens += output;
			n.committed.sdkEstimatedCost += cost;
			if (!known) n.unknown = true;
		}
		const root = this.node(this.root);
		if (root.committed.sdkEstimatedCost > root.limits.maxSdkEstimatedCost) root.exceeded = true;
	}

	markUnknown(reservation: PromptReservation): void {
		this.settlePrompt(reservation, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, reportedEvents: 0, unknownEvents: 1, complete: false, costComplete: false });
	}

	/** Observe a case-permitted probe before CPU work; there is no campaign call quota. */
	reserveProbe(lease: BudgetLease): void {
		if (this.phaseSealed && lease.id === this.root.id) throw new Error("direct root probe is forbidden after phase allocation");
		this.activateLease(lease);
		for (const n of this.lineage(lease)) if (this.status(n.lease).settlement !== "settled") throw new Error("probe budget has pending, unknown, or exceeded usage");
		for (const n of this.lineage(lease)) n.committed.probeCalls++;
	}

	debitCpuMillis(lease: BudgetLease, millis: number): void {
		if (this.phaseSealed && lease.id === this.root.id) throw new Error("direct root CPU spend is forbidden after phase allocation");
		this.activateLease(lease);
		nonnegative(millis, "cpuMillis");
		for (const n of this.lineage(lease)) n.committed.cpuMillis += millis;
	}
}
