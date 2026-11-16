import { test, describe, assert } from 'vitest';
import { create_deferred, type Deferred } from '@fuzdev/fuz_util/async.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { TaskQueue } from '#lib/task_queue.ts';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Queues a task that records its start and waits for the test to finish it. */
const queue_task = (
	queue: TaskQueue,
	started: Array<string>,
	name: string,
	get_priority?: () => number
): { done: Promise<string>; deferred: Deferred<string> } => {
	const deferred = create_deferred<string>();
	const done = queue.run(() => {
		started.push(name);
		return deferred.promise;
	}, get_priority);
	return { done, deferred };
};

describe('TaskQueue', () => {
	test('runs at most `concurrency` tasks at once, starting the next as one finishes', async () => {
		const queue = new TaskQueue(2);
		const started: Array<string> = [];
		const a = queue_task(queue, started, 'a');
		queue_task(queue, started, 'b');
		queue_task(queue, started, 'c');
		assert.deepEqual(started, [], 'nothing starts synchronously');
		await flush();
		assert.deepEqual(started, ['a', 'b']);
		assert.strictEqual(queue.active, 2);
		assert.strictEqual(queue.waiting, 1);

		a.deferred.resolve('A');
		assert.strictEqual(await a.done, 'A');
		await flush();
		assert.deepEqual(started, ['a', 'b', 'c']);
	});

	test('starts the lowest priority first, in queue order among ties', async () => {
		const queue = new TaskQueue(1);
		const started: Array<string> = [];
		const first = queue_task(queue, started, 'first', () => 2);
		const tasks = [
			queue_task(queue, started, 'low', () => 2),
			queue_task(queue, started, 'high', () => 0),
			queue_task(queue, started, 'mid_1', () => 1),
			queue_task(queue, started, 'mid_2', () => 1)
		];
		await flush();
		assert.deepEqual(started, ['high']);
		for (const task of [first, ...tasks]) task.deferred.resolve('');
		await Promise.all(tasks.map((task) => task.done));
		await first.done;
		assert.deepEqual(started, ['high', 'mid_1', 'mid_2', 'first', 'low']);
	});

	test('reads a priority when a slot frees, not when queued', async () => {
		const queue = new TaskQueue(1);
		const started: Array<string> = [];
		let b_priority = 5;
		const a = queue_task(queue, started, 'a', () => 0);
		queue_task(queue, started, 'b', () => b_priority);
		queue_task(queue, started, 'c', () => 1);
		await flush();
		b_priority = 0;
		a.deferred.resolve('');
		await a.done;
		await flush();
		assert.deepEqual(started, ['a', 'b']);
	});

	test('a rejection reaches its caller and frees the slot', async () => {
		const queue = new TaskQueue(1);
		const failing = queue.run(() => Promise.reject(new Error('boom')));
		const next = queue.run(() => Promise.resolve('ok'));
		await assert_rejects(() => failing, /boom/);
		assert.strictEqual(await next, 'ok');
	});

	test('refuses a concurrency below 1', () => {
		assert.throws(() => new TaskQueue(0), /at least 1/);
	});
});
