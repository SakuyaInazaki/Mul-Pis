import assert from "node:assert/strict";
import test from "node:test";
import { createEvaluationQueue, EvaluationQueueFullError } from "../src/m07/evaluation-queue.ts";

function gate(): { wait: Promise<void>; open: () => void } {
	let open!: () => void;
	const wait = new Promise<void>(resolve => { open = resolve; });
	return { wait, open };
}

test("evaluations run in submission order, one at a time by default", async () => {
	const queue = createEvaluationQueue();
	const started: string[] = [];
	const finished: string[] = [];
	const gates = { a: gate(), b: gate(), c: gate() };
	const job = (id: "a" | "b" | "c") => queue.submit(async () => {
		started.push(id);
		await gates[id].wait;
		finished.push(id);
		return id;
	});
	const all = [job("a"), job("b"), job("c")];
	await Promise.resolve();
	// Only the first is running; the other two wait rather than contending for the device.
	assert.deepEqual(started, ["a"]);
	assert.equal(queue.stats().queued, 2);
	assert.equal(queue.stats().running, 1);
	gates.a.open();
	await all[0];
	await Promise.resolve();
	assert.deepEqual(started, ["a", "b"]);
	gates.b.open(); gates.c.open();
	assert.deepEqual(await Promise.all(all), ["a", "b", "c"]);
	assert.deepEqual(finished, ["a", "b", "c"]);
	const stats = queue.stats();
	assert.deepEqual([stats.accepted, stats.completed, stats.failed, stats.rejected], [3, 3, 0, 0]);
	assert.deepEqual([stats.maxRunning, stats.maxQueued, stats.running, stats.queued], [1, 2, 0, 0]);
	await queue.drain();
});

test("a host that raises concurrency gets it, and the queue still orders the rest", async () => {
	const queue = createEvaluationQueue({ concurrency: 2 });
	const running: string[] = [];
	const gates = { a: gate(), b: gate(), c: gate() };
	const job = (id: "a" | "b" | "c") => queue.submit(async () => { running.push(id); await gates[id].wait; return id; });
	const all = [job("a"), job("b"), job("c")];
	await Promise.resolve();
	assert.deepEqual(running, ["a", "b"]);
	assert.equal(queue.stats().maxRunning, 2);
	gates.a.open(); gates.b.open(); gates.c.open();
	assert.deepEqual(await Promise.all(all), ["a", "b", "c"]);
	assert.deepEqual(running, ["a", "b", "c"]);
});

test("a full queue refuses the submission instead of growing", async () => {
	const queue = createEvaluationQueue({ capacity: 2 });
	const held = gate();
	const accepted = [queue.submit(async () => { await held.wait; return 1; }),
		queue.submit(async () => 2), queue.submit(async () => 3)];
	await Promise.resolve();
	assert.equal(queue.stats().queued, 2);
	const refused = queue.submit(async () => 4);
	await assert.rejects(refused, (error: Error) => error instanceof EvaluationQueueFullError &&
		/queue is full \(2 waiting, capacity 2\); collect a finished run/.test(error.message));
	assert.equal(queue.stats().rejected, 1);
	held.open();
	assert.deepEqual(await Promise.all(accepted), [1, 2, 3]);
	// Refusing never loses the work that was accepted, and the queue stays usable.
	assert.equal(await queue.submit(async () => 5), 5);
	assert.deepEqual([queue.stats().accepted, queue.stats().completed], [4, 4]);
});

test("a failed evaluation frees its slot and is counted apart from the completed ones", async () => {
	const queue = createEvaluationQueue({ now: (() => { let t = 0; return () => (t += 10); })() });
	await assert.rejects(queue.submit(async () => { throw new Error("backend exploded"); }), /backend exploded/);
	await assert.rejects(queue.submit(() => { throw new Error("thrown before the promise"); }), /thrown before the promise/);
	assert.equal(await queue.submit(async () => "after"), "after");
	const stats = queue.stats();
	assert.deepEqual([stats.accepted, stats.completed, stats.failed, stats.running], [3, 1, 2, 0]);
	assert.equal(stats.maxWaitMs >= 0, true);
	await queue.drain();
});

test("drain resolves only when nothing is running or waiting", async () => {
	const queue = createEvaluationQueue();
	const held = gate();
	let drained = false;
	const work = [queue.submit(async () => { await held.wait; return 1; }), queue.submit(async () => 2)];
	const draining = queue.drain().then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false);
	held.open();
	await Promise.all(work);
	await draining;
	assert.equal(drained, true);
	assert.deepEqual([queue.stats().running, queue.stats().queued], [0, 0]);
});

test("a caller that will not await can refuse up front, and the refusal is counted once", async () => {
	const queue = createEvaluationQueue({ capacity: 1 });
	const held = gate();
	const running = queue.submit(async () => { await held.wait; return "held"; });
	const waiting = queue.submit(async () => "waiting");
	assert.throws(() => queue.assertCapacity(), EvaluationQueueFullError);
	assert.equal(queue.stats().rejected, 1);
	held.open();
	assert.deepEqual(await Promise.all([running, waiting]), ["held", "waiting"]);
	// With the slot free again the same check passes.
	assert.equal(queue.assertCapacity(), undefined);
	assert.equal(queue.stats().rejected, 1);
});
