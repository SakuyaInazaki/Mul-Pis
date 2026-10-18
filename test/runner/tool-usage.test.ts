import assert from "node:assert/strict";
import test from "node:test";
import { experimentArmFromEnvironment, EXPERIMENT_ARMS } from "../../src/runner/experiment-arm.ts";
import { summarizeToolCalls } from "../../src/runner/tool-usage.ts";
import type { ToolCallRecord } from "../../src/runner/types.ts";

const call = (name: string, ok = true, failureClass?: ToolCallRecord["failureClass"]): ToolCallRecord =>
	({ name, args: {}, ok, at: "2026-10-18T00:00:00.000Z", ...(failureClass ? { failureClass } : {}) });

test("tool accounting shows the surface actually used and whether changes were measured", () => {
	const summary = summarizeToolCalls([
		call("read"), call("write"), call("edit"), call("candidate_run"),
		call("write"), call("write"), call("candidate_evaluate"),
		call("bash", false, "policy"), call("bash", false, "infrastructure"),
		call("candidate_list"), call("write"),
	]);
	assert.equal(summary.calls, 11);
	assert.equal(summary.distinctTools, 7);
	assert.deepEqual(summary.tools.slice(0, 2).map(entry => [entry.name, entry.calls]), [["write", 4], ["bash", 2]]);
	assert.deepEqual(summary.failures, { policy: 1, infrastructure: 1 });
	assert.deepEqual(summary.tools.find(entry => entry.name === "bash")?.failureClasses,
		{ policy: 1, infrastructure: 1 });
	// Five file changes, two batches of which reached an evaluation before the next
	// change; reading the archive is not an evaluation and the last change is still open.
	assert.equal(summary.mutations, 5);
	assert.equal(summary.mutationsEvaluated, 2);
	assert.equal(summary.evaluations, 2);
	// A failed change does not count as a change that could have been measured.
	assert.equal(summarizeToolCalls([call("write", false, "policy"), call("candidate_run")]).mutations, 0);
	assert.deepEqual(summarizeToolCalls([]), { version: 1, calls: 0, distinctTools: 0, tools: [],
		mutations: 0, mutationsEvaluated: 0, evaluations: 0, failures: {} });
});

test("the orchestration arm is a host-owned knob with a recorded default", () => {
	assert.deepEqual([...EXPERIMENT_ARMS], ["multi-role", "single-agent"]);
	assert.equal(experimentArmFromEnvironment({}), "multi-role");
	assert.equal(experimentArmFromEnvironment({ PRE_RSI_EXPERIMENT_ARM: "single-agent" }), "single-agent");
	assert.throws(() => experimentArmFromEnvironment({ PRE_RSI_EXPERIMENT_ARM: "duo" }), /must be one of/);
});
