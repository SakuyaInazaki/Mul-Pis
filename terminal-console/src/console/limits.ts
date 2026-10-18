/**
 * Observation limits of the console reader.
 *
 * These are thresholds, not cosmetics: the heartbeat window decides whether a
 * run is shown as running or as unknown, and the read limits decide whether a
 * record is projected at all. A threshold that decides a displayed verdict
 * must be a configuration value, not a literal in the middle of the reader.
 *
 * A workspace overrides them with `.agent/console-limits.json`. Unknown or
 * out-of-range fields are refused loudly rather than silently reverting to a
 * default, so an observation made under one window is never reported as if it
 * had been made under another.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ConsoleLimitsV1 {
	/** Largest control record the reader will parse, in bytes. */
	maxJsonBytes: number;
	/** Largest tail the reader will read from one text or JSONL file, in bytes. */
	maxPreviewBytes: number;
	/** A heartbeat older than this makes a running record's live state unknown. */
	staleHeartbeatMs: number;
	/** Number of trailing tool-log entries projected into the tree. */
	toolLogWindow: number;
}

export const DEFAULT_CONSOLE_LIMITS: ConsoleLimitsV1 = {
	maxJsonBytes: 40_000_000,
	maxPreviewBytes: 65_536,
	staleHeartbeatMs: 20_000,
	toolLogWindow: 100,
};

const RANGES: Record<keyof ConsoleLimitsV1, { min: number; max: number }> = {
	maxJsonBytes: { min: 64 * 1024, max: 1_000_000_000 },
	maxPreviewBytes: { min: 1024, max: 8 * 1024 * 1024 },
	staleHeartbeatMs: { min: 1_000, max: 3_600_000 },
	toolLogWindow: { min: 1, max: 10_000 },
};

export const CONSOLE_LIMITS_FILE = path.join(".agent", "console-limits.json");

export function validateConsoleLimits(raw: unknown): ConsoleLimitsV1 {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("console-limits.json 必须是一个对象");
	const input = raw as Record<string, unknown>;
	const names = Object.keys(RANGES) as Array<keyof ConsoleLimitsV1>;
	const unknown = Object.keys(input).filter(key => key !== "version" && !names.includes(key as keyof ConsoleLimitsV1));
	if (unknown.length) throw new Error(`console-limits.json 含未知字段：${unknown.join("、")}`);
	if (input.version !== undefined && input.version !== 1) throw new Error("console-limits.json 的 version 必须是 1");
	const limits = { ...DEFAULT_CONSOLE_LIMITS };
	for (const name of names) {
		const value = input[name];
		if (value === undefined) continue;
		const range = RANGES[name];
		if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max)
			throw new Error(`console-limits.json 的 ${name} 必须是 ${range.min}–${range.max} 之间的整数`);
		limits[name] = value;
	}
	return limits;
}

/** Absent file means the defaults; a malformed one is an error, not a default. */
export async function loadConsoleLimits(workspace: string): Promise<ConsoleLimitsV1> {
	let text: string;
	try { text = await readFile(path.join(workspace, CONSOLE_LIMITS_FILE), "utf8"); }
	catch { return { ...DEFAULT_CONSOLE_LIMITS }; }
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch (error) { throw new Error(`console-limits.json 不是合法 JSON：${(error as Error).message}`); }
	return validateConsoleLimits(parsed);
}
