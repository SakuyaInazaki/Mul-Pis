/**
 * The measurement contract derived from the platform profile.
 *
 * A task contract used to choose its own warmup, repeat count, tolerance and
 * case table. Two latencies produced under two such contracts were then
 * compared as if they meant the same thing, and a single global absolute
 * tolerance let a degenerate implementation through. The platform profile
 * already carries probed facts with a version on them, so the host derives the
 * binding from it and the task contract may only agree with it.
 *
 * Nothing here measures anything or decides a candidate. It turns probed
 * platform facts into the exact numbers the evaluator must enforce, and it
 * refuses to produce a binding when the profile does not carry them.
 */
import { HarnessError } from "../types.ts";
import { platformTolerance, type PlatformProfileV1 } from "../platform/profile.ts";

export interface PlatformBoundCaseV1 {
	id: string;
	elements: number;
	innermostBytes: number;
	dims: number;
	range: string;
	/** Innermost byte count against the profile's alignment, not a guess. */
	aligned: boolean;
	/** Reserved cases never reach the candidate: they exist to certify it. */
	set: "iteration" | "certification";
}

export interface PlatformTaskBindingV1 {
	version: 1;
	kind: "platform-task-binding";
	profileId: string;
	chip: string;
	toolchain: string;
	/** Every latency carries this; two numbers from two versions never compare. */
	protocolVersion: string;
	timing: { warmup: number; repeats: number; minimumSampleSeconds: number;
		latencySource: string; metricSource: string };
	tolerance: { dtype: string; mantissaRelative: number; firstScreenMaxMultiplier: number;
		smallValueFloor: number; cancellationFraction: number; goldenErrorRatio: number };
	cases: PlatformBoundCaseV1[];
	/** Share of unaligned cases, recomputed here rather than trusted. */
	unalignedFraction: number;
	bottleneckLabels: string[];
}

/** Published CANN Bench screen: mean relative error under the dtype bound, and
 * no single element beyond ten times it, so one outlier cannot by itself reject
 * an otherwise correct tensor. The two region constants below have no published
 * calibration, so they are stated here to be measured against, not believed. */
const FIRST_SCREEN_MAX_MULTIPLIER = 10;
const SMALL_VALUE_FLOOR = 2 ** -14;
const CANCELLATION_FRACTION = 2 ** -10;
const GOLDEN_ERROR_RATIO = 2;
/** Public cases per operator in the published split; the rest certify. */
const PUBLIC_CASES = 20;
/** The evaluator's own frozen protocol floors, mirrored so a profile that
 * cannot meet them is refused here with a readable reason instead of producing
 * a contract the evaluator will reject. `test/m07-platform-task-contract.test.ts`
 * asserts these still match `scripts/local-operator-stage.py`. */
export const BINDING_MINIMUM_WARMUP = 10;
export const BINDING_MINIMUM_REPEATS = 30;

export interface PlatformBindingOptions {
	/** Which declared dtype the tolerance is derived from. */
	dtype: string;
	/** Per-operator relaxation, capped by the profile's own maxRelaxation. */
	relaxation?: number;
	publicCases?: number;
}

function fail(message: string): never {
	throw new HarnessError("m07.platform-binding", message);
}

/**
 * Derive the binding, or refuse. A profile without a timing protocol, a
 * precision table or a case table cannot bind a measurement contract, and
 * saying so is more useful than falling back to whatever the task wrote.
 */
export function derivePlatformTaskBinding(profile: PlatformProfileV1,
	options: PlatformBindingOptions): PlatformTaskBindingV1 {
	const timing = profile.timing ?? fail(`platform ${profile.id} declares no timing protocol; it cannot bind a measurement contract`);
	const cases = profile.cases ?? fail(`platform ${profile.id} declares no case table`);
	if (!profile.precision) fail(`platform ${profile.id} declares no precision table`);
	// Timing and counters must come from two passes: an instrumented run is a
	// different measurement, not a cheaper way to read the same latency.
	if (timing.latencySource === timing.metricSource)
		fail(`platform ${profile.id} reads latency and counters from the same source; they must be separate passes`);
	if (!cases.table.length) fail(`platform ${profile.id} declares an empty case table`);
	if (timing.warmup < BINDING_MINIMUM_WARMUP || timing.repeats < BINDING_MINIMUM_REPEATS)
		fail(`platform ${profile.id} declares warmup ${timing.warmup} and ${timing.repeats} repeats, below the evaluator's frozen floor of ${BINDING_MINIMUM_WARMUP} and ${BINDING_MINIMUM_REPEATS}; reprobe the protocol rather than lower the floor`);
	const publicCases = options.publicCases ?? PUBLIC_CASES;
	if (!Number.isSafeInteger(publicCases) || publicCases < 1) fail("public case count must be a positive integer");
	const bound = cases.table.map((item, index): PlatformBoundCaseV1 => ({
		id: item.id, elements: item.elements, innermostBytes: item.innermostBytes,
		dims: item.dims, range: item.range,
		aligned: item.innermostBytes % cases.alignmentBytes === 0,
		set: index < publicCases ? "iteration" : "certification",
	}));
	const unaligned = bound.filter(item => !item.aligned).length / bound.length;
	if (!bound.some(item => item.set === "iteration"))
		fail("the derived binding has no iteration case");
	const mantissaRelative = platformTolerance(profile, options.dtype, options.relaxation ?? 1);
	return { version: 1, kind: "platform-task-binding", profileId: profile.id, chip: profile.chip,
		toolchain: profile.toolchain, protocolVersion: timing.protocolVersion,
		timing: { warmup: timing.warmup, repeats: timing.repeats,
			minimumSampleSeconds: timing.minRuntimeMs / 1000,
			latencySource: timing.latencySource, metricSource: timing.metricSource },
		tolerance: { dtype: options.dtype, mantissaRelative,
			firstScreenMaxMultiplier: FIRST_SCREEN_MAX_MULTIPLIER,
			smallValueFloor: SMALL_VALUE_FLOOR, cancellationFraction: CANCELLATION_FRACTION,
			goldenErrorRatio: GOLDEN_ERROR_RATIO },
		cases: bound, unalignedFraction: unaligned,
		bottleneckLabels: (profile.bottleneck?.labels ?? []).map(label => label.id) };
}

/** One line per fact a reader would otherwise have to reconstruct from JSON. */
export function describePlatformTaskBinding(binding: PlatformTaskBindingV1): string[] {
	const iteration = binding.cases.filter(item => item.set === "iteration").length;
	return [
		`Measurement protocol ${binding.protocolVersion} on ${binding.profileId} (${binding.chip}, ${binding.toolchain}): warmup ${binding.timing.warmup}, repeats ${binding.timing.repeats}, latency read from ${binding.timing.latencySource} and counters from ${binding.timing.metricSource} in a separate pass. A latency from another protocol version is not comparable with these.`,
		`Tolerance for ${binding.tolerance.dtype} is ${binding.tolerance.mantissaRelative} from the declared mantissa width, with no element beyond ${binding.tolerance.firstScreenMaxMultiplier}x it. Small-value and cancellation regions fall back to counting errors against a same-precision golden at a ratio of ${binding.tolerance.goldenErrorRatio}; those two region constants are uncalibrated and are recorded so they can be measured.`,
		`Case table: ${iteration} iteration and ${binding.cases.length - iteration} certification cases, ${(binding.unalignedFraction * 100).toFixed(0)}% unaligned by the profile's own alignment.`,
	];
}
