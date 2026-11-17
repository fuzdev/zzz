// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';

import { DiskfileDirectoryPath, DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	flush_reads,
	install_fake_disk,
	update_ok,
	type FakeDisk
} from './diskfile_test_helpers.ts';

/**
 * A file's editing state is app-level (`Diskfiles.get_editor_state`): it
 * records disk changes with no editor mounted and keeps the draft across tab
 * switches, remounts, and a long run of disk changes.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');
const PATH_A = parse_or_throw(DiskfilePath, '/w/a.txt');
const PATH_B = parse_or_throw(DiskfilePath, '/w/b.txt');

let app: Frontend;

let disk: FakeDisk;

/**
 * Writes the file on disk as the backend reports it (metadata only), with
 * the read of the new content it sets off for a file held eagerly landed.
 */
const upsert = async (path: DiskfilePath, contents: string): Promise<Diskfile> => {
	const diskfile = await disk.load(path, contents);
	await flush_reads();
	return diskfile;
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
});

describe('disk changes without an editor', () => {
	test('are recorded, so the file reopens on the disk content with nothing to save', async () => {
		const a = await upsert(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(a);

		await upsert(PATH_A, 'v2 external');

		assert.strictEqual(editor_state.current_content, 'v2 external');
		assert.isFalse(editor_state.has_changes);
		assert.isFalse(editor_state.can_save);
		assert.strictEqual(editor_state.history.current_entry?.content, 'v2 external');
	});

	test('files never opened get no editing state', async () => {
		const a = await upsert(PATH_A, 'v1');
		await upsert(PATH_A, 'v2');
		assert.isUndefined(app.diskfiles.find_editor_state(a.path));
	});

	test('an unchanged resync records nothing', async () => {
		const a = await upsert(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(a);
		await upsert(PATH_A, 'v1');
		assert.strictEqual(editor_state.history.entries.length, 1);
	});
});

describe('the draft', () => {
	test('survives viewing another file, with a disk change meanwhile', async () => {
		const a = await upsert(PATH_A, 'v1');
		const b = await upsert(PATH_B, 'b');
		const a_state = app.diskfiles.get_editor_state(a);
		a_state.current_content = 'my draft';

		app.diskfiles.get_editor_state(b).current_content = 'b draft';
		await upsert(PATH_A, 'v2 external');

		assert.strictEqual(a_state.current_content, 'my draft');
		assert.isTrue(a_state.content_was_modified_by_user);
		assert.isTrue(a_state.has_changes);
		assert.isTrue(a_state.has_conflict);
		assert.strictEqual(a_state.unsaved_history_entries.length, 1);
	});

	test('is what a reopen shows after the last tab closes', async () => {
		const a = await upsert(PATH_A, 'v1');
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'draft';
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);

		const tab = app.diskfiles.editor.tabs.by_path.get(a.path);
		assert.ok(tab);
		app.diskfiles.editor.close_tab(tab.id);
		app.diskfiles.select(a.path, true);

		assert.strictEqual(editor_state.current_content, 'draft');
		assert.isTrue(editor_state.content_was_modified_by_user);
	});

	test('a clean file reopens on the disk content, not a picked older entry', async () => {
		const a = await upsert(PATH_A, 'v1');
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);

		const tab = app.diskfiles.editor.tabs.by_path.get(a.path);
		assert.ok(tab);
		app.diskfiles.editor.close_tab(tab.id);

		assert.strictEqual(editor_state.current_content, 'v1');
		assert.isFalse(editor_state.can_save);
	});

	test('outlasts the history cap, keeping the file dirty for the delete rule', async () => {
		const a = await upsert(PATH_A, 'v0');
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'my unsaved edit';

		for (let i = 1; i <= 150; i++) await upsert(PATH_A, `v${i}`);

		const { history } = editor_state;
		assert.strictEqual(history.entries.length, history.max_entries);
		assert.isTrue(history.has_unsaved_edits);
		assert.strictEqual(editor_state.current_content, 'my unsaved edit');
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.strictEqual(history.entries[0]?.content, 'v150');

		app.diskfiles.remove_by_path(PATH_A);
		assert.isTrue(a.deleted_on_disk, 'the dirty tab is kept');
	});
});

describe('lifetime', () => {
	test('is disposed with the diskfile', async () => {
		const a = await upsert(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(a);
		const { all } = app.cell_registry;
		assert.ok(all.has(editor_state.history.id));

		app.diskfiles.remove_by_path(PATH_A);

		assert.isUndefined(app.diskfiles.find_editor_state(a.path));
		assert.ok(!all.has(editor_state.history.id));
	});

	test('a diskfile no longer in the collection gets an unmanaged, unregistered state', async () => {
		const a = await upsert(PATH_A, 'v1');
		app.diskfiles.remove_by_path(PATH_A);

		const editor_state = app.diskfiles.get_editor_state(a);

		assert.strictEqual(editor_state.diskfile, a);
		assert.isUndefined(app.diskfiles.find_editor_state(a.path));
		assert.ok(!app.cell_registry.all.has(editor_state.history.id));
	});
});

describe('closing a tab (request_close_tab)', () => {
	const setup_tab = async () => {
		const a = await disk.load(PATH_A, 'v1');
		app.diskfiles.select(a.path, true);
		const tab = app.diskfiles.editor.tabs.by_path.get(a.path);
		assert.ok(tab);
		return { a, tab, editor_state: app.diskfiles.get_editor_state(a) };
	};

	test('closes a clean file now', async () => {
		const { tab } = await setup_tab();
		assert.isTrue(app.diskfiles.editor.request_close_tab(tab.id));
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0);
		assert.isNull(app.diskfiles.editor.pending_close_tab_id);
	});

	test('waits on the user for the last tab of a file with a draft', async () => {
		const { tab, editor_state } = await setup_tab();
		editor_state.current_content = 'draft';
		const { editor } = app.diskfiles;

		assert.isFalse(editor.request_close_tab(tab.id));
		assert.strictEqual(editor.pending_close_tab, tab);
		assert.ok(editor.tabs.items.by_id.has(tab.id));

		editor.cancel_close_tab();
		assert.isNull(editor.pending_close_tab_id);
		assert.ok(editor.tabs.items.by_id.has(tab.id));

		// closing it (after a choice) clears the pending close
		editor.request_close_tab(tab.id);
		editor.close_tab(tab.id);
		assert.isNull(editor.pending_close_tab_id);
		assert.strictEqual(editor_state.current_content, 'draft', 'the draft outlives the tab');
	});

	test('closing the selected file moves selection to the next tab', async () => {
		const { a, tab } = await setup_tab();
		const b = await upsert(PATH_B, 'b');
		app.diskfiles.select(b.path, true);
		app.diskfiles.select(a.path, true);
		assert.strictEqual(app.diskfiles.selected_path, a.path);

		app.diskfiles.editor.request_close_tab(tab.id);

		assert.strictEqual(app.diskfiles.selected_path, b.path);
	});
});

describe('save_draft', () => {
	test('saves the draft even while the editor shows an older entry', async () => {
		const a = await upsert(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(a);
		await upsert(PATH_A, 'v2');
		editor_state.current_content = 'DRAFT';
		const v1 = editor_state.history.entries.find((entry) => entry.content === 'v1');
		assert.ok(v1);
		editor_state.set_content_from_history(v1.id);
		const writes: Array<string> = [];
		app.diskfiles.update = (_path, content) => {
			writes.push(content);
			return Promise.resolve(update_ok(content));
		};

		assert.isTrue(await editor_state.save_draft());

		assert.deepEqual(writes, ['DRAFT']);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.strictEqual(editor_state.current_content, 'DRAFT');
	});

	test('overwrites with the draft on a conflict, not the entry shown', async () => {
		const a = await upsert(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'DRAFT';
		await upsert(PATH_A, 'theirs');
		const v1 = editor_state.history.entries.find((entry) => entry.content === 'v1');
		assert.ok(v1);
		editor_state.set_content_from_history(v1.id);
		assert.isTrue(editor_state.has_conflict);
		const writes: Array<string> = [];
		app.diskfiles.update = (_path, content) => {
			writes.push(content);
			return Promise.resolve(update_ok(content));
		};

		assert.isTrue(await editor_state.save_draft({ overwrite: true }));

		assert.deepEqual(writes, ['DRAFT']);
	});
});

describe('saving a file deleted on disk', () => {
	test('recreates it: closing its tab before the add broadcast keeps it', async () => {
		app.projects.add({ root: parse_or_throw(DiskfileDirectoryPath, '/w/') });
		const a = await upsert(PATH_A, 'v1');
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'DRAFT';
		disk.files.delete(PATH_A);
		app.diskfiles.remove_by_path(PATH_A);
		assert.isTrue(a.deleted_on_disk);
		assert.isTrue(await editor_state.save_changes());
		assert.deepEqual(disk.creates, [{ path: PATH_A, content: 'DRAFT' }]);
		assert.isFalse(a.deleted_on_disk, 'cleared by the save itself');
		assert.isFalse(a.uncovered, 'its project indexes it, so its add is on the way');

		const tab = app.diskfiles.editor.tabs.by_path.get(a.path);
		assert.ok(tab);
		app.diskfiles.editor.close_tab(tab.id);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), a);

		await upsert(PATH_A, 'DRAFT');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), a, 'same id');
		assert.strictEqual(app.diskfiles.find_editor_state(a.path), editor_state, 'history kept');
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0, 'no stray tab');
	});
});

describe('a pending tab close', () => {
	test('lapses when its draft goes away elsewhere, and a later draft does not revive it', async () => {
		const a = await upsert(PATH_A, 'v1');
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'DRAFT';
		const { editor } = app.diskfiles;
		const tab = editor.tabs.by_path.get(a.path);
		assert.ok(tab);
		editor.request_close_tab(tab.id);
		assert.strictEqual(editor.pending_close_tab, tab);

		// e.g. discarded from a file part's editor
		editor_state.discard_draft();
		assert.isUndefined(editor.pending_close_tab);

		editor_state.current_content = 'another draft';
		assert.isUndefined(editor.pending_close_tab);
		assert.ok(editor.tabs.items.by_id.has(tab.id));
	});
});
