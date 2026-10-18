import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDeviceLease, readDeviceLease } from "../../src/platform/device-lease.ts";
import { createPlatformGate, platformGateFromEnvironment, type PlatformReceiptV1 } from "../../src/platform/gate.ts";
import { parsePlatformProfile } from "../../src/platform/profile.ts";
import { readCurrentProcessIdentity } from "../../src/runtime/process-identity.ts";
import { profileFixture } from "./profile-fixture.ts";

const KERNEL = `constexpr int BUFFER_NUM = 2;
pipe.InitBuffer(inQueue, 1024);
inQueue.EnQue(local);
inQueue.DeQue(local);
int tailLength = total % tileLength;
`;

async function workspace(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-platform-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	return root;
}

async function receipts(file: string): Promise<PlatformReceiptV1[]> {
	return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as PlatformReceiptV1);
}

test("the gate refuses writes outside the editable surface and records every decision", async t => {
	const root = await workspace(t);
	const receiptFile = path.join(root, "receipts", "platform.jsonl");
	const gate = createPlatformGate({ profile: parsePlatformProfile(profileFixture()),
		root, receiptFile, sessionId: "S1" });

	const readOnly = await gate.checkWrite(path.join(root, "verify", "reference.py"), "print(1)", 1);
	assert.match(readOnly.rejected ?? "", /keeps verify\/reference\.py read-only/);
	const illegal = await gate.checkWrite(path.join(root, "kernel", "elementwise.cpp"), "void Launch() { SetBlockDim(1); }", 1);
	assert.match(illegal.rejected ?? "", /REJECTED kernel\/elementwise\.cpp:1 \[single-core-launch\/performance\]/);
	assert.equal((await gate.checkWrite(path.join(root, "kernel", "elementwise.cpp"), KERNEL, 1)).rejected, undefined);
	const rows = await receipts(receiptFile);
	assert.deepEqual(rows.map(row => row.kind), ["write-outside-surface", "write-rejected"]);
	assert.equal(rows[0].sessionId, "S1");
	assert.deepEqual(rows[1].findings?.map(item => item.ruleId).sort(), ["single-core-launch", "tail-mask"]);
});

test("a warning does not block the write but still reaches the model", async t => {
	const root = await workspace(t);
	const receiptFile = path.join(root, "platform.jsonl");
	const gate = createPlatformGate({ profile: parsePlatformProfile(profileFixture()), root, receiptFile });
	const verdict = await gate.checkWrite(path.join(root, "kernel", "matmul.cpp"), KERNEL, 1);
	assert.equal(verdict.rejected, undefined);
	assert.match(verdict.warning ?? "", /WARNING kernel\/matmul\.cpp:0 \[high-throughput-mode\/performance\] the high-throughput mode switch is absent/);
	assert.deepEqual((await receipts(receiptFile)).map(row => row.kind), ["write-accepted"]);
});

test("one round changes one file", async t => {
	const root = await workspace(t);
	const gate = createPlatformGate({ profile: parsePlatformProfile(profileFixture()), root });
	assert.equal((await gate.checkWrite(path.join(root, "kernel", "a.cpp"), KERNEL, 7)).rejected, undefined);
	assert.equal((await gate.checkWrite(path.join(root, "kernel", "a.cpp"), `${KERNEL}// again\n`, 7)).rejected, undefined);
	const second = await gate.checkWrite(path.join(root, "kernel", "b.cpp"), KERNEL, 7);
	assert.match(second.rejected ?? "", /allows one file per round; this round already changed kernel\/a\.cpp/);
	// The next round is free to move to another file.
	assert.equal((await gate.checkWrite(path.join(root, "kernel", "b.cpp"), KERNEL, 8)).rejected, undefined);
});

test("only device commands take the device, and the lease is released afterwards", async t => {
	const root = await workspace(t);
	const raw = profileFixture();
	const leaseFile = path.join(root, "device.lease");
	(raw.deviceSerialization as { leaseFile: string }).leaseFile = leaseFile;
	const receiptFile = path.join(root, "platform.jsonl");
	const gate = createPlatformGate({ profile: parsePlatformProfile(raw), root, receiptFile });
	let heldDuring: string | undefined;
	const value = await gate.withDevice("device-run --case c1", async () => {
		heldDuring = (await readDeviceLease(leaseFile))?.purpose;
		return "measured";
	});
	assert.equal(value, "measured");
	assert.equal(heldDuring, "device-run --case c1");
	assert.equal(await readDeviceLease(leaseFile), undefined);
	// A failing device command must not keep the device.
	await assert.rejects(gate.withDevice("device-profile", async () => { throw new Error("boom"); }), /boom/);
	assert.equal(await readDeviceLease(leaseFile), undefined);
	let observedLease = true;
	await gate.withDevice("grep -n tile kernel/a.cpp", async () => { observedLease = Boolean(await readDeviceLease(leaseFile)); });
	assert.equal(observedLease, false);
	assert.deepEqual((await receipts(receiptFile)).map(row => row.kind), ["device-lease", "device-lease"]);
});

test("profiler output becomes one deterministic label appended after the original bytes", async t => {
	const root = await workspace(t);
	const receiptFile = path.join(root, "platform.jsonl");
	const gate = createPlatformGate({ profile: parsePlatformProfile(profileFixture()), root, receiptFile });
	assert.equal(await gate.observe("bash", "all good"), undefined);
	const note = await gate.observe("bash", "mte2_ratio: 0.63\nvector_ratio: 0.26");
	assert.match(note ?? "", /bottleneck transfer/);
	const rows = await receipts(receiptFile);
	assert.deepEqual(rows.map(row => row.kind), ["diagnosis"]);
	assert.equal(rows[0].bottleneck, "transfer");
});

test("the platform binding comes from the host environment only", async t => {
	const root = await workspace(t);
	const file = path.join(root, "profile.json");
	await writeFile(file, JSON.stringify(profileFixture()));
	assert.equal(await platformGateFromEnvironment({ root, env: {} }), undefined);
	const gate = await platformGateFromEnvironment({ root, env: { PRE_RSI_PLATFORM_PROFILE: file } });
	assert.equal(gate?.profile.id, "device-a");
	await writeFile(file, "{ not json");
	await assert.rejects(platformGateFromEnvironment({ root, env: { PRE_RSI_PLATFORM_PROFILE: file } }),
		/platform profile could not be read as JSON/);
});

test("the device lease is exclusive, reclaimed from a dead owner and never from a live one", async t => {
	const root = await workspace(t);
	const file = path.join(root, "device.lease");
	const first = await acquireDeviceLease({ file, platformId: "device-a", purpose: "case c1", timeoutMs: 50 });
	assert.equal((await readDeviceLease(file))?.purpose, "case c1");

	let waited = 0;
	let clock = 0;
	await assert.rejects(acquireDeviceLease({ file, platformId: "device-a", purpose: "case c2", timeoutMs: 1_000,
		now: () => clock, sleep: async ms => { waited += ms; clock += ms; } }), /is held by pid \d+ \(case c1\)/);
	assert.equal(waited >= 1_000, true);
	await first.release();
	assert.equal(await readDeviceLease(file), undefined);

	// A holder from an earlier boot cannot still be measuring, so it is displaced.
	const identity = await readCurrentProcessIdentity();
	await writeFile(file, `${JSON.stringify({ version: 1, platformId: "device-a", purpose: "stale",
		acquiredAt: new Date().toISOString(), owner: { ...identity, bootId: "boot-from-last-week" } })}\n`);
	const reclaimed = await acquireDeviceLease({ file, platformId: "device-a", purpose: "case c3", timeoutMs: 50 });
	assert.equal((await readDeviceLease(file))?.purpose, "case c3");
	// Releasing with a different identity leaves the lease alone.
	await reclaimed.release();
	assert.equal(await readDeviceLease(file), undefined);
	await assert.doesNotReject(stat(root));
});
