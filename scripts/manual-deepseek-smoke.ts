/**
 * Manual, billable DeepSeek smoke test. This file is intentionally outside the
 * offline test suite. It reads only the project-private credential file and
 * uses an isolated Pi ModelRuntime.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionRunner } from "../src/runner/pi.ts";
import type { SessionHandle, SessionSpec } from "../src/runner/types.ts";

const root = process.cwd();
const privateDir = path.join(root, ".agent/private/deepseek");
const smokeProfile = path.join(privateDir, "smoke-profile");
const credentialsPath = path.join(privateDir, "credentials.json");
const model = "deepseek/deepseek-flash:low";
const runDir = path.join(privateDir, `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`);

function report(name: string, data: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ check: name, ...data })}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function disposeAfter<T>(handle: SessionHandle, action: (handle: SessionHandle) => Promise<T>): Promise<T> {
	try {
		return await action(handle);
	} finally {
		handle.dispose();
	}
}

function spec(label: string, persistDir: string, tools: SessionSpec["tools"], systemPrompt: string): SessionSpec {
	return { label, role: "checker", model, systemPrompt, tools, persistDir };
}

async function main(): Promise<void> {
	const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as { apiKey?: unknown };
	if (typeof credentials.apiKey !== "string" || !credentials.apiKey.startsWith("sk-")) {
		throw new Error("private DeepSeek credential is missing or malformed");
	}
	// These must be set before PiSessionRunner lazily creates its default
	// ModelRuntime. This exercises the same profile discovery path as real runs.
	process.env.PI_CODING_AGENT_DIR = smokeProfile;
	process.env.DEEPSEEK_API_KEY = credentials.apiKey;
	const preflight = await ModelRuntime.create({ modelsPath: path.join(smokeProfile, "models.json"), authPath: path.join(smokeProfile, "preflight-auth.json"), allowModelNetwork: false });
	const resolvedModel = preflight.getModel("deepseek", "deepseek-flash");
	assert(resolvedModel?.provider === "deepseek" && resolvedModel.id === "deepseek-flash", "unexpected model resolution");
	assert(resolvedModel.baseUrl === "https://api.deepseek.com", "unexpected DeepSeek base URL");
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	await chmod(runDir, 0o700);

	const modelsResponse = await fetch("https://api.deepseek.com/models", {
		headers: { Authorization: `Bearer ${credentials.apiKey}` },
		signal: AbortSignal.timeout(20_000),
	});
	const modelsBody = (await modelsResponse.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
	report("api-auth", {
		status: modelsResponse.status,
		modelIds: Array.isArray(modelsBody.data) ? modelsBody.data.map((item) => item.id).filter(Boolean) : [],
	});
	if (!modelsResponse.ok) throw new Error(`DeepSeek models endpoint returned HTTP ${modelsResponse.status}`);

	// Fixed suite ceiling: one /models request plus at most seven model rounds.
	// Each scenario has a hard deadline; on failure the suite stops immediately.
	const persistedAbort = new AbortController();
	const persistedTimer = setTimeout(() => persistedAbort.abort(), 60_000);
	const runner = new PiSessionRunner({ signal: persistedAbort.signal });

	const persisted = await runner.create(
		spec("deepseek-persist", path.join(runDir, "persist"), { kind: "none" }, "Reply concisely. Follow exact output-format requests."),
	);
	let first;
	let second;
	let ref;
	let resumed;
	try {
		first = await persisted.prompt("Remember nonce ORCHID-731. Reply exactly: STREAM_OK");
		ref = persisted.ref;
		persisted.dispose();
		resumed = await runner.resume(ref);
		second = await disposeAfter(resumed, (handle) => handle.prompt("What nonce did I ask you to remember? Reply with only the nonce."));
	} finally {
		clearTimeout(persistedTimer);
	}
	report("stream-and-resume", {
		firstExact: first.text === "STREAM_OK",
		secondExact: second.text === "ORCHID-731",
		usage: [first.usage, second.usage],
		sessionIdStable: resumed.ref.id === ref.id,
		persisted: Boolean(ref.file && ref.specFile),
	});
	assert(first.text === "STREAM_OK" && second.text === "ORCHID-731", "stream/resume response mismatch");
	assert(resumed.ref.id === ref.id && Boolean(ref.file && ref.specFile), "session persistence mismatch");

	const isolatedAbort = new AbortController();
	const isolatedTimer = setTimeout(() => isolatedAbort.abort(), 45_000);
	const isolatedRunner = new PiSessionRunner({ signal: isolatedAbort.signal });
	const isolated = await isolatedRunner.create(
		spec("deepseek-isolated", path.join(runDir, "isolated"), { kind: "none" }, "Reply concisely and truthfully."),
	);
	let isolatedTurn;
	try {
		isolatedTurn = await disposeAfter(isolated, (handle) =>
			handle.prompt("Without guessing, state whether this conversation contains a previously supplied nonce. Reply exactly YES or NO."),
		);
	} finally {
		clearTimeout(isolatedTimer);
	}
	report("new-session-isolation", { exact: isolatedTurn.text === "NO", usage: isolatedTurn.usage });
	assert(isolatedTurn.text === "NO", "session isolation mismatch");

	const customAbort = new AbortController();
	const customTimer = setTimeout(() => customAbort.abort(), 60_000);
	const customRunner = new PiSessionRunner({ signal: customAbort.signal });
	const custom = await customRunner.create(
		spec(
			"deepseek-custom-tool",
			path.join(runDir, "custom-tool"),
			{
				kind: "custom",
				tools: [
					{
						name: "smoke_echo",
						description: "Return the supplied value. You must use this tool when asked to echo a value.",
						params: { value: { type: "string", description: "Value to echo" } },
						execute: async (args) => ({ text: `TOOL:${String(args.value)}` }),
					},
				],
			},
			"Use the required tool, then answer with its result only.",
		),
	);
	let customTurn;
	try {
		customTurn = await disposeAfter(custom, (handle) => handle.prompt("Call smoke_echo with value PEAR-42, then return the tool result."));
	} finally {
		clearTimeout(customTimer);
	}
	report("tool-continuation", {
		exact: customTurn.text === "TOOL:PEAR-42",
		toolCalls: customTurn.toolCalls,
		toolLog: custom.toolLog().map(({ name, ok }) => ({ name, ok })),
		usage: customTurn.usage,
	});
	assert(customTurn.text === "TOOL:PEAR-42" && customTurn.toolCalls === 1, "custom tool continuation mismatch");
	assert(custom.toolLog().length === 1 && custom.toolLog()[0]?.ok, "custom tool log mismatch");

	const materialDir = path.join(runDir, "material");
	await mkdir(materialDir, { recursive: true, mode: 0o700 });
	await writeFile(path.join(materialDir, "probe.txt"), "FILE_TOKEN=CEDAR-908\n", { mode: 0o600 });
	const readAbort = new AbortController();
	const readTimer = setTimeout(() => readAbort.abort(), 60_000);
	const readRunner = new PiSessionRunner({ signal: readAbort.signal });
	const reader = await readRunner.create(
		spec(
			"deepseek-read-tool",
			path.join(runDir, "read-tool"),
			{ kind: "read-dir", root: materialDir },
			"Read the requested file with material_read and answer only from its contents.",
		),
	);
	let readTurn;
	try {
		readTurn = await disposeAfter(reader, (handle) =>
			handle.prompt("Use material_read on probe.txt and reply with only the FILE_TOKEN value."),
		);
	} finally {
		clearTimeout(readTimer);
	}
	report("read-only-file-tool", {
		exact: readTurn.text === "CEDAR-908",
		toolCalls: readTurn.toolCalls,
		readCoverage: reader.readCoverage(),
		usage: readTurn.usage,
	});
	assert(readTurn.text === "CEDAR-908" && readTurn.toolCalls === 1, "read tool response mismatch");
	assert(reader.readCoverage().join(",") === "probe.txt", "read coverage mismatch");

	report("summary", { ok: true, model, runDir: path.relative(root, runDir) });
}

main().catch((error) => {
	report("summary", { ok: false, errorType: error instanceof Error ? error.name : "UnknownError" });
	process.exitCode = 1;
});
