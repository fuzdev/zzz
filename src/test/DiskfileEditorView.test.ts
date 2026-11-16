// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import DiskfileEditorView from '#lib/DiskfileEditorView.svelte';
import DiskfileMarkdownView from '#lib/DiskfileMarkdownView.svelte';
import { DISKFILE_CONTENT_LOADING_MESSAGE } from '#lib/diskfile_helpers.ts';
import { SAVE_ERROR_CHANGED_AGAIN } from '#lib/diskfile_editor_state.svelte.ts';
import DiskfileCloseDialog from '#lib/DiskfileCloseDialog.svelte';
import DiskfileListitem from '#lib/DiskfileListitem.svelte';
import DiskfileTabListitem from '#lib/DiskfileTabListitem.svelte';
import PartEditorForDiskfile from '#lib/PartEditorForDiskfile.svelte';
import PartSummary from '#lib/PartSummary.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfilePart } from '#lib/part.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { create_reactive_props } from './reactive_test_helpers.svelte.ts';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';
import {
	answer_update,
	content_hash,
	flush_reads,
	install_fake_disk,
	type FakeDisk,
	type HeldUpdateResult
} from './diskfile_test_helpers.ts';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';
import { jsonrpc_error_messages } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

/**
 * The file editors are views over app-level state (`Diskfiles.get_editor_state`):
 * disk changes are recorded while no editor is mounted, and a remount or tab
 * switch shows the draft or the current disk content — never stale text.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');
const PATH_A = parse_or_throw(DiskfilePath, '/w/a.txt');
const PATH_B = parse_or_throw(DiskfilePath, '/w/b.txt');

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
const write_externally = async (path: DiskfilePath, contents: string): Promise<Diskfile> => {
	const diskfile = await disk.load(path, contents);
	await flush_reads();
	flushSync();
	return diskfile;
};

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
		(b) => to_visible_text(b) === text
	);
	assert.ok(button, `a "${text}" button`);
	button.click();
	flushSync();
};

describe('DiskfileEditorView', () => {
	test('reopening after an external change made while unmounted shows the disk content', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const first = render(DiskfileEditorView, { diskfile: a });
		assert.strictEqual(first.textarea().value, 'v1');
		first.destroy();

		await write_externally(PATH_A, 'v2 external');

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

	test('a draft survives a remount, and further typing keeps one unsaved entry', async () => {
		const a = await disk.load(PATH_A, 'v1');
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
		const a = await disk.load(PATH_A, 'v1');
		const b = await disk.load(PATH_B, 'b');
		const props = create_reactive_props<{ diskfile: Diskfile }>({ diskfile: a });
		const view = render(DiskfileEditorView, props);
		type_into(view.textarea(), 'my draft');

		props.diskfile = b;
		flushSync();
		assert.strictEqual(view.textarea().value, 'b');

		await write_externally(PATH_A, 'v2 external');

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
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		assert.isNull(view.alert());

		await write_externally(PATH_A, 'theirs');
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

	test('the conflict notice names what it overwrites with', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);
		await write_externally(PATH_A, 'theirs');
		flushSync();
		// no draft: the version shown
		assert.include(view.target.textContent, 'overwrite with this version');

		type_into(view.textarea(), 'mine');
		assert.include(view.target.textContent, 'overwrite with your draft');
	});

	test('the conflict notice keeps the disk version, keeping the draft in the history', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		await write_externally(PATH_A, 'theirs');
		flushSync();

		click_button(view.target, 'keep the disk version');

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

	test('state a mounted view created stays live after it unmounts', async () => {
		const a = await disk.load(PATH_A, 'v1');
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
	test('Ctrl+S while conflicted focuses the notice, and resolving refocuses the editor', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		await write_externally(PATH_A, 'theirs');
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

		click_button(view.target, 'keep the disk version');
		assert.strictEqual(document.activeElement, view.textarea());
	});

	test('Ctrl+S during the read of a change focuses the notice once the read shows a conflict', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		const release = disk.hold_reads();
		disk.write(PATH_A, 'theirs');
		flushSync();
		assert.isNull(view.alert(), 'not known yet');

		view
			.textarea()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
			);
		await flush_reads();
		flushSync();
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isTrue(editor_state.save_pending);

		release();
		await flush_reads();
		await flush_reads();
		flushSync();
		const alert = view.alert();
		assert.ok(alert);
		assert.strictEqual(document.activeElement, alert);
		assert.strictEqual(a.content, 'theirs');
	});

	test('typing on while the read waits keeps the focus in the editor', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		type_into(view.textarea(), 'mine');
		view.textarea().focus();
		const release = disk.hold_reads();
		disk.write(PATH_A, 'theirs');
		view
			.textarea()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
			);
		await flush_reads();
		type_into(view.textarea(), 'mine, more');

		release();
		await flush_reads();
		await flush_reads();
		flushSync();
		assert.ok(view.alert(), 'the conflict shows');
		assert.strictEqual(
			document.activeElement,
			view.textarea(),
			'the keystrokes stay in the editor'
		);
	});
});

describe('a file whose content loads on view', () => {
	/** A file seeded from metadata alone, with its read held by the test. */
	const setup = () => {
		const read = create_deferred<unknown>();
		const read_paths: Array<string> = [];
		(app as unknown as { api: unknown }).api = {
			diskfile_read: ({ path }: { path: string }) => {
				read_paths.push(path);
				return read.promise;
			}
		};
		app.diskfiles.add_initial([
			{ id: PATH_A, source_dir: SOURCE_DIR, size: 4, ctime: 1, mtime: 1 }
		]);
		return { diskfile: app.diskfiles.get_by_path(PATH_A)!, read, read_paths };
	};
	const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	for (const [name, component] of [
		['DiskfileEditorView', DiskfileEditorView],
		['DiskfileMarkdownView', DiskfileMarkdownView]
	] as const) {
		test(`${name} reads it, read-only with a loading notice until it lands`, async () => {
			const { diskfile, read, read_paths } = setup();
			const view = render(component, { diskfile });
			assert.strictEqual(diskfile.content_status, 'loading');
			assert.include(to_visible_text(view.target), DISKFILE_CONTENT_LOADING_MESSAGE);
			assert.notInclude(to_visible_text(view.target), 'content not loaded');
			assert.notInclude(
				to_visible_text(view.target),
				"can't be edited",
				'not the notice of a file that can not load'
			);
			assert.isTrue(view.textarea().readOnly);
			await flush();
			assert.deepEqual(read_paths, [PATH_A]);

			read.resolve({
				ok: true,
				value: {
					contents: 'text',
					unloaded_reason: null,
					hash: content_hash('text'),
					size: 4,
					ctime: 1,
					mtime: 1
				}
			});
			await flush();
			flushSync();
			assert.notInclude(to_visible_text(view.target), DISKFILE_CONTENT_LOADING_MESSAGE);
			assert.strictEqual(view.textarea().value, 'text');
			assert.isFalse(view.textarea().readOnly);
			const editor_state = app.diskfiles.get_editor_state(diskfile);
			assert.isFalse(editor_state.dirty, 'the first arrival is no change to save');
			assert.isNull(view.alert(), 'nor a conflict');
		});
	}

	test('a file that can not load says why, not that it is loading', async () => {
		const { diskfile, read } = setup();
		const view = render(DiskfileEditorView, { diskfile });
		read.resolve({
			ok: true,
			value: {
				contents: null,
				unloaded_reason: 'too_large',
				hash: null,
				size: 5_000_000,
				ctime: 1,
				mtime: 1
			}
		});
		await flush();
		flushSync();
		const text = to_visible_text(view.target);
		assert.include(text, 'over 4 MiB');
		assert.notInclude(text, DISKFILE_CONTENT_LOADING_MESSAGE);
		assert.isTrue(view.textarea().readOnly);
	});
});

describe('the conflict notice showing the disk version', () => {
	const find_button = (target: HTMLElement, text: string): HTMLButtonElement => {
		const button = Array.from(target.querySelectorAll('button')).find(
			(b) => to_visible_text(b) === text
		);
		assert.ok(button, `a "${text}" button`);
		return button;
	};

	/** A view of a draft `mine` under a disk change to `theirs`. */
	const setup = async (component: Component<any> = DiskfileEditorView) => {
		const a = await disk.load(PATH_A, 'v1');
		const part = new DiskfilePart({ app, json: { path: PATH_A } });
		const view = render(
			component,
			component === PartEditorForDiskfile ? { diskfile_part: part } : { diskfile: a }
		);
		type_into(view.textarea(), 'mine');
		await write_externally(PATH_A, 'theirs');
		flushSync();
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.isTrue(editor_state.has_conflict);
		return { a, part, view, editor_state };
	};

	test('toggles the editor between the draft and the disk version, read-only', async () => {
		const { view, editor_state } = await setup();
		const toggle = find_button(view.target, 'show disk version');
		assert.isFalse(view.textarea().readOnly);

		toggle.click();
		flushSync();

		assert.strictEqual(view.textarea().value, 'theirs');
		assert.isTrue(view.textarea().readOnly);
		const toggle_back = find_button(view.target, 'show your draft');
		assert.include(view.alert()?.textContent, 'showing the file on disk, read-only');
		assert.include(view.alert()?.textContent, 'your draft is kept as it is');
		assert.strictEqual(editor_state.current_content, 'mine');

		toggle_back.click();
		flushSync();

		assert.strictEqual(view.textarea().value, 'mine');
		assert.isFalse(view.textarea().readOnly);
		assert.ok(find_button(view.target, 'show disk version'));
		assert.include(view.alert()?.textContent, 'changed on disk since you edited it');
	});

	test('the toggle is named by its shown label alone, sized by both, and looks like its siblings', async () => {
		const { view } = await setup();
		const toggle = find_button(view.target, 'show disk version');
		// the sizing copies are `visibility: hidden`, which leaves them out of the name
		assert.include(toggle.textContent, 'show your draft');
		assert.notInclude(to_visible_text(toggle), 'show your draft');
		assert.isTrue(toggle.classList.contains('sized_sm'));
		assert.isFalse(toggle.classList.contains('icon-button'));
		assert.isFalse(toggle.classList.contains('plain'));

		toggle.click();
		flushSync();
		assert.strictEqual(to_visible_text(toggle), 'show your draft', 'the same button, relabeled');
	});

	test('typing into the disk version changes nothing', async () => {
		const { view, editor_state } = await setup();
		click_button(view.target, 'show disk version');

		// a read-only textarea fires no input, but a stray one must not land either
		type_into(view.textarea(), 'typed');

		assert.strictEqual(editor_state.current_content, 'mine');
		assert.strictEqual(editor_state.shown_content, 'theirs');
		assert.isTrue(editor_state.has_conflict);
	});

	test('Ctrl+S while showing it stays blocked, and focuses the notice', async () => {
		const { a, view } = await setup();
		click_button(view.target, 'show disk version');

		view
			.textarea()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
			);
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(document.activeElement, view.alert());
		assert.strictEqual(a.content, 'theirs');
	});

	test('the actions leave the disk version alone: paste and clear are hidden', async () => {
		const { view } = await setup();
		const titled = (title: string): number =>
			view.target.querySelectorAll(`button[title="${title}"]`).length;
		assert.strictEqual(titled('paste from clipboard'), 1);
		assert.strictEqual(titled('clear'), 1);

		click_button(view.target, 'show disk version');

		assert.strictEqual(titled('paste from clipboard'), 0);
		assert.strictEqual(titled('clear'), 0);
		assert.strictEqual(titled('copy to clipboard'), 1);
	});

	test('copy copies the text shown, the disk version included', async () => {
		const { view } = await setup();
		const written: Array<string> = [];
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: (text: string) => {
					written.push(text);
					return Promise.resolve();
				}
			}
		});
		const copy = () => view.target.querySelector<HTMLButtonElement>('[title="copy to clipboard"]');
		try {
			copy()?.click();
			click_button(view.target, 'show disk version');
			copy()?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			Reflect.deleteProperty(navigator, 'clipboard');
		}

		assert.deepEqual(written, ['mine', 'theirs']);
	});

	test('overwrite with your draft writes the draft and shows it', async () => {
		const { a, view } = await setup();
		click_button(view.target, 'show disk version');

		click_button(view.target, 'overwrite with your draft');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(a.content, 'mine');
		assert.isNull(view.alert());
		assert.strictEqual(view.textarea().value, 'mine');
		assert.isFalse(view.textarea().readOnly);
	});

	/**
	 * Sets up a conflict whose overwrite the backend will refuse — a newer
	 * version on disk before its `filer_change` — holding the refusal until
	 * the returned release.
	 */
	const setup_refused_overwrite = async () => {
		const setup_result = await setup();
		disk.files.set(PATH_A, 'newer');
		const refusal = create_deferred<void>();
		app.diskfiles.update = async () => {
			await refusal.promise;
			return {
				ok: false,
				error: jsonrpc_error_messages.conflict(
					'failed to write file: File changed on disk since it was read',
					{ reason: 'disk_changed' }
				)
			};
		};
		const settle = async (): Promise<void> => {
			refusal.resolve();
			await flush_reads();
			await flush_reads();
			flushSync();
		};
		return { ...setup_result, settle };
	};

	test('a refused overwrite keeps the notice, takes the focus back to it, and says why', async () => {
		const { a, view, editor_state, settle } = await setup_refused_overwrite();
		const button = find_button(view.target, 'overwrite with your draft');
		button.focus();
		click_button(view.target, 'overwrite with your draft');
		assert.isTrue(button.disabled, 'disabled while the save waits');
		// the focus fixup a browser applies to a focused element that's disabled,
		// which jsdom doesn't (nor blurs a disabled one) — it does reset the focus
		// to `<body>` when the focused element is removed
		const stand_in = document.createElement('input');
		document.body.append(stand_in);
		stand_in.focus();
		stand_in.remove();
		assert.strictEqual(document.activeElement, document.body);

		await settle();

		assert.strictEqual(a.content, 'newer', 'read again');
		const notice = view.alert();
		assert.ok(notice, 'the conflict stands');
		assert.strictEqual(document.activeElement, notice, 'the focus is back on the notice');
		assert.strictEqual(view.textarea().value, 'mine');
		assert.strictEqual(editor_state.save_error, SAVE_ERROR_CHANGED_AGAIN);
	});

	test('a refused overwrite leaves the focus where the user moved it meanwhile', async () => {
		const { view, settle } = await setup_refused_overwrite();
		find_button(view.target, 'overwrite with your draft').focus();
		click_button(view.target, 'overwrite with your draft');
		view.textarea().focus();

		await settle();

		assert.ok(view.alert(), 'the conflict stands');
		assert.strictEqual(document.activeElement, view.textarea());
	});

	test('the toggle waits while an overwrite is in flight', async () => {
		const { view, editor_state } = await setup();
		const deferred = create_deferred<HeldUpdateResult>();
		app.diskfiles.update = (_path, content) =>
			deferred.promise.then((result) => answer_update(content, result));

		click_button(view.target, 'overwrite with your draft');
		assert.isTrue(editor_state.saving);
		assert.isTrue(find_button(view.target, 'show disk version').disabled);

		deferred.resolve({ ok: false, error: { code: -32603, message: 'disk full' } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.isFalse(find_button(view.target, 'show disk version').disabled);
	});

	test('keep the disk version discards the draft into the history and ends the preview', async () => {
		const { a, view, editor_state } = await setup();
		click_button(view.target, 'show disk version');

		const keep = find_button(view.target, 'keep the disk version');
		assert.include(keep.title, 'setting your edit aside in the history');
		keep.click();
		flushSync();

		assert.isNull(view.alert());
		assert.strictEqual(view.textarea().value, 'theirs');
		assert.isFalse(view.textarea().readOnly);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(a.content, 'theirs', 'nothing written');
	});

	test('a newer disk change shows as it lands', async () => {
		const { view } = await setup();
		click_button(view.target, 'show disk version');

		await write_externally(PATH_A, 'theirs again');
		flushSync();

		assert.strictEqual(view.textarea().value, 'theirs again');
		assert.isTrue(view.textarea().readOnly);
	});

	test('a file part editor shows it too, while the part sends the draft', async () => {
		const { view, part } = await setup(PartEditorForDiskfile);

		click_button(view.target, 'show disk version');

		assert.strictEqual(view.textarea().value, 'theirs');
		assert.isTrue(view.textarea().readOnly);
		assert.strictEqual(part.content, 'mine');

		click_button(view.target, 'show your draft');
		assert.strictEqual(view.textarea().value, 'mine');
		assert.isFalse(view.textarea().readOnly);
	});

	test('a picked older version is named as yours', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const view = render(DiskfileEditorView, { diskfile: a });
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);
		await write_externally(PATH_A, 'theirs');
		flushSync();

		click_button(view.target, 'show disk version');

		assert.include(view.alert()?.textContent, 'your version is kept as it is');
		assert.ok(find_button(view.target, 'overwrite with your version'));
		click_button(view.target, 'show your version');
		assert.strictEqual(view.textarea().value, 'older');
	});

	test('a file deleted on disk offers no disk version', async () => {
		const { view } = await setup();
		click_button(view.target, 'show disk version');

		app.diskfiles.remove_by_path(PATH_A);
		flushSync();

		assert.strictEqual(view.textarea().value, 'mine');
		assert.isFalse(view.textarea().readOnly);
		const labels = Array.from(view.target.querySelectorAll('button')).map(to_visible_text);
		assert.notInclude(labels, 'show disk version');
		assert.notInclude(labels, 'show your draft');
	});
});

describe('PartEditorForDiskfile', () => {
	const setup = async () => {
		const a = await disk.load(PATH_A, 'disk v1');
		const part = new DiskfilePart({ app, json: { path: PATH_A } });
		return { a, part };
	};

	test('follows external changes, so a save never reverts them', async () => {
		const { a, part } = await setup();
		const view = render(PartEditorForDiskfile, { diskfile_part: part });
		assert.strictEqual(view.textarea().value, 'disk v1');

		await write_externally(PATH_A, 'disk v2');
		flushSync();
		assert.strictEqual(view.textarea().value, 'disk v2');
		assert.strictEqual(part.content, 'disk v2');

		type_into(view.textarea(), 'disk v2, edited');
		assert.strictEqual(part.content, 'disk v2, edited');
		assert.isTrue(await app.diskfiles.get_editor_state(a).save_changes());
		assert.strictEqual(a.content, 'disk v2, edited');
	});

	test('the part keeps tracking the file after the editor unmounts', async () => {
		const { part } = await setup();
		const view = render(PartEditorForDiskfile, { diskfile_part: part });
		assert.strictEqual(part.content, 'disk v1');
		view.destroy();

		await write_externally(PATH_A, 'disk v2');

		assert.strictEqual(part.content, 'disk v2');
	});

	test('shares the draft with the files editor', async () => {
		const { a, part } = await setup();
		const files_view = render(DiskfileEditorView, { diskfile: a });
		type_into(files_view.textarea(), 'typed in /files');
		files_view.destroy();

		const part_view = render(PartEditorForDiskfile, { diskfile_part: part });

		assert.strictEqual(part_view.textarea().value, 'typed in /files');
		assert.strictEqual(part.content, 'typed in /files');
	});
});

describe('PartEditorForDiskfile deleted on disk', () => {
	test('shows a draft-kept deleted file, and discarding lets it go', async () => {
		await write_externally(PATH_B, 'b'); // takes the auto-selected tab, so a has none
		const a = await disk.load(PATH_A, 'v1');
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

/**
 * The `ellipsis` element truncates a long path, so the unsaved and deleted
 * markers sit after it, outside it, where truncation can't clip them.
 */
const assert_markers_outside_truncation = (target: HTMLElement, path: string): void => {
	const truncating = Array.from(target.querySelectorAll('.ellipsis'));
	assert.strictEqual(truncating.length, 1, 'one truncating element');
	assert.strictEqual(truncating[0]!.textContent.trim(), path, 'holding the path alone');
	for (const marker of ['●', '(deleted)']) {
		const el = Array.from(target.querySelectorAll('[aria-hidden="true"]')).find(
			(e) => e.textContent.trim() === marker
		);
		assert.ok(el, `shows ${marker}`);
		assert.isNull(el.closest('.ellipsis'), `${marker} is outside the truncation`);
	}
};

describe('DiskfileListitem', () => {
	test('marks a file with unsaved changes, without creating editing state', async () => {
		const a = await disk.load(PATH_A, 'v1');
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

	test('Space and a click preview, Enter and a double click open, like the tree', async () => {
		const a = await disk.load(PATH_A, 'v1');
		const calls: Array<boolean> = [];
		const view = render(DiskfileListitem, {
			diskfile: a,
			onselect: (_diskfile: Diskfile, open_not_preview: boolean) => calls.push(open_not_preview)
		});
		const item = view.target.querySelector('[role="button"]');
		assert.ok(item);
		const key = (k: string): void => {
			item.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
		};
		key(' ');
		key('Enter');
		key('a'); // ignored
		item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
		assert.deepEqual(calls, [false, true, false, true]);
	});

	test('only the path truncates, so its markers show past a long path', async () => {
		app.zzz_dir = '/w/'; // so the path shows relative, as `a.txt`
		const a = await disk.load(PATH_A, 'v1');
		app.diskfiles.get_editor_state(a).current_content = 'draft';
		app.diskfiles.remove_by_path(PATH_A); // kept for its draft, deleted on disk
		flushSync();
		assert.isTrue(a.deleted_on_disk);
		const view = render(DiskfileListitem, { diskfile: a });
		assert_markers_outside_truncation(view.target, 'a.txt');
	});
});

describe('PartSummary', () => {
	test("only the name and preview truncate, so a file part's draft label always shows", async () => {
		const a = await disk.load(PATH_A, 'v1');
		const part = new DiskfilePart({ app, json: { path: PATH_A } });
		app.diskfiles.get_editor_state(a).current_content = 'draft';
		const view = render(PartSummary, { part });
		const label = Array.from(view.target.querySelectorAll('small')).find(
			(el) => el.textContent.trim() === '(unsaved draft)'
		);
		assert.ok(label, 'shows the label');
		assert.isNull(label.closest('.ellipsis'), 'outside the truncation');
		const truncating = Array.from(view.target.querySelectorAll('.ellipsis')).map((el) =>
			el.textContent.trim()
		);
		assert.deepEqual(truncating, [part.name, part.content_preview]);
	});
});

describe('DiskfileTabListitem', () => {
	test('only the path truncates, so its markers show past a long path', async () => {
		app.zzz_dir = '/w/'; // so the path shows relative, as `a.txt`
		const a = await disk.load(PATH_A, 'v1');
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		app.diskfiles.get_editor_state(a).current_content = 'draft';
		app.diskfiles.remove_by_path(PATH_A); // kept for its draft, deleted on disk
		flushSync();
		assert.isTrue(a.deleted_on_disk);
		const view = render(DiskfileTabListitem, {
			tab,
			onselect: () => {},
			onclose: () => {},
			onopen: () => {}
		});
		assert_markers_outside_truncation(view.target, 'a.txt');
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

	const setup_pending = async () => {
		const a = await disk.load(PATH_A, 'v1');
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
		const { a, tab, view } = await setup_pending();
		click_button(view.target, 'save');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.strictEqual(a.content, 'draft');
		assert.isFalse(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
		assert.isNull(view.target.querySelector('dialog'));
	});

	test("don't save discards the draft into the history and closes the tab", async () => {
		const { a, tab, editor_state, view } = await setup_pending();
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
		const a = await disk.load(PATH_A, 'v1');
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		const editor_state = app.diskfiles.get_editor_state(a);
		await write_externally(PATH_A, 'v2');
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
		const { tab, view } = await setup_pending();
		const deferred = create_deferred<HeldUpdateResult>();
		app.diskfiles.update = (_path, content) =>
			deferred.promise.then((result) => answer_update(content, result));

		click_button(view.target, 'save');
		click_button(view.target, 'cancel');
		deferred.resolve({ ok: true, value: null });
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.ok(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
	});

	test('a failure shows for its own close only', async () => {
		const { a, tab, editor_state, view } = await setup_pending();
		app.diskfiles.update = () =>
			Promise.resolve({ ok: false, error: { code: -32603, message: 'disk full' } });

		click_button(view.target, 'save');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.include(view.target.textContent, 'disk full');

		click_button(view.target, 'cancel');
		const b = await disk.load(PATH_B, 'b');
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

	test("after don't save, focus moves to the next tab's editor", async () => {
		const b = await disk.load(PATH_B, 'b');
		const a = await disk.load(PATH_A, 'v1');
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

	test("when it lapses, focus moves to the kept tab's editor", async () => {
		const { a, editor_state, view } = await setup_pending();
		const a_view = render(DiskfileEditorView, { diskfile: a });

		editor_state.discard_draft();
		flushSync();

		assert.isNull(view.target.querySelector('dialog'));
		assert.strictEqual(document.activeElement, a_view.textarea());
	});

	test('cancel leaves focus to the native dialog', async () => {
		const { view } = await setup_pending();
		click_button(view.target, 'cancel');
		assert.isNull(app.ui.pending_element_to_focus_key);
	});

	test('closes itself when the draft is discarded elsewhere', async () => {
		const { editor_state, view } = await setup_pending();
		editor_state.discard_draft();
		flushSync();
		assert.isNull(view.target.querySelector('dialog'));
	});

	test('cancel keeps the tab and the draft', async () => {
		const { tab, editor_state, view } = await setup_pending();
		click_button(view.target, 'cancel');

		assert.ok(app.diskfiles.editor.tabs.items.by_id.has(tab.id));
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.isNull(view.target.querySelector('dialog'));
	});
});
