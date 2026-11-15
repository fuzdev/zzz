// @vitest-environment jsdom

import { describe, test, assert, afterEach, vi } from 'vitest';

import {
	MarkdownScrollSync,
	to_synced_scroll_top,
	type MarkdownScrollPane,
	type MarkdownScrollMetrics
} from '#lib/markdown_scroll_sync.ts';
import type { MarkdownScrollAnchor } from '#lib/markdown_source_map.ts';

const metrics = (
	scroll_top: number,
	scroll_height: number,
	client_height = 100
): MarkdownScrollMetrics => ({
	scroll_top,
	scroll_height,
	client_height
});

/** Maps through anchors given as arrays of content ys, one per pane. */
const sync = (
	from_ys: Array<number | null>,
	to_ys: Array<number | null>,
	from: MarkdownScrollMetrics,
	to: MarkdownScrollMetrics
): number | null =>
	to_synced_scroll_top(
		from_ys.length,
		(i) => from_ys[i]!,
		(i) => to_ys[i]!,
		from,
		to
	);

describe('to_synced_scroll_top', () => {
	// two blocks: the editor's at 0-50 and 100-200, the preview's at 0-200 and 300-400
	const EDITOR = [0, 50, 100, 200];
	const PREVIEW = [0, 200, 300, 400];

	test('aligns the anchors, interpolating between them', () => {
		const to = metrics(0, 1000);
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(0, 1000), to), 0);
		assert.strictEqual(
			sync(EDITOR, PREVIEW, metrics(25, 1000), to),
			100,
			'halfway through a block'
		);
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(50, 1000), to), 200);
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(75, 1000), to), 250, 'between two blocks');
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(150, 1000), to), 350);
	});

	test('maps back the other way', () => {
		const to = metrics(0, 1000);
		assert.strictEqual(sync(PREVIEW, EDITOR, metrics(100, 1000), to), 25);
		assert.strictEqual(sync(PREVIEW, EDITOR, metrics(350, 1000), to), 150);
	});

	test("past the last anchor it runs to the content's bottom", () => {
		// the editor's content ends at 1000 past its last anchor at 200, the preview's at 800 past 400
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(600, 1000, 0), metrics(0, 800, 0)), 600);
	});

	test("over the leader's last screenful it eases to the follower's bottom", () => {
		// the leader's max is 900, its last screenful 800-900; the follower maps it at twice the scale
		const at = (top: number) => sync([0], [0], metrics(top, 1000, 100), metrics(0, 2000, 100))!;
		const before = at(800);
		assert.strictEqual(before, 1600, 'no easing before the last screenful');
		assert.strictEqual(at(900), 1900, 'both at their bottoms together');
		const mid = at(850);
		assert.strictEqual(mid, 1800, 'halfway from the mapped 1700 to the bottom');
	});

	test('clamps to the follower range, and handles panes too short to scroll', () => {
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(150, 1000), metrics(0, 300, 100)), 200);
		assert.strictEqual(sync(EDITOR, PREVIEW, metrics(0, 50, 100), metrics(0, 1000)), 0);
		assert.strictEqual(sync([], [], metrics(400, 1000, 0), metrics(0, 500, 0)), 200);
	});

	test('an unmeasurable anchor stops the sync', () => {
		assert.isNull(sync([0, null, 100, 200], PREVIEW, metrics(150, 1000), metrics(0, 1000)));
		assert.isNull(sync(EDITOR, [0, 200, null, 400], metrics(150, 1000), metrics(0, 1000)));
	});

	test('measurements out of order stay within their segment', () => {
		// the second anchor measured above the first, as a block's overshooting end can
		const top = sync([0, 60, 50, 200], PREVIEW, metrics(55, 1000), metrics(0, 1000))!;
		assert.isAtLeast(top, 0);
		assert.isAtMost(top, 400);
	});

	test('measures only around the scroll position', () => {
		const count = 1000;
		const measured: Set<number> = new Set();
		const top = to_synced_scroll_top(
			count,
			(i) => {
				measured.add(i);
				return i * 10;
			},
			(i) => {
				measured.add(i);
				return i * 20;
			},
			metrics(5000, 10_000, 0),
			metrics(0, 20_000, 0)
		);
		assert.strictEqual(top, 10_000);
		assert.isBelow(measured.size, 30);
	});
});

describe('MarkdownScrollSync', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	/** A pane whose content ys scale its anchors' offsets by `scale`. */
	const create_pane = (scale: number, scroll_height: number): MarkdownScrollPane => {
		const element = document.createElement('div');
		let scroll_top = 0;
		Object.defineProperties(element, {
			scrollTop: {
				get: () => scroll_top,
				set: (v: number) => {
					scroll_top = v;
				}
			},
			scrollHeight: { get: () => scroll_height },
			clientHeight: { get: () => 0 }
		});
		return { element, measure: (anchor) => anchor.offset * scale };
	};

	const ANCHORS: Array<MarkdownScrollAnchor> = [10, 20, 30].map((offset) => ({
		offset,
		edge: 'top',
		element: document.createElement('p')
	}));

	const setup = () => {
		const editor = create_pane(1, 100);
		const preview = create_pane(3, 300);
		const root = document.createElement('div');
		root.append(editor.element, preview.element);
		document.body.append(root);
		const frames: Array<() => void> = [];
		vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
		vi.stubGlobal('cancelAnimationFrame', () => {
			frames.length = 0;
		});
		const scroll_sync = new MarkdownScrollSync({
			get_editor: () => editor,
			get_preview: () => preview,
			get_anchors: () => ANCHORS
		});
		const detach = scroll_sync.attach(root) as () => void;
		const run_frames = (): void => {
			for (const frame of frames.splice(0)) frame();
		};
		const scroll = (pane: MarkdownScrollPane, top: number): void => {
			pane.element.scrollTop = top;
			pane.element.dispatchEvent(new Event('scroll'));
		};
		return { editor, preview, scroll_sync, detach, frames, run_frames, scroll };
	};

	test('with no leader, a scroll moves nothing', () => {
		const { editor, preview, frames, scroll } = setup();
		scroll(editor, 20);
		assert.strictEqual(frames.length, 0);
		assert.strictEqual(preview.element.scrollTop, 0);
	});

	test('the pane the user touches leads, and the other follows its scroll on the next frame', () => {
		const { editor, preview, scroll_sync, run_frames, scroll } = setup();
		editor.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
		assert.strictEqual(scroll_sync.leader, 'editor');
		scroll(editor, 20);
		assert.strictEqual(preview.element.scrollTop, 0, 'not before the frame');
		run_frames();
		assert.strictEqual(preview.element.scrollTop, 60);

		preview.element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		assert.strictEqual(scroll_sync.leader, 'preview');
		scroll(preview, 75);
		run_frames();
		assert.strictEqual(editor.element.scrollTop, 25);

		editor.element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		assert.strictEqual(scroll_sync.leader, 'editor');
	});

	test("a follower's scroll, as a sync makes, never syncs back", () => {
		const { editor, preview, frames, run_frames, scroll } = setup();
		editor.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
		scroll(editor, 20);
		run_frames();
		assert.strictEqual(preview.element.scrollTop, 60);
		// the sync's own scroll event arrives
		preview.element.dispatchEvent(new Event('scroll'));
		assert.strictEqual(frames.length, 0, 'no sync scheduled');
		assert.strictEqual(editor.element.scrollTop, 20);
	});

	test('one sync per frame, however many scrolls asked', () => {
		const { editor, preview, frames, run_frames, scroll } = setup();
		editor.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
		scroll(editor, 10);
		scroll(editor, 15);
		scroll(editor, 20);
		assert.strictEqual(frames.length, 1);
		run_frames();
		assert.strictEqual(preview.element.scrollTop, 60, 'from the latest position');
	});

	test('refresh realigns the follower to the leader, and only once there is one', () => {
		const { editor, preview, frames, scroll_sync, run_frames } = setup();
		scroll_sync.refresh();
		assert.strictEqual(frames.length, 0);
		editor.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
		editor.element.scrollTop = 20;
		scroll_sync.refresh();
		run_frames();
		assert.strictEqual(preview.element.scrollTop, 60);
	});

	test('a scroll inside a pane, not of it, moves nothing', () => {
		const { editor, preview, frames } = setup();
		const inner = document.createElement('pre');
		editor.element.append(inner);
		editor.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
		inner.dispatchEvent(new Event('scroll'));
		assert.strictEqual(frames.length, 0);
		assert.strictEqual(preview.element.scrollTop, 0);
	});

	test('detaching and destroying stop it', () => {
		const { editor, preview, scroll_sync, detach, frames, run_frames, scroll } = setup();
		editor.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
		scroll(editor, 20);
		scroll_sync.destroy();
		run_frames();
		assert.strictEqual(preview.element.scrollTop, 0, 'the pending sync was cancelled');
		detach();
		scroll(editor, 30);
		assert.strictEqual(frames.length, 0);
	});
});
