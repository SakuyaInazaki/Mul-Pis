import assert from "node:assert/strict";
import test from "node:test";
import { observeManagedProcessGroup } from "../../src/runner/managed-bash.ts";

const error = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

test("Darwin-style group probe distinguishes empty, present and unavailable without procfs", async () => {
	const base = { platform: "darwin" as const };
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => { throw error("ESRCH"); } }), "none-observed");
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => undefined }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => { throw error("EPERM"); } }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => { throw error("ENOSYS"); } }), "unknown");
	assert.equal(await observeManagedProcessGroup(0, base), "unknown");
});

test("Linux positive group probe stays present when procfs hides a live member", async () => {
	// The host might list only a zombie while an unlisted child still holds the
	// process group. No procfs-only refinement may turn a positive kill probe
	// into a false empty result.
	assert.equal(await observeManagedProcessGroup(321, { platform: "linux",
		signalGroup: () => undefined }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, { platform: "linux",
		signalGroup: () => { throw error("EPERM"); } }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, { platform: "linux",
		signalGroup: () => { throw error("ESRCH"); } }), "none-observed");
});
