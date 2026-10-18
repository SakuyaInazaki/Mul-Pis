/** Explicit host-configured local operator entrypoint:
 * PRE_RSI_LOCAL_OPERATOR_CONFIG=/absolute/host/config.json pi -e ./extensions/local-operator.ts
 * Config requires subjectId: the exact subject authorized by the fixed contractPath.
 * Candidate execution must match that host binding; a task label cannot change it.
 * The ordinary research extension remains unbound unless its host supplies an adapter. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLocalOperatorBackend, type LocalOperatorBackendOptions } from "../src/m07/local-operator-backend.ts";
import { createResearchExtension } from "../src/pi/extension.ts";

const configurationPath = process.env.PRE_RSI_LOCAL_OPERATOR_CONFIG;
if (!configurationPath || !path.isAbsolute(configurationPath))
	throw new Error("PRE_RSI_LOCAL_OPERATOR_CONFIG must be an absolute host-owned configuration file path");
const configuration = JSON.parse(await readFile(configurationPath, "utf8")) as LocalOperatorBackendOptions;
const { backend, verifier } = await createLocalOperatorBackend(configuration);

const continuationWorkspace = process.env.PRE_RSI_CONTINUATION_WORKSPACE;
const continuationGoalRunId = process.env.PRE_RSI_CONTINUATION_GOAL_RUN_ID;
export default createResearchExtension({
	candidateExecutionBackend: backend,
	candidateVerifier: verifier,
	...(continuationWorkspace ? {
		newSessionCompaction: process.env.PRE_RSI_NEW_SESSION_COMPACTION === "200000",
		continuation: { workspace: continuationWorkspace,
			...(continuationGoalRunId ? { goalRunId: continuationGoalRunId } : {}) },
	} : {}),
});
