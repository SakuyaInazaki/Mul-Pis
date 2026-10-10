import assert from "node:assert/strict";
import test from "node:test";
import { validUnobservedControlDelivery,
	type UnobservedControlDelivery } from "../src/runner/mission-state.ts";

const delivery: UnobservedControlDelivery = {
	version: 1, kind: "unobserved-control-delivery",
	controlCommit: "a".repeat(40), testedSourceCommit: "b".repeat(40),
	testedSourceTree: "c".repeat(40), previousControlParent: null,
	admittedBy: { runId: "123", runAttempt: 1, runNumber: 2, commit: "d".repeat(40) },
	observedRunsAtAdmission: 0, effects: "unknown-unreconciled",
	accounting: "unquantified",
};

test("historical unknown control delivery survives JSON and field reordering", () => {
	assert.equal(validUnobservedControlDelivery(JSON.parse(JSON.stringify(delivery))), true);
	assert.equal(validUnobservedControlDelivery({
		accounting: delivery.accounting, admittedBy: { commit: delivery.admittedBy.commit,
			runNumber: 2, runAttempt: 1, runId: "123" },
		effects: delivery.effects, observedRunsAtAdmission: 0,
		previousControlParent: "e".repeat(40), testedSourceTree: delivery.testedSourceTree,
		testedSourceCommit: delivery.testedSourceCommit, controlCommit: delivery.controlCommit,
		kind: delivery.kind, version: 1,
	}), true);
});

test("unknown control delivery schema rejects altered source and settled effects", () => {
	for (const invalid of [
		{ ...delivery, admittedBy: { ...delivery.admittedBy, runId: "local" } },
		{ ...delivery, admittedBy: { ...delivery.admittedBy, extra: true } },
		{ ...delivery, observedRunsAtAdmission: 1 },
		{ ...delivery, effects: "reconciled" },
		{ ...delivery, accounting: "settled" },
		{ ...delivery, extra: true },
		{ ...delivery, controlCommit: "A".repeat(40) },
	]) assert.equal(validUnobservedControlDelivery(invalid), false);
});
