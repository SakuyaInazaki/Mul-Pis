/**
 * Private, offline reservation journal for a host that launches fresh mission
 * runs. In particular, a crash after markAttempted is an uncertain delivery,
 * even when no HTTP response was received. This module makes no connector calls.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { pendingActionIdentity, type ResumeIntent } from "./mission-supervisor.ts";
import { REUSABLE_RUN_REQUEST_MESSAGE } from "./ledger-continuation.ts";

const CONTROL_REF = "refs/heads/run-requests/workflow-learning-reliability";
const SOURCE_REF = "refs/heads/improve/workflow-learning-reliability";
const hex40 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const hex64 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const runId = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,17}$/.test(v);
const digest = (v: string): string => createHash("sha256").update(v).digest("hex");
const refuse = (why: string): never => { throw new Error(`mission resume journal refused: ${why}`); };

/** Only these fields may enter the public control request. The journal keeps
 * its relation to the private mission intent in a mode-0700 directory. */
export type TestedControlBinding = Readonly<{
	controlRef: typeof CONTROL_REF;
	message: typeof REUSABLE_RUN_REQUEST_MESSAGE;
	testedSourceCommit: string;
	testedTree: string;
	successfulCi: Readonly<{ workflow: string; runId: string; runAttempt: number;
		headCommit: string; conclusion: "success" }>;
	previousControlCommit: string | null;
	parents: readonly string[];
	expectedBefore: string | null;
	sourceRef: typeof SOURCE_REF;
	sourceRefTip: string;
}>;

export type ResumeJournalState = "reserved" | "ref-update-attempted" |
	"delivery-unknown" | "acknowledged" | "reconciled-not-delivered";
type ActionProvenance = Readonly<{ kind: "current-host-derived"; checkpointSha256: string }>;
export type ResumeJournalRecord = Readonly<{
	version: 1;
	idempotencyKey: string;
	intentBinding: Readonly<{ source: ResumeIntent["source"]; envelopeSha256: string;
		contractId: string; selectedTupleSha256: string; pendingActionSha256: string;
		actionKind: ResumeIntent["actionKind"]; actionProvenance?: ActionProvenance;
		workflowRepair?: ResumeIntent["workflowRepair"] }>;
	control: TestedControlBinding;
	state: ResumeJournalState;
	negativeReconciliations: number;
	successorRunId?: string;
	observedControlCommit?: string;
}>;

/** A read-only verifier external to this module must establish this exact
 * control commit and Actions run from the live source, then supply the facts. */
export type AcceptedControlObservation = Readonly<{
	kind: "read-only-accepted-control";
	controlRef: string; controlCommit: string; tree: string;
	parents: readonly string[]; message: string;
	successorRunId: string;
}>;

/** Only a separate read-only negative reconciliation can release an uncertain
 * attempt. It must cover the exact prior ref tip and the full run census. */
export type NotDeliveredObservation = Readonly<{
	kind: "read-only-not-delivered";
	controlRef: string; observedHead: string | null;
	matchingRunCount: 0; pendingDeliveryExcluded: true;
}>;

function canonical(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
		return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	return refuse("unsupported binding value");
}

function repairBinding(value: ResumeIntent["workflowRepair"]): ResumeIntent["workflowRepair"] {
	if (value === undefined) return undefined;
	if (!hex64(value?.reviewedPlanSha256) || !hex40(value.testedSourceCommit) || !hex40(value.testedTree) ||
		value.successfulCi?.workflow !== "workflow-regression.yml" || !runId(value.successfulCi.runId) ||
		value.successfulCi.runAttempt !== 1 || value.successfulCi.headCommit !== value.testedSourceCommit ||
		value.successfulCi.conclusion !== "success") refuse("invalid workflow repair binding");
	return { reviewedPlanSha256: value.reviewedPlanSha256, testedSourceCommit: value.testedSourceCommit,
		testedTree: value.testedTree, successfulCi: { workflow: value.successfulCi.workflow,
			runId: value.successfulCi.runId, runAttempt: value.successfulCi.runAttempt,
			headCommit: value.successfulCi.headCommit, conclusion: "success" } };
}

function intentBinding(intent: ResumeIntent): ResumeJournalRecord["intentBinding"] {
	const suppliedProvenance = (intent as ResumeIntent & {
		actionProvenance?: ActionProvenance }).actionProvenance;
	if (suppliedProvenance !== undefined &&
		(suppliedProvenance?.kind !== "current-host-derived" ||
			!hex64(suppliedProvenance.checkpointSha256)))
		refuse("invalid action provenance");
	const actionProvenance = suppliedProvenance ? { kind: "current-host-derived" as const,
		checkpointSha256: suppliedProvenance.checkpointSha256 } : undefined;
	const workflowRepair = repairBinding(intent.workflowRepair);
	if (intent?.version !== 1 || intent.kind !== "fresh-independent-mission-resume" ||
		!runId(intent.source?.runId) || !Number.isSafeInteger(intent.source.runAttempt) ||
		intent.source.runAttempt < 1 || !hex40(intent.source.commit) ||
		!hex64(intent.idempotencyKey) || !hex64(intent.envelopeSha256) ||
		!hex64(intent.selectedTupleSha256) || !hex64(intent.pendingActionSha256) ||
		!intent.contractId || intent.boundary !== "new-isolated-workspace-no-prior-session-resume" ||
		pendingActionIdentity(intent.pendingAction) !== intent.pendingActionSha256 ||
		intent.pendingAction.kind !== intent.actionKind ||
		(intent.actionKind === "repair-workflow-state") !== Boolean(workflowRepair))
		refuse("invalid or changed private intent");
	const source = { runId: intent.source.runId, runAttempt: intent.source.runAttempt,
		commit: intent.source.commit };
	const expected = digest(canonical({ ...(actionProvenance ? { actionProvenance } : {}),
		source,
		envelopeSha256: intent.envelopeSha256, contractId: intent.contractId,
		selectedTupleSha256: intent.selectedTupleSha256,
		pendingActionSha256: intent.pendingActionSha256,
		...(workflowRepair ? { workflowRepair } : {}) }));
	if (expected !== intent.idempotencyKey) refuse("idempotency key does not bind the intent");
	return { source, envelopeSha256: intent.envelopeSha256,
		contractId: intent.contractId, selectedTupleSha256: intent.selectedTupleSha256,
		pendingActionSha256: intent.pendingActionSha256, actionKind: intent.actionKind,
		...(actionProvenance ? { actionProvenance } : {}),
		...(workflowRepair ? { workflowRepair } : {}) };
}

function controlBinding(input: TestedControlBinding): TestedControlBinding {
	if (input?.controlRef !== CONTROL_REF || input.message !== REUSABLE_RUN_REQUEST_MESSAGE ||
		input.sourceRef !== SOURCE_REF || !hex40(input.testedSourceCommit) ||
		!hex40(input.testedTree) || input.sourceRefTip !== input.testedSourceCommit ||
		(input.previousControlCommit !== null && !hex40(input.previousControlCommit)) ||
		input.expectedBefore !== input.previousControlCommit ||
		!Array.isArray(input.parents) ||
		canonical(input.parents) !== canonical(input.previousControlCommit === null ||
			input.previousControlCommit === input.testedSourceCommit ?
			[input.testedSourceCommit] : [input.testedSourceCommit, input.previousControlCommit]) ||
		!input.successfulCi || !runId(input.successfulCi.runId) ||
		!Number.isSafeInteger(input.successfulCi.runAttempt) || input.successfulCi.runAttempt < 1 ||
		input.successfulCi.conclusion !== "success" ||
		input.successfulCi.workflow !== "workflow-regression.yml" ||
		input.successfulCi.headCommit !== input.testedSourceCommit)
		refuse("control descriptor does not bind a tested empty-tree request");
	return { controlRef: CONTROL_REF, message: REUSABLE_RUN_REQUEST_MESSAGE,
		testedSourceCommit: input.testedSourceCommit, testedTree: input.testedTree,
		successfulCi: { workflow: input.successfulCi.workflow, runId: input.successfulCi.runId,
			runAttempt: input.successfulCi.runAttempt,
			headCommit: input.successfulCi.headCommit, conclusion: "success" },
		previousControlCommit: input.previousControlCommit,
		parents: [...input.parents], expectedBefore: input.expectedBefore,
		sourceRef: SOURCE_REF, sourceRefTip: input.sourceRefTip };
}

async function syncDir(dir: string): Promise<void> {
	const handle = await open(dir, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
	const dir = path.dirname(file);
	const temp = path.join(dir, `.tmp-${randomUUID()}`);
	const handle = await open(temp, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
	finally { await handle.close(); }
	try { await rename(temp, file); await syncDir(dir); }
	finally { await rm(temp, { force: true }); }
}

async function privateDirectory(dir: string): Promise<void> {
	if (!path.isAbsolute(dir)) refuse("private directory must be absolute");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const meta = await lstat(dir);
	if (!meta.isDirectory() || (meta.mode & 0o077) !== 0)
		refuse("private directory must be a non-symlink mode-0700 directory");
}

async function readRecord(file: string): Promise<ResumeJournalRecord> {
	const info = await lstat(file);
	if (!info.isFile() || (info.mode & 0o077) !== 0) refuse("record permissions are unsafe");
	const value = JSON.parse(await readFile(file, "utf8")) as ResumeJournalRecord;
	if (value?.version !== 1 || !hex64(value.idempotencyKey) ||
		path.basename(file) !== `${value.idempotencyKey}.json` ||
		!["reserved", "ref-update-attempted", "delivery-unknown", "acknowledged",
			"reconciled-not-delivered"].includes(value.state) || !value.intentBinding || !value.control ||
		!Number.isSafeInteger(value.negativeReconciliations) || value.negativeReconciliations < 0)
		refuse("stored record is invalid");
	if (canonical(controlBinding(value.control)) !== canonical(value.control))
		refuse("stored control descriptor has unexpected fields");
	const bound = value.intentBinding;
	const workflowRepair = repairBinding(bound.workflowRepair);
	if (workflowRepair && (workflowRepair.testedSourceCommit !== value.control.testedSourceCommit ||
		workflowRepair.testedTree !== value.control.testedTree ||
		canonical(workflowRepair.successfulCi) !== canonical(value.control.successfulCi)))
		refuse("stored workflow repair does not bind the tested control source");
	if (!runId(bound.source?.runId) || !Number.isSafeInteger(bound.source.runAttempt) ||
		bound.source.runAttempt < 1 || !hex40(bound.source.commit) ||
		!hex64(bound.envelopeSha256) || !hex64(bound.selectedTupleSha256) ||
		!hex64(bound.pendingActionSha256) || typeof bound.contractId !== "string" ||
		!bound.contractId || typeof bound.actionKind !== "string" || !bound.actionKind ||
		(bound.actionKind === "repair-workflow-state") !== Boolean(workflowRepair) ||
		(workflowRepair !== undefined && canonical(workflowRepair) !== canonical(bound.workflowRepair)) ||
		(bound.actionProvenance !== undefined &&
			(bound.actionProvenance?.kind !== "current-host-derived" ||
				!hex64(bound.actionProvenance?.checkpointSha256))))
		refuse("stored private intent binding is invalid");
	const expected = digest(canonical({ ...(bound.actionProvenance ?
		{ actionProvenance: bound.actionProvenance } : {}), source: bound.source,
		envelopeSha256: bound.envelopeSha256, contractId: bound.contractId,
		selectedTupleSha256: bound.selectedTupleSha256,
		pendingActionSha256: bound.pendingActionSha256,
		...(workflowRepair ? { workflowRepair } : {}) }));
	if (expected !== value.idempotencyKey) refuse("stored idempotency binding changed");
	if (value.state === "acknowledged" ?
		!runId(value.successorRunId) || !hex40(value.observedControlCommit) ||
		value.observedControlCommit === value.control.expectedBefore :
		value.successorRunId !== undefined || value.observedControlCommit !== undefined)
		refuse("stored acknowledgment is invalid");
	return value;
}

/** Process-local writes are serialized by an exclusive directory lock. A dead
 * owner is identified by Linux boot ID and process birth time before recovery. */
export class MissionResumeJournal {
	readonly directory: string;
	constructor(directory: string) { this.directory = directory; }
	private file(key: string): string {
		if (!hex64(key)) refuse("invalid idempotency key");
		return path.join(this.directory, `${key}.json`);
	}
	private async owner(): Promise<{ host: string; pid: number; boot: string; start: string }> {
		const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const body = await readFile(`/proc/${process.pid}/stat`, "utf8");
		return { host: hostname(), pid: process.pid, boot,
			start: body.slice(body.lastIndexOf(") ") + 2).split(" ")[19] };
	}
	private async ownerAlive(owner: { host: string; pid: number; boot: string; start: string }): Promise<boolean> {
		if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.boot || !owner.start ||
			!owner.host)
			refuse("lock owner identity is invalid");
		if (owner.host !== hostname()) refuse("lock belongs to a different host");
		if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== owner.boot)
			return false;
		try {
			const body = await readFile(`/proc/${owner.pid}/stat`, "utf8");
			return body.slice(body.lastIndexOf(") ") + 2).split(" ")[19] === owner.start;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	private async lock<T>(work: () => Promise<T>): Promise<T> {
		await privateDirectory(this.directory);
		const lock = path.join(this.directory, ".lock");
		for (;;) {
			const candidate = path.join(this.directory, `.lock-candidate-${randomUUID()}`);
			await mkdir(candidate, { mode: 0o700 });
			await atomicJson(path.join(candidate, "owner.json"), await this.owner());
			await syncDir(candidate);
			try { await rename(candidate, lock); }
			catch (error) {
				await rm(candidate, { recursive: true, force: true });
				if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				// Another process owns the lock. Inspect that owner below.
				let owner: { host: string; pid: number; boot: string; start: string };
				try { owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					await new Promise(resolve => setTimeout(resolve, 20)); continue;
				}
				if (!(await this.ownerAlive(owner))) {
					const recovery = path.join(this.directory, ".lock-recovery");
					try { await mkdir(recovery, { mode: 0o700 }); }
					catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						await new Promise(resolve => setTimeout(resolve, 20)); continue;
					}
					try {
						const current = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
						if (canonical(current) === canonical(owner) && !(await this.ownerAlive(current))) {
							await rm(lock, { recursive: true }); await syncDir(this.directory);
						}
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					} finally { await rm(recovery, { recursive: true }); }
				}
				await new Promise(resolve => setTimeout(resolve, 20));
				continue;
			}
			await syncDir(this.directory);
			try { return await work(); }
			finally { await rm(lock, { recursive: true }); await syncDir(this.directory); }
		}
	}
	private async records(): Promise<ResumeJournalRecord[]> {
		const names = await readdir(this.directory);
		return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
			.map(name => readRecord(path.join(this.directory, name))));
	}
	async get(key: string): Promise<ResumeJournalRecord | undefined> {
		return this.lock(async () => {
			try { return await readRecord(this.file(key)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		});
	}
	async unresolvedForRef(ref: string): Promise<ResumeJournalRecord | undefined> {
		return this.lock(async () => (await this.records()).find(record =>
			record.control.controlRef === ref && record.state !== "acknowledged" &&
			record.state !== "reconciled-not-delivered"));
	}
	async reserve(intent: ResumeIntent, binding: TestedControlBinding): Promise<ResumeJournalRecord> {
		const privateBinding = intentBinding(intent), control = controlBinding(binding);
		if (privateBinding.workflowRepair &&
			(privateBinding.workflowRepair.testedSourceCommit !== control.testedSourceCommit ||
				privateBinding.workflowRepair.testedTree !== control.testedTree ||
				canonical(privateBinding.workflowRepair.successfulCi) !== canonical(control.successfulCi)))
			refuse("workflow repair does not bind the tested control source");
		return this.lock(async () => {
			const records = await this.records();
			const old = records.find(record => record.idempotencyKey === intent.idempotencyKey);
			if (old) {
				if (canonical(old.intentBinding) !== canonical(privateBinding) ||
					canonical(old.control) !== canonical(control)) refuse("same key has a different binding");
				return old;
			}
			if (records.some(record => record.control.controlRef === control.controlRef &&
				record.state !== "acknowledged" && record.state !== "reconciled-not-delivered"))
				refuse("control ref has an unresolved reservation");
			const acknowledged = records.filter(record => record.control.controlRef === control.controlRef &&
				record.state === "acknowledged");
			if (acknowledged.length) {
				const tips = acknowledged.filter(record => !acknowledged.some(next =>
					next.control.previousControlCommit === record.observedControlCommit));
				if (tips.length !== 1 || control.previousControlCommit !== tips[0]!.observedControlCommit)
					refuse("control ref does not continue the acknowledged tip");
			}
			const fresh: ResumeJournalRecord = { version: 1,
				idempotencyKey: intent.idempotencyKey, intentBinding: privateBinding,
				control, state: "reserved", negativeReconciliations: 0 };
			await atomicJson(this.file(intent.idempotencyKey), fresh);
			return fresh;
		});
	}
	private async transition(key: string, update: (old: ResumeJournalRecord) => ResumeJournalRecord): Promise<ResumeJournalRecord> {
		return this.lock(async () => {
			const old = await readRecord(this.file(key));
			const next = update(old);
			if (next !== old) await atomicJson(this.file(key), next);
			return next;
		});
	}
	/** Persist this before sending a ref update. A restarted adapter must treat
	 * this state as delivery-unknown, and must never invoke the update again. */
	markAttempted(key: string): Promise<ResumeJournalRecord> {
		return this.transition(key, old => old.state === "reserved" ?
			{ ...old, state: "ref-update-attempted" } :
			refuse("ref update cannot be reissued from this state"));
	}
	markDeliveryUnknown(key: string): Promise<ResumeJournalRecord> {
		return this.transition(key, old => old.state === "ref-update-attempted" ?
			{ ...old, state: "delivery-unknown" } : old.state === "delivery-unknown" ? old :
			refuse("unknown delivery requires an attempted ref update"));
	}
	/** The caller must independently verify the live control ref and run. */
	acknowledge(key: string, observed: AcceptedControlObservation): Promise<ResumeJournalRecord> {
		return this.transition(key, old => {
			if (old.state === "acknowledged") {
				if (old.successorRunId === observed.successorRunId &&
					old.observedControlCommit === observed.controlCommit) return old;
				return refuse("conflicting acknowledgment");
			}
			if (old.state !== "ref-update-attempted" && old.state !== "delivery-unknown")
				refuse("acknowledgment has no attempted ref update");
			if (observed.kind !== "read-only-accepted-control" ||
				observed.controlRef !== old.control.controlRef || !hex40(observed.controlCommit) ||
				observed.controlCommit === old.control.expectedBefore ||
				observed.tree !== old.control.testedTree ||
				canonical(observed.parents) !== canonical(old.control.parents) ||
				observed.message !== old.control.message || !runId(observed.successorRunId) ||
				observed.successorRunId === old.intentBinding.source.runId)
				refuse("read-only acknowledgment does not match the control request");
			return { ...old, state: "acknowledged", successorRunId: observed.successorRunId,
				observedControlCommit: observed.controlCommit };
		});
	}
	/** A negative read-only reconciliation can release an uncertain attempt.
	 * The host verifier must prove pending delivery is excluded. */
	reconcileNotDelivered(key: string, observed: NotDeliveredObservation): Promise<ResumeJournalRecord> {
		return this.transition(key, old => {
			if (old.state === "reconciled-not-delivered") return old;
			if (old.state === "acknowledged") refuse("an acknowledged request cannot be negated");
			if (observed.kind !== "read-only-not-delivered" ||
				observed.controlRef !== old.control.controlRef ||
				observed.observedHead !== old.control.expectedBefore ||
				observed.matchingRunCount !== 0 || observed.pendingDeliveryExcluded !== true)
				refuse("negative reconciliation does not exclude delivery");
			return { ...old, state: "reconciled-not-delivered",
				negativeReconciliations: old.negativeReconciliations + 1 };
		});
	}
	/** Re-arm only the exact original request after a durable negative read-only
	 * reconciliation. A different intent may have acquired the ref meanwhile. */
	async rearmAfterReconciliation(key: string): Promise<ResumeJournalRecord> {
		return this.lock(async () => {
			const old = await readRecord(this.file(key));
			if (old.state !== "reconciled-not-delivered" || old.negativeReconciliations < 1)
				refuse("request has no negative reconciliation");
			const records = await this.records();
			if (records.some(record => record.idempotencyKey !== key &&
				record.control.controlRef === old.control.controlRef &&
				record.state !== "acknowledged" && record.state !== "reconciled-not-delivered"))
				refuse("control ref has another unresolved reservation");
			const acknowledged = records.filter(record => record.control.controlRef === old.control.controlRef &&
				record.state === "acknowledged");
			if (acknowledged.length) {
				const tips = acknowledged.filter(record => !acknowledged.some(next =>
					next.control.previousControlCommit === record.observedControlCommit));
				if (tips.length !== 1 || tips[0]!.observedControlCommit !== old.control.previousControlCommit)
					refuse("control ref tip changed after reconciliation");
			}
			const next: ResumeJournalRecord = { ...old, state: "reserved" };
			await atomicJson(this.file(key), next);
			return next;
		});
	}
}
