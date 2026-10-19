/** Shared fixture: one M07 goal whose task carries frozen, host-verified
 * candidates. Several suites need the same archive shape, and writing it by
 * hand in each of them makes the archive contract easy to drift from. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../../src/workspace.ts";

export interface CandidateFixture {
	id: string;
	/** Exact frozen source bytes; byte identity is what the delivery check matches. */
	source: string;
	/** Single top-level metric value on the shared basis; lower is better. */
	value: number;
	externalId: string;
	/** Omit the same-basis reference measurement: the metric then has no denominator. */
	withoutReference?: boolean;
	/** Replace the frozen receipt body, e.g. with host performance decisions. */
	receipt?: Record<string, unknown>;
}

/** Writes stages/M07/<runId>/{run.json,goal.json} plus the frozen evidence files. */
export async function writeCandidateGoal(ws: Workspace, runId: string, subjectId: string,
	candidates: readonly CandidateFixture[]): Promise<{ workDir: string; sourceFile: (id: string) => string }> {
	const taskDir = path.join(ws.runDir("M07", runId), "tasks", "T001");
	const workDir = path.join(taskDir, "work");
	const frozenDir = path.join(taskDir, "frozen");
	await mkdir(workDir, { recursive: true });
	await mkdir(frozenDir, { recursive: true });
	const sourceFile = (id: string) => path.join(frozenDir, `${id}.txt`);
	const records = [];
	for (const candidate of candidates) {
		const source = sourceFile(candidate.id);
		const receipt = path.join(frozenDir, `${candidate.id}-receipt.json`);
		const observationPath = path.join(frozenDir, `${candidate.id}-observation.json`);
		await writeFile(source, candidate.source);
		await writeFile(receipt, JSON.stringify(candidate.receipt ?? { externalId: candidate.externalId }));
		const observation = {
			version: 1, kind: "candidate-observation", verifier: { id: "host", version: "1" },
			sourceBinding: "verified", correctness: "passed", stage: "measurement",
			checks: [{ criterion: "correctness", result: "passed" }], goalChecks: [],
			metrics: [{ name: "wall", value: candidate.value, unit: "s", basisId: "B1", direction: "lower" }],
			executionFacts: { evaluations: [{ externalId: candidate.externalId, subjectId, status: "done",
				terminal: true, capturedAt: "2026-01-01T00:00:00Z", receiptIndex: 0,
				cases: [{ caseId: "case1", status: "done", correctness: "passed", metrics: [],
					...(candidate.withoutReference ? {} : { referenceMeasurements: [{ name: "baseline", value: 3, unit: "s", basisId: "B1" }] }) }],
				diagnostics: [] }] },
			limitations: [], sourceFiles: [source], receiptFiles: [receipt],
		};
		await writeFile(observationPath, JSON.stringify(observation));
		records.push({ id: candidate.id, sourcePaths: [`${candidate.id}.txt`], receiptPaths: [`${candidate.id}-receipt.json`],
			hypothesis: `h-${candidate.id}`, changeKind: "structure", intent: "solution", observation, observationPath });
	}
	const run = { stage: "M07", runId, status: "completed", startedAt: "2026-01-01T00:00:00Z",
		finishedAt: "2026-01-01T01:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] };
	await writeFile(path.join(ws.runDir("M07", runId), "run.json"), JSON.stringify(run));
	const goal = { runId, lifecycle: "closed", goal: "候选目标", decisions: [], goalChecks: [],
		tasks: [{ taskId: "T001", objective: "优化", status: "accepted", subjectId,
			createdAt: "2026-01-01T00:00:00Z", workDir, toolLog: [],
			episode: { version: 1, candidates: records, incumbents: [] } }] };
	await writeFile(path.join(ws.runDir("M07", runId), "goal.json"), JSON.stringify(goal));
	return { workDir, sourceFile };
}
