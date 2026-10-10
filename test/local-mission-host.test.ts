import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import { objectiveProgress, type OriginalObjectiveContractV1 } from "../src/m07/objective-progress.ts";
import type { ProcessIdentityV1 } from "../src/runtime/process-identity.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const processOne: ProcessIdentityV1 = { hostId: "synthetic-host", bootId: "synthetic-boot",
	pid: 1001, processStartToken: "111" };
const processTwo: ProcessIdentityV1 = { ...processOne, pid: 1002, processStartToken: "222" };

async function recordSyntheticCleanContract(host: LocalMissionHost,
	contract: OriginalObjectiveContractV1): Promise<void> {
	const evidence = path.join(host.root, "evidence");
	await mkdir(evidence, { mode: 0o700 });
	const problem = Buffer.from("Synthetic frozen problem");
	await writeFile(path.join(evidence, "original-objective.json"), JSON.stringify(contract), { mode: 0o600 });
	await writeFile(path.join(evidence, "original-problem.txt"), problem, { mode: 0o600 });
	await host.recordInitialContract({ attemptId: "A001", bytes: Buffer.from(JSON.stringify({
		...contract, frozenInputs: [{ name: "original-problem.txt", bytes: problem.length,
			sha256: sha(problem) }] })) });
}

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

test("writer-lock initialization faults leave no orphan lock before mutation", async t => {
	for (const phase of ["before-stat", "after-open", "after-write", "after-sync",
		"after-close", "after-dir-sync"] as const) {
		const parent = await mkdtemp(path.join(os.tmpdir(), `mulpis-lock-init-${phase}-`));
		t.after(() => rm(parent, { recursive: true, force: true }));
		const root = path.join(parent, "mission");
		const input = { root, missionId: "mission-001", attemptId: "A001",
			codeRevision: "local-revision-1", currentIdentity: async () => processOne };
		await assert.rejects(LocalMissionHost.begin({ ...input,
			testLockInitFailureAt: phase }), /synthetic writer-lock initialization failure/);
		await assert.rejects(lstat(path.join(root, ".writer.lock")), { code: "ENOENT" }, phase);
		const before = await LocalMissionHost.status(root);
		assert.equal(before.repairRequired, false, phase);
		assert.equal(before.currentAttempt, null, phase);
		const host = await LocalMissionHost.begin(input);
		assert.equal((await host.status()).currentAttempt?.attemptId, "A001", phase);
	}
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

test("explicit clean-start release fences its live owner and permits only a pristine successor", async t => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "mulpis-clean-start-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const missionId = "mission-clean";
	const root = path.join(parent, ".agent", "missions", missionId);
	await mkdir(path.join(parent, ".agent"), { mode: 0o700 });
	const contract: OriginalObjectiveContractV1 = { version: 1, kind: "original-objective",
		id: missionId, createdAt: new Date().toISOString(), goal: "Synthetic task",
		goalSource: "verbatim-private-input", inputNames: ["problem.md"],
		obligations: [{ id: "check", description: "Check task" }], closure: "open-ended" };
	const first = await LocalMissionHost.begin({ root, missionId, attemptId: "A001",
		codeRevision: "revision-1", currentIdentity: async () => processOne });
	await recordSyntheticCleanContract(first, contract);
	const progress = objectiveProgress(contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: "next-task-pending", pendingActionFacts: {} });
	const initial = await first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from(JSON.stringify(progress)) });
	await assert.rejects(LocalMissionHost.begin({ root, missionId, attemptId: "A002",
		codeRevision: "revision-1", currentIdentity: async () => processTwo,
		probePrior: async () => ({ status: "alive", identityMatch: true, reason: "live owner" }) }),
		/may still be executing/);
	const release = await first.releaseCleanStart();
	assert.equal(release.checkpointSha256, initial.sha256);
	await assert.rejects(first.recordCheckpoint({ attemptId: "A001", sequence: 2,
		previousSha256: initial.sha256, bytes: Buffer.from("late") }), /not current/);
	await assert.rejects(LocalMissionHost.begin({ root, missionId, attemptId: "A001",
		codeRevision: "revision-1", currentIdentity: async () => processOne }), /was released/);
	const second = await LocalMissionHost.begin({ root, missionId, attemptId: "A002",
		codeRevision: "revision-1", currentIdentity: async () => processTwo,
		probePrior: async () => ({ status: "unknown", identityMatch: false, reason: "pid reused" }) });
	assert.equal(second.source.attemptId, "A002");
	const returned = Buffer.from(JSON.stringify(objectiveProgress(contract, { boundedRuns: [],
		selectedArtifacts: [], stopReason: "assessor-auth-unavailable", pendingActionFacts: {} })));
	const c2 = await second.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: initial.sha256, bytes: returned });
	const final = await second.releaseCleanReturn({ bytes: returned, verifyQuiescent: async () => true });
	assert.equal(final?.checkpointSha256, c2.sha256);
	assert.deepEqual(await second.readFinal(), returned);
	await assert.rejects(second.recordUnknownOperation({ attemptId: "A002", operationId: "late" }), /not current/);
	await assert.rejects(LocalMissionHost.begin({ root, missionId, attemptId: "A002",
		codeRevision: "revision-1", currentIdentity: async () => processTwo }), /final owner was released/);
	const third = await LocalMissionHost.begin({ root, missionId, attemptId: "A003",
		codeRevision: "revision-1", currentIdentity: async () => ({ ...processTwo, pid: 1003 }),
		probePrior: async () => ({ status: "unknown", identityMatch: false, reason: "pid reused" }) });
	assert.equal(third.source.attemptId, "A003");
});

test("clean-start release never covers an unknown operation or mission-bound stage", async t => {
	for (const poison of ["operation", "stage"] as const) {
		const parent = await mkdtemp(path.join(os.tmpdir(), `mulpis-clean-${poison}-`));
		t.after(() => rm(parent, { recursive: true, force: true }));
		const missionId = `mission-${poison}`;
		const root = path.join(parent, ".agent", "missions", missionId);
		await mkdir(path.join(parent, ".agent"), { mode: 0o700 });
		const contract: OriginalObjectiveContractV1 = { version: 1, kind: "original-objective",
			id: missionId, createdAt: new Date().toISOString(), goal: "Synthetic task",
			goalSource: "verbatim-private-input", inputNames: ["problem.md"],
			obligations: [{ id: "check", description: "Check task" }], closure: "open-ended" };
		const first = await LocalMissionHost.begin({ root, missionId, attemptId: "A001",
			codeRevision: "revision-1", currentIdentity: async () => processOne });
		await recordSyntheticCleanContract(first, contract);
		await first.recordCheckpoint({ attemptId: "A001", sequence: 1,
			previousSha256: null, bytes: Buffer.from(JSON.stringify(objectiveProgress(contract,
				{ boundedRuns: [], selectedArtifacts: [], stopReason: "next-task-pending", pendingActionFacts: {} }))) });
		await first.releaseCleanStart();
		if (poison === "operation") {
			const operationId = "unknown-child";
			await writeFile(path.join(root, "attempts", "A001", "operations", `${sha(Buffer.from(operationId))}.json`),
				`${JSON.stringify({ version: 1, kind: "local-mission-unknown-operation", source: first.source,
					operationId, effects: "unknown-unreconciled", accounting: "unquantified" })}\n`, { mode: 0o600 });
		} else {
			const run = path.join(parent, "stages", "MISSION", "issued-run");
			await mkdir(run, { recursive: true });
			await writeFile(path.join(run, "run.json"), JSON.stringify({ inputs: [
				{ path: path.join(root, "evidence", "original-objective.json") }] }));
		}
		await assert.rejects(LocalMissionHost.begin({ root, missionId, attemptId: "A002",
			codeRevision: "revision-1", currentIdentity: async () => processTwo,
			probePrior: async () => ({ status: "unknown", identityMatch: false, reason: "identity unknown" }) }),
			/may still be executing/);
	}
});

test("ordinary clean return refuses an unresolved operation and leaves the old owner unfenced", async t => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "mulpis-return-unknown-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	await mkdir(path.join(parent, ".agent"), { mode: 0o700 });
	const missionId = "mission-return-unknown", root = path.join(parent, ".agent", "missions", missionId);
	const contract: OriginalObjectiveContractV1 = { version: 1, kind: "original-objective",
		id: missionId, createdAt: new Date().toISOString(), goal: "Synthetic task",
		goalSource: "verbatim-private-input", inputNames: ["problem.md"],
		obligations: [{ id: "check", description: "Check task" }], closure: "open-ended" };
	const first = await LocalMissionHost.begin({ root, missionId, attemptId: "A001",
		codeRevision: "revision-1", currentIdentity: async () => processOne });
	await recordSyntheticCleanContract(first, contract);
	const initial = await first.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from(JSON.stringify(objectiveProgress(contract,
			{ boundedRuns: [], selectedArtifacts: [], stopReason: "next-task-pending", pendingActionFacts: {} }))) });
	await first.releaseCleanStart();
	const second = await LocalMissionHost.begin({ root, missionId, attemptId: "A002",
		codeRevision: "revision-1", currentIdentity: async () => processTwo });
	await second.recordUnknownOperation({ attemptId: "A002", operationId: "unsettled-child" });
	const held = Buffer.from(JSON.stringify(objectiveProgress(contract, { boundedRuns: [],
		selectedArtifacts: [], stopReason: "execution-interrupted",
		unresolvedOperationIds: ["unsettled-child"],
		pendingActionFacts: { unresolvedOperationRefs: ["unsettled-child"] } })));
	await second.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: initial.sha256, bytes: held });
	assert.equal(await second.releaseCleanReturn({ bytes: held, verifyQuiescent: async () => true }), undefined);
	assert.equal((await second.status()).final, "none");
	await assert.rejects(LocalMissionHost.begin({ root, missionId, attemptId: "A003",
		codeRevision: "revision-1", currentIdentity: async () => ({ ...processTwo, pid: 1003 }),
		probePrior: async () => ({ status: "unknown", identityMatch: false, reason: "pid reused" }) }),
		/may still be executing/);
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
