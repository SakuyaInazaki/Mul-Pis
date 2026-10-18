import assert from "node:assert/strict";
import test from "node:test";
import { BOTTLENECK_THRESHOLD_PERCENT, PROFILE_SUMMARY_LIMIT, describeProfileBottleneck,
	interpretProfileBottleneck } from "../src/m07/profile-bottleneck.ts";
import type { CandidatePerformanceEvidenceV1 } from "../src/m07/candidate-diagnostics.ts";

const counter = (name: string, value: number, unit = "%") =>
	({ name, value, unit, receiptIndex: 0, fieldPath: `csv.row:2.${name}` });
const evidence = (counters: Array<ReturnType<typeof counter>>,
	elapsedSeconds?: number): CandidatePerformanceEvidenceV1 => ({ basisId: "basis",
		...(elapsedSeconds === undefined ? {} : { elapsedSeconds: { value: elapsedSeconds, receiptIndex: 0, fieldPath: "elapsed" } }),
		counters });

test("the fixed three-throughput rule separates compute, bandwidth and latency limits", () => {
	const compute = interpretProfileBottleneck(evidence([
		counter("sm__throughput.avg.pct_of_peak_sustained_elapsed", 71.2),
		counter("dram__throughput.avg.pct_of_peak_sustained_elapsed", 12.0)]));
	assert.equal(compute.label, "compute");
	assert.match(compute.reason, new RegExp(`${BOTTLENECK_THRESHOLD_PERCENT}%`));
	const bandwidth = interpretProfileBottleneck(evidence([
		counter("sm__throughput.avg.pct_of_peak_sustained_elapsed", 18.0),
		counter("dram__throughput.avg.pct_of_peak_sustained_elapsed", 88.5)]));
	assert.equal(bandwidth.label, "bandwidth");
	const latency = interpretProfileBottleneck(evidence([
		counter("sm__throughput.avg.pct_of_peak_sustained_elapsed", 9.0),
		counter("dram__throughput.avg.pct_of_peak_sustained_elapsed", 11.0)]));
	assert.equal(latency.label, "latency");
	// The combined throughput counter can only raise the observed memory side.
	const combined = interpretProfileBottleneck(evidence([
		counter("sm__throughput.avg.pct_of_peak_sustained_elapsed", 9.0),
		counter("dram__throughput.avg.pct_of_peak_sustained_elapsed", 11.0),
		counter("gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed", 64.0)]));
	assert.equal(combined.label, "bandwidth");
});

test("a label is never invented from counters this rule does not read", () => {
	const unread = interpretProfileBottleneck(evidence([
		counter("lts__t_sector_hit_rate.pct", 42.0),
		counter("aiv_mte2_ratio", 0.6, "reported-ratio")]));
	assert.equal(unread.label, "unclassified");
	assert.deepEqual(unread.evidence, []);
	assert.deepEqual(unread.uninterpretedCounters, ["lts__t_sector_hit_rate.pct", "aiv_mte2_ratio"]);
	assert.equal(unread.speedOfLightFraction, undefined);
	const oneSided = interpretProfileBottleneck(evidence([
		counter("sm__throughput.avg.pct_of_peak_sustained_elapsed", 95.0)]));
	assert.equal(oneSided.label, "unclassified", "one throughput counter cannot decide which limit was reached");
});

test("headroom comes from the supplied bound and is reported with a saturation verdict", () => {
	const roomy = interpretProfileBottleneck(evidence([], 4e-3), 1e-3);
	assert.equal(roomy.speedOfLightFraction, 0.25);
	assert.equal(roomy.headroomFactor, 4);
	assert.equal(roomy.saturated, false);
	const saturated = interpretProfileBottleneck(evidence([], 1.1e-3), 1e-3);
	assert.equal(saturated.saturated, true);
	// A measurement below its own supplied bound cannot mean negative headroom.
	const impossible = interpretProfileBottleneck(evidence([], 5e-4), 1e-3);
	assert.equal(impossible.speedOfLightFraction, 1);
	assert.equal(impossible.headroomFactor, 1);
	assert.equal(interpretProfileBottleneck(evidence([], 4e-3)).headroomFactor, undefined,
		"no bound was supplied, so no headroom is claimed");
});

test("the rendered summary stays small, names its counters and never carries a raw table", () => {
	const interpretation = interpretProfileBottleneck(evidence([
		counter("sm__throughput.avg.pct_of_peak_sustained_elapsed", 71.2),
		counter("dram__throughput.avg.pct_of_peak_sustained_elapsed", 12.0),
		counter("smsp__warps_eligible.avg.per_cycle_active", 1.4, "per-cycle")], 4e-3), 1e-3);
	const summary = describeProfileBottleneck(interpretation);
	assert.ok(summary.length <= PROFILE_SUMMARY_LIMIT);
	assert.match(summary, /^What: compute\. Where: /, "the summary answers what, where and why in that order");
	assert.match(summary, /Why: Compute throughput 71\.2% is above/);
	assert.match(summary, /headroom factor 4\.00×/);
	assert.match(summary, /sm__throughput\.avg\.pct_of_peak_sustained_elapsed=71\.2%/);
	assert.match(summary, /not interpreted by this rule: smsp__warps_eligible\.avg\.per_cycle_active/);
	const huge = describeProfileBottleneck({ ...interpretation,
		uninterpretedCounters: Array.from({ length: 400 }, (_, index) => `counter_${index}`) });
	assert.equal(huge.length, PROFILE_SUMMARY_LIMIT, "an oversized counter list is truncated, not passed through");
});
