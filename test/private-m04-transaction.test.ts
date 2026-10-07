import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/workspace.ts";
import { exportPortableM04Transaction } from "../src/workflow-archive/m04-transaction.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

test("private M04 transaction exports the exact rejected draft and receipt without merge authority", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-transaction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(path.join(root, "workspace"));
	const run = await ws.startRun("M04", []);
	const out = path.join(root, "output");
	await mkdir(out);
	const proposals = path.join(ws.knowledgeDir, "proposals");
	await mkdir(proposals, { recursive: true });
	const draft = `${JSON.stringify({ id: "P0001", stage: "M04", runId: run.runId,
		ops: [{ op: "create", title: "synthetic" }] })}\n`;
	const proposalFile = path.relative(ws.root, path.join(proposals, "P0001.json")).replaceAll("\\", "/");
	const issues = [{ level: "error", message: "synthetic structural field missing", opIndex: 0 }];
	const receipt = `${JSON.stringify({ version: 1, kind: "m04-proposal-validation",
		m04RunId: run.runId, proposalId: "P0001", proposalFile,
		structurallyValid: false, issues })}\n`;
	await writeFile(path.join(proposals, "P0001.json"), draft);
	await writeFile(path.join(ws.runDir("M04", run.runId), "proposal-validation-0001.json"), receipt);
	const tx = { version: 1, kind: "m04-knowledge-transaction", m04RunId: run.runId,
		state: "rejected-draft", currentProposalId: "P0001", updatedAt: "2026-10-06T00:00:00.000Z",
		attempts: [{ ordinal: 1, proposalId: "P0001", proposalFile,
			receiptFile: "proposal-validation-0001.json", structurallyValid: false,
			issues, state: "rejected-draft" }] };
	await writeFile(path.join(ws.runDir("M04", run.runId), "m04-transaction.json"), JSON.stringify(tx));
	const portable = await exportPortableM04Transaction({ ws, m04RunId: run.runId, destination: out });
	assert.equal(portable.state, "rejected-draft");
	assert.equal(portable.attempts[0].proposalDraftJson, draft);
	assert.equal(portable.attempts[0].validationReceiptJson, receipt);
	assert.deepEqual(portable.attempts[0].issues, issues);
	assert.equal(JSON.parse(await readFile(path.join(out, "m04-transaction.json"), "utf8")).state,
		"rejected-draft");
	await ws.writeOutput(run, "m07-source.json", JSON.stringify({ m07RunId: "synthetic-goal" }),
		"M07 处理来源");
	await ws.writeRun(run);
	const recovered = await offlineChecks.retainFailedM04Transaction(ws, "synthetic-goal", out);
	assert.equal(recovered?.runId, run.runId);
	assert.equal(recovered?.proposalSubmitted, true);
	assert.equal(recovered?.snapshotCreated, false);
	assert.equal(recovered?.transaction?.state, "rejected-draft");
	assert.equal(offlineChecks.failedM04StopReason("failed", recovered?.transaction?.state),
		"m04-draft-rejected");
	await writeFile(path.join(ws.runDir("M04", run.runId), "proposal-validation-0001.json"),
		receipt.replace("synthetic structural field missing", "different issue"));
	await assert.rejects(exportPortableM04Transaction({ ws, m04RunId: run.runId, destination: out }),
		/validation receipt do not bind/);
});
