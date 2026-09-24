import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readCurrentProcessIdentity, probeProcessIdentity } from "../src/runtime/process-identity.ts";

const exec = promisify(execFile);

test("a bounded observer exits or times out without stopping its independent worker", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-observer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
	const identity = await readCurrentProcessIdentity(worker.pid!);
	t.after(() => { try { process.kill(worker.pid!, "SIGTERM"); } catch {} });
	const { stdout: groupText } = await exec("ps", ["-p", String(worker.pid), "-o", "pgid="], { timeout: 2_000 });
	assert.equal(Number(groupText.trim()), worker.pid);
	const log = path.join(root, "main-1.jsonl");
	await writeFile(log, "synthetic bounded log\n");
	const moduleUrl = pathToFileURL(path.resolve("src/runtime/bounded-file-tail.ts")).href;
	const observerScript = `import { readBoundedFileTail } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(readBoundedFileTail(process.argv[1], Number(process.argv[2]))));`;
	const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", observerScript, log, "8"], { timeout: 2_000 });
	assert.deepEqual(JSON.parse(stdout), {
		bytesRead: 8,
		truncatedStart: true,
		truncatedEnd: false,
		text: "ded log\n",
	});
	assert.equal((await probeProcessIdentity(identity)).status, "alive");
	const hungObserver = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	await new Promise((resolve) => setTimeout(resolve, 30));
	hungObserver.kill("SIGTERM");
	await new Promise<void>((resolve) => hungObserver.once("exit", () => resolve()));
	const afterTimeout = await probeProcessIdentity(identity);
	assert.equal(afterTimeout.status, "alive");
	assert.equal(afterTimeout.identityMatch, true);
});
