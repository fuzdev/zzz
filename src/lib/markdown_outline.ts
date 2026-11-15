/**
 * Where the reader is in a markdown document, for the markdown view's
 * outline: which sections the pane being read shows (`to_onscreen_sections`),
 * and, with no caret to say, which one the reader is at
 * (`to_followed_heading`). Pure — the view feeds them its panes'
 * measurements once per frame, so a test needs no layout.
 *
 * A heading's section runs from the heading to the next heading at its level
 * or above, or to the document's end (`to_markdown_sections`), so sections
 * nest as headings do: a parent shows while any of its children does.
 *
 * @module
 */

import type { MarkdownHeading } from './markdown_links.ts';
import type { MarkdownSourceRange } from './markdown_source_map.ts';

/**
 * The section of each heading: from its start to the start of the next
 * heading whose level is at or above its own (a lower or equal number), or
 * to `length` when none follows. In heading order, so in document order, each
 * section holding the deeper ones after it.
 *
 * @param headings - the document's headings, as `to_markdown_headings` returns
 * @param length - the length of the document the headings' offsets index
 */
export const to_markdown_sections = (
	headings: ReadonlyArray<Pick<MarkdownHeading, 'level' | 'start'>>,
	length: number
): Array<MarkdownSourceRange> => {
	const sections: Array<MarkdownSourceRange> = [];
	// the sections still open, each deeper than the one below it
	const open: Array<{ level: number; index: number }> = [];
	for (const heading of headings) {
		while (open.length > 0 && open.at(-1)!.level >= heading.level) {
			sections[open.pop()!.index]!.end = heading.start;
		}
		open.push({ level: heading.level, index: sections.length });
		sections.push({ start: heading.start, end: length });
	}
	return sections;
};

/**
 * The indexes of the sections overlapping `visible`, the source range a pane
 * shows — the outline's dimly lit items. Both ranges are end-exclusive, so a
 * section ending where the view starts, or starting where it ends, isn't
 * shown, and an empty view shows nothing.
 *
 * @param sections - from `to_markdown_sections`
 * @param visible - from `to_visible_source_range`, `null` when nothing is in view
 */
export const to_onscreen_sections = (
	sections: ReadonlyArray<MarkdownSourceRange>,
	visible: MarkdownSourceRange | null
): Set<number> => {
	const onscreen: Set<number> = new Set();
	if (!visible || visible.start >= visible.end) return onscreen;
	for (let i = 0; i < sections.length; i++) {
		const section = sections[i]!;
		// in document order a section starts no earlier than the one before
		if (section.start >= visible.end) break;
		if (visible.start < section.end) onscreen.add(i);
	}
	return onscreen;
};

/** A source range a pane shows, and where it shows it: content ys, `bottom` at or below `top`. */
export interface MarkdownMeasuredRange extends MarkdownSourceRange {
	top: number;
	bottom: number;
}

/**
 * The source range a pane shows between the content ys `view_top` and
 * `view_bottom` (its `scrollTop`, and that plus its `clientHeight`): from the
 * start of the first item whose bottom is below `view_top` to the end of the
 * last whose top is above `view_bottom`, so an item partly in view counts.
 * The items — the preview's leaf blocks, or the editor's characters, each
 * measured on its line — run down the pane in source order, their tops and
 * bottoms each non-decreasing, so two binary searches measure a few of them,
 * not all.
 *
 * @param count - the number of items
 * @param measure - the `index`th item's source range and content ys, `null` when it can't be measured
 * @param view_top - the content y of the pane's top edge
 * @param view_bottom - the content y of the pane's bottom edge
 * @returns the range, or `null` when no item is in view or a needed one can't be measured
 */
export const to_visible_source_range = (
	count: number,
	measure: (index: number) => MarkdownMeasuredRange | null,
	view_top: number,
	view_bottom: number
): MarkdownSourceRange | null => {
	// the first item reaching below the top
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const item = measure(mid);
		if (!item) return null;
		if (item.bottom > view_top) hi = mid;
		else lo = mid + 1;
	}
	const first = lo;
	// the first item starting at or below the bottom, after the last in view
	hi = count;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const item = measure(mid);
		if (!item) return null;
		if (item.top >= view_bottom) hi = mid;
		else lo = mid + 1;
	}
	const last = lo - 1;
	if (first > last) return null;
	const start = measure(first);
	const end = measure(last);
	if (!start || !end) return null;
	return { start: start.start, end: Math.max(start.start, end.end) };
};

/**
 * How far above a pane's top edge a heading's top can sit and still count as
 * fully in view — a heading scrolled to the top lands within a pixel of it.
 */
const HEADING_TOP_SLACK = 1;

/**
 * The heading the reader is at when no caret says — the outline's brightly
 * lit item in the preview alone: the topmost heading fully in the pane.
 * Going down, the next heading takes over as soon as the current one starts
 * to leave the top; going up, the previous takes over once its heading is
 * back in view, so the outline never points at a heading the reader can't
 * see. With no heading in view, the current one holds while its section
 * still shows, else the innermost section showing takes over.
 *
 * Nothing is held back at the very top: the document's first heading in view
 * is current there too, since the outline has no entry for what's above it.
 *
 * @param count - the number of headings
 * @param heading_top - the `index`th heading's content y, `null` when it can't be measured;
 *   non-decreasing in `index`, so a binary search measures a few
 * @param view_top - the content y of the pane's top edge
 * @param view_bottom - the content y of the pane's bottom edge
 * @param current - the heading followed so far, `-1` for none
 * @param onscreen - the sections showing, from `to_onscreen_sections`
 * @returns the heading's index, `-1` for none, or `current` when a needed heading can't be measured
 */
export const to_followed_heading = (
	count: number,
	heading_top: (index: number) => number | null,
	view_top: number,
	view_bottom: number,
	current: number,
	onscreen: ReadonlySet<number>
): number => {
	const min_top = view_top - HEADING_TOP_SLACK;
	// the first heading whose top hasn't left the top edge
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const top = heading_top(mid);
		if (top === null) return current;
		if (top >= min_top) hi = mid;
		else lo = mid + 1;
	}
	if (lo < count) {
		const top = heading_top(lo);
		if (top === null) return current;
		if (top < view_bottom) return lo;
	}
	// no heading is in view
	if (current !== -1 && onscreen.has(current)) return current;
	// sections nest in document order, so the last showing is the innermost
	let innermost = -1;
	for (const index of onscreen) innermost = Math.max(innermost, index);
	return innermost;
};
