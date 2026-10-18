import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BINDING_MINIMUM_REPEATS, BINDING_MINIMUM_WARMUP, derivePlatformTaskBinding,
	describePlatformTaskBinding } from "../src/m07/platform-task-contract.ts";
import { parsePlatformProfile } from "../src/platform/profile.ts";
import { profileFixture } from "./platform/profile-fixture.ts";

/** The fixture's probed protocol is below the evaluator's floor, which is the
 * point of one of the tests; everything else starts from a conforming copy. */
function profile(change: (raw: Record<string, unknown>) => void = () => {}) {
	const raw = profileFixture() as unknown as Record<string, unknown>;
	(raw.timing as Record<string, unknown>).warmup = 10;
	(raw.timing as Record<string, unknown>).repeats = 30;
	change(raw);
	return parsePlatformProfile(raw);
}

test("the measurement contract comes from the probed profile, not from the task", () => {
	const binding = derivePlatformTaskBinding(profile(), { dtype: "fp16" });
	assert.equal(binding.protocolVersion, "device-a-timing-1");
	assert.equal(binding.timing.warmup, 10);
	assert.equal(binding.timing.repeats, 30);
	assert.equal(binding.timing.minimumSampleSeconds, 0.015);
	// Latency and counters must stay two passes: an instrumented run measures
	// something else, however convenient reading both at once would be.
	assert.equal(binding.timing.latencySource, "step_trace.csv:computing");
	assert.equal(binding.timing.metricSource, "kernel_details.csv");
	// 2^-10 for a ten-bit mantissa, not a global allclose bound.
	assert.equal(binding.tolerance.mantissaRelative, 2 ** -10);
	assert.equal(derivePlatformTaskBinding(profile(), { dtype: "fp32" }).tolerance.mantissaRelative, 2 ** -13);
	assert.equal(binding.bottleneckLabels.join(","), "transfer,vector");
	assert.match(describePlatformTaskBinding(binding).join(" "), /Measurement protocol device-a-timing-1/);
	assert.match(describePlatformTaskBinding(binding).join(" "), /uncalibrated/);
});

test("a case table binds its alignment split and reserves its certification half", () => {
	const binding = derivePlatformTaskBinding(profile(), { dtype: "fp16", publicCases: 2 });
	assert.deepEqual(binding.cases.map(item => item.set), ["iteration", "iteration", "certification", "certification", "certification"]);
	// 512-byte alignment on the fixture's own table: only c1 and c4 are aligned.
	assert.deepEqual(binding.cases.filter(item => item.aligned).map(item => item.id), ["c1", "c4"]);
	assert.equal(binding.unalignedFraction, 0.6);
	assert.equal(derivePlatformTaskBinding(profile(), { dtype: "fp16" }).cases.every(item => item.set === "iteration"), true,
		"a table smaller than the public split reserves nothing, and says so by having no certification case");
});

test("a profile that cannot state a measurement contract is refused, not patched", () => {
	assert.throws(() => derivePlatformTaskBinding(profile(raw => { delete raw.timing; }), { dtype: "fp16" }),
		/declares no timing protocol/);
	assert.throws(() => derivePlatformTaskBinding(profile(raw => { delete raw.cases; }), { dtype: "fp16" }),
		/declares no case table/);
	assert.throws(() => derivePlatformTaskBinding(profile(raw => { delete raw.precision; }), { dtype: "fp16" }),
		/declares no precision table/);
	assert.throws(() => derivePlatformTaskBinding(profile(), { dtype: "bf16" }), /no tolerance for dtype bf16/);
	assert.throws(() => derivePlatformTaskBinding(profile(raw =>
		{ (raw.timing as Record<string, unknown>).metricSource = "step_trace.csv:computing"; }), { dtype: "fp16" }),
		/must be different passes/);
	// The probed fixture protocol itself is below the evaluator's floor.
	assert.throws(() => derivePlatformTaskBinding(parsePlatformProfile(profileFixture()), { dtype: "fp16" }),
		/below the evaluator's frozen floor of 10 and 30/);
	assert.throws(() => derivePlatformTaskBinding(profile(), { dtype: "fp16", relaxation: 100 }),
		/relaxation must be between 1 and 10/);
});

test("the binding's mirrored floors still match the evaluator's own constants", async () => {
	const evaluator = await readFile(new URL("../scripts/local-operator-stage.py", import.meta.url), "utf8");
	const read = (name: string): number => {
		const match = new RegExp(`^${name} = ([0-9]+)$`, "m").exec(evaluator);
		assert.ok(match, `${name} is no longer a plain constant in the evaluator`);
		return Number(match![1]);
	};
	assert.equal(read("MINIMUM_WARMUP"), BINDING_MINIMUM_WARMUP);
	assert.equal(read("MINIMUM_REPEATS"), BINDING_MINIMUM_REPEATS);
});
