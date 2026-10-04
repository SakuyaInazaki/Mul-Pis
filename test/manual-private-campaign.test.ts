import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

test("generic private campaign source-shape gate preserves non-target bodies", () => {
	const original = `static void baseline() { int x = 1; (void)x; }
// TODO first
static void targetA() { baseline(); }
// TODO second
static void targetB() { baseline(); }
static bool check() { return true; }
int main() { return check() ? 0 : 1; }
`;
	const candidate = original
		.replace("static void targetA() { baseline(); }", "static void targetA() {\n#pragma omp parallel\n { } }")
		.replace("static void targetB() { baseline(); }", "static void targetB() {\n#pragma omp parallel for\n for (int i = 0; i < 1; ++i) { } }");
	assert.equal(offlineChecks.sourceShape(original, candidate).ok, true);
	assert.equal(offlineChecks.sourceShape(original, candidate.replace("int x = 1", "int x = 2")).ok, false);
	assert.equal(offlineChecks.sourceShape(original, original).ok, false);
});

test("generic private campaign accepts only one C++ and two flat text inputs", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-input-fixture-"));
	try {
		await writeFile(path.join(directory, "fixture.cpp"), "int main() { return 0; }\n");
		await writeFile(path.join(directory, "guide.md"), "fixture\n");
		await writeFile(path.join(directory, "notes.txt"), "fixture\n");
		assert.equal((await offlineChecks.inputs(directory)).files.length, 3);
		await mkdir(path.join(directory, "nested"));
		await assert.rejects(offlineChecks.inputs(directory));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("isolation probe remains readable by the sandbox UID under umask 077", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-probe-fixture-"));
	const previous = process.umask(0o077);
	try {
		await offlineChecks.stageProbe(directory);
		assert.equal((await stat(path.join(directory, "probe.cpp"))).mode & 0o777, 0o644);
	} finally {
		process.umask(previous);
		await rm(directory, { recursive: true, force: true });
	}
});

test("checker bind source is top-level temporary storage, not under private 0700 workspace", async () => {
	const scratch = await offlineChecks.verifierScratch("original");
	try {
		assert.equal(path.dirname(scratch), os.tmpdir());
		assert.equal((await stat(scratch)).mode & 0o777, 0o777);
	} finally { await rm(scratch, { recursive: true, force: true }); }
});

test("private task failure diagnostic redacts exact key and authorization tokens", () => {
	const key = "sk-SYNTHETICPRIVATE123456";
	const message = `request failed Authorization: Bearer ${key}\nnext Bearer sk-ANOTHERSYNTHETIC777`;
	const redacted = offlineChecks.privateFailureMessage(message, key);
	assert.ok(redacted);
	assert.equal(redacted.includes(key), false);
	assert.equal(redacted.includes("sk-ANOTHERSYNTHETIC777"), false);
	assert.match(redacted, /REDACTED_KEY/);
});

test("private diagnostic redacts a key crossing the 4000-character output boundary", () => {
	const key = "sk-SYNTHETICBOUNDARYSECRET123456";
	const message = "x".repeat(3995) + key + " trailing diagnostic";
	const redacted = offlineChecks.privateFailureMessage(message, key);
	assert.ok(redacted);
	assert.equal(redacted.length, 4000);
	assert.equal(redacted.includes(key), false);
	assert.equal(redacted.slice(-5).includes("sk-"), false);
});

test("read-only credential probe uses one official model-list request and stores only status", async () => {
	let calls = 0;
	const mocked = (async (url: string | URL | Request, init?: RequestInit) => {
		calls++;
		assert.equal(String(url), "https://api.deepseek.com/models");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-SYNTHETIC_TEST_KEY");
		return new Response(null, { status: 200 });
	}) as typeof fetch;
	assert.deepEqual(await offlineChecks.credentialProbe("sk-SYNTHETIC_TEST_KEY", mocked),
		{ httpStatus: 200, accepted: true });
	assert.equal(calls, 1);
	const rejected = (async () => new Response(null, { status: 401 })) as typeof fetch;
	assert.deepEqual(await offlineChecks.credentialProbe("sk-SYNTHETIC_TEST_KEY", rejected),
		{ httpStatus: 401, accepted: false });
});
