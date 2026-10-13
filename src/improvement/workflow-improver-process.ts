/** Fixed IPC bridge that runs a source-backed I decision program in its own prepared source process. */
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import { verifyPreparedWorkflowSource } from "./workflow-source-arm.ts";
import type { WorkflowImproverStateV1 } from "./workflow-improver-types.ts";

const MODULE = "src/improvement/workflow-improver-program.ts";
const EXPORT = "decideWorkflowImprovement";
type ParentMessage = { type: "init"; binding: LoadedSourceV1; versionId: string; nonce: string } |
 { type: "decide"; id: number; state: WorkflowImproverStateV1 } | { type: "close" };
type ChildMessage = { type: "ready"; binding: LoadedSourceV1; pid: number; versionId: string; nonce: string; modulePath: string; exportName: string } |
 { type: "action"; id: number; action: unknown } | { type: "error"; id?: number; error: string };

export interface WorkflowImproverProcess {
 binding: LoadedSourceV1; versionId: string; pid: number; modulePath: typeof MODULE; exportName: typeof EXPORT;
 decide(state: WorkflowImproverStateV1): Promise<unknown>;
 close(): Promise<void>;
}

/** The parent verifies the prepared tree; the child proves the code it actually loaded. */
export async function openWorkflowImproverProcess(binding: LoadedSourceV1, versionId: string, signal?: AbortSignal): Promise<WorkflowImproverProcess> {
 if (!versionId.trim()) throw new Error("source I version ID is required");
 await verifyPreparedWorkflowSource(binding);
 const entry = path.join(binding.sourceRoot, "src/improvement/workflow-improver-process.ts");
 const module = path.join(binding.sourceRoot, MODULE);
 for (const file of [entry, module]) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) || await realpath(file) !== file)
   throw new Error("source I bridge or program is missing, indirect, or writable");
 }
 if (signal?.aborted) throw new Error("source I process cancelled before launch");
 const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
  PRE_RSI_SOURCE_ROOT: binding.sourceRoot, PRE_RSI_CODE_REVISION: binding.sourceCommit };
 const child = fork(entry, [], { cwd: binding.sourceRoot, env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
 const nonce = randomUUID();
 let exited = false, nextId = 0;
 let diagnostic = "";
 for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8_000); });
 const pending = new Map<number, { resolve: (action: unknown) => void; reject: (error: Error) => void }>();
 let readyResolve!: (ready: Extract<ChildMessage, { type: "ready" }>) => void;
 let readyReject!: (error: Error) => void;
 const ready = new Promise<Extract<ChildMessage, { type: "ready" }>>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
 const fail = (error: Error) => {
  readyReject(error);
  for (const item of pending.values()) item.reject(error);
  pending.clear();
 };
 const onAbort = () => child.kill("SIGKILL");
 signal?.addEventListener("abort", onAbort, { once: true });
 child.on("message", raw => {
  const message = raw as ChildMessage;
  if (message?.type === "ready") { readyResolve(message); return; }
  if (message?.type === "action") { const item = pending.get(message.id); if (item) { pending.delete(message.id); item.resolve(message.action); } return; }
  if (message?.type === "error") {
   const error = new Error(message.error);
   if (message.id === undefined) fail(error);
   else { const item = pending.get(message.id); if (item) { pending.delete(message.id); item.reject(error); } }
  }
 });
 child.once("error", error => fail(error));
 child.once("exit", (code, exitSignal) => { exited = true;
  fail(new Error(`source I process exited before completing decision (${code ?? exitSignal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`));
  signal?.removeEventListener("abort", onAbort);
 });
 child.send({ type: "init", binding, versionId, nonce } satisfies ParentMessage);
 let attested: Extract<ChildMessage, { type: "ready" }>;
 try { attested = await ready; }
 catch (error) { if (!exited) child.kill("SIGKILL"); throw error; }
 if (attested.pid !== child.pid || attested.versionId !== versionId || attested.nonce !== nonce || attested.modulePath !== MODULE || attested.exportName !== EXPORT ||
  attested.binding?.sourceRoot !== binding.sourceRoot || attested.binding.sourceCommit !== binding.sourceCommit) {
  child.kill("SIGKILL"); throw new Error("source I child did not attest the selected module and source binding");
 }
 return {
  binding, versionId, pid: child.pid!, modulePath: MODULE, exportName: EXPORT,
  decide(state) {
   if (exited || signal?.aborted) return Promise.reject(new Error("source I process is no longer available"));
   return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.send({ type: "decide", id, state } satisfies ParentMessage, error => {
     if (error) { pending.delete(id); reject(error); }
    });
   });
  },
  async close() {
   if (exited) return;
   // A loaded I program may never settle its decision or may block its event loop.
   child.kill("SIGKILL");
   await new Promise<void>(resolve => { if (exited) resolve(); else child.once("exit", () => resolve()); });
  },
 };
}

async function childMain(): Promise<void> {
 if (!process.send) throw new Error("source I bridge requires parent IPC");
 const send = process.send.bind(process);
 const init = await new Promise<Extract<ParentMessage, { type: "init" }>>(resolve => {
  const receive = (raw: unknown) => { const message = raw as ParentMessage;
   if (message?.type === "init") { process.off("message", receive); resolve(message); }
  }; process.on("message", receive);
 });
 try {
  const { verifyLoadedSource } = await import("../runtime/loaded-source.ts");
  const loaded = await verifyLoadedSource(import.meta.url, init.binding.sourceRoot, init.binding.sourceCommit);
  if (!loaded || loaded.sourceRoot !== init.binding.sourceRoot || loaded.sourceCommit !== init.binding.sourceCommit)
   throw new Error("source I process loaded a different source revision");
  const program = await import(pathToFileURL(path.join(loaded.sourceRoot, MODULE)).href) as Record<string, unknown>;
  const decide = program[EXPORT];
  if (typeof decide !== "function") throw new Error("source I program entry export is missing");
  send({ type: "ready", binding: loaded, pid: process.pid, versionId: init.versionId, nonce: init.nonce, modulePath: MODULE, exportName: EXPORT } satisfies ChildMessage);
  process.on("message", raw => {
   const message = raw as ParentMessage;
   if (message?.type === "close") { process.exit(0); return; }
   if (message?.type !== "decide") return;
   void Promise.resolve().then(() => decide(message.state)).then(action => {
    send({ type: "action", id: message.id, action } satisfies ChildMessage);
   }, error => {
    send({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) } satisfies ChildMessage);
   });
  });
  process.once("disconnect", () => process.exit(1));
 } catch (error) {
  send({ type: "error", error: error instanceof Error ? error.message : String(error) } satisfies ChildMessage, () => process.exit(1));
 }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void childMain();
