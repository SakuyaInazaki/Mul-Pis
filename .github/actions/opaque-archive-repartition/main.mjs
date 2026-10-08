import path from "node:path";
import { runOpaqueArchiveRepartitionFromFile } from
	"../../../scripts/repartition-opaque-actions-artifact.ts";

try {
	const env = process.env;
	if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "push" ||
		env.GITHUB_REPOSITORY !== "SakuyaInazaki/Mul-Pis" ||
		env.GITHUB_REF !== "refs/heads/run-requests/opaque-artifact-repartition" ||
		env.GITHUB_ACTOR !== "SakuyaInazaki" || env.GITHUB_RUN_ATTEMPT !== "1" ||
		!env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE) ||
		!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) ||
		!env.GITHUB_TOKEN || !env.GITHUB_RUN_ID || !env.GITHUB_SHA)
		throw new Error("Actions source identity is unavailable");
	const packageName = "@actions/artifact";
	const { DefaultArtifactClient } = await import(packageName);
	const result = await runOpaqueArchiveRepartitionFromFile({
		requestFile: path.join(env.GITHUB_WORKSPACE, "opaque-repartition-request.json"),
		githubToken: env.GITHUB_TOKEN,
		transport: { runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
			commit: env.GITHUB_SHA },
		temporaryParent: env.RUNNER_TEMP,
		client: new DefaultArtifactClient(),
	});
	console.log(`Verified opaque archive repartition published ${result.parts.length} chunks and a final index.`);
} catch {
	console.error("Opaque archive repartition did not complete; no result should be trusted without a final index.");
	process.exitCode = 1;
}
