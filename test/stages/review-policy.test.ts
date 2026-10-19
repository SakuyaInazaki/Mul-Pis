import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { certifyRun, evaluateTolerances, matchesSelector, parseAntiCheatPolicy, parseCertificationSpec,
	parseObservations, parseToleranceDeclarations, runHostCommands, scanAntiCheat,
	MAX_RELAXATION_FACTOR } from "../../src/stages/review-policy.ts";

const blocked = { id: "fallback", pattern: "fall\\s*back to the reference implementation", appliesTo: ["**/*.py"], reason: "交付物不得在运行时回落参考实现" };
const required = { id: "raises", pattern: "raise\\s+RuntimeError", appliesTo: ["**/*.py"], reason: "失败路径必须抛错而不是静默降级" };

async function tree(t: TestContext, files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-review-policy-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(files)) {
		await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
		await writeFile(path.join(root, relative), content);
	}
	return root;
}

test("a declared policy decides rejection, and an undeclared one is not a pass", async (t) => {
	const root = await tree(t, {
		"src/kernel.py": "def run(x):\n    if broken:\n        raise RuntimeError('unsupported')\n    return compute(x)\n",
		"notes.md": "fall back to the reference implementation is fine in prose\n",
	});
	const policy = parseAntiCheatPolicy({ blocked: [blocked], required: [required] })!;
	const clean = await scanAntiCheat(root, "test", policy);
	assert.equal(clean.verdict, "pass");
	assert.deepEqual(clean.scannedFiles, [path.join("src", "kernel.py")]);
	// A prose mention outside the selector is not a finding: the policy says where it applies.
	assert.equal(clean.findings.length, 0);

	const dirty = await tree(t, { "src/kernel.py": "def run(x):\n    return fall back to the reference implementation\n" });
	const report = await scanAntiCheat(dirty, "test", policy);
	assert.equal(report.verdict, "reject");
	assert.deepEqual(report.findings.map(item => [item.patternId, item.kind, item.line]),
		[["fallback", "blocked-match", 2], ["raises", "required-missing", undefined]]);
	assert.match(report.findings[0].excerpt ?? "", /fall back/);

	const undeclared = await scanAntiCheat(root, "test", undefined);
	assert.equal(undeclared.verdict, "not-declared");
	assert.equal(undeclared.scannedFiles.length, 0);
});

test("a required pattern with no matching file at all is a rejection, and binaries are reported unscanned", async (t) => {
	const root = await tree(t, { "readme.md": "no python here\n" });
	await writeFile(path.join(root, "blob.py"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
	const policy = parseAntiCheatPolicy({ required: [required] })!;
	const report = await scanAntiCheat(root, "test", policy);
	assert.equal(report.verdict, "reject");
	assert.equal(report.findings[0].kind, "required-missing");
	assert.ok(report.unscannedFiles.some(item => item.file === "blob.py"));
	assert.ok(matchesSelector(path.join("src", "deep", "a.py"), "**/*.py"));
	assert.ok(!matchesSelector(path.join("src", "a.py"), "*.py"));
	for (const bad of [{}, { blocked: [] }, { blocked: [{ ...blocked, pattern: "(" }] }, { blocked: [{ ...blocked, reason: "" }] },
		{ blocked: [{ ...blocked, appliesTo: ["/abs"] }] }, { blocked: [blocked, blocked] }])
		assert.throws(() => parseAntiCheatPolicy(bad), /anti-cheat|antiCheat|pattern|reason|appliesTo|重复/);
});

const declaration = { id: "err", metric: "relative-error", comparison: "at_most" as const, value: 0.01,
	basis: "按本机噪声标定", declaredBy: "caller:main-agent" };

test("tolerances are the caller's, capped, disjunctive, and inconclusive when unobserved", () => {
	const parsed = parseToleranceDeclarations([declaration]);
	assert.equal(parsed[0].declaredBy, "caller:main-agent");
	assert.deepEqual(parseToleranceDeclarations(undefined), []);
	for (const bad of [[], [{ ...declaration, basis: "" }], [{ ...declaration, declaredBy: "" }],
		[{ ...declaration, comparison: "about" }], [{ ...declaration, value: "0.01" }], [declaration, declaration],
		[{ ...declaration, relaxations: [{ case: "big", value: declaration.value * (MAX_RELAXATION_FACTOR + 1), reason: "x" }] }]])
		assert.throws(() => parseToleranceDeclarations(bad), /tolerance|基准值|重复|必须/);

	const pass = evaluateTolerances([{ metric: "relative-error", value: 0.004 }], parsed, "obs.json");
	assert.equal(pass.verdict, "pass");
	assert.equal(pass.results[0].declaredBy, "caller:main-agent");
	const fail = evaluateTolerances([{ metric: "relative-error", value: 0.02 }], parsed);
	assert.equal(fail.verdict, "fail");
	// One failing case fails the evaluation even when another passes: the criterion
	// is disjunctive, never "both thresholds must be exceeded".
	const mixed = evaluateTolerances([{ metric: "relative-error", value: 0.001, case: "small" },
		{ metric: "relative-error", value: 0.5, case: "big" }], parsed);
	assert.equal(mixed.verdict, "fail");
	// A declared relaxation applies only to its own case, and only within the cap.
	const relaxed = parseToleranceDeclarations([{ ...declaration, relaxations: [{ case: "big", value: 0.1, reason: "该用例量级更大" }] }]);
	assert.equal(evaluateTolerances([{ metric: "relative-error", value: 0.05, case: "big" }], relaxed).verdict, "pass");
	assert.equal(evaluateTolerances([{ metric: "relative-error", value: 0.05, case: "small" }], relaxed).verdict, "fail");
	assert.equal(evaluateTolerances([], parsed).verdict, "inconclusive");
	assert.equal(evaluateTolerances([{ metric: "relative-error", value: 0.001 }], []).verdict, "not-declared");
	assert.deepEqual(parseObservations({ "relative-error": 0.5 }, "obs.json"), [{ metric: "relative-error", value: 0.5 }]);
	assert.throws(() => parseObservations({ "relative-error": "0.5" }, "obs.json"), /有限数值/);
});

test("the host reruns the authorised commands itself and records when it refuses an accepted delivery", async (t) => {
	const root = await tree(t, { "DELIVERY.md": "delivery\n", ".certification-material/hidden-cases.json": JSON.stringify({ cases: 3 }) });
	const spec = parseCertificationSpec({
		commands: [`node -e "const fs=require('fs');const hidden=JSON.parse(fs.readFileSync('.certification-material/hidden-cases.json','utf8'));fs.writeFileSync('cert.json', JSON.stringify({'relative-error': hidden.cases === 3 ? 0.002 : 1}))"`],
		observationsFile: "cert.json", tolerances: [declaration] })!;
	const commands = await runHostCommands(spec.commands, root);
	assert.equal(commands[0].exitCode, 0);
	const report = await certifyRun(root, spec, commands, 1, true);
	assert.equal(report.verdict, "pass");
	assert.equal(report.engineRejectedSessionAcceptance, false);
	assert.equal(report.hiddenMaterialFiles, 1);

	// Commands that exit non-zero stop the run, and a verdict that contradicts the
	// sessions' acceptance is recorded as exactly that.
	const broken = parseCertificationSpec({ commands: ["node -e \"process.exit(3)\"", "node -e \"process.exit(0)\""],
		observationsFile: "cert.json", tolerances: [declaration] })!;
	const brokenCommands = await runHostCommands(broken.commands, root);
	assert.equal(brokenCommands.length, 1);
	const brokenReport = await certifyRun(root, broken, brokenCommands, 1, true);
	assert.equal(brokenReport.verdict, "fail");
	assert.equal(brokenReport.engineRejectedSessionAcceptance, true);

	const missing = parseCertificationSpec({ commands: ["node -e \"0\""], observationsFile: "absent.json", tolerances: [declaration] })!;
	const missingReport = await certifyRun(root, missing, await runHostCommands(missing.commands, root), 1, false);
	assert.equal(missingReport.verdict, "inconclusive");
	assert.equal(missingReport.engineRejectedSessionAcceptance, false, "the sessions had not accepted it either");
	for (const bad of [{ commands: [], observationsFile: "a.json", tolerances: [declaration] },
		{ commands: ["true"], observationsFile: "/abs.json", tolerances: [declaration] },
		{ commands: ["true"], observationsFile: "a.json", tolerances: [] }])
		assert.throws(() => parseCertificationSpec(bad), /certification|tolerance/);
});
