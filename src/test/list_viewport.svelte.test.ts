import { test, describe, assert } from 'vitest';

import { ListViewport } from '#lib/list_viewport.svelte.ts';

describe('ListViewport.first_visible_index', () => {
	const cases: Array<
		[label: string, start: number, height: number, count: number, expected: number]
	> = [
		['before a measurement', 200, 0, 40, 0],
		['at the top', 0, 20, 40, 0],
		['the list starting below the top', -50, 20, 40, 0],
		['scrolled to a row boundary', 200, 20, 40, 10],
		['scrolled into a row, the next whole one', 210, 20, 40, 11],
		['a row clipped by a fraction of a pixel still counts', 200.0001, 20, 40, 10],
		['clipped by a whole pixel', 201, 20, 40, 10],
		['clipped by more than a pixel, the next', 201.5, 20, 40, 11],
		['scrolled past the end', 5000, 20, 40, 39],
		['no rows', 200, 20, 0, 0]
	];
	test.each(cases)('%s', (_label, start, height, count, expected) => {
		const viewport = new ListViewport();
		viewport.viewport_start = start;
		viewport.row_height = height;
		assert.strictEqual(viewport.first_visible_index(count), expected);
	});
});
