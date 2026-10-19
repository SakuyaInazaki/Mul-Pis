import assert from "node:assert/strict";
import test from "node:test";
import { checkApiSymbols, checkCandidate, checkHardConstraints, collectApiContracts } from "../../src/knowledge/static-checks.ts";
import { validateOptimizationCard, type OptimizationCard } from "../../src/knowledge/optimization-card.ts";

function card(raw: Record<string, unknown>): OptimizationCard {
	const result = validateOptimizationCard(raw);
	assert.equal(result.issues.length, 0, result.issues.join("; "));
	return result.card!;
}

const base = { version: 1, operatorCategory: "normalization", canonicalFamily: "layernorm", bottleneck: "compile_failure",
	applicability: { backend: "backend-a", toolchain: "toolchain-1.2" }, provenance: { kind: "external-source", detail: "S007 头文件" } };

const signatureCard = (api: string, signature: string) => card({ ...base, kind: "contract", api, signature, constraints: [], source: "S007" });
const budgetCard = card({ ...base, kind: "contract", constraints: [
	{ name: "buffer_bytes", unit: "bytes", limit: 196352, comparison: "at_most", source: "S007" },
	{ name: "tile_elements", unit: "elements", limit: 16, comparison: "multiple_of", source: "S007" }], source: "S007" });

test("an unknown symbol inside a covered namespace is rejected with the closest legal signature", () => {
	const contracts = collectApiContracts([{ card: signatureCard("BackendA::Add", "void Add(Tensor&, const Tensor&, int32_t)") },
		{ card: signatureCard("BackendA::Sub", "void Sub(Tensor&, const Tensor&, int32_t)") }]);
	const report = checkApiSymbols("BackendA::Add(dst, src, n);\nBackendA::Scale(dst, src);\nstd::memcpy(a, b, n);", contracts);
	assert.equal(report.status, "reject");
	assert.equal(report.findings.length, 1);
	assert.equal(report.findings[0].witness, "BackendA::Scale");
	assert.match(report.findings[0].suggestion ?? "", /void (Add|Sub)\(/);
	// std:: has no contract card, so it is reported as uncovered rather than judged.
	assert.deepEqual(report.uncoveredSymbols, ["std::memcpy"]);
	assert.equal(checkApiSymbols("BackendA::Add(a, b, c);", contracts).status, "pass");
	assert.equal(checkApiSymbols("anything();", []).status, "inconclusive");
});

test("numeric budgets are compared with their cited limits and unchecked ones stay unchecked", () => {
	const constraints = budgetCard.kind === "contract" ? budgetCard.constraints : [];
	const violated = checkHardConstraints([{ name: "buffer_bytes", value: 262144 }, { name: "tile_elements", value: 24 }], constraints);
	assert.equal(violated.status, "reject");
	assert.equal(violated.findings.length, 2);
	assert.match(violated.findings[0].witness, /buffer_bytes=262144bytes/);
	const ok = checkHardConstraints([{ name: "buffer_bytes", value: 131072 }, { name: "tile_elements", value: 32 }], constraints);
	assert.equal(ok.status, "pass");
	const partial = checkHardConstraints([{ name: "buffer_bytes", value: 131072 }], constraints);
	assert.equal(partial.status, "inconclusive");
	assert.equal(partial.findings[0].code, "constraint-unchecked");
});

test("a combined candidate report never reports an unchecked constraint as a pass", () => {
	const cards = [{ card: signatureCard("BackendA::Add", "void Add(Tensor&, const Tensor&, int32_t)") }, { card: budgetCard }];
	const unchecked = checkCandidate({ source: "BackendA::Add(a, b, c);" }, cards);
	assert.equal(unchecked.status, "inconclusive");
	const passing = checkCandidate({ source: "BackendA::Add(a, b, c);",
		observations: [{ name: "buffer_bytes", value: 1024 }, { name: "tile_elements", value: 16 }] }, cards);
	assert.equal(passing.status, "pass");
	const rejected = checkCandidate({ source: "BackendA::Scale(a, b);",
		observations: [{ name: "buffer_bytes", value: 1024 }, { name: "tile_elements", value: 16 }] }, cards);
	assert.equal(rejected.status, "reject");
});
