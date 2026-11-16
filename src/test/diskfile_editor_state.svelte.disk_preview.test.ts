// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';

import type { DiskfileEditorState } from '#lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePart } from '#lib/part.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * During a conflict the views can show the disk content (`showing_disk`,
 * `shown_content`), read-only — a look that never touches the edit, the
 * history, or what's saved and sent, and that ends with the conflict.
 */

const PATH = parse_or_throw(DiskfilePath, '/w/a.txt');
const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let diskfile: Diskfile;
let editor_state: DiskfileEditorState;

let disk: FakeDisk;

/**
 * A write to the file on disk: its `filer_change` (metadata only), and the
 * read of the new content it sets off, landed.
 */
const broadcast = async (contents: string): Promise<void> => {
	disk.write(PATH, contents);
	await flush_reads();
};

/** Makes `app.diskfiles.update` record its writes and succeed. */
const capture_writes = (): Array<string> => {
	const writes: Array<string> = [];
	app.diskfiles.update = (_path, content) => {
		writes.push(content);
		return Promise.resolve({ ok: true, value: null });
	};
	return writes;
};

/** A draft `mine` under a disk change to `theirs`, shown as the disk. */
const preview_conflict = async (): Promise<void> => {
	editor_state.current_content = 'mine';
	await broadcast('theirs');
	assert.isTrue(editor_state.has_conflict);
	editor_state.set_showing_disk(true);
	assert.isTrue(editor_state.showing_disk);
};

/** The history's entries, as plain values. */
const snapshot_history = () =>
	editor_state.history.entries.map(({ id, content, is_unsaved_edit, is_discarded_edit }) => ({
		id,
		content,
		is_unsaved_edit,
		is_discarded_edit
	}));

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
	diskfile = app.diskfiles.add({ path: PATH, source_dir: SOURCE_DIR, content: 'v1' });
	editor_state = app.diskfiles.get_editor_state(diskfile);
});

describe('showing the disk version', () => {
	test('shows the disk content, read-only, leaving the edit as it is', async () => {
		editor_state.current_content = 'mine';
		await broadcast('theirs');
		const history_before = snapshot_history();
		const selected_before = editor_state.selected_history_entry_id;

		editor_state.set_showing_disk(true);

		assert.isTrue(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'theirs');
		assert.isFalse(editor_state.can_edit);
		assert.strictEqual(editor_state.current_content, 'mine');
		assert.isTrue(editor_state.has_changes);
		assert.isTrue(editor_state.has_conflict);
		assert.isTrue(editor_state.disk_conflict);
		assert.isTrue(editor_state.dirty);
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.strictEqual(editor_state.selected_history_entry_id, selected_before);
		assert.deepEqual(snapshot_history(), history_before);
	});

	test('toggling back shows the draft again, editable', async () => {
		await preview_conflict();

		editor_state.set_showing_disk(false);

		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
		assert.isTrue(editor_state.can_edit);
		assert.isTrue(editor_state.has_conflict);
	});

	test('edits are ignored while showing it', async () => {
		await preview_conflict();
		const history_before = snapshot_history();

		editor_state.current_content = 'typed into the disk version';

		assert.strictEqual(editor_state.current_content, 'mine');
		assert.strictEqual(editor_state.shown_content, 'theirs');
		assert.deepEqual(snapshot_history(), history_before);
		assert.isTrue(editor_state.has_conflict);
	});

	test('does nothing without a conflict', () => {
		editor_state.set_showing_disk(true);
		assert.isFalse(editor_state.showing_disk);
		assert.isTrue(editor_state.can_edit);

		// a clean draft isn't a conflict either
		editor_state.current_content = 'mine';
		editor_state.set_showing_disk(true);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
	});

	test('follows a newer disk change', async () => {
		await preview_conflict();

		await broadcast('theirs again');

		assert.isTrue(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'theirs again');
		assert.strictEqual(editor_state.current_content, 'mine');
	});

	test('a plain save while showing it stays blocked', async () => {
		await preview_conflict();
		const writes = capture_writes();

		assert.isFalse(await editor_state.save_changes());

		assert.deepEqual(writes, []);
		assert.isTrue(editor_state.showing_disk);
	});

	test('a file part sends the draft while the disk is shown', async () => {
		const part = new DiskfilePart({ app, json: { path: PATH } });
		await preview_conflict();

		assert.strictEqual(part.content, 'mine');
		assert.strictEqual(part.draft_status, 'conflict');
	});

	test('a picked older entry is shown back the same way', async () => {
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);
		await broadcast('theirs');

		editor_state.set_showing_disk(true);
		assert.strictEqual(editor_state.shown_content, 'theirs');
		editor_state.set_showing_disk(false);
		assert.strictEqual(editor_state.shown_content, 'older');
	});
});

describe('showing the disk version ends with the conflict', () => {
	test('overwriting with the draft saves the draft, never the disk content', async () => {
		await preview_conflict();
		const writes = capture_writes();

		const saving = editor_state.save_draft({ overwrite: true });
		// the content being written shows at once
		assert.isFalse(editor_state.showing_disk);
		assert.isTrue(await saving);

		assert.deepEqual(writes, ['mine']);
		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
	});

	test('keeping the disk version', async () => {
		await preview_conflict();

		editor_state.discard_draft();

		assert.isFalse(editor_state.showing_disk);
		assert.isTrue(editor_state.can_edit);
		assert.strictEqual(editor_state.shown_content, 'theirs');
	});

	test('the disk landing on the draft', async () => {
		await preview_conflict();

		await broadcast('mine');

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.isTrue(editor_state.can_edit);
	});

	test('a file deleted on disk shows its draft, and offers no disk version', async () => {
		const part = new DiskfilePart({ app, json: { path: PATH } });
		await preview_conflict();

		app.diskfiles.remove_by_path(PATH);

		assert.isTrue(diskfile.deleted_on_disk);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
		assert.isTrue(editor_state.can_edit);
		editor_state.set_showing_disk(true);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(part.content, 'mine');
	});

	test('a file deleted on disk and back shows its draft, not the disk', async () => {
		await preview_conflict();
		app.diskfiles.remove_by_path(PATH);
		// kept, not forgotten - so the delete's clear, not `dispose`, ended the preview
		assert.isTrue(diskfile.deleted_on_disk);
		assert.isFalse(editor_state.showing_disk);

		await broadcast('theirs again');

		assert.isFalse(diskfile.deleted_on_disk);
		assert.isTrue(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
	});

	test('asking to show a file deleted on disk does nothing, even once it is back', async () => {
		editor_state.current_content = 'mine';
		await broadcast('theirs');
		app.diskfiles.remove_by_path(PATH);
		assert.isTrue(diskfile.deleted_on_disk);
		assert.isTrue(editor_state.has_conflict);

		editor_state.set_showing_disk(true);
		await broadcast('theirs again');

		assert.isTrue(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
	});

	test('the disk landing on a picked entry, with a draft elsewhere', async () => {
		editor_state.current_content = 'mine';
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);
		await broadcast('theirs');
		editor_state.set_showing_disk(true);
		assert.isTrue(editor_state.showing_disk);

		await broadcast('older');

		// the draft still predates the disk, but nothing shown differs from it
		assert.isTrue(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.isTrue(editor_state.can_edit);
	});

	test('picking a history entry', async () => {
		await preview_conflict();
		const disk_entry = editor_state.history.entries.find((entry) => entry.content === 'theirs');
		assert.ok(disk_entry);
		const draft_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft_id);

		editor_state.set_content_from_history(disk_entry.id);
		assert.isFalse(editor_state.showing_disk);

		// back on the draft the conflict is there again, showing the draft
		editor_state.set_content_from_history(draft_id);
		assert.isTrue(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
	});

	test('a later conflict starts on the edit, not the disk', async () => {
		await preview_conflict();
		capture_writes();
		assert.isTrue(await editor_state.save_draft({ overwrite: true }));

		editor_state.current_content = 'mine again';
		await broadcast('theirs again');

		assert.isTrue(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine again');
	});

	test('a later conflict after keeping the disk version starts on the edit too', async () => {
		await preview_conflict();
		editor_state.discard_draft();

		editor_state.current_content = 'mine again';
		await broadcast('theirs again');

		assert.isTrue(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
	});

	test('a failed overwrite keeps the draft shown', async () => {
		await preview_conflict();
		app.diskfiles.update = () =>
			Promise.resolve({ ok: false, error: { code: -32603, message: 'disk full' } as const });

		const saving = editor_state.save_draft({ overwrite: true });

		assert.isFalse(await saving);
		assert.isTrue(editor_state.has_conflict);
		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
	});

	test('the last tab closing resets the view to the draft', async () => {
		await preview_conflict();

		editor_state.reset_view();

		assert.isFalse(editor_state.showing_disk);
		assert.strictEqual(editor_state.shown_content, 'mine');
	});

	test('disposing', async () => {
		await preview_conflict();

		editor_state.dispose();

		assert.isFalse(editor_state.showing_disk);
	});
});
