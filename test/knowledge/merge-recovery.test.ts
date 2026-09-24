import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore, type KnowledgeStoreRecoveryOptions } from "../../src/knowledge/store.ts";
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

for (const phase of ["prepared", "records", "current", "result"] as const) {
	test(`frozen merge intent recovers after ${phase} without duplicate record or lost limit`, async (t) => {
		const { dir, store } = await fixture(t);
		const receipt = await store.submitProposal({ stage: "test", runId: "r2", ops: [
			{ op: "revise", id: "C001", body: "v2", reason: "new evidence" },
			{ op: "limit", target: "C001", kind: "suspended", reason: "uncertain", authority: "test" },
		] });
		let injected = false;
		const broken = createFileKnowledgeStore(dir, { afterPhase: (at) => {
			if (at === phase && !injected) { injected = true; throw new Error(`power loss: ${phase}`); }
		} });
		await assert.rejects(broken.merge(receipt.proposalId), /power loss/);
		const before = await store.current();
		assert.equal(before?.id, phase === "current" || phase === "result" ? "G002" : "G001");
		if (phase === "records") {
			assert.equal((await store.get("C001"))?.version, 1);
			assert((await store.limits()).some((limit) => limit.target === "C001" && limit.kind === "suspended" && !limit.liftedAt));
		}
		const other = await store.submitProposal({ stage: "test", runId: "other", ops: [{ op: "create", type: "E", title: "e", body: "e" }] });
		await assert.rejects(store.merge(other.proposalId), /尚未对账/);
		const recovered = await store.merge(receipt.proposalId);
		assert.equal(recovered.snapshot.id, "G002");
		assert.equal((await store.get("C001"))?.version, 2);
		assert.equal((await store.get("C001"))?.body, "v2");
		assert.equal((await store.limits()).filter((limit) => limit.target === "C001" && limit.kind === "suspended" && !limit.liftedAt).length, 1);
		assert.equal((await store.merge(receipt.proposalId)).snapshot.id, "G002");
		assert.deepEqual((await readdir(path.join(dir, "snapshots"))).sort(), ["G001.json", "G002.json"]);
		const intent = JSON.parse(await readFile(path.join(dir, "proposals", `${receipt.proposalId}.intent.json`), "utf8"));
		assert.equal(intent.status, "committed");
		await store.merge(other.proposalId);
		assert.equal((await store.merge(receipt.proposalId)).snapshot.id, "G002", "old committed proposal remains idempotent after a later CURRENT");
	});
}

test("a pending lift never drops an active restriction before CURRENT", async (t) => {
	const { dir, store } = await fixture(t);
	const limited = await store.submitProposal({ stage: "test", runId: "limit", ops: [{ op: "limit", target: "C001", kind: "suspended", reason: "uncertain", authority: "test" }] });
	await store.merge(limited.proposalId);
	const lift = await store.submitProposal({ stage: "test", runId: "lift", ops: [{ op: "lift_limit", target: "C001", reason: "resolved", authority: "test" }] });
	const broken = createFileKnowledgeStore(dir, { afterPhase: (phase) => { if (phase === "records") throw new Error("power loss"); } });
	await assert.rejects(broken.merge(lift.proposalId), /power loss/);
	assert((await store.limits()).some((limit) => limit.target === "C001" && !limit.liftedAt));
	await store.merge(lift.proposalId);
	assert((await store.limits()).every((limit) => limit.target !== "C001" || !!limit.liftedAt));
});

const localIdentity: ProcessIdentityV1 = { hostId: "test-host", bootId: "test-boot", pid: 42001, processStartToken: "start-1" };
const deadOwner = { version: 1, ...localIdentity, pid: 42002, processStartToken: "old-start", nonce: "old-owner", time: "2020-01-01T00:00:00Z" };

for (const status of ["alive", "unknown", "dead"] as const) {
	test(`merge lock owner ${status} is ${status === "dead" ? "recovered" : "preserved"}`, async (t) => {
		const { dir, store } = await fixture(t);
		const receipt = await store.submitProposal({ stage: "test", runId: "r2", ops: [{ op: "create", type: "E", title: "e", body: "e" }] });
		const lock = path.join(dir, ".merge.lock");
		await writeFile(lock, JSON.stringify(deadOwner));
		const options: KnowledgeStoreRecoveryOptions = {
			identity: async () => localIdentity,
			probe: async () => ({ status, identityMatch: status === "alive", reason: "injected" }),
		};
		const contender = createFileKnowledgeStore(dir, options);
		if (status === "dead") {
			assert.equal((await contender.merge(receipt.proposalId)).snapshot.id, "G002");
			assert.equal(await readFile(path.join(dir, `.merge.lock.recovered.${deadOwner.nonce}`), "utf8"), JSON.stringify(deadOwner));
		} else {
			await assert.rejects(contender.merge(receipt.proposalId), /merge.locked|身份未知|正在使用中/);
			assert.equal(await readFile(lock, "utf8"), JSON.stringify(deadOwner));
		}
	});
}

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

test("two trusted dead-owner recoverers publish one snapshot", async (t) => {
	const { dir, store } = await fixture(t);
	const receipt = await store.submitProposal({ stage: "test", runId: "r2", ops: [{ op: "create", type: "E", title: "e", body: "e" }] });
	await writeFile(path.join(dir, ".merge.lock"), JSON.stringify(deadOwner));
	const options: KnowledgeStoreRecoveryOptions = { identity: async () => localIdentity, probe: async () => ({ status: "dead", identityMatch: false, reason: "absent" }) };
	const outcomes = await Promise.allSettled([createFileKnowledgeStore(dir, options).merge(receipt.proposalId), createFileKnowledgeStore(dir, options).merge(receipt.proposalId)]);
	assert(outcomes.some((item) => item.status === "fulfilled"));
	assert.equal((await store.current())?.id, "G002");
	assert.equal((await store.list()).filter((record) => record.type === "E").length, 1);
	assert.deepEqual((await readdir(path.join(dir, "snapshots"))).sort(), ["G001.json", "G002.json"]);
});

test("release refuses a replaced lock owner and preserves the replacement", async (t) => {
	const { dir, store } = await fixture(t);
	const receipt = await store.submitProposal({ stage: "test", runId: "r2", ops: [{ op: "create", type: "E", title: "e", body: "e" }] });
	const lock = path.join(dir, ".merge.lock");
	const replacement = { ...deadOwner, nonce: "replacement" };
	const broken = createFileKnowledgeStore(dir, { afterPhase: async (phase) => {
		if (phase !== "prepared") return;
		await rm(lock);
		await writeFile(lock, JSON.stringify(replacement));
	} });
	await assert.rejects(broken.merge(receipt.proposalId), /拒绝释放/);
	assert.equal(await readFile(lock, "utf8"), JSON.stringify(replacement));
	assert.equal((await store.current())?.id, "G001");
});
