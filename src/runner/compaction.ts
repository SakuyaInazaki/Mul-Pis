import type { ExtensionFactory, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Frozen per new session; old sessions without this entry retain Pi defaults. */
export const WORKFLOW_COMPACTION = { thresholdTokens: 200_000, reserveTokens: 16_384, keepRecentTokens: 20_000 } as const;
const ENTRY = "workflow_compaction";
type Policy = { thresholdTokens: number; reserveTokens: number; keepRecentTokens: number };

export function sessionCompactionPolicy(manager: Pick<SessionManager, "getSessionId" | "getEntries" | "appendCustomEntry">, fresh: boolean): Policy | undefined {
	const sessionId = manager.getSessionId();
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as { sessionId: string; policy: Policy };
		if (data.sessionId === sessionId) return data.policy;
	}
	if (!fresh) return undefined;
	const policy = { ...WORKFLOW_COMPACTION };
	manager.appendCustomEntry(ENTRY, { sessionId, policy });
	return policy;
}

/** Use Pi's native threshold checks, including between tool batches. */
export function workflowCompactionSettings(contextWindow: number, policy: Policy = WORKFLOW_COMPACTION): ReturnType<SettingsManager["getCompactionSettings"]> {
	return {
		enabled: true,
		reserveTokens: Math.max(policy.reserveTokens, contextWindow - policy.thresholdTokens),
		keepRecentTokens: policy.keepRecentTokens,
	};
}

/** Pi 0.85.1 also uses reserveTokens as its summary budget. Keep that budget
 * separate from the earlier trigger, without replacing Pi's summary or retry path. */
export function workflowCompactionExtension(policy: Policy = WORKFLOW_COMPACTION): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", (event) => {
			event.preparation.settings = { ...event.preparation.settings, reserveTokens: policy.reserveTokens };
		});
	};
}
