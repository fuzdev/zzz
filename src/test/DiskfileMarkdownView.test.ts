// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import DiskfileMarkdownView from '#lib/DiskfileMarkdownView.svelte';
import DiskfileView from '#lib/DiskfileView.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * The markdown view is the editor view's twin over the same app-level state
 * (`Diskfiles.get_editor_state`), laid out as source and preview, with a
 * mode remembered per file.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');
const PATH_A = parse_or_throw(DiskfilePath, '/w/a.md');

let app: Frontend;
let disk: FakeDisk;
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
	disk = install_fake_disk(app, SOURCE_DIR);
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

/**
 * An external write, as the filer broadcasts it (metadata only), with the
 * read of the new content it sets off for a file held eagerly landed.
 */
const write_externally = async (path: DiskfilePath, contents: string | null): Promise<Diskfile> => {
	const diskfile = await disk.load(path, contents);
	await flush_reads();
	flushSync();
	return diskfile;
};

/** An external delete, as the filer broadcasts it. */
const delete_externally = (path: DiskfilePath): void => {
	disk.files.delete(path);
	app.diskfiles.handle_change({
		change: { type: 'delete', path },
		disknode: { id: path, source_dir: SOURCE_DIR, size: null, ctime: null, mtime: null }
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
		(b) => to_visible_text(b) === text
	);
	assert.ok(button, `a "${text}" button`);
	button.click();
	flushSync();
};

/** Gives the drawer's panel a transition, as a browser with motion allowed computes it. */
const allow_motion = (): void => {
	const original = window.getComputedStyle.bind(window);
	vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
		el.classList.contains('details-drawer-panel')
			? ({ transitionDuration: '0.2s' } as CSSStyleDeclaration)
			: original(el, pseudo)
	);
};

/** Toggles the details drawer's setting, as the files header's button does. */
const toggle_details = (): void => {
	app.ui.toggle_diskfile_details();
	flushSync();
};

const press_save = (target: EventTarget): void => {
	target.dispatchEvent(
		new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
	);
	flushSync();
};

describe('DiskfileMarkdownView', () => {
	test('DiskfileView routes a markdown file to it', async () => {
		const a = await disk.load(PATH_A, '# title');
		const view = render(DiskfileView, { diskfile: a });
		assert.strictEqual(view.heading(), 'title');
		assert.strictEqual(view.textarea()?.value, '# title');
	});

	test('splits source and preview by default, and the preview follows typing', async () => {
		const a = await disk.load(PATH_A, '# one');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.strictEqual(view.heading(), 'one');
		const textarea = view.textarea();
		assert.ok(textarea);
		type_into(textarea, '# two');
		assert.strictEqual(view.heading(), 'two');
		assert.isTrue(app.diskfiles.get_editor_state(a).has_unsaved_edits);
	});

	test('the chosen mode is remembered per file across remounts', async () => {
		const a = await disk.load(PATH_A, '# one');
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
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.input]),
			[
				['markdown_mode_set', { path: a.path, mode: 'preview' }],
				['markdown_mode_set', { path: a.path, mode: 'source' }]
			],
			'each click is one intent'
		);
	});

	test('a draft survives switching modes', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, '# draft');
		click_button(view.target, 'preview');
		click_button(view.target, 'source');
		assert.strictEqual(view.textarea()?.value, '# draft');
	});

	test('an unloaded file opens read-only in preview', async () => {
		const a = await disk.load(PATH_A, null);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.isNull(view.textarea());
		assert.include(view.target.textContent, "read-only, it can't be edited or saved");
		click_button(view.target, 'split view');
		assert.isTrue(view.textarea()?.readOnly);
	});

	test('Ctrl+S saves in preview mode, with no editor mounted', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, 'v2');
		click_button(view.target, 'preview');
		press_save(document.body);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(a.content, 'v2');
	});

	test('Ctrl+S while conflicted focuses the notice, and resolving refocuses the editor', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, 'mine');
		await write_externally(PATH_A, 'theirs');
		flushSync();
		const alert = view.alert();
		assert.ok(alert);

		press_save(view.textarea()!);
		assert.strictEqual(document.activeElement, alert);
		assert.strictEqual(a.content, 'theirs');

		click_button(view.target, 'keep the disk version');
		assert.strictEqual(document.activeElement, view.textarea());
	});

	test('the details drawer is open until closed, and the preview shows a picked history entry', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('# older', { created: 1 });
		flushSync();
		assert.include(view.target.textContent, 'save changes', 'open by default');

		toggle_details();
		// let the drawer finish its outro
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.notInclude(view.target.textContent, 'save changes');

		editor_state.set_content_from_history(older.id);
		flushSync();
		assert.strictEqual(view.heading(), 'older');
	});

	test('in preview mode, a pending focus key is taken by the preview', async () => {
		const a = await disk.load(PATH_A, '# a');
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		app.ui.pending_element_to_focus_key = a.path;
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.isNull(app.ui.pending_element_to_focus_key);
		const preview = view.target.querySelector('h1')?.closest('[tabindex="-1"]');
		assert.ok(preview);
		assert.strictEqual(document.activeElement, preview);
	});

	test('Ctrl+S in preview mode on an unloaded file writes nothing', async () => {
		const a = await disk.load(PATH_A, null);
		const update = vi.spyOn(app.diskfiles, 'update');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'preview');
		assert.isNull(view.textarea());
		press_save(document.body);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(update.mock.calls.length, 0);
	});

	test('deleted on disk with unsaved edits offers to discard them, then says the tab holds it', async () => {
		const a = await disk.load(PATH_A, 'v1');
		app.diskfiles.select(a.path, true);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, 'mine');
		delete_externally(PATH_A);
		assert.isTrue(a.deleted_on_disk);
		assert.include(view.target.textContent, 'save to recreate it with your edits');

		click_button(view.target, 'discard them');
		const editor_state = app.diskfiles.find_editor_state(a.path);
		assert.isFalse(editor_state?.has_unsaved_edits ?? false);
		assert.include(
			view.target.textContent,
			'deleted on disk — save to recreate it, or close the tab'
		);
	});

	test('the mode buttons show their shortcuts', async () => {
		const a = await disk.load(PATH_A, '# a');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const titles = Array.from(view.target.querySelectorAll('button[aria-pressed]')).map((b) =>
			b.getAttribute('title')
		);
		assert.deepEqual(titles, [
			'split view [Ctrl+Shift+1]',
			'preview [Ctrl+Shift+2]',
			'source [Ctrl+Shift+3]'
		]);
	});
});

const press_mode = (
	target: EventTarget,
	digit: 1 | 2 | 3,
	init: KeyboardEventInit = {}
): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', {
		key: '!@#'[digit - 1],
		code: `Digit${digit}`,
		ctrlKey: true,
		shiftKey: true,
		bubbles: true,
		cancelable: true,
		...init
	});
	target.dispatchEvent(event);
	flushSync();
	return event;
};

describe('DiskfileMarkdownView mode shortcuts', () => {
	test('Ctrl+Shift+1/2/3 switch modes from the editor, and the focus follows', async () => {
		const a = await disk.load(PATH_A, '# a');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const textarea = view.textarea()!;
		textarea.focus();

		const event = press_mode(textarea, 2);
		assert.isTrue(event.defaultPrevented);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'preview');
		assert.isNull(view.textarea());
		const preview = view.target.querySelector('h1')?.closest('[tabindex="-1"]');
		assert.strictEqual(document.activeElement, preview, 'the preview took the focus');

		press_mode(document.activeElement!, 3);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'source');
		assert.strictEqual(document.activeElement, view.textarea());
		assert.isNull(view.heading());

		press_mode(document.activeElement!, 1);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'split');
		assert.ok(view.heading());
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.input]),
			[
				['markdown_mode_set', { path: a.path, mode: 'preview' }],
				['markdown_mode_set', { path: a.path, mode: 'source' }],
				['markdown_mode_set', { path: a.path, mode: 'split' }]
			],
			'each chord is one intent'
		);
	});

	test('work from the page, but leave an input elsewhere its keys', async () => {
		const a = await disk.load(PATH_A, '# a');
		render(DiskfileMarkdownView, { diskfile: a });
		press_mode(document.body, 3);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'source');

		const input = document.createElement('input');
		document.body.append(input);
		cleanups.push(() => input.remove());
		const event = press_mode(input, 2);
		assert.isFalse(event.defaultPrevented);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'source');
	});
});

describe('DiskfileMarkdownView mode shortcut guards', () => {
	/** An element outside the view, removed after the test. */
	const add_outside = <T extends HTMLElement>(el: T): T => {
		document.body.append(el);
		cleanups.push(() => el.remove());
		return el;
	};

	test('a held key repeating switches nothing, though its repeats stay swallowed', async () => {
		const a = await disk.load(PATH_A, '# a');
		render(DiskfileMarkdownView, { diskfile: a });
		const event = press_mode(document.body, 3, { repeat: true });
		assert.isTrue(event.defaultPrevented);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'split');
		assert.strictEqual(app.recent_intents.entries.length, 0, 'no intent');
	});

	test('focus on a non-editable element outside the view stays put, and the mode switches', async () => {
		const a = await disk.load(PATH_A, '# a');
		render(DiskfileMarkdownView, { diskfile: a });
		const button = add_outside(document.createElement('button'));
		button.focus();
		const event = press_mode(button, 2);
		assert.isTrue(event.defaultPrevented);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'preview');
		assert.strictEqual(document.activeElement, button);
	});

	test('a focused element inside a contenteditable elsewhere keeps its keys', async () => {
		const a = await disk.load(PATH_A, '# a');
		render(DiskfileMarkdownView, { diskfile: a });
		const editable = add_outside(document.createElement('div'));
		editable.setAttribute('contenteditable', 'true');
		const inner = document.createElement('span');
		inner.tabIndex = 0;
		editable.append(inner);
		inner.focus();
		const event = press_mode(inner, 3);
		assert.isFalse(event.defaultPrevented);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'split');
	});

	test('a modal dialog open over the page keeps the view as it is', async () => {
		const a = await disk.load(PATH_A, '# a');
		render(DiskfileMarkdownView, { diskfile: a });
		// jsdom has no `showModal`, so the dialog claims `:modal` itself
		const dialog = add_outside(document.createElement('dialog'));
		dialog.setAttribute('open', '');
		const matches = dialog.matches.bind(dialog);
		// `defineProperty`, not assignment: lib.dom types `matches` with type-predicate overloads
		Object.defineProperty(dialog, 'matches', {
			value: (selector: string) => selector === ':modal' || matches(selector)
		});
		const event = press_mode(document.body, 3);
		assert.isFalse(event.defaultPrevented);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'split');

		dialog.removeAttribute('open');
		press_mode(document.body, 3);
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'source');
	});
});

describe('DiskfileMarkdownView outline and links', () => {
	beforeEach(() => {
		// the index covers `/w/`, so a missing file there is broken
		app.zzz_dir = '/w/';
	});

	const DOC = '# Top\n\nintro [gone](./gone.md) and [ok](./a.md)\n\n## Part Two\n\nmore\n';

	test('the drawer outlines the headings; a click puts the caret there and scrolls the preview', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const h2 = view.target.querySelector('h2');
		assert.ok(h2);
		const scroll = vi.fn();
		h2.scrollIntoView = scroll;

		click_button(view.target, 'Part Two');
		assert.strictEqual(scroll.mock.calls.length, 1);
		const textarea = view.textarea()!;
		assert.strictEqual(document.activeElement, textarea);
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('## Part Two'));
		assert.strictEqual(textarea.selectionEnd, DOC.indexOf('## Part Two'));
	});

	test('in source mode the outline only moves the caret; in preview only scrolls', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		click_button(view.target, 'source');
		click_button(view.target, 'Top');
		assert.strictEqual(view.textarea()!.selectionStart, 0);

		click_button(view.target, 'preview');
		const h1 = view.target.querySelector('h1');
		assert.ok(h1);
		const scroll = vi.fn();
		h1.scrollIntoView = scroll;
		click_button(view.target, 'Top');
		assert.strictEqual(scroll.mock.calls.length, 1);
	});

	test('the drawer lists broken links; a click reveals the link', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const section = Array.from(view.target.querySelectorAll('section')).find((el) =>
			el.textContent.includes('broken links')
		);
		assert.ok(section);
		assert.include(section.querySelector('h4')?.textContent, '1');
		const anchor = Array.from(view.target.querySelectorAll('a')).find(
			(el) => el.textContent === 'gone'
		);
		assert.ok(anchor);
		assert.strictEqual(anchor.dataset.linkStatus, 'broken');
		const scroll = vi.fn();
		anchor.scrollIntoView = scroll;

		const button = section.querySelector('button');
		assert.ok(button);
		assert.include(button.textContent, './gone.md');
		button.click();
		flushSync();
		assert.strictEqual(scroll.mock.calls.length, 1);
		assert.strictEqual(document.activeElement, anchor, 'alone, the preview gives the link focus');
	});

	test('the list updates as the source changes', async () => {
		const a = await disk.load(PATH_A, '# a');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		assert.notInclude(view.target.textContent, 'broken links', 'no section without any');
		type_into(view.textarea()!, '[x](./x.md)');
		assert.include(view.target.textContent, 'broken links');
		await write_externally(parse_or_throw(DiskfilePath, '/w/x.md'), '');
		flushSync();
		assert.notInclude(view.target.textContent, 'broken links');
	});

	test('a link from another file reveals its heading once this file shows', async () => {
		const a = await disk.load(PATH_A, DOC);
		const b = await disk.load(parse_or_throw(DiskfilePath, '/w/b.md'), '[to a](./a.md#part-two)');
		app.intents.markdown_mode_set({ path: b.path, mode: 'preview' });
		const view = render(DiskfileView, {
			get diskfile() {
				return app.diskfiles.selected_file ?? b;
			}
		});
		const link = Array.from(view.target.querySelectorAll('a')).find(
			(el) => el.textContent === 'to a'
		);
		assert.ok(link);
		const scrolls: Array<string> = [];
		const original = Element.prototype.scrollIntoView as Element['scrollIntoView'] | undefined;
		Element.prototype.scrollIntoView = function (this: Element) {
			scrolls.push(this.tagName);
		};
		cleanups.push(() => {
			if (original) Element.prototype.scrollIntoView = original;
			else delete (Element.prototype as Partial<Element>).scrollIntoView;
		});
		link.click();
		flushSync();
		assert.strictEqual(app.diskfiles.selected_path, a.path);
		assert.isNull(app.diskfiles.get_editor_state(a).markdown_pending_fragment, 'consumed');
		assert.deepEqual(scrolls, ['H2']);
		const textarea = view.textarea()!;
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('## Part Two'));
	});
});

describe('DiskfileMarkdownView source sync', () => {
	const DOC = '# Top\n\nintro [ok](./a.md)\n\n## Part Two\n\n- one\n- two **bold**\n';
	const CRLF_DOC = DOC.replaceAll('\n', '\r\n');

	const marked = (target: HTMLElement): string | null =>
		target.querySelector('.markdown-caret-block')?.textContent.trim() ?? null;

	const move_caret = (textarea: HTMLTextAreaElement, offset: number): void => {
		textarea.focus();
		textarea.setSelectionRange(offset, offset);
		textarea.dispatchEvent(new Event('keyup', { bubbles: true }));
		flushSync();
	};

	const click = (el: Element): void => {
		el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
		flushSync();
	};

	const find_by_text = (target: HTMLElement, selector: string, text: string): Element => {
		const el = Array.from(target.querySelectorAll(selector)).find(
			(e) => e.textContent.trim() === text
		);
		assert.ok(el, `a ${selector} "${text}"`);
		return el;
	};

	test('the preview marks the block holding the caret, following it and typing', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const textarea = view.textarea()!;
		assert.isNull(marked(view.target), 'no mark before the caret moves');

		move_caret(textarea, DOC.indexOf('two'));
		assert.strictEqual(marked(view.target), 'two bold');
		move_caret(textarea, DOC.indexOf('Part'));
		assert.strictEqual(marked(view.target), 'Part Two');

		// typing at the end of the heading keeps it marked as the preview re-renders
		const at = DOC.indexOf('Part Two') + 'Part Two'.length;
		textarea.value = DOC.slice(0, at) + '!' + DOC.slice(at);
		textarea.setSelectionRange(at + 1, at + 1);
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		assert.strictEqual(marked(view.target), 'Part Two!');
		assert.strictEqual(view.target.querySelectorAll('.markdown-caret-block').length, 1);
	});

	test('clicking a preview block puts the caret at its source', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const textarea = view.textarea()!;

		click(find_by_text(view.target, 'h2', 'Part Two'));
		assert.strictEqual(document.activeElement, textarea);
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('## Part Two'));
		assert.strictEqual(textarea.selectionEnd, DOC.indexOf('## Part Two'));
		assert.strictEqual(marked(view.target), 'Part Two');

		click(find_by_text(view.target, 'strong', 'bold'));
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('**bold**'), 'the innermost element');
		assert.strictEqual(marked(view.target), 'two bold');

		// a link acts as a link, and leaves the caret
		click(find_by_text(view.target, 'a', 'ok'));
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('**bold**'));
	});

	test('in preview mode a click is only a click, and nothing is marked', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const h2 = find_by_text(view.target, 'h2', 'Part Two');
		click(h2);
		assert.isNull(view.textarea());
		assert.strictEqual(app.diskfiles.get_editor_state(a).markdown_view_mode, 'preview');
		assert.isNull(marked(view.target));
	});

	test('the mark goes when the editor does', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		move_caret(view.textarea()!, DOC.indexOf('intro'));
		assert.strictEqual(marked(view.target), 'intro ok');
		click_button(view.target, 'preview');
		assert.isNull(marked(view.target));
		click_button(view.target, 'split view');
		assert.isNull(marked(view.target), 'no stale caret from before');
	});

	test('a CRLF file: the caret, the clicks, and the outline agree with the textarea', async () => {
		const a = await disk.load(PATH_A, CRLF_DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const textarea = view.textarea()!;
		assert.strictEqual(textarea.value, DOC, 'the textarea reads LF');

		move_caret(textarea, DOC.indexOf('one'));
		assert.strictEqual(marked(view.target), 'one');
		move_caret(textarea, DOC.indexOf('Part'));
		assert.strictEqual(marked(view.target), 'Part Two');

		click(find_by_text(view.target, 'li', 'two bold'));
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('- two'));

		click_button(view.target, 'Part Two');
		assert.strictEqual(textarea.selectionStart, DOC.indexOf('## Part Two'));

		// a mode round trip remounts the editor, still writing nothing
		click_button(view.target, 'preview');
		click_button(view.target, 'split view');

		// shown as LF but not edited, so the draft and the disk content are untouched
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.strictEqual(editor_state.current_content, CRLF_DOC);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.dirty);

		// a disk change shows in the editor, LF, and leaves it clean
		const CHANGED = CRLF_DOC.replace('one', 'uno');
		await write_externally(PATH_A, CHANGED);
		flushSync();
		assert.strictEqual(view.textarea()!.value, DOC.replace('one', 'uno'));
		assert.strictEqual(editor_state.current_content, CHANGED);
		assert.isFalse(editor_state.dirty);
		assert.isFalse(editor_state.disk_conflict);
	});
});

describe('DiskfileMarkdownView showing the disk version', () => {
	const DISK = '# Theirs\n\n## Disk Part\n\ntheir text\n';
	const DRAFT = '# Mine\n\nmy text\n';

	const marked = (target: HTMLElement): string | null =>
		target.querySelector('.markdown-caret-block')?.textContent.trim() ?? null;

	/** A split view of a draft `DRAFT` under a disk change to `DISK`, showing the disk. */
	const setup = async () => {
		const a = await disk.load(PATH_A, '# v1');
		const view = render(DiskfileMarkdownView, { diskfile: a });
		type_into(view.textarea()!, DRAFT);
		await write_externally(PATH_A, DISK);
		flushSync();
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isTrue(editor_state.has_conflict);
		click_button(view.target, 'show disk version');
		return { a, view, editor_state };
	};

	test('the editor and the preview show the disk version, read-only, then the draft again', async () => {
		const { view, editor_state } = await setup();

		assert.strictEqual(view.textarea()!.value, DISK);
		assert.isTrue(view.textarea()!.readOnly);
		assert.strictEqual(view.heading(), 'Theirs');
		assert.strictEqual(editor_state.current_content, DRAFT);
		assert.isTrue(editor_state.has_unsaved_edits);

		click_button(view.target, 'show your draft');

		assert.strictEqual(view.textarea()!.value, DRAFT);
		assert.isFalse(view.textarea()!.readOnly);
		assert.strictEqual(view.heading(), 'Mine');
	});

	test('preview mode shows the disk version too', async () => {
		const { view } = await setup();
		click_button(view.target, 'preview');
		assert.isNull(view.textarea());
		assert.strictEqual(view.heading(), 'Theirs');
	});

	test('a click on the preview only moves the caret in the read-only editor', async () => {
		const { view, editor_state } = await setup();
		const h2 = Array.from(view.target.querySelectorAll('h2')).find(
			(el) => el.textContent.trim() === 'Disk Part'
		);
		assert.ok(h2);
		const history_before = editor_state.history.entries.map((entry) => entry.content);

		h2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
		flushSync();

		const textarea = view.textarea()!;
		assert.strictEqual(textarea.selectionStart, DISK.indexOf('## Disk Part'));
		assert.strictEqual(marked(view.target), 'Disk Part');
		assert.strictEqual(editor_state.current_content, DRAFT);
		assert.deepEqual(
			editor_state.history.entries.map((entry) => entry.content),
			history_before
		);
		assert.isTrue(editor_state.showing_disk);
	});

	test('Ctrl+S while showing it stays blocked, and focuses the notice', async () => {
		const { a, view } = await setup();

		press_save(view.textarea()!);
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(document.activeElement, view.alert());
		assert.strictEqual(a.content, DISK);
	});

	test('keeping the disk version ends it, editable', async () => {
		const { view, editor_state } = await setup();

		click_button(view.target, 'keep the disk version');

		assert.isNull(view.alert());
		assert.strictEqual(view.textarea()!.value, DISK);
		assert.isFalse(view.textarea()!.readOnly);
		assert.isFalse(editor_state.showing_disk);
		assert.isFalse(editor_state.has_unsaved_edits);
	});
});

describe('DiskfileMarkdownView outline highlight', () => {
	// A holds B, then a sibling C; laid out at one pixel per source character
	const DOC = '# A\n\nintro\n\n## B\n\nbee\n\n# C\n\nsee\n';

	let frames: Array<() => void> = [];
	beforeEach(() => {
		frames = [];
		vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
		vi.stubGlobal('cancelAnimationFrame', () => {
			frames.length = 0;
		});
	});
	afterEach(() => {
		// last first, so layouts stubbed twice unwind to the original, and unmounted before the frame
		// stubs go, since unmounting cancels a pending frame
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		vi.unstubAllGlobals();
	});

	const run_frames = (): void => {
		for (const frame of frames.splice(0)) frame();
		flushSync();
	};

	/** Each outline item's text, `*` for highlighted and `!` for current with `aria-current`. */
	const lit = (target: HTMLElement): Array<string> =>
		Array.from(target.querySelectorAll('.outline-item')).map((item) => {
			let s = item.textContent.trim();
			if (item.classList.contains('highlighted')) s += '*';
			if (item.classList.contains('current')) {
				assert.strictEqual(item.getAttribute('aria-current'), 'location');
				s += '!';
			} else {
				assert.isFalse(item.hasAttribute('aria-current'));
			}
			return s;
		});

	/**
	 * Lays the preview out at one pixel per source character, `height` tall,
	 * returning a scroll that runs the frame it schedules, and a count of the
	 * blocks measured.
	 */
	const lay_out_preview = (target: HTMLElement, height: number) => {
		const pane = target.querySelector<HTMLElement>('.markdown-preview');
		assert.ok(pane);
		let scroll_top = 0;
		let measured = 0;
		Object.defineProperties(pane, {
			scrollTop: {
				configurable: true,
				get: () => scroll_top,
				set: (v: number) => {
					scroll_top = v;
				}
			},
			clientHeight: { configurable: true, get: () => height }
		});
		const original = Element.prototype.getBoundingClientRect;
		Element.prototype.getBoundingClientRect = function (this: Element) {
			let top = 0;
			let bottom = 0;
			if (this !== pane && pane.contains(this) && this.hasAttribute('data-mdz-start')) {
				measured++;
				top = Number(this.getAttribute('data-mdz-start')) - scroll_top;
				bottom = Number(this.getAttribute('data-mdz-end')) - scroll_top;
			}
			return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top } as DOMRect;
		};
		cleanups.push(() => {
			Element.prototype.getBoundingClientRect = original;
		});
		return {
			scroll: (top: number): void => {
				scroll_top = top;
				pane.dispatchEvent(new Event('scroll'));
				run_frames();
			},
			measured: () => measured
		};
	};

	const move_caret = (textarea: HTMLTextAreaElement, offset: number): void => {
		textarea.focus();
		textarea.setSelectionRange(offset, offset);
		textarea.dispatchEvent(new Event('keyup', { bubbles: true }));
		flushSync();
	};

	test('in the preview alone, sections on screen are lit, and the topmost heading in view is current', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);

		preview.scroll(DOC.indexOf('## B') + 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C'], 'B, inside A');
		preview.scroll(DOC.indexOf('# C') + 1);
		assert.deepEqual(lit(view.target), ['A', 'B', 'C*!']);
		preview.scroll(DOC.indexOf('intro'));
		assert.deepEqual(
			lit(view.target),
			['A*!', 'B', 'C'],
			'no heading in view: the section showing'
		);
	});

	test('a re-render re-reads the preview on the next frame', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C']);

		// the content shifts down under a still scroll, so the view now shows A's intro
		await write_externally(PATH_A, '# A\n\nmore intro\n\nintro\n\n## B\n\nbee\n\n# C\n\nsee\n');
		flushSync();
		run_frames();
		assert.deepEqual(lit(view.target), ['A*!', 'B', 'C']);
	});

	test("beside the editor, the caret's innermost section is current, wherever the preview is", async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C'], 'no caret yet: as the preview alone');

		const textarea = view.textarea()!;
		move_caret(textarea, DOC.indexOf('see'));
		assert.deepEqual(lit(view.target), ['A*', 'B*', 'C!'], 'the caret, off screen');
		move_caret(textarea, DOC.indexOf('bee'));
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C'], 'B, not A around it');
		move_caret(textarea, DOC.indexOf('intro'));
		assert.deepEqual(lit(view.target), ['A*!', 'B*', 'C']);
	});

	test('a caret ends the followed heading, so the preview alone follows afresh', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(0);
		assert.deepEqual(lit(view.target), ['A*!', 'B', 'C'], 'no caret: A, followed');

		move_caret(view.textarea()!, DOC.indexOf('see'));
		// inside B's body, no heading in view
		preview.scroll(DOC.indexOf('bee') - 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*', 'C!']);

		click_button(view.target, 'preview');
		run_frames();
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C'], 'the innermost showing, not A held');
	});

	test('a caret placed with no frame since still ends the followed heading', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(0);
		preview.scroll(DOC.indexOf('bee') - 1);
		assert.deepEqual(lit(view.target), ['A*!', 'B*', 'C'], 'no caret: A held, inside its body');

		move_caret(view.textarea()!, DOC.indexOf('see'));
		click_button(view.target, 'preview');
		run_frames();
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C'], 'the innermost showing, not A held');
	});

	/**
	 * Lays the editor's text out at one pixel per source character, `height`
	 * tall and scrolled to `scroll_top`, with no scroll event.
	 */
	const lay_out_editor = (textarea: HTMLTextAreaElement, scroll_top: number, height: number) => {
		Object.defineProperties(textarea, {
			scrollTop: { configurable: true, get: () => scroll_top },
			clientHeight: { configurable: true, get: () => height }
		});
		const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
		Range.prototype.getClientRects = function (this: Range) {
			const top = this.startOffset;
			return [{ top, bottom: top + 1 }] as unknown as DOMRectList;
		};
		cleanups.push(() => {
			if (original) Object.defineProperty(Range.prototype, 'getClientRects', original);
			else delete (Range.prototype as Partial<Range>).getClientRects;
		});
	};

	test('a mode switch re-reads the pane now being read on the next frame, with no scroll', async () => {
		const a = await disk.load(PATH_A, DOC);
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C'], 'split: the preview');

		const textarea = view.textarea()!;
		lay_out_editor(textarea, DOC.indexOf('# C'), 6);
		click_button(view.target, 'source');
		run_frames();
		assert.deepEqual(lit(view.target), ['A', 'B', 'C*!'], "the editor's C, not the preview's B");

		move_caret(textarea, DOC.indexOf('see'));
		click_button(view.target, 'preview');
		lay_out_preview(view.target, 6);
		run_frames();
		assert.deepEqual(lit(view.target), ['A*!', 'B', 'C'], 'the caret gone, A followed at once');
	});

	test('in the source alone the caret says too', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'source' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		move_caret(view.textarea()!, DOC.indexOf('see'));
		run_frames();
		assert.deepEqual(lit(view.target), ['A', 'B', 'C!'], 'jsdom lays out no lines, so none lit');
	});

	test('with the drawer closed, a scroll measures nothing', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		toggle_details();
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.strictEqual(preview.measured(), 0);

		toggle_details();
		run_frames();
		assert.isAbove(preview.measured(), 0, 'opening it reads the preview');
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C']);
	});

	test('a closing drawer measures nothing as its content slides out', async () => {
		allow_motion();
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		toggle_details();
		assert.ok(view.target.querySelector('.details-drawer-content'), 'still closing');
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.strictEqual(preview.measured(), 0);
		assert.deepEqual(lit(view.target), ['A', 'B', 'C']);
	});

	test('closing the drawer clears its lights, so it reopens with none stale', async () => {
		const a = await disk.load(PATH_A, DOC);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		const view = render(DiskfileMarkdownView, { diskfile: a });
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C']);

		toggle_details();
		preview.scroll(DOC.indexOf('# C') + 1);
		toggle_details();
		assert.deepEqual(lit(view.target), ['A', 'B', 'C'], 'none, until the frame');
		run_frames();
		assert.deepEqual(lit(view.target), ['A', 'B', 'C*!']);
	});

	/** A second file, its headings shaped like `DOC`'s, shown in the same `DiskfileView`. */
	const PATH_B = parse_or_throw(DiskfilePath, '/w/b.md');
	const DOC_B = '# P\n\nintro\n\n## Q\n\nqueue\n\n# R\n\nare\n';

	const render_switching = (a: Diskfile) =>
		render(DiskfileView, {
			get diskfile() {
				return app.diskfiles.selected_file ?? a;
			}
		});

	test("a file switch starts the outline afresh: the caret's current section stays with its file", async () => {
		const a = await disk.load(PATH_A, DOC);
		const b = await disk.load(PATH_B, DOC_B);
		app.diskfiles.select(a.path, true);
		const view = render_switching(a);
		move_caret(view.textarea()!, DOC.indexOf('see'));
		assert.deepEqual(lit(view.target), ['A', 'B', 'C!']);

		app.diskfiles.select(b.path, true);
		flushSync();
		assert.deepEqual(lit(view.target), ['P', 'Q', 'R'], "none of a's");
	});

	test('a file switch starts the outline afresh: the followed heading and lit sections too', async () => {
		const a = await disk.load(PATH_A, DOC);
		const b = await disk.load(PATH_B, DOC_B);
		app.intents.markdown_mode_set({ path: a.path, mode: 'preview' });
		app.intents.markdown_mode_set({ path: b.path, mode: 'preview' });
		app.diskfiles.select(a.path, true);
		const view = render_switching(a);
		const preview = lay_out_preview(view.target, 6);
		preview.scroll(DOC.indexOf('## B') + 1);
		assert.deepEqual(lit(view.target), ['A*', 'B*!', 'C']);

		app.diskfiles.select(b.path, true);
		flushSync();
		assert.deepEqual(lit(view.target), ['P', 'Q', 'R'], "none of a's");
	});
});
