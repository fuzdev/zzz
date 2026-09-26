// @vitest-environment jsdom

import { test, describe, assert, beforeEach, afterEach, vi } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Time, TIME_INTERVAL_MAX } from '$lib/time.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const START = new Date(2026, 0, 1, 12, 0, 30).getTime(); // 30s into a minute

let app: Frontend;
let time: Time | undefined;

/** The SvelteDate's own value, which components like `TimeWidget` read. */
const now_ms = (): number => time!.now.getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	app = monkeypatch_zzz_for_tests(new Frontend());
});

afterEach(() => {
	time?.dispose();
	time = undefined;
	app.dispose();
	vi.useRealTimers();
});

describe('Time ticks', () => {
	test('the first tick lands at the next minute, not a full interval after start', () => {
		time = new Time({ app, autostart: false });
		time.start();
		assert.strictEqual(now_ms(), START);

		vi.advanceTimersByTime(29_000);
		assert.strictEqual(now_ms(), START, 'no tick before the minute boundary');

		vi.advanceTimersByTime(1_000 + 20);
		assert.isAtLeast(now_ms(), START + 30_000, 'ticked at the minute boundary');
		assert.strictEqual(new Date(now_ms()).getMinutes(), 1);
	});

	test('later ticks stay on minute boundaries', () => {
		time = new Time({ app, autostart: false });
		time.start();

		vi.advanceTimersByTime(30_000 + 60_000 + 20);
		const now = new Date(now_ms());
		assert.strictEqual(now.getMinutes(), 2);
		assert.isBelow(now.getSeconds(), 1);
	});

	test('start refreshes a stale `now`', () => {
		time = new Time({ app, autostart: false });
		vi.setSystemTime(START + 5 * 60_000);
		time.start();
		assert.strictEqual(now_ms(), START + 5 * 60_000);
	});

	test('stop cancels the pending tick', () => {
		time = new Time({ app, autostart: false });
		time.start();
		assert.ok(time.stop());

		vi.advanceTimersByTime(120_000);
		assert.strictEqual(now_ms(), START);
		assert.isFalse(time.running);
	});
});

describe('Time interval', () => {
	test('the `interval` option sets the tick interval', () => {
		time = new Time({ app, autostart: false, interval: 1_000 });
		assert.strictEqual(time.interval, 1_000);
		time.start();

		vi.advanceTimersByTime(1_000 + 20);
		assert.strictEqual(new Date(now_ms()).getSeconds(), 31);

		vi.advanceTimersByTime(1_000);
		assert.strictEqual(new Date(now_ms()).getSeconds(), 32);
	});

	test('a multi-minute interval ticks on its local wall-clock boundaries', () => {
		vi.setSystemTime(new Date(2026, 0, 1, 12, 3, 30));
		time = new Time({ app, autostart: false, interval: 5 * 60_000 });
		time.start();

		vi.advanceTimersByTime(60_000 + 20);
		assert.strictEqual(new Date(now_ms()).getMinutes(), 3, 'no tick before 12:05');

		vi.advanceTimersByTime(30_000);
		let now = new Date(now_ms());
		assert.deepEqual([now.getMinutes(), now.getSeconds()], [5, 0]);

		vi.advanceTimersByTime(5 * 60_000);
		now = new Date(now_ms());
		assert.deepEqual([now.getMinutes(), now.getSeconds()], [10, 0]);
	});

	test('restart takes a new interval', () => {
		time = new Time({ app, autostart: false });
		time.start();
		time.restart(10_000);
		assert.strictEqual(time.interval, 10_000);

		vi.advanceTimersByTime(10_000 + 20);
		assert.strictEqual(new Date(now_ms()).getSeconds(), 40);
	});

	test('rejects an interval that is not positive or is too long for `setTimeout`', () => {
		for (const interval of [
			0,
			-1_000,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			TIME_INTERVAL_MAX + 1
		]) {
			assert.throws(() => new Time({ app, autostart: false, interval }), /positive/);
		}
		time = new Time({ app, autostart: false });
		assert.throws(() => time!.restart(0), /positive/);
		assert.strictEqual(time.interval, Time.DEFAULT_INTERVAL);
	});

	test('`interval` is read-only — only `restart` changes it', () => {
		time = new Time({ app, autostart: false });
		assert.throws(() => {
			(time as any).interval = 0;
		}, TypeError);
		assert.strictEqual(time.interval, Time.DEFAULT_INTERVAL);
	});

	test('the longest interval schedules without overflowing', () => {
		// right on a boundary, where the next is a full interval plus the slack away
		const local = 1_000 * TIME_INTERVAL_MAX;
		const start = local + new Date(local).getTimezoneOffset() * 60_000;
		vi.setSystemTime(start);
		time = new Time({ app, autostart: false, interval: TIME_INTERVAL_MAX });
		time.start();

		vi.advanceTimersByTime(60_000);
		assert.strictEqual(now_ms(), start, 'no tick — an overflowed timeout would fire at once');
	});
});

describe('Time in a half-hour timezone', () => {
	const tz_original = process.env.TZ;

	beforeEach(() => {
		process.env.TZ = 'Asia/Kolkata'; // UTC+5:30
	});

	afterEach(() => {
		if (tz_original === undefined) delete process.env.TZ;
		else process.env.TZ = tz_original;
	});

	test('an hour interval ticks at the top of the local hour', () => {
		const start = new Date(2026, 0, 1, 12, 10, 30);
		assert.strictEqual(start.getTimezoneOffset(), -330, 'the timezone applied');
		vi.setSystemTime(start);
		time = new Time({ app, autostart: false, interval: 3_600_000 });
		time.start();

		// epoch-aligned hours fall on :30 here
		vi.advanceTimersByTime(20 * 60_000);
		assert.strictEqual(new Date(now_ms()).getMinutes(), 10, 'no tick at 12:30');

		vi.advanceTimersByTime(30 * 60_000);
		let now = new Date(now_ms());
		assert.deepEqual([now.getHours(), now.getMinutes()], [13, 0]);

		vi.advanceTimersByTime(3_600_000);
		now = new Date(now_ms());
		assert.deepEqual([now.getHours(), now.getMinutes()], [14, 0]);
	});

	test('the default minute interval still ticks on the minute', () => {
		vi.setSystemTime(new Date(2026, 0, 1, 12, 10, 30));
		time = new Time({ app, autostart: false });
		time.start();

		vi.advanceTimersByTime(30_000 + 20);
		const now = new Date(now_ms());
		assert.deepEqual([now.getMinutes(), now.getSeconds()], [11, 0]);
	});
});
