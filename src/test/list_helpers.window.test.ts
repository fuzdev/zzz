import { test, describe, assert } from 'vitest';

import { compute_list_window } from '$lib/list_helpers.ts';

describe('compute_list_window', () => {
	test('renders the visible rows plus overscan', () => {
		// rows 10..19 are visible at 20px each
		assert.deepEqual(
			compute_list_window({
				count: 1000,
				row_height: 20,
				viewport_start: 200,
				viewport_end: 400,
				overscan: 5
			}),
			{ start: 5, end: 25 }
		);
	});

	test('includes partially visible rows', () => {
		assert.deepEqual(
			compute_list_window({
				count: 1000,
				row_height: 20,
				viewport_start: 210,
				viewport_end: 390,
				overscan: 0
			}),
			{ start: 10, end: 20 }
		);
	});

	test('clamps to the start of the list when it begins below the viewport top', () => {
		// the list starts 100px below the top of the visible area
		assert.deepEqual(
			compute_list_window({
				count: 1000,
				row_height: 20,
				viewport_start: -100,
				viewport_end: 300,
				overscan: 5
			}),
			{ start: 0, end: 20 }
		);
	});

	test('clamps to the end of the list', () => {
		assert.deepEqual(
			compute_list_window({
				count: 30,
				row_height: 20,
				viewport_start: 400,
				viewport_end: 800,
				overscan: 5
			}),
			{ start: 15, end: 30 }
		);
	});

	test('a list scrolled far past renders at most the overscan rows at its end', () => {
		const w = compute_list_window({
			count: 30,
			row_height: 20,
			viewport_start: 10_000,
			viewport_end: 10_400,
			overscan: 5
		});
		assert.deepEqual(w, { start: 30, end: 30 });
	});

	test('a list entirely below the viewport renders at most the overscan rows at its start', () => {
		assert.deepEqual(
			compute_list_window({
				count: 30,
				row_height: 20,
				viewport_start: -1000,
				viewport_end: -500,
				overscan: 5
			}),
			{ start: 0, end: 0 }
		);
		assert.deepEqual(
			compute_list_window({
				count: 30,
				row_height: 20,
				viewport_start: -1000,
				viewport_end: -60,
				overscan: 5
			}),
			{ start: 0, end: 2 }
		);
	});

	test('before measuring, renders the first overscan rows', () => {
		assert.deepEqual(
			compute_list_window({
				count: 1000,
				row_height: 0,
				viewport_start: 0,
				viewport_end: 400,
				overscan: 10
			}),
			{ start: 0, end: 10 }
		);
		assert.deepEqual(
			compute_list_window({
				count: 1000,
				row_height: 20,
				viewport_start: 0,
				viewport_end: 0,
				overscan: 10
			}),
			{ start: 0, end: 10 }
		);
		assert.deepEqual(
			compute_list_window({
				count: 3,
				row_height: 0,
				viewport_start: 0,
				viewport_end: 0,
				overscan: 10
			}),
			{ start: 0, end: 3 }
		);
	});

	test('an empty list renders nothing', () => {
		assert.deepEqual(
			compute_list_window({
				count: 0,
				row_height: 20,
				viewport_start: 0,
				viewport_end: 400,
				overscan: 10
			}),
			{ start: 0, end: 0 }
		);
	});

	test('handles fractional row heights', () => {
		const w = compute_list_window({
			count: 20_000,
			row_height: 29.6,
			viewport_start: 29.6 * 15_000 + 1,
			viewport_end: 29.6 * 15_000 + 601,
			overscan: 0
		});
		assert.strictEqual(w.start, 15_000);
		assert.strictEqual(w.end, 15_021);
	});
});
