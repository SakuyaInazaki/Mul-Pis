import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { ProcessIdentityV1 } from "../../src/runtime/process-identity.ts";

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-merge-recovery-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	const first = await store.submitProposal({ stage: "test", runId: "r1", ops: [{ op: "create", type: "C", title: "claim", body: "v1" }] });
	await store.merge(first.proposalId);
	return { dir, store };
}

test("a pending lift never drops an active restriction before CURRENT", async (t) => {
	const { dir, store } = await fixture(t);
	const limited = await store.submitProposal({ stage: "test", runId: "limit", ops: [
		{ op: "limit", target: "C001", kind: "needs_recheck", reason: "derived", authority: "impact:old" },
		{ op: "limit", target: "C001", kind: "suspended", reason: "independent", authority: "test" },
	] });
	await store.merge(limited.proposalId);
	const lift = await store.submitProposal({ stage: "test", runId: "lift", ops: [{ op: "lift_limit", target: "C001", limitAuthority: "impact:old", reason: "impact resolved", authority: "test" }] });
	const broken = createFileKnowledgeStore(dir, { afterPhase: (phase) => { if (phase === "records") throw new Error("power loss"); } });
	await assert.rejects(broken.merge(lift.proposalId), /power loss/);
	assert((await store.limits()).some((limit) => limit.target === "C001" && limit.authority === "impact:old" && !limit.liftedAt));
	await store.merge(lift.proposalId);
	assert((await store.limits()).some((limit) => limit.target === "C001" && limit.authority === "impact:old" && !!limit.liftedAt));
	assert((await store.limits()).some((limit) => limit.target === "C001" && limit.authority === "test" && !limit.liftedAt));
	assert.equal((await store.availability("C001")).availability, "not_allowed");
});

const localIdentity: ProcessIdentityV1 = { hostId: "test-host", bootId: "test-boot", pid: 42001, processStartToken: "start-1" };
const deadOwner = { version: 1, ...localIdentity, pid: 42002, processStartToken: "old-start", nonce: "old-owner", time: "2020-01-01T00:00:00Z" };

test("PID reuse and cross-host dead reports do not take over the lock", async (t) => {
	const { dir, store } = await fixture(t);
	const receipt = await store.submitProposal({ stage: "test", runId: "r2", ops: [{ op: "create", type: "E", title: "e", body: "e" }] });
	const lock = path.join(dir, ".merge.lock");
	await writeFile(lock, JSON.stringify(deadOwner));
	const reused = createFileKnowledgeStore(dir, { identity: async () => localIdentity, probe: async () => ({ status: "unknown", identityMatch: false, reason: "pid reused" }) });
	await assert.rejects(reused.merge(receipt.proposalId), /身份未知/);
	await writeFile(lock, JSON.stringify({ ...deadOwner, hostId: "other-host" }));
	const remote = createFileKnowledgeStore(dir, { identity: async () => localIdentity, probe: async () => ({ status: "dead", identityMatch: false, reason: "remote" }) });
	await assert.rejects(remote.merge(receipt.proposalId), /正在使用中/);
	assert.equal((await store.current())?.id, "G001");
});
