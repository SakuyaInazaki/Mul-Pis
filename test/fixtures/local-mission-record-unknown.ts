/** Record a synthetic unresolved effect in a short-lived, real local host owner. */
import path from "node:path";
import { LocalMissionHost } from "../../src/runner/local-mission-host.ts";

const [workspaceRoot, missionId] = process.argv.slice(2);
if (!workspaceRoot || !missionId) throw new Error("workspace and mission are required");
const root = path.join(workspaceRoot, ".agent", "missions", missionId);
const prior = await LocalMissionHost.status(root);
const number = Number(prior.currentAttempt?.attemptId.slice(1));
if (!Number.isSafeInteger(number) || number < 1) throw new Error("current attempt is missing");
const attemptId = `A${String(number + 1).padStart(3, "0")}`;
const host = await LocalMissionHost.begin({ root, missionId, attemptId,
	codeRevision: "local-harness-v1" });
await host.recordUnknownOperation({ attemptId, operationId: "synthetic-unsettled-effect" });
