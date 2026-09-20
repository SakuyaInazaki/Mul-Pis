/**
 * Shared types for the research harness.
 *
 * The harness carries the user's research workflow v1.0 (see workflow/v1.0/)
 * with the current alignment recorded in docs/research/workflow-foundation.md.
 * Nothing here decides models: every role's model comes from the workspace
 * configuration, and the harness refuses to run a stage whose role is unset.
 */

/** Roles that a stage session can take. One role can be served by any configured model. */
export type Role = "execution" | "reviewer" | "research" | "reader" | "checker" | "applicability" | "acquisition";

export const ROLES: readonly Role[] = ["execution", "reviewer", "research", "reader", "checker", "applicability", "acquisition"];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A model reference written as `provider/model` or `provider/model:thinking`. */
export interface ModelSpec {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	/** The original string, kept for logs and run records. */
	raw: string;
}

/**
 * Workspace configuration (`research.config.json`).
 *
 * `roles` maps each role to a model string. `default` is an explicit user-chosen
 * fallback for roles that are not listed. There is no built-in default.
 */
export interface HarnessConfig {
	roles: Partial<Record<Role | "default", string>>;
	/** Maximum number of M06 material groups processed at the same time. Engineering default 1. */
	concurrency: number;
	/** External tool endpoints for M05. Absent entries disable the corresponding provider. */
	tools: ToolsConfig;
}

export interface ToolsConfig {
	/** Brave Search API key for general-web search (optional; the keyless providers work without it). */
	braveApiKey?: string;
	/** Restrict search providers by name (openalex, arxiv, hackernews, stackexchange, github, duckduckgo, brave; reddit is opt-in only). */
	searchProviders?: string[];
	/** Contact e-mail sent in the User-Agent to OpenAlex (polite pool). Optional. */
	openAlexMailto?: string;
	/** Model for browser-use interactive fetches (provider/model). Unset means the interactive fallback is unavailable. */
	browserUseModel?: string;
	/** Python venv directory with Crawl4AI and browser-use installed. Default: <repo>/.venv */
	pythonVenv?: string;
	/** DPI for PDF page images rendered for multimodal reading (pdftoppm). Default 110. */
	pageImageDpi?: number;
}

export interface InputRef {
	label: string;
	path: string;
}

export interface OutputRef {
	label: string;
	path: string;
}

export type RunStatus = "running" | "completed" | "failed";

/**
 * Behaviour record of one stage run. It is the machine-readable companion of the
 * `.agent/notes/` entry and answers: what was read, what was done, what was produced.
 */
export interface StageRunRecord {
	stage: string;
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: RunStatus;
	inputs: InputRef[];
	sessions: Array<{ label: string; role: Role; id: string; file?: string; model: string }>;
	outputs: OutputRef[];
	failures: string[];
	/** Knowledge snapshot id that was current when the run started, if any. */
	knowledgeSnapshot?: string;
	/** Free-form remarks that belong in the behaviour record, never scientific conclusions. */
	remarks: string[];
}

export class HarnessError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HarnessError";
		this.code = code;
	}
}
