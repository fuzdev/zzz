// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import MarkdownPreview from '#lib/MarkdownPreview.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { mdz_parse } from '@fuzdev/mdz/mdz.ts';

import {
	find_markdown_link_index,
	query_markdown_link_anchors,
	to_markdown_links
} from '#lib/markdown_links.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import MdzCodeLinkHarness from './MdzCodeLinkHarness.svelte';
import { create_reactive_props } from './reactive_test_helpers.svelte.ts';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

const render = (props: Record<string, unknown>): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(MarkdownPreview, { target, props: props as any });
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
	});
	return target;
};

const find_link = (target: HTMLElement, text: string): HTMLAnchorElement => {
	const anchor = Array.from(target.querySelectorAll('a')).find(
		(a) => a.textContent.trim() === text
	);
	assert.ok(anchor, `a "${text}" link`);
	return anchor;
};

/**
 * Clicks the preview's link with `text` — a primary `click`, or with
 * `type: 'auxclick'` a middle click — returning whether the click was
 * prevented once it bubbled out of the preview (where SvelteKit's router
 * and the browser would act on it).
 */
const click_link = (
	target: HTMLElement,
	text: string,
	init: MouseEventInit = {},
	type: 'click' | 'auxclick' = 'click'
): boolean => {
	const anchor = find_link(target, text);
	let prevented: boolean | null = null;
	const listener = (event: Event): void => {
		prevented = event.defaultPrevented;
		// keep jsdom from attempting the navigation itself
		event.preventDefault();
	};
	document.addEventListener(type, listener);
	anchor.dispatchEvent(
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			button: type === 'auxclick' ? 1 : 0,
			...init
		})
	);
	document.removeEventListener(type, listener);
	assert.isNotNull(prevented, 'the click bubbled out of the preview');
	return prevented;
};

const middle_click_link = (target: HTMLElement, text: string): boolean =>
	click_link(target, text, {}, 'auxclick');

describe('MarkdownPreview links', () => {
	test('without a file, a link into the app does nothing, so the files page stays', () => {
		const target = render({
			content:
				'[rel](./docs/x.md) [root](/settings) [query](?x=1) [bare](notes.md) [same](http://localhost:3000/x)'
		});
		for (const text of ['rel', 'root', 'query', 'bare']) {
			assert.isTrue(click_link(target, text), text);
			assert.isTrue(click_link(target, text, { ctrlKey: true }), `${text} with ctrl`);
			assert.isTrue(middle_click_link(target, text), `${text} middle-clicked`);
		}
		assert.strictEqual(location.origin, 'http://localhost:3000', 'jsdom origin');
		assert.isTrue(click_link(target, 'same'), 'same-origin absolute');
		assert.isTrue(middle_click_link(target, 'same'), 'same-origin absolute middle-clicked');
	});

	test('a middle click on a fragment is prevented and scrolls nothing', () => {
		const target = render({ content: '[jump](#later)\n\n## later' });
		const heading = target.querySelector('h2');
		assert.ok(heading);
		const scroll = vi.fn();
		heading.scrollIntoView = scroll;
		assert.isTrue(middle_click_link(target, 'jump'));
		assert.strictEqual(scroll.mock.calls.length, 0);
	});

	test('a fragment scrolls to its heading in the preview without navigating', () => {
		const target = render({ content: '[jump](#later)\n\n## later' });
		const heading = target.querySelector('h2');
		assert.ok(heading);
		assert.strictEqual(heading.id, 'later');
		const scroll = vi.fn();
		heading.scrollIntoView = scroll;
		assert.isTrue(click_link(target, 'jump'));
		assert.strictEqual(scroll.mock.calls.length, 1);
	});

	test('a malformed fragment escape is still prevented and throws nothing', () => {
		const target = render({ content: '[bad](#a%zz)\n\n## a' });
		const errors: Array<unknown> = [];
		const on_error = (event: ErrorEvent): void => {
			errors.push(event.error);
		};
		window.addEventListener('error', on_error);
		cleanups.push(() => window.removeEventListener('error', on_error));
		assert.isTrue(click_link(target, 'bad'));
		assert.deepEqual(errors, []);
	});

	test('an external link opens in a new tab, never in place of the app', () => {
		const open = vi.spyOn(window, 'open').mockImplementation(() => null);
		const target = render({ content: '[ext](https://example.com/page)' });
		const anchor = target.querySelector('a');
		assert.strictEqual(anchor?.target, '_blank');
		assert.isFalse(click_link(target, 'ext'), 'left to the browser, which opens a new tab');
		assert.isFalse(middle_click_link(target, 'ext'), 'a middle click too');
		assert.strictEqual(open.mock.calls.length, 0);
	});

	test('a protocol-relative link is inert', () => {
		const target = render({ content: '[pr](//example.com/x)' });
		assert.isTrue(click_link(target, 'pr'));
		assert.isTrue(middle_click_link(target, 'pr'));
	});
});

describe('MarkdownPreview focus', () => {
	test('takes the pending focus key, clearing it', () => {
		let pending: string | null = 'k';
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(MarkdownPreview, {
			target,
			props: {
				content: '# a',
				focus_key: 'k',
				get pending_element_to_focus_key() {
					return pending;
				},
				set pending_element_to_focus_key(v) {
					pending = v;
				}
			}
		});
		flushSync();
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
		});
		const container = target.firstElementChild;
		assert.ok(container);
		assert.strictEqual(document.activeElement, container);
		assert.isNull(pending);
	});
});

describe('MarkdownPreview in-zzz links', () => {
	const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');
	const GUIDE = parse_or_throw(DiskfilePath, '/w/docs/guide.md');

	let app: Frontend;
	let disk: FakeDisk;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		app = monkeypatch_zzz_for_tests(new Frontend());
		disk = install_fake_disk(app, SOURCE_DIR);
		app.zzz_dir = '/w/';
	});

	const add_file = (path: string, contents: string | null = ''): Promise<Diskfile> =>
		disk.load(path, contents);

	const render_in_app = (props: Record<string, unknown>): HTMLElement => {
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(FrontendContextHarness, {
			target,
			props: { app, component: MarkdownPreview, props }
		});
		flushSync();
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
		});
		return target;
	};

	const status_of = (target: HTMLElement, text: string): string | undefined =>
		find_link(target, text).dataset.linkStatus;

	test('a relative link to an indexed file opens it in a preview tab, without navigating', async () => {
		await add_file(GUIDE);
		const x = await add_file('/w/docs/x.md');
		const target = render_in_app({ path: GUIDE, content: '[x](./x.md)' });
		assert.isTrue(click_link(target, 'x'));
		assert.strictEqual(app.diskfiles.selected_file_id, x.id);
		assert.strictEqual(app.diskfiles.editor.tabs.preview_tab?.diskfile_id, x.id);
	});

	test('a middle click or Ctrl-click opens a kept tab, never a browser tab', async () => {
		await add_file(GUIDE);
		const x = await add_file('/w/docs/x.md');
		const y = await add_file('/w/y.md');
		const target = render_in_app({ path: GUIDE, content: '[x](x.md) [y](../y.md)' });

		assert.isTrue(middle_click_link(target, 'x'));
		assert.strictEqual(app.diskfiles.selected_file_id, x.id);
		assert.isUndefined(app.diskfiles.editor.tabs.preview_tab, 'not the preview tab');

		assert.isTrue(click_link(target, 'y', { ctrlKey: true }));
		assert.strictEqual(app.diskfiles.selected_file_id, y.id);
		assert.isUndefined(app.diskfiles.editor.tabs.preview_tab);
	});

	test('a root-relative link opens from the root holding the file', async () => {
		await add_file(GUIDE);
		const a = await add_file('/w/src/a.md');
		const target = render_in_app({ path: GUIDE, content: '[a](/src/a.md)' });
		assert.isTrue(click_link(target, 'a'));
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	test('a fragment on a markdown file is left for its view to reveal', async () => {
		await add_file(GUIDE);
		const x = await add_file('/w/docs/x.md', '# x\n\n## Part Two');
		const target = render_in_app({ path: GUIDE, content: '[x](./x.md#part-two)' });
		assert.isTrue(click_link(target, 'x'));
		assert.strictEqual(app.diskfiles.get_editor_state(x).markdown_pending_fragment, 'part-two');
	});

	test('a link to a folder opens its README, and marks one without as a folder', async () => {
		await add_file(GUIDE);
		const readme = await add_file('/w/sub/README.md');
		await add_file('/w/bare/x.txt');
		const target = render_in_app({ path: GUIDE, content: '[sub](../sub/) [bare](../bare)' });
		assert.isTrue(click_link(target, 'sub'));
		assert.strictEqual(app.diskfiles.selected_file_id, readme.id);
		assert.include(find_link(target, 'sub').title, 'readme');

		assert.isTrue(click_link(target, 'bare'));
		assert.strictEqual(app.diskfiles.selected_file_id, readme.id, 'nothing opened');
		assert.include(find_link(target, 'bare').title, 'a folder');
		assert.isUndefined(status_of(target, 'bare'));
	});

	test('a missing file inside the index is marked broken, and clicking it does nothing', async () => {
		await add_file(GUIDE);
		app.diskfiles.select(null);
		const target = render_in_app({ path: GUIDE, content: '[gone](./gone.md) [ok](guide.md)' });
		assert.strictEqual(status_of(target, 'gone'), 'broken');
		assert.strictEqual(find_link(target, 'gone').title, 'not found: /w/docs/gone.md');
		assert.isUndefined(status_of(target, 'ok'));
		assert.strictEqual(find_link(target, 'ok').getAttribute('title'), null);
		assert.isTrue(click_link(target, 'gone'));
		assert.isNull(app.diskfiles.selected_file_id);
	});

	test('what the index can not see is marked unknown, never broken', async () => {
		await add_file(GUIDE);
		const target = render_in_app({
			path: GUIDE,
			content: '[far](../../far.md) [nm](../node_modules/x/README.md) [root](/nope.md)'
		});
		assert.strictEqual(status_of(target, 'far'), 'unknown');
		assert.strictEqual(find_link(target, 'far').title, 'outside the open workspaces: /far.md');
		assert.strictEqual(status_of(target, 'nm'), 'unknown');
		assert.strictEqual(status_of(target, 'root'), 'unknown');
	});

	test('marks follow the index and the content', async () => {
		// a diskfile's content is reactive state, standing in for an editor's draft
		const guide = await add_file(GUIDE, '[a](./a.md)');
		const target = render_in_app({
			path: GUIDE,
			get content() {
				return guide.content ?? '';
			}
		});
		assert.strictEqual(status_of(target, 'a'), 'broken');

		await add_file('/w/docs/a.md');
		flushSync();
		assert.isUndefined(status_of(target, 'a'), 'the file appeared');
		assert.isNull(find_link(target, 'a').getAttribute('title'));

		guide.content = '[b](./b.md) [a](./a.md)';
		flushSync();
		assert.strictEqual(status_of(target, 'b'), 'broken', "a new link, in the old one's place");
		assert.isUndefined(status_of(target, 'a'));
	});

	test('a mark never outlives its link, even where the rendered href stays the same', async () => {
		const guide = await add_file('/w/docs/readme.md', '[a](/nope/x.md)');
		const target = render_in_app({
			path: guide.path,
			get content() {
				return guide.content ?? '';
			}
		});
		assert.strictEqual(status_of(target, 'a'), 'unknown');
		assert.include(find_link(target, 'a').title, '/w/nope/x.md');

		// mdz collapses a leading slash run, so the reused anchor keeps its `href`, but the
		// reference is now protocol-relative, which nothing follows; the link after it is still
		// paired with its own anchor
		guide.content = '[a](//nope/x.md) [b](./missing.md)';
		flushSync();
		assert.strictEqual(find_link(target, 'a').getAttribute('href'), '/nope/x.md');
		assert.isUndefined(status_of(target, 'a'));
		assert.isNull(find_link(target, 'a').getAttribute('title'));
		assert.strictEqual(status_of(target, 'b'), 'broken');
	});

	test('a click follows the reference, not the rendered href', async () => {
		const readme = await add_file('/w/readme.md');
		await add_file(GUIDE);
		// rendered `/docs/guide.md`, an indexed file, but written protocol-relative, so inert
		const target = render_in_app({
			path: readme.path,
			content: '[g](//docs/guide.md) [h](docs/guide.md)'
		});
		assert.strictEqual(find_link(target, 'g').getAttribute('href'), '/docs/guide.md');
		assert.isTrue(click_link(target, 'g'));
		assert.isNull(app.diskfiles.selected_file_id);
		// the link after it still follows its own reference
		assert.isTrue(click_link(target, 'h'));
		assert.strictEqual(app.diskfiles.selected_file?.path, GUIDE);
	});

	test('a title the marking did not set is left alone', async () => {
		await add_file(GUIDE);
		const target = render_in_app({ path: GUIDE, content: '[ok](guide.md)' });
		const anchor = find_link(target, 'ok');
		anchor.title = 'from elsewhere';
		await add_file('/w/docs/other.md');
		flushSync();
		assert.strictEqual(anchor.title, 'from elsewhere');
	});

	test('an anchor an injected component renders is left alone, and the links keep their marks', async () => {
		await add_file(GUIDE);
		app.diskfiles.select(null);
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(FrontendContextHarness, {
			target,
			props: {
				app,
				component: MdzCodeLinkHarness,
				props: {
					component: MarkdownPreview,
					props: {
						path: GUIDE,
						content: '[gone](./gone.md) `x` [lost](./lost.md) [ok](guide.md)'
					}
				}
			}
		});
		flushSync();
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
		});
		// the injected anchor sits between the links, and would shift a pairing by order
		const code_anchor = find_link(target, 'x');
		assert.strictEqual(code_anchor.getAttribute('href'), './x.md');
		assert.strictEqual(code_anchor.dataset.mdzStart, '18', "the `Code` node's offsets");
		assert.isUndefined(code_anchor.dataset.linkStatus, 'not marked, though ./x.md is missing');
		assert.isNull(code_anchor.getAttribute('title'));
		assert.strictEqual(status_of(target, 'gone'), 'broken');
		assert.strictEqual(status_of(target, 'lost'), 'broken', 'paired past the injected anchor');
		assert.strictEqual(find_link(target, 'lost').title, 'not found: /w/docs/lost.md');
		assert.isUndefined(status_of(target, 'ok'));
		// a click on it follows nothing, as for any relative anchor the links don't account for
		assert.isTrue(click_link(target, 'x'));
		assert.isNull(app.diskfiles.selected_file_id);
		assert.isTrue(click_link(target, 'ok'));
		assert.strictEqual(app.diskfiles.selected_file?.path, GUIDE);
	});

	test('without a path, nothing is marked or opened', async () => {
		await add_file('/w/docs/x.md');
		const target = render_in_app({ content: '[x](/w/docs/x.md) [gone](./gone.md)' });
		assert.isUndefined(status_of(target, 'gone'));
		assert.isTrue(click_link(target, 'x'));
		assert.isNull(app.diskfiles.selected_file_id);
	});
});

describe('MarkdownPreview source offsets', () => {
	const CARET_CLASS = 'markdown-caret-block';

	const marked = (target: HTMLElement): Array<string> =>
		Array.from(target.querySelectorAll(`.${CARET_CLASS}`), (el) => el.tagName);

	test('mdz renders its offsets, so every link anchor carries its node range', () => {
		const target = render({ content: 'a [b](./b.md)' });
		const anchor = find_link(target, 'b');
		assert.strictEqual(anchor.dataset.mdzStart, '2');
		assert.strictEqual(anchor.dataset.mdzEnd, '13');
	});

	test('marks the innermost block holding the caret, and moves the mark as it moves', () => {
		const content = '# head\n\n- one\n- two\n\npara';
		const props = create_reactive_props<Record<string, unknown>>({ content, caret_offset: null });
		const target = render(props);
		assert.deepEqual(marked(target), [], 'no caret, no mark');

		props.caret_offset = content.indexOf('two') + 1;
		flushSync();
		assert.deepEqual(marked(target), ['LI']);
		assert.strictEqual(target.querySelector(`.${CARET_CLASS}`)?.textContent.trim(), 'two');

		// at the end of a block, as when typing there
		props.caret_offset = content.indexOf('head') + 4;
		flushSync();
		assert.deepEqual(marked(target), ['H1']);

		// a blank line between blocks is in none
		props.caret_offset = content.indexOf('para') - 1;
		flushSync();
		assert.deepEqual(marked(target), []);

		props.caret_offset = content.length;
		flushSync();
		assert.deepEqual(marked(target), ['P']);

		props.caret_offset = null;
		flushSync();
		assert.deepEqual(marked(target), []);
	});

	test('the mark follows a re-render that moves the blocks', () => {
		const props = create_reactive_props<Record<string, unknown>>({
			content: 'para',
			caret_offset: 2
		});
		const target = render(props);
		assert.deepEqual(marked(target), ['P']);
		props.content = '# head\n\npara';
		flushSync();
		assert.deepEqual(marked(target), ['H1'], 'offset 2 is in the heading now');
		props.content = '';
		flushSync();
		assert.deepEqual(marked(target), []);
	});

	const click = (el: Element, init: MouseEventInit = {}): MouseEvent => {
		const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
		el.dispatchEvent(event);
		return event;
	};

	test('a click reports the source start of the innermost element under it', () => {
		const offsets: Array<number> = [];
		const content = 'intro\n\n- one **bold** text\n- two';
		const target = render({ content, onsourceclick: (o: number) => offsets.push(o) });
		const strong = target.querySelector('strong');
		assert.ok(strong);
		click(strong);
		const li = target.querySelectorAll('li')[1];
		assert.ok(li);
		click(li);
		click(target.querySelector('p')!);
		assert.deepEqual(offsets, [content.indexOf('**bold**'), content.indexOf('- two'), 0]);
	});

	test('a link, a multi-click, a modified click, or a selection drag reports nothing', () => {
		const offsets: Array<number> = [];
		const target = render({
			content: 'text [jump](#x) more',
			onsourceclick: (o: number) => offsets.push(o)
		});
		const p = target.querySelector('p')!;
		click(find_link(target, 'jump'));
		click(p, { detail: 2 });
		click(p, { shiftKey: true });
		click(p, { button: 1 });

		const selection = window.getSelection()!;
		selection.selectAllChildren(p);
		click(p);
		selection.removeAllRanges();
		assert.deepEqual(offsets, []);

		click(p, { detail: 1 });
		assert.deepEqual(offsets, [0], 'a plain click still reports');
	});

	test('a touch tap reports nothing, a mouse or pen click as usual', () => {
		const offsets: Array<number> = [];
		const target = render({ content: 'text', onsourceclick: (o: number) => offsets.push(o) });
		const p = target.querySelector('p')!;
		const tap = (pointerType: string): void => {
			p.dispatchEvent(
				new PointerEvent('click', { bubbles: true, cancelable: true, button: 0, pointerType })
			);
		};
		tap('touch');
		assert.deepEqual(offsets, []);
		tap('mouse');
		// deliberate: a pen points as precisely as a mouse
		tap('pen');
		// a keyboard activation or `el.click()`, no pointer at all
		tap('');
		assert.deepEqual(offsets, [0, 0, 0]);
	});

	test("a click sent as a plain `MouseEvent` goes by its press's `pointerType`", () => {
		const offsets: Array<number> = [];
		const target = render({ content: 'text', onsourceclick: (o: number) => offsets.push(o) });
		const p = target.querySelector('p')!;
		const press = (pointerType: string): void => {
			p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType }));
		};
		press('touch');
		click(p);
		assert.deepEqual(offsets, [], 'a touch press makes its click a tap');
		press('mouse');
		click(p);
		press('pen');
		click(p);
		assert.deepEqual(offsets, [0, 0]);

		press('touch');
		click(p);
		click(p);
		assert.deepEqual(offsets, [0, 0, 0], 'a press is read by one click only');

		// a touch that scrolled sends no click, so its press is stale - a click's own type wins
		press('touch');
		p.dispatchEvent(
			new PointerEvent('click', { bubbles: true, cancelable: true, button: 0, pointerType: '' })
		);
		assert.deepEqual(offsets, [0, 0, 0, 0]);
		click(p);
		assert.deepEqual(offsets, [0, 0, 0, 0, 0], 'and that click took the press with it');
	});

	test('without `onsourceclick`, a click reports nothing and throws nothing', () => {
		const target = render({ content: 'text' });
		const event = click(target.querySelector('p')!);
		assert.isFalse(event.defaultPrevented);
	});

	test('offsets past the parse are clamped', () => {
		const offsets: Array<number> = [];
		const content = 'one\n\ntwo';
		const target = render({ content, onsourceclick: (o: number) => offsets.push(o) });
		const p = target.querySelectorAll('p')[1]!;
		// as content authoring the attributes on a registered element could
		p.setAttribute('data-mdz-start', '9999');
		click(p);
		assert.deepEqual(offsets, [content.length]);
	});
});

describe('query_markdown_link_anchors', () => {
	const container_for = (html: string): HTMLElement => {
		const container = document.createElement('div');
		container.innerHTML = html;
		return container;
	};

	test('pairs links and anchors by source offsets, duplicate references included', () => {
		const content = '[one](x.md) [two](x.md) [three](y.md)';
		const links = to_markdown_links(mdz_parse(content));
		assert.deepEqual(
			links.map((l) => [l.start, l.end]),
			[
				[0, 11],
				[12, 23],
				[24, 37]
			]
		);
		// out of document order, so only offsets can pair them
		const container = container_for(
			'<a href="/y.md" data-mdz-start="24" data-mdz-end="37">three</a>' +
				'<a name="no-href" data-mdz-start="0" data-mdz-end="11">named</a>' +
				'<a href="x.md" data-mdz-start="12" data-mdz-end="23">two</a>' +
				'<a href="x.md" data-mdz-start="0" data-mdz-end="11">one</a>'
		);
		const anchors = query_markdown_link_anchors(container, links);
		assert.deepEqual(
			anchors.map((a) => a?.textContent),
			['one', 'two', 'three'],
			'an anchor without an href is not a link, and the hrefs are not compared'
		);
	});

	test('an anchor whose offsets match no link pairs with nothing, and leaves the rest paired', () => {
		const links = to_markdown_links(mdz_parse('[one](x.md) `code` [two](x.md)'));
		const container = container_for(
			'<a href="x.md" data-mdz-start="0" data-mdz-end="11">one</a>' +
				// an injected `code` component rendering a link, with the `Code` node's offsets
				'<a href="/elsewhere" data-mdz-start="12" data-mdz-end="18">code</a>' +
				'<a href="/no-offsets">bare</a>' +
				'<a href="x.md" data-mdz-start="19" data-mdz-end="30">two</a>'
		);
		const anchors = query_markdown_link_anchors(container, links);
		assert.deepEqual(
			anchors.map((a) => a?.textContent),
			['one', 'two']
		);
		assert.strictEqual(find_markdown_link_index(container.querySelectorAll('a')[1]!, links), -1);
		assert.strictEqual(find_markdown_link_index(container.querySelectorAll('a')[2]!, links), -1);
		assert.strictEqual(find_markdown_link_index(container.querySelectorAll('a')[3]!, links), 1);
	});

	test("an anchor carrying a link's exact offsets before the link's own takes it - the first wins", () => {
		const links = to_markdown_links(mdz_parse('[one](x.md)'));
		const container = container_for(
			'<a href="/elsewhere" data-mdz-start="0" data-mdz-end="11">first</a>' +
				'<a href="x.md" data-mdz-start="0" data-mdz-end="11">one</a>'
		);
		assert.deepEqual(
			query_markdown_link_anchors(container, links).map((a) => a?.textContent),
			['first']
		);
	});

	test('a link with no rendered anchor pairs with null, matching only both offsets', () => {
		const links = to_markdown_links(mdz_parse('[one](x.md) [two](x.md)'));
		const container = container_for(
			'<a href="x.md" data-mdz-start="0" data-mdz-end="12">start matches, end does not</a>' +
				'<a href="x.md" data-mdz-start="12" data-mdz-end="23">two</a>'
		);
		assert.deepEqual(
			query_markdown_link_anchors(container, links).map((a) => a?.textContent ?? null),
			[null, 'two']
		);
	});
});
