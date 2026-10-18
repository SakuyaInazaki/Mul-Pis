import assert from "node:assert/strict";
import test from "node:test";
import { checkPlatformSource, describePlatformFindings, nearestSymbols, platformEditable } from "../../src/platform/contract.ts";
import { diagnosePlatformOutput, describePlatformDiagnosis, classifyBottleneck } from "../../src/platform/diagnostics.ts";
import { parsePlatformProfile, platformCapacity, platformTolerance } from "../../src/platform/profile.ts";
import { profileFixture, probe } from "./profile-fixture.ts";

const LEGAL_KERNEL = `#include "device_api.h"
constexpr int BUFFER_NUM = 2;
__device__ void CopyIn() {
  pipe.InitBuffer(inQueue, 65536);
  DeviceApi::DataCopy(dst, src, 256);
  inQueue.EnQue(local);
}
__device__ void Compute() {
  inQueue.DeQue(local);
  DeviceApi::SoftMax(dst, src);
  int tailLength = total % tileLength;
}
void Launch() { SetBlockDim(coreCount); }
`;

test("a capacity without a device probe is not a capacity", () => {
	const raw = profileFixture();
	const capacities = raw.capacities as Record<string, Record<string, unknown>>;
	delete capacities.unified_buffer_bytes.probe;
	assert.throws(() => parsePlatformProfile(raw), /capacities\.unified_buffer_bytes\.probe must be an object/);
	const good = parsePlatformProfile(profileFixture());
	assert.equal(platformCapacity(good, "unified_buffer_bytes").value, 196_352);
	assert.equal(platformCapacity(good, "unified_buffer_bytes").probe.command, "device-query --unified-buffer-bytes");
	assert.throws(() => platformCapacity(good, "l1_bytes"), /no probed capacity named l1_bytes/);
});

test("the case table must satisfy the four axes before any case is used", () => {
	const aligned = profileFixture();
	(aligned.cases as { table: Array<{ innermostBytes: number }> }).table.forEach(row => { row.innermostBytes = 1_024; });
	assert.throws(() => parsePlatformProfile(aligned), /at least half of its cases unaligned/);
	const flat = profileFixture();
	(flat.cases as { table: Array<{ elements: number }> }).table.forEach(row => { row.elements = 1_000_000; });
	assert.throws(() => parsePlatformProfile(flat), /three element-count magnitudes/);
	const oneRank = profileFixture();
	(oneRank.cases as { table: Array<{ dims: number }> }).table.forEach(row => { row.dims = 2; });
	assert.throws(() => parsePlatformProfile(oneRank), /two rank values/);
	const oneRange = profileFixture();
	(oneRange.cases as { table: Array<{ range: string }> }).table.forEach(row => { row.range = "small-symmetric"; });
	assert.throws(() => parsePlatformProfile(oneRange), /three value ranges/);
});

test("timing and metric passes stay separate and tolerance follows the dtype", () => {
	const merged = profileFixture();
	(merged.timing as { metricSource: string }).metricSource = "step_trace.csv:computing";
	assert.throws(() => parsePlatformProfile(merged), /must be different passes/);
	const loose = profileFixture();
	(loose.precision as { maxRelaxation: number }).maxRelaxation = 25;
	assert.throws(() => parsePlatformProfile(loose), /must not exceed 10x/);
	const profile = parsePlatformProfile(profileFixture());
	assert.equal(platformTolerance(profile, "fp16"), 2 ** -10);
	assert.equal(platformTolerance(profile, "fp32", 4), 4 * 2 ** -13);
	assert.throws(() => platformTolerance(profile, "fp32", 11), /between 1 and 10/);
	assert.throws(() => platformTolerance(profile, "fp8"), /no tolerance for dtype fp8/);
});

test("rules may not reference a capacity or metric the profile does not have", () => {
	const unknownCapacity = profileFixture();
	(unknownCapacity.rules as Array<Record<string, unknown>>)
		.filter(rule => rule.kind === "budget").forEach(rule => { rule.capacity = "l0c_bytes"; });
	assert.throws(() => parsePlatformProfile(unknownCapacity), /budgets against unknown capacity l0c_bytes/);
	const unknownMetric = profileFixture();
	(unknownMetric.bottleneck as { labels: Array<{ when: Array<{ metric: string }> }> })
		.labels[0].when[0].metric = "cube_ratio";
	assert.throws(() => parsePlatformProfile(unknownMetric), /no metrics entry extracts/);
});

test("a legal kernel passes and each contract violation is reported once with its purpose", () => {
	const profile = parsePlatformProfile(profileFixture());
	const clean = checkPlatformSource(profile, "kernel/elementwise.cpp", LEGAL_KERNEL);
	assert.deepEqual(clean.findings, []);
	assert.equal(clean.allowed, true);

	const broken = checkPlatformSource(profile, "kernel/elementwise.cpp", `constexpr int BUFFER_NUM = 2;
pipe.InitBuffer(inQueue, 120000);
DeviceApi::DataCopy(dst, src, 33);
DeviceApi::Softmax(dst, src);
inQueue.EnQue(local);
inQueue.EnQue(other);
inQueue.DeQue(local);
// stride-unaligned
void Launch() { SetBlockDim(1); }
`);
	assert.equal(broken.allowed, false);
	const byRule = new Map(broken.findings.map(item => [item.ruleId, item]));
	assert.equal(byRule.get("single-core-launch")?.purpose, "performance");
	assert.equal(byRule.get("copy-length-alignment")?.purpose, "correctness");
	// The bandwidth rule stays a warning and never masquerades as a compile requirement.
	assert.equal(byRule.get("innermost-stride-bandwidth")?.purpose, "bandwidth");
	assert.equal(byRule.get("innermost-stride-bandwidth")?.severity, "warn");
	assert.match(byRule.get("queue-balance")?.message ?? "", /2 open, 1 close/);
	assert.match(byRule.get("buffer-budget")?.message ?? "", /240000 byte requested, 196352 byte probed on Device A rev 2/);
	assert.equal(byRule.get("tail-mask")?.severity, "reject");
	// A hallucinated call is answered with the nearest declared name, not a retry.
	assert.equal(byRule.get("platform.symbol")?.suggestion, "nearest declared: SoftMax");
	assert.match(byRule.get("platform.symbol")?.message ?? "", /not in the API surface extracted from the installed Toolchain 8\.3\.RC1 headers/);
	assert.equal(byRule.get("single-core-launch")?.line, 9);
	const text = describePlatformFindings(profile, broken);
	assert.match(text, /^platform device-a \(Device A rev 2, Toolchain 8\.3\.RC1\) contract check/);
	assert.match(text, /REJECTED kernel\/elementwise\.cpp:3 \[copy-length-alignment\/correctness\]/);
	assert.match(text, /WARNING kernel\/elementwise\.cpp:8 \[innermost-stride-bandwidth\/bandwidth\]/);
});

test("rules apply only where the profile says, and the host surface covers cheating", () => {
	const profile = parsePlatformProfile(profileFixture());
	// Kernel rules do not fire on the binding file, and vice versa.
	assert.deepEqual(checkPlatformSource(profile, "binding/module.cpp",
		`PYBIND11_MODULE(m, handle) {
  EXEC_DEVICE_CMD(kernel, stream, args);
}`).findings, []);
	const cheating = checkPlatformSource(profile, "binding/module.cpp",
		`PYBIND11_MODULE(m, handle) {
  auto out = framework::softmax(input);
}`);
	assert.equal(cheating.allowed, false);
	assert.deepEqual(cheating.findings.map(item => item.ruleId).sort(), ["device-launch-present", "no-framework-fallback"]);
	assert.equal(platformEditable(profile, "kernel/elementwise.cpp"), true);
	assert.equal(platformEditable(profile, "verify/reference.py"), false);
	assert.equal(platformEditable(profile, "host/tiling.cpp"), false);
	assert.equal(platformEditable(profile, "kernel/nested/other.cpp"), false);
	assert.deepEqual(nearestSymbols(profile, "DataCopyPadded"), ["DataCopyPad", "DataCopy"]);
	assert.deepEqual(nearestSymbols(profile, "CompletelyUnrelatedName"), []);
});

test("toolchain output is classified and routed without being rewritten", () => {
	const profile = parsePlatformProfile(profileFixture());
	const diagnosis = diagnosePlatformOutput(profile,
		"error: no member named 'Softmax' in namespace 'DeviceApi'\nerror: no member named 'DataCopyPadded' in namespace 'DeviceApi'");
	assert.deepEqual(diagnosis.classes, [{ id: "missing-symbol", class: "syntax",
		hint: "look the call up in the extracted API surface instead of retrying" }]);
	assert.deepEqual(diagnosis.symbolHints, [
		{ used: "Softmax", nearest: ["SoftMax"] },
		{ used: "DataCopyPadded", nearest: ["DataCopyPad", "DataCopy"] },
	]);
	assert.equal(diagnosis.inconclusive, false);
	const text = describePlatformDiagnosis(profile, diagnosis);
	assert.match(text, /symbol Softmax is not declared; nearest declared: SoftMax/);

	const infrastructure = diagnosePlatformOutput(profile, "device is busy or unavailable");
	assert.deepEqual(infrastructure.classes.map(entry => entry.class), ["infrastructure"]);
});

test("the bottleneck label is decided by the counters or left inconclusive", () => {
	const profile = parsePlatformProfile(profileFixture());
	assert.deepEqual(classifyBottleneck(profile, { mte2_ratio: 0.63, vector_ratio: 0.26 }),
		{ label: "transfer", actions: ["alignment", "coalescing", "double-buffer", "copy-compute-overlap"] });
	assert.equal(classifyBottleneck(profile, { mte2_ratio: 0.2, vector_ratio: 0.3 }), undefined);
	const unclear = diagnosePlatformOutput(profile, "mte2_ratio: 0.21\nvector_ratio: 0.18");
	assert.equal(unclear.inconclusive, true);
	assert.match(describePlatformDiagnosis(profile, unclear), /bottleneck inconclusive from mte2_ratio=0.21 vector_ratio=0.18; do not rewrite on a guessed bottleneck/);
	const decided = diagnosePlatformOutput(profile, "mte2_ratio: 0.63\nvector_ratio: 0.26");
	assert.match(describePlatformDiagnosis(profile, decided), /bottleneck transfer from mte2_ratio=0.63 vector_ratio=0.26; action order: alignment → coalescing → double-buffer → copy-compute-overlap/);
	// Output with no counters at all is silence, not an inconclusive verdict.
	assert.equal(diagnosePlatformOutput(profile, "build succeeded").inconclusive, false);
});

test("a profile is rejected outright when its parts cannot be evaluated", () => {
	const brokenPattern = profileFixture();
	(brokenPattern.rules as Array<Record<string, unknown>>)[0].pattern = "SetBlockDim(";
	assert.throws(() => parsePlatformProfile(brokenPattern), /not a valid regular expression/);
	const noCapture = profileFixture();
	(noCapture.metrics as Array<Record<string, unknown>>)[0].pattern = "mte2_ratio";
	assert.throws(() => parsePlatformProfile(noCapture), /needs one capture group/);
	const noProvenance = profileFixture();
	delete (noProvenance.symbols as Record<string, unknown>).provenance;
	assert.throws(() => parsePlatformProfile(noProvenance), /symbols\.provenance must be an object/);
	const badProbe = profileFixture();
	(noProvenance.symbols as Record<string, unknown>).provenance = probe("x");
	((badProbe.capacities as Record<string, Record<string, Record<string, unknown>>>)
		.unified_buffer_bytes.probe).capturedAt = "not-a-time";
	assert.throws(() => parsePlatformProfile(badProbe), /capturedAt must be a timestamp/);
});
