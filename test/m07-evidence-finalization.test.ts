import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runMeasuredEvidenceHandoff } from "../src/m07/evidence-finalization.ts";
import type { AssistantTurn, SessionHandle, ToolCallRecord, UsageEvent, UsageSummary } from "../src/runner/types.ts";

const usage = (input: number): UsageSummary => ({ input, output: 1, cacheRead: 0, cacheWrite: 0,
	totalTokens: input + 1, cost: input / 1000, reportedEvents: 1, unknownEvents: 0,
	complete: true, costComplete: true });

function fixture(onFinalization: (files: { source: string; evidence: string; log: ToolCallRecord[] }) => Promise<void>,
	options: { missingSource?: boolean; noEvents?: boolean; missingFirstUsage?: boolean } = {}) {
	const log: ToolCallRecord[] = [], events: UsageEvent[] = [];
	let prompts = 0;
	let source = "", evidence = "";
	const handle = {
		prompt: async (_message: string): Promise<AssistantTurn> => {
			prompts++;
			if (prompts === 1) {
				if (!options.missingSource) await writeFile(source, "candidate A\n");
			} else await onFinalization({ source, evidence, log });
			if (!options.noEvents) events.push({ entryId: `prompt-${prompts}`, kind: "assistant", promptIndex: prompts,
				at: new Date().toISOString(), status: "reported", costStatus: "priced",
				usage: { input: prompts, output: 1, cacheRead: 0, cacheWrite: 0,
					totalTokens: prompts + 1, cost: prompts / 1000 } });
			return { text: prompts === 1 ? "preliminary report" : "final report from current verification",
				stopReason: "stop", toolCalls: prompts, ...((prompts === 1 && options.missingFirstUsage) ? {} : { usage: usage(prompts) }) };
		},
		usageEvents: () => events, toolLog: () => log,
	} as SessionHandle;
	return { handle, log, setFiles: (s: string, e: string) => { source = s; evidence = e; }, get prompts() { return prompts; } };
}

test("same actor reads new host verification, finalizes report, and retains both prompt usages", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-measured-handoff-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async ({ evidence: file, log }) => {
		assert.equal((await readFile(file, "utf8")), '{"status":"passed","timeMs":7}');
		log.push({ name: "read", args: { path: "verification.json" }, ok: true, at: new Date().toISOString() });
		await writeFile(path.join(root, "lesson-delta.json"), '{"version":1,"action":"none","evidencePaths":[]}');
	});
	f.setFiles(source, evidence);
	let measured = 0;
	const result = await runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "read current evidence",
		measure: async () => { measured++; await writeFile(evidence, '{"status":"passed","timeMs":7}'); } });
	assert.equal(f.prompts, 2);
	assert.equal(measured, 1, "host measurements must not be rerun after finalization");
	assert.equal(result.text, "final report from current verification");
	assert.equal(result.toolCalls, 3);
	assert.equal(result.usage?.input, 3);
	assert.equal(result.usage?.reportedEvents, 2);
	assert.equal(await readFile(source, "utf8"), "candidate A\n");
});

test("candidate mutation after host measurement fails before reviewer handoff", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-mutated-handoff-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async ({ source: file, log }) => {
		log.push({ name: "read", args: { path: "verification.json" }, ok: true, at: new Date().toISOString() });
		await writeFile(file, "unmeasured candidate B\n");
	});
	f.setFiles(source, evidence);
	await assert.rejects(runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "finalize",
		measure: async () => writeFile(evidence, '{"status":"passed"}') }), /changed after measurement/);
});

test("host verification cannot silently measure a source that changes during the check", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-measure-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async () => {});
	f.setFiles(source, evidence);
	await assert.rejects(runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "finalize",
		measure: async () => { await writeFile(evidence, '{"status":"passed"}');
			await writeFile(source, "changed while measured\n"); } }), /changed while host verification ran/);
	assert.equal(f.prompts, 1);
});

test("verification mutation during finalization fails before reviewer handoff", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-evidence-mutation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async ({ evidence: file, log }) => {
		log.push({ name: "read", args: { path: "verification.json" }, ok: true, at: new Date().toISOString() });
		await writeFile(file, '{"status":"falsified"}');
	});
	f.setFiles(source, evidence);
	await assert.rejects(runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "finalize",
		measure: async () => writeFile(evidence, '{"status":"passed"}') }), /changed after measurement/);
});

test("claimed evidence without a successful post-measurement read fails closed", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-unread-handoff-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async () => {});
	f.setFiles(source, evidence);
	await assert.rejects(runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "finalize",
		measure: async () => writeFile(evidence, '{"status":"passed"}') }), /did not read/);
});

test("missing candidate remains a measured failure for ordinary repair review", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-missing-handoff-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async () => {}, { missingSource: true });
	f.setFiles(source, evidence);
	const result = await runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "finalize",
		measure: async () => writeFile(evidence, '{"status":"failed"}') });
	assert.equal(f.prompts, 1);
	assert.equal(result.text, "preliminary report");
});

test("a final-only usage summary is not misreported as the two-prompt total", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-usage-handoff-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, "candidate.cpp"), evidence = path.join(root, "verification.json");
	const f = fixture(async ({ log }) => {
		log.push({ name: "read", args: { path: "verification.json" }, ok: true, at: new Date().toISOString() });
	}, { noEvents: true, missingFirstUsage: true });
	f.setFiles(source, evidence);
	const result = await runMeasuredEvidenceHandoff({ handle: f.handle, implementationPrompt: "build",
		sourceFile: source, evidenceFile: evidence, readToolName: "read", finalizationPrompt: "finalize",
		measure: async () => writeFile(evidence, '{"status":"passed"}') });
	assert.equal(result.usage, undefined);
});
