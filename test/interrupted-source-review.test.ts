import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isVerifiedInterruptedSourceCapability,
	readReviewedInterruptedSourceCapability, type InterruptedSourceReviewReceiptV2,
	type InterruptedSourceReviewRole } from "../src/runner/interrupted-source-review.ts";
import type { TerminalInterruptionEvidenceV1 } from "../src/runner/mission-supervisor.ts";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const priorCommit = "c".repeat(40);
const checkpoint = "d".repeat(64);
const interruption: TerminalInterruptionEvidenceV1 = {
	version: 1, kind: "host-verified-terminal-interruption",
	source: { runId: "210", runAttempt: 1, commit },
	priorCarrySource: { runId: "209", runAttempt: 1, commit: priorCommit },
	priorCarryEnvelopeSha256: "e".repeat(64), resultArtifactId: "710",
	resultArchiveSha256: "f".repeat(64), accounting: "unquantified",
	effects: "unknown-unreconciled", terminationOrigin: "unknown"
};
const roles: InterruptedSourceReviewRole[] = [
	"m07-builder-confined-writes", "objective-assessor-read-only",
	"m04-reviewer-read-only", "m07-reviewer-read-only",
	"fresh-workspace-store", "host-execution-confinement", "encrypted-output-provider"
];
const codeRefs: InterruptedSourceReviewReceiptV2["review"]["codeEvidenceRefs"] = [
	{ role: roles[0]!, path: "src/runner/confined-campaign-files.ts", symbol: "createConfinedCampaignFileTools" },
	{ role: roles[0]!, path: "scripts/manual-private-campaign.ts", symbol: "createConfinedCampaignFileTools" },
	{ role: roles[1]!, path: "src/m07/objective-progress.ts", symbol: "objective_evidence_read" },
	{ role: roles[2]!, path: "src/stages/m04.ts", symbol: "m07_evidence_read" },
	{ role: roles[3]!, path: "src/m07/controller.ts", symbol: "reviewerSpec" },
	{ role: roles[4]!, path: "scripts/manual-private-campaign.ts", symbol: "createFileKnowledgeStore" },
	{ role: roles[5]!, path: "scripts/manual-private-campaign.ts", symbol: "sandboxArguments" },
	{ role: roles[5]!, path: "scripts/manual-private-campaign.ts", symbol: "checkCandidate" },
	{ role: roles[6]!, path: "scripts/manual-private-campaign.ts", symbol: "DeepSeekCampaignBudget" },
	{ role: roles[6]!, path: "scripts/private_actions_transport.py", symbol: "encrypt_results" },
	{ role: roles[6]!, path: ".github/workflows/manual-private-campaign.yml", symbol: "Upload ciphertext only" }
];
const testRefs: InterruptedSourceReviewReceiptV2["review"]["testEvidenceRefs"] = [
	{ role: roles[0]!, path: "test/confined-campaign-evidence-read.test.ts", name: "confined local tools" },
	{ role: roles[1]!, path: "test/m07-objective-progress.test.ts", name: "objective evidence" },
	{ role: roles[2]!, path: "test/m04-checkpoint.test.ts", name: "frozen feedback" },
	{ role: roles[3]!, path: "test/m07-execution-loop.test.ts", name: "fresh reviewer" },
	{ role: roles[4]!, path: "test/manual-private-campaign.test.ts", name: "fresh state" },
	{ role: roles[5]!, path: "test/manual-private-campaign.test.ts",
		name: "measurement mounts evaluator and immutable reference workers read-only while preserving separate temporary scratch" },
	{ role: roles[6]!, path: "test/private_actions_transport_test.py", name: "test_encrypt_results" },
	{ role: roles[6]!, path: "test/private-campaign-workflow-manifest.test.ts", name: "ciphertext upload" }
];
const files = new Map<string, Uint8Array>();
for (const ref of codeRefs) files.set(ref.path,
	new TextEncoder().encode([...(files.get(ref.path) ? [new TextDecoder().decode(files.get(ref.path))] : []),
		ref.symbol].join("\n")));
for (const ref of testRefs) files.set(ref.path,
	new TextEncoder().encode([...(files.get(ref.path) ? [new TextDecoder().decode(files.get(ref.path))] : []),
		ref.name].join("\n")));
const receipt: InterruptedSourceReviewReceiptV2 = {
	version: 2, kind: "host-reviewed-interrupted-source-capability",
	prior: { source: interruption.source, sourceTree: tree,
		priorCarrySource: interruption.priorCarrySource,
		priorCarryEnvelopeSha256: interruption.priorCarryEnvelopeSha256,
		priorCheckpointSha256: checkpoint, resultArtifactId: interruption.resultArtifactId,
		resultArchiveSha256: interruption.resultArchiveSha256 },
	review: { kind: "operator-code-review", conclusion: "approved-for-fresh-only-execution",
		codeEvidenceRefs: codeRefs, testEvidenceRefs: testRefs },
	grant: { mode: "fresh-only-confined-effects", oldResultUse: "untrusted-no-replay-no-adoption",
		m07BuilderToolGrant: "factory-confined-task-file-writes",
		objectiveAssessorToolGrant: "read-only", m04ReviewerToolGrant: "read-only",
		m07ReviewerToolGrant: "read-only",
		state: "fresh-workspace-empty-store-no-resume", outputTransport: "encrypted-fixed",
		providerInference: "fixed-configured-provider" }
};

async function fixture(run: (file: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "interrupted-review-"));
	const file = path.join(dir, "review.json");
	try {
		await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
		await run(file);
	} finally { await rm(dir, { recursive: true, force: true }); }
}
const readFileAtCommit = async (sha: string, file: string): Promise<Uint8Array> => {
	assert.equal(sha, commit);
	const bytes = files.get(file);
	if (!bytes) throw new Error("absent immutable file");
	return bytes;
};
const input = (privateReceiptFile: string) => ({ privateReceiptFile, interruption,
	interruptedSourceTree: tree, priorCheckpointSha256: checkpoint,
	readImmutableSourceFile: readFileAtCommit });

test("mints an in-process brand from a private source-bound operator receipt", async () => {
	await fixture(async file => {
		const value = await readReviewedInterruptedSourceCapability(input(file));
		assert.equal(value.source.commit, commit);
		assert.equal(value.sourceTree, tree);
		assert.match(value.receiptSha256, /^[0-9a-f]{64}$/);
		assert.equal(value.grant.oldResultUse, "untrusted-no-replay-no-adoption");
		assert.ok(isVerifiedInterruptedSourceCapability(value));
		assert.equal(isVerifiedInterruptedSourceCapability(structuredClone(value)), false);
		assert.equal(isVerifiedInterruptedSourceCapability({ ...value }), false);
	});
});

test("refuses unrelated and mutated source, artifact, or prior AEAD identities", async () => {
	await fixture(async file => {
		const base = input(file);
		await assert.rejects(readReviewedInterruptedSourceCapability({ ...base,
			interruptedSourceTree: "1".repeat(40) }), /unrelated-receipt/);
		await assert.rejects(readReviewedInterruptedSourceCapability({ ...base,
			interruption: { ...interruption, resultArchiveSha256: "1".repeat(64) } }), /unrelated-receipt/);
		await assert.rejects(readReviewedInterruptedSourceCapability({ ...base,
			priorCheckpointSha256: "1".repeat(64) }), /unrelated-receipt/);
		await assert.rejects(readReviewedInterruptedSourceCapability({ ...base,
			interruption: { ...interruption, source: { ...interruption.source, commit: "1".repeat(40) } } }),
			/unrelated-receipt/);
		await assert.rejects(readReviewedInterruptedSourceCapability({ ...base,
			interruption: { ...interruption, priorCarrySource: { ...interruption.priorCarrySource,
				commit: "1".repeat(40) } } }), /unrelated-receipt/);
	});
});

test("refuses absent immutable evidence and weaker grants", async () => {
	await fixture(async file => {
		await assert.rejects(readReviewedInterruptedSourceCapability({ ...input(file),
			readImmutableSourceFile: async () => new TextEncoder().encode("unrelated") }), /evidence-unavailable/);
		await writeFile(file, JSON.stringify({ ...receipt, grant: {
			...receipt.grant, m07BuilderToolGrant: "unrestricted-write" } }), { mode: 0o600 });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await writeFile(file, JSON.stringify({ ...receipt, grant: {
			...receipt.grant, objectiveAssessorToolGrant: "writable" } }), { mode: 0o600 });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await writeFile(file, JSON.stringify({ ...receipt, version: 1,
			review: { ...receipt.review,
				codeEvidenceRefs: [
					{ ...codeRefs[0], role: "m07-local-tool-confinement" },
					{ ...codeRefs[2], role: "read-only-model-sessions" },
					...codeRefs.filter(ref => ["fresh-workspace-store",
						"host-execution-confinement", "encrypted-output-provider"].includes(ref.role)) ],
				testEvidenceRefs: [
					{ ...testRefs[0], role: "m07-local-tool-confinement" },
					{ ...testRefs[1], role: "read-only-model-sessions" },
					...testRefs.filter(ref => ["fresh-workspace-store",
						"host-execution-confinement", "encrypted-output-provider"].includes(ref.role)) ] },
			grant: { mode: "fresh-only-confined-effects",
				oldResultUse: "untrusted-no-replay-no-adoption",
				m07Tools: "factory-confined-local", modelSessions: "read-only",
				state: "fresh-workspace-empty-store-no-resume",
				outputTransport: "encrypted-fixed",
				providerInference: "fixed-configured-provider" } }), { mode: 0o600 });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await writeFile(file, JSON.stringify({ ...receipt, grant: {
			...receipt.grant, oldResultUse: "trusted-replay" } }), { mode: 0o600 });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
	});
});

test("requires a private mode-0600 file outside the checkout", async () => {
	await fixture(async file => {
		await chmod(file, 0o644);
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
	});
});

test("accepts script, transport, workflow, and Python test refs while rejecting missing roles and traversal", async () => {
	await fixture(async file => {
		const save = async (value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
		for (const role of ["m07-builder-confined-writes", "objective-assessor-read-only",
			"m04-reviewer-read-only", "m07-reviewer-read-only"] as const) {
			await save({ ...receipt, review: { ...receipt.review,
				codeEvidenceRefs: codeRefs.filter(ref => ref.role !== role) } });
			await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
			await save({ ...receipt, review: { ...receipt.review,
				testEvidenceRefs: testRefs.filter(ref => ref.role !== role) } });
			await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		}
		await save({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: codeRefs.filter(ref => ref.role !== "encrypted-output-provider") } });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: codeRefs.filter(ref => ref.role !== "host-execution-confinement") } });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			testEvidenceRefs: testRefs.filter(ref => ref.role !== "fresh-workspace-store") } });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			testEvidenceRefs: testRefs.filter(ref => ref.role !== "host-execution-confinement") } });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: codeRefs.map(ref => ref.path === ".github/workflows/manual-private-campaign.yml" ?
				{ ...ref, path: ".github/workflows/../manual-private-campaign.yml" } : ref) } });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			testEvidenceRefs: testRefs.map(ref => ref.path === "test/private_actions_transport_test.py" ?
				{ ...ref, path: "test/../private_actions_transport_test.py" } : ref) } });
		await assert.rejects(readReviewedInterruptedSourceCapability(input(file)), /invalid-receipt/);
	});
});
