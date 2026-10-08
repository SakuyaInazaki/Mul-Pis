import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CARRY_ARTIFACT_NAME } from "../src/runner/ledger-continuation.ts";

test("manual private workflow preserves encrypted carry and runtime admission", async () => {
	const yaml = await readFile(new URL("../.github/workflows/manual-private-campaign.yml", import.meta.url), "utf8");
	assert.ok(yaml.includes("github.event_name == 'workflow_dispatch'"));
	assert.ok(yaml.includes("inputs.authorize_bounded_run == true"));
	assert.ok(yaml.includes("github.event_name == 'push'"));
	assert.ok(yaml.includes("github.event.head_commit.message == 'Run confidential workflow'"));
	assert.ok(yaml.includes("refs/heads/run-requests/workflow-learning-reliability"));
	assert.ok(yaml.includes("github.run_attempt == 1"));
	assert.ok(yaml.includes("cancel-in-progress: false"));
	assert.ok(yaml.includes("persist-credentials: false"));
	assert.ok(yaml.includes("MULPIS_MISSION_LEDGER_B64: ${{ secrets.MULPIS_MISSION_LEDGER_B64 }}"));
	const uploadPaths = [...yaml.matchAll(/^\s+path: (.+)$/gm)].map(match => match[1]);
	assert.deepEqual(uploadPaths, ["${{ runner.temp }}/private-campaign-outcome.enc.json"]);
	const carryUpload = yaml.split("- name: Upload encrypted mission continuation")[1]!
		.split("- name: Report generic campaign failure")[0]!;
	assert.match(carryUpload, /uses: \.\/\.github\/actions\/final-carry-upload/);
	assert.match(carryUpload,
		/MULPIS_MISSION_LEDGER_B64: \$\{\{ secrets\.MULPIS_MISSION_LEDGER_B64 \}\}/);
	const action = await readFile(new URL("../.github/actions/final-carry-upload/action.yml",
		import.meta.url), "utf8");
	assert.match(action, /using: node24/);
	assert.match(action, /main: main\.mjs/);
	const uploader = await readFile(new URL("../.github/actions/final-carry-upload/main.mjs",
		import.meta.url), "utf8");
	assert.ok(uploader.includes("CARRY_ARTIFACT_NAME"));
	assert.ok(uploader.includes("authenticateSealedCarryFilesForUpload"));
	assert.ok(uploader.includes("INCREMENTAL_CHECKPOINT_FILE"));
	assert.ok(uploader.includes("sealPartitionManifest"));
	assert.equal(CARRY_ARTIFACT_NAME, "confidential-mission-carry");
	assert.ok(yaml.includes("if: always() && steps.continuation.outputs.available == 'true'"));
	assert.ok(yaml.includes("-s \"$RUNNER_TEMP/private-campaign-output/incremental-control-prefix.json\""));
});
