/** SGR terminal mouse reports. Coordinates become zero-based layout cells. */
export function parseMouse(sequence: string): { x: number; y: number; wheel: number; release: boolean; left: boolean } | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
	if (!match) return undefined;
	const [button, x, y] = match.slice(1, 4).map(Number);
	if (!Number.isSafeInteger(button) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1) return undefined;
	return { x: x - 1, y: y - 1, wheel: button & 64 ? (button & 1 ? 1 : -1) : 0, release: match[4] === "m", left: (button & 3) === 0 && !(button & 32) };
}
