import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
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
const deadlineAt = () => new Date(Date.now()+60_000).toISOString();

test("opt-in M07 repair keeps one builder, creates fresh reviewers, and preserves final review and candidate delta", async t => {
 const f = await fixture(t, async ({spec,turnIndex}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:spec.label.includes("round-1")?"revise":"ready",feedback:spec.label.includes("round-1")?"Fix the candidate":"Ready for independent final checks"});
  if (spec.tools.kind === "execution") {
   await writeFile(path.join(spec.tools.root,"result.txt"),turnIndex === 1 ? "first" : "second");
   await writeFile(path.join(spec.tools.root,"delta.json"),JSON.stringify({version:1,action:"propose",observation:"second output",hypothesis:"candidate",applicability:"this bounded case",evidencePaths:["result.txt"]}));
  }
  return `builder round ${turnIndex}`;
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"execute one candidate",inputs:[f.guide],planInput:f.guide,resourceInputs:[{id:"kernelwiki",version:"2026.04",input:f.guide}],expectedOutputs:["result.txt","delta.json"],lessonDeltaOutput:"delta.json",checks:["result inspected"],mode:"execute",executionLoop:{maxRounds:2,deadlineAt:deadlineAt()}});
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
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],planInput:f.guide,expectedOutputs:["result.txt"],checks:["same candidate"],mode:"execute",executionLoop:{maxRounds:1,deadlineAt:deadlineAt()}});
 await writeFile(path.join(task.workDir,"result.txt"),"changed later");
 await assert.rejects(f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"same candidate",result:"passed",evidence:[path.join(task.workDir,"result.txt")]}],artifacts:[path.join(task.workDir,"result.txt")]}),/changed after ready/);
});

test("ready reviewer cannot approve extra evidence added after its snapshot", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"ready",feedback:"reviewed snapshot"}); if(spec.tools.kind==="execution")await writeFile(path.join(spec.tools.root,"result.txt"),"reviewed"); return "done";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt"],checks:["same candidate"],mode:"execute",executionLoop:{maxRounds:1,deadlineAt:deadlineAt()}});
 await writeFile(path.join(task.workDir,"extra.txt"),"new unreviewed claim");
 await assert.rejects(f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"same candidate",result:"passed",evidence:[path.join(task.workDir,"extra.txt")]}],artifacts:[path.join(task.workDir,"result.txt"),path.join(task.workDir,"extra.txt")]}),/added after ready/);
});

test("max-round stop can be reviewed as rejected but cannot be accepted", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"revise",feedback:"still incomplete"}); if(spec.tools.kind==="execution")await writeFile(path.join(spec.tools.root,"result.txt"),"partial"); return "partial";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{maxRounds:1,deadlineAt:deadlineAt()}});
 assert.equal(task.loopStopReason,"max-rounds");
 const result=path.join(task.workDir,"result.txt");
 const reviewed=await f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"checked",result:"passed",evidence:[result]}],artifacts:[result]});
 assert.equal(reviewed.status,"rejected"); assert.match(reviewed.review?.failures.join(" ")??"",/without a ready handoff/);
});

test("round-two abort leaves unknown operation and blocks renewed execution", async t => {
 const f=await fixture(t,async ({spec,turnIndex})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"revise",feedback:"try again"}); if(spec.tools.kind==="execution"&&turnIndex===2)return new Promise<string>(()=>{}); return "round one";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{maxRounds:2,deadlineAt:new Date(Date.now()+500).toISOString()}});
 assert.equal(task.status,"failed"); assert.equal(task.loopStopReason,"deadline");
 const state=await f.controller.status(f.goal.runId);
 assert.deepEqual(state.executionState?.operations.map(x=>x.status),["response-received","unknown"]);
 await assert.rejects(f.controller.delegate(f.goal.runId,{objective:"do not retry",inputs:[],expectedOutputs:["next.txt"],checks:["checked"],mode:"execute"}),/副作用状态未知/);
});

test("changed plan copy and invalid candidate delta fail closed", async t => {
 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"ready",feedback:"ready"}); if(spec.tools.kind==="execution"){const [copy]=await readdir(path.join(spec.tools.root,"inputs")); await writeFile(path.join(spec.tools.root,"inputs",copy),"changed"); await writeFile(path.join(spec.tools.root,"result.txt"),"done");} return "done";});
 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],planInput:f.guide,expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{maxRounds:1,deadlineAt:deadlineAt()}});
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
