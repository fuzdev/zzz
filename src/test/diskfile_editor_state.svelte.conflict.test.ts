// @vitest-environment jsdom

import { test, beforeEach, describe, assert } from 'vitest';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';

import type { DiskfileEditorState } from '$lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

/**
 * A change on disk under the user's edit is kept apart from it: the edit
 * stays, and saving waits for an explicit overwrite or reload — while our own
 * save's broadcast never counts as such a change.
 */

const PATH = DiskfilePath.parse('/w/a.txt');
const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');

let app: Frontend;
let diskfile: Diskfile;
let editor_state: DiskfileEditorState;

/** A `filer_change` for the file, as the backend broadcasts it. */
const broadcast = (contents: string): void => {
	app.diskfiles.handle_change({
		change: { type: 'change', path: PATH },
		disknode: {
			id: PATH,
			source_dir: SOURCE_DIR,
			contents,
			ctime: 1,
			mtime: 1,
			dependents: [],
			dependencies: []
		}
	});
};

/** Makes `app.diskfiles.update` wait for the returned deferred. */
const defer_update = () => {
	const writes: Array<string> = [];
	const deferred = create_deferred<Awaited<ReturnType<Frontend['diskfiles']['update']>>>();
	app.diskfiles.update = (_path, content) => {
		writes.push(content);
		return deferred.promise;
	};
	return { writes, deferred };
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	diskfile = app.diskfiles.add({ path: PATH, source_dir: SOURCE_DIR, content: 'v1' });
	editor_state = app.diskfiles.get_editor_state(diskfile);
});

describe('an external change on a dirty file', () => {
	test('keeps the draft and marks a conflict', () => {
		editor_state.current_content = 'mine';

		broadcast('theirs');

		assert.strictEqual(editor_state.current_content, 'mine');
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.isTrue(editor_state.disk_conflict);
		assert.isTrue(editor_state.has_conflict);
		assert.ok(
			editor_state.history.entries.some(
				(entry) => entry.is_disk_change && entry.content === 'theirs'
			)
		);
	});

	test('a plain save writes nothing, an overwrite saves the draft', async () => {
		editor_state.current_content = 'mine';
		broadcast('theirs');
		const { writes, deferred } = defer_update();

		assert.isFalse(await editor_state.save_changes());
		assert.deepEqual(writes, []);

		const saving = editor_state.save_changes({ overwrite: true });
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		assert.deepEqual(writes, ['mine']);
		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.strictEqual(editor_state.current_content, 'mine');
	});

	test('discard_draft resolves it without writing', () => {
		editor_state.current_content = 'mine';
		broadcast('theirs');

		editor_state.discard_draft();

		assert.strictEqual(editor_state.current_content, 'theirs');
		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.can_save);
	});

	test('editing back to the disk content resolves it', () => {
		editor_state.current_content = 'mine';
		broadcast('theirs');

		editor_state.current_content = 'theirs';

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
	});

	test('the disk landing on the draft settles it instead', () => {
		editor_state.current_content = 'same';

		broadcast('same');

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.content_was_modified_by_user);
	});

	test('a picked older entry counts as the user content too', () => {
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);

		broadcast('theirs');

		assert.strictEqual(editor_state.current_content, 'older');
		assert.isTrue(editor_state.has_conflict);
	});

	test('a clean editor follows the disk, no conflict', () => {
		broadcast('theirs');

		assert.strictEqual(editor_state.current_content, 'theirs');
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.can_save);
	});

	test('a draft viewed away from is flagged, and shows once it is viewed again', () => {
		editor_state.current_content = 'mine';
		const draft_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft_id);
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);

		broadcast('theirs');

		// the clean view follows the disk, the draft predates it
		assert.strictEqual(editor_state.current_content, 'theirs');
		assert.isFalse(editor_state.has_conflict);
		editor_state.set_content_from_history(draft_id);
		assert.isTrue(editor_state.has_conflict);
	});

	test('a fresh draft typed on the new disk content is no conflict', () => {
		editor_state.current_content = 'D';
		broadcast('X');
		const x = editor_state.history.entries.find((entry) => entry.content === 'X');
		assert.ok(x);
		editor_state.set_content_from_history(x.id);

		editor_state.current_content = 'X plus my new edit';

		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_conflict);
		// the old draft is set aside, still restorable
		assert.ok(
			editor_state.history.entries.some((entry) => entry.content === 'D' && entry.is_discarded_edit)
		);
	});

	test('a disk change matching a discarded edit records a disk entry, not the discarded one', () => {
		editor_state.current_content = 'D';
		editor_state.discard_draft();

		broadcast('D');

		const discarded = editor_state.history.entries.find((entry) => entry.is_discarded_edit);
		assert.ok(discarded);
		assert.isFalse(discarded.is_disk_change);
		const disk_entry = editor_state.history.entries[0];
		assert.include(disk_entry, { content: 'D', is_disk_change: true, is_discarded_edit: false });
		assert.strictEqual(editor_state.current_content, 'D');
	});

	test('a follow-up save queued before the change lands is refused', async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();
		const saving = editor_state.save_changes();
		editor_state.current_content = 'second';
		const queued = editor_state.save_changes();

		// someone else writes after ours, and their broadcast lands last
		broadcast('first');
		broadcast('theirs');
		deferred.resolve({ ok: true, value: null });

		assert.isTrue(await saving);
		assert.isFalse(await queued);
		assert.deepEqual(writes, ['first']);
		assert.strictEqual(editor_state.current_content, 'second');
		assert.isTrue(editor_state.has_conflict);
	});
});

describe("our own save's broadcast", () => {
	test('landing before the response is no conflict', async () => {
		editor_state.current_content = 'mine';
		const { deferred } = defer_update();
		const saving = editor_state.save_changes();

		broadcast('mine');
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
	});

	test('landing while typing continues past it is no conflict', async () => {
		editor_state.current_content = 'mine';
		const { deferred } = defer_update();
		const saving = editor_state.save_changes();
		editor_state.current_content = 'mine, more';

		broadcast('mine');
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		assert.isFalse(editor_state.disk_conflict);
		assert.strictEqual(editor_state.current_content, 'mine, more');
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.isTrue(await editor_state.save_changes());
	});

	test('landing after the response is no conflict', async () => {
		editor_state.current_content = 'mine';
		const { deferred } = defer_update();
		const saving = editor_state.save_changes();
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		broadcast('mine');

		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.has_changes);
	});

	test('landing after an external write mid-save settles the conflict it raised', async () => {
		editor_state.current_content = 'mine';
		const { deferred } = defer_update();
		const saving = editor_state.save_changes();

		// an external write lands just before ours, its broadcast arrives mid-save
		broadcast('theirs');
		assert.isTrue(editor_state.has_conflict);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
		// the disk still holds theirs until our broadcast says otherwise
		assert.isTrue(editor_state.has_conflict);

		broadcast('mine');

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.strictEqual(editor_state.current_content, 'mine');
	});
});
