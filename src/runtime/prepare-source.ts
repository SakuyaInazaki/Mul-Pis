/** Export reviewed workflow code without copying dependencies or research data. */
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePaths = ["src", "extensions", "workflow", "tools", "package.json"];
export interface WorkflowCodeSnapshot { version: 1; sourceRoot: string; sourceCommit: string; preparedAt: string }
async function makeReadOnly(file: string): Promise<void> {
 const info = await lstat(file);
 if (info.isSymbolicLink()) return;
 if (info.isDirectory()) for (const entry of await readdir(file)) await makeReadOnly(path.join(file, entry));
 await chmod(file, info.mode & 0o555);
}
export async function prepareWorkflowCodeSource(repository: string, revision: string, outputRoot: string): Promise<WorkflowCodeSnapshot> {
 if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error("Provide the full reviewed commit ID");
 const repo = await realpath(repository);
 const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
 if (git(["rev-parse", "--verify", `${revision}^{commit}`]) !== revision) throw new Error("Source revision is not the requested commit");
 const target = path.resolve(outputRoot);
 await mkdir(path.dirname(target), { recursive: true });
 const canonicalTarget = path.join(await realpath(path.dirname(target)), path.basename(target));
 if (repo === canonicalTarget || repo.startsWith(canonicalTarget + path.sep)) throw new Error("Source output must not contain the repository");
 const entries = git(["ls-tree", "-r", revision, "--", ...sourcePaths]).split("\n");
 if (entries.some(entry => !/^100(?:644|755) blob /.test(entry))) throw new Error("Workflow source must contain regular files only");
 if (!entries.some(entry => entry.endsWith("\tsrc/runtime/loaded-source.ts"))) throw new Error("Selected revision does not support loaded-source verification");
 const modules = await realpath(path.join(repo, "node_modules"));
 await mkdir(canonicalTarget, { mode: 0o700 });
 const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", revision, "--", ...sourcePaths], { maxBuffer: 64 * 1024 * 1024 });
 execFileSync("tar", ["-C", canonicalTarget, "-xf", "-"], { input: archive });
 await symlink(modules, path.join(canonicalTarget, "node_modules"), "dir");
 let venv: string | undefined;
 try { venv = await realpath(path.join(repo, ".venv")); }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
 if (venv) await symlink(venv, path.join(canonicalTarget, ".venv"), "dir");
 const receipt: WorkflowCodeSnapshot = { version: 1, sourceRoot: canonicalTarget, sourceCommit: revision, preparedAt: new Date().toISOString() };
 await writeFile(path.join(canonicalTarget, ".workflow-source.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o400 });
 await makeReadOnly(canonicalTarget);
 return receipt;
}
