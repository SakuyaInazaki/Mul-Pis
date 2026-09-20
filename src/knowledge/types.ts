/**
 * Knowledge management types.
 *
 * Source of the rules: workflow/v1.0 完整手册 第七章 (图式认识管理 v1.0).
 * Seven record types, one authoritative store per project, one serial merge entry,
 * three separated states (evidence status / historical usage decision / derived
 * availability), deactivation-first publishing, no hashes anywhere.
 */

export type RecordType = "C" | "K" | "E" | "J" | "Q" | "D" | "X";

export const RECORD_TYPES: readonly RecordType[] = ["C", "K", "E", "J", "Q", "D", "X"];

/** Relations carry their meaning; they are never collapsed into one generic arrow. */
export type RelType =
	| "premise_of" // C/E is a premise or evidence input of J
	| "supports" // J supports C/K
	| "refutes" // J refutes C/K
	| "limits" // J limits C/K to conditions
	| "questions" // Q targets C/K/E/J
	| "checks" // K checks a claim or result
	| "handles" // D handles Q
	| "replaces" // new version/record replaces old
	| "splits" // record was split from
	| "applies_in" // record applies in context X
	| "located_in"; // E is located in source S or artifact

export interface Ref {
	rel: RelType;
	/** `C001` or `C001@2`. A bare id means "whatever version is current when read"; a pinned one never moves. */
	target: string;
	/** For `premise_of`: the role the input plays in the argument. */
	inputRole?: "condition" | "local_assumption" | "temporary_assumption" | "definition" | "data" | "adopted_result";
	note?: string;
}

/** Historical usage decision. Bound to context, purpose and version; never a truth label. */
export type UsageDecision = "candidate" | "working_assumption" | "adopted" | "suspended" | "withdrawn" | "replaced";

/** Reason a Q was closed. Closing never certifies the target. */
export type QCloseReason = "answered" | "not_valid" | "duplicate" | "out_of_scope" | "shelved";

export interface KnowledgeRecord {
	id: string; // e.g. C001
	type: RecordType;
	version: number; // starts at 1; substantive revisions create a new version
	title: string;
	/** Markdown body: the actual statement, criterion, evidence excerpt, argument, question, decision or context. */
	body: string;
	/** Type-specific structured fields (e.g. K: object/premise/method/meaning; E: source/version/location/scope). */
	fields: Record<string, unknown>;
	refs: Ref[];
	/** Evidence status as free text chosen from the workflow's vocabulary (题设/工作假设/原文陈述/本轮推导/数值检查/独立复算/形式检查/未覆盖). */
	evidenceStatus?: string;
	usageDecision?: UsageDecision;
	/** Contexts (X ids) the record applies in. Empty means the project's default context. */
	scope: string[];
	/** For Q: open until closed; closing reason kept. */
	qStatus?: { open: boolean; closeReason?: QCloseReason; closedBy?: string };
	createdAt: string;
	/** Who produced it: stage, run and (optionally) session label. Never a model's hidden thoughts. */
	source: { stage: string; runId: string; session?: string };
	/** `id@version` this version supersedes, if any. */
	supersedes?: string;
	/** Why this version exists (revision reason). */
	reason?: string;
}

/** A published limit. Written before the full merge and never removed by rollback or replay. */
export interface Limit {
	target: string; // id (all versions) or id@version
	kind: "suspended" | "withdrawn" | "needs_recheck";
	reason: string;
	/** What authorised the limit: evidence reference, decision id or user instruction. */
	authority: string;
	since: string;
	/** Set when the limit is lifted; lifting requires a new reason. */
	liftedAt?: string;
	liftReason?: string;
}

export interface Snapshot {
	id: string; // G001, G002 ...
	createdAt: string;
	/** Latest version of every record at publish time. */
	records: Array<{ id: string; version: number }>;
	/** Active limits at publish time (informational; limits.json stays authoritative). */
	activeLimits: string[];
	/** Proposal ids merged into this snapshot. */
	proposals: string[];
	note?: string;
}

/** Operations a stage may propose. Structure is validated; science is not. */
export type ProposalOp =
	| {
			op: "create";
			type: RecordType;
			title: string;
			body: string;
			fields?: Record<string, unknown>;
			refs?: Ref[];
			evidenceStatus?: string;
			usageDecision?: UsageDecision;
			scope?: string[];
			reason?: string;
			/** Client-side handle so later ops in the same batch can reference this record before its id exists, e.g. `$1`. */
			handle?: string;
	  }
	| {
			op: "revise";
			id: string;
			title?: string;
			body?: string;
			fields?: Record<string, unknown>;
			refs?: Ref[];
			evidenceStatus?: string;
			scope?: string[];
			reason: string;
	  }
	| {
			op: "decide";
			id: string;
			usageDecision: UsageDecision;
			reason: string;
			/** Context/purpose the decision is bound to. */
			context?: string;
	  }
	| {
			op: "limit";
			target: string;
			kind: Limit["kind"];
			reason: string;
			authority: string;
	  }
	| {
			op: "lift_limit";
			target: string;
			reason: string;
			authority: string;
	  }
	| {
			op: "close_q";
			id: string;
			closeReason: QCloseReason;
			reason: string;
	  };

export interface ProposalBatch {
	id?: string; // assigned on submit
	stage: string;
	runId: string;
	session?: string;
	/** Snapshot id the proposer worked against, if any. Used for the merge-time recheck. */
	baseSnapshot?: string;
	ops: ProposalOp[];
	/** Free-text summary written by the proposer (what changed and why). */
	summary?: string;
	createdAt?: string;
}

export interface ValidationIssue {
	level: "error" | "warning";
	message: string;
	opIndex?: number;
}

export interface ProposalReceipt {
	proposalId: string;
	file: string;
	issues: ValidationIssue[];
	/** True when there are no `error` issues. */
	structurallyValid: boolean;
}

export interface ImpactItem {
	/** Record that depends on something changed by the merge. */
	id: string;
	version: number;
	via: string; // e.g. "premise_of J003@1"
	/** Always "needs_recheck": impact propagates a check requirement, never falsity. */
	mark: "needs_recheck";
}

export interface MergeResult {
	proposalId: string;
	snapshot: Snapshot;
	applied: Array<{ opIndex: number; result: string }>;
	impacts: ImpactItem[];
	/** Limits that were persisted before the rest of the merge (deactivation-first). */
	limitsWrittenFirst: string[];
	warnings: string[];
}

/** Derived availability of a record for a given task. Never stored; computed on read. */
export type Availability = "usable_conditionally" | "exploratory_only" | "needs_recheck" | "not_allowed" | "unrecorded";

export interface AvailabilityReport {
	id: string;
	version: number;
	availability: Availability;
	reasons: string[];
}

export interface PackQuery {
	/** Explicit ids to include (bare or pinned). */
	ids?: string[];
	/** Include records whose title/body match any of these terms (case-insensitive). */
	terms?: string[];
	/** Include all open Q. Default true. */
	includeOpenQuestions?: boolean;
	/** Include records of these types when no ids/terms are given. */
	types?: RecordType[];
	/** Upper bound on characters of the rendered pack; truncation is marked, never silent. */
	maxChars?: number;
	/** Purpose string recorded in the pack header. */
	purpose: string;
}

export interface KnowledgePack {
	snapshot?: string;
	purpose: string;
	/** Rendered Markdown handed to a session. Includes availability and limits per record. */
	markdown: string;
	included: Array<{ id: string; version: number; availability: Availability }>;
	/** Ids that matched but were left out because of `maxChars`. */
	omitted: string[];
	truncated: boolean;
}

export interface ListFilter {
	type?: RecordType;
	openOnly?: boolean; // Q only
}

export interface KnowledgeStore {
	/** Create the layout if missing. Never overwrites existing records. */
	init(): Promise<void>;
	current(): Promise<Snapshot | undefined>;
	get(id: string, version?: number): Promise<KnowledgeRecord | undefined>;
	/** Latest version of each record, optionally filtered. */
	list(filter?: ListFilter): Promise<KnowledgeRecord[]>;
	limits(): Promise<Limit[]>;
	availability(id: string, version?: number): Promise<AvailabilityReport>;
	/** Persist a proposal under `proposals/` and validate its structure. Never changes records. */
	submitProposal(batch: ProposalBatch): Promise<ProposalReceipt>;
	/**
	 * Serial merge entry. Re-validates the proposal against the *current* state, writes limits first,
	 * applies ops, computes impacts (needs_recheck on dependents), publishes a snapshot and moves CURRENT.
	 * Rejects (leaving the previous CURRENT intact) when any op is structurally invalid on the current state.
	 */
	merge(proposalId: string): Promise<MergeResult>;
	buildPack(query: PackQuery): Promise<KnowledgePack>;
	/** Regenerate derived views under `views/` and `_index/` from records. */
	regenerateViews(): Promise<void>;
}
