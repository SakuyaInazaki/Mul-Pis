import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.ts";

test("local execution capability requires an explicit workspace policy", () => {
	const base = { roles: { research: "fake/research", execution: "fake/execution" } };
	assert.equal(validateConfig(base).localMission, undefined);
	assert.deepEqual(validateConfig({ ...base,
		localMission: { execution: "task-root-bash" } }).localMission,
		{ execution: "task-root-bash" });
	assert.deepEqual(validateConfig({ ...base,
		localMission: { evaluatorId: "host:file-sha256" } }).localMission,
		{ evaluatorId: "host:file-sha256" });
	for (const policy of [{ execution: "sandboxed" }, { execution: "task-root-bash", extra: true },
		{ execution: true }, {}, { evaluatorId: "../untrusted-module.ts" }])
		assert.throws(() => validateConfig({ ...base, localMission: policy }),
			/localMission.execution/);
});
