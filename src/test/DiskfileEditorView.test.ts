// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import DiskfileEditorView from '$lib/DiskfileEditorView.svelte';
import DiskfileCloseDialog from '$lib/DiskfileCloseDialog.svelte';
import DiskfileListitem from '$lib/DiskfileListitem.svelte';
import PartEditorForDiskfile from '$lib/PartEditorForDiskfile.svelte';
import { Frontend } from '$lib/frontend.svelte.ts';
import { DiskfilePart } from '$lib/part.svelte.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { create_reactive_props } from './reactive_test_helpers.svelte.ts';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';

/**
 * The file editors are views over app-level state (`Diskfiles.get_editor_state`):
 * disk changes are recorded while no editor is mounted, and a remount or tab
 * switch shows the draft or the current disk content — never stale text.
 */

const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');
const PATH_A = DiskfilePath.parse('/w/a.txt');
const PATH_B = DiskfilePath.parse('/w/b.txt');

const create_disknode = (path: DiskfilePath, contents: string): SerializableDisknode => ({
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
const write_externally = (path: DiskfilePath, contents: string): Diskfile =>
	app.diskfiles.upsert(create_disknode(path, contents));

interface Rendered {
	target: HTMLElement;
	textarea: () => HTMLTextAreaElement;
	alert: () => HTMLElement | null;
	destroy: () => void;
}

const render = (component: Component<any>, props: Record<string, unknown>): Rendered => {
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
		textarea: () => {
			const textarea = target.querySelector('textarea');
			assert.ok(textarea, 'renders a textarea');
			return textarea;
		},
		alert: () => target.querySelector('[role="alert"]'),
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

describe('DiskfileEditorView', () => {
	test('reopening after an external change made while unmounted shows the disk content', () => {
		const a = write_externally(PATH_A, 'v1');
		const first = render(DiskfileEditorView, { diskfile: a });
		assert.strictEqual(first.textarea().value, 'v1');
		first.destroy();

		write_externally(PATH_A, 'v2 external');

		const second = render(DiskfileEditorView, { diskfile: a });
		assert.strictEqual(second.textarea().value, 'v2 external');
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isFalse(editor_state.has_changes);
		assert.isFalse(editor_state.can_save, 'nothing to write back');
		assert.ok(
			editor_state.history.entries.some((entry) => entry.content === 'v2 external'),
			'recorded while unmounted'
		);
	});

	test('a draft survives a remount, and further typing keeps one unsaved entry', () => {
		const a = write_externally(PATH_A, 'v1');
		const first = render(DiskfileEditorView, { diskfile: a });
		type_into(first.textarea(), 'draft');
		first.destroy();

		const second = render(DiskfileEditorView, { diskfile: a });
		assert.strictEqual(second.textarea().value, 'draft');
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isTrue(editor_state.content_was_modified_by_user);

		type_into(second.textarea(), 'draft, more');
		const unsaved = editor_state.history.entries.filter((entry) => entry.is_unsaved_edit);
		assert.strictEqual(unsaved.length, 1);
		assert.strictEqual(unsaved[0]!.content, 'draft, more');
	});

	test('switching tabs keeps the draft, and an external change meanwhile is a conflict', async () => {
		const a = write_externally(PATH_A, 'v1');
		const b = write_externally(PATH_B, 'b');
		const props = create_reactive_props<{ diskfile: Diskfile }>({ diskfile: a });
		const view = render(DiskfileEditorView, props);
		type_into(view.textarea(), 'my draft');

		props.diskfile = b;
		flushSync();
		assert.strictEqual(view.textarea().value, 'b');

		write_externally(PATH_A, 'v2 external');

		props.diskfile = a;
		flushSync();
		assert.strictEqual(view.textarea().value, 'my draft');
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.isTrue(editor_state.has_conflict);
		assert.ok(view.alert(), 'the conflict is shown');

		// Ctrl+S doesn't overwrite the external change
		view
			.textarea()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
			);
		await Promise.resolve();
		assert.strictEqual(a.content, 'v2 external');
	});

	test('the conflict notice overwrites with the draft on request', async () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		assert.isNull(view.alert());

		write_externally(PATH_A, 'theirs');
		flushSync();
		assert.ok(view.alert());
		assert.strictEqual(view.textarea().value, 'mine');
		const save_button = Array.from(view.target.querySelectorAll('button')).find(
			(button) => button.textContent.trim() === 'save changes'
		);
		assert.ok(save_button?.disabled, 'the plain save waits for a choice');

		click_button(view.target, 'overwrite with your draft');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(a.content, 'mine');
		assert.isNull(view.alert());
		assert.isFalse(app.diskfiles.get_editor_state(a).has_unsaved_edits);
	});

	test('the conflict notice names what it overwrites with', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);
		write_externally(PATH_A, 'theirs');
		flushSync();
		// no draft: the version shown
		assert.include(view.target.textContent, 'overwrite with this version');

		type_into(view.textarea(), 'mine');
		assert.include(view.target.textContent, 'overwrite with your draft');
	});

	test('the conflict notice reloads from disk, keeping the draft in the history', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		write_externally(PATH_A, 'theirs');
		flushSync();

		click_button(view.target, 'reload from disk');

		assert.strictEqual(view.textarea().value, 'theirs');
		assert.isNull(view.alert());
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.ok(
			editor_state.history.entries.some(
				(entry) => entry.content === 'mine' && entry.is_discarded_edit
			)
		);
		assert.strictEqual(a.content, 'theirs', 'nothing written');
	});

	test('state a mounted view created stays live after it unmounts', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const { history } = editor_state;
		// read while mounted, as the view does
		assert.isFalse(history.has_unsaved_edits);
		assert.strictEqual(history.current_entry?.content, 'v1');
		view.destroy();

		editor_state.current_content = 'edit after unmount';

		assert.isTrue(history.has_unsaved_edits);
		assert.strictEqual(history.current_entry?.content, 'edit after unmount');
		assert.isTrue(editor_state.has_changes);

		// the dirty-tab rule reads it: a delete on disk keeps the tab
		app.diskfiles.editor.open_diskfile(a.id);
		app.diskfiles.remove_by_path(PATH_A);
		assert.isTrue(a.deleted_on_disk);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), a);
	});
	test('Ctrl+S while conflicted focuses the notice, and resolving refocuses the editor', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		write_externally(PATH_A, 'theirs');
		flushSync();
		const alert = view.alert();
		assert.ok(alert);

		view
			.textarea()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
			);
		flushSync();
		assert.strictEqual(document.activeElement, alert);

		click_button(view.target, 'reload from disk');
		assert.strictEqual(document.activeElement, view.textarea());
	});
});

describe('PartEditorForDiskfile', () => {
	const setup = () => {
		const a = write_externally(PATH_A, 'disk v1');
		const part = new DiskfilePart({ app, json: { path: PATH_A } });
		return { a, part };
	};

	test('follows external changes, so a save never reverts them', async () => {
		const { a, part } = setup();
		const view = render(PartEditorForDiskfile, { diskfile_part: part });
		assert.strictEqual(view.textarea().value, 'disk v1');

		write_externally(PATH_A, 'disk v2');
		flushSync();
		assert.strictEqual(view.textarea().value, 'disk v2');
		assert.strictEqual(part.content, 'disk v2');

		type_into(view.textarea(), 'disk v2, edited');
		assert.strictEqual(part.content, 'disk v2, edited');
		assert.isTrue(await app.diskfiles.get_editor_state(a).save_changes());
		assert.strictEqual(a.content, 'disk v2, edited');
	});

	test('the part keeps tracking the file after the editor unmounts', () => {
		const { part } = setup();
		const view = render(PartEditorForDiskfile, { diskfile_part: part });
		assert.strictEqual(part.content, 'disk v1');
		view.destroy();

		write_externally(PATH_A, 'disk v2');

		assert.strictEqual(part.content, 'disk v2');
	});

	test('shares the draft with the files editor', () => {
		const { a, part } = setup();
		const files_view = render(DiskfileEditorView, { diskfile: a });
		type_into(files_view.textarea(), 'typed in /files');
		files_view.destroy();

		const part_view = render(PartEditorForDiskfile, { diskfile_part: part });

		assert.strictEqual(part_view.textarea().value, 'typed in /files');
		assert.strictEqual(part.content, 'typed in /files');
	});
});

describe('PartEditorForDiskfile deleted on disk', () => {
	test('shows a draft-kept deleted file, and discarding lets it go', () => {
		write_externally(PATH_B, 'b'); // takes the auto-selected tab, so a has none
		const a = write_externally(PATH_A, 'v1');
		assert.isFalse(app.diskfiles.editor.tabs.by_diskfile_id.has(a.id));
		const part = new DiskfilePart({ app, json: { path: PATH_A } });
		const view = render(PartEditorForDiskfile, { diskfile_part: part });
		type_into(view.textarea(), 'part draft');

		app.diskfiles.remove_by_path(PATH_A);
		flushSync();

		assert.isTrue(a.deleted_on_disk);
		assert.strictEqual(view.textarea().value, 'part draft');
		assert.include(view.target.textContent, 'deleted on disk');

		click_button(view.target, 'discard them');

		assert.isUndefined(app.diskfiles.get_by_path(PATH_A));
		assert.isUndefined(part.diskfile);
	});
});

describe('DiskfileListitem', () => {
	test('marks a file with unsaved changes, without creating editing state', () => {
		const a = write_externally(PATH_A, 'v1');
		const view = render(DiskfileListitem, { diskfile: a });
		const item = view.target.querySelector('[role="button"]');
		assert.ok(item);
		assert.isUndefined(app.diskfiles.find_editor_state(a.id));
		assert.notInclude(view.target.textContent, '●');

		app.diskfiles.get_editor_state(a).current_content = 'draft';
		flushSync();

		assert.include(view.target.textContent, '●');
		assert.include(item.getAttribute('aria-label'), 'unsaved changes');
	});
});

describe('DiskfileCloseDialog', () => {
	// jsdom has no modal dialogs
	const dialog_proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
	const originals = { showModal: dialog_proto.showModal, close: dialog_proto.close };
	beforeEach(() => {
		dialog_proto.showModal = function (this: HTMLDialogElement) {
			this.open = true;
		};
		dialog_proto.close = function (this: HTMLDialogElement) {
			this.open = false;
		};
	});
	afterEach(() => {
		// unmount while the stubs are still in place
		for (const cleanup of cleanups.splice(0)) cleanup();
		dialog_proto.showModal = originals.showModal;
		dialog_proto.close = originals.close;
	});

	const setup_pending = () => {
		const a = write_externally(PATH_A, 'v1');
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'draft';
		const view = render(DiskfileCloseDialog, {});
		assert.isNull(view.target.querySelector('dialog'));
		assert.isFalse(app.diskfiles.editor.request_close_tab(tab.id));
		flushSync();
		assert.ok(view.target.querySelector('dialog'), 'asks');
		return { a, tab, editor_state, view };
	};

	test('save writes the draft and closes the tab', async () => {
		const { a, tab, view } = setup_pending();
		click_button(view.target, 'save');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(a.content, 'draft');
		assert.isFalse(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
		assert.isNull(view.target.querySelector('dialog'));
	});

	test("don't save discards the draft into the history and closes the tab", () => {
		const { a, tab, editor_state, view } = setup_pending();
		click_button(view.target, "don't save");

		assert.strictEqual(a.content, 'v1');
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.ok(
			editor_state.history.entries.some(
				(entry) => entry.content === 'draft' && entry.is_discarded_edit
			)
		);
		assert.isFalse(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
	});

	test('save writes the draft, not an older entry the editor shows', async () => {
		const a = write_externally(PATH_A, 'v1');
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		const editor_state = app.diskfiles.get_editor_state(a);
		write_externally(PATH_A, 'v2');
		editor_state.current_content = 'DRAFT';
		const v1 = editor_state.history.entries.find((entry) => entry.content === 'v1');
		assert.ok(v1);
		editor_state.set_content_from_history(v1.id);
		const view = render(DiskfileCloseDialog, {});
		app.diskfiles.editor.request_close_tab(tab.id);
		flushSync();

		click_button(view.target, 'save');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(a.content, 'DRAFT');
		assert.isFalse(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
	});

	test('cancel while the save is in flight keeps the tab', async () => {
		const { tab, view } = setup_pending();
		const deferred = create_deferred<Awaited<ReturnType<Frontend['diskfiles']['update']>>>();
		app.diskfiles.update = () => deferred.promise;

		click_button(view.target, 'save');
		click_button(view.target, 'cancel');
		deferred.resolve({ ok: true, value: null });
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.ok(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
	});

	test('a failure shows for its own close only', async () => {
		const { a, tab, editor_state, view } = setup_pending();
		app.diskfiles.update = () =>
			Promise.resolve({ ok: false, error: { code: -32603, message: 'disk full' } });

		click_button(view.target, 'save');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.include(view.target.textContent, 'disk full');

		click_button(view.target, 'cancel');
		const b = write_externally(PATH_B, 'b');
		app.diskfiles.select(b.id, true);
		app.diskfiles.get_editor_state(b).current_content = 'b draft';
		const b_tab = app.diskfiles.editor.tabs.by_diskfile_id.get(b.id);
		assert.ok(b_tab);
		app.diskfiles.editor.request_close_tab(b_tab.id);
		flushSync();

		assert.ok(view.target.querySelector('dialog'));
		assert.notInclude(view.target.textContent, 'disk full');
		// the first file's close was cancelled, its draft kept
		assert.ok(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
		assert.strictEqual(a.content, 'v1');
		assert.isTrue(editor_state.has_unsaved_edits);
	});

	test("after don't save, focus moves to the next tab's editor", () => {
		const b = write_externally(PATH_B, 'b');
		const a = write_externally(PATH_A, 'v1');
		app.diskfiles.select(b.id, true);
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		app.diskfiles.get_editor_state(a).current_content = 'draft';
		const b_view = render(DiskfileEditorView, { diskfile: b });
		const dialog = render(DiskfileCloseDialog, {});
		app.diskfiles.editor.request_close_tab(tab.id);
		flushSync();

		click_button(dialog.target, "don't save");
		flushSync();

		assert.strictEqual(app.diskfiles.editor.tabs.selected_diskfile_id, b.id);
		assert.strictEqual(document.activeElement, b_view.textarea());
	});

	test("when it lapses, focus moves to the kept tab's editor", () => {
		const { a, editor_state, view } = setup_pending();
		const a_view = render(DiskfileEditorView, { diskfile: a });

		editor_state.discard_draft();
		flushSync();

		assert.isNull(view.target.querySelector('dialog'));
		assert.strictEqual(document.activeElement, a_view.textarea());
	});

	test('cancel leaves focus to the native dialog', () => {
		const { view } = setup_pending();
		click_button(view.target, 'cancel');
		assert.isNull(app.ui.pending_element_to_focus_key);
	});

	test('closes itself when the draft is discarded elsewhere', () => {
		const { editor_state, view } = setup_pending();
		editor_state.discard_draft();
		flushSync();
		assert.isNull(view.target.querySelector('dialog'));
	});

	test('cancel keeps the tab and the draft', () => {
		const { tab, editor_state, view } = setup_pending();
		click_button(view.target, 'cancel');

		assert.ok(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.isNull(view.target.querySelector('dialog'));
	});
});
