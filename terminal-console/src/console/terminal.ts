/** Small terminal-only layout primitives. Text from files never supplies escape sequences. */
export function safeText(value: unknown): string {
	return String(value ?? "").replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, " ");
}
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function columns(s: string): number {
	if (/^\p{Mark}+$/u.test(s)) return 0;
	if (/\p{Extended_Pictographic}/u.test(s)) return 2;
	const c = s.codePointAt(0)!;
	return c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
		(c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe6f) ||
		(c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f1e6) ? 2 : 1;
}
export function textWidth(s: string): number { return [...segments.segment(safeText(s))].reduce((n, x) => n + columns(x.segment), 0); }
export function clip(s: string, width: number, ellipsis = true): string {
	s = safeText(s); width = Math.max(0, width);
	if (textWidth(s) <= width) return s;
	let out = "", used = 0;
	for (const x of segments.segment(s)) { const n = columns(x.segment); if (used + n > width - (ellipsis && width ? 1 : 0)) break; out += x.segment; used += n; }
	return out + (ellipsis && width ? "…" : "");
}
export function pad(s: string, width: number): string { const t = clip(s, width, false); return t + " ".repeat(Math.max(0, width - textWidth(t))); }
export function wrap(s: string, width: number): string[] {
	const result: string[] = []; let line = "", used = 0;
	for (const x of segments.segment(safeText(s))) { const n = columns(x.segment); if (used + n > width && line) { result.push(line); line = ""; used = 0; } line += x.segment; used += n; }
	result.push(line); return result;
}
export const theme = {
	plain: "", dim: "\x1b[38;5;245m", border: "\x1b[38;5;240m", heading: "\x1b[1m",
	cyan: "\x1b[38;5;80m", purple: "\x1b[38;5;147m", green: "\x1b[38;5;114m",
	yellow: "\x1b[38;5;222m", red: "\x1b[38;5;210m",
	selected: "\x1b[48;5;24m\x1b[38;5;231m\x1b[1m",
	selectedGreen: "\x1b[48;5;24m\x1b[38;5;157m", selectedYellow: "\x1b[48;5;24m\x1b[38;5;222m",
	selectedRed: "\x1b[48;5;24m\x1b[38;5;217m", selectedDim: "\x1b[48;5;24m\x1b[38;5;252m",
};
export type Tone = keyof typeof theme;
export interface Line { text: string; tone?: Tone }
export class Screen {
	private grid: Array<Array<{ text: string; tone: Tone; continuation?: boolean }>>;
	readonly width: number;
	readonly height: number;
	constructor(width: number, height: number) { this.width = width; this.height = height; this.grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: " ", tone: "plain" as Tone }))); }
	write(x: number, y: number, text: string, tone: Tone = "plain", max = this.width - x): void {
		if (y < 0 || y >= this.height || x < 0) return;
		let at = x;
		for (const { segment } of segments.segment(clip(text, Math.min(max, this.width - x), false))) {
			const n = columns(segment); if (!n || at + n > this.width) continue;
			if (this.grid[y][at].continuation && at > 0) this.grid[y][at - 1] = { text: " ", tone: "plain" };
			if (at + n < this.width && this.grid[y][at + n].continuation) this.grid[y][at + n] = { text: " ", tone: "plain" };
			this.grid[y][at] = { text: segment, tone };
			if (n === 2) this.grid[y][at + 1] = { text: "", tone, continuation: true };
			at += n;
		}
	}
	box(x: number, y: number, width: number, height: number, title: string, lines: Line[], tone: Tone = "border"): void {
		if (height < 3 || width < 5) return;
		this.write(x, y, "╭" + "─".repeat(width - 2) + "╮", tone);
		this.write(x + 2, y, ` ${clip(title, width - 6, false)} `, tone === "cyan" ? "cyan" : "heading");
		for (let i = 1; i < height - 1; i++) { this.write(x, y + i, "│", tone); this.write(x + width - 1, y + i, "│", tone); const line = lines[i - 1]; if (line) { if (line.tone?.startsWith("selected")) this.write(x + 1, y + i, " ".repeat(width - 2), line.tone); this.write(x + 2, y + i, line.text, line.tone, width - 4); } }
		this.write(x, y + height - 1, "╰" + "─".repeat(width - 2) + "╯", tone);
	}
	lines(color = true): string[] {
		return this.grid.map(row => {
			let line = "", tone: Tone = "plain";
			for (const cell of row) { if (cell.continuation) continue; if (color && cell.tone !== tone) { line += "\x1b[0m" + theme[cell.tone]; tone = cell.tone; } line += cell.text; }
			return line + (color && tone !== "plain" ? "\x1b[0m" : "");
		});
	}
}
