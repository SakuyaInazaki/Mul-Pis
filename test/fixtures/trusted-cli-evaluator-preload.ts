/** Explicit trusted Node --import bootstrap for offline production CLI tests. */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerTrustedLocalMissionEvaluator } from "../../src/m07/local-mission-evaluator.ts";
import { FakeSessionRunner, registerTrustedCliFakeRunnerFactory } from "../../src/runner/fake.ts";
import type { ReadReturnEvent } from "../../src/runner/types.ts";

const answer = "A synthetic observed result.\n";
const observationName = "observation-byte-count.json";
const lineCount = (text: string) => text.split(/\r?\n/).length - Number(text.endsWith("\n"));

registerTrustedLocalMissionEvaluator({ id: "test:byte-observation", version: "1",
	supportedObligationTypes: ["test-byte-count"],
	async preflight({ contract, frozenOriginalInputs, capabilities }) {
		return { available: contract.obligations.every(item => item.type === "test-byte-count") &&
			frozenOriginalInputs.some(item => item.name === "original-problem.txt" && item.bytes > 0 &&
				/^[0-9a-f]{64}$/.test(item.sha256)) &&
			capabilities.some(item => item.scope === "local-m07-reason" && item.available),
			reason: "synthetic offline original input or reasoning capability is unavailable" };
	},
	async evaluate({ contract, missionId, runId, taskId, candidate, observationOutputDir }) {
		const observed = await Promise.all(candidate.map(async item => ({ name: item.name,
			bytes: (await readFile(item.file)).length, sha256: item.sha256 })));
		await writeFile(path.join(observationOutputDir, observationName),
			`${JSON.stringify({ kind: "synthetic-byte-count-observation", missionId, runId,
				taskId, observed }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		const match = observed.find(item => item.bytes === Buffer.byteLength(answer));
		return { observations: [{ name: observationName, kind: "json" }],
			checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: match ? "passed" as const : "failed" as const,
				evidenceRefs: [...(match ? [match.name] : []), observationName],
				limitations: ["Synthetic byte-count measurement only; no scientific conclusion."] })),
			limitations: ["This offline test does not evaluate a research objective."] };
	},
});

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const found: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const value = await readFile(file, "utf8");
			if (!value.length) continue;
			found.push({ toolName, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1, endLine: lineCount(value),
					truncated: false }, at: new Date().toISOString() });
		}
	}
	await visit(root);
	return found;
}

registerTrustedCliFakeRunnerFactory(() => new FakeSessionRunner(async ({ spec }) => {
	if (spec.label === "M04-research") return spec.tools.kind === "read-dir" ?
		{ text: "Offline independent M04 read all selected text; no knowledge proposal.",
			readReturns: await readEvents(spec.tools.root, "m07_evidence_read") } :
		"Offline initial M04 baseline; no knowledge proposal.";
	if (spec.label.startsWith("M07-")) return answer;
	if (spec.label.startsWith("local-original-objective-")) {
		if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks read-dir evidence");
		const contract = JSON.parse(await readFile(path.join(spec.tools.root,
			"original-objective.json"), "utf8")) as { id: string };
		const ref = { sourceId: "original-problem.txt", startLine: 1, endLine: 1 };
		const first = spec.label.endsWith("-1");
		const twoStep = process.env.MULPIS_SYNTHETIC_TWO_STEP === "1";
		const selectedObservation = (await readdir(spec.tools.root)).find(name =>
			/^observation-byte-count-[0-9a-f]{16}\.json$/.test(name));
		const issue = { id: "synthetic-gap", claim: "Synthetic byte count needs observation",
			status: first ? "open" : "resolved", classification: "explicit-requirement",
			sourceRefs: [ref], implication: "A host observation can settle the synthetic check",
			...(first ? {} : { resolution: { explanation: "The selected host observation records the synthetic result.",
				evidenceRefs: [{ sourceId: selectedObservation, startLine: 1, endLine: 1 }] } }) };
		if (twoStep && !first) {
			const priorIssue = { id: "synthetic-gap", claim: "Synthetic byte count needs observation",
				status: "open", classification: "explicit-requirement", sourceRefs: [ref],
				implication: "A host observation can settle the synthetic check" };
			const secondIssue = { id: "synthetic-second-gap",
				claim: "A distinct synthetic candidate still needs observation", status: "open",
				classification: "explicit-requirement", sourceRefs: [ref],
				implication: "A second bounded task can test a separate candidate" };
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "The first reviewed task is settled; test a distinct candidate.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [priorIssue.claim, secondIssue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: contract.id, missionStatus: "open", issues: [priorIssue, secondIssue],
					legacyOpenDetails: [],
					nextTask: { objective: "Produce a second distinct synthetic byte-count candidate",
						obligationIds: ["answer"], addresses: [secondIssue.id],
						adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "A second observation can test a distinct candidate",
						expectedEvidence: "Second host-created JSON observation", sourceRefs: [ref] } } }),
				readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
		}
		return { text: JSON.stringify(first ? { version: 1, decision: "continue",
			rationale: "The synthetic candidate needs a host measurement.",
			evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
			unresolvedDetails: [issue.claim], groundedAssessment: { version: 1,
				kind: "grounded-assessment-proposal", contractId: contract.id,
				missionStatus: "open", issues: [issue], legacyOpenDetails: [],
				nextTask: { objective: "Produce a synthetic byte-count candidate",
					obligationIds: ["answer"], addresses: [issue.id],
					adapterScope: "local-m07-reason",
					decisionChangingHypothesis: "A byte-count observation settles this test",
					expectedEvidence: "Host-created JSON observation", sourceRefs: [ref] } } } :
			{ version: 1, decision: "fulfilled", rationale: "The selected synthetic result is measured.",
				evidenceRefs: [selectedObservation], unresolvedObligations: [], unresolvedDetails: [],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: contract.id, missionStatus: "open", issues: [issue], legacyOpenDetails: [] } }),
			readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
	}
	throw new Error(`unexpected offline CLI session ${spec.label}`);
}));
