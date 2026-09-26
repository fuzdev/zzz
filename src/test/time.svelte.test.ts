// @vitest-environment jsdom

import { test, describe, assert, beforeEach, afterEach, vi } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Time } from '$lib/time.svelte.ts';

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
