/** Model-authored source candidate in a disposable private Git checkout. */
import { execFileSync, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareWorkflowCodeSource, type WorkflowCodeSnapshot } from "../runtime/prepare-source.ts";
import { createConfinedCampaignFileTools } from "../runner/confined-campaign-files.ts";
import type { SessionRef, SessionRunner, ToolCallRecord, UsageSummary } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { parseSourceHypothesis } from "./model-json.ts";

/** This first research surface is deliberately narrow. Expanding it requires a separate control-boundary review. */
const EDITABLE_SOURCE = new Set(["src/m07/feedback.ts", "src/improvement/workflow-improver-program.ts"]);
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export interface SourceCandidateCheck { name: string; executable: string; args: string[] }
export interface SourceCandidateInput {
 repository: string; parentCommit: string; candidateRoot: string; snapshotRoot: string;
 receiptPath: string; persistDir: string; runner: SessionRunner;
 /** Resolved by the trusted caller from research.config.json roles.improver. */
 model: string; writableFiles: string[];
 /** Frozen development request chosen by the loaded I program. It is guidance, never permission or a check. */
 developmentBrief?: string;
 developmentEvidence: Array<{ id: string; path: string }>;
 checks: SourceCandidateCheck[];
 signal?: AbortSignal;
}
export interface SourceCandidateReceipt {
 version: 1; status: "committed" | "rejected"; reason?: string;
 candidateRoot: string; parentCommit: string; sourceCommit?: string;
 snapshot?: WorkflowCodeSnapshot; writableFiles: string[]; changedFiles: string[];
 diff: string; developmentEvidence: Array<{ id: string; frozenPath: string; bytes: number }>;
 hypothesis?: { claim: string; predictedObservation: string; falsifier: string };
 developmentBrief?: string;
 session?: SessionRef; toolLog?: ToolCallRecord[]; usage?: UsageSummary;
 checks: Array<{ name: string; passed: boolean; exitCode: number | null; output: string }>;
 engineeringStatus: "passed" | "failed" | "unverified";
}

function git(repo: string, args: string[], input?: string): string {
 return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", ...(input === undefined ? {} : { input }) }).trimEnd();
}
function parseHypothesis(text: string): SourceCandidateReceipt["hypothesis"] {
 try { return parseSourceHypothesis(text); }
 catch (error) { throw new HarnessError("improvement.source-candidate", `builder hypothesis: ${(error as Error).message}`); }
}
function changedFiles(repo: string): string[] {
 const raw = execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
 const entries = raw.toString("utf8").split("\0").filter(Boolean);
 const names: string[] = [];
 for (let index = 0; index < entries.length; index++) {
  const entry = entries[index]!;
  const status = entry.slice(0, 2);
  const name = entry.slice(3);
  names.push(name);
  if (status.includes("R") || status.includes("C")) names.push(entries[++index] ?? "");
 }
 return [...new Set(names)].sort();
}
function validateWritable(files: string[]): void {
 if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length || files.some(file => !EDITABLE_SOURCE.has(file)))
  throw new HarnessError("improvement.source-candidate", "writableFiles must name reviewed source modules only");
}
async function runCheck(check: SourceCandidateCheck, root: string, signal?: AbortSignal): Promise<SourceCandidateReceipt["checks"][number]> {
 if (signal?.aborted) throw new Error("source candidate cancelled before engineering check");
 return new Promise(resolve => {
  const child = spawn(check.executable, check.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errorText = "", done = false;
  const onAbort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  const append = (chunk: Buffer) => {
   output = (output + chunk.toString("utf8")).slice(0, 4 * 1024 * 1024);
   if (output.length >= 4 * 1024 * 1024) { errorText = "engineering check output exceeded capture limit"; child.kill("SIGKILL"); }
  };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  child.once("error", error => { errorText = error.message; });
  child.once("close", code => {
   if (done) return; done = true; signal?.removeEventListener("abort", onAbort);
   resolve({ name: check.name, passed: code === 0 && !errorText && !signal?.aborted, exitCode: code,
    output: `${output}${errorText}${signal?.aborted ? "source candidate cancelled" : ""}` });
  });
  if (signal?.aborted) onAbort();
 });
}
async function freezeEvidence(root: string, evidence: SourceCandidateInput["developmentEvidence"]): Promise<SourceCandidateReceipt["developmentEvidence"]> {
 const target = path.join(root, ".source-candidate-evidence");
 await mkdir(target, { recursive: true });
 const seen = new Set<string>();
 const frozen: SourceCandidateReceipt["developmentEvidence"] = [];
 for (const entry of evidence) {
  if (!SAFE_EVIDENCE_ID.test(entry.id) || seen.has(entry.id)) throw new HarnessError("improvement.source-candidate", "invalid or duplicate development evidence ID");
  seen.add(entry.id);
  const info = await lstat(entry.path);
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("improvement.source-candidate", "development evidence must be a regular file");
  const frozenPath = path.join(target, `${entry.id}.txt`);
  await copyFile(entry.path, frozenPath);
  frozen.push({ id: entry.id, frozenPath, bytes: info.size });
 }
 return frozen;
}

/** A single real builder session. This function never activates the resulting source. */
export async function generateSourceCandidate(input: SourceCandidateInput): Promise<SourceCandidateReceipt> {
 validateWritable(input.writableFiles);
 if (!FULL_COMMIT.test(input.parentCommit) || !input.model.trim() || !Array.isArray(input.checks))
  throw new HarnessError("improvement.source-candidate", "invalid parent commit, model, or engineering checks");
 const repository = await realpath(input.repository);
 if (git(repository, ["rev-parse", "--verify", `${input.parentCommit}^{commit}`]) !== input.parentCommit)
  throw new HarnessError("improvement.source-candidate", "parent commit does not resolve exactly");
 const root = path.resolve(input.candidateRoot);
 const receipt: SourceCandidateReceipt = { version: 1, status: "rejected", candidateRoot: root, parentCommit: input.parentCommit,
  writableFiles: [...input.writableFiles], changedFiles: [], diff: "", developmentEvidence: [], checks: [], engineeringStatus: "unverified" };
 if (input.developmentBrief !== undefined) receipt.developmentBrief = input.developmentBrief;
 await mkdir(path.dirname(root), { recursive: true });
 await mkdir(path.dirname(input.receiptPath), { recursive: true });
 try {
  if (input.signal?.aborted) throw new Error("source candidate cancelled before clone");
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", repository, root]);
  git(root, ["checkout", "-q", "--detach", input.parentCommit]);
  git(root, ["config", "user.name", "Source Candidate Builder"]);
  git(root, ["config", "user.email", "source-candidate@example.invalid"]);
  const modules = await realpath(path.join(repository, "node_modules"));
  await symlink(modules, path.join(root, "node_modules"), "dir");
  // Evidence is readable through the confined tools but never enters source Git.
  await writeFile(path.join(root, ".git", "info", "exclude"), "node_modules\n.source-candidate-evidence/\n", { flag: "a" });
  receipt.developmentEvidence = await freezeEvidence(root, input.developmentEvidence);
  for (const file of input.writableFiles) await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  const tools = await createConfinedCampaignFileTools(root, { writableFiles: input.writableFiles });
  const session = await input.runner.create({ label: "source-candidate-builder", role: "improver", model: input.model,
   systemPrompt: "You are editing a research workflow source candidate. Read the frozen development evidence and relevant source. Form your own falsifiable failure hypothesis, then edit only the explicitly writable source files with the granted file tools. Do not change evaluation, controller, runner, verifier, budget, knowledge merge, or usage code. Return JSON with claim, predictedObservation, and falsifier after editing.",
   tools: { kind: "custom", tools }, persistDir: input.persistDir });
  receipt.session = session.ref;
  const onAbort = () => { void session.abort().catch(() => {}); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
   if (input.signal?.aborted) { await session.abort(); throw new Error("source candidate cancelled before model prompt"); }
   const turn = await session.prompt(JSON.stringify({ parentCommit: input.parentCommit, writableFiles: input.writableFiles,
    ...(input.developmentBrief !== undefined ? { developmentBrief: input.developmentBrief } : {}),
    developmentEvidence: receipt.developmentEvidence.map(({ id, frozenPath }) => ({ id, relativePath: path.relative(root, frozenPath) })) }));
   receipt.hypothesis = parseHypothesis(turn.text);
  } finally {
   input.signal?.removeEventListener("abort", onAbort);
   receipt.toolLog = session.toolLog(); receipt.usage = session.usageSummary(); session.dispose();
  }
  if (input.signal?.aborted) throw new Error("source candidate cancelled after model prompt");
  receipt.changedFiles = changedFiles(root);
  if (!receipt.changedFiles.length) throw new HarnessError("improvement.source-candidate", "builder made no source change");
  if (receipt.changedFiles.some(file => !input.writableFiles.includes(file)))
   throw new HarnessError("improvement.source-candidate", "full Git status contains a change outside the declared source allowlist");
  git(root, ["add", "--", ...receipt.changedFiles]);
  receipt.diff = git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", input.parentCommit]);
  if (!receipt.diff.trim()) throw new HarnessError("improvement.source-candidate", "candidate diff is empty");
  for (const check of input.checks) {
   if (!check.name.trim() || !check.executable.trim() || !Array.isArray(check.args) || !check.args.every(arg => typeof arg === "string"))
    throw new HarnessError("improvement.source-candidate", "invalid controller engineering check");
   receipt.checks.push(await runCheck(check, root, input.signal));
   if (input.signal?.aborted) throw new Error("source candidate cancelled during engineering check");
  }
  if (changedFiles(root).join("\0") !== receipt.changedFiles.join("\0") ||
   git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", input.parentCommit]) !== receipt.diff ||
   git(root, ["diff", "--binary", "--full-index", "--no-ext-diff"]))
   throw new HarnessError("improvement.source-candidate", "engineering checks changed the frozen candidate patch");
  receipt.engineeringStatus = input.checks.length ? receipt.checks.every(check => check.passed) ? "passed" : "failed" : "unverified";
  git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Model-generated workflow source candidate"]);
  receipt.sourceCommit = git(root, ["rev-parse", "HEAD"]);
  if (git(root, ["rev-parse", "HEAD^"]) !== input.parentCommit || changedFiles(root).length)
   throw new HarnessError("improvement.source-candidate", "committed candidate differs from the reviewed patch");
  receipt.snapshot = await prepareWorkflowCodeSource(root, receipt.sourceCommit, input.snapshotRoot);
  receipt.status = "committed";
 } catch (error) {
  receipt.reason = error instanceof Error ? error.message : String(error);
  try { receipt.changedFiles = changedFiles(root); } catch { /* clone may have failed */ }
  if (!receipt.diff) try { receipt.diff = git(root, ["diff", "--binary", "--full-index", "--no-ext-diff", input.parentCommit]); } catch { /* no checkout */ }
 } finally {
  await writeFile(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
 }
 return receipt;
}
