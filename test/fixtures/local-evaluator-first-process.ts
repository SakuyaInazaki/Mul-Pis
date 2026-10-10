/** Offline child process for the real process-identity restart test. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { openDefaultLocalMission } from "../../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";
import type { ReadReturnEvent } from "../../src/runner/types.ts";
import { runM04 } from "../../src/stages/m04.ts";
import { runInit } from "../../src/stages/init.ts";
import { Workspace } from "../../src/workspace.ts";

const root = process.argv[2];
if (!root) throw new Error("fixture workspace missing");
const answer = "A synthetic finite answer with exact bytes.\n";
const ws = new Workspace(root);
await mkdir(path.dirname(ws.problemFile), { recursive: true });
await writeFile(ws.problemFile, "Produce the exact synthetic finite answer.\n");
const store = createFileKnowledgeStore(ws.knowledgeDir);
await runInit(ws, store);
const config = { roles: { research: "fake/research", execution: "fake/execution" },
	localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1, tools: {} };
let missionId = "";
const events = async (dir: string, toolName: string): Promise<ReadReturnEvent[]> => {
	const found: ReadReturnEvent[] = [];
	const visit = async (folder: string): Promise<void> => {
		for (const name of await readdir(folder)) {
			const file = path.join(folder, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const text = await readFile(file, "utf8");
			if (text.length) found.push({ toolName, status: "returned",
				path: path.relative(dir, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1,
					endLine: text.split(/\r?\n/).length - Number(text.endsWith("\n")),
					truncated: false }, at: new Date().toISOString() });
		}
	};
	await visit(dir);
	return found;
};
const runner = new FakeSessionRunner(async ({ spec }) => {
	if (spec.label === "M04-research") return spec.tools.kind === "read-dir" ?
		{ text: "Independent M04 read all selected evidence; no proposal.",
			readReturns: await events(spec.tools.root, "m07_evidence_read") } :
		"Initial synthetic baseline; no proposal.";
	if (spec.label.startsWith("M07-")) return answer;
	if (spec.label.startsWith("local-original-objective-")) {
		if (spec.tools.kind !== "read-dir") throw new Error("assessor grant missing");
		const ref = { sourceId: "original-problem.txt", startLine: 1, endLine: 1 };
		return { text: JSON.stringify({ version: 1, decision: "continue",
			rationale: "The exact answer still needs a checked candidate.",
			evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
			unresolvedDetails: ["Exact answer has not been checked"],
			groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
				contractId: missionId, missionStatus: "open", legacyOpenDetails: [],
				issues: [{ id: "finite-gap", claim: "Exact answer has not been checked",
					status: "open", classification: "explicit-requirement", sourceRefs: [ref],
					implication: "A checked candidate can settle this task" }],
				nextTask: { objective: "Produce the exact synthetic answer", obligationIds: ["answer"],
					addresses: ["finite-gap"], adapterScope: "local-m07-reason",
					decisionChangingHypothesis: "Exact bytes settle the finite obligation",
					expectedEvidence: "A digest checked candidate", sourceRefs: [ref] } } }),
			readReturns: await events(spec.tools.root, "objective_evidence_read") };
	}
	throw new Error(`unexpected offline session ${spec.label}`);
});
await runM04({ ws, runner, store, config }, { feedback: { kind: "file",
	label: "Synthetic baseline", path: ws.problemFile }, freshSession: true });
const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
	goal: "Produce the exact synthetic finite answer", goalSource: "verbatim-private-input",
	obligations: [{ id: "answer", description: "Produce exact answer bytes", type: "file-sha256",
		expectedSha256: createHash("sha256").update(answer).digest("hex") }],
	closure: "finite-evidence" });
missionId = started.contract.id;
const first = await mission.step(missionId);
if (first.objectiveOutcome !== "incomplete" ||
	!/^candidate-001-[0-9a-f]{16}\.md$/.test(first.selectedArtifacts[0] ?? ""))
	throw new Error("first process did not persist a selected candidate");
process.stdout.write(`${JSON.stringify({ missionId })}\n`);
