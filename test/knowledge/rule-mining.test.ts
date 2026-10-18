import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectFailureObservations, extractErrorSignatures, failureRuleDrafts, mineFailureRules,
	normalizeErrorSignature, renderFailureRuleDrafts } from "../../src/knowledge/rule-mining.ts";

const compileLog = (file: string) => `building ${file}\n${file}:12:5: error: no member named 'Softmax' in namespace 'AscendC'\n1 error generated.\n`;

test("signatures drop file locations, addresses and long numbers but keep the symbol", () => {
	const signature = normalizeErrorSignature("kernel.cpp:12:5: error: no member named 'Softmax' in namespace 'AscendC' at 0x7ffee1a2");
	assert.equal(signature, "error: no member named 'Softmax' in namespace 'AscendC' at 0x…");
	assert.deepEqual(extractErrorSignatures(compileLog("a.cpp")), ["error: no member named 'Softmax' in namespace 'AscendC'"]);
	// A line with no failure marker is not a signature, and a very short one is dropped.
	assert.deepEqual(extractErrorSignatures("compiled successfully\nerror: x"), []);
});

test("a rule is kept for happening in several sources, not for happening often in one", () => {
	const repeated = { text: [compileLog("a.cpp"), compileLog("a.cpp"), compileLog("a.cpp")].join(""), source: "tasks/T001/compile.log" };
	assert.deepEqual(mineFailureRules([repeated]), []);
	const spread = ["T001", "T002", "T003"].map((task) => ({ text: compileLog("a.cpp"), source: `tasks/${task}/compile.log` }));
	const mined = mineFailureRules(spread);
	assert.equal(mined.length, 1);
	assert.equal(mined[0].frequency, 3);
	assert.deepEqual(mined[0].sources, ["tasks/T001/compile.log", "tasks/T002/compile.log", "tasks/T003/compile.log"]);
	assert.equal(mineFailureRules(spread, { minimumFrequency: 4 }).length, 0);
	assert.equal(mineFailureRules([...spread, ...["T004", "T005"].map((task) => ({
		text: "runtime error: tile exceeds unified buffer budget\n", source: `tasks/${task}/stderr.log` }))],
		{ minimumFrequency: 2, maxRules: 1 }).length, 1);
});

test("drafts carry an honest denominator and never claim a root cause", () => {
	const drafts = failureRuleDrafts(["T001", "T002", "T003"].map((task) => ({ text: compileLog("a.cpp"), source: `tasks/${task}/compile.log` })));
	assert.equal(drafts.scanned, 3);
	assert.equal(drafts.minimumFrequency, 3);
	const rendered = renderFailureRuleDrafts(drafts);
	assert.match(rendered, /3 次/);
	assert.match(rendered, /统计重复不等于已找到根因/);
	assert.equal(renderFailureRuleDrafts(failureRuleDrafts([])), "");
});

test("log collection treats each file as one source and skips binaries, symlinks and oversized files", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-rule-mining-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	for (const task of ["T001", "T002", "T003"]) {
		await mkdir(path.join(root, "tasks", task), { recursive: true });
		await writeFile(path.join(root, "tasks", task, "compile.log"), compileLog("kernel.cpp"));
		await writeFile(path.join(root, "tasks", task, "notes.md"), "error: this file is not a log by name");
	}
	await writeFile(path.join(root, "tasks", "T001", "binary.log"), Buffer.from([0, 1, 2, 3, 0]));
	await symlink(path.join(root, "tasks", "T001", "compile.log"), path.join(root, "tasks", "link.log"));
	const observations = await collectFailureObservations(root);
	assert.deepEqual(observations.map((item) => item.source).sort(),
		["tasks/T001/compile.log", "tasks/T002/compile.log", "tasks/T003/compile.log"]);
	const drafts = failureRuleDrafts(observations);
	assert.equal(drafts.rules.length, 1);
	assert.equal(drafts.rules[0].frequency, 3);
});
