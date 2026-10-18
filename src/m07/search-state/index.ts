/** Append-only search state: the event log, the state it rebuilds, and cross-run warm start. */
export { openSearchEventLog, readSearchEvents, type SearchEventKind, type SearchEventLog,
	type SearchEventLogOptions, type SearchEventInput, type SearchEventV1, type SearchEventReadV1,
	type SearchCandidateFactsV1 } from "./events.ts";
export { rebuildSearchState, searchCandidate, candidateAncestors, candidateSiblings, candidateChildren,
	bestCandidates, searchStateSummary, type SearchStateV1, type SearchCandidateNodeV1,
	type SearchTaskNodeV1, type SearchBestOptions } from "./store.ts";
export { collectWarmStartLeads, describeWarmStartLeads, type WarmStartLeadV1, type WarmStartQueryV1,
	type WarmStartResultV1 } from "./warm-start.ts";
