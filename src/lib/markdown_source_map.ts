/**
 * Mapping a rendered markdown preview back to its source, for the markdown
 * view: which preview block holds the editor's caret, where a click in the
 * preview lands in the source, and the blocks scroll sync anchors on and the
 * outline measures (`to_markdown_leaf_blocks`).
 * Built on the offsets mdz puts on what it renders (`Mdz`'s
 * `source_offsets`): `data-mdz-start` and `data-mdz-end`, UTF-16 indices
 * into the parsed string, end exclusive.
 *
 * The offsets index the string mdz parsed, and the editor's caret indexes
 * the textarea's `value`, which reads every line break as `\n` — so the view
 * parses `to_textarea_value` of its source, and the two agree.
 *
 * @module
 */

import { clamp } from '@fuzdev/fuz_util/maths.ts';

/**
 * `text` as a `<textarea>`'s `value` reads it: each `\r\n` and lone `\r` a
 * `\n`. Parsing this, rather than the raw text, keeps the offsets mdz
 * reports in the same space as the textarea's `selectionStart`.
 */
export const to_textarea_value = (text: string): string =>
	text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;

/** A source range, UTF-16 offsets with `end` exclusive. */
export interface MarkdownSourceRange {
	start: number;
	end: number;
}

/**
 * The source offsets on `element` (`data-mdz-start` / `data-mdz-end`),
 * clamped to `[0, length]`, or `null` when it has none or they aren't
 * integers. Clamped because content can author the attributes itself (a
 * registered `props: 'all'` component passes any attribute through).
 *
 * @param element - an element mdz rendered with `source_offsets` on
 * @param length - the length of the parsed source
 */
export const read_mdz_source_range = (
	element: Element,
	length: number
): MarkdownSourceRange | null => {
	const start = to_integer(element.getAttribute('data-mdz-start'));
	const end = to_integer(element.getAttribute('data-mdz-end'));
	if (start === null || end === null) return null;
	const clamped_start = clamp(start, 0, length);
	return { start: clamped_start, end: clamp(end, clamped_start, length) };
};

const to_integer = (value: string | null): number | null => {
	if (value === null || value === '') return null;
	const n = Number(value);
	return Number.isInteger(n) ? n : null;
};

/**
 * The block-level elements mdz renders with source offsets — what the caret
 * marks and, table cells aside, scroll sync anchors on
 * (`to_markdown_scroll_anchors`). Inline marks (`strong`, `em`, `s`,
 * `code`) and links carry offsets too but aren't blocks.
 */
export const MDZ_BLOCK_SELECTOR = [
	'p',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'ul',
	'ol',
	'li',
	'blockquote',
	'table',
	'tr',
	'th',
	'td',
	'hr',
	'pre'
]
	.map((tag) => `${tag}[data-mdz-start][data-mdz-end]`)
	.join(', ');

/** A rendered block and its source range. */
export interface MarkdownBlock extends MarkdownSourceRange {
	element: Element;
}

/**
 * The blocks mdz rendered into `container`, in document order (a block
 * before the blocks inside it), each with its clamped source range.
 *
 * @param container - the element mdz rendered into, with `source_offsets` on
 * @param length - the length of the parsed source
 */
export const query_markdown_blocks = (
	container: ParentNode,
	length: number
): Array<MarkdownBlock> => {
	const blocks: Array<MarkdownBlock> = [];
	for (const element of container.querySelectorAll(MDZ_BLOCK_SELECTOR)) {
		const range = read_mdz_source_range(element, length);
		if (range) blocks.push({ element, start: range.start, end: range.end });
	}
	return blocks;
};

/**
 * The index of the innermost of `blocks` holding the caret at `offset`, or
 * `-1` when none does (a blank line between blocks). A caret at a block's
 * `end` counts as in it — typing at the end of a line is in that line's
 * block — and where one block ends as the next starts, the later wins.
 *
 * @param blocks - source ranges in document order, as `query_markdown_blocks` returns
 * @param offset - the caret, an offset into the parsed source
 */
export const find_markdown_caret_block = (
	blocks: ReadonlyArray<MarkdownSourceRange>,
	offset: number
): number => {
	let found = -1;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]!;
		// in document order a block starts no earlier than the one before, so nothing later holds it
		if (block.start > offset) break;
		// containing blocks nest, so the last in document order is the innermost
		if (offset <= block.end) found = i;
	}
	return found;
};

/** A point scroll sync aligns the panes on: a block's top or bottom, at its source offset. */
export interface MarkdownScrollAnchor {
	/** The source offset — the block's `start` for its top, its `end` for its bottom. */
	offset: number;
	edge: 'top' | 'bottom';
	element: Element;
}

/**
 * The leaves of `blocks`: each block that holds no other, table cells aside —
 * a row's cells sit side by side, so their tops and bottoms zigzag in y, and
 * the row is the leaf instead. Leaves never nest or share a line, so they run
 * in source order down the preview, their tops and bottoms each
 * non-decreasing.
 *
 * @param blocks - the rendered blocks in document order, as `query_markdown_blocks` returns
 */
export const to_markdown_leaf_blocks = (
	blocks: ReadonlyArray<MarkdownBlock>
): Array<MarkdownBlock> => {
	const stacked = blocks.filter((block) => !is_table_cell(block.element));
	const leaves: Array<MarkdownBlock> = [];
	for (let i = 0; i < stacked.length; i++) {
		const block = stacked[i]!;
		const next = stacked[i + 1];
		// a block inside this one comes next in document order
		if (next && block.element.contains(next.element)) continue;
		leaves.push(block);
	}
	return leaves;
};

/**
 * The scroll-sync anchors of `leaves`: the top and bottom of each, so they
 * run in source order down both panes.
 *
 * @param leaves - the rendered leaf blocks, as `to_markdown_leaf_blocks` returns
 */
export const to_markdown_scroll_anchors = (
	leaves: ReadonlyArray<MarkdownBlock>
): Array<MarkdownScrollAnchor> => {
	const anchors: Array<MarkdownScrollAnchor> = [];
	for (const block of leaves) {
		anchors.push({ offset: block.start, edge: 'top', element: block.element });
		anchors.push({ offset: block.end, edge: 'bottom', element: block.element });
	}
	return anchors;
};

const is_table_cell = (element: Element): boolean =>
	element.localName === 'th' || element.localName === 'td';
