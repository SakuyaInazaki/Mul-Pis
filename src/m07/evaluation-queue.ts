/**
 * The boundary between generating candidates and evaluating them.
 *
 * Generation happens in the model session; evaluation happens here, in the
 * host. Almost all of the wall clock is on this side, so the two must not be
 * one pipeline: a model that waits for a compiler produces nothing, and an
 * evaluator that accepts work without bound turns a burst of submissions into
 * an unbounded backlog nobody can reason about.
 *
 * So this is a bounded queue. Concurrency says how many evaluations may run at
 * once and defaults to one, because a device measured by two processes at the
 * same time produces numbers that cannot be compared — raising it is a fidelity
 * decision for whoever knows the machine. Capacity says how many may wait, and
 * a full queue refuses the submission instead of growing: the refusal is the
 * backpressure signal that tells the caller to collect a finished run first.
 */
import { HarnessError } from "../types.ts";

export interface EvaluationQueueOptions {
	/** Evaluations allowed to run at once. Default 1. */
	concurrency?: number;
	/** Submissions allowed to wait. Default 8. */
	capacity?: number;
	now?: () => number;
}

export interface EvaluationQueueStatsV1 {
	accepted: number;
	/** Submissions refused because the queue was full. */
	rejected: number;
	completed: number;
	failed: number;
	running: number;
	queued: number;
	maxRunning: number;
	/** Deepest the queue has been: the compile backlog, in one number. */
	maxQueued: number;
	totalWaitMs: number;
	maxWaitMs: number;
}

export class EvaluationQueueFullError extends HarnessError {
	readonly queued: number;
	readonly capacity: number;
	constructor(queued: number, capacity: number) {
		super("m07.evaluation-queue",
			`the host evaluation queue is full (${queued} waiting, capacity ${capacity}); collect a finished run before submitting another`);
		this.name = "EvaluationQueueFullError";
		this.queued = queued;
		this.capacity = capacity;
	}
}

export interface EvaluationQueue {
	/** Run the job when a slot frees, in submission order. Rejects at once when full. */
	submit<T>(job: () => Promise<T>): Promise<T>;
	/** Throw now if there is no waiting slot, so a caller that will not await the
	 * job can refuse the request instead of discovering it when collecting. */
	assertCapacity(): void;
	stats(): EvaluationQueueStatsV1;
	/** Resolve once nothing is running or waiting. */
	drain(): Promise<void>;
}

interface Waiting {
	start(): void;
	submittedAt: number;
}

export function createEvaluationQueue(options: EvaluationQueueOptions = {}): EvaluationQueue {
	const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
	const capacity = Math.max(1, Math.trunc(options.capacity ?? 8));
	const now = options.now ?? (() => Date.now());
	const waiting: Waiting[] = [];
	const idle: Array<() => void> = [];
	let running = 0;
	const stats: EvaluationQueueStatsV1 = { accepted: 0, rejected: 0, completed: 0, failed: 0, running: 0,
		queued: 0, maxRunning: 0, maxQueued: 0, totalWaitMs: 0, maxWaitMs: 0 };

	const settleIdle = (): void => {
		if (running || waiting.length) return;
		for (const resolve of idle.splice(0)) resolve();
	};
	const pump = (): void => {
		while (running < concurrency && waiting.length) {
			const next = waiting.shift()!;
			stats.queued = waiting.length;
			const waited = Math.max(0, now() - next.submittedAt);
			stats.totalWaitMs += waited;
			if (waited > stats.maxWaitMs) stats.maxWaitMs = waited;
			running++;
			stats.running = running;
			if (running > stats.maxRunning) stats.maxRunning = running;
			next.start();
		}
		settleIdle();
	};
	return {
		submit<T>(job: () => Promise<T>): Promise<T> {
			if (waiting.length >= capacity) {
				stats.rejected++;
				return Promise.reject(new EvaluationQueueFullError(waiting.length, capacity));
			}
			stats.accepted++;
			return new Promise<T>((resolve, reject) => {
				const entry: Waiting = {
					submittedAt: now(),
					start: () => {
						let result: Promise<T>;
						try { result = job(); }
						catch (error) { result = Promise.reject(error as Error); }
						// The slot is freed and the next job started before the caller
						// resumes, so what it observes is the state the queue is in.
						const release = (): void => { running--; stats.running = running; pump(); };
						result.then(
							value => { stats.completed++; release(); resolve(value); },
							error => { stats.failed++; release(); reject(error as Error); },
						);
					},
				};
				waiting.push(entry);
				stats.queued = waiting.length;
				if (waiting.length > stats.maxQueued) stats.maxQueued = waiting.length;
				pump();
			});
		},
		assertCapacity(): void {
			if (waiting.length < capacity) return;
			stats.rejected++;
			throw new EvaluationQueueFullError(waiting.length, capacity);
		},
		stats: () => ({ ...stats }),
		drain(): Promise<void> {
			if (!running && !waiting.length) return Promise.resolve();
			return new Promise<void>(resolve => { idle.push(resolve); });
		},
	};
}
