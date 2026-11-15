import { describe, test, assert } from 'vitest';
import { mdz_parse } from '@fuzdev/mdz/mdz.ts';

import {
	to_followed_heading,
	to_markdown_sections,
	to_onscreen_sections,
	to_visible_source_range,
	type MarkdownMeasuredRange
} from '#lib/markdown_outline.ts';
import { to_markdown_headings } from '#lib/markdown_links.ts';
import { find_markdown_caret_block } from '#lib/markdown_source_map.ts';

/** The sections of `source`'s headings, parsed as the view parses it. */
const sections_of = (source: string) =>
	to_markdown_sections(to_markdown_headings(mdz_parse(source)), source.length);

// A, its children B and C (C with a child D), then a sibling E
const DOC = '# A\n\nintro\n\n## B\n\nbee\n\n## C\n\nsee\n\n### D\n\ndee\n\n# E\n\nend\n';
const at = (text: string): number => DOC.indexOf(text);

describe('to_markdown_sections', () => {
	test('each section runs to the next heading at its level or above, so they nest', () => {
		assert.deepEqual(sections_of(DOC), [
			{ start: at('# A'), end: at('# E') },
			{ start: at('## B'), end: at('## C') },
			{ start: at('## C'), end: at('# E') },
			{ start: at('### D'), end: at('# E') },
			{ start: at('# E'), end: DOC.length }
		]);
	});

	test('the last sections run to the end of the document', () => {
		const source = '# A\n\n## B\n\nlast words\n';
		assert.deepEqual(sections_of(source), [
			{ start: 0, end: source.length },
			{ start: source.indexOf('## B'), end: source.length }
		]);
	});

	test('a shallower heading after a deep one closes every section deeper than it', () => {
		assert.deepEqual(
			to_markdown_sections(
				[
					{ level: 2, start: 0 },
					{ level: 4, start: 10 },
					{ level: 3, start: 20 },
					{ level: 1, start: 30 },
					{ level: 2, start: 40 }
				],
				50
			),
			[
				{ start: 0, end: 30 },
				{ start: 10, end: 20 },
				{ start: 20, end: 30 },
				{ start: 30, end: 50 },
				{ start: 40, end: 50 }
			]
		);
	});

	test('an empty document, or one without headings, has no sections', () => {
		assert.deepEqual(sections_of(''), []);
		assert.deepEqual(sections_of('just text\n'), []);
	});

	test('headings alone: siblings end where the next starts', () => {
		const source = '# a\n## b\n## c\n# d';
		assert.deepEqual(sections_of(source), [
			{ start: 0, end: source.indexOf('# d') },
			{ start: source.indexOf('## b'), end: source.indexOf('## c') },
			{ start: source.indexOf('## c'), end: source.indexOf('# d') },
			{ start: source.indexOf('# d'), end: source.length }
		]);
	});
});

describe('to_onscreen_sections', () => {
	const sections = sections_of(DOC);
	const onscreen = (start: number, end: number): Array<number> =>
		Array.from(to_onscreen_sections(sections, { start, end }));

	test('a section shows while any of it does, so a parent shows with its children', () => {
		assert.deepEqual(onscreen(at('bee'), at('bee') + 3), [0, 1], 'A and B');
		assert.deepEqual(onscreen(at('dee'), at('dee') + 3), [0, 2, 3], 'A, C, and D');
		assert.deepEqual(onscreen(at('see'), at('end')), [0, 2, 3, 4], 'from C into E');
		assert.deepEqual(onscreen(0, DOC.length), [0, 1, 2, 3, 4], 'the whole document');
	});

	test('a view touching a section at its boundary does not show it', () => {
		assert.deepEqual(onscreen(at('intro'), at('## B')), [0], 'ending where B starts');
		assert.deepEqual(onscreen(at('## B'), at('## B') + 1), [0, 1], 'one character of B');
		assert.deepEqual(onscreen(at('# E'), DOC.length), [4], 'starting where A ends');
		assert.deepEqual(onscreen(at('# E') - 1, DOC.length), [0, 2, 3, 4], 'one character of A');
	});

	test('nothing in view shows nothing', () => {
		assert.strictEqual(to_onscreen_sections(sections, null).size, 0);
		assert.strictEqual(onscreen(at('bee'), at('bee')).length, 0, 'an empty view');
		assert.strictEqual(to_onscreen_sections([], { start: 0, end: 10 }).size, 0, 'no sections');
	});

	test('a preamble before the first heading is in no section', () => {
		const source = 'preamble\n\n# A\n\ntext\n';
		const view = { start: 0, end: source.indexOf('# A') };
		assert.strictEqual(to_onscreen_sections(sections_of(source), view).size, 0);
	});
});

describe("the caret's section", () => {
	const sections = sections_of(DOC);
	const caret_in = (offset: number): number => find_markdown_caret_block(sections, offset);

	test('is the innermost section holding the caret', () => {
		assert.strictEqual(caret_in(at('intro')), 0);
		assert.strictEqual(caret_in(at('bee')), 1);
		assert.strictEqual(caret_in(at('see')), 2);
		assert.strictEqual(caret_in(at('dee')), 3, 'D, not A or C around it');
		assert.strictEqual(caret_in(at('end')), 4);
	});

	test("a caret on a heading's line is in its section, one at the end in the last", () => {
		assert.strictEqual(caret_in(at('## C')), 2);
		assert.strictEqual(caret_in(at('### D') + 2), 3);
		assert.strictEqual(caret_in(DOC.length), 4);
	});

	test('a caret before the first heading is in none', () => {
		const source = 'preamble\n\n# A\n';
		assert.strictEqual(find_markdown_caret_block(sections_of(source), 3), -1);
	});
});

describe('to_visible_source_range', () => {
	// blocks 10px tall with 10px gaps: [0,10) at y 0-10, [20,30) at y 20-30, ...
	const ITEMS: Array<MarkdownMeasuredRange> = Array.from({ length: 10 }, (_, i) => ({
		start: i * 20,
		end: i * 20 + 10,
		top: i * 20,
		bottom: i * 20 + 10
	}));
	const visible = (view_top: number, view_bottom: number, items = ITEMS) =>
		to_visible_source_range(items.length, (i) => items[i]!, view_top, view_bottom);

	test('runs from the first item reaching into view to the last, partly shown ones included', () => {
		assert.deepEqual(visible(0, 30), { start: 0, end: 30 });
		assert.deepEqual(visible(5, 25), { start: 0, end: 30 }, 'halves of two items');
		assert.deepEqual(visible(10, 20), null, 'only the gap between two');
		assert.deepEqual(visible(9, 21), { start: 0, end: 30 });
		assert.deepEqual(visible(150, 1000), { start: 160, end: 190 }, 'past the end');
	});

	test('an item at the edge of the view is out of it', () => {
		assert.deepEqual(visible(10, 40), { start: 20, end: 30 }, 'one ending at the top edge');
		assert.deepEqual(visible(20, 40), { start: 20, end: 30 }, 'one starting at the bottom edge');
	});

	test('nothing to measure or nothing in view is null', () => {
		assert.isNull(visible(0, 100, []));
		assert.isNull(visible(500, 600));
		assert.isNull(visible(0, 0), 'an empty view');
	});

	test('an item that can not be measured is null', () => {
		assert.isNull(to_visible_source_range(10, () => null, 0, 100));
	});

	test('measures only around the edges of the view', () => {
		const measured: Set<number> = new Set();
		const items: Array<MarkdownMeasuredRange> = Array.from({ length: 10_000 }, (_, i) => ({
			start: i,
			end: i + 1,
			top: i,
			bottom: i + 1
		}));
		const range = to_visible_source_range(
			items.length,
			(i) => {
				measured.add(i);
				return items[i]!;
			},
			5000,
			5100
		);
		assert.deepEqual(range, { start: 5000, end: 5100 });
		assert.isBelow(measured.size, 40);
	});
});

describe('to_followed_heading', () => {
	// headings at content ys 0, 300, 600, 900, viewed through a 200px pane
	const TOPS = [0, 300, 600, 900];
	const HEIGHT = 200;
	const follow = (
		view_top: number,
		current: number,
		onscreen: Array<number> = [],
		tops: Array<number | null> = TOPS
	): number =>
		to_followed_heading(
			tops.length,
			(i) => tops[i]!,
			view_top,
			view_top + HEIGHT,
			current,
			new Set(onscreen)
		);

	test('the topmost heading fully in view is current, at the very top too', () => {
		assert.strictEqual(follow(0, -1), 0);
		assert.strictEqual(follow(150, -1), 1, 'the next, lower in view');
		assert.strictEqual(follow(300, 0), 1);
	});

	test("a heading whose top is at the view's bottom edge is out of view", () => {
		assert.strictEqual(follow(100, -1, [0]), 0, 'the section showing, not the heading at 300');
		assert.strictEqual(follow(100.5, -1, [0]), 1, 'just above the edge');
	});

	test('going down, the next takes over as soon as the current starts to leave the top', () => {
		assert.strictEqual(follow(300.5, -1), 1, 'within the slack of the top edge');
		assert.strictEqual(follow(302, 1, [1, 2]), 1, 'held: no heading in view, its section shows');
		assert.strictEqual(follow(450, 1, [1, 2]), 2, 'the next is in view');
	});

	test('going up, the previous takes over only once its heading is back in view', () => {
		assert.strictEqual(follow(250, 2, [1, 2]), 1, 'the previous heading is in view again');
		assert.strictEqual(follow(350, 2, [1, 2]), 2, 'its heading is still out of view');
	});

	test('with no heading in view, the current holds while its section shows', () => {
		assert.strictEqual(follow(320, 1, [1]), 1);
		assert.strictEqual(follow(320, 0, [0, 1]), 0, 'a parent section still showing holds');
	});

	test('else the innermost section showing takes over, or none', () => {
		assert.strictEqual(follow(320, -1, [0, 1]), 1);
		assert.strictEqual(follow(320, 3, [0, 1]), 1, 'the current section scrolled away');
		assert.strictEqual(follow(320, 3, []), -1);
	});

	test('a preamble above the first heading: the heading below it is current once in view', () => {
		assert.strictEqual(follow(0, -1, [], [250, 600]), -1);
		assert.strictEqual(follow(100, -1, [0], [250, 600]), 0);
	});

	test('a heading that can not be measured keeps the current one', () => {
		assert.strictEqual(follow(0, 2, [], [null, null]), 2);
		assert.strictEqual(follow(0, -1, [], []), -1, 'no headings');
	});
});
