import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PUBLIC_HEARTBEAT_INTERVAL_MS, PUBLIC_HEARTBEAT_LINE,
	startPrivateCampaignHeartbeat } from "../scripts/private-campaign-heartbeat.ts";

test("public heartbeat is fixed text, nonfatal, unref'd and cleaned up", () => {
	const lines: string[] = [];
	let active = false;
	let fire = () => {};
	let interval: number | undefined;
	let unrefed = false;
	const handle = { unref: () => { unrefed = true; } } as ReturnType<typeof setInterval>;
	const clock = {
		every: (callback: () => void, intervalMs: number) => {
			interval = intervalMs;
			active = true;
			fire = () => { if (active) callback(); };
			return handle;
		},
		clear: (timer: ReturnType<typeof setInterval>) => {
			assert.equal(timer, handle);
			active = false;
		},
	};
	let attempts = 0;
	const stop = startPrivateCampaignHeartbeat(true, line => {
		attempts++;
		if (attempts === 1) throw new Error("observer unavailable");
		lines.push(line);
	}, clock);
	assert.equal(interval, PUBLIC_HEARTBEAT_INTERVAL_MS);
	assert.equal(unrefed, true);
	fire();
	assert.deepEqual(lines, [PUBLIC_HEARTBEAT_LINE]);
	stop();
	fire();
	assert.equal(attempts, 2);
	assert.equal(PUBLIC_HEARTBEAT_LINE, "Private campaign process responsive\n");
});

test("heartbeat is inert without explicit Actions launch context", () => {
	let writes = 0;
	let timers = 0;
	const stop = startPrivateCampaignHeartbeat(false, () => { writes++; }, {
		every: () => { timers++; throw new Error("disabled heartbeat started a timer"); },
		clear: () => { throw new Error("disabled heartbeat cleared a timer"); },
	});
	stop();
	assert.equal(writes, 0);
	assert.equal(timers, 0);
});

test("enabled helper emits through FD3 while stdout and stderr remain private", async () => {
	const yaml = await readFile(new URL("../.github/workflows/manual-private-campaign.yml", import.meta.url), "utf8");
	assert.match(yaml, /MULPIS_ACTIONS_PUBLIC_HEARTBEAT_FD: "3"/);
	const start = yaml.indexOf("node scripts/manual-private-campaign.ts");
	const end = yaml.indexOf("code=$?", start);
	assert.ok(start > -1 && end > start);
	const command = yaml.slice(start, end);
	const fd3 = command.indexOf("3>&1");
	const stdout = command.indexOf('> "$RUNNER_TEMP/private-campaign-stdout"');
	const stderr = command.indexOf('2> "$RUNNER_TEMP/private-campaign-stderr"');
	assert.ok(fd3 > -1 && stdout > fd3 && stderr > stdout,
		"FD3 must duplicate public stdout before private stdout/stderr redirection");
	assert.doesNotMatch(command, /\btee\b|2>&1/);

	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-heartbeat-test-"));
	try {
		const script = path.join(directory, "probe.mjs");
		const privateOut = path.join(directory, "private-stdout");
		const privateErr = path.join(directory, "private-stderr");
		const helperUrl = new URL("../scripts/private-campaign-heartbeat.ts", import.meta.url).href;
		await writeFile(script, `import { startPrivateCampaignHeartbeat } from ${JSON.stringify(helperUrl)};\n` +
			'process.stdout.write("synthetic-private-stdout\\n");\n' +
			'process.stderr.write("synthetic-private-stderr\\n");\n' +
			'startPrivateCampaignHeartbeat()();\n');
		const result = spawnSync("bash", ["-c", '"$1" "$2" 3>&1 > "$3" 2> "$4"', "heartbeat",
			process.execPath, script, privateOut, privateErr], { encoding: "utf8",
			env: { ...process.env, GITHUB_ACTIONS: "true", MULPIS_ACTIONS_PUBLIC_HEARTBEAT_FD: "3" } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, PUBLIC_HEARTBEAT_LINE);
		assert.equal(result.stderr, "");
		assert.equal(await readFile(privateOut, "utf8"), "synthetic-private-stdout\n");
		assert.equal(await readFile(privateErr, "utf8"), "synthetic-private-stderr\n");
		const disabled = spawnSync("bash", ["-c", '"$1" "$2" 3>&1 > "$3" 2> "$4"', "heartbeat",
			process.execPath, script, privateOut, privateErr], { encoding: "utf8",
			env: { ...process.env, GITHUB_ACTIONS: "true", MULPIS_ACTIONS_PUBLIC_HEARTBEAT_FD: "" } });
		assert.equal(disabled.status, 0, disabled.stderr);
		assert.equal(disabled.stdout, "", "a direct launch without the explicit flag must not write FD3");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
