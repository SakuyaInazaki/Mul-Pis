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

async function fixture(t: TestContext, reply: FakeReplyFn, continuous = false, prepareStore?: (store: ReturnType<typeof createFileKnowledgeStore>) => Promise<void>) {
 const root = await realpath(await mkdtemp(path.join(tmpdir(), "m07-loop-")));
 t.after(() => rm(root, { recursive: true, force: true }));
 const ws = new Workspace(root);
 await mkdir(path.join(root, "problem"), { recursive: true });
 await writeFile(ws.problemFile, "bounded research problem\n");
 const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
 if (prepareStore) await prepareStore(store);
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

test("continuous execute returns a negative task result without an implicit reviewer and keeps the goal active", async t => {
 const f = await fixture(t, async ({spec}) => {
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"incomplete result");
  return "The candidate did not meet the original check.";
 }, true);
 const task = await f.controller.delegate(f.goal.runId,{objective:"produce a verified result",inputs:[],
  expectedOutputs:["result.txt"],checks:["result is verified"],mode:"execute"});
 assert.equal(task.status,"returned",task.executionFailure);
 assert.equal(task.executionLoop,undefined);
 assert.equal(task.executionRounds,undefined);
 assert.equal(f.runner.created.filter(spec=>spec.role === "reviewer").length,0);
 const result = path.join(task.workDir,"result.txt");
 const reviewed = await f.controller.review(f.goal.runId,{taskId:task.taskId,artifacts:[result],
  checks:[{criterion:"result is verified",result:"failed",evidence:[result]}]});
 assert.equal(reviewed.status,"rejected");
 assert.equal((await f.controller.status(f.goal.runId)).lifecycle,"active");
 await assert.rejects(f.controller.finish(f.goal.runId,{outcome:"partial",summary:"negative task fact",returnPath:"continue",
  goalChecks:[{criterion:"verified",result:"not_run",evidence:[]}]}),/continuous/);
 await assert.rejects(f.controller.finish(f.goal.runId,{outcome:"fulfilled",summary:"premature overall completion",returnPath:"user",
  goalChecks:[{criterion:"verified",result:"failed",evidence:[]}]}),/fulfilled/);
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

test("fresh reviewer receives the builder's frozen knowledge and root output remains reviewable", async t => {
 const premise = "Measured cases cover only the observed conditions; impossibility of the target remains unproved.";
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"checked the scoped evidence"});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"local observation");
  return "This local observation closes the route.";
 }, false, async store => {
  const proposal = await store.submitProposal({stage:"M04",runId:"review-context",ops:[
   {op:"create",type:"Q",title:"Target scope limit",body:premise,usageDecision:"adopted"},
   {op:"create",type:"K",title:"Scoped executor method",body:"Use only after checking its limits",usageDecision:"adopted",fields:{experience:{version:1,targetKind:"executor",applicableStages:["M07"],requiredTags:["execute"],excludedTags:[],requiredRefs:[]}}},
  ]});
  assert.equal(proposal.structurallyValid,true);
  await store.merge(proposal.proposalId);
 });
 const storeId = await f.store.storeId();
 const task = await f.controller.delegate(f.goal.runId,{objective:"inspect a local observation",inputs:[],knowledgeIds:["Q001@1"],experienceRefs:[{storeId,recordId:"K001",version:1}],expectedOutputs:["."],checks:["observation recorded"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned",task.executionFailure);
 const builder = [...f.runner.sessions.values()].find(session=>session.spec.tools.kind === "execution")!;
 assert.match(builder.transcript[0].text,/Measured cases cover only the observed conditions/);
 const reviewer = [...f.runner.sessions.values()].find(session=>session.spec.label.includes("round-1-reviewer"))!;
 assert.equal(reviewer.spec.tools.kind,"read-dir");
 const prompt = reviewer.transcript[0].text;
 assert.match(prompt,/Q001@1/);
 assert.match(prompt,/K001@1/);
 assert.match(prompt,/"requiredTags":\["execute"\]/);
 assert.match(prompt,/Measured cases cover only the observed conditions/);
 assert.match(prompt,/快照：/);
 assert.match(prompt,/A documented negative experiment can be ready for a diagnostic or bounded-attempt task/);
 assert.match(prompt,/Do not demand another submission, evaluation, or new kernel beyond this task's authorization/);
 const result = path.join(task.workDir,"result.txt");
 const reviewed = await f.controller.review(f.goal.runId,{taskId:task.taskId,artifacts:[result],checks:[{criterion:"observation recorded",result:"passed",evidence:[result]}]});
 assert.equal(reviewed.status,"accepted",reviewed.review?.failures.join("; "));
});

test("long builder report handoff is not counted as a root candidate output", async t => {
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"read frozen handoff and result"});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"actual candidate");
  return "R".repeat(190_000);
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"inspect the actual output",inputs:[],expectedOutputs:["."],checks:["actual output exists"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(task.status,"returned",task.executionFailure);
 assert.ok(task.executionRounds?.[0].builderReportHandoffDir);
 const result = path.join(task.workDir,"result.txt");
 const reviewed = await f.controller.review(f.goal.runId,{taskId:task.taskId,artifacts:[result],checks:[{criterion:"actual output exists",result:"passed",evidence:[result]}]});
 assert.equal(reviewed.status,"accepted",reviewed.review?.failures.join("; "));
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

test("the until-ready loop stops at its frozen round bound instead of revising forever", async t => {
 let rounds = 0;
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"revise",feedback:"keep going"});
  if (spec.tools.kind === "execution") { rounds++; await writeFile(path.join(spec.tools.root,"result.txt"),`attempt ${rounds}`); }
  return "another attempt";
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"bounded rounds",inputs:[],expectedOutputs:["result.txt"],checks:["bounded"],mode:"execute",executionLoop:{mode:"until-ready",maxRounds:2}});
 assert.equal(task.status,"returned");
 assert.equal(rounds,2,"the builder is prompted exactly twice");
 assert.equal(task.loopStopReason,"max-rounds");
 assert.equal(task.executionRounds?.length,2);
 const past = await f.controller.delegate(f.goal.runId,{objective:"expired deadline",inputs:[],expectedOutputs:["result.txt"],checks:["bounded"],mode:"execute",executionLoop:{mode:"until-ready",maxRounds:5,deadlineAt:new Date(Date.now()-1000).toISOString()}});
 assert.equal(past.loopStopReason,"deadline","an expired deadline stops the loop before a new round is issued");
 assert.equal(past.executionRounds?.length,0);
});

test("a task deadline reaches the builder and reviewer sessions as an observed fact", async t => {
 const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
 const f = await fixture(t, async ({spec}) => {
  if (spec.label.includes("reviewer")) return JSON.stringify({verdict:"ready",feedback:"checked"});
  if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root,"result.txt"),"done");
  return "done";
 });
 const task = await f.controller.delegate(f.goal.runId,{objective:"deadline is observable",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready",maxRounds:2,deadlineAt}});
 assert.equal(task.status,"returned");
 const specs = f.runner.created.filter(spec => spec.label.startsWith("M07-"));
 assert.ok(specs.length >= 2, "builder and reviewer sessions were both created");
 for (const spec of specs) assert.equal(spec.runDeadline, deadlineAt);
 const noDeadline = await f.controller.delegate(f.goal.runId,{objective:"no deadline",inputs:[],expectedOutputs:["result.txt"],checks:["checked"],mode:"execute",executionLoop:{mode:"until-ready"}});
 assert.equal(noDeadline.status,"returned");
 assert.equal(f.runner.created.at(-1)!.runDeadline, undefined, "no deadline means no invented horizon");
});
