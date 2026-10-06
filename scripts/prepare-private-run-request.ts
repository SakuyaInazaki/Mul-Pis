/** Offline descriptor for an operator-controlled, empty private workflow request. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REUSABLE_RUN_REQUEST_MESSAGE } from "../src/runner/ledger-continuation.ts";

const REF = "refs/heads/run-requests/workflow-learning-reliability";
const hex40 = /^[0-9a-f]{40}$/;

function commit(raw: string): string {
	if (raw !== "HEAD" && !hex40.test(raw)) throw new Error("commit must be HEAD or a full lowercase SHA-1");
	const resolved = execFileSync("git", ["rev-parse", "--verify", `${raw}^{commit}`],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	if (!hex40.test(resolved)) throw new Error("commit did not resolve to a full SHA-1");
	return resolved;
}

/** Builds instructions only. It never creates a commit, pushes, or checks remote CI. */
export function preparePrivateRunRequest(sourceRaw: string, previousControlRaw?: string) {
	const sourceCommit = commit(sourceRaw);
	const previousControlCommit = previousControlRaw === undefined ? undefined : commit(previousControlRaw);
	const tree = execFileSync("git", ["rev-parse", "--verify", `${sourceCommit}^{tree}`],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	if (!hex40.test(tree)) throw new Error("source tree is unavailable");
	return { ref: REF, message: REUSABLE_RUN_REQUEST_MESSAGE, tree,
		parents: previousControlCommit && previousControlCommit !== sourceCommit
			? [sourceCommit, previousControlCommit] : [sourceCommit],
		sourceCommit, ...(previousControlCommit ? { previousControlCommit } : {}),
		status: "descriptor-only; remote source tip and CI must be verified before launch" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if ((args.length !== 2 && args.length !== 4) || args[0] !== "--source" ||
		(args.length === 4 && args[2] !== "--previous-control")) {
		process.stderr.write("usage: node scripts/prepare-private-run-request.ts --source <HEAD|full-sha> [--previous-control <full-sha>]\n");
		process.exitCode = 2;
	} else {
		try { process.stdout.write(`${JSON.stringify(preparePrivateRunRequest(args[1], args[3]))}\n`); }
		catch { process.stderr.write("run request descriptor could not be prepared from local commits\n"); process.exitCode = 1; }
	}
}
