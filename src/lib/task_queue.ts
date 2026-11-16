import { create_deferred, type Deferred } from '@fuzdev/fuz_util/async.ts';

/** A task waiting in a `TaskQueue`. */
interface QueuedTask {
	readonly fn: () => Promise<unknown>;
	readonly get_priority: (() => number) | undefined;
	readonly deferred: Deferred<unknown>;
}

/**
 * Runs async tasks at most `concurrency` at a time, the waiting ones in
 * priority order (lowest first), first come first served within a priority.
 * A task's priority is read when a slot frees up, not when it's queued, so
 * it can follow what changed meanwhile (a tab coming into view).
 *
 * Tasks start in a microtask, never synchronously from `run`: everything
 * queued in one turn is ordered by priority before any starts.
 *
 * Not fuz_util's `AsyncSemaphore`: it admits waiters first come first
 * served, with no priority.
 */
export class TaskQueue {
	readonly concurrency: number;

	#active = 0;
	readonly #waiting: Array<QueuedTask> = [];
	#pump_scheduled = false;

	/** @param concurrency - how many tasks run at once, at least 1 */
	constructor(concurrency: number) {
		if (!(concurrency >= 1)) throw new Error(`concurrency must be at least 1, got ${concurrency}`);
		this.concurrency = concurrency;
	}

	/** How many tasks are running. */
	get active(): number {
		return this.#active;
	}

	/** How many tasks are waiting for a slot. */
	get waiting(): number {
		return this.#waiting.length;
	}

	/**
	 * Queues `fn`.
	 *
	 * @param fn - the task
	 * @param get_priority - read when the task could start; lower runs first, default 0
	 * @returns what `fn` resolves to, or its rejection
	 */
	run<T>(fn: () => Promise<T>, get_priority?: () => number): Promise<T> {
		const deferred = create_deferred<T>();
		this.#waiting.push({ fn, get_priority, deferred: deferred as Deferred<unknown> });
		this.#schedule_pump();
		return deferred.promise;
	}

	#schedule_pump(): void {
		if (this.#pump_scheduled) return;
		this.#pump_scheduled = true;
		queueMicrotask(() => {
			this.#pump_scheduled = false;
			this.#pump();
		});
	}

	#pump(): void {
		while (this.#active < this.concurrency && this.#waiting.length > 0) {
			const task = this.#take_next();
			this.#active++;
			void this.#start(task);
		}
	}

	/** Removes and returns the waiting task with the lowest priority, the earliest among ties. */
	#take_next(): QueuedTask {
		let best_index = 0;
		let best_priority = Infinity;
		for (let i = 0; i < this.#waiting.length; i++) {
			const priority = this.#waiting[i]!.get_priority?.() ?? 0;
			if (priority < best_priority) {
				best_priority = priority;
				best_index = i;
			}
		}
		return this.#waiting.splice(best_index, 1)[0]!;
	}

	async #start(task: QueuedTask): Promise<void> {
		try {
			task.deferred.resolve(await task.fn());
		} catch (error) {
			task.deferred.reject(error);
		} finally {
			this.#active--;
			this.#pump();
		}
	}
}
