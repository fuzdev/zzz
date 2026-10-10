// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import MarkdownPreview from '$lib/MarkdownPreview.svelte';
import { Frontend } from '$lib/frontend.svelte.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { mdz_parse } from '@fuzdev/mdz/mdz.ts';
import { query_markdown_link_anchors, to_markdown_links } from '$lib/markdown_links.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

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
	const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');
	const GUIDE = DiskfilePath.parse('/w/docs/guide.md');

	let app: Frontend;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		app = monkeypatch_zzz_for_tests(new Frontend());
		app.zzz_dir = '/w/';
	});

	const add_file = (path: string, contents: string | null = ''): Diskfile =>
		app.diskfiles.upsert({
			id: DiskfilePath.parse(path),
			source_dir: SOURCE_DIR,
			contents,
			ctime: 1,
			mtime: 1,
			dependents: [],
			dependencies: []
		});

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

	test('a relative link to an indexed file opens it in a preview tab, without navigating', () => {
		add_file(GUIDE);
		const x = add_file('/w/docs/x.md');
		const target = render_in_app({ path: GUIDE, content: '[x](./x.md)' });
		assert.isTrue(click_link(target, 'x'));
		assert.strictEqual(app.diskfiles.selected_file_id, x.id);
		assert.strictEqual(app.diskfiles.editor.tabs.preview_tab?.diskfile_id, x.id);
	});

	test('a middle click or Ctrl-click opens a kept tab, never a browser tab', () => {
		add_file(GUIDE);
		const x = add_file('/w/docs/x.md');
		const y = add_file('/w/y.md');
		const target = render_in_app({ path: GUIDE, content: '[x](x.md) [y](../y.md)' });

		assert.isTrue(middle_click_link(target, 'x'));
		assert.strictEqual(app.diskfiles.selected_file_id, x.id);
		assert.isUndefined(app.diskfiles.editor.tabs.preview_tab, 'not the preview tab');

		assert.isTrue(click_link(target, 'y', { ctrlKey: true }));
		assert.strictEqual(app.diskfiles.selected_file_id, y.id);
		assert.isUndefined(app.diskfiles.editor.tabs.preview_tab);
	});

	test('a root-relative link opens from the root holding the file', () => {
		add_file(GUIDE);
		const a = add_file('/w/src/a.md');
		const target = render_in_app({ path: GUIDE, content: '[a](/src/a.md)' });
		assert.isTrue(click_link(target, 'a'));
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	test('a fragment on a markdown file is left for its view to reveal', () => {
		add_file(GUIDE);
		const x = add_file('/w/docs/x.md', '# x\n\n## Part Two');
		const target = render_in_app({ path: GUIDE, content: '[x](./x.md#part-two)' });
		assert.isTrue(click_link(target, 'x'));
		assert.strictEqual(app.diskfiles.get_editor_state(x).markdown_pending_fragment, 'part-two');
	});

	test('a link to a folder opens its README, and marks one without as a folder', () => {
		add_file(GUIDE);
		const readme = add_file('/w/sub/README.md');
		add_file('/w/bare/x.txt');
		const target = render_in_app({ path: GUIDE, content: '[sub](../sub/) [bare](../bare)' });
		assert.isTrue(click_link(target, 'sub'));
		assert.strictEqual(app.diskfiles.selected_file_id, readme.id);
		assert.include(find_link(target, 'sub').title, 'readme');

		assert.isTrue(click_link(target, 'bare'));
		assert.strictEqual(app.diskfiles.selected_file_id, readme.id, 'nothing opened');
		assert.include(find_link(target, 'bare').title, 'a folder');
		assert.isUndefined(status_of(target, 'bare'));
	});

	test('a missing file inside the index is marked broken, and clicking it does nothing', () => {
		add_file(GUIDE);
		app.diskfiles.select(null);
		const target = render_in_app({ path: GUIDE, content: '[gone](./gone.md) [ok](guide.md)' });
		assert.strictEqual(status_of(target, 'gone'), 'broken');
		assert.strictEqual(find_link(target, 'gone').title, 'not found: /w/docs/gone.md');
		assert.isUndefined(status_of(target, 'ok'));
		assert.strictEqual(find_link(target, 'ok').getAttribute('title'), null);
		assert.isTrue(click_link(target, 'gone'));
		assert.isNull(app.diskfiles.selected_file_id);
	});

	test('what the index can not see is marked unknown, never broken', () => {
		add_file(GUIDE);
		const target = render_in_app({
			path: GUIDE,
			content: '[far](../../far.md) [nm](../node_modules/x/README.md) [root](/nope.md)'
		});
		assert.strictEqual(status_of(target, 'far'), 'unknown');
		assert.strictEqual(find_link(target, 'far').title, 'outside the open workspaces: /far.md');
		assert.strictEqual(status_of(target, 'nm'), 'unknown');
		assert.strictEqual(status_of(target, 'root'), 'unknown');
	});

	test('marks follow the index and the content', () => {
		// a diskfile's content is reactive state, standing in for an editor's draft
		const guide = add_file(GUIDE, '[a](./a.md)');
		const target = render_in_app({
			path: GUIDE,
			get content() {
				return guide.content ?? '';
			}
		});
		assert.strictEqual(status_of(target, 'a'), 'broken');

		add_file('/w/docs/a.md');
		flushSync();
		assert.isUndefined(status_of(target, 'a'), 'the file appeared');
		assert.isNull(find_link(target, 'a').getAttribute('title'));

		guide.content = '[b](./b.md) [a](./a.md)';
		flushSync();
		assert.strictEqual(status_of(target, 'b'), 'broken', "a new link, in the old one's place");
		assert.isUndefined(status_of(target, 'a'));
	});

	test('a mark never outlives its link, even where the rendered href differs from the reference', () => {
		add_file(GUIDE);
		const guide = add_file('/w/docs/readme.md', '[a](/nope/x.md)');
		const target = render_in_app({
			path: guide.path,
			get content() {
				return guide.content ?? '';
			}
		});
		assert.strictEqual(status_of(target, 'a'), 'unknown');
		assert.include(find_link(target, 'a').title, '/w/nope/x.md');

		// mdz renders a root-relative reference through SvelteKit's `resolve`, dropping the empty
		// segment, and reuses the anchor in place
		guide.content = '[a](/docs//guide.md)';
		flushSync();
		assert.strictEqual(find_link(target, 'a').getAttribute('href'), '/docs/guide.md');
		assert.isUndefined(status_of(target, 'a'), 'the file exists');
		assert.isNull(find_link(target, 'a').getAttribute('title'));
	});

	test('a click follows the reference, not the rendered href', () => {
		const readme = add_file('/w/readme.md');
		add_file(GUIDE);
		const target = render_in_app({ path: readme.path, content: '[g](/docs//guide.md)' });
		assert.isTrue(click_link(target, 'g'));
		assert.strictEqual(app.diskfiles.selected_file?.path, GUIDE);
	});

	test('a title the marking did not set is left alone', () => {
		add_file(GUIDE);
		const target = render_in_app({ path: GUIDE, content: '[ok](guide.md)' });
		const anchor = find_link(target, 'ok');
		anchor.title = 'from elsewhere';
		add_file('/w/docs/other.md');
		flushSync();
		assert.strictEqual(anchor.title, 'from elsewhere');
	});

	test('without a path, nothing is marked or opened', () => {
		add_file('/w/docs/x.md');
		const target = render_in_app({ content: '[x](/w/docs/x.md) [gone](./gone.md)' });
		assert.isUndefined(status_of(target, 'gone'));
		assert.isTrue(click_link(target, 'x'));
		assert.isNull(app.diskfiles.selected_file_id);
	});
});

describe('query_markdown_link_anchors', () => {
	const container_for = (html: string): HTMLElement => {
		const container = document.createElement('div');
		container.innerHTML = html;
		return container;
	};

	test('pairs links and anchors by document order, duplicates included', () => {
		const links = to_markdown_links(mdz_parse('[one](x.md) [two](x.md) [three](y.md)'));
		const container = container_for(
			'<a href="x.md">one</a><a name="no-href">named</a><a href="x.md">two</a><a href="/y.md">three</a>'
		);
		const anchors = query_markdown_link_anchors(container, links);
		assert.ok(anchors);
		assert.deepEqual(
			anchors.map((a) => a.textContent),
			['one', 'two', 'three'],
			'an anchor without an href is not a link, and the hrefs are not compared'
		);
	});

	test('pairs nothing when an unrelated anchor makes the counts disagree', () => {
		const links = to_markdown_links(mdz_parse('[one](x.md) [two](x.md)'));
		const container = container_for(
			'<a href="x.md">one</a><a href="/elsewhere">unrelated</a><a href="x.md">two</a>'
		);
		assert.isNull(query_markdown_link_anchors(container, links));
	});
});
