/**
 * Host-owned description of one target platform.
 *
 * Everything the harness knows about an accelerator lives in this file, never in
 * code: capacity constants carry the receipt of the device query that produced
 * them, alignment rules say whether they exist for correctness or for bandwidth,
 * and the legal API surface comes from the installed headers. Code that hardcodes
 * a chip constant cannot be checked against the machine it will run on, and the
 * published numbers for the same chip disagree with each other, so a profile
 * whose capacities have no probe receipt is rejected rather than trusted.
 *
 * The profile is supplied by the operator out of band. A model-facing session
 * can neither read nor write it: the execution tool environment is rebuilt
 * without the variable that names it, and the file lives outside the work root.
 */
import { readFile } from "node:fs/promises";
import { HarnessError } from "../types.ts";

export interface PlatformProbeReceiptV1 {
	/** Exact command that produced the value, run on the target device. */
	command: string;
	capturedAt: string;
	/** Host-owned file holding the raw command output. */
	outputPath: string;
}

export interface PlatformCapacityV1 {
	value: number;
	unit: string;
	probe: PlatformProbeReceiptV1;
}

/** Why a rule exists. A correctness rule and a bandwidth rule may not be merged. */
export type PlatformRulePurpose = "correctness" | "bandwidth" | "performance" | "integrity";

export type PlatformRuleV1 =
	| { id: string; purpose: PlatformRulePurpose; severity: "reject" | "warn"; appliesTo: string; message: string;
		kind: "forbid" | "require"; pattern: string; suggest?: string }
	| { id: string; purpose: PlatformRulePurpose; severity: "reject" | "warn"; appliesTo: string; message: string;
		kind: "forbidWithin" | "requireWithin"; region: string; pattern: string; suggest?: string }
	| { id: string; purpose: PlatformRulePurpose; severity: "reject" | "warn"; appliesTo: string; message: string;
		kind: "pairing"; open: string; close: string; suggest?: string }
	| { id: string; purpose: PlatformRulePurpose; severity: "reject" | "warn"; appliesTo: string; message: string;
		kind: "budget"; capacity: string; allocation: string; multiplier?: string; suggest?: string };

export interface PlatformDiagnosticClassV1 {
	id: string;
	pattern: string;
	/** Syntax-level, hardware-level and numeric failures move the next action to different places. */
	class: "syntax" | "hardware" | "numeric" | "infrastructure";
	/** Mechanical hint appended to the failing tool result; never a rewritten error. */
	hint?: string;
	/** Answer a missing-symbol error with the legal signatures nearest to the one used. */
	routeSymbols?: boolean;
}

export interface PlatformMetricV1 {
	name: string;
	/** Regular expression with one capture group holding the numeric value. */
	pattern: string;
}

export interface PlatformBottleneckLabelV1 {
	id: string;
	when: Array<{ metric: string; op: ">=" | "<=" | ">" | "<"; value: number }>;
	/** Ordered action classes for this label; the first entry is what to try first. */
	actions: string[];
}

export interface PlatformProfileV1 {
	version: 1;
	id: string;
	chip: string;
	toolchain: string;
	capacities: Record<string, PlatformCapacityV1>;
	editableSurface?: { allow: string[]; readOnly: string[]; singleFilePerTurn: boolean };
	symbols?: { namespaces: string[]; names: string[]; provenance: PlatformProbeReceiptV1 };
	rules: PlatformRuleV1[];
	diagnostics: PlatformDiagnosticClassV1[];
	metrics: PlatformMetricV1[];
	bottleneck?: { labels: PlatformBottleneckLabelV1[] };
	timing?: { protocolVersion: string; warmup: number; repeats: number; latencySource: string;
		metricSource: string; minRuntimeMs: number };
	precision?: { dtypes: Array<{ name: string; mantissaBits: number }>; maxRelaxation: number };
	cases?: { alignmentBytes: number; table: Array<{ id: string; elements: number; innermostBytes: number;
		dims: number; range: string }> };
	deviceSerialization?: { leaseFile: string; commandPattern: string; timeoutMs: number };
}

const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;
const PURPOSES = new Set(["correctness", "bandwidth", "performance", "integrity"]);
const SEVERITIES = new Set(["reject", "warn"]);
const OPS = new Set([">=", "<=", ">", "<"]);

function fail(message: string): never {
	throw new HarnessError("platform.profile", message);
}

function object(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
	return value as Record<string, unknown>;
}

function text(value: unknown, what: string, limit = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
		fail(`${what} must be a non-empty string of at most ${limit} characters`);
	return value;
}

function count(value: unknown, what: string, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min) fail(`${what} must be a number >= ${min}`);
	return value;
}

function array(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) fail(`${what} must be an array`);
	return value;
}

/** A rule is only usable if the harness can actually run its expressions. */
function expression(value: unknown, what: string): string {
	const pattern = text(value, what, 1_024);
	try {
		new RegExp(pattern, "gm");
	} catch {
		fail(`${what} is not a valid regular expression`);
	}
	return pattern;
}

function probe(value: unknown, what: string): PlatformProbeReceiptV1 {
	const raw = object(value, what);
	const capturedAt = text(raw.capturedAt, `${what}.capturedAt`, 64);
	if (Number.isNaN(Date.parse(capturedAt))) fail(`${what}.capturedAt must be a timestamp`);
	return { command: text(raw.command, `${what}.command`, 1_024), capturedAt,
		outputPath: text(raw.outputPath, `${what}.outputPath`, 1_024) };
}

function rule(value: unknown, index: number): PlatformRuleV1 {
	const raw = object(value, `rules[${index}]`);
	const id = text(raw.id, `rules[${index}].id`, 96);
	if (!ID.test(id)) fail(`rules[${index}].id must be a short identifier`);
	const purpose = text(raw.purpose, `rules[${index}].purpose`, 32);
	if (!PURPOSES.has(purpose)) fail(`rules[${index}].purpose must be one of ${[...PURPOSES].join(", ")}`);
	const severity = text(raw.severity, `rules[${index}].severity`, 16);
	if (!SEVERITIES.has(severity)) fail(`rules[${index}].severity must be reject or warn`);
	const common = {
		id, purpose: purpose as PlatformRulePurpose, severity: severity as "reject" | "warn",
		appliesTo: expression(raw.appliesTo, `rules[${index}].appliesTo`),
		message: text(raw.message, `rules[${index}].message`, 512),
		...(raw.suggest === undefined ? {} : { suggest: text(raw.suggest, `rules[${index}].suggest`, 512) }),
	};
	const kind = text(raw.kind, `rules[${index}].kind`, 32);
	if (kind === "forbid" || kind === "require")
		return { ...common, kind, pattern: expression(raw.pattern, `rules[${index}].pattern`) };
	if (kind === "forbidWithin" || kind === "requireWithin")
		return { ...common, kind, region: expression(raw.region, `rules[${index}].region`),
			pattern: expression(raw.pattern, `rules[${index}].pattern`) };
	if (kind === "pairing")
		return { ...common, kind, open: expression(raw.open, `rules[${index}].open`),
			close: expression(raw.close, `rules[${index}].close`) };
	if (kind === "budget")
		return { ...common, kind, capacity: text(raw.capacity, `rules[${index}].capacity`, 96),
			allocation: expression(raw.allocation, `rules[${index}].allocation`),
			...(raw.multiplier === undefined ? {} : { multiplier: expression(raw.multiplier, `rules[${index}].multiplier`) }) };
	return fail(`rules[${index}].kind is not a supported rule kind`);
}

function diagnostics(value: unknown): PlatformDiagnosticClassV1[] {
	return array(value, "diagnostics").map((item, index) => {
		const raw = object(item, `diagnostics[${index}]`);
		const kind = text(raw.class, `diagnostics[${index}].class`, 32);
		if (!["syntax", "hardware", "numeric", "infrastructure"].includes(kind))
			fail(`diagnostics[${index}].class must be syntax, hardware, numeric or infrastructure`);
		return {
			id: text(raw.id, `diagnostics[${index}].id`, 96),
			pattern: expression(raw.pattern, `diagnostics[${index}].pattern`),
			class: kind as PlatformDiagnosticClassV1["class"],
			...(raw.hint === undefined ? {} : { hint: text(raw.hint, `diagnostics[${index}].hint`, 512) }),
			...(raw.routeSymbols === undefined ? {} : { routeSymbols: raw.routeSymbols === true }),
		};
	});
}

function metrics(value: unknown): PlatformMetricV1[] {
	return array(value, "metrics").map((item, index) => {
		const raw = object(item, `metrics[${index}]`);
		const pattern = expression(raw.pattern, `metrics[${index}].pattern`);
		if (!/\((?!\?:)/.test(pattern)) fail(`metrics[${index}].pattern needs one capture group for the value`);
		return { name: text(raw.name, `metrics[${index}].name`, 96), pattern };
	});
}

function bottleneck(value: unknown, known: ReadonlySet<string>): NonNullable<PlatformProfileV1["bottleneck"]> {
	const raw = object(value, "bottleneck");
	const labels = array(raw.labels, "bottleneck.labels").map((item, index) => {
		const entry = object(item, `bottleneck.labels[${index}]`);
		const when = array(entry.when, `bottleneck.labels[${index}].when`).map((row, position) => {
			const condition = object(row, `bottleneck.labels[${index}].when[${position}]`);
			const metric = text(condition.metric, `bottleneck.labels[${index}].when[${position}].metric`, 96);
			if (!known.has(metric)) fail(`bottleneck.labels[${index}] uses metric ${metric}, which no metrics entry extracts`);
			const op = text(condition.op, `bottleneck.labels[${index}].when[${position}].op`, 2);
			if (!OPS.has(op)) fail(`bottleneck.labels[${index}].when[${position}].op must be one of ${[...OPS].join(", ")}`);
			return { metric, op: op as PlatformBottleneckLabelV1["when"][number]["op"],
				value: count(condition.value, `bottleneck.labels[${index}].when[${position}].value`, Number.NEGATIVE_INFINITY) };
		});
		if (!when.length) fail(`bottleneck.labels[${index}].when must hold at least one condition`);
		const actions = array(entry.actions, `bottleneck.labels[${index}].actions`)
			.map((action, position) => text(action, `bottleneck.labels[${index}].actions[${position}]`, 256));
		if (!actions.length) fail(`bottleneck.labels[${index}].actions must name at least one action class`);
		return { id: text(entry.id, `bottleneck.labels[${index}].id`, 96), when, actions };
	});
	if (!labels.length) fail("bottleneck.labels must hold at least one label");
	return { labels };
}

function timing(value: unknown): NonNullable<PlatformProfileV1["timing"]> {
	const raw = object(value, "timing");
	const latencySource = text(raw.latencySource, "timing.latencySource", 256);
	const metricSource = text(raw.metricSource, "timing.metricSource", 256);
	// One number per protocol: a profiler pass measures different work than the
	// timing pass, so a metric file may never double as the latency source.
	if (latencySource === metricSource) fail("timing.latencySource and timing.metricSource must be different passes");
	return {
		protocolVersion: text(raw.protocolVersion, "timing.protocolVersion", 96),
		warmup: count(raw.warmup, "timing.warmup", 1), repeats: count(raw.repeats, "timing.repeats", 2),
		latencySource, metricSource, minRuntimeMs: count(raw.minRuntimeMs, "timing.minRuntimeMs", 0),
	};
}

function precision(value: unknown): NonNullable<PlatformProfileV1["precision"]> {
	const raw = object(value, "precision");
	const dtypes = array(raw.dtypes, "precision.dtypes").map((item, index) => {
		const entry = object(item, `precision.dtypes[${index}]`);
		const mantissaBits = count(entry.mantissaBits, `precision.dtypes[${index}].mantissaBits`, 1);
		if (!Number.isInteger(mantissaBits) || mantissaBits > 52)
			fail(`precision.dtypes[${index}].mantissaBits must be an integer of at most 52`);
		return { name: text(entry.name, `precision.dtypes[${index}].name`, 64), mantissaBits };
	});
	if (!dtypes.length) fail("precision.dtypes must describe at least one dtype");
	const maxRelaxation = count(raw.maxRelaxation, "precision.maxRelaxation", 1);
	if (maxRelaxation > 10) fail("precision.maxRelaxation must not exceed 10x the dtype tolerance");
	return { dtypes, maxRelaxation };
}

function cases(value: unknown): NonNullable<PlatformProfileV1["cases"]> {
	const raw = object(value, "cases");
	const alignmentBytes = count(raw.alignmentBytes, "cases.alignmentBytes", 1);
	const table = array(raw.table, "cases.table").map((item, index) => {
		const entry = object(item, `cases.table[${index}]`);
		return {
			id: text(entry.id, `cases.table[${index}].id`, 128),
			elements: count(entry.elements, `cases.table[${index}].elements`, 1),
			innermostBytes: count(entry.innermostBytes, `cases.table[${index}].innermostBytes`, 1),
			dims: count(entry.dims, `cases.table[${index}].dims`, 1),
			range: text(entry.range, `cases.table[${index}].range`, 64),
		};
	});
	if (table.length < 4) fail("cases.table needs at least four cases to cover the four axes");
	// Without unaligned, differently shaped and differently scaled cases, a tail
	// mask bug and a shape-specialised implementation both pass every case.
	const unaligned = table.filter(row => row.innermostBytes % alignmentBytes !== 0).length;
	if (unaligned * 2 < table.length) fail("cases.table must leave at least half of its cases unaligned");
	const buckets = new Set(table.map(row => Math.floor(Math.log10(row.elements))));
	if (buckets.size < 3) fail("cases.table must span at least three element-count magnitudes");
	if (new Set(table.map(row => row.dims)).size < 2) fail("cases.table must cover at least two rank values");
	if (new Set(table.map(row => row.range)).size < 3) fail("cases.table must cover at least three value ranges");
	return { alignmentBytes, table };
}

export function parsePlatformProfile(value: unknown): PlatformProfileV1 {
	const raw = object(value, "platform profile");
	if (raw.version !== 1) fail("platform profile version must be 1");
	const id = text(raw.id, "id", 96);
	if (!ID.test(id)) fail("id must be a short identifier");
	const capacityEntries = Object.entries(object(raw.capacities, "capacities"));
	const capacities: Record<string, PlatformCapacityV1> = {};
	for (const [name, entry] of capacityEntries) {
		if (!ID.test(name)) fail(`capacities.${name} is not a usable capacity name`);
		const capacity = object(entry, `capacities.${name}`);
		capacities[name] = {
			value: count(capacity.value, `capacities.${name}.value`, 1),
			unit: text(capacity.unit, `capacities.${name}.unit`, 32),
			// The published constants for one chip contradict each other, so a
			// capacity without the device query that produced it is not evidence.
			probe: probe(capacity.probe, `capacities.${name}.probe`),
		};
	}
	const metricList = metrics(raw.metrics ?? []);
	const profile: PlatformProfileV1 = {
		version: 1, id,
		chip: text(raw.chip, "chip", 128),
		toolchain: text(raw.toolchain, "toolchain", 128),
		capacities,
		rules: array(raw.rules ?? [], "rules").map(rule),
		diagnostics: diagnostics(raw.diagnostics ?? []),
		metrics: metricList,
	};
	if (raw.editableSurface !== undefined) {
		const surface = object(raw.editableSurface, "editableSurface");
		const allow = array(surface.allow, "editableSurface.allow")
			.map((item, index) => expression(item, `editableSurface.allow[${index}]`));
		if (!allow.length) fail("editableSurface.allow must name at least one writable path pattern");
		profile.editableSurface = { allow,
			readOnly: array(surface.readOnly ?? [], "editableSurface.readOnly")
				.map((item, index) => expression(item, `editableSurface.readOnly[${index}]`)),
			singleFilePerTurn: surface.singleFilePerTurn === true };
	}
	if (raw.symbols !== undefined) {
		const symbols = object(raw.symbols, "symbols");
		const namespaces = array(symbols.namespaces, "symbols.namespaces")
			.map((item, index) => text(item, `symbols.namespaces[${index}]`, 96));
		const names = array(symbols.names, "symbols.names")
			.map((item, index) => text(item, `symbols.names[${index}]`, 192));
		if (!namespaces.length || !names.length) fail("symbols must list at least one namespace and one name");
		profile.symbols = { namespaces, names, provenance: probe(symbols.provenance, "symbols.provenance") };
	}
	if (raw.bottleneck !== undefined) profile.bottleneck = bottleneck(raw.bottleneck, new Set(metricList.map(item => item.name)));
	if (raw.timing !== undefined) profile.timing = timing(raw.timing);
	if (raw.precision !== undefined) profile.precision = precision(raw.precision);
	if (raw.cases !== undefined) profile.cases = cases(raw.cases);
	if (raw.deviceSerialization !== undefined) {
		const device = object(raw.deviceSerialization, "deviceSerialization");
		profile.deviceSerialization = {
			leaseFile: text(device.leaseFile, "deviceSerialization.leaseFile", 1_024),
			commandPattern: expression(device.commandPattern, "deviceSerialization.commandPattern"),
			timeoutMs: count(device.timeoutMs, "deviceSerialization.timeoutMs", 1_000),
		};
	}
	for (const item of profile.rules) {
		if (item.kind === "budget" && !profile.capacities[item.capacity])
			fail(`rules ${item.id} budgets against unknown capacity ${item.capacity}`);
	}
	return profile;
}

export async function loadPlatformProfile(file: string): Promise<PlatformProfileV1> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch (error) {
		throw new HarnessError("platform.profile", `platform profile could not be read as JSON: ${(error as NodeJS.ErrnoException)?.code ?? "parse error"}`);
	}
	return parsePlatformProfile(parsed);
}

export function platformCapacity(profile: PlatformProfileV1, name: string): PlatformCapacityV1 {
	const value = profile.capacities[name];
	if (!value) throw new HarnessError("platform.capacity", `platform ${profile.id} has no probed capacity named ${name}`);
	return value;
}

/**
 * Relative tolerance for one dtype, derived from its mantissa width instead of a
 * single global `allclose` bound. A per-operator relaxation is capped by the
 * profile so a hard case cannot quietly widen the gate until anything passes.
 */
export function platformTolerance(profile: PlatformProfileV1, dtype: string, relaxation = 1): number {
	const precision = profile.precision;
	if (!precision) throw new HarnessError("platform.precision", `platform ${profile.id} declares no precision table`);
	const entry = precision.dtypes.find(item => item.name === dtype);
	if (!entry) throw new HarnessError("platform.precision", `platform ${profile.id} declares no tolerance for dtype ${dtype}`);
	if (!Number.isFinite(relaxation) || relaxation < 1 || relaxation > precision.maxRelaxation)
		throw new HarnessError("platform.precision", `tolerance relaxation must be between 1 and ${precision.maxRelaxation}`);
	return relaxation * 2 ** -entry.mantissaBits;
}
