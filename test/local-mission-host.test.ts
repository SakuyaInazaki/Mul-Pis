import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ProcessIdentityV1 } from "../src/runtime/process-identity.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const processOne: ProcessIdentityV1 = { hostId: "synthetic-host", bootId: "synthetic-boot",
	pid: 1001, processStartToken: "111" };
const processTwo: ProcessIdentityV1 = { ...processOne, pid: 1002, processStartToken: "222" };

async function fixture(t: TestContext) {
	const parent = await mkdtemp(path.join(os.tmpdir(), "mulpis-local-host-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, "mission");
	const first = await LocalMissionHost.begin({ root, missionId: "mission-001",
		attemptId: "A001", codeRevision: "local-revision-1",
		currentIdentity: async () => processOne });
	return { parent, root, first };
}

test("local committed contract, checkpoint and final carry are private and byte-exact", async t => {
	const f = await fixture(t);
	assert.equal((await LocalMissionHost.status(f.root)).currentAttempt?.attemptId, "A001");
	assert.equal(await LocalMissionHost.readInitialContract(f.root), undefined);
	const contract = Buffer.from('{"id":"mission-001","goal":"synthetic"}\n');
	const contractReceipt = await f.first.recordInitialContract({ attemptId: "A001", bytes: contract });
	assert.equal(contractReceipt.sha256, sha(contract));
	assert.deepEqual(await f.first.recordInitialContract({ attemptId: "A001", bytes: contract }),
		contractReceipt);
	await assert.rejects(f.first.recordInitialContract({ attemptId: "A001",
		bytes: Buffer.from("changed contract") }), /identity changed/);
	assert.deepEqual(await LocalMissionHost.readInitialContract(f.root), contract);
	await f.first.recordUnknownOperation({ attemptId: "A001", operationId: "external-op-1" });
	const checkpoint = Buffer.from("SYNTHETIC-AUTHENTICATED-CHECKPOINT");
	const cp = await f.first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: checkpoint });
	assert.deepEqual(cp.unresolvedOperationIds, ["external-op-1"]);
	assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.root), checkpoint);
	assert.deepEqual(await f.first.readCheckpoint(1), checkpoint);
	await writeFile(path.join(f.root, ".writer.lock"), "synthetic uncertain writer\n",
		{ mode: 0o600 });
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, true);
	assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.root), checkpoint,
		"known committed evidence stays readable during an unrelated writer uncertainty");
	await rm(path.join(f.root, ".writer.lock"));
	const carry = Buffer.from("SYNTHETIC-ENCRYPTED-CARRY");
	const intent = await f.first.reserveFinal({ attemptId: "A001", intentId: "seal-1",
		checkpointSequence: cp.sequence, checkpointSha256: cp.sha256,
		carrySha256: sha(carry) });
	assert.deepEqual(intent.unresolvedOperationIds, ["external-op-1"]);
	const receipt = await f.first.commitFinal({ attemptId: "A001", intentId: "seal-1", bytes: carry });
	assert.equal(receipt.transportOnly, true);
	assert.deepEqual(await f.first.readFinal(), carry);
	const status = await LocalMissionHost.status(f.root);
	assert.equal(status.final, "committed");
	assert.equal(status.accounting, "unquantified");
	assert.equal(status.selectionAuthority, false);
	assert.deepEqual(status.unresolvedOperationIds, ["external-op-1"]);
	for (const file of ["original-contract.json", "original-contract.receipt.json",
		"attempts/A001/source.json", "attempts/A001/checkpoints/C00000001.bin",
		"attempts/A001/checkpoints/C00000001.json", "attempts/A001/final/intent.json",
		"attempts/A001/final/attempted.json", "attempts/A001/final/carry.bin",
		"attempts/A001/final/receipt.json"]) {
		const info = await lstat(path.join(f.root, file));
		assert.ok(info.isFile() && !info.isSymbolicLink());
		assert.equal(info.mode & 0o777, 0o600, file);
	}
	assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
});

test("attempt and checkpoint identities advance exactly while UNKNOWN effects persist", async t => {
	const f = await fixture(t);
	await f.first.recordInitialContract({ attemptId: "A001", bytes: Buffer.from("contract") });
	await f.first.recordUnknownOperation({ attemptId: "A001", operationId: "op-unresolved" });
	const cp1 = await f.first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from("checkpoint-one") });
	await assert.rejects(f.first.recordCheckpoint({ attemptId: "A001", sequence: 3,
		previousSha256: cp1.sha256, bytes: Buffer.from("skipped") }), /sequence/);
	await assert.rejects(f.first.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: cp1.sha256, bytes: Buffer.from("wrong attempt") }), /identity/);
	await assert.rejects(LocalMissionHost.begin({ root: f.root, missionId: "mission-001",
		attemptId: "A002", codeRevision: "local-revision-2",
		currentIdentity: async () => processTwo,
		probePrior: async () => ({ status: "alive", identityMatch: true, reason: "synthetic" }) }),
		/may still be executing/);
	const second = await LocalMissionHost.begin({ root: f.root, missionId: "mission-001",
		attemptId: "A002", codeRevision: "local-revision-2",
		currentIdentity: async () => processTwo,
		probePrior: async () => ({ status: "dead", identityMatch: false, reason: "synthetic" }) });
	const interrupted = await second.status();
	assert.deepEqual(interrupted.interruptedAttemptIds, ["A001"]);
	assert.deepEqual(interrupted.unresolvedOperationIds, ["op-unresolved"]);
	const cp2 = await second.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: cp1.sha256, bytes: Buffer.from("checkpoint-two") });
	assert.equal(cp2.sequence, 2);
	assert.deepEqual(cp2.unresolvedOperationIds, ["op-unresolved"]);
	await assert.rejects(f.first.recordUnknownOperation({ attemptId: "A001",
		operationId: "late" }), /not current/);
	assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.root), Buffer.from("checkpoint-two"));
});

test("successor reads exact predecessor carry and checkpoints without replay", async t => {
	const f = await fixture(t);
	await f.first.recordInitialContract({ attemptId: "A001", bytes: Buffer.from("contract") });
	const cp1 = await f.first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from("first checkpoint") });
	const carry = Buffer.from("first sealed carry");
	await f.first.reserveFinal({ attemptId: "A001", intentId: "first-final",
		checkpointSequence: cp1.sequence, checkpointSha256: cp1.sha256,
		carrySha256: sha(carry) });
	await f.first.commitFinal({ attemptId: "A001", intentId: "first-final", bytes: carry });
	const second = await LocalMissionHost.begin({ root: f.root, missionId: "mission-001",
		attemptId: "A002", codeRevision: "local-revision-2",
		currentIdentity: async () => processTwo });
	assert.deepEqual(await LocalMissionHost.readCommittedFinal(f.root, "A001"), carry);
	assert.deepEqual(await LocalMissionHost.readCommittedCheckpoint(f.root, 1),
		Buffer.from("first checkpoint"));
	assert.equal((await second.status()).final, "none");
	const cp2 = await second.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: cp1.sha256, bytes: Buffer.from("second checkpoint") });
	assert.equal(cp2.sequence, 2);
	assert.deepEqual(await LocalMissionHost.readLatestCheckpoint(f.root),
		Buffer.from("second checkpoint"));
	assert.deepEqual(await second.readFinal("A001"), carry);
});

test("nested missions parent is private and read-only status does not create an attempt", async t => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "mulpis-local-nested-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const agent = path.join(parent, ".agent");
	await mkdir(agent, { mode: 0o700 });
	const root = path.join(agent, "missions", "mission-uuid");
	const host = await LocalMissionHost.begin({ root, missionId: "mission-uuid",
		attemptId: "A001", codeRevision: "revision-1",
		currentIdentity: async () => processOne });
	assert.equal((await lstat(path.dirname(root))).mode & 0o777, 0o700);
	await host.recordInitialContract({ attemptId: "A001", bytes: Buffer.from("contract") });
	const before = await readFile(path.join(root, "attempts", "A001", "source.json"));
	assert.equal((await LocalMissionHost.status(root)).currentAttempt?.attemptId, "A001");
	assert.deepEqual(await readFile(path.join(root, "attempts", "A001", "source.json")), before);
});

test("local process identity accepts Darwin boot timestamps without weakening attempt binding", async t => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "mulpis-local-darwin-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, "mission");
	const darwin = { ...processOne,
		bootId: "{ sec = 1730000000, usec = 123456 }", processStartToken: "1730000000:123456" };
	const host = await LocalMissionHost.begin({ root, missionId: "mission-darwin",
		attemptId: "A001", codeRevision: "revision-1", currentIdentity: async () => darwin });
	assert.deepEqual(host.source.process, darwin);
	await assert.rejects(LocalMissionHost.begin({ root, missionId: "mission-darwin",
		attemptId: "A001", codeRevision: "revision-1",
		currentIdentity: async () => ({ ...darwin, processStartToken: "1730000000:123457" }) }),
		/identity changed/);
});

test("one-use final intent refuses retry after a recorded ambiguous attempt", async t => {
	const f = await fixture(t);
	await f.first.recordInitialContract({ attemptId: "A001", bytes: Buffer.from("contract") });
	const cp = await f.first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from("checkpoint") });
	const carry = Buffer.from("SYNTHETIC-CARRY");
	await f.first.reserveFinal({ attemptId: "A001", intentId: "seal-once",
		checkpointSequence: 1, checkpointSha256: cp.sha256, carrySha256: sha(carry) });
	await assert.rejects(f.first.reserveFinal({ attemptId: "A001", intentId: "seal-again",
		checkpointSequence: 1, checkpointSha256: cp.sha256, carrySha256: sha(carry) }), /already|exact/);
	// Synthetic crash point: the one-use attempt marker was durable, but the
	// host did not commit any final payload or receipt.
	await writeFile(path.join(f.root, "attempts/A001/final/attempted.json"),
		`${JSON.stringify({ version: 1, kind: "local-mission-final-attempt",
			source: f.first.source, intentId: "seal-once", carrySha256: sha(carry) })}\n`,
		{ mode: 0o600 });
	const state = await LocalMissionHost.status(f.root);
	assert.equal(state.final, "attempted-unknown");
	assert.equal(await f.first.readFinal(), undefined);
	await assert.rejects(f.first.commitFinal({ attemptId: "A001", intentId: "seal-once",
		bytes: carry }), /one-use intent/);
});

test("orphan contract is visible for review and cannot become a checkpoint", async t => {
	const f = await fixture(t);
	await writeFile(path.join(f.root, "original-contract.json"), "orphan-private-contract",
		{ mode: 0o600 });
	const state = await LocalMissionHost.status(f.root);
	assert.equal(state.contractOrphan, true);
	assert.equal(state.repairRequired, true);
	assert.equal(await LocalMissionHost.readInitialContract(f.root), undefined);
	await assert.rejects(f.first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from("checkpoint") }), /prior evidence needs review/);
});

test("symlinked contract cannot be read as local evidence", async t => {
	const f = await fixture(t);
	const outside = path.join(f.parent, "outside");
	await writeFile(outside, "not evidence", { mode: 0o600 });
	await symlink(outside, path.join(f.root, "original-contract.json"));
	await assert.rejects(LocalMissionHost.status(f.root), /ELOOP|unsafe/);
});
