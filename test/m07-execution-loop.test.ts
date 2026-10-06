import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { parseRoundReview } from "../src/m07/execution-loop.ts";
import { FakeSessionRunner, type FakeReplyFn } from "../src/runner/fake.ts";
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
 return {root,ws,store,runner,controller,goal,guide};
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

test("nonrecoverable reviewer format still permits an honest rejected task and frozen fork", async t => {
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return "The answer is revise, but this is not JSON.";
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"candidate\n");
  return "builder finished";
 });
 const spec = { objective:"bounded candidate", inputs:[], expectedOutputs:["result.txt"], checks:["checked"], mode:"execute" as const,
  executionLoop:{ mode:"until-ready" as const } };
 const parent = await f.controller.delegate(f.goal.runId,spec);
 assert.equal(parent.status,"returned"); assert.equal(parent.loopStopReason,"reviewer-invalid");
 assert.ok(parent.branchSource, parent.branchUnavailableReason ?? "checkpoint unavailable");
 const reviewed = await f.controller.review(f.goal.runId,{taskId:parent.taskId,checks:[{criterion:"checked",result:"failed",evidence:[]}],
  artifacts:[path.join(parent.workDir,"result.txt")]});
 assert.equal(reviewed.status,"rejected");
 const context = {mode:"fork" as const,parentRunId:f.goal.runId,
  parentTaskId:parent.taskId,checkpointId:parent.branchSource!.checkpoint.id};
 await assert.rejects(f.controller.delegate(f.goal.runId,{...spec,executionLoop:undefined,context}),
  /review-loop obligations/);
 const child = await f.controller.delegate(f.goal.runId,{...spec,context});
 assert.equal(child.status,"returned", child.executionFailure ?? "fork failed");
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
