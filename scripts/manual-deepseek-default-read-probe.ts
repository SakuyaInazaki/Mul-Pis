/** Billable two-round probe for the production default ModelRuntime path. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionRunner } from "../src/runner/pi.ts";

const root = process.cwd();
const profile = path.join(root, ".agent/private/deepseek");
const credential = JSON.parse(await readFile(path.join(profile, "credentials.json"), "utf8")) as { apiKey?: unknown };
if (typeof credential.apiKey !== "string" || !credential.apiKey.startsWith("sk-")) throw new Error("credential unavailable");
process.env.PI_CODING_AGENT_DIR = profile;
process.env.DEEPSEEK_API_KEY = credential.apiKey;
const preflight = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"), authPath: path.join(profile, "preflight-auth.json"), allowModelNetwork: false });
const resolvedModel = preflight.getModel("deepseek", "deepseek-flash");
if (
	resolvedModel?.provider !== "deepseek" ||
	resolvedModel.id !== "deepseek-flash" ||
	resolvedModel.baseUrl !== "https://api.deepseek.com"
) throw new Error("unexpected DeepSeek model resolution");

const runDir = path.join(profile, `default-read-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const materialDir = path.join(runDir, "material");
await mkdir(materialDir, { recursive: true, mode: 0o700 });
await writeFile(path.join(materialDir, "probe.txt"), "DEFAULT_PATH_TOKEN=MAPLE-614\n", { mode: 0o600 });

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);
const runner = new PiSessionRunner({ signal: controller.signal });
let handle;
try {
	handle = await runner.create({
		label: "deepseek-default-read",
		role: "checker",
		model: "deepseek/deepseek-flash:low",
		systemPrompt: "Use material_read on the requested file and answer only from its contents.",
		tools: { kind: "read-dir", root: materialDir },
		persistDir: path.join(runDir, "session"),
	});
	const turn = await handle.prompt("Read probe.txt and reply with only the DEFAULT_PATH_TOKEN value.");
	const ok = turn.text === "MAPLE-614" && turn.toolCalls === 1 && handle.readCoverage().join(",") === "probe.txt";
	process.stdout.write(
		`${JSON.stringify({
			check: "default-runtime-read-tool",
			ok,
			toolCalls: turn.toolCalls,
			readCoverage: handle.readCoverage(),
			usage: turn.usage,
		})}\n`,
	);
	if (!ok) process.exitCode = 1;
} catch (error) {
	process.stdout.write(`${JSON.stringify({ check: "default-runtime-read-tool", ok: false, errorType: error instanceof Error ? error.name : "UnknownError" })}\n`);
	process.exitCode = 1;
} finally {
	clearTimeout(timer);
	handle?.dispose();
}
