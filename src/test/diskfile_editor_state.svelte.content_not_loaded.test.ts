// @vitest-environment jsdom

import { test, beforeEach, describe, assert, vi } from 'vitest';

import { DiskfileEditorState } from '$lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';
import { DISKFILE_CONTENT_NOT_LOADED_MESSAGE } from '$lib/diskfile_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

/**
 * A diskfile whose content wasn't loaded (`content: null` — over the 4 MiB
 * index cap, not UTF-8, or unreadable) must never be saved over: an empty
 * editor for it isn't the file's content.
 */

const PATH = DiskfilePath.parse('/w/big.bin');
const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');

let app: Frontend;
let update: ReturnType<typeof vi.fn>;

const add_diskfile = (content: string | null): Diskfile =>
	app.diskfiles.add({ path: PATH, source_dir: SOURCE_DIR, content });

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	// the real `Diskfiles.update` (the monkeypatch stubs it), over a mocked API
	delete (app.diskfiles as { update?: unknown }).update;
	update = vi.fn(() => Promise.resolve({ ok: true, value: null }));
	(app as any).api = { diskfile_update: update };
});

describe('a file whose content was not loaded', () => {
	test('is read-only: edits are ignored and nothing can be saved', async () => {
		const diskfile = add_diskfile(null);
		const editor_state = new DiskfileEditorState({ app, diskfile });

		assert.isFalse(diskfile.content_loaded);
		assert.isFalse(editor_state.content_loaded);

		editor_state.current_content = 'typed into the empty editor';

		assert.strictEqual(editor_state.current_content, '');
		assert.isFalse(editor_state.has_changes);
		assert.isFalse(editor_state.can_save);
		assert.isNull(editor_state.unsaved_edit_entry_id);

		assert.isFalse(await editor_state.save_changes());
		assert.strictEqual(editor_state.save_error, DISKFILE_CONTENT_NOT_LOADED_MESSAGE);
		assert.strictEqual(update.mock.calls.length, 0, 'never written');
	});

	test('a loaded file that becomes unloaded stops being savable', async () => {
		const diskfile = add_diskfile('small');
		const editor_state = new DiskfileEditorState({ app, diskfile });
		editor_state.current_content = 'edited';
		assert.isTrue(editor_state.can_save);

		// grew past the index cap on disk
		diskfile.content = null;
		editor_state.check_disk_changes();

		assert.isFalse(editor_state.can_save);
		assert.isFalse(await editor_state.save_changes());
		assert.strictEqual(update.mock.calls.length, 0);
		// the stale edit stays in history, but the editor shows (and copies) nothing
		assert.strictEqual(editor_state.current_content, '');
		assert.ok(editor_state.history?.entries.some((entry) => entry.content === 'edited'));
	});

	test('`Diskfiles.update` refuses to write over it', async () => {
		add_diskfile(null);
		const result = await app.diskfiles.update(PATH, 'clobber');
		assert.isFalse(result.ok);
		assert.ok(!result.ok);
		assert.deepEqual(result.error.data, { reason: 'content_not_loaded' });
		assert.strictEqual(update.mock.calls.length, 0);
	});

	test('`Diskfiles.update` still writes loaded and unknown files', async () => {
		add_diskfile('');
		assert.isTrue((await app.diskfiles.update(PATH, 'x')).ok);
		assert.isTrue((await app.diskfiles.update(DiskfilePath.parse('/w/new.txt'), 'y')).ok);
		assert.strictEqual(update.mock.calls.length, 2);
	});

	test('an empty file is loaded, not unloaded', () => {
		const diskfile = add_diskfile('');
		const editor_state = new DiskfileEditorState({ app, diskfile });
		assert.isTrue(diskfile.content_loaded);
		editor_state.current_content = 'now has text';
		assert.isTrue(editor_state.can_save);
	});
});
