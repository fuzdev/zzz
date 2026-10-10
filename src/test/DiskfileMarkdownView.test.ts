// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import DiskfileMarkdownView from '$lib/DiskfileMarkdownView.svelte';
import DiskfileView from '$lib/DiskfileView.svelte';
import { Frontend } from '$lib/frontend.svelte.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

/**
 * The markdown view is the editor view's twin over the same app-level state
 * (`Diskfiles.get_editor_state`), laid out as source and preview, with a
 * mode remembered per file.
 */

const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');
const PATH_A = DiskfilePath.parse('/w/a.md');

const create_disknode = (path: DiskfilePath, contents: string | null): SerializableDisknode => ({
	id: path,
	source_dir: SOURCE_DIR,
	contents,
	ctime: 1,
	mtime: 1,
	dependents: [],
	dependencies: []
});

let app: Frontend;
const cleanups: Array<() => void> = [];

// jsdom has no Web Animations, which Svelte transitions use
const animate_original = Element.prototype.animate as Element['animate'] | undefined;
const animate_stub = function (this: Element): Animation {
	const animation = {
		onfinish: null as (() => void) | null,
		cancel: () => {},
		finished: Promise.resolve()
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

beforeEach(() => {
	Element.prototype.animate = animate_stub;
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	if (animate_original) {
		Element.prototype.animate = animate_original;
	} else {
		delete (Element.prototype as Partial<Element>).animate;
	}
});

/** An external write, as the filer broadcasts it. */
const write_externally = (path: DiskfilePath, contents: string | null): Diskfile =>
	app.diskfiles.upsert(create_disknode(path, contents));

/** An external delete, as the filer broadcasts it. */
const delete_externally = (path: DiskfilePath): void => {
	app.diskfiles.handle_change({
		change: { type: 'delete', path },
		disknode: create_disknode(path, null)
	});
	flushSync();
};

const render = (component: Component<any>, props: Record<string, unknown>) => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, { target, props: { app, component, props } });
	flushSync();
	let destroyed = false;
	const destroy = (): void => {
		if (destroyed) return;
		destroyed = true;
		void unmount(mounted);
		target.remove();
		flushSync();
	};
	cleanups.push(destroy);
	return {
		target,
		textarea: () => target.querySelector('textarea'),
		heading: () => target.querySelector('h1')?.textContent ?? null,
		alert: () => target.querySelector<HTMLElement>('[role="alert"]'),
		destroy
	};
};

const type_into = (textarea: HTMLTextAreaElement, value: string): void => {
	textarea.value = value;
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

const click_button = (target: HTMLElement, text: string): void => {
	const button = Array.from(target.querySelectorAll('button')).find(
		(b) => b.textContent.trim() === text
	);
	assert.ok(button, `a "${text}" button`);
	button.click();
	flushSync();
};

const press_save = (target: EventTarget): void => {
	target.dispatchEvent(
		new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
	);
	flushSync();
};

describe('DiskfileMarkdownView', () => {
	test('DiskfileView routes a markdown file to it', () => {
		const a = write_externally(PATH_A, '# title');
		const view = render(DiskfileView, { diskfile: a });
		assert.strictEqual(view.heading(), 'title');
		assert.strictEqual(view.textarea()?.value, '# title');
	});

	test('splits source and preview by default, and the preview follows typing', () => {
		const a = write_externally(PATH_A, '# one');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.strictEqual(view.heading(), 'one');
		const textarea = view.textarea();
		assert.ok(textarea);
		type_into(textarea, '# two');
		assert.strictEqual(view.heading(), 'two');
		assert.isTrue(app.diskfiles.get_editor_state(a).has_unsaved_edits);
	});

	test('the chosen mode is remembered per file across remounts', () => {
		const a = write_externally(PATH_A, '# one');
		const first = render(DiskfileMarkdownView, { diskfile: a });
		click_button(first.target, 'preview');
		assert.isNull(first.textarea());
		assert.strictEqual(first.heading(), 'one');
		first.destroy();

		const second = render(DiskfileMarkdownView, { diskfile: a });
		assert.isNull(second.textarea());
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'preview');

		click_button(second.target, 'source');
		assert.ok(second.textarea());
		assert.isNull(second.heading());
	});

	test('a draft survives switching modes', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, '# draft');
		click_button(view.target, 'preview');
		click_button(view.target, 'source');
		assert.strictEqual(view.textarea()?.value, '# draft');
	});

	test('an unloaded file opens read-only in preview', () => {
		const a = write_externally(PATH_A, null);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.isNull(view.textarea());
		assert.include(view.target.textContent, "read-only, it can't be edited or saved");
		click_button(view.target, 'split view');
		assert.isTrue(view.textarea()?.readOnly);
	});

	test('Ctrl+S saves in preview mode, with no editor mounted', async () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, 'v2');
		click_button(view.target, 'preview');
		press_save(document.body);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(a.content, 'v2');
	});

	test('Ctrl+S while conflicted focuses the notice, and resolving refocuses the editor', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, 'mine');
		write_externally(PATH_A, 'theirs');
		flushSync();
		const alert = view.alert();
		assert.ok(alert);

		press_save(view.textarea()!);
		assert.strictEqual(document.activeElement, alert);
		assert.strictEqual(a.content, 'theirs');

		click_button(view.target, 'reload from disk');
		assert.strictEqual(document.activeElement, view.textarea());
	});

	test('the details drawer is closed until asked for, and the preview shows a picked history entry', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('# older', { created: 1 });
		flushSync();
		assert.notInclude(view.target.textContent, 'save changes', 'closed by default');

		click_button(view.target, 'details');
		assert.include(view.target.textContent, 'save changes');

		editor_state.set_content_from_history(older.id);
		flushSync();
		assert.strictEqual(view.heading(), 'older');
	});

	test('a save error shows with the drawer closed, and once with it open', async () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		app.diskfiles.get_editor_state(a).save_error = 'disk full';
		flushSync();
		const count = (): number => view.target.textContent.split('save failed: disk full').length - 1;
		assert.strictEqual(count(), 1, 'closed drawer');
		click_button(view.target, 'details');
		// let the main column's copy finish its outro
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.strictEqual(count(), 1, 'open drawer');
	});

	test('in preview mode, a pending focus key is taken by the preview', () => {
		const a = write_externally(PATH_A, '# a');
		app.diskfiles.get_editor_state(a).markdown_view_mode_choice = 'preview';
		app.ui.pending_element_to_focus_key = a.id;
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.isNull(app.ui.pending_element_to_focus_key);
		const preview = view.target.querySelector('h1')?.closest('[tabindex="-1"]');
		assert.ok(preview);
		assert.strictEqual(document.activeElement, preview);
	});

	test('Ctrl+S in preview mode on an unloaded file writes nothing', async () => {
		const a = write_externally(PATH_A, null);
		const update = vi.spyOn(app.diskfiles, 'update');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'preview');
		assert.isNull(view.textarea());
		press_save(document.body);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(update.mock.calls.length, 0);
	});

	test('deleted on disk with unsaved edits offers to discard them, then says the tab holds it', () => {
		const a = write_externally(PATH_A, 'v1');
		app.diskfiles.select(a.id, true);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, 'mine');
		delete_externally(PATH_A);
		assert.isTrue(a.deleted_on_disk);
		assert.include(view.target.textContent, 'save to recreate it with your edits');

		click_button(view.target, 'discard them');
		const editor_state = app.diskfiles.find_editor_state(a.id);
		assert.isFalse(editor_state?.has_unsaved_edits ?? false);
		assert.include(
			view.target.textContent,
			'deleted on disk — save to recreate it, or close the tab'
		);
	});
});
