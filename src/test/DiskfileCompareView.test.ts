// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import DiskfileEditorView from '#lib/DiskfileEditorView.svelte';
import DiskfileMarkdownView from '#lib/DiskfileMarkdownView.svelte';
import PartEditorForDiskfile from '#lib/PartEditorForDiskfile.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfilePart } from '#lib/part.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * The file views show a diff (`DiskfileCompareView`) in place of the editor
 * while a file is compared, the editor kept mounted beneath it.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');
const PATH_TXT = parse_or_throw(DiskfilePath, '/w/a.txt');
const PATH_MD = parse_or_throw(DiskfilePath, '/w/b.md');

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

const render = (component: Component<any>, props: Record<string, unknown>): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, { target, props: { app, component, props } });
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

const textarea_of = (target: HTMLElement): HTMLTextAreaElement => {
	const textarea = target.querySelector('textarea');
	assert.ok(textarea, 'renders a textarea');
	return textarea;
};

const type_into = (textarea: HTMLTextAreaElement, value: string): void => {
	textarea.value = value;
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

const find_buttons = (target: HTMLElement, text: string): Array<HTMLButtonElement> =>
	Array.from(target.querySelectorAll('button')).filter((b) => to_visible_text(b) === text);

const click = (button: HTMLElement | undefined): void => {
	assert.ok(button);
	button.click();
	flushSync();
};

/** Whether the element or an ancestor is hidden by the `display:none` class. */
const is_hidden = (el: Element): boolean => !!el.closest('[class~="display:none"]');

const diff_of = (target: HTMLElement): HTMLElement | null => target.querySelector('.code_diff');

describe('the compare view', () => {
	test("the actions' compare shows the diff over the editor, and close goes back", async () => {
		const a = await disk.load(PATH_TXT, 'one\ntwo\n');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'one\nthree\n');
		assert.isNull(diff_of(target));

		click(find_buttons(target, 'compare')[0]);

		const diff = diff_of(target);
		assert.ok(diff, 'renders the diff');
		assert.include(diff.querySelector('del')?.textContent, 'two');
		assert.include(diff.querySelector('ins')?.textContent, 'three');
		const textarea = textarea_of(target);
		assert.isTrue(is_hidden(textarea), 'the editor is hidden, not unmounted');
		assert.strictEqual(textarea.value, 'one\nthree\n');

		click(find_buttons(target, 'close')[0]);

		assert.isNull(diff_of(target));
		assert.isFalse(is_hidden(textarea_of(target)));
		assert.isFalse(app.diskfiles.compare_bases.has(PATH_TXT));
	});

	test('a clean file says it has no changes', async () => {
		const a = await disk.load(PATH_TXT, 'same');
		const target = render(DiskfileEditorView, { diskfile: a });
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();
		assert.isNull(diff_of(target));
		assert.include(to_visible_text(target), 'no changes');
	});

	test('split shows the versions side by side, a choice every diff shares', async () => {
		const a = await disk.load(PATH_TXT, 'one');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'two');
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();
		assert.isFalse(diff_of(target)?.classList.contains('split'));

		click(find_buttons(target, 'split')[0]);

		assert.isTrue(app.ui.diff_split);
		assert.isTrue(diff_of(target)?.classList.contains('split'));
	});

	test('the base picker compares against a history entry', async () => {
		const a = await disk.load(PATH_TXT, 'v1');
		const target = render(DiskfileEditorView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const entry = editor_state.history.add_entry('older');
		type_into(textarea_of(target), 'mine');
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();

		const select = target.querySelector('select');
		assert.ok(select);
		select.value = entry.id;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		assert.strictEqual(app.diskfiles.compare_bases.get(PATH_TXT), entry.id);
		assert.include(diff_of(target)?.querySelector('del')?.textContent, 'older');
	});

	test("the conflict notice's compare diffs the disk version against the draft", async () => {
		const a = await disk.load(PATH_TXT, 'v1');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'mine');
		await disk.load(PATH_TXT, 'theirs');
		await flush_reads();
		flushSync();
		const alert = target.querySelector('[role="alert"]');
		assert.ok(alert);

		click(find_buttons(alert as HTMLElement, 'compare')[0]);

		const diff = diff_of(target);
		assert.include(diff?.querySelector('del')?.textContent, 'theirs');
		assert.include(diff?.querySelector('ins')?.textContent, 'mine');
		const toggle = find_buttons(alert as HTMLElement, 'compare')[0];
		assert.strictEqual(
			toggle?.getAttribute('aria-pressed'),
			'true',
			'stays, pressed, keeping the focus'
		);
	});

	test('settling the conflict ends its compare, the editor shown again', async () => {
		const a = await disk.load(PATH_TXT, 'v1');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'mine');
		await disk.load(PATH_TXT, 'theirs');
		await flush_reads();
		flushSync();
		const alert = target.querySelector<HTMLElement>('[role="alert"]');
		assert.ok(alert);
		click(find_buttons(alert, 'compare')[0]);
		assert.ok(diff_of(target));
		assert.lengthOf(find_buttons(alert, 'show disk version'), 0, 'the diff covers the editor');

		click(find_buttons(alert, 'keep the disk version')[0]);

		assert.isFalse(app.diskfiles.compare_bases.has(PATH_TXT));
		assert.isNull(diff_of(target));
		assert.isFalse(is_hidden(textarea_of(target)));
	});

	test('settling keeps a compare from a history entry, which still has changes to show', async () => {
		const a = await disk.load(PATH_TXT, 'v1');
		const target = render(DiskfileEditorView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('older');
		type_into(textarea_of(target), 'mine');
		await disk.load(PATH_TXT, 'theirs');
		await flush_reads();
		flushSync();
		app.intents.file_compare_set({ path: PATH_TXT, base: older.id });
		flushSync();
		const alert = target.querySelector<HTMLElement>('[role="alert"]');
		assert.ok(alert);

		click(find_buttons(alert, 'keep the disk version')[0]);

		assert.strictEqual(app.diskfiles.compare_bases.get(PATH_TXT), older.id);
		assert.include(diff_of(target)?.querySelector('ins')?.textContent, 'theirs');
		assert.strictEqual(
			document.activeElement,
			target.querySelector('select'),
			'the compare takes the focus, the editor being hidden'
		);
	});

	test('closing or settling refocuses the editor once it shows again', async () => {
		const a = await disk.load(PATH_TXT, 'v1');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'mine');
		await disk.load(PATH_TXT, 'theirs');
		await flush_reads();
		flushSync();
		const alert = target.querySelector<HTMLElement>('[role="alert"]');
		assert.ok(alert);
		// jsdom applies no stylesheet, so record whether the textarea was still in the hidden subtree
		const hidden_at_focus: Array<boolean> = [];
		const textarea = textarea_of(target);
		const focus = textarea.focus.bind(textarea);
		textarea.focus = (options) => {
			hidden_at_focus.push(is_hidden(textarea));
			focus(options);
		};

		click(find_buttons(alert, 'compare')[0]);
		click(find_buttons(target, 'close')[0]);
		click(find_buttons(alert, 'compare')[0]);
		click(find_buttons(alert, 'keep the disk version')[0]);

		assert.deepEqual(hidden_at_focus, [false, false]);
	});

	test('a CRLF file is compared as LF, with a note, so one edit shows one line', async () => {
		const a = await disk.load(PATH_TXT, 'one\r\ntwo\r\nthree\r\n');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'one\nTWO\nthree\n');
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();

		const diff = diff_of(target);
		assert.lengthOf(diff?.querySelectorAll('del') ?? [], 1);
		assert.lengthOf(diff?.querySelectorAll('ins') ?? [], 1);
		assert.include(to_visible_text(target), 'saving converts');
	});

	test('a lone CR is compared as LF too', async () => {
		const a = await disk.load(PATH_TXT, 'one\r\ntwo\rthree\r\n');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'one\nTWO\nthree\n');
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();
		assert.lengthOf(diff_of(target)?.querySelectorAll('del') ?? [], 1);
		assert.lengthOf(diff_of(target)?.querySelectorAll('ins') ?? [], 1);
	});

	test('edits reverted on a CRLF file say only the line endings differ', async () => {
		const a = await disk.load(PATH_TXT, 'one\r\ntwo\r\n');
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), 'one\ntwo\n');
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();
		const text = to_visible_text(target);
		assert.include(text, 'only the line endings differ');
		assert.notInclude(text, 'the two versions are the same');
		assert.include(text, 'saving converts');
	});

	test("a CRLF history entry against an LF disk notes the entry's endings, not a save's", async () => {
		const a = await disk.load(PATH_TXT, 'one\ntwo\n');
		const target = render(DiskfileEditorView, { diskfile: a });
		const older = app.diskfiles.get_editor_state(a).history.add_entry('one\r\ntwo\r\n');
		app.intents.file_compare_set({ path: PATH_TXT, base: older.id });
		flushSync();
		const text = to_visible_text(target);
		assert.include(text, "this version's CRLF or CR line endings are compared as LF");
		assert.notInclude(text, 'saving converts');
		assert.include(text, 'only the line endings differ');
	});

	test('a large file shows only its changes, its unchanged lines left out', async () => {
		const line = 'x'.repeat(99) + '\n';
		const big = line.repeat(3000); // about 300 KiB, over the fold limit
		const a = await disk.load(PATH_TXT, big);
		const target = render(DiskfileEditorView, { diskfile: a });
		type_into(textarea_of(target), big + 'added\n');
		app.intents.file_compare_set({ path: PATH_TXT, base: 'disk' });
		flushSync();

		const diff = diff_of(target);
		assert.ok(diff);
		assert.isNull(diff.querySelector('details'), 'nothing folded');
		assert.include(diff.querySelector('ins')?.textContent, 'added');
		assert.include(to_visible_text(target), 'shows only its changes');
	});

	test('the markdown view shows the diff over its panes', async () => {
		const b = await disk.load(PATH_MD, '# a\n');
		const target = render(DiskfileMarkdownView, { diskfile: b });
		type_into(textarea_of(target), '# b\n');

		click(find_buttons(target, 'compare')[0]);

		assert.ok(diff_of(target));
		assert.isTrue(is_hidden(textarea_of(target)));
	});

	test("a file part's conflict notice offers no compare, having no diff to show", async () => {
		await disk.load(PATH_TXT, 'v1');
		const part = new DiskfilePart({ app, json: { path: PATH_TXT } });
		const target = render(PartEditorForDiskfile, { diskfile_part: part });
		await flush_reads();
		flushSync();
		type_into(textarea_of(target), 'mine');
		await disk.load(PATH_TXT, 'theirs');
		await flush_reads();
		flushSync();
		assert.ok(target.querySelector('[role="alert"]'), 'in conflict');
		assert.lengthOf(find_buttons(target, 'compare'), 0);
	});
});
