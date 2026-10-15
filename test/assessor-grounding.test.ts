import assert from "node:assert/strict";
import test from "node:test";
import { validateGroundedAssessment, GroundingFieldError, type GroundedAssessmentProposal, type GroundingContext } from "../src/m07/assessor-grounding.ts";

const context: GroundingContext = {
	contractId: "frozen-contract",
	sources: {
		"user-directive": { kind: "user-instruction", lineCount: 2 },
		"task-material": { kind: "supplied-task", lineCount: 3 },
		"selected-result": { kind: "selected-evidence", lineCount: 4 },
		"observed-host": { kind: "host-capability", lineCount: 2 },
	},
	capabilities: { "registered-experiment": { available: true }, counters: { available: false } },
	legacyOpenDetails: ["An old unresolved detail whose provenance has not been checked."],
};

const ref = (sourceId: string, startLine = 1, endLine = startLine) =>
	({ sourceId, startLine, endLine });

function proposal(): GroundedAssessmentProposal {
	return {
		version: 1, kind: "grounded-assessment-proposal", contractId: "frozen-contract",
		missionStatus: "open", legacyOpenDetails: [...context.legacyOpenDetails],
		issues: [
			{ id: "deliverable", claim: "Produce a supported result", status: "open", classification: "explicit-requirement",
				sourceRefs: [ref("user-directive")], implication: "Defines the requested deliverable." },
			{ id: "validation", claim: "Check the stated result", status: "open", classification: "necessary-verification",
				sourceRefs: [ref("selected-result", 2)], implication: "A claim depends on this check.",
				claimAtRisk: "The proposed result is correct." },
			{ id: "optional", claim: "One suggested method is optional", status: "open", classification: "optional-method",
				sourceRefs: [ref("task-material", 2)], implication: "It does not define the deliverable.",
				optionalBasis: "The source presents this as a possible method." },
			{ id: "equipment", claim: "A device is unavailable", status: "open", classification: "physical-capability-gap",
				sourceRefs: [ref("task-material", 3)], implication: "Claims needing it remain limited.",
				blockedScope: "counters", capabilityRef: ref("observed-host", 2) },
		],
		nextTask: { objective: "Run a synthetic independent check",
			obligationIds: ["original-task"], addresses: ["deliverable", "validation"],
			adapterScope: "registered-experiment",
			decisionChangingHypothesis: "A new check could change the recommended result.",
			expectedEvidence: "A new measured comparison and validity check.",
			sourceRefs: [ref("user-directive"), ref("selected-result", 2)] },
		deliverableReady: { status: "proposed", ready: false,
			rationale: "More evidence is needed before a deliverable claim.",
			evidenceRefs: [ref("selected-result", 2)],
			remainingIssueIds: ["deliverable", "validation", "optional", "equipment"] },
	};
}


test("a prior issue can resolve with cited evidence while retaining its ID and open mission", () => {
	const candidate = proposal();
	const verification = candidate.issues[1]!;
	const previous = structuredClone(verification);
	verification.status = "resolved";
	verification.resolution = { explanation: "The new selected result checks the claim.",
		evidenceRefs: [ref("selected-result", 3)] };
	candidate.nextTask!.addresses = ["deliverable"];
	candidate.deliverableReady!.remainingIssueIds = ["deliverable", "optional", "equipment"];
	assert.equal(validateGroundedAssessment(candidate,
		{ ...context, previousIssues: [previous], newEvidenceSourceIds: ["selected-result"] }).missionStatus, "open");
	assert.throws(() => validateGroundedAssessment(candidate,
		{ ...context, previousIssues: [previous] }), /new frozen evidence/);
	const changedClaim = structuredClone(candidate);
	changedClaim.issues[1]!.claim = "A different claim";
	assert.throws(() => validateGroundedAssessment(changedClaim,
		{ ...context, previousIssues: [previous], newEvidenceSourceIds: ["selected-result"] }),
		/authenticated prior issue/);

	candidate.nextTask!.addresses = ["validation"];
	assert.throws(() => validateGroundedAssessment(candidate, context), error =>
		error instanceof GroundingFieldError &&
		error.pointer === "/groundedAssessment/nextTask/addresses" &&
		error.safeDetail.includes("OPEN grounded issue IDs"));
	candidate.nextTask!.addresses = ["deliverable"];
	verification.resolution = { explanation: "Unsupported self assertion.",
		evidenceRefs: [ref("task-material")] };
	assert.throws(() => validateGroundedAssessment(candidate, context), /selected result or host observation/);
});


test("live source binding needs an exact available attempt and grounded attempt citations", () => {
	const selected = { kind: "selected" as const, sourceSha256: "a".repeat(64) };
	const attempt = { kind: "unselected-attempt" as const, attemptId: "R2:T1",
		sourceSha256: "b".repeat(64), planSha256: "c".repeat(64) };
	const taskEvidence = { source: "task-attempt-1-source.cpp",
		verification: "task-attempt-1-verification.json",
		archive: "task-attempt-1-archive.json", plan: "task-attempt-1-plan.json" };
	const live = { ...context, taskSourceBindings: { selected, attempts: [attempt],
		attemptEvidence: { [attempt.attemptId]: taskEvidence } },
		sources: { ...context.sources, ...Object.fromEntries(Object.values(taskEvidence).map(name =>
			[name, { kind: "unselected-evidence" as const, lineCount: 1 }])) } };
	const missing = proposal();
	assert.throws(() => validateGroundedAssessment(missing, live), error =>
		error instanceof GroundingFieldError && error.pointer.endsWith("/sourceBinding"));
	const stale = proposal();
	stale.nextTask!.sourceBinding = { ...attempt, sourceSha256: "d".repeat(64) };
	assert.throws(() => validateGroundedAssessment(stale, live), error =>
		error instanceof GroundingFieldError && error.safeDetail.includes(
			"available host-frozen selected or unselected source"));
	const cited = proposal();
	cited.nextTask!.sourceBinding = attempt;
	assert.throws(() => validateGroundedAssessment(cited, live), error =>
		error instanceof GroundingFieldError && error.safeDetail.includes(
			"must cite its frozen source, verification and archive"));
	cited.nextTask!.sourceRefs.push(ref(taskEvidence.source), ref(taskEvidence.verification),
		ref(taskEvidence.archive));
	assert.equal(validateGroundedAssessment(cited, live).nextTask!.sourceBinding, attempt);
	const baseline = proposal();
	baseline.nextTask!.sourceBinding = selected;
	assert.equal(validateGroundedAssessment(baseline, live).nextTask!.sourceBinding, selected);
	assert.equal(validateGroundedAssessment(proposal(), context).nextTask!.sourceBinding, undefined,
		"historical assessments remain readable without the live source binding policy");
});
