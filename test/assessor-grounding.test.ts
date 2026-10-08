import assert from "node:assert/strict";
import test from "node:test";
import { mergeGroundedAssessmentDelta, validateGroundedAssessment, validatePriorGroundingIndex,
	GroundingSpanError, GroundingFieldError,
	type GroundedAssessmentProposal,
	type GroundingContext } from "../src/m07/assessor-grounding.ts";

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

test("accepts a traceable offline proposal without changing the open mission", () => {
	const candidate = proposal();
	const before = structuredClone(candidate);
	assert.equal(validateGroundedAssessment(candidate, context), candidate);
	assert.deepEqual(candidate, before);
	assert.equal(candidate.missionStatus, "open");
	assert.equal(candidate.deliverableReady?.status, "proposed");
});

test("requires registered exact line ranges and class-specific evidence", () => {
	const missingSource = proposal();
	missingSource.issues[0]!.sourceRefs = [ref("unregistered")];
	assert.throws(() => validateGroundedAssessment(missingSource, context), error =>
		error instanceof GroundingSpanError && error.pointer === "/groundedAssessment/issues/0/sourceRefs/0" &&
		error.safeDetail.includes("unregistered"));
	const privateLooking = proposal();
	privateLooking.issues[0]!.sourceRefs = [ref("PRIVATEACCOUNTID123")];
	assert.throws(() => validateGroundedAssessment(privateLooking, context), error =>
		error instanceof GroundingSpanError &&
		error.safeDetail.includes("unregistered-or-invalid") &&
		!error.safeDetail.includes("PRIVATEACCOUNTID123"));

	const badRange = proposal();
	badRange.issues[0]!.sourceRefs = [ref("user-directive", 2, 3)];
	assert.throws(() => validateGroundedAssessment(badRange, context), error =>
		error instanceof GroundingSpanError && error.pointer === "/groundedAssessment/issues/0/sourceRefs/0" &&
		error.safeDetail.includes('"endLineMax":2') &&
		error.safeDetail.includes('"endLine":3'));

	const unsupportedRequirement = proposal();
	unsupportedRequirement.issues[0]!.sourceRefs = [ref("selected-result")];
	assert.throws(() => validateGroundedAssessment(unsupportedRequirement, context), /instruction or task source/);

	const unsourcedOptionality = proposal();
	unsourcedOptionality.issues[2]!.optionalBasis = undefined;
	assert.throws(() => validateGroundedAssessment(unsourcedOptionality, context), /sourced optionality basis/);

	const unobservedGap = proposal();
	unobservedGap.issues[3]!.capabilityRef = ref("task-material");
	assert.throws(() => validateGroundedAssessment(unobservedGap, context), /host-capability source/);
});

test("a physical gap cites its own frozen unavailable capability row", () => {
	const located = { ...context, capabilityLocators: { counters: ref("observed-host", 2) } };
	assert.equal(validateGroundedAssessment(proposal(), located).issues[3]!.blockedScope, "counters");
	const unrelatedLine = proposal();
	unrelatedLine.issues[3]!.capabilityRef = ref("observed-host", 1);
	assert.throws(() => validateGroundedAssessment(unrelatedLine, located),
		/citation must cover the registered unavailable capability/);
	const descriptiveScope = proposal();
	descriptiveScope.issues[3]!.blockedScope = "hardware counters are unavailable";
	assert.throws(() => validateGroundedAssessment(descriptiveScope, located),
		/unavailable registered capability/);
});

test("next work needs an available scope and a decision-changing hypothesis", () => {
	const noHypothesis = proposal();
	noHypothesis.nextTask!.decisionChangingHypothesis = "";
	assert.throws(() => validateGroundedAssessment(noHypothesis, context), error =>
		error instanceof GroundingFieldError &&
		error.pointer === "/groundedAssessment/nextTask/decisionChangingHypothesis" &&
		error.safeDetail.includes("nonempty text"));

	const unavailable = proposal();
	unavailable.nextTask!.adapterScope = "counters";
	assert.throws(() => validateGroundedAssessment(unavailable, context), error =>
		error instanceof GroundingFieldError &&
		error.pointer === "/groundedAssessment/nextTask/adapterScope" &&
		error.safeDetail.includes("unavailable registered scope"));

	const unknownIssue = proposal();
	unknownIssue.nextTask!.addresses = ["not-an-issue"];
	assert.throws(() => validateGroundedAssessment(unknownIssue, context), error =>
		error instanceof GroundingFieldError &&
		error.pointer === "/groundedAssessment/nextTask/addresses" &&
		error.safeDetail.includes("OPEN grounded issue IDs"));
});

test("cannot drop legacy claims or smuggle in mission closure or accepted readiness", () => {
	const dropped = proposal();
	dropped.legacyOpenDetails = [];
	assert.throws(() => validateGroundedAssessment(dropped, context), /unresolved legacy details/);
	assert.throws(() => validateGroundedAssessment(proposal(),
		{ ...context, previousIssueIds: ["earlier-requirement"] }), /previously grounded issue/);

	const closed = { ...proposal(), missionStatus: "fulfilled" };
	assert.throws(() => validateGroundedAssessment(closed, context), /mission status/);

	const hiddenOutcome = { ...proposal(), objectiveOutcome: "fulfilled" };
	assert.throws(() => validateGroundedAssessment(hiddenOutcome, context), /mission status/);

	const accepted = proposal();
	accepted.deliverableReady = { ...accepted.deliverableReady!, status: "accepted" as "proposed" };
	assert.throws(() => validateGroundedAssessment(accepted, context), /only a proposed finding/);
});

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

test("a partial host-control summary cannot resolve a scientific issue", () => {
	const candidate = proposal();
	const previous = structuredClone(candidate.issues[1]!);
	candidate.issues[1]!.status = "resolved";
	candidate.issues[1]!.resolution = { explanation: "The prior run had observed calls.",
		evidenceRefs: [ref("prior-incomplete-run-control")] };
	candidate.nextTask!.addresses = ["deliverable"];
	candidate.deliverableReady!.remainingIssueIds = ["deliverable", "optional", "equipment"];
	assert.throws(() => validateGroundedAssessment(candidate, { ...context,
		previousIssues: [previous],
		newEvidenceSourceIds: ["prior-incomplete-run-control"],
		sources: { ...context.sources,
			"prior-incomplete-run-control": { kind: "host-control", lineCount: 1 } } }),
		/resolution needs a selected result or host observation/);
});

test("line-addressed prior grounding reassembles exactly and delta omission retains old records", () => {
	const oldIssue = proposal().issues[1]!;
	const legacy = ["old detail"];
	const partName = "prior-part.jsonl";
	const part = `${JSON.stringify({ kind: "legacy-detail", value: legacy[0] })}\n` +
		`${JSON.stringify({ kind: "issue", value: oldIssue })}\n`;
	const index = JSON.stringify({ version: 1, kind: "prior-grounding-index", parts: [partName],
		legacyLocators: [{ partName, line: 1 }],
		issueLocators: [{ id: oldIssue.id, partName, line: 2 }] });
	const locators = validatePriorGroundingIndex(index, { [partName]: part },
		{ legacyOpenDetails: legacy, previousIssues: [oldIssue] });
	assert.deepEqual(locators[oldIssue.id], { sourceId: partName, startLine: 2, endLine: 2 });
	const merged = mergeGroundedAssessmentDelta({ version: 1, kind: "grounded-assessment-delta",
		newIssues: [], resolutions: [] }, { ...context, legacyOpenDetails: legacy,
		previousIssues: [oldIssue], priorIssueLocators: locators });
	assert.deepEqual(merged.proposal.issues, [oldIssue]);
	assert.deepEqual(merged.proposal.legacyOpenDetails, legacy);
	assert.throws(() => validatePriorGroundingIndex(index, { [partName]: part.replace("old detail", "tampered") },
		{ legacyOpenDetails: legacy, previousIssues: [oldIssue] }), /legacy detail changed/);
});
