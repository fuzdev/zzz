import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';

import {
	TERMINAL_ACK_DELAY,
	TERMINAL_ACK_RETRY_DELAY,
	TERMINAL_ACK_THRESHOLD_BYTES,
	TerminalOutputAcker,
	type TerminalAckOutcome
} from '#lib/terminal_helpers.ts';

/** An ack in flight, settled by the test. */
interface SentAck {
	bytes: number;
	settle: (outcome: TerminalAckOutcome) => Promise<void>;
}

let sent: Array<SentAck>;
let acker: TerminalOutputAcker;

/** The byte counts of every ack sent so far. */
const sent_bytes = (): Array<number> => sent.map((ack) => ack.bytes);

beforeEach(() => {
	vi.useFakeTimers();
	sent = [];
	acker = new TerminalOutputAcker({
		send: (bytes) =>
			new Promise((resolve) => {
				sent.push({
					bytes,
					settle: async (outcome) => {
						resolve(outcome);
						// let the acker's continuation run
						await vi.advanceTimersByTimeAsync(0);
					}
				});
			})
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('TerminalOutputAcker', () => {
	test('acks a little output after the delay, once', async () => {
		acker.consumed(10);
		acker.consumed(25);
		assert.deepEqual(sent_bytes(), [], 'nothing is sent per chunk');
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY - 1);
		assert.deepEqual(sent_bytes(), []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(sent_bytes(), [25], 'one ack covers both chunks');
		await sent[0]!.settle('ok');
		assert.strictEqual(acker.acked, 25);
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY * 10);
		assert.deepEqual(sent_bytes(), [25], 'nothing left to ack');
	});

	test('acks at once when the threshold is waiting', () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES - 1);
		assert.deepEqual(sent_bytes(), [], 'one byte short of the threshold waits');
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		assert.deepEqual(sent_bytes(), [TERMINAL_ACK_THRESHOLD_BYTES]);
	});

	test('measures the threshold from the last ack, not from zero', async () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		await sent[0]!.settle('ok');
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES + 10);
		assert.strictEqual(sent.length, 1, 'ten bytes past the last ack waits');
		acker.consumed(2 * TERMINAL_ACK_THRESHOLD_BYTES);
		assert.deepEqual(sent_bytes(), [
			TERMINAL_ACK_THRESHOLD_BYTES,
			2 * TERMINAL_ACK_THRESHOLD_BYTES
		]);
	});

	test('keeps one ack in flight and covers what was consumed meanwhile', async () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		acker.consumed(3 * TERMINAL_ACK_THRESHOLD_BYTES);
		acker.consumed(5 * TERMINAL_ACK_THRESHOLD_BYTES);
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY * 10);
		assert.deepEqual(sent_bytes(), [TERMINAL_ACK_THRESHOLD_BYTES], 'the rest waits on the first');

		// with a threshold or more waiting, the next follows the first at once
		acker.consumed(5 * TERMINAL_ACK_THRESHOLD_BYTES + 1);
		await sent[0]!.settle('ok');
		assert.deepEqual(sent_bytes(), [
			TERMINAL_ACK_THRESHOLD_BYTES,
			5 * TERMINAL_ACK_THRESHOLD_BYTES + 1
		]);
		await sent[1]!.settle('ok');
		assert.strictEqual(sent.length, 2);
		assert.strictEqual(acker.acked, 5 * TERMINAL_ACK_THRESHOLD_BYTES + 1);
	});

	test('what an ack in flight left under the threshold waits out the delay', async () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		acker.consumed(2 * TERMINAL_ACK_THRESHOLD_BYTES - 1);
		await sent[0]!.settle('ok');
		assert.strictEqual(sent.length, 1, 'round trips do not set the pace of the acks');
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY - 1);
		assert.strictEqual(sent.length, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(sent_bytes(), [
			TERMINAL_ACK_THRESHOLD_BYTES,
			2 * TERMINAL_ACK_THRESHOLD_BYTES - 1
		]);
	});

	test('an ack that left nothing waiting schedules nothing', async () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		await sent[0]!.settle('ok');
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	describe('against a backend that has paused the terminal', () => {
		// The backend's window (`OUTPUT_WINDOW_HIGH_BYTES` and
		// `OUTPUT_WINDOW_LOW_BYTES` in `pty_manager.rs`): it stops reading past
		// `HIGH` unacked bytes and, once stopped, reads again at `LOW` or under.
		const HIGH = 1024 * 1024;
		const LOW = 256 * 1024;

		/** Whether a backend that had `sent` bytes out stays paused at `acked`. */
		const stays_paused = (sent: number, acked: number): boolean => sent - acked > LOW;

		test('the threshold is within the low-water mark', () => {
			assert.isAtMost(TERMINAL_ACK_THRESHOLD_BYTES, LOW);
		});

		test('a client that has consumed everything acks at once', () => {
			// paused the moment it passed the high mark, with nothing acked
			const sent_total = HIGH + 1;
			assert.ok(stays_paused(sent_total, acker.acked));
			// the client works through it in pieces under the threshold
			const step = TERMINAL_ACK_THRESHOLD_BYTES - 1;
			for (let consumed = step; consumed < sent_total; consumed += step) {
				acker.consumed(consumed);
			}
			acker.consumed(sent_total);
			assert.isAbove(sent.length, 0, 'no timer has run');
			assert.strictEqual(vi.getTimerCount(), 0, 'and none is what the ack waits on');
		});

		test('however little over the low mark is unacked, it is acked at once', async () => {
			// the least a paused backend can be waiting for: one byte over the mark
			const acked = 5 * HIGH;
			acker.consumed(acked);
			await sent[0]!.settle('ok');
			const sent_total = acked + LOW + 1;
			assert.ok(stays_paused(sent_total, acker.acked));

			acker.consumed(sent_total);
			assert.deepEqual(sent_bytes(), [acked, sent_total], 'sent without the delay');
			assert.ok(!stays_paused(sent_total, sent.at(-1)!.bytes), 'and it reopens the window');
		});

		test('with an ack in flight, the rest follows when it returns', async () => {
			const first = TERMINAL_ACK_THRESHOLD_BYTES;
			acker.consumed(first);
			// everything else the paused backend sent is consumed meanwhile
			const sent_total = first + LOW + 1;
			acker.consumed(sent_total);
			assert.deepEqual(sent_bytes(), [first]);
			assert.ok(stays_paused(sent_total, first), 'the one in flight does not reopen it');

			await sent[0]!.settle('ok');
			assert.deepEqual(sent_bytes(), [first, sent_total], 'sent without the delay');
		});
	});

	test('ignores counts that go backwards', async () => {
		acker.consumed(100);
		acker.consumed(40);
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY);
		assert.deepEqual(sent_bytes(), [100]);
		await sent[0]!.settle('ok');
		acker.consumed(100);
		acker.consumed(99);
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY * 10);
		assert.strictEqual(sent.length, 1);
	});

	test('retries a failed ack after the retry delay, with the latest count', async () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES + 5);
		await sent[0]!.settle('retry');
		assert.strictEqual(sent.length, 1, 'no immediate resend');
		assert.strictEqual(acker.acked, 0, 'a failed ack acked nothing');
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY - 1);
		assert.strictEqual(sent.length, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(sent_bytes(), [
			TERMINAL_ACK_THRESHOLD_BYTES,
			TERMINAL_ACK_THRESHOLD_BYTES + 5
		]);
	});

	test('stops for good once the backend has no such terminal', async () => {
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		await sent[0]!.settle('stop');
		acker.consumed(10 * TERMINAL_ACK_THRESHOLD_BYTES);
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY * 10);
		assert.strictEqual(sent.length, 1);
	});

	test('stop cancels a pending ack and the follow-up of one in flight', async () => {
		acker.consumed(10);
		acker.stop();
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY * 10);
		assert.strictEqual(sent.length, 0);

		acker = new TerminalOutputAcker({
			send: (bytes) =>
				new Promise((resolve) => {
					sent.push({
						bytes,
						settle: async (outcome) => {
							resolve(outcome);
							await vi.advanceTimersByTimeAsync(0);
						}
					});
				})
		});
		acker.consumed(TERMINAL_ACK_THRESHOLD_BYTES);
		acker.consumed(2 * TERMINAL_ACK_THRESHOLD_BYTES);
		acker.stop();
		await sent[0]!.settle('ok');
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY * 10);
		assert.strictEqual(sent.length, 1);
	});
});
