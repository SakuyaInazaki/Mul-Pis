/** A separate process checks current validity without creating a model session. */
import { openDefaultLocalMission } from "../../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";

const [root, missionId, action] = process.argv.slice(2);
if (!root || !missionId || !["status", "step", "run"].includes(action ?? ""))
	throw new Error("reopen fixture arguments are invalid");
const mission = openDefaultLocalMission({ workspaceRoot: root,
	runner: new FakeSessionRunner(() => { throw new Error("reopen must not prompt"); }),
	config: { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1, tools: {} } });
try {
	const result = action === "status" ? await mission.status(missionId) :
		action === "step" ? await mission.step(missionId) : await mission.run(missionId);
	process.stdout.write(`${JSON.stringify({ valid: true, outcome: result.objectiveOutcome })}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ valid: false, message: (error as Error).message })}\n`);
}
