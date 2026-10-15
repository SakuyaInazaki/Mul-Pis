import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { parseRpcHostArgs, runRpcHost } from "../scripts/workflow-rpc-host.ts";

test("RPC host requires an explicit recovery descriptor for an existing goal", () => {
	assert.throws(() => parseRpcHostArgs(["--workspace", "/tmp/ws", "--goal", "g1"]), /--descriptor/);
	assert.deepEqual(parseRpcHostArgs(["--workspace", "/tmp/ws", "--", "--model", "fake/test"]).piArgs, ["--model", "fake/test"]);
});

test("RPC host remains alive between prompt events and ends on stdin EOF", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-rpc-host-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const fakePi = path.join(root, "fake-pi.mjs");
	await writeFile(fakePi, `import readline from "node:readline";\nfor await (const line of readline.createInterface({ input: process.stdin })) { const command = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "agent_settled", id: command.id, mode: process.argv.includes("rpc") ? "rpc" : "missing" }) + "\\n"); }\n`);
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let output = "";
	stdout.on("data", (chunk) => { output += String(chunk); });
	let finished = false;
	const running = runRpcHost({ workspace: root }, { stdin, stdout, stderr }, fakePi).then((code) => { finished = true; return code; });
	const until = async (id: string) => {
		for (let i = 0; i < 100 && !output.includes(`\"id\":\"${id}\"`); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.match(output, new RegExp(`\"id\":\"${id}\"`));
	};
	stdin.write('{"type":"prompt","id":"first","message":"continue"}\n');
	await until("first");
	assert.equal(finished, false, "a settled turn leaves the RPC process ready for explicit input");
	stdin.write('{"type":"prompt","id":"resume","message":"[[resume-goal:g1]] new decision"}\n');
	await until("resume");
	stdin.end();
	assert.equal(await running, 0);
});
