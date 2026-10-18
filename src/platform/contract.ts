/**
 * Static contract checks run between generation and compilation.
 *
 * On an accelerator whose compiler is slow and whose error text does not point
 * at the offending source line, most first-round failures are contract
 * violations that can be decided from the text alone: a symbol that does not
 * exist, an allocation larger than the probed on-chip capacity, an unpaired
 * queue, a missing tail-block branch, calculation left on the host side. Those
 * are rejected here, for free, instead of consuming a device slot, and the
 * rejection names the rule and the nearest legal alternative so the next attempt
 * is directed rather than random.
 *
 * Every rule and every constant comes from the platform profile. This module
 * knows how to evaluate rules; it knows nothing about any particular chip.
 */
import type { PlatformProfileV1, PlatformRulePurpose, PlatformRuleV1 } from "./profile.ts";

export interface PlatformFindingV1 {
	ruleId: string;
	severity: "reject" | "warn";
	purpose: PlatformRulePurpose;
	path: string;
	line?: number;
	message: string;
	/** Exact matched text, bounded. Never a rewritten description of it. */
	evidence: string;
	suggestion?: string;
}

const EVIDENCE_CHARS = 160;

function clip(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= EVIDENCE_CHARS ? flat : `${flat.slice(0, EVIDENCE_CHARS)}…`;
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let position = 0; position < index && position < source.length; position++)
		if (source[position] === "\n") line++;
	return line;
}

function matches(pattern: string, source: string): Array<{ text: string; index: number }> {
	const expression = new RegExp(pattern, "gm");
	const found: Array<{ text: string; index: number }> = [];
	for (const match of source.matchAll(expression)) found.push({ text: match[0], index: match.index ?? 0 });
	return found;
}

function numbers(pattern: string, source: string): number[] {
	const expression = new RegExp(pattern, "gm");
	const values: number[] = [];
	for (const match of source.matchAll(expression)) {
		const raw = match[1] ?? match[0];
		const value = Number(raw);
		if (Number.isFinite(value)) values.push(value);
	}
	return values;
}

function distance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const current = previous[j];
			previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1,
				diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = current;
		}
	}
	return previous[right.length];
}

/** Legal names closest to one the model used, so a wrong call becomes a lookup. */
export function nearestSymbols(profile: PlatformProfileV1, name: string, limit = 3): string[] {
	if (!profile.symbols) return [];
	return profile.symbols.names
		.map(candidate => ({ candidate, score: distance(name.toLowerCase(), candidate.split("(")[0].toLowerCase()) }))
		.sort((left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate))
		.slice(0, limit)
		.filter(entry => entry.score <= Math.max(3, Math.ceil(name.length / 2)))
		.map(entry => entry.candidate);
}

function finding(rule: PlatformRuleV1, path: string, message: string, evidence: string, line?: number): PlatformFindingV1 {
	return { ruleId: rule.id, severity: rule.severity, purpose: rule.purpose, path,
		...(line === undefined ? {} : { line }), message, evidence: clip(evidence),
		...(rule.suggest ? { suggestion: rule.suggest } : {}) };
}

function evaluate(rule: PlatformRuleV1, profile: PlatformProfileV1, path: string, source: string): PlatformFindingV1[] {
	if (rule.kind === "forbid")
		return matches(rule.pattern, source).map(match => finding(rule, path, rule.message, match.text, lineOf(source, match.index)));
	if (rule.kind === "require")
		return matches(rule.pattern, source).length ? [] : [finding(rule, path, rule.message, rule.pattern)];
	if (rule.kind === "forbidWithin" || rule.kind === "requireWithin") {
		const found: PlatformFindingV1[] = [];
		const regions = matches(rule.region, source);
		if (!regions.length) return rule.kind === "requireWithin" ? [finding(rule, path, `${rule.message} (no region matched)`, rule.region)] : [];
		for (const region of regions) {
			const inner = matches(rule.pattern, region.text);
			if (rule.kind === "forbidWithin")
				for (const hit of inner) found.push(finding(rule, path, rule.message, hit.text, lineOf(source, region.index + hit.index)));
			else if (!inner.length) found.push(finding(rule, path, rule.message, region.text, lineOf(source, region.index)));
		}
		return found;
	}
	if (rule.kind === "pairing") {
		const open = matches(rule.open, source).length;
		const close = matches(rule.close, source).length;
		return open === close ? [] : [finding(rule, path, `${rule.message} (${open} open, ${close} close)`, `${open}/${close}`)];
	}
	if (rule.kind !== "budget") return [];
	const capacity = profile.capacities[rule.capacity];
	if (!capacity) return [];
	const allocated = numbers(rule.allocation, source).reduce((total, value) => total + value, 0);
	if (!allocated) return [];
	const multiplier = rule.multiplier ? numbers(rule.multiplier, source)[0] ?? 1 : 1;
	const total = allocated * multiplier;
	return total <= capacity.value ? [] : [finding(rule, path,
		`${rule.message} (${total} ${capacity.unit} requested, ${capacity.value} ${capacity.unit} probed on ${profile.chip})`,
		`${total} > ${capacity.value}`)];
}

function symbolFindings(profile: PlatformProfileV1, path: string, source: string): PlatformFindingV1[] {
	const symbols = profile.symbols;
	if (!symbols) return [];
	const legal = new Set(symbols.names.map(name => name.split("(")[0]));
	const found: PlatformFindingV1[] = [];
	const seen = new Set<string>();
	for (const namespace of symbols.namespaces) {
		const expression = new RegExp(`${namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([A-Za-z_][A-Za-z0-9_]*)`, "gm");
		for (const match of source.matchAll(expression)) {
			const name = match[1];
			if (legal.has(name) || seen.has(`${namespace}${name}`)) continue;
			seen.add(`${namespace}${name}`);
			const nearest = nearestSymbols(profile, name);
			found.push({
				ruleId: "platform.symbol", severity: "reject", purpose: "correctness", path,
				line: lineOf(source, match.index ?? 0),
				message: `${namespace}${name} is not in the API surface extracted from the installed ${profile.toolchain} headers`,
				evidence: clip(match[0]),
				...(nearest.length ? { suggestion: `nearest declared: ${nearest.join(", ")}` } : {}),
			});
		}
	}
	return found;
}

export interface PlatformVerdictV1 {
	path: string;
	allowed: boolean;
	findings: PlatformFindingV1[];
}

/** Check one candidate file against the profile. Pure, so it costs no device time. */
export function checkPlatformSource(profile: PlatformProfileV1, relativePath: string, source: string): PlatformVerdictV1 {
	const findings: PlatformFindingV1[] = [];
	for (const rule of profile.rules) {
		if (!new RegExp(rule.appliesTo).test(relativePath)) continue;
		findings.push(...evaluate(rule, profile, relativePath, source));
	}
	findings.push(...symbolFindings(profile, relativePath, source));
	findings.sort((left, right) => (left.line ?? 0) - (right.line ?? 0) || left.ruleId.localeCompare(right.ruleId));
	return { path: relativePath, allowed: !findings.some(item => item.severity === "reject"), findings };
}

/** One rejection line per finding: location, violated contract, what to do next. */
export function describePlatformFindings(profile: PlatformProfileV1, verdict: PlatformVerdictV1): string {
	const lines = verdict.findings.map(item =>
		`${item.severity === "reject" ? "REJECTED" : "WARNING"} ${item.path}:${item.line ?? 0} [${item.ruleId}/${item.purpose}] ${item.message}` +
		` | evidence: ${item.evidence}${item.suggestion ? ` | ${item.suggestion}` : ""}`);
	return [`platform ${profile.id} (${profile.chip}, ${profile.toolchain}) contract check`, ...lines].join("\n");
}

/**
 * Whether the agent may edit this path at all. The evaluation surface and the
 * generated host scaffolding stay read-only: rewriting them every round is how a
 * contract layer loses the correctness it was supposed to provide.
 */
export function platformEditable(profile: PlatformProfileV1, relativePath: string): boolean {
	const surface = profile.editableSurface;
	if (!surface) return true;
	if (surface.readOnly.some(pattern => new RegExp(pattern).test(relativePath))) return false;
	return surface.allow.some(pattern => new RegExp(pattern).test(relativePath));
}
