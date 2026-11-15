// @vitest-environment jsdom

import { describe, test, assert } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Mdz from '@fuzdev/mdz/Mdz.svelte';

import {
	find_markdown_caret_block,
	query_markdown_blocks,
	read_mdz_source_range,
	to_markdown_leaf_blocks,
	to_markdown_scroll_anchors,
	to_textarea_value,
	type MarkdownBlock,
	type MarkdownScrollAnchor
} from '#lib/markdown_source_map.ts';

/** Renders `content` with mdz's source offsets, returning the container and an unmount. */
const render_mdz = (content: string): { container: HTMLElement; destroy: () => void } => {
	const container = document.createElement('div');
	document.body.append(container);
	const mounted = mount(Mdz, { target: container, props: { content, source_offsets: true } });
	flushSync();
	return {
		container,
		destroy: () => {
			void unmount(mounted);
			container.remove();
		}
	};
};

const el_with = (attrs: Record<string, string>): Element => {
	const el = document.createElement('p');
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	return el;
};

describe('to_textarea_value', () => {
	test('reads every line break as a textarea does', () => {
		assert.strictEqual(to_textarea_value('a\r\nb\rc\nd\r\n\r\n'), 'a\nb\nc\nd\n\n');
		const textarea = document.createElement('textarea');
		const raw = '# a\r\n\r\ntext\rmore\r\n';
		textarea.value = raw;
		assert.strictEqual(to_textarea_value(raw), textarea.value);
	});

	test('returns text without a carriage return as it is', () => {
		const text = 'a\nb';
		assert.strictEqual(to_textarea_value(text), text);
	});
});

describe('read_mdz_source_range', () => {
	test('reads the offsets', () => {
		assert.deepEqual(
			read_mdz_source_range(el_with({ 'data-mdz-start': '2', 'data-mdz-end': '5' }), 10),
			{
				start: 2,
				end: 5
			}
		);
	});

	test('clamps to the source, keeping the end at or after the start', () => {
		const read = (start: string, end: string) =>
			read_mdz_source_range(el_with({ 'data-mdz-start': start, 'data-mdz-end': end }), 10);
		assert.deepEqual(read('-3', '4'), { start: 0, end: 4 });
		assert.deepEqual(read('2', '9999'), { start: 2, end: 10 });
		assert.deepEqual(read('9999', '99999'), { start: 10, end: 10 });
		assert.deepEqual(read('6', '3'), { start: 6, end: 6 });
	});

	test('reads nothing from missing or non-integer offsets', () => {
		assert.isNull(read_mdz_source_range(el_with({}), 10));
		assert.isNull(read_mdz_source_range(el_with({ 'data-mdz-start': '1' }), 10));
		for (const bad of ['', '1.5', 'x', 'NaN', 'Infinity']) {
			assert.isNull(
				read_mdz_source_range(el_with({ 'data-mdz-start': bad, 'data-mdz-end': '4' }), 10),
				bad
			);
		}
	});
});

describe('find_markdown_caret_block', () => {
	// `# h\n\n- a\n- b\n\np` - a heading, a list of two items, a paragraph
	const blocks = [
		{ start: 0, end: 3 }, // h1
		{ start: 5, end: 12 }, // ul
		{ start: 5, end: 8 }, // li a
		{ start: 9, end: 12 }, // li b
		{ start: 14, end: 15 } // p
	];

	test('finds the innermost block holding the caret', () => {
		assert.strictEqual(find_markdown_caret_block(blocks, 0), 0);
		assert.strictEqual(find_markdown_caret_block(blocks, 6), 2);
		assert.strictEqual(find_markdown_caret_block(blocks, 10), 3);
		assert.strictEqual(find_markdown_caret_block(blocks, 14), 4);
	});

	test("a caret at a block's end is in it, one on a line between blocks in none", () => {
		assert.strictEqual(find_markdown_caret_block(blocks, 3), 0);
		assert.strictEqual(find_markdown_caret_block(blocks, 12), 3);
		assert.strictEqual(find_markdown_caret_block(blocks, 15), 4);
		assert.strictEqual(find_markdown_caret_block(blocks, 4), -1);
		assert.strictEqual(find_markdown_caret_block(blocks, 13), -1);
		assert.strictEqual(find_markdown_caret_block(blocks, 99), -1);
		assert.strictEqual(find_markdown_caret_block([], 0), -1);
	});

	test('where one block ends as the next starts, the later wins', () => {
		assert.strictEqual(
			find_markdown_caret_block(
				[
					{ start: 0, end: 4 },
					{ start: 4, end: 8 }
				],
				4
			),
			1
		);
	});
});

describe('query_markdown_blocks', () => {
	test('reads the rendered blocks in document order, skipping inline marks and links', () => {
		const content = '# h\n\n- a **b**\n- [c](./c.md)\n\n> q\n\n```\ncode\n```';
		const { container, destroy } = render_mdz(content);
		const blocks = query_markdown_blocks(container, content.length);
		assert.deepEqual(
			blocks.map((b) => [b.element.tagName, content.slice(b.start, b.end)]),
			[
				['H1', '# h'],
				['UL', '- a **b**\n- [c](./c.md)'],
				['LI', '- a **b**'],
				['LI', '- [c](./c.md)'],
				['BLOCKQUOTE', '> q'],
				['P', 'q'],
				['PRE', '```\ncode\n```']
			]
		);
		destroy();
	});

	test('a CRLF source parsed as the textarea reads it puts the caret in the right block', () => {
		const raw = '# Top\r\n\r\nintro\r\n\r\n## Part Two\r\n\r\nmore\r\n';
		const source = to_textarea_value(raw);
		const { container, destroy } = render_mdz(source);
		const blocks = query_markdown_blocks(container, source.length);
		const textarea = document.createElement('textarea');
		textarea.value = raw;
		const caret = textarea.value.indexOf('more');
		const i = find_markdown_caret_block(blocks, caret);
		assert.strictEqual(blocks[i]?.element.textContent, 'more');
		assert.strictEqual(blocks[i]?.start, caret);
		destroy();
	});
});

describe('to_markdown_leaf_blocks', () => {
	test('the blocks holding no other, table rows rather than their cells, in source order', () => {
		const content = '# h\n\n- a\n- b\n  - c\n\n| x |\n| - |\n| 1 |\n\np';
		const { container, destroy } = render_mdz(content);
		const leaves = to_markdown_leaf_blocks(query_markdown_blocks(container, content.length));
		assert.deepEqual(
			leaves.map((b) => `${b.element.tagName}:${content.slice(b.start, b.end).trim()}`),
			['H1:# h', 'LI:- a', 'LI:- c', 'TR:| x |', 'TR:| 1 |', 'P:p']
		);
		destroy();
	});
});

describe('to_markdown_scroll_anchors', () => {
	const describe_anchors = (anchors: Array<MarkdownScrollAnchor>): Array<string> =>
		anchors.map((a) => `${a.element.tagName}:${a.edge}:${a.offset}`);

	const assert_non_decreasing = (anchors: Array<MarkdownScrollAnchor>): void => {
		const offsets = anchors.map((a) => a.offset);
		assert.deepEqual(
			offsets,
			offsets.toSorted((a, b) => a - b),
			'non-decreasing'
		);
	};

	test("anchors on each leaf block's top and bottom, in source order", () => {
		const content = '# h\n\n- a\n- b\n  - c\n\np';
		const { container, destroy } = render_mdz(content);
		const anchors = to_markdown_scroll_anchors(query_markdown_blocks(container, content.length));
		assert.deepEqual(describe_anchors(anchors), [
			'H1:top:0',
			'H1:bottom:3',
			'LI:top:5',
			'LI:bottom:8',
			// the `li` holding `b` holds a list, so only its innermost blocks anchor
			'LI:top:15',
			'LI:bottom:18',
			`P:top:${content.length - 1}`,
			`P:bottom:${content.length}`
		]);
		assert_non_decreasing(anchors);
		destroy();
	});

	test("a table anchors on its rows, not its cells, which share a row's line", () => {
		const content = 'p\n\n| x | y |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nq';
		const { container, destroy } = render_mdz(content);
		const blocks = query_markdown_blocks(container, content.length);
		assert.ok(
			blocks.some((b) => b.element.tagName === 'TD'),
			'the cells are blocks, for the caret mark'
		);
		const anchors = to_markdown_scroll_anchors(blocks);
		const row = (text: string): Array<string> => {
			const start = content.indexOf(text);
			return [`TR:top:${start}`, `TR:bottom:${start + text.length}`];
		};
		assert.deepEqual(describe_anchors(anchors), [
			'P:top:0',
			'P:bottom:1',
			...row('| x | y |'),
			...row('| 1 | 2 |'),
			...row('| 3 | 4 |'),
			`P:top:${content.length - 1}`,
			`P:bottom:${content.length}`
		]);
		assert_non_decreasing(anchors);
		destroy();
	});

	/** The anchors of the rows in `rows`, each found in `content` after the one before. */
	const row_anchors = (content: string, rows: Array<string>): Array<string> => {
		let from = 0;
		return rows.flatMap((text) => {
			const start = content.indexOf(text, from);
			assert.ok(start !== -1, text);
			from = start + text.length;
			return [`TR:top:${start}`, `TR:bottom:${start + text.length}`];
		});
	};

	test('a table in a blockquote or a list item anchors on its rows, inline marks aside', () => {
		for (const content of [
			'> | x | **y** |\n> | - | - |\n> | `1` | 2 |\n> | 3 | _4_ |',
			// a list item's table follows its text - a row on the marker's line is text
			'- item\n\n  | x | **y** |\n  | - | - |\n  | `1` | 2 |\n  | 3 | _4_ |'
		]) {
			const { container, destroy } = render_mdz(content);
			const blocks = query_markdown_blocks(container, content.length);
			assert.ok(
				container.querySelector('table strong, table code, table em'),
				`the cells hold inline marks: ${content}`
			);
			const anchors = to_markdown_scroll_anchors(blocks);
			assert.deepEqual(
				describe_anchors(anchors),
				row_anchors(content, ['| x | **y** |', '| `1` | 2 |', '| 3 | _4_ |']),
				content
			);
			assert_non_decreasing(anchors);
			destroy();
		}
	});

	test('a header-only table anchors on its one row', () => {
		const content = 'p\n\n| x | y |\n| - | - |\n\nq';
		const { container, destroy } = render_mdz(content);
		assert.strictEqual(container.querySelectorAll('tr').length, 1, 'renders as a table');
		const anchors = to_markdown_scroll_anchors(query_markdown_blocks(container, content.length));
		assert.deepEqual(describe_anchors(anchors), [
			'P:top:0',
			'P:bottom:1',
			...row_anchors(content, ['| x | y |']),
			`P:top:${content.length - 1}`,
			`P:bottom:${content.length}`
		]);
		assert_non_decreasing(anchors);
		destroy();
	});

	test('empty without blocks', () => {
		assert.deepEqual(to_markdown_scroll_anchors([] as Array<MarkdownBlock>), []);
	});
});
