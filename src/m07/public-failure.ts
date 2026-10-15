/** Public wording shared by task status and frozen M07 handoffs. */
export function publicFailure(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.replace(/Bearer\s+[^\s'"\r\n]+/gi, "Bearer [redacted credential]")
		.replace(/sk-[A-Za-z0-9_-]{6,}/gi, "[redacted credential]")
		.replace(/\b(?:api[_-]?key|password|secret|token|session[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]");
}
