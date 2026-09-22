import { projectInline, type BudgetPolicy } from "./policy.ts";
import type { ImprovementEvaluation, ImprovementProtocol, PolicyReplayResult } from "./types.ts";

export function replayPolicy(policy: BudgetPolicy, protocol: ImprovementProtocol): PolicyReplayResult {
	let totalObservedInputChars = 0;
	let totalInlineChars = 0;
	let totalDeferredChars = 0;
	let maxInlineChars = 0;
	let manifestedSamples = 0;
	let observedFiles = 0;
	let manifestedFiles = 0;
	for (const sample of protocol.samples) {
		let aggregateUsed = 0;
		let represented = 0;
		for (const chars of sample.inputFileChars) {
			const projected = projectInline(policy, chars, aggregateUsed);
			aggregateUsed = projected.nextAggregateChars;
			totalObservedInputChars += chars; totalInlineChars += projected.inlineChars; totalDeferredChars += projected.deferredChars;
			maxInlineChars = Math.max(maxInlineChars, aggregateUsed);
			observedFiles += 1; manifestedFiles += 1; represented += projected.inlineChars + projected.deferredChars;
		}
		if (represented === sample.inputChars) manifestedSamples += 1;
	}
	return { policy, observedSamples: protocol.samples.length, observedFiles, totalObservedInputChars, totalInlineChars, totalDeferredChars, maxInlineChars, manifestedSamples, manifestedFiles };
}

export function evaluateCandidate(protocol: ImprovementProtocol, candidate: BudgetPolicy): ImprovementEvaluation {
	const baseline = replayPolicy(protocol.baselinePolicy, protocol);
	const replay = replayPolicy(candidate, protocol);
	const reductionRatio = baseline.totalInlineChars > 0 ? (baseline.totalInlineChars - replay.totalInlineChars) / baseline.totalInlineChars : 0;
	const newDeferredRatio = replay.totalObservedInputChars > 0 ? Math.max(0, replay.totalDeferredChars - baseline.totalDeferredChars) / replay.totalObservedInputChars : 0;
	const inlineCoverageRatio = replay.totalObservedInputChars > 0 ? replay.totalInlineChars / replay.totalObservedInputChars : 0;
	const gates = [
		{ name: "observed-evidence", passed: protocol.samples.length > 0 && baseline.totalObservedInputChars > 0, detail: `${protocol.samples.length} 个匿名化历史样本，输入字符 ${baseline.totalObservedInputChars}` },
		{ name: "measurable-reduction", passed: reductionRatio >= protocol.minimumReductionRatio, detail: `内联字符减少 ${(reductionRatio * 100).toFixed(2)}%，门槛 ${(protocol.minimumReductionRatio * 100).toFixed(2)}%` },
		{ name: "manifest-coverage", passed: replay.manifestedSamples === replay.observedSamples && replay.manifestedFiles === replay.observedFiles, detail: `${replay.manifestedFiles}/${replay.observedFiles} 文件完整表示为内联或延后` },
		{ name: "bounded-new-read-burden", passed: newDeferredRatio <= protocol.maximumNewDeferredRatio, detail: `新增延后字符占观测输入 ${(newDeferredRatio * 100).toFixed(2)}%，上限 ${(protocol.maximumNewDeferredRatio * 100).toFixed(2)}%` },
		{ name: "absolute-inline-coverage", passed: inlineCoverageRatio >= protocol.minimumInlineCoverageRatio, detail: `候选内联覆盖率 ${(inlineCoverageRatio * 100).toFixed(2)}%，绝对下限 ${(protocol.minimumInlineCoverageRatio * 100).toFixed(2)}%` },
		{ name: "caps-do-not-expand", passed: candidate.maxPromptChars <= protocol.baselinePolicy.maxPromptChars && candidate.maxInlineFileChars <= protocol.baselinePolicy.maxInlineFileChars && candidate.maxAggregateInlineChars <= protocol.baselinePolicy.maxAggregateInlineChars && candidate.maxFeedbackChars <= protocol.baselinePolicy.maxFeedbackChars, detail: "候选不得扩大任一内容预算" },
		{ name: "unreplayed-caps-frozen", passed: candidate.maxPromptChars === protocol.baselinePolicy.maxPromptChars && candidate.maxFeedbackChars === protocol.baselinePolicy.maxFeedbackChars, detail: "本轮没有真实重放 prompt 总长与反馈包生成，因此这两个门槛必须保持基线值" },
		{ name: "overflow-mode-nonregression", passed: candidate.overflowMode === protocol.baselinePolicy.overflowMode, detail: `溢出处置保持 ${protocol.baselinePolicy.overflowMode}` },
		{ name: "maximum-inline-nonregression", passed: replay.maxInlineChars <= baseline.maxInlineChars, detail: `最大内联 ${baseline.maxInlineChars} → ${replay.maxInlineChars}` },
	];
	return { passed: gates.every((gate) => gate.passed), baseline, candidate: replay, reductionRatio, gates };
}
