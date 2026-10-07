import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createAgentSession, type CreateAgentSessionOptions, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { parseRoundReview } from "../src/m07/execution-loop.ts";
import { FakeSessionRunner, type FakeReplyFn } from "../src/runner/fake.ts";
import { certifyLocalNotIssued, certifyRequestNotSent, certifySettledLocalAdmissionStop,
	certifySettledTerminalResponse } from "../src/runner/operation-disposition.ts";
import { DeepSeekRequestContractError } from "../src/runner/deepseek-request-contract.ts";
import { DeepSeekCampaignBudget } from "../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";
import { PiSessionRunner } from "../src/runner/pi.ts";
import type { SessionRunner } from "../src/runner/types.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, reply: FakeReplyFn) {
 const root = await mkdtemp(path.join(tmpdir(), "m07-loop-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const ws = new Workspace(root);
 await mkdir(path.join(root, "problem"), { recursive: true });
 await writeFile(ws.problemFile, "bounded research problem\n");
 const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
 const baseline = await ws.startRun("M04", [{label:"problem",path:ws.problemFile}]); await ws.finishRun(baseline,"completed");
 const runner = new FakeSessionRunner(reply);
 const ctx: StageContext = {ws,store,runner,config:{roles:{execution:"fake/execution",reviewer:"fake/reviewer",research:"fake/research"},concurrency:1,tools:{}}};
 const controller = createM07Controller(ctx);
 const goal = await controller.begin({goal:"Evaluate a bounded candidate",problemRelation:"direct",constraints:["keep the plan"],successCriteria:["verified"],plan:"one candidate"});
 const guide = path.join(root,"guide.md"); await writeFile(guide,"Guide version one\n");
 return {root,ws,store,runner,controller,goal,guide,ctx};
}

function attestConfinedExecutionGrant(runner: FakeSessionRunner): void {
	(runner as SessionRunner).attestConfinedGrant = async handle => {
		const spec = JSON.parse(await readFile(handle.ref.specFile!, "utf8"));
		return spec.tools.kind === "execution" ? { version: 1, kind: "confined-campaign-files",
			root: spec.tools.root, writableFiles: ["result.txt"] } : undefined;
	};
}

const OFFLINE_DEEPSEEK = { id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek",
	api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true,
	input: ["text"], cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 10_000, maxTokens: 20 } as Model<"openai-completions">;

/** Exercise the actual Pi payload hook and campaign ledger, with no network. */
async function offlineM07PiRunner(invalidRequest: 1 | 2): Promise<{
	runner: SessionRunner; budget: DeepSeekCampaignBudget; httpRequests: () => number;
}> {
	const outputLimit = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-only",
		request: async () => new Response(JSON.stringify({ object: "list", data: [{
			id: "deepseek-flash", object: "model", name: "DeepSeek-V4.1-Flash",
			max_output_tokens: 20, context_window: 10_000,
		}] }), { status: 200 }) });
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", accountingMode: "accounting-only",
		providerOutputLimit: outputLimit, outputAccountingMarginTokens: 32 });
	let httpRequests = 0;
	const runtime = { getModels: () => [OFFLINE_DEEPSEEK],
		async streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { maxTokens?: number; onPayload?: (payload: unknown,
				model: Model<"openai-completions">) => Promise<unknown> }) {
			for (let index = 1; index <= invalidRequest; index++) {
				const messages: unknown[] = [{ role: "user", content: "offline" }];
				if (index === invalidRequest) messages.push({ role: "tool",
					tool_call_id: "orphan", content: "offline" });
				await options.onPayload?.({ model: model.id, messages,
					max_tokens: options.maxTokens }, model);
				httpRequests++;
			}
		},
	} as unknown as ModelRuntime;
	const sessionFactory = (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return { session: {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
			getActiveToolNames: () => options.tools ?? [],
			async prompt(text: string) {
				const user = { role: "user", content: text, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				await (options.modelRuntime as ModelRuntime).streamSimple(options.model!,
					{ messages } as never, {});
			},
			abort() {}, dispose() {},
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	const pi = new PiSessionRunner({ modelRuntime: runtime, createSession: sessionFactory,
		campaignBudget: budget });
	const runner: SessionRunner = {
		create: async spec => spec.tools.kind === "execution" ? pi.create({ ...spec,
			tools: { kind: "custom", tools: await createConfinedCampaignFileTools(spec.tools.root,
				{ writableFiles: ["result.txt", "lesson-delta.json"] }) } }) : pi.create(spec),
		resume: ref => pi.resume(ref),
		capabilities: () => pi.capabilities(),
		attestConfinedGrant: handle => pi.attestConfinedGrant(handle),
		checkpoint: (handle, envelope) => pi.checkpoint(handle, envelope),
		fork: request => pi.fork(request),
	};
	return { runner, budget, httpRequests: () => httpRequests };
}

test("until-ready execution continues past eight rounds without a host deadline", async t => {
 const f = await fixture(t, async ({spec, turnIndex}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:spec.label.includes("round-10-")?"ready":"revise",feedback:"Review the same candidate"});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),`candidate ${turnIndex}\n`);
  return `builder round ${turnIndex}`;
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"continue one candidate",inputs:[],expectedOutputs:["result.txt"],
  checks:["same candidate"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned");
 assert.equal(task.loopStopReason,"ready");
 assert.equal(task.executionRounds?.length,10);
 assert.equal((await f.controller.status(f.goal.runId)).executionState?.operations.length,10);
});

test("reviewer snapshot preserves more than 1,000 small work files", async t => {
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) {
   if (spec.tools.kind !== "read-dir") throw new Error("reviewer did not receive a read-dir snapshot");
   assert.ok((await readdir(spec.tools.root)).length > 1_000);
   assert.equal(await readFile(path.join(spec.tools.root,"piece-1000.txt"),"utf8"),"x");
   return JSON.stringify({verdict:"ready",feedback:"checked the complete copied work directory"});
  }
  if (spec.tools.kind === "execution") {
   const workRoot = spec.tools.root;
   for (let start=0; start<1_001; start+=100) {
    await Promise.all(Array.from({length: Math.min(100,1_001-start)},(_,offset) =>
     writeFile(path.join(workRoot,`piece-${String(start+offset).padStart(4,"0")}.txt`),"x")));
   }
  }
  return "candidate files ready for independent review";
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"review a many-file candidate",inputs:[],
  expectedOutputs:["piece-1000.txt"],checks:["complete snapshot"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned",task.executionFailure ?? "M07 task failed");
 assert.equal(task.loopStopReason,"ready");
 assert.ok(task.executionRounds?.[0].reviewerSnapshotPath);
 assert.ok(task.branchSource,task.branchUnavailableReason ?? "branch evidence was not frozen");
});

test("legacy caller quotas cannot stop a new M07 task or clip a long builder report", async t => {
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"checked"});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n");
  return "B".repeat(17_000);
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"new candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],
  mode:"execute",executionLoop:{maxRounds:1,deadlineAt:"2000-01-01T00:00:00.000Z"}});
 assert.deepEqual(task.executionLoop,{mode:"until-ready"});
 assert.equal(task.status,"returned");
 assert.equal(task.loopStopReason,"ready");
 assert.match(await readFile(task.reportPath!,"utf8"),/B{17000}/);
});

test("long builder report reaches an independent reviewer as complete readable evidence", async t => {
 const fullReport = "B".repeat(190_000);
 const f = await fixture(t, async ({spec,message}) => {
  if (spec.label.includes("reviewer")) {
   if (spec.tools.kind !== "read-dir") throw new Error("reviewer did not receive a read-dir snapshot");
   assert.ok(!message.includes("B".repeat(1_000)),"large report should not be inlined into reviewer prompt");
   const folder = message.match(/\.m07-builder-report-[a-f0-9-]+\/part-000001\.txt/)?.[0].split("/")[0];
   assert.ok(folder,"reviewer prompt should name the complete segmented report");
   const root = path.join(spec.tools.root,folder);
   const parts = (await readdir(root)).filter(name => name.startsWith("part-")).sort();
   assert.ok(parts.length > 1,"long lines must have readable segments");
   assert.equal((await Promise.all(parts.map(name => readFile(path.join(root,name),"utf8")))).join(""),fullReport);
   return JSON.stringify({verdict:"ready",feedback:"checked complete frozen report and candidate"});
  }
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n");
  return fullReport;
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"review complete long report",inputs:[],
  expectedOutputs:["result.txt"],checks:["complete report"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned",task.executionFailure ?? "M07 task failed");
 assert.equal(task.loopStopReason,"ready");
 assert.match(await readFile(task.executionRounds![0].builderReportPath,"utf8"),/^B{190000}$/);
});

test("oversized reviewer report is a file-size failure, not an invalid verdict", async t => {
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"R".repeat(512_000)});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n");
  return "candidate ready for review";
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"new candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],
  mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"failed");
 assert.match(task.executionFailure ?? "",/reviewer report file exceeds 512,000 UTF-8 bytes/);
 assert.notEqual(task.loopStopReason,"reviewer-invalid");
});

test("reviewer JSON repairs only literal paragraph breaks inside bounded feedback", () => {
 const malformed = '{"verdict":"revise","feedback":"Inspect the measured cases.\nOne target regressed; revise the candidate."}';
 assert.deepEqual(parseRoundReview(malformed), { verdict: "revise", feedback: "Inspect the measured cases.\nOne target regressed; revise the candidate." });
 const crlf = '{"verdict":"revise","feedback":"One checked case.\r\nAnother checked case."}';
 assert.equal(parseRoundReview(crlf).feedback, "One checked case.\r\nAnother checked case.");
 assert.deepEqual(parseRoundReview(JSON.stringify({ verdict: "ready", feedback: "All bounded checks passed." })),
  { verdict: "ready", feedback: "All bounded checks passed." });
 assert.throws(() => parseRoundReview('Reviewer says {"verdict":"ready","feedback":"looks good"}'), /JSON verdict/);
 assert.throws(() => parseRoundReview('{"verdict":"ready","feedback":"unterminated\nparagraph}'), /JSON verdict/);
 assert.throws(() => parseRoundReview('{"verdict":"accept","feedback":"looks good\nnow"}'), /nonempty feedback/);
 assert.throws(() => parseRoundReview('{"verdict":["ready"],"feedback":"looks good"}'), /nonempty feedback/);
 assert.equal(parseRoundReview('{"verdict":"ready","feedback":"' + "a".repeat(512_001) + '"}').feedback.length,512_001);
});

test("malformed reviewer verdicts repair in the same frozen read-only session without rerunning builder", async t => {
 const f = await fixture(t, async ({spec,turnIndex,message}) => {
  if (spec.label.includes("reviewer")) {
   if (turnIndex > 1) assert.match(message,/SAME independent read-only reviewer session/);
   return turnIndex === 1 ? "The answer is ready, but this is not JSON." :
    turnIndex === 2 ? JSON.stringify({verdict:"accept",feedback:"not a valid verdict"}) :
    JSON.stringify({verdict:"ready",feedback:"Checked the frozen candidate file"});
  }
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n");
  return "builder finished";
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"bounded candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned",task.executionFailure ?? "task failed");
 assert.equal(task.loopStopReason,"ready");
 assert.equal(task.executionRounds?.length,1);
 assert.equal(f.runner.created.filter(spec=>spec.tools.kind === "execution").length,1);
 assert.equal(f.runner.created.filter(spec=>spec.label.includes("reviewer")).length,1);
 assert.equal([...f.runner.sessions.values()].find(session=>session.spec.label.includes("reviewer"))?.turns,3);
 const taskDir=path.dirname(task.workDir);
 assert.match(await readFile(path.join(taskDir,"round-1-reviewer-attempt-1.md"),"utf8"),/not JSON/);
 assert.match(await readFile(path.join(taskDir,"round-1-reviewer-attempt-2.md"),"utf8"),/"accept"/);
 assert.equal(await readFile(path.join(taskDir,"round-1-reviewer.md"),"utf8"),
  await readFile(path.join(taskDir,"round-1-reviewer-attempt-3.md"),"utf8"));
 const result=path.join(task.workDir,"result.txt");
 const reviewed=await f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"checked",result:"passed",evidence:[result]}],artifacts:[result]});
 assert.equal(reviewed.status,"accepted");
});

test("reviewer prompt failure after malformed verdict stops without replaying builder operation", async t => {
 const f=await fixture(t,async ({spec,turnIndex})=>{
  if(spec.label.includes("reviewer")) {
   if(turnIndex===2) throw new Error("synthetic reviewer provider failure");
   return "not JSON";
  }
  if(spec.tools.kind==="execution") await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n");
  return "builder finished";
 });
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"failed");
 assert.match(task.executionFailure??"",/synthetic reviewer provider failure/);
 assert.equal(f.runner.created.filter(spec=>spec.tools.kind==="execution").length,1);
 assert.deepEqual((await f.controller.status(f.goal.runId)).executionState?.operations.map(op=>op.status),["response-received"]);
 assert.equal(await readFile(path.join(path.dirname(task.workDir),"round-1-reviewer-attempt-1.md"),"utf8"),"not JSON");
});

test("opt-in M07 repair keeps one builder, creates fresh reviewers, and preserves final review and candidate delta", async t => {
 const f = await fixture(t, async ({spec,turnIndex}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:spec.label.includes("round-1")?"revise":"ready",feedback:spec.label.includes("round-1")?"Fix the candidate":"Ready for independent final checks"});
  if (spec.tools.kind === "execution") {
   await writeFile(path.join(spec.tools.root,"result.txt"),turnIndex === 1 ? "first" : "second");
   await writeFile(path.join(spec.tools.root,"delta.json"),JSON.stringify({version:1,action:"propose",observation:"second output",hypothesis:"candidate",applicability:"this bounded case",evidencePaths:["result.txt"]}));
  }
  return `builder round ${turnIndex}`;
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"execute one candidate",inputs:[f.guide],planInput:f.guide,resourceInputs:[{id:"kernelwiki",version:"2026.04",input:f.guide}],expectedOutputs:["result.txt","delta.json"],lessonDeltaOutput:"delta.json",checks:["result inspected"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned"); assert.equal(task.loopStopReason,"ready");
 assert.equal(task.executionRounds?.length,2);
 assert.equal(task.executionRounds?.[0].verdict,"revise");
 assert.equal(task.executionRounds?.[1].verdict,"ready");
 assert.equal(f.runner.created.filter(s=>s.tools.kind === "execution").length,1);
 assert.match([...f.runner.sessions.values()].find(s=>s.spec.tools.kind === "execution")!.transcript[0].text,/kernelwiki@2026\.04/);
 const reviewers=f.runner.created.filter(s=>s.label.includes("reviewer"));
 assert.equal(reviewers.length,2); assert.notEqual(reviewers[0].tools.kind === "read-dir" ? reviewers[0].tools.root : "",reviewers[1].tools.kind === "read-dir" ? reviewers[1].tools.root : "");
 assert.equal((await f.controller.status(f.goal.runId)).executionState?.operations.length,2);
 const result=path.join(task.workDir,"result.txt");
 const reviewed=await f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"result inspected",result:"passed",evidence:[result]}],artifacts:[result]});
 assert.equal(reviewed.status,"accepted");
 assert.ok(reviewed.review?.artifacts.some(a=>a.sourcePath === path.join(task.workDir,"delta.json")));
 const checkpoint=await f.controller.checkpoint(f.goal.runId);
 assert.match(await readFile(checkpoint.feedbackPath,"utf8"),/delta\.json|candidate/i);
});

test("ready with oversized lesson delta becomes same-session revise, then repaired candidate is accepted", async t => {
 const f = await fixture(t, async ({spec, turnIndex, message}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"reviewed candidate files"});
  if (spec.tools.kind === "execution") {
   if (turnIndex === 2) assert.match(message,/lesson-delta\.json file exceeds 16,000 bytes/);
   await writeFile(path.join(spec.tools.root,"result.txt"),`candidate ${turnIndex}\n`);
   await writeFile(path.join(spec.tools.root,"delta.json"),JSON.stringify({version:1,action:"propose",observation:turnIndex === 1 ? "x".repeat(16_100) : "repaired candidate",applicability:"this bounded case",evidencePaths:["result.txt"]}));
  }
  return `builder round ${turnIndex}`;
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"repair file-bound candidate",inputs:[],expectedOutputs:["result.txt","delta.json"],lessonDeltaOutput:"delta.json",checks:["result inspected"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned",task.executionFailure ?? "task failed");
 assert.equal(task.loopStopReason,"ready");
 assert.deepEqual(task.executionRounds?.map(round=>round.verdict),["revise","ready"]);
 assert.match(task.executionRounds![0].feedback!,/16,000 bytes/);
 assert.equal(f.runner.created.filter(s=>s.tools.kind === "execution").length,1);
 const result=path.join(task.workDir,"result.txt");
 const reviewed=await f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"result inspected",result:"passed",evidence:[result]}],artifacts:[result]});
 assert.equal(reviewed.status,"accepted",reviewed.review?.failures.join("; ") ?? "");
});

test("final review rejects malformed lesson-delta schema and evidence paths", async t => {
 const cases: Array<[string,string,RegExp]> = [
  ["invalid JSON","{",/invalid or missing/],
  ["missing observation",JSON.stringify({version:1,action:"propose",applicability:"bounded",evidencePaths:["result.txt"]}),/lacks observation/],
  ["unpinned amendment",JSON.stringify({version:1,action:"amend",observation:"changed",applicability:"bounded",evidencePaths:["result.txt"]}),/pinned priorRef/],
  ["unsafe evidence",JSON.stringify({version:1,action:"propose",observation:"changed",applicability:"bounded",evidencePaths:["../outside.txt"]}),/invalid schema/],
  ["missing evidence",JSON.stringify({version:1,action:"propose",observation:"changed",applicability:"bounded",evidencePaths:["missing.txt"]}),/invalid or missing/],
  ["too many evidence paths",JSON.stringify({version:1,action:"propose",observation:"changed",applicability:"bounded",evidencePaths:Array(21).fill("result.txt")}),/invalid schema/],
 ];
 for (const [name,delta,reason] of cases) {
  await t.test(name,async t => {
   const f=await fixture(t,async ({spec})=>{if(spec.tools.kind==="execution"){await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n"); await writeFile(path.join(spec.tools.root,"delta.json"),delta);} return "candidate";});
   const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt","delta.json"],lessonDeltaOutput:"delta.json",checks:["checked"],mode:"execute"});
   const result=path.join(task.workDir,"result.txt");
   const reviewed=await f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"checked",result:"passed",evidence:[result]}],artifacts:[result]});
   assert.equal(reviewed.status,"rejected");
   assert.match(reviewed.review?.failures.join("; ")??"",reason);
  });
 }
});

test("ready reviewer cannot approve candidate changed afterward", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"ready",feedback:"reviewed snapshot"}); if(spec.tools.kind==="execution")await writeFile(path.join(spec.tools.root,"result.txt"),"reviewed"); return "done";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],planInput:f.guide,expectedOutputs:["result.txt"],checks:["same candidate"],mode:"execute",executionLoop:{mode:"until-ready"}});
 await writeFile(path.join(task.workDir,"result.txt"),"changed later");
 await assert.rejects(f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"same candidate",result:"passed",evidence:[path.join(task.workDir,"result.txt")]}],artifacts:[path.join(task.workDir,"result.txt")]}),/changed after ready/);
});

test("ready reviewer cannot approve extra evidence added after its snapshot", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"ready",feedback:"reviewed snapshot"}); if(spec.tools.kind==="execution")await writeFile(path.join(spec.tools.root,"result.txt"),"reviewed"); return "done";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt"],checks:["same candidate"],mode:"execute",executionLoop:{mode:"until-ready"}});
 await writeFile(path.join(task.workDir,"extra.txt"),"new unreviewed claim");
 await assert.rejects(f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"same candidate",result:"passed",evidence:[path.join(task.workDir,"extra.txt")]}],artifacts:[path.join(task.workDir,"result.txt"),path.join(task.workDir,"extra.txt")]}),/added after ready/);
});

test("blocked reviewer verdict can be reviewed as rejected but cannot be accepted", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"blocked",feedback:"still incomplete"}); if(spec.tools.kind==="execution")await writeFile(path.join(spec.tools.root,"result.txt"),"partial"); return "partial";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.loopStopReason,"blocked");
 const result=path.join(task.workDir,"result.txt");
 const reviewed=await f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"checked",result:"passed",evidence:[result]}],artifacts:[result]});
 assert.equal(reviewed.status,"rejected"); assert.match(reviewed.review?.failures.join(" ")??"",/without a ready handoff/);
});

test("round-two execution failure leaves unknown operation and blocks renewed execution", async t => {
 const f=await fixture(t,async ({spec,turnIndex})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"revise",feedback:"try again"}); if(spec.tools.kind==="execution"&&turnIndex===2) throw new Error("synthetic interrupted execution"); return "round one";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"failed"); assert.match(task.executionFailure ?? "", /synthetic interrupted execution/);
 const state=await f.controller.status(f.goal.runId);
 assert.deepEqual(state.executionState?.operations.map(x=>x.status),["response-received","unknown"]);
 await assert.rejects(f.controller.delegate(f.goal.runId,{objective:"do not retry",inputs:[],expectedOutputs:["next.txt"],checks:["checked"],mode:"execute"}),/副作用状态未知/);
});

test("an unbranded local-stop claim cannot settle an issued M07 operation", async t => {
	const f = await fixture(t, () => {
		throw Object.assign(new Error("campaign global CNY total exhausted after settled provider requests"),
			{ code: "runner.campaign.partial-settled",
				details: { settledProviderRequestCount: 1, rejectedBeforeTransport: true,
					stopReason: "total-cny-ceiling" } });
	});
	const task = await f.controller.delegate(f.goal.runId, { objective: "synthetic task", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute",
		executionLoop: { mode: "until-ready" } });
	assert.equal(task.status, "failed");
	const goal = await f.controller.status(f.goal.runId);
	assert.equal(goal.executionState?.operations[0].status, "unknown");
	assert.equal(goal.executionState?.operations[0].observationMethod, undefined);
});

test("legacy branded quota errors cannot certify a new M07 operation", async t => {
	for (const [label, makeError] of [
		["unsent provider-call quota", () => certifyLocalNotIssued({
			settledProviderRequestCount: 0, requestNotSent: true, stopReason: "provider-call-limit",
			admissionDecision: "provider-call-limit",
			effectScope: "factory-attested-confined-file-tools",
		}, "legacy call quota")],
		["partial settled CNY quota", () => certifySettledLocalAdmissionStop({
			settledProviderRequestCount: 1, rejectedBeforeTransport: true,
			stopReason: "total-cny-ceiling", effectScope: "factory-attested-confined-file-tools",
		}, "legacy CNY quota")],
	] as const) {
		await t.test(label, async sub => {
			const f = await fixture(sub, () => { throw makeError(); });
			// Make the old controller path's grant condition true. The receipt must
			// still be refused because quota certifications are historical only.
			attestConfinedExecutionGrant(f.runner);
			const task = await f.controller.delegate(f.goal.runId, { objective: "new task", inputs: [],
				expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute",
				executionLoop: { mode: "until-ready" } });
			assert.equal(task.status, "failed");
			assert.equal(task.loopStopReason, undefined);
			const goal = await f.controller.status(f.goal.runId);
			assert.equal(goal.lifecycle, "active");
			const operation = goal.executionState?.operations[0];
			assert.equal(operation?.status, "unknown");
			assert.equal(operation.observationMethod, undefined);
			assert.equal(operation.evidencePath, undefined);
			await assert.rejects(f.controller.delegate(f.goal.runId, { objective: "unsafe replay",
				inputs: [], expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute" }),
				/副作用状态未知/);
		});
	}
});

test("host-branded zero-request contract rejection is not issued and retains static controls", async t => {
	let prompts = 0;
	const f = await fixture(t, async ({ spec }) => {
		prompts++;
		if (prompts === 1) throw certifyRequestNotSent({ requestNotSent: true,
			noProviderRequestsInPrompt: true, effectScope: "factory-attested-confined-file-tools",
			violation: "missing-reasoning", messageIndex: 3 });
		if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root, "result.txt"), "candidate\n");
		return "new task completed";
	});
	attestConfinedExecutionGrant(f.runner);
	const task = await f.controller.delegate(f.goal.runId, { objective: "validate final request", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute",
		executionLoop: { mode: "until-ready" } });
	assert.equal(task.status, "failed");
	assert.equal(task.loopStopReason, "request-contract-invalid");
	const goal = await f.controller.status(f.goal.runId);
	assert.equal(goal.lifecycle, "active");
	const operation = goal.executionState?.operations[0];
	assert.equal(operation?.status, "not-issued");
	assert.equal(operation.observationMethod, "host-request-contract-preflight");
	assert.equal(path.basename(operation.evidencePath!), "request-contract-not-issued-receipt.json");
	const receipt = JSON.parse(await readFile(operation.evidencePath!, "utf8"));
	assert.deepEqual(Object.keys(receipt).sort(), ["version", "kind", "goalRunId", "taskId",
		"operationId", "requestNotSent", "noProviderRequestsInPrompt", "violation", "messageIndex",
		"effectScope", "observedAt"].sort());
	assert.equal(receipt.violation, "missing-reasoning");
	assert.equal(receipt.messageIndex, 3);
	assert.equal(receipt.requestNotSent, true);
	assert.equal(receipt.noProviderRequestsInPrompt, true);
	assert.doesNotMatch(await readFile(operation.evidencePath!, "utf8"), /secret|prompt text|tool_call_id/);
	const next = await f.controller.delegate(f.goal.runId, { objective: "fresh task", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute" });
	assert.equal(next.status, "returned");
});

test("a bare preflight error with forged not-sent flags leaves an issued operation UNKNOWN", async t => {
	const f = await fixture(t, () => {
		throw Object.assign(new DeepSeekRequestContractError("missing-reasoning", 3), {
			requestNotSent: true, noProviderRequestsInPrompt: true,
		});
	});
	attestConfinedExecutionGrant(f.runner);
	const task = await f.controller.delegate(f.goal.runId, { objective: "synthetic request", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute",
		executionLoop: { mode: "until-ready" } });
	assert.equal(task.status, "failed");
	assert.equal(task.loopStopReason, undefined);
	const operation = (await f.controller.status(f.goal.runId)).executionState?.operations[0];
	assert.equal(operation?.status, "unknown");
	assert.equal(operation.observationMethod, undefined);
	assert.equal(operation.evidencePath, undefined);
});

test("offline M07 plus Pi request preflight distinguishes zero transport from an earlier unreceived request", async t => {
	for (const invalidRequest of [1, 2] as const) {
		await t.test(invalidRequest === 1 ? "first request rejected" : "second request rejected", async sub => {
			const f = await fixture(sub, () => "unused");
			const live = await offlineM07PiRunner(invalidRequest);
			f.ctx.runner = live.runner;
			f.ctx.config.roles.execution = "deepseek/deepseek-flash:low";
			const task = await f.controller.delegate(f.goal.runId, { objective: "offline request preflight",
				inputs: [], expectedOutputs: ["result.txt"], checks: ["checked"],
				mode: "execute", executionLoop: { mode: "until-ready" } });
			assert.equal(task.status, "failed");
			assert.equal(task.loopStopReason,
				invalidRequest === 1 ? "request-contract-invalid" : undefined);
			const operation = (await f.controller.status(f.goal.runId)).executionState?.operations[0];
			assert.equal(live.httpRequests(), invalidRequest - 1);
			assert.equal(live.budget.requestAccountingAuditSnapshot().requests.length, invalidRequest - 1);
			assert.equal(operation?.status, invalidRequest === 1 ? "not-issued" : "unknown");
			if (invalidRequest === 1) {
				assert.equal(operation.observationMethod, "host-request-contract-preflight");
				const receipt = JSON.parse(await readFile(operation.evidencePath!, "utf8"));
				assert.equal(receipt.violation, "orphan-tool-result");
				assert.equal(receipt.messageIndex, 1);
				assert.equal(receipt.noProviderRequestsInPrompt, true);
			} else {
				assert.equal(operation.observationMethod, undefined);
				assert.equal(operation.evidencePath, undefined);
				assert.equal(live.budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
			}
		});
	}
});

test("a certified terminal-length response remains incomplete and distinct from an unknown", async t => {
	const f = await fixture(t, () => { throw certifySettledTerminalResponse({
		settledProviderRequestCount: 1, responseReceived: true,
		terminalStopReason: "length", taskComplete: false,
		effectScope: "factory-attested-confined-file-tools",
	}, "provider length response"); });
	attestConfinedExecutionGrant(f.runner);
	const task = await f.controller.delegate(f.goal.runId, { objective: "new task", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute",
		executionLoop: { mode: "until-ready" } });
	assert.equal(task.status, "failed");
	assert.equal(task.loopStopReason, "output-limit");
	const operation = (await f.controller.status(f.goal.runId)).executionState?.operations[0];
	assert.equal(operation?.status, "terminal-response-incomplete");
	assert.equal(operation.observationMethod, "host-terminal-response");
	assert.ok(operation.evidencePath);
});

test("changed plan copy and invalid candidate delta fail closed", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"ready",feedback:"ready"}); if(spec.tools.kind==="execution"){const [copy]=await readdir(path.join(spec.tools.root,"inputs")); await writeFile(path.join(spec.tools.root,"inputs",copy),"changed"); await writeFile(path.join(spec.tools.root,"result.txt"),"done");} return "done";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],planInput:f.guide,expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"failed"); assert.match(task.executionFailure??"",/changed a frozen plan/);
 const g=await fixture(t,async ({spec})=>{if(spec.tools.kind==="execution"){await writeFile(path.join(spec.tools.root,"result.txt"),"done"); await writeFile(path.join(spec.tools.root,"delta.json"),JSON.stringify({version:1,action:"propose",observation:"unsupported",applicability:"this case",evidencePaths:["../outside.txt"]}));}return "done";});
 const candidate=await g.controller.delegate(g.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt","delta.json"],lessonDeltaOutput:"delta.json",checks:["checked"],mode:"execute"});
 const reviewed=await g.controller.review(g.goal.runId,{taskId:candidate.taskId,checks:[{criterion:"checked",result:"passed",evidence:[path.join(candidate.workDir,"result.txt")]}],artifacts:[path.join(candidate.workDir,"result.txt")]});
 assert.equal(reviewed.status,"rejected"); assert.match(reviewed.review?.failures.join(" ")??"",/Candidate lesson delta/);
});

test("versioned resource must be a declared input and never enables discovered Pi skills", async t => {
 const f=await fixture(t,()=>"done");
 await assert.rejects(f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],resourceInputs:[{id:"kernelwiki",version:"2026.04",input:f.guide}],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute"}),/declared text input/);
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],resourceInputs:[{id:"kernelwiki",version:"2026.04",input:f.guide}],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute"});
 assert.equal(task.resourceInputs?.[0].version,"2026.04");
 assert.equal(f.runner.created[0].tools.kind,"execution");
});

test("single-turn execute also rejects modified bound references", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.tools.kind==="execution"){const [copy]=await readdir(path.join(spec.tools.root,"inputs")); await writeFile(path.join(spec.tools.root,"inputs",copy),"changed"); await writeFile(path.join(spec.tools.root,"result.txt"),"done");} return "done";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],resourceInputs:[{id:"kernelwiki",version:"2026.04",input:f.guide}],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute"});
 assert.equal(task.status,"failed"); assert.match(task.executionFailure??"",/changed a frozen plan or versioned resource/);
});

test("M07 rechecks the live knowledge epoch after session setup and before dispatch", async t => {
 let modelCalls=0;
 const f=await fixture(t,()=>{modelCalls++; return "must not dispatch";});
 const originalCreate=f.runner.create.bind(f.runner);
 f.runner.create=async spec=>{
  const handle=await originalCreate(spec);
  if(spec.tools.kind==="execution"){
   const proposal=await f.store.submitProposal({stage:"M04",runId:"new-evidence",ops:[{op:"create",type:"Q",title:"new issue",body:"new epoch",usageDecision:"candidate"}]});
   await f.store.merge(proposal.proposalId);
  }
  return handle;
 };
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute"});
 assert.equal(task.status,"failed"); assert.match(task.executionFailure??"",/snapshot or live limits changed before task dispatch/);
 assert.equal((await f.controller.status(f.goal.runId)).executionState?.operations[0].status,"not-issued");
 assert.equal(modelCalls,0);
});
