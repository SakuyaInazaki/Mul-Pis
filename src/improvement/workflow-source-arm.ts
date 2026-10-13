/** One fixed-source, fresh-process execution of the existing v1 M07→M04 arm. */
import { fork } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SharedBudget } from "../experiments/budget.ts";
import type { BudgetLease } from "../experiments/contracts.ts";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import type { UsageSummary, SessionRunner } from "../runner/types.ts";
import { Workspace } from "../workspace.ts";
import type { WorkflowArmExecutionArgs } from "./workflow-adapter.ts";
import { validateWorkflowCaseV2, type WorkflowArmReceiptV1, type WorkflowCaseV2, type WorkflowOutcomeV2 } from "./workflow-types.ts";
import { evaluateWorkflowOutcomeV2, type WorkflowTrustedEvaluatorV2 } from "./workflow-result-evaluator.ts";

export interface WorkflowSourceArmInput extends Omit<WorkflowArmExecutionArgs,
 "source" | "runner" | "budget" | "lease" | "protectedInputs" | "beforePrompt" | "onSettled" | "onFailed"> {
 sourceWorkspaceRoot: string;
 protectedInputsRoot?: string;
}

export type WorkflowSourceArmReceipt = WorkflowArmReceiptV1 & { loadedSource: LoadedSourceV1; childPid: number };

export interface WorkflowSourceArmOptions {
 runnerKind: "pi" | "fake";
 budget: SharedBudget;
 lease: BudgetLease;
 beforePrompt: () => Promise<void>;
 /** Trusted offline test hook only. A plan or case never selects executable code. */
 fakeReplyModule?: string;
}

type ChildRequest = { type: "prompt-before" | "prompt-settled" | "prompt-failed" | "result" | "fatal"; id: number; turnId?: number; usage?: UsageSummary; receipt?: WorkflowSourceArmReceipt; error?: string };
type ParentReply = { type: "reply"; id: number; ok: boolean; error?: string };
type Init = { type: "init"; binding: LoadedSourceV1; args: WorkflowSourceArmInput; runnerKind: "pi" | "fake"; fakeReplyModule?: string };

const ownEntry = fileURLToPath(import.meta.url);
const sameBinding = (a: LoadedSourceV1 | undefined, b: LoadedSourceV1) =>
 !!a && a.sourceRoot === b.sourceRoot && a.sourceCommit === b.sourceCommit;

const FIRST_SOURCE_ALLOWLIST = new Set(["src/m07/feedback.ts"]);
const SOURCE_PARTS = ["src", "extensions", "workflow", "tools", "package.json"];

async function sourceFiles(root: string): Promise<Map<string, Buffer>> {
 const files = new Map<string, Buffer>();
 const visit = async (relative: string): Promise<void> => {
  const absolute = path.join(root, relative), info = await lstat(absolute);
  if (info.isSymbolicLink() || (info.mode & 0o222) !== 0) throw new Error("prepared source contains an indirect or writable code entry");
  if (info.isFile()) { files.set(relative, await readFile(absolute)); return; }
  if (!info.isDirectory()) throw new Error("prepared source contains a non-file entry");
  for (const name of await readdir(absolute)) await visit(path.join(relative, name));
 };
 for (const part of SOURCE_PARTS) await visit(part);
 return files;
}

/** Parent-owned verification. It does not import the candidate's verifier. */
export async function verifyPreparedWorkflowSource(binding: LoadedSourceV1): Promise<void> {
 if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.sourceCommit) || await realpath(binding.sourceRoot) !== binding.sourceRoot)
  throw new Error("prepared source has an invalid canonical binding");
 const receiptFile = path.join(binding.sourceRoot, ".workflow-source.json"), info = await lstat(receiptFile);
 if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0) throw new Error("prepared source receipt is not fixed");
 const receipt = JSON.parse(await readFile(receiptFile, "utf8")) as { version?: number; sourceRoot?: string; sourceCommit?: string };
 if (receipt.version !== 1 || !sameBinding(receipt as LoadedSourceV1, binding)) throw new Error("source arm prepared receipt differs from selected source");
 const root = await lstat(binding.sourceRoot);
 if (!root.isDirectory() || (root.mode & 0o222) !== 0) throw new Error("prepared source root is writable");
 await sourceFiles(binding.sourceRoot);
}

/** The first candidate may change only evidence handoff behavior; evaluator and runner stay fixed. */
export async function assertFirstWorkflowSourceAllowlist(baseline: LoadedSourceV1, candidate: LoadedSourceV1): Promise<void> {
 await verifyPreparedWorkflowSource(baseline); await verifyPreparedWorkflowSource(candidate);
 const before = await sourceFiles(baseline.sourceRoot), after = await sourceFiles(candidate.sourceRoot);
 for (const file of new Set([...before.keys(), ...after.keys()]))
  if (!before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) && !FIRST_SOURCE_ALLOWLIST.has(file))
   throw new Error(`candidate changed a fixed control or non-allowlisted source file: ${file}`);
}

/** The parent owns the provider-use ledger and all pre-prompt policy checks. */
export async function executeWorkflowSourceArm(binding: LoadedSourceV1, args: WorkflowSourceArmInput,
 options: WorkflowSourceArmOptions): Promise<WorkflowSourceArmReceipt> {
 if (options.runnerKind !== "pi" && options.runnerKind !== "fake") throw new Error("workflow source arm requires an explicit runner kind");
 if (options.runnerKind === "fake" && (!options.fakeReplyModule || !path.isAbsolute(options.fakeReplyModule)))
  throw new Error("offline fake source arm requires a trusted absolute reply module");
 if (options.runnerKind === "pi" && options.fakeReplyModule) throw new Error("Pi source arm cannot load a fake reply module");
 if (Object.hasOwn(args.caseInput, "evaluation") || Object.hasOwn(args.caseInput, "groundTruth")) throw new Error("private evaluator data cannot enter source arm IPC");
 await verifyPreparedWorkflowSource(binding);
 const sourceRoot = binding.sourceRoot;
 const entry = path.join(sourceRoot, "src/improvement/workflow-source-arm.ts");
 const env: NodeJS.ProcessEnv = { ...process.env, PRE_RSI_SOURCE_ROOT: sourceRoot, PRE_RSI_CODE_REVISION: binding.sourceCommit };
 for (const key of ["PRE_RSI_RECOVER_GOAL_RUN_ID", "PRE_RSI_CONTINUATION_GOAL_RUN_ID", "PRE_RSI_CONTINUATION_WORKSPACE", "PRE_RSI_RUN_DESCRIPTOR_FILE", "PRE_RSI_RUN_INSTANCE_ID", "PRE_RSI_CONTROL_STATE_FILE"])
  delete env[key];
 const child = fork(entry, [], { cwd: args.sourceWorkspaceRoot, env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
 let diagnostic = "";
 for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8_000); });
 const reservations = new Map<number, ReturnType<SharedBudget["reserveObservedTurn"]>>();
 const observedUsage: UsageSummary[] = [];
 let result: WorkflowSourceArmReceipt | undefined;
 let fatal: Error | undefined;
 let exited = false;
 const pendingMessages = new Set<Promise<void>>();
 const reply = (id: number, ok: boolean, error?: unknown) => {
  if (child.connected) child.send({ type: "reply", id, ok, ...(error ? { error: String((error as Error).message ?? error) } : {}) } satisfies ParentReply);
 };
 const markUnknown = () => {
  for (const reservation of reservations.values()) options.budget.markObservedTurnUnknown(reservation);
  reservations.clear();
 };
 const message = async (raw: unknown) => {
  const request = raw as ChildRequest;
  if (!request || typeof request !== "object" || !Number.isSafeInteger(request.id)) return;
  try {
   if (request.type === "prompt-before") {
    if (!Number.isSafeInteger(request.turnId) || reservations.has(request.turnId!)) throw new Error("invalid prompt reservation identity");
    await options.beforePrompt();
    if (exited) throw new Error("source arm exited before prompt reservation");
    if (options.budget.status(options.lease).inFlight) throw new Error("workflow source arm has an unsettled provider turn");
    reservations.set(request.turnId!, options.budget.reserveObservedTurn(options.lease));
    reply(request.id, true); return;
   }
   if (request.type === "prompt-settled" || request.type === "prompt-failed") {
    const reservation = reservations.get(request.turnId!);
    if (!reservation) throw new Error("source arm settled an unknown provider turn");
    const usage = request.usage;
    if (!usage || typeof usage !== "object" ||
     [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost].some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
     !Number.isSafeInteger(usage.reportedEvents) || usage.reportedEvents < 0 || !Number.isSafeInteger(usage.unknownEvents) || usage.unknownEvents < 0 ||
     typeof usage.complete !== "boolean" || typeof usage.costComplete !== "boolean" ||
     (request.type === "prompt-failed" && (usage.complete || usage.costComplete || usage.unknownEvents < 1)))
     throw new Error("source arm omitted or invalidated provider usage");
    options.budget.settleObservedTurn(reservation, usage);
    observedUsage.push(usage);
    reservations.delete(request.turnId!);
    reply(request.id, true); return;
   }
   if (request.type === "result") {
    if (reservations.size || !request.receipt || !sameBinding(request.receipt.loadedSource, binding) ||
     request.receipt.childPid !== child.pid || request.receipt.workspaceRoot !== args.root ||
     request.receipt.arm !== args.arm || request.receipt.caseId !== args.caseInput.id)
     throw new Error("source arm returned an unbound or incomplete receipt");
    const usage = request.receipt.usage;
    const calls = observedUsage.reduce((sum, item) => sum + item.reportedEvents, 0);
    const input = observedUsage.reduce((sum, item) => sum + item.input + item.cacheRead + item.cacheWrite, 0);
    const output = observedUsage.reduce((sum, item) => sum + item.output, 0);
    const cost = observedUsage.reduce((sum, item) => sum + item.cost, 0);
    if (usage.providerCalls !== calls || usage.inputTokens !== input || usage.outputTokens !== output || usage.sdkEstimatedCost !== cost ||
     (usage.complete && (observedUsage.length < 2 || observedUsage.some(item => !item.complete || item.reportedEvents < 1))) ||
     (usage.costComplete && observedUsage.some(item => !item.costComplete)) ||
     (request.receipt.status === "complete" && !usage.complete))
     throw new Error("source arm usage differs from parent-owned settlement");
    result = request.receipt;
    reply(request.id, true); return;
   }
   if (request.type === "fatal") { fatal = new Error(request.error ?? "source arm failed"); reply(request.id, true); return; }
   throw new Error("unknown workflow source arm message");
  } catch (error) {
   fatal = error as Error;
   reply(request.id, false, error);
  }
 };
 child.on("message", raw => {
  const pending = message(raw);
  pendingMessages.add(pending);
  void pending.finally(() => pendingMessages.delete(pending));
 });
 let exit: { code: number | null; signal: NodeJS.Signals | null };
 try {
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
   child.once("error", reject);
   child.once("exit", () => { exited = true; });
   child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.send({ type: "init", binding, args, runnerKind: options.runnerKind, ...(options.fakeReplyModule ? { fakeReplyModule: options.fakeReplyModule } : {}) } satisfies Init);
  exit = await exitPromise;
 } catch (error) {
  exited = true;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  throw error;
 } finally {
  await Promise.allSettled([...pendingMessages]);
  markUnknown();
 }
 if (fatal) throw fatal;
 if (exit.code !== 0 || exit.signal || !result) throw new Error(`workflow source arm process failed (${exit.code ?? exit.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
 return result;
}

/** V2 keeps G in this parent process, then checks real M07→M04 and knowledge artifacts. */
export async function executeWorkflowSourceArmV2(binding: LoadedSourceV1, args: Omit<WorkflowSourceArmInput, "caseInput"> & { caseInput: WorkflowCaseV2 },
 options: WorkflowSourceArmOptions & { evaluator: WorkflowTrustedEvaluatorV2; baselineSource?: LoadedSourceV1 }): Promise<{ receipt: WorkflowSourceArmReceipt; outcome: WorkflowOutcomeV2 }> {
 const checked = validateWorkflowCaseV2(args.caseInput);
 if (args.arm === "candidate") {
  if (!options.baselineSource) throw new Error("v2 candidate requires the fixed baseline source for allowlist verification");
  await assertFirstWorkflowSourceAllowlist(options.baselineSource, binding);
 }
 const receipt = await executeWorkflowSourceArm(binding, { ...args, caseInput: checked.visible }, options);
 const outcome = await evaluateWorkflowOutcomeV2(checked, receipt, options.evaluator, args.bundle.knowledgeSnapshot);
 return { receipt, outcome };
}

async function childMain(): Promise<void> {
 if (!process.send) throw new Error("workflow source arm requires a parent IPC channel");
 let nextId = 0, turnId = 0;
 const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
 const onDisconnect = () => {
  for (const pending of waiting.values()) pending.reject(new Error("source arm parent IPC disconnected"));
  waiting.clear();
  process.exit(1); // A parentless arm must not continue making model requests.
 };
 process.once("disconnect", onDisconnect);
 const rpc = (request: Omit<ChildRequest, "id">): Promise<void> => new Promise((resolve, reject) => {
  const id = ++nextId;
  waiting.set(id, { resolve, reject });
  process.send!({ ...request, id } satisfies ChildRequest);
 });
 process.on("message", raw => {
  const message = raw as ParentReply | Init;
  if (message?.type === "reply") {
   const pending = waiting.get(message.id); if (!pending) return;
   waiting.delete(message.id);
   if (message.ok) pending.resolve(); else pending.reject(new Error(message.error ?? "parent rejected workflow source arm request"));
  }
 });
 const init = await new Promise<Init>(resolve => {
  const receive = (raw: unknown) => {
   const message = raw as Init;
   if (message?.type === "init") { process.off("message", receive); resolve(message); }
  };
  process.on("message", receive);
 });
 try {
  const { verifyLoadedSource } = await import("../runtime/loaded-source.ts");
  const loadedSource = await verifyLoadedSource(import.meta.url, init.binding.sourceRoot, init.binding.sourceCommit);
  if (!sameBinding(loadedSource, init.binding)) throw new Error("child loaded a different workflow source");
  if (!loadedSource) throw new Error("child source binding is missing");
  let runner: SessionRunner;
  if (init.runnerKind === "pi") {
   const { createPiSessionRunner } = await import("../runner/pi.ts");
   runner = createPiSessionRunner();
  } else if (init.runnerKind === "fake" && init.fakeReplyModule && path.isAbsolute(init.fakeReplyModule)) {
   const { FakeSessionRunner } = await import("../runner/fake.ts");
   const factory = await import(pathToFileURL(init.fakeReplyModule).href);
   if (typeof factory.default !== "function") throw new Error("trusted offline fake reply module has no default function");
   runner = new FakeSessionRunner(factory.default);
  } else throw new Error("source arm runner selection is invalid");
  const budget = new SharedBudget(`source-arm-${process.pid}`, {});
  const args = init.args;
  const { executeArm } = await import("./workflow-adapter.ts");
  const receipt = await executeArm({
   ...args, source: new Workspace(args.sourceWorkspaceRoot), protectedInputs: args.protectedInputsRoot ? new Workspace(args.protectedInputsRoot) : undefined,
   runner, budget, lease: budget.root,
   beforePrompt: async () => { await rpc({ type: "prompt-before", turnId: ++turnId }); },
   onSettled: usage => rpc({ type: "prompt-settled", turnId, usage }),
   onFailed: usage => rpc({ type: "prompt-failed", turnId, usage }),
  });
  await rpc({ type: "result", receipt: { ...receipt, loadedSource, childPid: process.pid } });
 } catch (error) {
  await rpc({ type: "fatal", error: (error as Error).message }).catch(() => undefined);
  process.exitCode = 1;
 }
 process.off("disconnect", onDisconnect);
 process.disconnect();
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownEntry) await childMain();
