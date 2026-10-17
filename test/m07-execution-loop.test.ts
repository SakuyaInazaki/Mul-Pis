import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";


import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner, type FakeReplyFn } from "../src/runner/fake.ts";







import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, reply: FakeReplyFn, continuous = false) {
 const root = await realpath(await mkdtemp(path.join(tmpdir(), "m07-loop-")));
 t.after(() => rm(root, { recursive: true, force: true }));
 const ws = new Workspace(root);
 await mkdir(path.join(root, "problem"), { recursive: true });
 await writeFile(ws.problemFile, "bounded research problem\n");
 const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
 const baseline = await ws.startRun("M04", [{label:"problem",path:ws.problemFile}]); await ws.finishRun(baseline,"completed");
 const runner = new FakeSessionRunner(reply);
 const ctx: StageContext = {ws,store,runner,config:{roles:{execution:"fake/execution",reviewer:"fake/reviewer",research:"fake/research"},concurrency:1,tools:{}}};
 const controller = createM07Controller(ctx);
 const goal = await controller.begin({goal:"Evaluate a bounded candidate",problemRelation:"direct",constraints:["keep the plan"],successCriteria:["verified"],plan:"one candidate"}, continuous ? {executionContract:"continuous"} : undefined);
 const guide = path.join(root,"guide.md"); await writeFile(guide,"Guide version one\n");
 return {root,ws,store,runner,controller,goal,guide,ctx};
}

test("host constraint additions affect only future task and reviewer messages", async t => {
 const added = "retain the newly supplied boundary";
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"checked result"});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"checked result");
  return "done";
 });
 const first = await f.controller.delegate(f.goal.runId,{objective:"record earlier task",inputs:[],expectedOutputs:[],checks:["recorded"],mode:"reason"});
 const oldMessage = [...f.runner.sessions.values()].at(-1)!.transcript[0].text;
 assert.doesNotMatch(oldMessage,/retain the newly supplied boundary/);
 const originalCriteria = [...f.goal.successCriteria];
 const supplemented = await f.controller.hostAddConstraints(f.goal.runId,{sourceEventId:"user-event-1",constraints:[added,added]});
 assert.deepEqual(supplemented.constraints,["keep the plan",added]);
 assert.deepEqual(supplemented.successCriteria,originalCriteria);
 assert.equal(supplemented.constraintAdditions?.[0].sourceEventId,"user-event-1");
 assert.ok(supplemented.constraintAdditions?.[0].recordedAt);
 const recordedAt = supplemented.constraintAdditions?.[0].recordedAt;
 const replay = await f.controller.hostAddConstraints(f.goal.runId,{sourceEventId:"user-event-1",constraints:[added]});
 assert.equal(replay.constraintAdditions?.length,1);
 assert.equal(replay.constraintAdditions?.[0].recordedAt,recordedAt);
 await assert.rejects(f.controller.hostAddConstraints(f.goal.runId,{sourceEventId:"user-event-1",constraints:["conflicting boundary"]}),/sourceEventId/);
 const next = await f.controller.delegate(f.goal.runId,{objective:"check later task",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(next.status,"returned");
 const sent = [...f.runner.sessions.values()].filter(session=>session.spec.tools.kind === "execution" || session.spec.label.includes("reviewer"));
 assert.equal(sent.length,2);
 for (const session of sent) assert.match(session.transcript[0].text,/retain the newly supplied boundary/);
 assert.equal([...f.runner.sessions.values()][0].transcript[0].text,oldMessage);
 assert.equal((await f.controller.status(f.goal.runId)).tasks.find(task=>task.taskId === first.taskId)?.taskId,first.taskId);

 const statePath = path.join(f.ws.runDir("M07",f.goal.runId),"goal.json");
 const raw = JSON.parse(await readFile(statePath,"utf8"));
 raw.tasks[0].status = "running";
 await writeFile(statePath,JSON.stringify(raw));
 await assert.rejects(f.controller.hostAddConstraints(f.goal.runId,{sourceEventId:"user-event-2",constraints:["another boundary"]}),/running/);
 raw.tasks[0].status = first.status;
 raw.executionState.operations[0].status = "unknown";
 await writeFile(statePath,JSON.stringify(raw));
 await assert.rejects(f.controller.hostAddConstraints(f.goal.runId,{sourceEventId:"user-event-2",constraints:["another boundary"]}),/未决外部操作/);
});

test("continuous execution cannot return on the builder's early finish without reviewer readiness", async t => {
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 let continued!: () => void;
 const enteredRepair = new Promise<void>(resolve => { continued = resolve; });
 const f = await fixture(t, async ({spec, turnIndex}) => {
  if (spec.tools.kind === "read-dir") {
   const actual = await readFile(path.join(spec.tools.root,"result.txt"),"utf8");
   return JSON.stringify({verdict:actual === "verified result" ? "ready" : "revise",feedback:`Checked result.txt: ${actual}`});
  }
  if (spec.tools.kind === "execution") {
   if (turnIndex === 2) { continued(); await gate; }
   await writeFile(path.join(spec.tools.root,"result.txt"),turnIndex === 1 ? "incomplete result" : "verified result");
  }
  return "Finished; return this task now.";
 }, true);
 const pending = f.controller.delegate(f.goal.runId,{objective:"produce a verified result",inputs:[],
  expectedOutputs:["result.txt"],checks:["result is verified"],mode:"execute"});
 try {
  const first = await Promise.race([enteredRepair.then(()=>"repair"),pending.then(()=>"returned")]);
  assert.equal(first,"repair","a normal builder finish must not bypass the controller review loop");
  const during = await f.controller.status(f.goal.runId);
  assert.equal(during.lifecycle,"active");
  assert.equal(during.tasks[0].status,"running");
  assert.deepEqual(during.tasks[0].executionLoop,{mode:"until-ready"});
 } finally { release(); }
 const task = await pending;
 assert.equal(task.status,"returned",task.executionFailure);
 assert.equal(task.loopStopReason,"ready");
 assert.deepEqual(task.executionRounds?.map(round=>round.verdict),["revise","ready"]);
 assert.equal(f.runner.created.filter(spec=>spec.tools.kind === "execution").length,1);
 const result = path.join(task.workDir,"result.txt");
 const reviewed = await f.controller.review(f.goal.runId,{taskId:task.taskId,artifacts:[result],
  checks:[{criterion:"result is verified",result:"passed",evidence:[result]}]});
 assert.equal(reviewed.status,"accepted");
 assert.equal((await f.controller.status(f.goal.runId)).lifecycle,"active");
 await assert.rejects(f.controller.finish(f.goal.runId,{outcome:"fulfilled",summary:"premature overall completion",returnPath:"user",
  goalChecks:[{criterion:"verified",result:"failed",evidence:[result]}]}),/fulfilled/);
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
	 const f=await fixture(t,async ({spec})=>{if(spec.label.includes("reviewer"))return JSON.stringify({verdict:"ready",feedback:"reviewed snapshot"}); if(spec.tools.kind==="execution") { await mkdir(path.join(spec.tools.root,"candidate","kernel"),{recursive:true}); await writeFile(path.join(spec.tools.root,"candidate","receipt.json"),'{"correct":true}\n'); await writeFile(path.join(spec.tools.root,"candidate","kernel","src.py"),"reviewed"); } return "done";});
	 const task=await f.controller.delegate(f.goal.runId,{objective:"candidate",inputs:[f.guide],planInput:f.guide,expectedOutputs:["candidate"],checks:["same candidate"],mode:"execute",executionLoop:{mode:"until-ready"}});
	 const receipt=path.join(task.workDir,"candidate","receipt.json");
	 await writeFile(path.join(task.workDir,"candidate","kernel","src.py"),"changed later");
	 await assert.rejects(f.controller.review(f.goal.runId,{taskId:task.taskId,checks:[{criterion:"same candidate",result:"passed",evidence:[receipt]}],artifacts:[receipt]}),/changed after ready/);
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
