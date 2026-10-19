/** Deterministic interpretation of already normalized profile evidence.
 *
 * Raw counters must never reach a model prompt unread: published ablations put
 * raw-counter feedback below no feedback at all, while the same information
 * translated into a bottleneck label, a location and a bounded headroom
 * estimate is the best-performing form. Everything here is fixed arithmetic on
 * host-normalized quantities; nothing is inferred, ranked or recommended by a
 * model, and no value is invented when its inputs are absent. */
import type { CandidatePerformanceEvidenceV1 } from "./candidate-diagnostics.ts";

/** Fixed thresholds, stated once so a reader can check every label by hand. */
export const BOTTLENECK_THRESHOLD_PERCENT = 30;
export const SATURATION_FRACTION = 0.7;
/** Counters whose names this layer understands, by role. Anything else stays
 * an uninterpreted counter: it is reported, never folded into a label. */
const COMPUTE_THROUGHPUT = "sm__throughput.avg.pct_of_peak_sustained_elapsed";
const MEMORY_THROUGHPUT = "dram__throughput.avg.pct_of_peak_sustained_elapsed";
const COMBINED_THROUGHPUT = "gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed";

export interface ProfileBottleneckV1 {
	/** `compute`/`bandwidth`/`latency` follow the published three-throughput
	 * rule; `unclassified` means the required counters were not supplied. */
	label: string;
	/** The exact counters and bounds the label was read from. */
	evidence: Array<{ name: string; value: number; unit: string; sourceLocation?: string }>;
	reason: string;
	/** Fraction of the supplied theoretical bound already attained, when both a
	 * roofline lower bound and a measured elapsed time exist. */
	speedOfLightFraction?: number;
	/** Remaining factor to that bound: elapsed / lowerBound, never below 1. */
	headroomFactor?: number;
	saturated?: boolean;
	/** Counters supplied but outside this layer's fixed vocabulary. */
	uninterpretedCounters: string[];
}

const percent = (performance: CandidatePerformanceEvidenceV1, name: string): { value: number; unit: string; sourceLocation?: string } | undefined => {
	const counter = performance.counters?.find(item => item.name === name && item.unit === "%");
	return counter && Number.isFinite(counter.value) ?
		{ value: counter.value, unit: counter.unit, ...(counter.sourceLocation ? { sourceLocation: counter.sourceLocation } : {}) } : undefined;
};

/** Classify one case's normalized profile evidence. The caller decides whether
 * the result is worth showing; this function never chooses an optimization. */
export function interpretProfileBottleneck(performance: CandidatePerformanceEvidenceV1,
	rooflineLowerBoundSeconds?: number): ProfileBottleneckV1 {
	const compute = percent(performance, COMPUTE_THROUGHPUT);
	const memory = percent(performance, MEMORY_THROUGHPUT);
	const combined = percent(performance, COMBINED_THROUGHPUT);
	const evidence: ProfileBottleneckV1["evidence"] = [];
	for (const [name, item] of [[COMPUTE_THROUGHPUT, compute], [MEMORY_THROUGHPUT, memory], [COMBINED_THROUGHPUT, combined]] as const)
		if (item) evidence.push({ name, ...item });
	const uninterpretedCounters = (performance.counters ?? [])
		.filter(counter => ![COMPUTE_THROUGHPUT, MEMORY_THROUGHPUT, COMBINED_THROUGHPUT].includes(counter.name))
		.map(counter => counter.name);
	let label: ProfileBottleneckV1["label"] = "unclassified";
	let reason = "No supplied counter pair carries the compute and memory throughput percentages this rule reads.";
	if (compute && memory) {
		const memoryObserved = Math.max(memory.value, combined?.value ?? memory.value);
		if (compute.value > BOTTLENECK_THRESHOLD_PERCENT) {
			label = "compute";
			reason = `Compute throughput ${compute.value}% is above the ${BOTTLENECK_THRESHOLD_PERCENT}% rule threshold.`;
		} else if (memoryObserved < BOTTLENECK_THRESHOLD_PERCENT) {
			label = "latency";
			reason = `Neither compute (${compute.value}%) nor memory (${memoryObserved}%) throughput reaches ${BOTTLENECK_THRESHOLD_PERCENT}%, so neither is the limit being hit.`;
		} else {
			label = "bandwidth";
			reason = `Memory throughput ${memoryObserved}% is at or above ${BOTTLENECK_THRESHOLD_PERCENT}% while compute throughput ${compute.value}% is not.`;
		}
	}
	const elapsed = performance.elapsedSeconds?.value;
	const bounded = rooflineLowerBoundSeconds !== undefined && rooflineLowerBoundSeconds > 0 &&
		elapsed !== undefined && elapsed > 0 && Number.isFinite(elapsed / rooflineLowerBoundSeconds);
	const fraction = bounded ? Math.min(1, rooflineLowerBoundSeconds! / elapsed!) : undefined;
	return { label, evidence, reason,
		...(fraction !== undefined ? { speedOfLightFraction: fraction,
			headroomFactor: Math.max(1, elapsed! / rooflineLowerBoundSeconds!),
			saturated: fraction >= SATURATION_FRACTION } : {}),
		uninterpretedCounters };
}

/** One bounded, mechanically assembled summary per case, in the three-question
 * order the ablations use: what the limit is, where it shows, why that is the
 * reading. The byte ceiling is the point: an unfiltered profile dump is the
 * failure mode this replaces, and it is applied where the text is generated,
 * not where it is displayed. */
export const PROFILE_SUMMARY_LIMIT = 1024;

export function describeProfileBottleneck(bottleneck: ProfileBottleneckV1): string {
	const where = bottleneck.evidence.filter(item => item.sourceLocation)
		.map(item => `${item.name} at ${item.sourceLocation}`);
	const parts = [`What: ${bottleneck.label}.`,
		`Where: ${where.length ? where.join("; ") :
			bottleneck.speedOfLightFraction !== undefined ?
				`no source location was supplied; the limit shows as ${(bottleneck.speedOfLightFraction * 100).toFixed(1)}% of the supplied theoretical bound, headroom factor ${bottleneck.headroomFactor!.toFixed(2)}×${bottleneck.saturated ? " (at or above the saturation threshold, so further work against this bound is unlikely to pay)" : ""}` :
				"no source location and no theoretical bound were supplied"}.`,
		`Why: ${bottleneck.reason}${bottleneck.evidence.length ?
			` Read from ${bottleneck.evidence.map(item => `${item.name}=${item.value}${item.unit}`).join(", ")}.` : ""}`];
	if (bottleneck.speedOfLightFraction !== undefined && where.length)
		parts.push(`Headroom: ${(bottleneck.speedOfLightFraction * 100).toFixed(1)}% of the supplied theoretical bound attained, remaining factor ${bottleneck.headroomFactor!.toFixed(2)}×${bottleneck.saturated ? " (at or above the saturation threshold)" : ""}.`);
	if (bottleneck.uninterpretedCounters.length)
		parts.push(`Supplied but not interpreted by this rule: ${bottleneck.uninterpretedCounters.join(", ")}.`);
	return parts.join(" ").slice(0, PROFILE_SUMMARY_LIMIT);
}
