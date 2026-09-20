/**
 * Launch the project harness or the repository-local Pi CLI with an isolated
 * DeepSeek profile. The API key is passed only through the child environment.
 *
 * Examples:
 *   npm run deepseek:local -- pi --list-models deepseek
 *   npm run deepseek:local -- pi -e ./extensions/research.ts
 *   npm run deepseek:local -- harness init ./my-workspace
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const profile = path.join(root, ".agent/private/deepseek");
const credentials = JSON.parse(await readFile(path.join(profile, "credentials.json"), "utf8")) as { apiKey?: unknown };
if (typeof credentials.apiKey !== "string" || !credentials.apiKey.startsWith("sk-")) {
	throw new Error("private DeepSeek credential is missing or malformed");
}

const [target, ...args] = process.argv.slice(2);
if (target !== "pi" && target !== "harness") {
	throw new Error("usage: npm run deepseek:local -- <pi|harness> [arguments...]");
}
const entry =
	target === "pi"
		? path.join(root, "third_party/pi/packages/coding-agent/dist/cli.js")
		: path.join(root, "src/cli.ts");
const childArgs =
	target === "pi" && !args.includes("--model") && !args.includes("--provider")
		? ["--model", "deepseek/deepseek-flash", ...args]
		: args;
const child = spawn(process.execPath, [entry, ...childArgs], {
	cwd: root,
	stdio: "inherit",
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: profile,
		DEEPSEEK_API_KEY: credentials.apiKey,
	},
});
child.once("error", (error) => {
	process.stderr.write(`failed to start ${target}: ${error.message}\n`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});
