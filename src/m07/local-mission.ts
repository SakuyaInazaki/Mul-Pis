/** Workspace-local original-objective entry point. GitHub transport is an optional
 * host adapter; this path binds the existing assessor and M07/M04 stages to a
 * private, durable filesystem host without choosing a scientific conclusion. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import { LocalMissionHost } from "../runner/local-mission-host.ts";
import type { SessionRunner } from "../runner/types.ts";
import type { HarnessConfig } from "../types.ts";
import type { StageContext } from "../stages/context.ts";
import { Workspace } from "../workspace.ts";
import { createLocalM07Adapters, LOCAL_M07_MISSION_BINDING_PREFIX } from "./local-m07-adapter.ts";
import { freezeLocalMaterialBundle, readLocalMaterialBundle,
	type LocalMaterialSelection } from "./local-material-bundle.ts";
import { createLocalOriginalObjectiveCaller, type LocalObjectiveFrozenEvidence,
	type LocalObjectiveHostPort, type LocalObjectiveRequestV1 } from "./local-original-objective.ts";
import type { ObjectiveProgressV1, OriginalObjectiveContractV1 } from "./objective-progress.ts";
export type { LocalObjectiveRequestV1 } from "./local-original-objective.ts";

const checkpointBytes = (progress: ObjectiveProgressV1): Buffer =>
	Buffer.from(`${JSON.stringify(progress, null, 2)}\n`, "utf8");
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const attemptNumber = (id: string): number => Number(id.slice(1));

async function safeText(file: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024)
			throw new Error("local mission input is not a bounded regular file");
		const bytes = await handle.readFile();
		if (bytes.length !== before.size) throw new Error("local mission input changed during freeze");
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} finally { await handle.close(); }
}

async function saveFrozen(file: string, text: string): Promise<void> {
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(text); await handle.sync(); }
	finally { await handle.close(); }
	const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await directory.sync(); } finally { await directory.close(); }
}

async function ensureFrozen(file: string, text: string): Promise<void> {
	try { await saveFrozen(file, text); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await safeText(file) !== text)
			throw error;
	}
}

function textParts(text: string): string[] {
	const parts: string[] = [];
	let current = "", bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (current && bytes + size > 900_000) { parts.push(current); current = ""; bytes = 0; }
		current += character; bytes += size;
	}
	parts.push(current);
	return parts;
}

async function parseProgress(bytes: Buffer | undefined, missionId: string): Promise<ObjectiveProgressV1 | undefined> {
	if (!bytes) return undefined;
	const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ObjectiveProgressV1;
	if (value?.version !== 1 || value.kind !== "original-objective-progress" ||
		value.contract?.id !== missionId || !Array.isArray(value.boundedRuns) ||
		!Array.isArray(value.assessmentHistory) || !Array.isArray(value.selectedArtifacts) ||
		!Array.isArray(value.continuation?.unresolvedOperationIds))
		throw new Error("local mission checkpoint schema or identity is invalid");
	return value;
}

export function openDefaultLocalMission(input: { workspaceRoot: string;
	runner?: SessionRunner; config?: HarnessConfig }) {
	const ws = new Workspace(input.workspaceRoot);
	const rootFor = (missionId: string) => path.join(ws.agentDir, "missions", missionId);
	const context: StageContext | undefined = input.runner && input.config ?
		{ ws, runner: input.runner, config: input.config,
			store: createFileKnowledgeStore(ws.knowledgeDir) } : undefined;
	const hostFor = (missionId: string): LocalObjectiveHostPort => {
		const root = rootFor(missionId);
		let active: LocalMissionHost | undefined;
		const writable = async (): Promise<LocalMissionHost> => {
			if (active) return active;
			const current = await LocalMissionHost.status(root).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			const source = current?.currentAttempt;
			const nextId = source ? `A${String(attemptNumber(source.attemptId) + 1).padStart(3, "0")}` : "A001";
			// The host authenticates same-process reuse and checks a dead predecessor before
			// admitting any new attempt. A failed probe leaves prior effects UNKNOWN.
			try { active = await LocalMissionHost.begin({ root, missionId,
				attemptId: source?.attemptId ?? "A001", codeRevision: "local-harness-v1" }); }
			catch (error) {
				if (!source || !/attempt identity changed/.test(String(error))) throw error;
				active = await LocalMissionHost.begin({ root, missionId,
					attemptId: nextId, codeRevision: "local-harness-v1" });
			}
			return active;
		};
		const contractFile = path.join(root, "evidence", "original-objective.json");
		const stageBoundedEvidence = async (progress: ObjectiveProgressV1): Promise<Record<string, string[]>> => {
			const evidenceDir = path.join(root, "evidence");
			const mapped: Record<string, string[]> = {};
			for (const [index, bounded] of progress.boundedRuns.entries()) {
				const goalPath = path.join(ws.runDir("M07", bounded.runId), "goal.json");
				const goal = JSON.parse(await safeText(goalPath)) as { problemRelation?: string;
					checkpoints?: Array<{ id: string; feedbackPath: string; feedbackStatus: string }> };
				if (goal.problemRelation !== `${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n${progress.contract.goal}`)
					throw new Error("local mission bounded M07 run lacks exact mission binding");
				const checkpoint = goal.checkpoints?.at(-1);
				let feedback: string;
				let controlOnly = false;
				if (checkpoint && ["complete", "indexed"].includes(checkpoint.feedbackStatus) &&
					checkpoint.feedbackPath === path.join(ws.runDir("M07", bounded.runId), "checkpoints",
						checkpoint.id, "m04-feedback.md")) feedback = await safeText(checkpoint.feedbackPath);
				else if (bounded.outcome === "unknown" &&
					progress.continuation.unresolvedOperationIds.some(id =>
						id === bounded.runId || id.startsWith(`${bounded.runId}/`))) {
					controlOnly = true;
					// A failed task may have no report. This host control witness preserves
					// the negative outcome without inventing scientific evidence.
					const control = goal as { lifecycle?: string; tasks?: Array<{ taskId: string; status: string }>;
						executionState?: { operations?: Array<{ id: string; status: string }> } };
					feedback = `${JSON.stringify({ version: 1, kind: "local-m07-incomplete-control",
						runId: bounded.runId, outcome: bounded.outcome, lifecycle: control.lifecycle,
						tasks: (control.tasks ?? []).map(task => ({ taskId: task.taskId, status: task.status })),
						operations: (control.executionState?.operations ?? []).map(operation =>
							({ id: operation.id, status: operation.status })) }, null, 2)}\n`;
				} else throw new Error("local mission bounded M07 feedback is incomplete");
				const names: string[] = [];
				for (const [partIndex, part] of textParts(feedback).entries()) {
					const name = `prior-run-${index + 1}-${controlOnly ? "control" : "feedback"}-${partIndex + 1}.txt`;
					await ensureFrozen(path.join(evidenceDir, name), part);
					names.push(name);
				}
				mapped[bounded.runId] = names;
			}
			return mapped;
		};
		const unrepresentedM07 = async (progress: ObjectiveProgressV1): Promise<string[]> => {
			const runIds = await ws.listRuns("M07");
			const missing: string[] = [];
			for (const runId of runIds) {
				const goal = JSON.parse(await safeText(path.join(ws.runDir("M07", runId), "goal.json"))) as
					{ problemRelation?: string };
				if (goal.problemRelation?.startsWith(`${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n`) &&
					!progress.boundedRuns.some(item => item.runId === runId)) missing.push(runId);
			}
			return missing;
		};
		return {
			async currentUnknownOperationIds() {
				return [...(await LocalMissionHost.status(root)).unresolvedOperationIds];
			},
			currentUnrepresentedM07RunIds: unrepresentedM07,
			async createContract(contract: OriginalObjectiveContractV1,
				request: { materials?: readonly LocalMaterialSelection[] }) {
				const problem = await ws.readProblem();
				const raw = request.materials ? undefined : await ws.readRawInfo();
				if (raw?.skipped.length)
					throw new Error("local mission has original binary inputs that require an explicit supported evidence conversion before starting");
				const host = await writable();
				const serialized = `${JSON.stringify(contract, null, 2)}\n`;
				const evidenceDir = path.join(root, "evidence");
				await mkdir(evidenceDir, { mode: 0o700 });
				await saveFrozen(contractFile, serialized);
				await saveFrozen(path.join(evidenceDir, "original-problem.txt"), await safeText(problem.path));
				for (const [index, item] of (raw?.items ?? []).entries())
					await saveFrozen(path.join(evidenceDir, `original-input-${index + 1}.txt`), await safeText(item.path));
				const inputFiles = ["original-problem.txt",
					...(raw?.items ?? []).map((_, index) => `original-input-${index + 1}.txt`)];
				const frozenInputs = await Promise.all(inputFiles.map(async name => {
					const bytes = await readFile(path.join(evidenceDir, name));
					return { name, bytes: bytes.length, sha256: sha256(bytes) };
				}));
				const material = request.materials ? await freezeLocalMaterialBundle({
					root: path.join(root, "materials"), baseDir: ws.root,
					selections: request.materials }) : undefined;
				const materialManifestSha256 = material ?
					sha256(await readFile(material.manifestFile)) : undefined;
				// The original contract gains durable host authority only after all
				// workspace inputs are frozen. Partial preliminary copies remain orphans.
				await host.recordInitialContract({ attemptId: host.source.attemptId,
					bytes: Buffer.from(`${JSON.stringify({ ...contract, frozenInputs,
						...(materialManifestSha256 ? { materialManifestSha256 } : {}) }, null, 2)}\n`, "utf8") });
				return { contractFile,
					...(material ? { materialBundleRoot: path.join(root, "materials") } : {}) };
			},
			async readCheckpoint() {
				return parseProgress(await LocalMissionHost.readLatestCheckpoint(root), missionId);
			},
			async recordCheckpoint(progress: ObjectiveProgressV1) {
				if (progress.contract.id !== missionId) throw new Error("local mission checkpoint belongs to another mission");
				// Evidence is copied before this control checkpoint becomes the latest
				// committed state. A crash cannot seal a run whose feedback vanished.
				await stageBoundedEvidence(progress);
				const host = await writable();
				const latest = (await host.status()).latestCheckpoint;
				await host.recordCheckpoint({ attemptId: host.source.attemptId,
					sequence: (latest?.sequence ?? 0) + 1,
					previousSha256: latest?.sha256 ?? null, bytes: checkpointBytes(progress) });
			},
			async freeze({ contract, progress, iteration }: { contract: OriginalObjectiveContractV1;
				progress: ObjectiveProgressV1; iteration: number }): Promise<LocalObjectiveFrozenEvidence> {
				const stored = await LocalMissionHost.readInitialContract(root);
				const storedValue = stored ? JSON.parse(stored.toString("utf8")) as
					OriginalObjectiveContractV1 & { frozenInputs?: Array<{ name: string; bytes: number;
						sha256: string }>; materialManifestSha256?: string } : undefined;
				if (!storedValue || JSON.stringify(Object.fromEntries(Object.entries(storedValue)
					.filter(([key]) => key !== "frozenInputs" && key !== "materialManifestSha256"))) !==
					JSON.stringify(contract) ||
					await safeText(contractFile) !== `${JSON.stringify(contract, null, 2)}\n`)
					throw new Error("local mission original contract differs from committed host evidence");
				const evidenceDir = path.join(root, "evidence");
				const names = (await readdir(evidenceDir)).filter(name =>
					name === "original-problem.txt" || /^original-input-[1-9][0-9]*\.txt$/.test(name)).sort();
				const original = names.map(name => ({ name, file: path.join(evidenceDir, name) }));
				if (!names.includes("original-problem.txt") ||
					(!storedValue.materialManifestSha256 && names.length !== contract.inputNames.length) ||
					(storedValue.materialManifestSha256 && names.length !== 1) ||
					!Array.isArray(storedValue.frozenInputs) ||
					JSON.stringify(storedValue.frozenInputs.map(item => item.name).sort()) !==
						JSON.stringify([...names].sort()))
					throw new Error("local mission frozen original input set is incomplete");
				for (const item of original) {
					const text = await safeText(item.file);
					const bytes = Buffer.from(text, "utf8");
					const expected = storedValue.frozenInputs.find(row => row.name === item.name);
					if (!expected || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
						throw new Error("local mission original input differs from committed host evidence");
				}
				const materialNames = new Map<string, "host-control" | "supplied-task" |
					"unselected-evidence">();
				if (storedValue.materialManifestSha256) {
					const materialRoot = path.join(root, "materials");
					const manifestBytes = await readFile(path.join(materialRoot, "manifest.json"));
					if (sha256(manifestBytes) !== storedValue.materialManifestSha256)
						throw new Error("local mission material manifest differs from committed host evidence");
					const manifest = await readLocalMaterialBundle(materialRoot);
					for (const [index, relative] of manifest.indexFiles.entries()) {
						const name = `material-index-${index + 1}.md`;
						original.push({ name, file: path.join(materialRoot, relative) });
						materialNames.set(name, "host-control");
					}
					for (const item of manifest.items) if (item.text)
						for (const [index, part] of item.parts.entries()) {
							const name = `${item.id}-part-${index + 1}.txt`;
							original.push({ name, file: path.join(materialRoot, part.file) });
							materialNames.set(name, item.sourceIdentity.startsWith("declared:") ?
								"supplied-task" : "unselected-evidence");
						}
				}
				const status = await LocalMissionHost.status(root);
				if (status.repairRequired || status.writerLockPresent)
					throw new Error("local mission host has an unresolved durable-write repair; assessor was not started");
				// A new CLI/Pi process must prove the prior attempt is dead before any
				// read-only assessor can reserve another provider request.
				await writable();
				const boundedRunEvidence = await stageBoundedEvidence(progress);
				for (const names of Object.values(boundedRunEvidence))
					for (const name of names) original.push({ name, file: path.join(evidenceDir, name) });
				const unrepresentedM07RunIds = await unrepresentedM07(progress);
				for (const runId of await ws.listRuns("MISSION")) {
					const run = await ws.readRun("MISSION", runId);
					if (run.status === "running" && run.inputs.some(item => item.path === contractFile))
						unrepresentedM07RunIds.push(`MISSION:${runId}`);
				}
				const capabilityFile = path.join(evidenceDir, `host-capability-${iteration}.txt`);
				const hasModel = (role: "research" | "execution") =>
					Boolean(context?.config.roles[role] ?? context?.config.roles.default);
				const capabilities = [
					{ scope: "local-m07-reason", available: hasModel("research") && hasModel("execution"),
						description: "Local M07 read-only reasoning with M04 review", limits: ["A returned report is unselected evidence"] },
					{ scope: "local-m07-execute", available: hasModel("research") && hasModel("execution") &&
						context?.config.localMission?.execution === "task-root-bash",
						description: "Opt-in trusted local M07 execution with task-root Pi read/write/edit/bash tools",
						limits: ["Bash is not an OS sandbox and can access same-user files outside the task root; keep unrelated secrets outside this worker environment", "External effects require authorization and host reconciliation"] },
				];
				if (await lstat(capabilityFile).catch(() => undefined) === undefined)
					await saveFrozen(capabilityFile, `${JSON.stringify(capabilities)}\n`);
				else if (await safeText(capabilityFile) !== `${JSON.stringify(capabilities)}\n`)
					throw new Error("local mission capability evidence changed");
				original.push({ name: path.basename(capabilityFile), file: capabilityFile });
				const sourceKinds = Object.fromEntries(original.map(item => [item.name,
					item.name === path.basename(capabilityFile) ? "host-capability" :
					materialNames.get(item.name) ?? (item.name.startsWith("prior-run-") ?
						item.name.includes("-control-") ? "host-control" : "unselected-evidence" :
						"supplied-task")])) as
					NonNullable<LocalObjectiveFrozenEvidence["groundingPolicy"]>["sourceKinds"];
				const unknown = [...new Set([...status.unresolvedOperationIds,
					...progress.continuation.unresolvedOperationIds])].sort();
				const assessmentsDir = path.join(root, "assessments");
				await mkdir(assessmentsDir, { mode: 0o700, recursive: true });
				return { contractFile, evidenceRoot: path.join(assessmentsDir,
					`attempt-${iteration}-${randomUUID()}`), evidence: original,
					capabilities, selectedArtifacts: [...progress.selectedArtifacts],
					availableArtifacts: [...progress.availableArtifacts], unresolvedOperationIds: unknown,
					groundingPolicy: { require: true, sourceKinds,
						legacyOpenDetails: [...progress.continuation.unresolvedDetails],
						previousIssues: progress.assessment?.groundedAssessment?.issues ?? [] },
					boundedRunEvidence, unrepresentedM07RunIds,
					evidenceAccess: Object.fromEntries(Object.values(boundedRunEvidence).flat()
						.map(name => [name, "retrievable" as const])),
					evidenceRequirements: { requiredNames: original.filter(item =>
						item.name.startsWith("original-") || materialNames.has(item.name)).map(item => item.name),
						instructions: "Read every selected frozen text projection and its coverage index. A binary original remains frozen but is not read by text extraction; check its explicit gap before any claim. Historical reports are unselected until reviewed." } };
			},
		};
	};
	const caller = createLocalOriginalObjectiveCaller({ ws, hostFor, ctx: context,
		adapters: createLocalM07Adapters() });
	return caller;
}
