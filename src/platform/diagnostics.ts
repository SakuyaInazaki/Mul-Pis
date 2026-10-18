/**
 * Mechanical reading of toolchain and profiler output.
 *
 * Failure text is classified, deduplicated and routed; it is never rewritten.
 * A missing-symbol error becomes a lookup into the legal API surface, a
 * capacity error becomes the probed constant, and profiler counters become one
 * deterministic bottleneck label with its action class. When the counters do not
 * decide, the answer is `inconclusive` rather than a guess: a wrong bottleneck
 * label sends the next round into a rewrite that cannot help.
 */
import type { PlatformProfileV1 } from "./profile.ts";
import { nearestSymbols } from "./contract.ts";

export interface PlatformDiagnosisV1 {
	/** Failure classes matched in the output, in profile order, deduplicated. */
	classes: Array<{ id: string; class: "syntax" | "hardware" | "numeric" | "infrastructure"; hint?: string }>;
	/** Legal signatures nearest to a symbol the toolchain rejected. */
	symbolHints: Array<{ used: string; nearest: string[] }>;
	metrics: Record<string, number>;
	bottleneck?: { label: string; actions: string[] };
	/** True when metrics were present but no label's conditions held. */
	inconclusive: boolean;
}

function values(profile: PlatformProfileV1, text: string): Record<string, number> {
	const found: Record<string, number> = {};
	for (const metric of profile.metrics) {
		const match = new RegExp(metric.pattern, "m").exec(text);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value)) found[metric.name] = value;
	}
	return found;
}

function holds(op: ">=" | "<=" | ">" | "<", left: number, right: number): boolean {
	return op === ">=" ? left >= right : op === "<=" ? left <= right : op === ">" ? left > right : left < right;
}

/** First label whose conditions all hold on present metrics; otherwise nothing. */
export function classifyBottleneck(profile: PlatformProfileV1, metrics: Record<string, number>):
	{ label: string; actions: string[] } | undefined {
	for (const label of profile.bottleneck?.labels ?? []) {
		const decided = label.when.every(condition => {
			const value = metrics[condition.metric];
			return value !== undefined && holds(condition.op, value, condition.value);
		});
		if (decided) return { label: label.id, actions: [...label.actions] };
	}
	return undefined;
}

export function diagnosePlatformOutput(profile: PlatformProfileV1, text: string): PlatformDiagnosisV1 {
	const classes: PlatformDiagnosisV1["classes"] = [];
	const symbolHints: PlatformDiagnosisV1["symbolHints"] = [];
	const seenSymbols = new Set<string>();
	for (const entry of profile.diagnostics) {
		const expression = new RegExp(entry.pattern, "gm");
		let matched = false;
		for (const match of text.matchAll(expression)) {
			matched = true;
			const used = entry.routeSymbols ? match[1] : undefined;
			if (used && !seenSymbols.has(used)) {
				seenSymbols.add(used);
				symbolHints.push({ used, nearest: nearestSymbols(profile, used) });
			}
			if (!entry.routeSymbols) break;
		}
		if (matched) classes.push({ id: entry.id, class: entry.class, ...(entry.hint ? { hint: entry.hint } : {}) });
	}
	const metrics = values(profile, text);
	const bottleneck = classifyBottleneck(profile, metrics);
	return { classes, symbolHints, metrics, ...(bottleneck ? { bottleneck } : {}),
		inconclusive: Object.keys(metrics).length > 0 && !bottleneck };
}

export function hasPlatformDiagnosis(diagnosis: PlatformDiagnosisV1): boolean {
	return diagnosis.classes.length > 0 || diagnosis.symbolHints.length > 0 ||
		diagnosis.bottleneck !== undefined || diagnosis.inconclusive;
}

/**
 * Render the diagnosis as a short, bounded block appended after the original
 * output. The original bytes stay above it untouched, so every line can still be
 * traced to the toolchain that produced it.
 */
export function describePlatformDiagnosis(profile: PlatformProfileV1, diagnosis: PlatformDiagnosisV1): string {
	const lines: string[] = [`platform ${profile.id} (${profile.chip}, ${profile.toolchain}) mechanical read of the output above`];
	for (const entry of diagnosis.classes)
		lines.push(`class ${entry.class}: ${entry.id}${entry.hint ? ` — ${entry.hint}` : ""}`);
	for (const entry of diagnosis.symbolHints)
		lines.push(entry.nearest.length
			? `symbol ${entry.used} is not declared; nearest declared: ${entry.nearest.join(", ")}`
			: `symbol ${entry.used} is not declared and nothing in the extracted API surface is close to it`);
	if (diagnosis.bottleneck)
		lines.push(`bottleneck ${diagnosis.bottleneck.label} from ${Object.entries(diagnosis.metrics)
			.map(([name, value]) => `${name}=${value}`).sort().join(" ")}; action order: ${diagnosis.bottleneck.actions.join(" → ")}`);
	else if (diagnosis.inconclusive)
		lines.push(`bottleneck inconclusive from ${Object.entries(diagnosis.metrics)
			.map(([name, value]) => `${name}=${value}`).sort().join(" ")}; do not rewrite on a guessed bottleneck`);
	return lines.join("\n");
}
