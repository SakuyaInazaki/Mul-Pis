/** Historical control delivery whose execution was unobserved at admission.
 * Keep this persisted shape exact when moving mission state between hosts.
 */
export type UnobservedControlDelivery = Readonly<{
	version: 1; kind: "unobserved-control-delivery";
	controlCommit: string; testedSourceCommit: string; testedSourceTree: string;
	previousControlParent: string | null;
	admittedBy: Readonly<{ runId: string; runAttempt: number; runNumber: number; commit: string }>;
	observedRunsAtAdmission: 0; effects: "unknown-unreconciled";
	accounting: "unquantified";
}>;

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function positiveId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value);
}

/** Validates the original persisted schema without granting effect or replay authority. */
export function validUnobservedControlDelivery(value: unknown): value is UnobservedControlDelivery {
	return record(value) && exactKeys(value, ["version", "kind", "controlCommit",
		"testedSourceCommit", "testedSourceTree", "previousControlParent", "admittedBy",
		"observedRunsAtAdmission", "effects", "accounting"]) &&
		value.version === 1 && value.kind === "unobserved-control-delivery" &&
		[value.controlCommit, value.testedSourceCommit, value.testedSourceTree].every(item =>
			typeof item === "string" && /^[0-9a-f]{40}$/.test(item)) &&
		(value.previousControlParent === null ||
			(typeof value.previousControlParent === "string" && /^[0-9a-f]{40}$/.test(value.previousControlParent))) &&
		record(value.admittedBy) && exactKeys(value.admittedBy,
			["runId", "runAttempt", "runNumber", "commit"]) &&
		positiveId(value.admittedBy.runId) && Number.isSafeInteger(value.admittedBy.runAttempt) &&
		Number(value.admittedBy.runAttempt) > 0 && Number.isSafeInteger(value.admittedBy.runNumber) &&
		Number(value.admittedBy.runNumber) > 0 && typeof value.admittedBy.commit === "string" &&
		/^[0-9a-f]{40}$/.test(value.admittedBy.commit) &&
		value.observedRunsAtAdmission === 0 && value.effects === "unknown-unreconciled" &&
		value.accounting === "unquantified";
}
