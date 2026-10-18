import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { assertDeliversHistoricalBest, collectDeliveryEvidence, renderDeliveryEvidence } from "../src/stages/delivery-evidence.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";
import { writeCandidateGoal } from "./helpers/candidate-goal.ts";

async function fixture(t: TestContext): Promise<{ ws: Workspace; delivery: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-delivery-evidence-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const delivery = path.join(root, "delivery");
	await mkdir(delivery, { recursive: true });
	return { ws: new Workspace(root), delivery };
}

const CANDIDATES = [
	{ id: "C001", source: "slow kernel\n", value: 2, externalId: "E001" },
	{ id: "C002", source: "fast kernel\n", value: 1, externalId: "E002" },
];

test("a delivery without archived candidate bytes stays unchanged and is not refused", async (t) => {
	const f = await fixture(t);
	await writeCandidateGoal(f.ws, "g", "S1", CANDIDATES);
	await writeFile(path.join(f.delivery, "report.md"), "一份说明，不含候选源码\n");
	const evidence = await collectDeliveryEvidence(f.ws, f.delivery);
	assert.deepEqual(evidence.deliveredCandidateRefs, []);
	assert.deepEqual(evidence.superseded, []);
	assert.equal(evidence.archivedCandidates, 2);
	assert.equal(evidence.best.length, 1);
	assert.equal(evidence.best[0].candidateRef, "T001/C002");
	assert.equal(evidence.best[0].delivered, false);
	assertDeliversHistoricalBest(evidence);
});

test("delivering a superseded candidate is refused and names the historical best", async (t) => {
	const f = await fixture(t);
	await writeCandidateGoal(f.ws, "g", "S1", CANDIDATES);
	await writeFile(path.join(f.delivery, "kernel.txt"), "slow kernel\n");
	const evidence = await collectDeliveryEvidence(f.ws, f.delivery);
	assert.deepEqual(evidence.deliveredCandidateRefs, ["g/T001/C001"]);
	assert.equal(evidence.superseded.length, 1);
	assert.equal(evidence.superseded[0].deliveredCandidateRef, "T001/C001");
	assert.equal(evidence.superseded[0].bestCandidateRef, "T001/C002");
	assert.throws(() => assertDeliversHistoricalBest(evidence),
		(error: unknown) => error instanceof HarnessError && error.code === "m09.superseded-delivery" && /T001\/C002/.test(error.message));
});

test("delivering the historical best passes and discloses the measurement basis", async (t) => {
	const f = await fixture(t);
	await writeCandidateGoal(f.ws, "g", "S1", CANDIDATES);
	// A renamed copy still matches: identity is byte identity, not the file name.
	await writeFile(path.join(f.delivery, "shipped.txt"), "fast kernel\n");
	const evidence = await collectDeliveryEvidence(f.ws, f.delivery);
	assert.deepEqual(evidence.deliveredCandidateRefs, ["g/T001/C002"]);
	assert.deepEqual(evidence.superseded, []);
	assert.equal(evidence.best[0].delivered, true);
	assert.deepEqual(evidence.measurement.basisIds, ["B1"]);
	assert.equal(evidence.measurement.metricsWithReference, 1);
	assert.equal(evidence.measurement.metricsWithoutReference, 0);
	assert.equal(evidence.measurement.terminalEvaluations, 1);
	assert.deepEqual(evidence.measurement.cases, { passed: 1, failed: 0, unknown: 0 });
	assertDeliversHistoricalBest(evidence);
	const rendered = renderDeliveryEvidence(evidence).join("\n");
	assert.match(rendered, /同口径历史最佳：g\/T001\/C002/);
	assert.match(rendered, /已在交付范围内/);
});

test("a metric with no reference measurement is disclosed as having no denominator", async (t) => {
	const f = await fixture(t);
	await writeCandidateGoal(f.ws, "g", "S1", [{ ...CANDIDATES[1], withoutReference: true }]);
	await writeFile(path.join(f.delivery, "shipped.txt"), "fast kernel\n");
	const evidence = await collectDeliveryEvidence(f.ws, f.delivery);
	assert.equal(evidence.measurement.metricsWithReference, 0);
	assert.equal(evidence.measurement.metricsWithoutReference, 1);
	assert.ok(evidence.limitations.some(item => item.includes("没有分母")));
});
