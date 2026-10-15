import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivePrivateM07Task, loadPrivateM07Archive, recordPrivateM04Outcome, M04_KNOWLEDGE_EXPORT_NAME } from "../src/workflow-archive/m07-private.ts";
import type { CurrentGoal, M07TaskRecord } from "../src/m07/types.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";

test("private M07 archive keeps each bounded round's source and host verification, plus structured reviewer feedback", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-rounds-")));
	try {
		const workDir = path.join(root, "task", "work"), destination = path.join(root, "returned");
		await mkdir(workDir, { recursive: true });
		await writeFile(path.join(workDir, "candidate.cpp"), "second candidate\n");
		for (const index of [1, 2]) {
			const snapshot = path.join(root, "task", `round-${index}-snapshot`);
			await mkdir(snapshot);
			await writeFile(path.join(snapshot, "candidate.cpp"), `round ${index} source\n`);
			const timings = [1, 2].flatMap(target => [1, 4].flatMap(threads => [[64, 32], [128, 64]].map(([rows, cols]) =>
				({ target, rows, cols, threads, repeats: 16, elapsedNs: 1000 * target * threads * rows }))));
			await writeFile(path.join(snapshot, "verification.json"), JSON.stringify({ version: 1, status: index === 1 ? "failed" : "passed",
				compile: { success: true, stderrTail: "private compiler output" },
				originalCheckerRuns: [{ args: ["--sensitive-command-arg"], exitCode: 0, isolatedProcessWallMs: 42, stdout: "private stdout" }],
				independent: { status: index === 1 ? "failed" : "passed", timings, stderrTail: "private checker output" },
				originalBaselineIndependent: { status: "passed", timings: timings.map(item => ({ ...item, elapsedNs: item.elapsedNs * 2 })) },
				originalHostComparison: { state: "measured", ratios: Array(8).fill(1.25), medianRatio: 1.25, minRatio: 1.25, advisory: "not trusted" },
				priorCandidateComparison: { state: "unavailable", note: "not trusted" } }));
		}
		const task = { taskId: "T001", workDir, status: "returned", executionRounds: [
			{ index: 1, verdict: "revise", feedback: "Fix the first round.", reviewerSnapshotPath: path.join(root, "task", "round-1-snapshot") },
			{ index: 2, verdict: "ready", feedback: "Second round passed observed checks.", reviewerSnapshotPath: path.join(root, "task", "round-2-snapshot") },
		] } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		const archive = await archivePrivateM07Task({ goal, task, destination });
		assert.equal(archive.controllerEvidence.rounds.length, 2);
		assert.equal(archive.controllerEvidence.rounds[0].feedback, "Fix the first round.");
		assert.equal(await readFile(path.join(destination, "round-1-reviewer-feedback.txt"), "utf8"), "Fix the first round.");
		assert.equal((await loadPrivateM07Archive(destination)).roundFiles[0].feedback, path.join(destination, "round-1-reviewer-feedback.txt"));
		assert.equal(archive.controllerEvidence.rounds[0].candidate.status, "present");
		assert.equal(await readFile(path.join(destination, "round-1-candidate.cpp"), "utf8"), "round 1 source\n");
		assert.equal(await readFile(path.join(destination, "round-2-candidate.cpp"), "utf8"), "round 2 source\n");
		const verification = await readFile(path.join(destination, "round-2-verification.json"), "utf8");
		assert.match(verification, /"status": "passed"/);
		const checked = JSON.parse(verification);
		assert.equal(checked.independent.timings.length, 8);
		assert.equal(checked.independent.timings[0].elapsedNs, 64_000);
		assert.equal(checked.originalBaselineIndependent.timings.length, 8);
		assert.equal(checked.originalBaselineIndependent.timings[0].elapsedNs, 128_000);
		assert.equal(checked.originalHostComparison.medianRatio, 1.25);
		assert.deepEqual(checked.priorCandidateComparison, { state: "unavailable" });
		assert.doesNotMatch(verification, /private|sensitive-command-arg|stdout|stderr|args/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private review archive redacts credential values without discarding surrounding rationale", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-review-redaction-")));
	try {
		const workDir = path.join(root, "task", "work"), destination = path.join(root, "returned");
		await mkdir(workDir, { recursive: true });
		const task = { taskId: "T001", workDir, status: "returned", executionRounds: [
			{ index: 1, verdict: "revise", feedback: 'The independent check failed. api_key=sk-AbCdEfGhIjKlMnOp; {"password":"hidden-value"}; Authorization: Basic dXNlcjpwYXNz; run it again with a safe fixture.' },
		] } as M07TaskRecord;
		const archive = await archivePrivateM07Task({ goal: { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal, task, destination });
		const saved = await readFile(path.join(destination, "round-1-reviewer-feedback.txt"), "utf8");
		assert.match(saved, /independent check failed/);
		assert.match(saved, /safe fixture/);
		assert.doesNotMatch(saved, /sk-AbCdEfGhIjKlMnOp/);
		assert.doesNotMatch(saved, /hidden-value/);
		assert.doesNotMatch(saved, /dXNlcjpwYXNz/);
		assert.equal(archive.controllerEvidence.rounds[0].feedbackRedacted, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private M04 export carries actual adopted record content, pinned dependencies, limits and snapshot without trusting the external archive", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-knowledge-")));
	try {
		const workDir = path.join(root, "work"), destination = path.join(root, "returned");
		await mkdir(workDir);
		await writeFile(path.join(workDir, "candidate.cpp"), "candidate\n");
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		await archivePrivateM07Task({ goal, task, destination });
		const store = createFileKnowledgeStore(path.join(root, "knowledge"));
		await store.init();
		const storeId = await store.storeId();
		const evidence = await store.submitProposal({ stage: "M04", runId: "earlier", ops: [
			{ op: "create", type: "E", title: "Independent evidence", body: "Synthetic controlled check", usageDecision: "adopted" },
		] });
		assert.equal(evidence.structurallyValid, true);
		await store.merge(evidence.proposalId);
		const experience = await store.submitProposal({ stage: "M04", runId: "m04-run", ops: [
			{ op: "create", type: "K", title: "Bounded executor method", body: "Use an independent check before claiming readiness.", usageDecision: "adopted",
				fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: [], excludedTags: [],
					requiredRefs: [{ storeId, recordId: "E001", version: 1 }] } } },
			{ op: "limit", target: "E001", kind: "needs_recheck", reason: "Synthetic evidence needs a fresh check", authority: "synthetic-test" },
		] });
		assert.equal(experience.structurallyValid, true, JSON.stringify(experience.issues));
		const merged = await store.merge(experience.proposalId);
		const updated = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-run", proposalSubmitted: true,
			snapshotCreated: true, adoptedExperienceRefs: [] }, store);
		assert.equal(updated.m04?.knowledgeExport?.state, "complete");
		assert.deepEqual(updated.m04?.adoptedExperienceRefs, [], "a live dependency limit blocks follow-on eligibility");
		assert.equal(updated.knowledgeReuse.trustedAdoption, false);
		const exported = JSON.parse(await readFile(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME), "utf8"));
		assert.equal(exported.snapshot.id, merged.snapshot.id);
		assert.equal(exported.records.length, 2);
		assert.equal(exported.records.find((item: { ref: { recordId: string } }) => item.ref.recordId === "K001").record.body,
			"Use an independent check before claiming readiness.");
		assert.equal(exported.records.find((item: { ref: { recordId: string } }) => item.ref.recordId === "K001").record.usageDecision,
			"adopted", "the exact historical M04 decision remains exported despite current limits");
		assert.deepEqual(exported.dependencies, [{ from: { storeId, recordId: "K001", version: 1 },
			to: { storeId, recordId: "E001", version: 1 }, kind: "required" }]);
		assert.equal(exported.activeLimits.some((limit: { target: string; kind: string }) => limit.target === "E001" && limit.kind === "needs_recheck"), true);
		assert.equal((await loadPrivateM07Archive(destination)).m04Knowledge, path.join(destination, M04_KNOWLEDGE_EXPORT_NAME));
		assert.equal(exported.provenance.restore, "explicit-provenance-and-live-limit-check-required");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("M04 export marks missing store or unsafe knowledge incomplete instead of inventing adoption", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-incomplete-")));
	try {
		const workDir = path.join(root, "work"), destination = path.join(root, "returned");
		await mkdir(workDir);
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		await archivePrivateM07Task({ goal, task, destination });
		const missing = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-run" });
		assert.equal(missing.m04?.knowledgeExport?.state, "incomplete");
		assert.equal(missing.m04?.knowledgeExport?.failureKind, "store-unavailable");
		assert.equal(missing.knowledgeReuse.trustedAdoption, false);
		assert.equal(existsSync(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME)), false);
		const legacy = JSON.parse(await readFile(path.join(destination, "workflow-archive.json"), "utf8"));
		delete legacy.m04.knowledgeExport.failureKind;
		await writeFile(path.join(destination, "workflow-archive.json"), JSON.stringify(legacy));
		assert.equal((await loadPrivateM07Archive(destination)).archive.m04?.knowledgeExport?.state, "incomplete",
			"older private archives with a reason but no failureKind remain readable");
		const store = createFileKnowledgeStore(path.join(root, "knowledge"));
		await store.init();
		const proposal = await store.submitProposal({ stage: "M04", runId: "m04-run", ops: [
			{ op: "create", type: "K", title: "Unsafe example", body: "A synthetic sk-a_b-c_d_e value must not leave the private store.", usageDecision: "adopted",
				fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: [], excludedTags: [], requiredRefs: [] } } },
		] });
		assert.equal(proposal.structurallyValid, true);
		await store.merge(proposal.proposalId);
		const unsafe = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-run" }, store);
		assert.equal(unsafe.m04?.knowledgeExport?.state, "incomplete");
		assert.equal(existsSync(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME)), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("M04 export retains candidate, negative and limit-only published outcomes without claiming adoption", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-negative-")));
	try {
		const workDir = path.join(root, "work"), destination = path.join(root, "returned");
		await mkdir(workDir);
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		await archivePrivateM07Task({ goal, task, destination });
		const store = createFileKnowledgeStore(path.join(root, "knowledge"));
		await store.init();
		// The earlier evidence is deliberately separate from the M04 outcome under test.
		const baseline = await store.submitProposal({ stage: "M04", runId: "prior", ops: [
			{ op: "create", type: "E", title: "Earlier observation", body: "Synthetic earlier observation", usageDecision: "adopted" },
		] });
		assert.equal(baseline.structurallyValid, true);
		await store.merge(baseline.proposalId);
		const current = await store.submitProposal({ stage: "M04", runId: "m04-negative", ops: [
			{ op: "create", type: "K", title: "Candidate method", body: "Needs more testing", usageDecision: "candidate",
				fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: [], excludedTags: [], requiredRefs: [] } } },
			{ op: "create", type: "J", title: "Negative finding", body: "The tested method did not pass the observed case.", usageDecision: "adopted" },
			{ op: "limit", target: "E001", kind: "needs_recheck", reason: "A new counterexample needs checking", authority: "M04 review" },
		] });
		assert.equal(current.structurallyValid, true, JSON.stringify(current.issues));
		await store.merge(current.proposalId);
		const updated = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-negative", proposalSubmitted: true, snapshotCreated: true }, store);
		assert.equal(updated.m04?.knowledgeExport?.state, "complete");
		assert.deepEqual(updated.m04?.adoptedExperienceRefs, []);
		const exported = JSON.parse(await readFile(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME), "utf8"));
		assert.deepEqual(exported.m04SourceRefs.map((ref: { recordId: string }) => ref.recordId), ["J001", "K001"]);
		assert.equal(exported.records.find((item: { ref: { recordId: string } }) => item.ref.recordId === "K001").record.usageDecision, "candidate");
		assert.match(exported.records.find((item: { ref: { recordId: string } }) => item.ref.recordId === "J001").record.body, /did not pass/);
		assert.equal(exported.activeLimits.some((limit: { target: string }) => limit.target === "E001"), true);
		assert.equal(exported.snapshot.id, (await store.current())?.id);
		const limitOnly = await store.submitProposal({ stage: "M04", runId: "m04-limit-only", ops: [
			{ op: "limit", target: "K001", kind: "withdrawn", reason: "The candidate is ruled out", authority: "M04 review" },
		] });
		assert.equal(limitOnly.structurallyValid, true);
		await store.merge(limitOnly.proposalId);
		const limited = await recordPrivateM04Outcome(destination,
			{ state: "completed", runId: "m04-limit-only", proposalSubmitted: true, snapshotCreated: true }, store);
		assert.equal(limited.m04?.knowledgeExport?.state, "complete");
		const limitExport = JSON.parse(await readFile(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME), "utf8"));
		assert.deepEqual(limitExport.m04SourceRefs, []);
		assert.deepEqual(limitExport.m04LimitTargetRefs.map((ref: { recordId: string }) => ref.recordId), ["K001"]);
		assert.equal(limitExport.records.some((item: { ref: { recordId: string } }) => item.ref.recordId === "K001"), true,
			"a limit-only decision still exports its target content for later provenance review");
		assert.equal(limitExport.activeLimits.some((limit: { target: string; kind: string }) => limit.target === "K001" && limit.kind === "withdrawn"), true);
	} finally { await rm(root, { recursive: true, force: true }); }
});
