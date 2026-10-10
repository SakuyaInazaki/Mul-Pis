import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isVerifiedUnobservedControlSourceCapability,
	readReviewedUnobservedControlSourceCapability,
	type ReviewUnobservedControlSourceInput,
	type UnobservedControlSourceReviewReceiptV1,
	type UnobservedControlSourceReviewRole } from "../src/runner/unobserved-control-source-review.ts";

const oldJournalKey = "a".repeat(64);
const oldAcceptedControl = { commit: "b".repeat(40), tree: "c".repeat(40),
	parents: ["d".repeat(40), "e".repeat(40)] };
const oldTestedSource = { commit: oldAcceptedControl.parents[0]!, tree: oldAcceptedControl.tree };
const priorCarrySource = { runId: "213", runAttempt: 1, commit: "f".repeat(40) };
const priorCarryEnvelopeSha256 = "1".repeat(64);
const roles: readonly UnobservedControlSourceReviewRole[] = [
	"host-native-execution-confinement", "m07-local-tool-grant",
	"fresh-workspace-store", "session-constraints",
	"encrypted-output-provider-transport"
];
const encoder = new TextEncoder();
const files = new Map<string, Uint8Array>();
const codeEvidenceRefs = roles.map((role, index) => {
	const file = `src/runner/role-${index}.ts`;
	const symbol = `function reviewedRole${index}() { return true; }`;
	const bytes = encoder.encode(symbol);
	files.set(file, bytes);
	return { role, path: file, symbol };
});
const testEvidenceRefs = roles.map((role, index) => {
	const file = `test/role-${index}.test.ts`;
	const name = `test("reviewed role ${index}", () => {})`;
	const bytes = encoder.encode(name);
	files.set(file, bytes);
	return { role, path: file, name };
});
const receipt: UnobservedControlSourceReviewReceiptV1 = {
	version: 1, kind: "host-reviewed-unobserved-control-source-capability",
	prior: { oldJournalKey, oldAcceptedControl, oldTestedSource,
		priorCarrySource, priorCarryEnvelopeSha256 },
	review: { kind: "operator-code-review", conclusion: "approved-for-fresh-only-execution",
		codeEvidenceRefs, testEvidenceRefs },
	grant: { mode: "fresh-only-confined-effects", oldExecution: "unknown-may-run-later",
		oldAccounting: "unquantified", oldScience: "untrusted-no-adoption",
		m07Tools: "factory-confined-local", researchAndReviewerSessions: "read-only",
		state: "fresh-workspace-empty-store-no-resume", outputTransport: "encrypted-fixed",
		providerInference: "fixed-configured-provider" }
};

const input = (privateReceiptFile: string): ReviewUnobservedControlSourceInput => ({
	privateReceiptFile, oldJournalKey, oldAcceptedControl, oldTestedSource,
	priorCarrySource, priorCarryEnvelopeSha256,
	readImmutableSourceTree: async commit => {
		assert.equal(commit, oldTestedSource.commit);
		return oldTestedSource.tree;
	},
	readImmutableSourceFile: async (commit, file) => {
		assert.equal(commit, oldTestedSource.commit);
		const bytes = files.get(file);
		if (!bytes) throw new Error("missing immutable file");
		return bytes;
	}
});
async function fixture(run: (file: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "unobserved-review-"));
	const file = path.join(dir, "review.json");
	try {
		await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
		await run(file);
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("private source-bound receipt mints only a process-local capability", async () => {
	await fixture(async file => {
		const capability = await readReviewedUnobservedControlSourceCapability(input(file));
		assert.equal(capability.oldJournalKey, oldJournalKey);
		assert.equal(capability.oldAcceptedControl.commit, oldAcceptedControl.commit);
		assert.equal(capability.oldTestedSource.tree, oldTestedSource.tree);
		assert.match(capability.receiptSha256, /^[0-9a-f]{64}$/);
		assert.ok(isVerifiedUnobservedControlSourceCapability(capability));
		assert.equal(isVerifiedUnobservedControlSourceCapability(structuredClone(capability)), false);
		assert.equal(isVerifiedUnobservedControlSourceCapability({ ...capability }), false);
	});
});

test("accepts more than 64 valid citations within the private receipt byte bound", async () => {
	await fixture(async file => {
		const extraRefs = Array.from({ length: 60 }, (_, index) => {
			const refPath = `src/runner/extra-role-${index}.ts`;
			const symbol = `function extraReviewedRole${index}() { return true; }`;
			const bytes = encoder.encode(symbol);
			files.set(refPath, bytes);
			return { role: roles[index % roles.length]!, path: refPath, symbol };
		});
		const manyRefs = [...codeEvidenceRefs, ...extraRefs];
		assert.equal(manyRefs.length, 65);
		await writeFile(file, JSON.stringify({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: manyRefs } }), { mode: 0o600 });
		assert.ok(isVerifiedUnobservedControlSourceCapability(
			await readReviewedUnobservedControlSourceCapability(input(file))));
	});
});

test("refuses tampered journal, control, source and authenticated prior carry bindings", async () => {
	await fixture(async file => {
		const base = input(file);
		for (const mutation of [
			{ oldJournalKey: "2".repeat(64) },
			{ oldAcceptedControl: { ...oldAcceptedControl, commit: "2".repeat(40) } },
			{ oldAcceptedControl: { ...oldAcceptedControl, parents: [oldTestedSource.commit] } },
			{ oldTestedSource: { ...oldTestedSource, tree: "2".repeat(40) } },
			{ oldTestedSource: { ...oldTestedSource, commit: "2".repeat(40) } },
			{ priorCarrySource: { ...priorCarrySource, runId: "214" } },
			{ priorCarryEnvelopeSha256: "2".repeat(64) }
		]) {
			await assert.rejects(readReviewedUnobservedControlSourceCapability({ ...base, ...mutation }),
				/unrelated-receipt/);
		}
	});
});

test("requires the live old tested tree and cited code and test markers", async () => {
	await fixture(async file => {
		const base = input(file);
		await assert.rejects(readReviewedUnobservedControlSourceCapability({ ...base,
			readImmutableSourceTree: async () => "2".repeat(40) }), /evidence-unavailable/);
		await assert.rejects(readReviewedUnobservedControlSourceCapability({ ...base,
			readImmutableSourceFile: async (commit, ref) => ref === codeEvidenceRefs[0]!.path ?
				encoder.encode("unrelated code") : base.readImmutableSourceFile(commit, ref)
		}), /evidence-unavailable/);
		await assert.rejects(readReviewedUnobservedControlSourceCapability({ ...base,
			readImmutableSourceFile: async (commit, ref) => ref === testEvidenceRefs[0]!.path ?
				encoder.encode("unrelated") : base.readImmutableSourceFile(commit, ref)
		}), /evidence-unavailable/);
	});
});

test("rejects missing semantic roles, weaker grants and path traversal", async () => {
	await fixture(async file => {
		const save = async (value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
		await save({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: codeEvidenceRefs.slice(1) } });
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			testEvidenceRefs: testEvidenceRefs.slice(0, -1) } });
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, grant: { ...receipt.grant, oldExecution: "absent" } });
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, grant: { ...receipt.grant,
			researchAndReviewerSessions: undefined, modelSessions: "read-only" } });
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: [{ ...codeEvidenceRefs[0]!, sha256: "2".repeat(64) },
				...codeEvidenceRefs.slice(1)] } });
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
		await save({ ...receipt, review: { ...receipt.review,
			codeEvidenceRefs: [{ ...codeEvidenceRefs[0]!, path: "src/../role.ts" },
				...codeEvidenceRefs.slice(1)] } });
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
	});
});

test("requires an outside-checkout private mode-0600 receipt", async () => {
	await fixture(async file => {
		await chmod(file, 0o644);
		await assert.rejects(readReviewedUnobservedControlSourceCapability(input(file)), /invalid-receipt/);
	});
});
