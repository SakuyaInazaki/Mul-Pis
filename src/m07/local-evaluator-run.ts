import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectiveCapabilityV1, OriginalObjectiveContractV1 } from "./objective-progress.ts";
import { mediaType } from "../media.ts";
import type { CurrentGoal, M07TaskRecord, TaskReviewInput } from "./types.ts";
import { resolveExpectedOutputFiles } from "./expected-output.ts";
import { trustedLocalMissionEvaluator, type LocalCandidateSnapshot,
	validEvaluatorSchemaErrors, validatedTaskInputContract,
	type LocalEvaluatorCheck, type LocalMissionEvaluator } from "./local-mission-evaluator.ts";
import type { LocalFrozenOriginalIdentity } from "./local-mission-evaluator.ts";
import { HarnessError } from "../types.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
const RECEIPT = "local-evaluator-receipt.json";
const observationName = /^observation-[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:txt|md|json|jsonl|csv|tsv)$/;

export interface LocalEvaluatorObservation {
	name: string; kind: "text" | "json";
	sourceFile: string; file: string; bytes: number; sha256: string;
	binding: { missionId: string; runId: string; taskId: string;
		evaluatorId: string; evaluatorVersion: string;
		candidate: Array<{ name: string; sha256: string }> };
}

export interface LocalEvaluatorReceiptV1 {
	version: 1; kind: "local-evaluator-receipt";
	missionId: string; runId: string; taskId: string;
	evaluator: { id: string; version: string };
	candidate: LocalCandidateSnapshot[];
	observations: LocalEvaluatorObservation[];
	frozenEvidence: Array<{ name: string; file: string; bytes: number; sha256: string }>;
	checks: LocalEvaluatorCheck[];
	limitations: string[];
}

async function exactDirectory(root: string, expected: readonly string[]): Promise<void> {
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
		await realpath(root) !== root)
		throw new HarnessError("local.evaluator.observation", "evaluator observation directory is not host-owned");
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) ||
		JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify([...expected].sort()))
		throw new HarnessError("local.evaluator.observation", "evaluator observation members are missing or extra");
}

function observationText(bytes: Buffer, kind: "text" | "json"): void {
	const value = bytes.toString("utf8");
	if (!Buffer.from(value, "utf8").equals(bytes) || value.includes("\0"))
		throw new HarnessError("local.evaluator.observation", "observation is not valid UTF-8 text");
	if (kind === "json") {
		try { JSON.parse(value); }
		catch { throw new HarnessError("local.evaluator.observation", "declared JSON observation is invalid"); }
	}
}

async function boundedFile(file: string, root?: string): Promise<Buffer> {
	const info = await lstat(file);
	const resolved = await realpath(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 ||
		info.size > 8 * 1024 * 1024 || (root && !inside(root, resolved)))
		throw new HarnessError("local.evaluator.file", "candidate or evidence is not a bounded regular file");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
			before.size !== after.size) throw new HarnessError("local.evaluator.file", "candidate or evidence changed during read");
		return bytes;
	} finally { await handle.close(); }
}

export async function requireLocalEvaluator(contract: OriginalObjectiveContractV1,
	id: string | undefined, facts: { frozenOriginalInputs: readonly LocalFrozenOriginalIdentity[];
		capabilities: readonly ObjectiveCapabilityV1[] }): Promise<LocalMissionEvaluator> {
	const evaluator = trustedLocalMissionEvaluator(id);
	if (!evaluator) throw new HarnessError("local.evaluator.capability",
		id ? `trusted evaluator ${id} is not registered` : "local objective needs a configured trusted host evaluator");
	const supported = new Set(evaluator.supportedObligationTypes);
	if (contract.obligations.some(item => !supported.has(item.type ?? "general")))
		throw new HarnessError("local.evaluator.capability", `trusted evaluator ${id} does not support every obligation type`);
	const preflight = await evaluator.preflight({ contract,
		frozenOriginalInputs: facts.frozenOriginalInputs,
		capabilities: facts.capabilities });
	if (!preflight.available) throw new HarnessError("local.evaluator.capability",
		preflight.reason || `trusted evaluator ${id} preflight declined this objective`);
	return evaluator;
}

export async function verifyLocalEvaluatorReceipt(receipt: LocalEvaluatorReceiptV1,
	contract: OriginalObjectiveContractV1, goal: CurrentGoal, task: M07TaskRecord): Promise<void> {
	if (receipt.version !== 1 || receipt.kind !== "local-evaluator-receipt" ||
		receipt.missionId !== contract.id || receipt.runId !== goal.runId ||
		receipt.taskId !== task.taskId || !receipt.candidate.length ||
		!Array.isArray(receipt.observations) ||
		new Set(receipt.observations.map(item => item.name)).size !== receipt.observations.length ||
		receipt.observations.some(item => !observationName.test(item.name) ||
			!["text", "json"].includes(item.kind) ||
			(item.kind === "json" && !item.name.endsWith(".json")) ||
			mediaType(item.name) !== "text") ||
		new Set([...receipt.candidate.map(item => item.name),
			...receipt.frozenEvidence.map(item => item.name),
			...receipt.observations.map(item => item.name)]).size !==
			receipt.candidate.length + receipt.frozenEvidence.length + receipt.observations.length ||
		receipt.checks.length !== contract.obligations.length ||
		new Set(receipt.checks.map(item => item.obligationId)).size !== receipt.checks.length ||
		new Set(receipt.candidate.map(item => item.name)).size !== receipt.candidate.length ||
		receipt.checks.some(item => !contract.obligations.some(ob => ob.id === item.obligationId) ||
			!["passed", "failed", "not_run", "unknown"].includes(item.result) ||
			!Array.isArray(item.evidenceRefs) || !Array.isArray(item.limitations) ||
			(item.schemaErrors !== undefined && (!validEvaluatorSchemaErrors(item.schemaErrors) ||
				item.schemaErrors.some(error => item.result === "passed"))) ||
			item.evidenceRefs.some(ref => !receipt.candidate.some(candidate => candidate.name === ref) &&
				!receipt.frozenEvidence.some(file => file.name === ref) &&
				!receipt.observations.some(file => file.name === ref)) ||
			(item.result === "passed" && !item.evidenceRefs.length)))
		throw new HarnessError("local.evaluator.receipt", "evaluator receipt has mismatched mission, task or checks");
	const taskRoot = await realpath(path.dirname(task.workDir));
	const outputDir = path.join(taskRoot, "host-evaluator-output");
	const snapshotDir = path.join(taskRoot, "host-evaluator-snapshot");
	await exactDirectory(outputDir, receipt.observations.map(item => item.name));
	await exactDirectory(snapshotDir, receipt.observations.map(item => item.name));
	for (const file of receipt.candidate) {
		const source = await boundedFile(file.sourceFile, taskRoot);
		const snapshot = await boundedFile(file.file);
		if (source.length !== file.bytes || snapshot.length !== file.bytes ||
			digest(source) !== file.sha256 || digest(snapshot) !== file.sha256)
			throw new HarnessError("local.evaluator.bytes", "candidate bytes changed after evaluation");
	}
	for (const file of receipt.frozenEvidence) {
		const bytes = await boundedFile(file.file);
		if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
			throw new HarnessError("local.evaluator.bytes", "frozen evaluation evidence changed");
	}
	const binding = { missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluatorId: receipt.evaluator.id, evaluatorVersion: receipt.evaluator.version,
		candidate: receipt.candidate.map(item => ({ name: item.name, sha256: item.sha256 })) };
	for (const item of receipt.observations) {
		if (item.sourceFile !== path.join(outputDir, item.name) ||
			item.file !== path.join(snapshotDir, item.name) ||
			JSON.stringify(item.binding) !== JSON.stringify(binding))
			throw new HarnessError("local.evaluator.observation", "observation binding or path differs from trusted task");
		if (((await lstat(item.sourceFile)).mode & 0o077) !== 0 ||
			((await lstat(item.file)).mode & 0o077) !== 0)
			throw new HarnessError("local.evaluator.observation", "observation file is not private");
		const source = await boundedFile(item.sourceFile, outputDir);
		const snapshot = await boundedFile(item.file, snapshotDir);
		if (source.length !== item.bytes || snapshot.length !== item.bytes ||
			digest(source) !== item.sha256 || digest(snapshot) !== item.sha256)
			throw new HarnessError("local.evaluator.observation", "observation bytes changed after evaluation");
		observationText(source, item.kind);
	}
}

export async function evaluateLocalM07Task(input: { contract: OriginalObjectiveContractV1;
	goal: CurrentGoal; task: M07TaskRecord; evidence: readonly { name: string; file: string }[];
	evaluatorId: string | undefined; frozenOriginalInputs: readonly LocalFrozenOriginalIdentity[];
	capabilities: readonly ObjectiveCapabilityV1[] }): Promise<{ receipt: LocalEvaluatorReceiptV1;
	receiptFile: string; review: TaskReviewInput }> {
	const { contract, goal, task } = input;
	const evaluator = await requireLocalEvaluator(contract, input.evaluatorId, input);
	const taskRoot = await realpath(path.dirname(task.workDir));
	const observationOutputDir = path.join(taskRoot, "host-evaluator-output");
	const observationSnapshotDir = path.join(taskRoot, "host-evaluator-snapshot");
	const resolved = await resolveExpectedOutputFiles(task.workDir, task.expectedOutputPaths);
	const outputFiles = resolved.flatMap(item => item.error ? [] : item.files);
	const sources = [...new Set([task.reportPath, ...outputFiles].filter((file): file is string => !!file))];
	if (!sources.length) throw new HarnessError("local.evaluator.candidate", "returned task has no candidate files");
	const snapshotDir = path.join(path.dirname(task.workDir), "evaluator-snapshot");
	await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
	const candidate: LocalCandidateSnapshot[] = [];
	for (const [index, sourceFile] of sources.entries()) {
		const bytes = await boundedFile(sourceFile, taskRoot);
		const name = `candidate-${String(index + 1).padStart(3, "0")}${path.extname(sourceFile) || ".bin"}`;
		const file = path.join(snapshotDir, name);
		await writeFile(file, bytes, { flag: "wx", mode: 0o400 });
		await chmod(file, 0o400);
		candidate.push({ name, file, sourceFile, bytes: bytes.length, sha256: digest(bytes) });
	}
	const frozenEvidence = await Promise.all(input.evidence.map(async item => {
		const bytes = await boundedFile(item.file);
		return { ...item, bytes: bytes.length, sha256: digest(bytes) };
	}));
	if (new Set([...candidate.map(file => file.name), ...frozenEvidence.map(file => file.name)]).size !==
		candidate.length + frozenEvidence.length)
		throw new HarnessError("local.evaluator.evidence", "candidate and frozen evidence names collide");
	await mkdir(observationOutputDir, { mode: 0o700 });
	await mkdir(observationSnapshotDir, { mode: 0o700 });
	const result = await evaluator.evaluate({ contract, missionId: contract.id, runId: goal.runId,
		taskId: task.taskId, candidate, frozenEvidence, observationOutputDir });
	const taskContract = validatedTaskInputContract(evaluator.taskInputContract);
	const contractedPaths = new Set(taskContract?.artifacts.map(item => item.path) ?? []);
	if (!Array.isArray(result.checks) || result.checks.some(item => item.schemaErrors !== undefined &&
		(!validEvaluatorSchemaErrors(item.schemaErrors) || item.result === "passed" ||
			!taskContract || item.schemaErrors.some((error: { artifact: string }) =>
				!contractedPaths.has(error.artifact)))))
		throw new HarnessError("local.evaluator.receipt", "evaluator returned invalid schema-error feedback");
	if (!Array.isArray(result.observations) || result.observations.some(item =>
		!item || typeof item.name !== "string" || !observationName.test(item.name) ||
		!["text", "json"].includes(item.kind) ||
		(item.kind === "json" && !item.name.endsWith(".json")) ||
		mediaType(item.name) !== "text") ||
		new Set([...candidate.map(item => item.name), ...frozenEvidence.map(item => item.name),
			...result.observations.map(item => item.name)]).size !==
			candidate.length + frozenEvidence.length + result.observations.length)
		throw new HarnessError("local.evaluator.observation", "evaluator declared invalid observation members");
	await exactDirectory(observationOutputDir, result.observations.map(item => item.name));
	const binding = { missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluatorId: evaluator.id, evaluatorVersion: evaluator.version,
		candidate: candidate.map(item => ({ name: item.name, sha256: item.sha256 })) };
	const observations: LocalEvaluatorObservation[] = [];
	for (const item of result.observations) {
		const sourceFile = path.join(observationOutputDir, item.name);
		if (((await lstat(sourceFile)).mode & 0o077) !== 0)
			throw new HarnessError("local.evaluator.observation", "evaluator output file is not private");
		const bytes = await boundedFile(sourceFile, observationOutputDir);
		observationText(bytes, item.kind);
		const file = path.join(observationSnapshotDir, item.name);
		await writeFile(file, bytes, { flag: "wx", mode: 0o400 });
		await chmod(file, 0o400);
		observations.push({ name: item.name, kind: item.kind, sourceFile, file,
			bytes: bytes.length, sha256: digest(bytes), binding });
	}
	const receipt: LocalEvaluatorReceiptV1 = { version: 1, kind: "local-evaluator-receipt",
		missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluator: { id: evaluator.id, version: evaluator.version }, candidate, observations,
		frozenEvidence, checks: result.checks.map(item => ({ obligationId: item.obligationId,
			result: item.result, evidenceRefs: [...item.evidenceRefs],
			limitations: [...item.limitations],
			...(item.schemaErrors ? { schemaErrors: item.schemaErrors.map((error: {
				artifact: string; path: string; message: string }) => ({ ...error })) } : {}) })),
		limitations: [...result.limitations] };
	await verifyLocalEvaluatorReceipt(receipt, contract, goal, task);
	const frozenCopies = new Map<string, string>();
	for (const name of new Set(receipt.checks.flatMap(item => item.evidenceRefs))) {
		const evidence = frozenEvidence.find(item => item.name === name);
		if (!evidence) continue;
		const source = await realpath(evidence.file);
		const copy = task.inputCopies.find(item => item.source === source);
		if (!copy || digest(await boundedFile(copy.copy, taskRoot)) !== evidence.sha256)
			throw new HarnessError("local.evaluator.evidence", "evaluator evidence lacks the exact M07 task input copy");
		frozenCopies.set(name, copy.copy);
	}
	const receiptFile = path.join(task.workDir, RECEIPT);
	await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	const evidencePath = (ref: string): string => candidate.find(file => file.name === ref)?.sourceFile ??
		observations.find(file => file.name === ref)?.file ?? frozenCopies.get(ref)!;
	const checks = task.checks.map((criterion, index) => {
		const item = receipt.checks.find(check => contract.obligations.find(ob => ob.id === check.obligationId)?.description === criterion);
		if (!item) throw new HarnessError("local.evaluator.receipt", `no evaluator check for task criterion ${index + 1}`);
		return { criterion, result: item.result === "unknown" ? "not_run" as const : item.result,
				evidence: [receiptFile, ...item.evidenceRefs.map(evidencePath)] };
	});
	return { receipt, receiptFile,
		review: { taskId: task.taskId, artifacts: [receiptFile, ...sources,
			...observations.map(item => item.file), ...frozenCopies.values()], checks,
			failures: resolved.flatMap(item => item.error ? [item.error] : []),
			limitations: [...receipt.limitations, ...receipt.checks.flatMap(item => [
				...item.limitations, ...(item.schemaErrors ?? []).map(error =>
					`Schema error in ${error.artifact} at ${error.path}: ${error.message}`)])] } };
}

export async function readLocalEvaluatorReceipt(file: string): Promise<{ receipt: LocalEvaluatorReceiptV1; sha256: string }> {
	const bytes = await boundedFile(file);
	return { receipt: JSON.parse(bytes.toString("utf8")) as LocalEvaluatorReceiptV1,
		sha256: digest(bytes) };
}
