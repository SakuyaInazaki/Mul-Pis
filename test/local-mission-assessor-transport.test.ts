import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, type CreateAgentSessionOptions, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { PiSessionRunner } from "../src/runner/pi.ts";
import type { ReadReturnEvent, SessionSpec, TransportFailureDiagnostic } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

async function reads(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const result: ReadReturnEvent[] = [];
	async function visit(folder: string): Promise<void> {
		for (const name of await readdir(folder)) {
			const file = path.join(folder, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const text = await readFile(file, "utf8");
			if (!text) continue;
			result.push({ toolName, status: "returned", path: path.relative(root, file).replaceAll("\\", "/"),
				requested: {}, returned: { kind: "text", startLine: 1,
					endLine: text.split("\n").length - Number(text.endsWith("\n")), truncated: false },
				at: new Date().toISOString() });
		}
	}
	await visit(root);
	return result;
}

function offlinePi503(): { runner: PiSessionRunner; providerRequests: () => number } {
	const model = { id: "deepseek-flash", name: "Offline synthetic DeepSeek", provider: "deepseek",
		api: "openai-completions", baseUrl: "https://invalid.example", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000, maxTokens: 256 } as Model<"openai-completions">;
	let requests = 0;
	const fakeFetch: typeof fetch = async () => {
		requests++;
		return new Response("synthetic unavailable", { status: 503 });
	};
	const runtime = { getModels: () => [model], streamSimple(_runtimeModel: typeof model, _context: unknown,
		options: { fetch?: typeof fetch; onPayload?: (payload: unknown, resolvedModel: typeof model) => Promise<unknown>;
			onResponse?: (response: { status: number; headers: Record<string, string> }, resolvedModel: typeof model) => Promise<void> }) {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			await options.onPayload?.({ model: model.id, messages: [{ role: "user", content: "synthetic" }],
				max_tokens: model.maxTokens }, model);
			const response = await options.fetch!("https://invalid.example/offline", {});
			await options.onResponse?.({ status: response.status, headers: {} }, model);
			await response.text();
			const error = { role: "assistant", content: [], api: model.api, provider: model.provider,
				model: model.id, stopReason: "error", errorMessage: "synthetic provider failure",
				timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
					totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
			stream.push({ type: "error", reason: "error", error }); stream.end();
		})().catch(error => { throw error; });
		return stream;
	} } as unknown as ModelRuntime;
	const createSession = (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return { session: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
			messages, getActiveToolNames: () => options.tools ?? [],
			async prompt(text: string) {
				const user = { role: "user", content: text, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				const stream = (options.modelRuntime as ModelRuntime).streamSimple(options.model!,
					{ messages } as never, { fetch: fakeFetch });
				for await (const event of stream) if (event.type === "error") {
					messages.push(event.error); manager.appendMessage(event.error as never);
				}
			}, abort() {}, dispose() {} } } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	return { runner: new PiSessionRunner({ modelRuntime: runtime, createSession }),
		providerRequests: () => requests };
}

for (const providerPath of ["fake", "pi" ] as const) test(
	`default mission.run continues after a classified transient assessor stream failure (${providerPath})`, async t => {
	const evaluatorId = `test:assessor-transport-retry-${providerPath}`;
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-unresolved.txt";
			await writeFile(path.join(observationOutputDir, name), "No original answer was established.\n", { mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Unknown"] })),
				observations: [{ name, kind: "text" }], limitations: ["Synthetic only"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-assessor-transport-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "The synthetic original question remains open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let missionId = "", assessorCalls = 0, builders = 0, m04 = 0;
	const sourceRefs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
	const issue = { id: "original-gap", claim: "The original question is unresolved", status: "open",
		classification: "explicit-requirement", sourceRefs,
		implication: "A bounded investigation may produce new evidence" };
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (assessorCalls === 1 && providerPath === "fake")
				throw new HarnessError("runner.stop", "synthetic stream failed");
			if (assessorCalls === 3)
				throw new DOMException("intentional operator abort", "AbortError");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read grant missing");
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "The original answer remains unknown.", evidenceRefs: ["original-problem.txt"],
				unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Inspect a bounded synthetic avenue", obligationIds: ["answer"],
						addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "The avenue may establish a source-backed answer",
						expectedEvidence: "A reviewed bounded report", sourceRefs } } }),
				readReturns: await reads(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) { builders++; return "Unselected bounded report"; }
		if (spec.label === "M04-research") {
			m04++;
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			return { text: "The report remains unselected.",
				readReturns: await reads(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected session ${spec.label}`);
	});
	const create = runner.create.bind(runner);
	runner.create = async spec => {
		const handle = await create(spec);
		if (!spec.label.startsWith("local-original-objective-")) return handle;
		const diagnostics: TransportFailureDiagnostic[] = [];
		return { ...handle, transportDiagnostics: () => [...diagnostics],
			prompt: async message => {
				try { return await handle.prompt(message); }
				catch (error) {
					if (error instanceof HarnessError && error.code === "runner.stop") diagnostics.push({
						version: 1, promptIndex: 1, phase: "provider-stream", httpStatus: 503,
						responseStarted: true, bytesRead: 0, abortSource: null,
						providerErrorCode: null, providerErrorType: "server_error",
						providerRequestId: null, errorCodes: [] });
					throw error;
				}
			} };
	};
	const fakeCreate = runner.create.bind(runner);
	const offlinePi = providerPath === "pi" ? offlinePi503() : undefined;
	let piAssessorSessions = 0;
	if (offlinePi) runner.create = async (spec: SessionSpec) => {
		if (spec.label.startsWith("local-original-objective-") && piAssessorSessions === 0) {
			piAssessorSessions++;
			assessorCalls++;
			return offlinePi.runner.create(spec);
		}
		return fakeCreate(spec);
	};
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: providerPath === "pi" ? "deepseek/deepseek-flash:low" : "fake/research",
			execution: "fake/execution" },
			localMission: { evaluatorId }, concurrency: 1, tools: {} } });
	const begun = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original synthetic question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Establish the original answer",
			type: "synthetic-open" }], closure: "open-ended" });
	missionId = begun.contract.id;
	const result = await mission.run(missionId);
	assert.equal(assessorCalls, 3);
	assert.equal(builders, 1);
	assert.equal(m04, 1);
	assert.equal(result.boundedRuns.length, 1);
	assert.equal(result.objectiveOutcome, "incomplete");
	assert.deepEqual(result.selectedArtifacts, []);
	const missionRuns = await ws.listRuns("MISSION");
	assert.equal(missionRuns.length, 2);
	const records = await Promise.all(missionRuns.map(id => ws.readRun("MISSION", id)));
	assert(records.every(record => Number.isSafeInteger(record.startSequence)));
	const [firstRun] = records.sort((a, b) => a.startSequence! - b.startSequence!);
	assert(firstRun);
	const diagnosticOutput = firstRun.outputs.find(item => path.basename(item.path).startsWith("assessor-transport-"));
	const repairOutput = firstRun.outputs.find(item => path.basename(item.path).startsWith("assessor-repair-"));
	assert(diagnosticOutput && repairOutput, "failed provider attempt and retry decision must persist");
	const diagnostic = JSON.parse(await readFile(diagnosticOutput.path, "utf8")) as {
		classification: string; diagnostic: { httpStatus: number } };
	assert.equal(diagnostic.classification, "retryable");
	assert.equal(diagnostic.diagnostic.httpStatus, 503);
	assert.equal(runner.created.filter(spec => spec.label === "local-original-objective-1").length + piAssessorSessions, 2,
		"a transport retry needs a genuinely fresh read-only assessor");
	if (offlinePi) assert.equal(offlinePi.providerRequests(), 1,
		"the failed default Pi assessor made one offline provider request");
});
