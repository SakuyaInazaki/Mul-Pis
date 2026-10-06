import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivePrivateM07Task, loadPrivateM07Archive, recordPrivateM04Outcome, M04_KNOWLEDGE_EXPORT_NAME } from "../src/workflow-archive/m07-private.ts";
import type { CurrentGoal, M07TaskRecord } from "../src/m07/types.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";

test("private M07 archive retains bounded artifacts and a pending lesson without adopting it", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-test-"));
	try {
		const workDir = path.join(root, "task", "work"), destination = path.join(root, "returned");
		await mkdir(workDir, { recursive: true });
		await writeFile(path.join(workDir, "candidate.cpp"), "int main() { return 0; }\n");
		await writeFile(path.join(workDir, "verification.json"), '{"status":"passed"}\n');
		await writeFile(path.join(workDir, "lesson-delta.json"), JSON.stringify({ version: 1, action: "propose",
			observation: "Synthetic observation", applicability: "Synthetic case", evidencePaths: ["verification.json"] }));
		await writeFile(path.join(workDir, "credentials.json"), "DO_NOT_ARCHIVE");
		const task = { taskId: "T001", workDir, status: "returned", executionRounds: [{ index: 1, verdict: "ready" }] } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		const archived = await archivePrivateM07Task({ goal, task, destination });
		assert.equal(archived.goalOutcome, "active");
		assert.equal(archived.lesson.state, "pending-m04");
		assert.equal(archived.knowledgeReuse.trustedAdoption, false);
		assert.equal(existsSync(path.join(destination, "credentials.json")), false);
		const loaded = await loadPrivateM07Archive(destination);
		assert.equal(loaded.archive.taskId, "T001");
		assert.ok(loaded.candidate && loaded.verification && loaded.lesson);
		assert.equal((await readFile(loaded.candidate, "utf8")).includes("int main"), true);
		const afterM04 = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-run", proposalSubmitted: false,
			snapshotCreated: false, adoptedExperienceRefs: [] });
		assert.equal(afterM04.m04?.state, "completed");
		assert.equal(afterM04.knowledgeReuse.trustedAdoption, false);
		assert.equal((await loadPrivateM07Archive(destination)).archive.m04?.proposalSubmitted, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private M07 archive records missing lesson rather than inventing adoption", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-missing-"));
	try {
		const workDir = path.join(root, "work"); await mkdir(workDir);
		await writeFile(path.join(workDir, "candidate.cpp"), "candidate\n");
		const task = { taskId: "T001", workDir, status: "failed" } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "finished", outcome: "partial", tasks: [task] } as CurrentGoal;
		const archived = await archivePrivateM07Task({ goal, task, destination: path.join(root, "result") });
		assert.equal(archived.lesson.state, "missing");
		assert.equal(archived.controllerEvidence.reviewStatus, "unreviewed");
		assert.equal(archived.goalOutcome, "partial");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private M07 archive rejects a lesson whose evidence is missing or revision ref is unpinned", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-invalid-"));
	try {
		const workDir = path.join(root, "work"); await mkdir(workDir);
		await writeFile(path.join(workDir, "candidate.cpp"), "candidate\n");
		await writeFile(path.join(workDir, "lesson-delta.json"), JSON.stringify({ version: 1, action: "propose",
			observation: "Synthetic", applicability: "Synthetic", evidencePaths: ["missing.json"] }));
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		const first = await archivePrivateM07Task({ goal, task, destination: path.join(root, "out1") });
		assert.equal(first.lesson.state, "invalid");
		await writeFile(path.join(workDir, "verification.json"), "{}\n");
		await writeFile(path.join(workDir, "lesson-delta.json"), JSON.stringify({ version: 1, action: "amend",
			observation: "Synthetic", applicability: "Synthetic", evidencePaths: ["verification.json"] }));
		const second = await archivePrivateM07Task({ goal, task, destination: path.join(root, "out2") });
		assert.equal(second.lesson.state, "invalid");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private M07 archive keeps each bounded round's source and host verification, plus structured reviewer feedback", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-rounds-"));
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

test("private archive retains full long reviewer rationale and explicit controller decision as bounded artifacts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-review-evidence-"));
	try {
		const workDir = path.join(root, "task", "work"), destination = path.join(root, "returned");
		await mkdir(workDir, { recursive: true });
		const feedback = Array.from({ length: 35 }, (_, index) => `Reason ${index + 1}: inspect the original candidate and check the actual measured row before accepting.`).join("\n");
		const reviewerReport = `Reviewer verdict and full explicit rationale:\n${feedback}\n`;
		const reviewerReportPath = path.join(root, "task", "round-1-reviewer.md");
		await writeFile(reviewerReportPath, reviewerReport);
		const task = { taskId: "T001", workDir, status: "rejected", executionRounds: [
			{ index: 1, verdict: "revise", feedback, reviewerReportPath },
		], review: { at: new Date().toISOString(), frozenReportPath: path.join(root, "task", "report.md"),
			checks: [{ criterion: "real check", result: "failed", evidence: [] }], artifacts: [],
			failures: ["Independent measurement did not cover the second target."], unexecuted: ["4-thread replay"],
			limitations: ["Measurement must be serialized to avoid contention."],
			independentCheck: { taskId: "T002", report: path.join(root, "task", "independent.md"), disposition: "Reject the candidate pending a full retry." } } } as unknown as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		const archive = await archivePrivateM07Task({ goal, task, destination });
		assert.equal(archive.controllerEvidence.rounds[0].feedbackStatus, "present");
		assert.equal(archive.controllerEvidence.rounds[0].feedback, undefined, "short inline preview is not mistaken for the full rationale");
		assert.equal(await readFile(path.join(destination, "round-1-reviewer-feedback.txt"), "utf8"), feedback);
		assert.equal(await readFile(path.join(destination, "round-1-reviewer-report.md"), "utf8"), reviewerReport);
		const decision = JSON.parse(await readFile(path.join(destination, "review-decision.json"), "utf8"));
		assert.deepEqual(decision.failures, task.review!.failures);
		assert.deepEqual(decision.unexecuted, task.review!.unexecuted);
		assert.equal(decision.independentCheck.disposition, task.review!.independentCheck!.disposition);
		const loaded = await loadPrivateM07Archive(destination);
		assert.equal(loaded.reviewDecision, path.join(destination, "review-decision.json"));
		assert.equal(loaded.roundFiles[0].reviewerReport, path.join(destination, "round-1-reviewer-report.md"));
		await rm(path.join(destination, "round-1-reviewer-feedback.txt"));
		await assert.rejects(loadPrivateM07Archive(destination), /feedback file is missing or changed/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private review archive redacts credential values without discarding surrounding rationale", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-review-redaction-"));
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

test("review text beyond the private archive hard limit fails visibly instead of reporting a normal exclusion", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-review-limit-"));
	try {
		const workDir = path.join(root, "task", "work"), destination = path.join(root, "returned");
		await mkdir(workDir, { recursive: true });
		const task = { taskId: "T001", workDir, status: "returned", executionRounds: [
			{ index: 1, verdict: "revise", feedback: "A".repeat(512_001) },
		] } as M07TaskRecord;
		await assert.rejects(archivePrivateM07Task({ goal: { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal, task, destination }), /hard limit/);
		assert.equal(existsSync(path.join(destination, "workflow-archive.json")), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private archive rejects malformed trusted numeric measurements rather than copying advisory payloads", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-bad-measurement-"));
	try {
		const workDir = path.join(root, "work"), destination = path.join(root, "returned");
		await mkdir(workDir);
		await writeFile(path.join(workDir, "verification.json"), JSON.stringify({ status: "passed",
			independent: { status: "passed", timings: Array.from({ length: 8 }, (_, target) => ({ target: target % 2 + 1,
				rows: 1024, cols: 509, threads: target % 2 ? 1 : 4, repeats: 16, elapsedNs: "sk-a_b-c_d_e" })) },
			originalHostComparison: { state: "measured", ratios: Array(8).fill(1), medianRatio: 1, minRatio: 1 } }));
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		const archive = await archivePrivateM07Task({ goal: { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal,
			task, destination });
		assert.equal(archive.files.find(file => file.name === "verification.json")?.status, "invalid");
		assert.equal(existsSync(path.join(destination, "verification.json")), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private M04 export carries actual adopted record content, pinned dependencies, limits and snapshot without trusting the external archive", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-knowledge-"));
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
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-incomplete-"));
	try {
		const workDir = path.join(root, "work"), destination = path.join(root, "returned");
		await mkdir(workDir);
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		const goal = { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal;
		await archivePrivateM07Task({ goal, task, destination });
		const missing = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-run" });
		assert.equal(missing.m04?.knowledgeExport?.state, "incomplete");
		assert.equal(missing.knowledgeReuse.trustedAdoption, false);
		assert.equal(existsSync(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME)), false);
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
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-negative-"));
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

test("M04 export passes a live adopted experience with required tags to explicit authoritative follow-on selection", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-archive-eligible-"));
	try {
		const workDir = path.join(root, "work"), destination = path.join(root, "returned");
		await mkdir(workDir);
		const task = { taskId: "T001", workDir, status: "returned" } as M07TaskRecord;
		await archivePrivateM07Task({ goal: { runId: "run-example", lifecycle: "active", tasks: [task] } as CurrentGoal, task, destination });
		const store = createFileKnowledgeStore(path.join(root, "knowledge"));
		await store.init();
		const proposal = await store.submitProposal({ stage: "M04", runId: "m04-live", ops: [
			{ op: "create", type: "K", title: "Live adopted method", body: "Check the observed evidence first.", usageDecision: "adopted",
				fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: ["cpp-parallel"], excludedTags: [], requiredRefs: [] } } },
		] });
		assert.equal(proposal.structurallyValid, true);
		await store.merge(proposal.proposalId);
		const recorded = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-live", proposalSubmitted: true, snapshotCreated: true }, store);
		assert.deepEqual(recorded.m04?.adoptedExperienceRefs, [{ storeId: await store.storeId(), recordId: "K001", version: 1 }]);
		assert.equal(recorded.knowledgeReuse.trustedAdoption, false);
		const downgraded = await recordPrivateM04Outcome(destination, { state: "completed", runId: "m04-live" });
		assert.equal(downgraded.m04?.knowledgeExport?.state, "incomplete");
		const staleReplacement = await readFile(path.join(destination, M04_KNOWLEDGE_EXPORT_NAME), "utf8");
		assert.match(staleReplacement, /"state": "incomplete"/);
		assert.doesNotMatch(staleReplacement, /Check the observed evidence first/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private machine feedback retains actionable failed-case diagnostics and explicit measurement semantics", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "machine-feedback-archive-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workDir = path.join(root, "work"), destination = path.join(root, "out");
	await mkdir(workDir);
	const feedback = { version: 1, kind: "execution-result-feedback", status: "failed",
		measurementMetric: "isolated-worker-roundtrip", observedEnvironment: { availableParallelism: 2 },
		timingInterpretation: "Includes IPC and kernel work; finite observations only",
		diagnostics: [{ phase: "compile", message: "Synthetic missing declaration at line 3" },
			{ phase: "timing", caseId: "case-a", selector: "strategy:2", reason: "time-boundary" }] };
	await writeFile(path.join(workDir, "verification.json"), JSON.stringify({ version: 1, status: "failed", hostFeedback: feedback,
		registeredExperiment: { status: "failed", reason: "Synthetic case did not complete", timings: [], plan: { cases: [] } } }));
	const task = { taskId: "T001", workDir, status: "failed" } as M07TaskRecord;
	const goal = { runId: "synthetic-feedback", lifecycle: "finished", outcome: "partial", tasks: [task] } as CurrentGoal;
	await archivePrivateM07Task({ goal, task, destination });
	const saved = JSON.parse(await readFile(path.join(destination, "verification.json"), "utf8"));
	assert.deepEqual(saved.hostFeedback, feedback);
	assert.equal(saved.registeredExperiment.reason, "Synthetic case did not complete");
	assert.equal(saved.status, "failed");
});

test("private archive retains a controller-certified partial-settled budget stop distinctly from an unknown operation", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "partial-settled-archive-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const taskDir = path.join(root, "T001"), workDir = path.join(taskDir, "work"), destination = path.join(root, "out");
	await mkdir(workDir, { recursive: true });
	const evidencePath = path.join(taskDir, "local-admission-stop-receipt.json");
	await writeFile(evidencePath, JSON.stringify({ version: 1, kind: "m07-partial-settled-local-admission-stop",
		goalRunId: "synthetic-goal", taskId: "T001", operationId: "O001",
		settledProviderRequestCount: 1, rejectedBeforeTransport: true,
		stopReason: "total-cny-ceiling", effectScope: "factory-attested-confined-file-tools",
		observedAt: new Date().toISOString() }));
	const task = { taskId: "T001", mode: "execute", workDir, status: "failed" } as M07TaskRecord;
	const goal = { runId: "synthetic-goal", lifecycle: "active", tasks: [task],
		executionState: { operations: [{ id: "O001", taskId: "T001", status: "partial-settled",
			observationMethod: "host-local-admission-rejection", evidencePath }] } } as unknown as CurrentGoal;
	const archived = await archivePrivateM07Task({ goal, task, destination });
	assert.deepEqual(archived.controllerEvidence.operationOutcomes, [{ operationId: "O001", status: "partial-settled",
		localStop: { settledProviderRequestCount: 1, rejectedBeforeTransport: true,
			stopReason: "total-cny-ceiling", effectScope: "factory-attested-confined-file-tools" } }]);
	assert.deepEqual((await loadPrivateM07Archive(destination)).archive.controllerEvidence.operationOutcomes,
		archived.controllerEvidence.operationOutcomes);
});

test("private archive retains a settled but truncated terminal response without claiming task completion", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "terminal-response-archive-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const taskDir = path.join(root, "T001"), workDir = path.join(taskDir, "work"), destination = path.join(root, "out");
	await mkdir(workDir, { recursive: true });
	const evidencePath = path.join(taskDir, "terminal-response-receipt.json");
	await writeFile(evidencePath, JSON.stringify({ version: 1, kind: "m07-incomplete-settled-terminal-response",
		goalRunId: "synthetic-goal", taskId: "T001", operationId: "O001",
		settledProviderRequestCount: 1, responseReceived: true, terminalStopReason: "length",
		taskComplete: false, effectScope: "factory-attested-confined-file-tools",
		observedAt: new Date().toISOString() }));
	const task = { taskId: "T001", mode: "execute", workDir, status: "failed" } as M07TaskRecord;
	const goal = { runId: "synthetic-goal", lifecycle: "active", tasks: [task],
		executionState: { operations: [{ id: "O001", taskId: "T001", status: "terminal-response-incomplete",
			observationMethod: "host-terminal-response", evidencePath }] } } as unknown as CurrentGoal;
	const archived = await archivePrivateM07Task({ goal, task, destination });
	assert.deepEqual(archived.controllerEvidence.operationOutcomes, [{ operationId: "O001", status: "terminal-response-incomplete",
		terminalResponse: { settledProviderRequestCount: 1, responseReceived: true,
			terminalStopReason: "length", taskComplete: false,
			effectScope: "factory-attested-confined-file-tools" } }]);
	assert.deepEqual((await loadPrivateM07Archive(destination)).archive.controllerEvidence.operationOutcomes,
		archived.controllerEvidence.operationOutcomes);
});
