import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Counting the failures the project actually hit.
 *
 * The cheapest knowledge asset in the evidence is an offline failure-rule list:
 * one short imperative sentence per repeated failure, kept only when the same
 * failure occurred at least three times. It beat same-length official API
 * documentation in every model tested, and on Ascend it was the one component
 * that raised the success rate and lowered the cost at the same time.
 *
 * The counting must be deterministic, because the whole point is that a rule is
 * kept for having happened repeatedly, not for sounding plausible. This module
 * normalises error text into a signature, counts signatures, and produces
 * drafts. It never writes to the store: M04 decides whether a counted signature
 * becomes a `rule` card, and the admission gate still applies.
 */

/** Only UTF-8 text is scanned; a binary artifact is not a failure log. */
function textFile(bytes: Uint8Array): boolean {
	try { return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
	catch { return false; }
}

export interface FailureObservation {
	/** Raw compiler, runtime or harness failure text. */
	text: string;
	/** Where it came from: a run id, a task id, a frozen evidence path. */
	source: string;
}

export interface MinedRule {
	signature: string;
	frequency: number;
	/** Distinct sources, so a single log repeated ten times is not "ten failures". */
	sources: string[];
	/** One verbatim example, bounded, for the proposer to check against. */
	sample: string;
}

// A failure line announces itself: `error:`, `fatal error:`, `Exception:`,
// `错误：`. Summary lines such as "1 error generated." are not failures and
// must not be counted as one.
const ERROR_LINE = /(?:^|\n)[^\n]*?(?:\b(?:error|fatal error|exception|panic|assertion failed)\s*[:：]|错误\s*[:：]|失败\s*[:：])[^\n]*/giu;
const LOCATION = /(?:[\w./\\-]+\.[a-z]{1,4}:\d+(?::\d+)?:?\s*)/giu;
const HEX = /\b0x[0-9a-f]+\b/giu;
const NUMBER = /\b\d{3,}\b/gu;

/** Normalise one failure line into a signature: drop file locations, addresses
 * and long numbers, collapse whitespace, bound the length. Identifiers stay,
 * because the symbol is the key. */
export function normalizeErrorSignature(line: string): string {
	return line.replace(LOCATION, "").replace(HEX, "0x…").replace(NUMBER, "…")
		.replace(/\s+/gu, " ").trim().slice(0, 160);
}

export function extractErrorSignatures(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(ERROR_LINE)) {
		const signature = normalizeErrorSignature(match[0]);
		if (signature.length >= 12) found.push(signature);
	}
	return found;
}

export interface MiningOptions {
	/** Keep a signature only when this many distinct sources produced it. */
	minimumFrequency?: number;
	/** Upper bound on drafts, so one noisy log cannot fill a prompt. */
	maxRules?: number;
}

export function mineFailureRules(observations: readonly FailureObservation[], options: MiningOptions = {}): MinedRule[] {
	const minimumFrequency = options.minimumFrequency ?? 3;
	const maxRules = options.maxRules ?? 20;
	const counts = new Map<string, { sources: Set<string>; sample: string }>();
	for (const observation of observations) {
		for (const signature of new Set(extractErrorSignatures(observation.text))) {
			const row = counts.get(signature) ?? { sources: new Set<string>(), sample: signature };
			row.sources.add(observation.source);
			counts.set(signature, row);
		}
	}
	return [...counts].map(([signature, row]) => ({ signature, frequency: row.sources.size,
		sources: [...row.sources].sort(), sample: row.sample }))
		.filter((rule) => rule.frequency >= minimumFrequency)
		.sort((left, right) => right.frequency - left.frequency || left.signature.localeCompare(right.signature))
		.slice(0, maxRules);
}

export interface FailureRuleDraftsV1 {
	version: 1;
	kind: "failure-rule-drafts";
	minimumFrequency: number;
	/** Observations the host scanned, for an honest denominator. */
	scanned: number;
	rules: MinedRule[];
}

export function failureRuleDrafts(observations: readonly FailureObservation[], options: MiningOptions = {}): FailureRuleDraftsV1 {
	return { version: 1, kind: "failure-rule-drafts", minimumFrequency: options.minimumFrequency ?? 3,
		scanned: observations.length, rules: mineFailureRules(observations, options) };
}

/** Prompt section. The counts are host facts; the wording of a rule and whether
 * it is worth keeping are not. */
export function renderFailureRuleDrafts(drafts: FailureRuleDraftsV1): string {
	if (!drafts.rules.length) return "";
	return ["【宿主统计的重复失败签名】",
		`在本轮可见的 ${drafts.scanned} 份失败文本中，以下签名在至少 ${drafts.minimumFrequency} 个不同来源里重复出现。次数是宿主确定性统计，措辞与是否值得入库由你判断：`,
		...drafts.rules.map((rule) => `- ${rule.frequency} 次：${rule.signature}（来源：${rule.sources.slice(0, 5).join("、")}${rule.sources.length > 5 ? " 等" : ""}）`),
		"若其中某条确实是可复用的硬规则，可提 kind=\"rule\" 的结构化卡片：errorSignature 用确切符号、ruleText 写一句「不能……」、frequency 填上面的次数、evidence 填这些来源路径。没有把握就不提；统计重复不等于已找到根因。"].join("\n");
}

/** Read bounded failure logs out of the frozen feedback tree. Each file is one
 * source, so a single log repeated inside itself cannot look like three
 * independent failures. Nothing here interprets the text. */
export async function collectFailureObservations(root: string): Promise<FailureObservation[]> {
	const observations: FailureObservation[] = [];
	const visit = async (dir: string, depth: number): Promise<void> => {
		if (depth > 6 || observations.length >= 200) return;
		let entries: string[];
		try { entries = await readdir(dir); } catch { return; }
		for (const name of entries.sort()) {
			if (observations.length >= 200) return;
			const file = path.join(dir, name);
			const info = await lstat(file).catch(() => undefined);
			if (!info || info.isSymbolicLink()) continue;
			if (info.isDirectory()) { await visit(file, depth + 1); continue; }
			if (!info.isFile() || info.size > 262_144) continue;
			if (!/\.(?:log|txt|md|json)$/iu.test(name) || !/(?:log|stderr|stdout|compile|build|error|fail|report)/iu.test(name)) continue;
			const bytes = await readFile(file).catch(() => undefined);
			if (!bytes || !textFile(bytes)) continue;
			observations.push({ text: bytes.toString("utf8"), source: path.relative(root, file) || name });
		}
	};
	await visit(root, 0);
	return observations;
}

