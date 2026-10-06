import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantTurn, SessionHandle, UsageSummary } from "../runner/types.ts";
import { summarizeUsage } from "../runner/usage.ts";
import { HarnessError } from "../types.ts";

const MAX_FROZEN_BYTES = 1_000_000;

async function frozenFile(file: string, optional = false): Promise<Buffer | undefined> {
	let info;
	try { info = await lstat(file); }
	catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new HarnessError("m07.evidence-finalization", "measured source or evidence file is unavailable");
	}
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FROZEN_BYTES)
		throw new HarnessError("m07.evidence-finalization", "measured source or evidence is not a bounded regular file");
	const bytes = await readFile(file);
	if (bytes.length !== info.size) throw new HarnessError("m07.evidence-finalization", "measured source or evidence changed while being frozen");
	return bytes;
}

function combinedTurnUsage(first: AssistantTurn, second: AssistantTurn): UsageSummary | undefined {
	if (!first.usage || !second.usage) return undefined;
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "reportedEvents", "unknownEvents"] as const;
	const total = { ...first.usage };
	for (const field of fields) total[field] += second.usage[field];
	total.complete = first.usage.complete && second.usage.complete;
	total.costComplete = first.usage.costComplete && second.usage.costComplete;
	return total;
}

/** One live actor observes host evidence before a fresh reviewer can inspect its final account. */
export async function runMeasuredEvidenceHandoff(input: {
	handle: SessionHandle;
	implementationPrompt: string;
	sourceFile: string;
	/** Additional model-authored inputs used by host measurement, such as an experiment plan. */
	frozenSourceFiles?: string[];
	evidenceFile: string;
	measure: () => Promise<void>;
	finalizationPrompt: string;
	/** Full-file read tool, rather than a path mentioned in the model's prose. */
	readToolName: string;
	onFinalization?: () => void;
}): Promise<AssistantTurn> {
	const { handle } = input;
	const usageStart = handle.usageEvents().length;
	const implementation = await handle.prompt(input.implementationPrompt);
	const sourceBefore = await frozenFile(input.sourceFile, true);
	const additionalBefore = await Promise.all((input.frozenSourceFiles ?? []).map(file => frozenFile(file, true)));
	await input.measure();
	const sourceMeasured = await frozenFile(input.sourceFile, true);
	const additionalMeasured = await Promise.all((input.frozenSourceFiles ?? []).map(file => frozenFile(file, true)));
	if (Boolean(sourceBefore) !== Boolean(sourceMeasured) ||
		(sourceBefore && sourceMeasured && !sourceBefore.equals(sourceMeasured)) ||
		additionalBefore.some((bytes, index) => Boolean(bytes) !== Boolean(additionalMeasured[index]) ||
			(bytes && additionalMeasured[index] && !bytes.equals(additionalMeasured[index]))))
		throw new HarnessError("m07.evidence-finalization", "candidate source changed while host verification ran");
	// Even an absent source is host feedback the actor must read before ordinary repair review.
	const evidenceMeasured = await frozenFile(input.evidenceFile);
	if (!evidenceMeasured) throw new HarnessError("m07.evidence-finalization", "host verification is missing");
	const toolStart = handle.toolLog().length;
	input.onFinalization?.();
	const finalization = await handle.prompt(input.finalizationPrompt);
	const [sourceFinal, evidenceFinal] = await Promise.all([
		frozenFile(input.sourceFile, true), frozenFile(input.evidenceFile),
	]);
	const additionalFinal = await Promise.all((input.frozenSourceFiles ?? []).map(file => frozenFile(file, true)));
	if (Boolean(sourceFinal) !== Boolean(sourceMeasured) || (sourceFinal && sourceMeasured && !sourceFinal.equals(sourceMeasured)) || !evidenceFinal?.equals(evidenceMeasured))
		throw new HarnessError("m07.evidence-finalization", "candidate or verification changed after measurement");
	if (additionalMeasured.some((bytes, index) => Boolean(bytes) !== Boolean(additionalFinal[index]) ||
		(bytes && additionalFinal[index] && !bytes.equals(additionalFinal[index]))))
		throw new HarnessError("m07.evidence-finalization", "experiment input changed after measurement");
	const evidencePath = path.resolve(input.evidenceFile);
	const readEvidence = handle.toolLog().slice(toolStart).some((call) =>
		call.ok && call.name === input.readToolName && typeof call.args.path === "string" &&
		path.resolve(path.dirname(input.evidenceFile), call.args.path) === evidencePath);
	if (!readEvidence) throw new HarnessError("m07.evidence-finalization", "final account did not read the current host verification");
	const events = handle.usageEvents().slice(usageStart);
	const fallbackUsage = events.length ? undefined : combinedTurnUsage(implementation, finalization);
	const { usage: _finalizationOnlyUsage, ...finalizedWithoutUsage } = finalization;
	return { ...finalizedWithoutUsage, toolCalls: implementation.toolCalls + finalization.toolCalls,
		...(events.length ? { usage: summarizeUsage(events) } : fallbackUsage ? { usage: fallbackUsage } : {}) };
}
