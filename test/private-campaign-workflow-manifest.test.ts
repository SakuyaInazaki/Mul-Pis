import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CARRY_ARTIFACT_NAME, CARRY_FILE_NAME } from "../src/runner/ledger-continuation.ts";

test("manual private workflow preserves encrypted carry and runtime admission", async () => {
	const yaml = await readFile(new URL("../.github/workflows/manual-private-campaign.yml", import.meta.url), "utf8");
	assert.ok(yaml.includes("github.event_name == 'workflow_dispatch'"));
	assert.ok(yaml.includes("inputs.authorize_bounded_run == true"));
	assert.doesNotMatch(yaml, /github\.event\.head_commit\.message|github\.event_name == 'push'/);
	assert.ok(yaml.includes("github.run_attempt == 1"));
	assert.ok(yaml.includes("cancel-in-progress: false"));
	assert.ok(yaml.includes("persist-credentials: false"));
	assert.ok(yaml.includes("MULPIS_MISSION_LEDGER_B64: ${{ secrets.MULPIS_MISSION_LEDGER_B64 }}"));
	assert.ok(yaml.includes(`name: ${CARRY_ARTIFACT_NAME}`));
	const uploadPaths = [...yaml.matchAll(/^\s+path: (.+)$/gm)].map(match => match[1]);
	assert.deepEqual(uploadPaths, [
		"${{ runner.temp }}/private-campaign-outcome.enc.json",
		"${{ runner.temp }}/private-campaign-output/" + CARRY_FILE_NAME,
	]);
	assert.ok(yaml.includes("if: always() && steps.continuation.outputs.available == 'true'"));
});
