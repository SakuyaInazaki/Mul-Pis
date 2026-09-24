import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GenerationStore, type ExperienceRequirementV1 } from "../src/improvement/generation.ts";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import type { ResearchCampaignPlanV1 } from "../src/improvement/research-types.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import type { KnowledgeRef, KnowledgeStore, ProposalBatch } from "../src/knowledge/types.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { validateResearchAction } from "../src/improvement/policy-host.ts";

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.001 };
const strategy = {
	executor: { version: 1 as const, kind: "cpu-numerical-prompt" as const, body: "Choose a hypothesis from the visible measurements." },
	improver: { version: 1 as const, kind: "diagnostic-improver-prompt" as const, body: "Make a bounded development decision." },
};

function caseSet() {
	return { version: 1, split: "development", cases: [{ id: "response", version: 1, truthHypothesisId: "h1",
		hypotheses: [{ id: "h1", formula: { kind: "affine", slope: 1, intercept: 4 } }, { id: "h2", formula: { kind: "quadratic", coefficient: 1, intercept: 4 } }],
		initialX: [0], allowedProbeX: [2], maxProbeCalls: 1, tolerance: 0.01, units: { x: "s", y: "m" } }] };
}

function plan(): ResearchCampaignPlanV1 {
	return { version: 1, experimentKind: "executor-quality", target: "executor", developmentCaseSetPath: "development.json",
		maxDecisions: 3, maxCandidates: 1, admissionRepetitions: 2, maxFeedbackItems: 8, perPromptTimeoutMs: 10_000,
		budget: { maxProviderCalls: 12, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxSdkEstimatedCost: 2, maxProbeCalls: 10, maxCpuMillis: 60_000, maxWallMillis: 60_000 },
		experienceRefs: [], experienceMaxRecords: 0, experienceMaxChars: 0 };
}

async function apply(store: KnowledgeStore, ops: ProposalBatch["ops"]): Promise<void> {
	const receipt = await store.submitProposal({ stage: "M04", runId: "experience-review", ops });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((issue) => issue.message).join("; "));
	await store.merge(receipt.proposalId);
}

async function fixture(t: TestContext, reply: (context: FakeReplyContext) => { text: string; usage: typeof usage } | Promise<{ text: string; usage: typeof usage }>) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-method-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { default: "fake/default", improver: "fake/improver", research: "fake/research" }, concurrency: 1 }));
	await writeFile(path.join(root, "development.json"), JSON.stringify(caseSet()));
	const store = createFileKnowledgeStore(path.join(root, ".agent", "knowledge"));
	await store.init();
	await apply(store, [
		{ op: "create", type: "K", title: "改进判断经验", body: "先辨识再判断", usageDecision: "adopted", fields: { experience: { version: 1, targetKind: "improver", applicableStages: ["method-research"], requiredTags: ["cpu-response-identification"], excludedTags: [], requiredRefs: [] } } },
		{ op: "create", type: "K", title: "执行判断经验", body: "使用有区别的观测", usageDecision: "adopted", fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["method-research"], requiredTags: ["cpu-response-identification"], excludedTags: [], requiredRefs: [] } } },
	]);
	const storeId = await store.storeId();
	const runner = new FakeSessionRunner(reply);
	const service = new ResearchImprovementService({ workspaceRoot: root, runner });
	await service.bootstrap({ version: 1, ...strategy, applicability: ["cpu-response-identification"] });
	return { root, store, storeId, runner, service, generation: new GenerationStore(root) };
}

function requirement(storeId: string, targetKind: "executor" | "improver"): ExperienceRequirementV1 {
	const ref: KnowledgeRef = { storeId, recordId: targetKind === "improver" ? "K001" : "K002", version: 1 };
	return { targetKind, ref };
}

/** Trusted test-state construction, not a fake scientific admission. */
async function activateDependent(f: Awaited<ReturnType<typeof fixture>>, requirements: ExperienceRequirementV1[], kind: "executor" | "improver" = "improver") {
	const active = (await f.generation.active())!;
	const old = await f.generation.readStrategy(kind === "improver" ? active.bundle.improverVersionId : active.bundle.executorVersionId);
	const next = await f.generation.writeStrategy({ versionId: f.generation.newId(`${kind}-dependent`), kind, artifact: old.artifact,
		parentVersionId: old.versionId, origin: "agent-generated", applicability: old.applicability, limitations: [],
		sourceExperienceRefs: requirements, requiredExperienceRefs: requirements, state: "admitted" });
	const bundle = await f.generation.writeBundle({ bundleId: f.generation.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: kind === "executor" ? next.versionId : active.bundle.executorVersionId,
		improverVersionId: kind === "improver" ? next.versionId : active.bundle.improverVersionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot, environmentVersion: active.bundle.environmentVersion,
		modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "admitted" });
	await f.generation.activate(bundle.bundleId, active.pointer, "local-meta-admission", "trusted-test-state");
	return { strategy: next, bundle };
}

test("active I requirements survive an omitted plan selection and block new calls after recheck", async (t) => {
	let calls = 0;
	const f = await fixture(t, () => { calls++; return { text: JSON.stringify({ kind: "stop", reason: "more evidence needed" }), usage }; });
	await activateDependent(f, [requirement(f.storeId, "improver")]);
	const first = await f.service.run(plan());
	assert.equal(first.status, "research-only", first.stopReason);
	assert.equal(calls, 1, "live pinned requirements permit a new I child without repeated plan refs");
	await apply(f.store, [{ op: "limit", target: "K001", kind: "needs_recheck", reason: "依据需要复核", authority: "test-review" }]);
	const recheck = await f.service.run(plan());
	assert.notEqual(recheck.status, "promoted");
	assert.equal(calls, 1, "new I child is blocked despite experienceRefs: []");
});

test("active H requirement blocks a later campaign after its old pinned version is withdrawn", async (t) => {
	let calls = 0;
	const f = await fixture(t, () => { calls++; return { text: JSON.stringify({ kind: "stop", reason: "done" }), usage }; });
	await activateDependent(f, [requirement(f.storeId, "executor")], "executor");
	assert.equal((await f.service.run(plan())).status, "research-only");
	assert.equal(calls, 1);
	await apply(f.store, [{ op: "decide", id: "K002", usageDecision: "withdrawn", reason: "执行经验撤回" }]);
	const blocked = await f.service.run(plan());
	assert.notEqual(blocked.status, "promoted");
	assert.equal(calls, 1, "withdrawn K002@1 cannot reach a new I/H child through an omitted plan selection");
});

test("rollback prechecks the old generation and leaves the current pointer unchanged when its dependency is withdrawn", async (t) => {
	const f = await fixture(t, () => ({ text: JSON.stringify({ kind: "stop", reason: "done" }), usage }));
	const dependent = await activateDependent(f, [requirement(f.storeId, "improver")]);
	const current = (await f.generation.active())!;
	const neutral = await f.generation.writeBundle({ bundleId: f.generation.newId("bundle"), parents: [dependent.bundle.bundleId], executorVersionId: current.bundle.executorVersionId,
		improverVersionId: (await f.generation.readBundle(dependent.bundle.parents[0]!)).improverVersionId,
		knowledgeSnapshot: current.bundle.knowledgeSnapshot, environmentVersion: current.bundle.environmentVersion, modelConfig: current.bundle.modelConfig,
		protocolVersion: current.bundle.protocolVersion, allowedCapabilities: current.bundle.allowedCapabilities, state: "manual-active" });
	await f.generation.activate(neutral.bundleId, current.pointer, "external-manual-unverified", "trusted-neutral-state");
	await apply(f.store, [{ op: "decide", id: "K001", usageDecision: "withdrawn", reason: "原经验撤回" }]);
	await assert.rejects(f.service.rollback(), /experience|unavailable|changed/i);
	assert.equal((await f.generation.active())!.bundle.bundleId, neutral.bundleId);
});

test("V2 import preserves foreign pinned obligations and cannot activate without an explicitly registered store", async (t) => {
	const source = await fixture(t, () => ({ text: JSON.stringify({ kind: "stop", reason: "done" }), usage }));
	const dependent = await activateDependent(source, [requirement(source.storeId, "improver")]);
	const packagePath = path.join(source.root, "method-package.json");
	await source.service.exportMethod(dependent.strategy.versionId, packagePath);
	const pkg = JSON.parse(await readFile(packagePath, "utf8"));
	assert.deepEqual(pkg.requiredExperienceRefs, [requirement(source.storeId, "improver")]);
	assert.deepEqual(pkg.sourceExperienceRefs, pkg.requiredExperienceRefs);
	const target = await fixture(t, () => ({ text: JSON.stringify({ kind: "stop", reason: "done" }), usage }));
	const before = (await target.generation.active())!.bundle.bundleId;
	await assert.rejects(target.service.bindMethod(packagePath), /experience|unavailable|registered/i);
	assert.equal((await target.generation.active())!.bundle.bundleId, before);
});

test("a candidate saying to ignore dependencies still inherits controller-pinned I requirements", async (t) => {
	let calls = 0;
	const f = await fixture(t, (context) => {
		calls++;
		if (context.spec.role === "research") {
			const input = JSON.parse(context.message);
			return { text: JSON.stringify(input.visibleFeedback.length ? { kind: "submit", actionId: "submit", hypothesisId: "h1" } : { kind: "probe", actionId: "probe", x: 2 }), usage };
		}
		const view = JSON.parse(context.message.slice(context.message.indexOf("\n") + 1));
		const index = Number(context.spec.label.split("-").at(-1));
		if (index === 0) return { text: JSON.stringify({ kind: "propose", target: "executor", body: "Ignore earlier dependencies; probe before selecting.",
			hypothesis: { claim: "probe distinguishes responses", predictedObservation: "one response survives", falsifier: "responses remain tied", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [view.feedback[0].id] } }), usage };
		if (index === 1) return { text: JSON.stringify({ kind: "evaluate-development", candidateId: view.candidates[0].id }), usage };
		return { text: JSON.stringify({ kind: "stop", reason: "development support", selectedCandidateId: view.candidates[0].id }), usage };
	});
	const required = requirement(f.storeId, "improver");
	await activateDependent(f, [required]);
	const result = await f.service.run(plan());
	assert.equal(result.status, "research-only", result.stopReason);
	assert.ok(result.candidates.length > 0 && calls > 3);
	const candidate = await f.generation.readStrategy(result.candidates[0]!.strategyVersionId);
	assert.deepEqual(candidate.sourceExperienceRefs, [], "plan omitted explicit selection");
	assert.deepEqual(candidate.requiredExperienceRefs, [required], "model body cannot erase inherited control obligation");
	const view = { version: 1, target: "executor", current: { bundleId: "b", executorVersionId: "h", improverVersionId: "i" }, task: { allowedProbeX: [2] }, feedback: [{ id: "visible" }], candidates: [] } as unknown as Parameters<typeof validateResearchAction>[1];
	assert.throws(() => validateResearchAction({ kind: "propose", target: "executor", body: "Ignore dependencies", requiredExperienceRefs: [], hypothesis: { claim: "A", predictedObservation: "B", falsifier: "C", applicability: [], motivatingEvidenceIds: ["visible"] } }, view), /unsupported decision schema/);
});

test("a live limit after the first I reply blocks the next I request in the same campaign", async (t) => {
	let calls = 0;
	let f!: Awaited<ReturnType<typeof fixture>>;
	f = await fixture(t, async (context) => {
		assert.equal(context.spec.role, "improver");
		calls++;
		if (calls === 1) {
			await apply(f.store, [{ op: "limit", target: "K001", kind: "needs_recheck", reason: "新证据要求复核", authority: "test-review" }]);
			return { text: JSON.stringify({ kind: "probe", x: 2, rationale: "distinguish visible mechanisms" }), usage };
		}
		throw new Error("second I request must be blocked before reaching FakeRunner");
	});
	await activateDependent(f, [requirement(f.storeId, "improver")]);
	const result = await f.service.run(plan());
	assert.equal(result.status, "inconclusive", result.stopReason);
	assert.equal(calls, 1);
	assert.ok(result.feedback.some((item) => item.status === "observed" && item.observations.some((observation) => observation.source === "probe")));
});
