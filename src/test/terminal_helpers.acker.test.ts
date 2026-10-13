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

		// the final ack follows the first without waiting for more output, even
		// when what's left is under the threshold
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
