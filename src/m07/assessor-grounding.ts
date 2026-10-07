/** Offline shape check for a proposed, source-grounded objective assessment.
 *
 * This does not interpret private source text, accept a scientific claim, dispatch
 * work, change an original contract, or close an open-ended mission.
 */
import { isDeepStrictEqual } from "node:util";

export type GroundingSourceKind = "user-instruction" | "supplied-task" |
	"selected-evidence" | "host-capability";

export interface GroundingSource {
	kind: GroundingSourceKind;
	/** Number of addressable lines in the frozen, registered source. */
	lineCount: number;
}

export interface GroundingSpan {
	sourceId: string;
	startLine: number;
	endLine: number;
}

export type GroundedIssue = {
	id: string;
	claim: string;
	status: "open" | "resolved";
	classification: "explicit-requirement" | "necessary-verification" |
		"optional-method" | "physical-capability-gap";
	sourceRefs: GroundingSpan[];
	/** Explains how the cited source affects the original deliverable. */
	implication: string;
	/** Required for a derived verification claim. */
	claimAtRisk?: string;
	/** Required before a method may be called optional. */
	optionalBasis?: string;
	/** Required for a physical gap; must cite a registered host observation. */
	capabilityRef?: GroundingSpan;
	blockedScope?: string;
	/** Closing an issue requires newly cited frozen evidence, not deletion. */
	resolution?: { explanation: string; evidenceRefs: GroundingSpan[] };
};

export interface GroundedNextTask {
	/** Original contract obligation IDs, matched by the live assessor parser. */
	obligationIds: string[];
	/** IDs of grounded issues this task could change. */
	addresses: string[];
	adapterScope: string;
	/** Testable reason this work could change the strategy recommendation. */
	decisionChangingHypothesis: string;
	expectedEvidence: string;
	sourceRefs: GroundingSpan[];
}

export interface GroundedAssessmentProposal {
	version: 1;
	kind: "grounded-assessment-proposal";
	contractId: string;
	/** A proposed deliverable finding never changes the mission outcome. */
	missionStatus: "open";
	issues: GroundedIssue[];
	/** Copied exactly from the old checkpoint until separately grounded. */
	legacyOpenDetails: string[];
	nextTask?: GroundedNextTask;
	deliverableReady?: {
		status: "proposed";
		ready: boolean;
		rationale: string;
		evidenceRefs: GroundingSpan[];
		remainingIssueIds: string[];
	};
}

export interface GroundingContext {
	contractId: string;
	sources: Readonly<Record<string, GroundingSource>>;
	capabilities: Readonly<Record<string, { available: boolean }>>;
	legacyOpenDetails: readonly string[];
	/** Earlier grounded issues stay open until a separate resolution review exists. */
	previousIssueIds?: readonly string[];
	/** Full prior records are shown to the assessor; IDs and claims cannot drift. */
	previousIssues?: readonly GroundedIssue[];
	/** Frozen files that were produced after the prior assessment. */
	newEvidenceSourceIds?: readonly string[];
	/** Authenticated location of each prior issue in the current frozen evidence. */
	priorIssueLocators?: Readonly<Record<string, GroundingSpan>>;
}

export interface GroundedAssessmentDelta {
	version: 1;
	kind: "grounded-assessment-delta";
	newIssues: GroundedIssue[];
	resolutions: Array<{ id: string; priorRef: GroundingSpan;
		explanation: string; evidenceRefs: GroundingSpan[] }>;
	nextTask?: GroundedNextTask;
	deliverableReady?: GroundedAssessmentProposal["deliverableReady"];
}

/** Validates a lossless, line-addressable frozen partition of prior grounding. */
export function validatePriorGroundingIndex(indexText: string,
	parts: Readonly<Record<string, string>>, expected: Pick<GroundingContext,
		"legacyOpenDetails" | "previousIssues">): Record<string, GroundingSpan> {
	let index: unknown;
	try { index = JSON.parse(indexText); } catch { return fail("prior grounding index is invalid JSON"); }
	if (!obj(index) || !onlyKeys(index, ["version", "kind", "parts", "legacyLocators",
		"issueLocators"]) || index.version !== 1 || index.kind !== "prior-grounding-index" ||
		!Array.isArray(index.parts) || !index.parts.every(id) ||
		new Set(index.parts).size !== index.parts.length ||
		!Array.isArray(index.legacyLocators) || !Array.isArray(index.issueLocators) ||
		index.legacyLocators.length !== expected.legacyOpenDetails.length ||
		index.issueLocators.length !== (expected.previousIssues ?? []).length ||
		!isDeepStrictEqual([...index.parts].sort(), Object.keys(parts).sort()))
		fail("prior grounding index does not match authenticated records and frozen parts");
	const linesByPart = new Map<string, string[]>();
	const used = new Set<string>();
	for (const name of index.parts) {
		const source = parts[name];
		if (typeof source !== "string") fail("prior grounding part is missing");
		const lines = source.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (lines.some(line => !line.trim())) fail("prior grounding part has an empty line");
		linesByPart.set(name, lines);
	}
	const recordAt = (locator: unknown, kind: "legacy-detail" | "issue"): unknown => {
		if (!obj(locator) || !onlyKeys(locator, kind === "issue" ? ["id", "partName", "line"] :
			["partName", "line"]) || !id(locator.partName) || !Number.isSafeInteger(locator.line) ||
			(locator.line as number) < 1 || !linesByPart.has(locator.partName) ||
			(locator.line as number) > linesByPart.get(locator.partName)!.length)
			fail("prior grounding locator is invalid");
		const key = `${locator.partName}:${locator.line}`;
		if (used.has(key)) fail("prior grounding locator is duplicated");
		used.add(key);
		let record: unknown;
		try { record = JSON.parse(linesByPart.get(locator.partName)![(locator.line as number) - 1]!); }
		catch { return fail("prior grounding part contains invalid JSON"); }
		if (!obj(record) || !onlyKeys(record, ["kind", "value"]) || record.kind !== kind)
			fail("prior grounding part record is invalid");
		return record.value;
	};
	for (let n = 0; n < index.legacyLocators.length; n++)
		if (!isDeepStrictEqual(recordAt(index.legacyLocators[n], "legacy-detail"), expected.legacyOpenDetails[n]))
			fail("prior grounding legacy detail changed");
	const locators: Record<string, GroundingSpan> = {};
	for (let n = 0; n < index.issueLocators.length; n++) {
		const locator = index.issueLocators[n];
		const prior = expected.previousIssues![n]!;
		if (!obj(locator) || locator.id !== prior.id ||
			!isDeepStrictEqual(recordAt(locator, "issue"), prior))
			fail("prior grounding issue changed");
		locators[prior.id] = { sourceId: locator.partName as string,
			startLine: locator.line as number, endLine: locator.line as number };
	}
	if ([...linesByPart].some(([name, lines]) => lines.some((_, n) => !used.has(`${name}:${n + 1}`))))
		fail("prior grounding part has unindexed records");
	return locators;
}

const id = (value: unknown): value is string => typeof value === "string" &&
	/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(value);
const prose = (value: unknown): value is string => typeof value === "string" &&
	value.trim().length > 0 && !value.includes("\0");
const obj = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
function fail(message: string): never { throw new Error(`assessor-grounding: ${message}`); }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function span(value: unknown, sources: GroundingContext["sources"]): GroundingSpan {
	if (!obj(value) || !onlyKeys(value, ["sourceId", "startLine", "endLine"]) || !id(value.sourceId) ||
		!Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine))
		fail("invalid source span");
	const source = sources[value.sourceId];
	if (!source || !Number.isSafeInteger(source.lineCount) || source.lineCount < 1 ||
		(value.startLine as number) < 1 || (value.endLine as number) < (value.startLine as number) ||
		(value.endLine as number) > source.lineCount) fail("span is outside a registered frozen source");
	return value as unknown as GroundingSpan;
}

function spans(value: unknown, sources: GroundingContext["sources"]): GroundingSpan[] {
	if (!Array.isArray(value) || !value.length) fail("source references are required");
	const refs = value.map(item => span(item, sources));
	if (new Set(refs.map(item => `${item.sourceId}:${item.startLine}:${item.endLine}`)).size !== refs.length)
		fail("duplicate source reference");
	return refs;
}

function ids(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(id) || new Set(value).size !== value.length)
		fail("invalid or duplicate issue IDs");
	return value;
}

/** Validates a proposal's traceability and shape only, never the truth of cited text. */
export function validateGroundedAssessment(value: unknown, context: GroundingContext): GroundedAssessmentProposal {
	if (!obj(value) || !onlyKeys(value, ["version", "kind", "contractId", "missionStatus", "issues",
		"legacyOpenDetails", "nextTask", "deliverableReady"]) ||
		value.version !== 1 || value.kind !== "grounded-assessment-proposal" ||
		value.contractId !== context.contractId || value.missionStatus !== "open" ||
		!Array.isArray(value.issues) || !Array.isArray(value.legacyOpenDetails) ||
		JSON.stringify(value.legacyOpenDetails) !== JSON.stringify(context.legacyOpenDetails))
		fail("proposal changed the contract, mission status, or unresolved legacy details");
	const issueIds = new Set<string>();
	const openIssueIds = new Set<string>();
	const priorIssues = new Map((context.previousIssues ?? []).map(item => [item.id, item]));
	for (const issue of value.issues) {
		if (!obj(issue) || !onlyKeys(issue, ["id", "claim", "status", "classification", "sourceRefs", "implication",
			"claimAtRisk", "optionalBasis", "capabilityRef", "blockedScope", "resolution"]) ||
			!id(issue.id) || issueIds.has(issue.id) || !prose(issue.claim) ||
			!prose(issue.implication) || !["open", "resolved"].includes(String(issue.status)))
			fail("invalid grounded issue");
		issueIds.add(issue.id);
		const prior = priorIssues.get(issue.id);
		if (prior) {
			const priorBase = { ...prior, status: undefined, resolution: undefined };
			const currentBase = { ...issue, status: undefined, resolution: undefined };
			if (!isDeepStrictEqual(priorBase, currentBase) ||
				prior.status === "resolved" && !isDeepStrictEqual(prior, issue) ||
				prior.status === "open" && issue.status === "open" && !isDeepStrictEqual(prior, issue))
				fail("proposal changed an authenticated prior issue");
		}
		if (issue.status === "open") {
			if (issue.resolution !== undefined) fail("open issue cannot carry a resolution");
			openIssueIds.add(issue.id);
		} else {
			if (!obj(issue.resolution) || !onlyKeys(issue.resolution, ["explanation", "evidenceRefs"]) ||
				!prose(issue.resolution.explanation)) fail("resolved issue needs an evidence-backed explanation");
			if (!prior || prior.status === "open") {
				const resolutionRefs = spans(issue.resolution.evidenceRefs, context.sources);
				if (!resolutionRefs.some(ref => ["selected-evidence", "host-capability"].includes(context.sources[ref.sourceId]!.kind)))
					fail("resolution needs a selected result or host observation");
			}
		}
		if (prior) continue; // The prior record was already authenticated; only a new resolution needs new proof.
		const refs = spans(issue.sourceRefs, context.sources);
		switch (issue.classification) {
			case "explicit-requirement":
				if (!refs.some(ref => ["user-instruction", "supplied-task"].includes(context.sources[ref.sourceId]!.kind)))
					fail("explicit requirement needs an instruction or task source");
				break;
			case "necessary-verification":
				if (!prose(issue.claimAtRisk)) fail("necessary verification needs a claim at risk");
				break;
			case "optional-method":
				if (!prose(issue.optionalBasis) || !refs.some(ref =>
					["user-instruction", "supplied-task"].includes(context.sources[ref.sourceId]!.kind)))
					fail("optional method needs a sourced optionality basis");
				break;
			case "physical-capability-gap": {
				if (!prose(issue.blockedScope) || !issue.capabilityRef ||
					!context.capabilities[issue.blockedScope] || context.capabilities[issue.blockedScope]!.available)
					fail("physical gap needs an unavailable registered capability");
				const ref = span(issue.capabilityRef, context.sources);
				if (context.sources[ref.sourceId]!.kind !== "host-capability")
					fail("physical gap needs a host-capability source");
				break;
			}
			default: fail("unknown issue classification");
		}
	}
	if ((context.previousIssueIds ?? []).some(item => !issueIds.has(item)))
		fail("proposal dropped a previously grounded issue");
	for (const prior of context.previousIssues ?? []) {
		const current = value.issues.find(item => item.id === prior.id);
		if (!current || current.claim !== prior.claim)
			fail("proposal changed a previous issue ID or claim");
		if (prior.status === "open" && current.status === "resolved" &&
			!current.resolution?.evidenceRefs.some((ref: GroundingSpan) =>
				(context.newEvidenceSourceIds ?? []).includes(ref.sourceId)))
			fail("newly resolved issue needs new frozen evidence");
	}
	if (value.nextTask !== undefined) {
		const task = value.nextTask;
		if (!obj(task) || !onlyKeys(task, ["obligationIds", "addresses", "adapterScope", "decisionChangingHypothesis",
			"expectedEvidence", "sourceRefs"]) ||
			!prose(task.decisionChangingHypothesis) || !prose(task.expectedEvidence) ||
			!id(task.adapterScope) || !context.capabilities[task.adapterScope]?.available)
			fail("next task needs a feasible scope and decision-changing hypothesis");
		if (!ids(task.obligationIds).length) fail("next task needs original obligation IDs");
		const addresses = ids(task.addresses);
		if (!addresses.length || addresses.some(item => !openIssueIds.has(item)))
			fail("next task must address an open grounded issue");
		spans(task.sourceRefs, context.sources);
	}
	if (value.deliverableReady !== undefined) {
		const finding = value.deliverableReady;
		if (!obj(finding) || !onlyKeys(finding, ["status", "ready", "rationale", "evidenceRefs",
			"remainingIssueIds"]) || finding.status !== "proposed" || typeof finding.ready !== "boolean" ||
			!prose(finding.rationale)) fail("deliverable readiness is only a proposed finding");
		spans(finding.evidenceRefs, context.sources);
		const remaining = ids(finding.remainingIssueIds);
		if (remaining.length !== openIssueIds.size || remaining.some(item => !openIssueIds.has(item)))
			fail("deliverable finding must disclose every open issue");
	}
	return value as unknown as GroundedAssessmentProposal;
}

/** Host merge: omissions retain old records; only cited resolutions change them. */
export function mergeGroundedAssessmentDelta(value: unknown, context: GroundingContext):
	{ proposal: GroundedAssessmentProposal; delta: GroundedAssessmentDelta } {
	if (!obj(value) || !onlyKeys(value, ["version", "kind", "newIssues", "resolutions", "nextTask",
		"deliverableReady"]) || value.version !== 1 || value.kind !== "grounded-assessment-delta" ||
		!Array.isArray(value.newIssues) || !Array.isArray(value.resolutions))
		fail("invalid grounded assessment delta");
	const previous = context.previousIssues ?? [];
	const priorIds = new Set(previous.map(item => item.id));
	const issues = previous.map(item => structuredClone(item));
	const resolutions = new Set<string>();
	for (const raw of value.resolutions) {
		if (!obj(raw) || !onlyKeys(raw, ["id", "priorRef", "explanation", "evidenceRefs"]) ||
			!id(raw.id) || resolutions.has(raw.id) || !prose(raw.explanation))
			fail("invalid prior issue resolution");
		resolutions.add(raw.id);
		const prior = issues.find(item => item.id === raw.id);
		const locator = context.priorIssueLocators?.[raw.id];
		const priorRef = span(raw.priorRef, context.sources);
		if (!prior || prior.status !== "open" || !locator || !isDeepStrictEqual(locator, priorRef))
			fail("resolution lacks its authenticated prior issue locator");
		const evidenceRefs = spans(raw.evidenceRefs, context.sources);
		if (!evidenceRefs.some(ref => (context.newEvidenceSourceIds ?? []).includes(ref.sourceId)))
			fail("newly resolved issue needs new frozen evidence");
		prior.status = "resolved";
		prior.resolution = { explanation: raw.explanation, evidenceRefs };
	}
	for (const raw of value.newIssues) {
		if (!obj(raw) || !id(raw.id) || priorIds.has(raw.id) ||
			issues.some(item => item.id === raw.id)) fail("new issue reused an old ID");
		issues.push(raw as unknown as GroundedIssue);
	}
	const proposal = validateGroundedAssessment({ version: 1, kind: "grounded-assessment-proposal",
		contractId: context.contractId, missionStatus: "open", issues,
		legacyOpenDetails: [...context.legacyOpenDetails],
		...(value.nextTask === undefined ? {} : { nextTask: value.nextTask }),
		...(value.deliverableReady === undefined ? {} : { deliverableReady: value.deliverableReady }) }, context);
	return { proposal, delta: value as unknown as GroundedAssessmentDelta };
}
