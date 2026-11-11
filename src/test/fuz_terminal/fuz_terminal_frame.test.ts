import { test, describe, assert } from 'vitest';

import { FuzTerminalFrameLoop } from '#lib/fuz_terminal/fuz_terminal_frame.ts';

import { create_manual_frame_scheduler } from './fuz_terminal_test_helpers.ts';

/** For a loop whose frame never throws. */
const unexpected = (error: unknown): never => assert.fail(String(error));

describe('FuzTerminalFrameLoop', () => {
	test('idle until requested; many requests schedule one frame', () => {
		const scheduler = create_manual_frame_scheduler();
		let frames = 0;
		const loop = new FuzTerminalFrameLoop(scheduler, () => frames++, unexpected);
		assert.strictEqual(scheduler.requested, 0);
		assert.strictEqual(scheduler.pending, 0);
		for (let i = 0; i < 50; i++) loop.request();
		assert.strictEqual(scheduler.pending, 1);
		assert.strictEqual(scheduler.requested, 1);
		assert.strictEqual(scheduler.step(), 1);
		assert.strictEqual(frames, 1);
		assert.strictEqual(scheduler.pending, 0);
		// nothing more until another request
		assert.strictEqual(scheduler.step(), 0);
		assert.strictEqual(frames, 1);
	});

	test('a request from inside the frame schedules the next one', () => {
		const scheduler = create_manual_frame_scheduler();
		let frames = 0;
		const loop = new FuzTerminalFrameLoop(
			scheduler,
			() => {
				frames++;
				if (frames < 3) loop.request();
			},
			unexpected
		);
		loop.request();
		scheduler.step();
		assert.strictEqual(scheduler.pending, 1);
		scheduler.step();
		scheduler.step();
		assert.strictEqual(frames, 3);
		assert.strictEqual(scheduler.pending, 0);
		assert.strictEqual(scheduler.requested, 3);
	});

	test('stop cancels the pending frame and refuses later requests', () => {
		const scheduler = create_manual_frame_scheduler();
		let frames = 0;
		const loop = new FuzTerminalFrameLoop(scheduler, () => frames++, unexpected);
		loop.request();
		loop.stop();
		assert.strictEqual(scheduler.pending, 0);
		assert.strictEqual(scheduler.pending, 0, 'cancelled with the scheduler');
		loop.request();
		assert.strictEqual(scheduler.requested, 1);
		assert.strictEqual(scheduler.step(), 0);
		assert.strictEqual(frames, 0);
		loop.stop();
	});

	test('a callback that runs after stop (a scheduler that ignores cancels) draws nothing', () => {
		const scheduler = create_manual_frame_scheduler();
		let frames = 0;
		const loop = new FuzTerminalFrameLoop(
			{ request_frame: scheduler.request_frame, cancel_frame: () => {} },
			() => frames++,
			unexpected
		);
		loop.request();
		loop.stop();
		scheduler.step();
		assert.strictEqual(frames, 0);
	});

	test('an exception out of the frame goes to on_error, and the loop goes on', () => {
		const scheduler = create_manual_frame_scheduler();
		const errors: Array<unknown> = [];
		const boom = new Error('boom');
		let throws = true;
		let frames = 0;
		const loop = new FuzTerminalFrameLoop(
			scheduler,
			() => {
				frames++;
				if (throws) throw boom;
			},
			(error) => errors.push(error)
		);
		loop.request();
		scheduler.step();
		assert.deepEqual(errors, [boom]);
		throws = false;
		loop.request();
		scheduler.step();
		assert.strictEqual(frames, 2);
		assert.strictEqual(errors.length, 1);
	});
});
