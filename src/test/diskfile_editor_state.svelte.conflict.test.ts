// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';

import type { DiskfileEditorState } from '#lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	answer_update,
	flush_reads,
	install_fake_disk,
	type FakeDisk,
	type HeldUpdateResult
} from './diskfile_test_helpers.ts';

/**
 * A change on disk under the user's edit is kept apart from it: the edit
 * stays, and saving waits for an explicit overwrite or keeping the disk
 * version — while our own save's broadcast never counts as such a change.
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

/** Makes `app.diskfiles.update` wait for the returned deferred. */
const defer_update = () => {
	const writes: Array<string> = [];
	const deferred = create_deferred<HeldUpdateResult>();
	app.diskfiles.update = (_path, content) => {
		writes.push(content);
		return deferred.promise.then((result) => answer_update(content, result));
	};
	return { writes, deferred };
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
	diskfile = app.diskfiles.add({ path: PATH, source_dir: SOURCE_DIR, content: 'v1' });
	editor_state = app.diskfiles.get_editor_state(diskfile);
});

describe('an external change on a dirty file', () => {
	test('keeps the draft and marks a conflict', async () => {
		editor_state.current_content = 'mine';

		await broadcast('theirs');

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
		await broadcast('theirs');
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

	test('discard_draft resolves it without writing', async () => {
		editor_state.current_content = 'mine';
		await broadcast('theirs');

		editor_state.discard_draft();

		assert.strictEqual(editor_state.current_content, 'theirs');
		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.can_save);
	});

	test('editing back to the disk content resolves it', async () => {
		editor_state.current_content = 'mine';
		await broadcast('theirs');

		editor_state.current_content = 'theirs';

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
	});

	test('the disk landing on the draft settles it instead', async () => {
		editor_state.current_content = 'same';

		await broadcast('same');

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.content_was_modified_by_user);
	});

	test('a picked older entry counts as the user content too', async () => {
		const older = editor_state.history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);

		await broadcast('theirs');

		assert.strictEqual(editor_state.current_content, 'older');
		assert.isTrue(editor_state.has_conflict);
	});

	test('a clean editor follows the disk, no conflict', async () => {
		await broadcast('theirs');

		assert.strictEqual(editor_state.current_content, 'theirs');
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.can_save);
	});

	test('a draft viewed away from is flagged, and shows once it is viewed again', async () => {
		editor_state.current_content = 'mine';
		const draft_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft_id);
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);

		await broadcast('theirs');

		// the clean view follows the disk, the draft predates it
		assert.strictEqual(editor_state.current_content, 'theirs');
		assert.isFalse(editor_state.has_conflict);
		editor_state.set_content_from_history(draft_id);
		assert.isTrue(editor_state.has_conflict);
	});

	test('a fresh draft typed on the new disk content is no conflict', async () => {
		editor_state.current_content = 'D';
		await broadcast('X');
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

	test('a disk change matching a discarded edit records a disk entry, not the discarded one', async () => {
		editor_state.current_content = 'D';
		editor_state.discard_draft();

		await broadcast('D');

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
		await broadcast('first');
		await broadcast('theirs');
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

		await broadcast('mine');
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

		await broadcast('mine');
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

		await broadcast('mine');

		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.has_changes);
	});

	test('landing after an external write mid-save settles the conflict it raised', async () => {
		editor_state.current_content = 'mine';
		const { deferred } = defer_update();
		const saving = editor_state.save_changes();

		// an external write lands just before ours, its broadcast arrives mid-save
		await broadcast('theirs');
		assert.isTrue(editor_state.has_conflict);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
		// the disk still holds theirs until our broadcast says otherwise
		assert.isTrue(editor_state.has_conflict);

		await broadcast('mine');

		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.strictEqual(editor_state.current_content, 'mine');
	});
});

describe('a save while a reported change is still being read', () => {
	test('waits for the read, then refuses on the conflict it shows', async () => {
		editor_state.current_content = 'mine';
		const release = disk.hold_reads();
		disk.write(PATH, 'theirs');
		await flush_reads();
		assert.isFalse(editor_state.has_conflict, 'not known before the read lands');
		const { writes } = defer_update();

		const saving = editor_state.save_changes();
		await flush_reads();
		assert.deepEqual(writes, [], 'nothing written while the read is in flight');

		release();
		assert.isFalse(await saving);
		assert.deepEqual(writes, []);
		assert.isTrue(editor_state.has_conflict);
		assert.strictEqual(editor_state.current_content, 'mine');
	});

	test('a change of the same bytes: the save goes ahead once the read lands', async () => {
		editor_state.current_content = 'mine';
		const release = disk.hold_reads();
		// a `touch` — the file still holds what the draft started from
		disk.write(PATH, 'v1');
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		await flush_reads();
		assert.deepEqual(writes, []);

		release();
		await flush_reads();
		assert.deepEqual(writes, ['mine']);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
		assert.isFalse(editor_state.has_conflict);
	});

	test("a reconnect's re-read gates a save the same way", async () => {
		editor_state.current_content = 'mine';
		// changed while disconnected, and the snapshot says only that the file is there
		disk.files.set(PATH, 'theirs');
		const release = disk.hold_reads();
		app.diskfiles.reconcile([disk.disknode(PATH)], [SOURCE_DIR]);
		const { writes } = defer_update();

		const saving = editor_state.save_changes();
		await flush_reads();
		assert.deepEqual(writes, []);

		release();
		assert.isFalse(await saving);
		assert.deepEqual(writes, []);
		assert.isTrue(editor_state.has_conflict);
	});

	test("our own save's re-read holds back only the next save, which then goes ahead", async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();
		const saving = editor_state.save_changes();
		const release = disk.hold_reads();
		// our save's broadcast lands before its response, and its re-read is held
		disk.write(PATH, 'first');
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		editor_state.current_content = 'second';
		const next = editor_state.save_changes();
		await flush_reads();
		assert.deepEqual(writes, ['first'], 'the next save waits for the read');

		release();
		assert.isTrue(await next);
		assert.deepEqual(writes, ['first', 'second']);
		assert.isFalse(editor_state.has_conflict);
	});
});

describe('a save after a read that failed', () => {
	test('reads once more, and refuses on the change that read shows', async () => {
		editor_state.current_content = 'mine';
		const release = disk.hold_reads();
		disk.fail_reads(1, 'socket closed');
		disk.write(PATH, 'theirs');
		const { writes } = defer_update();

		const saving = editor_state.save_changes();
		await flush_reads();
		assert.isTrue(editor_state.save_pending, 'busy while it waits');
		assert.isFalse(editor_state.saving, 'no write in flight');

		release();
		assert.isFalse(await saving);
		assert.deepEqual(writes, []);
		assert.isTrue(editor_state.has_conflict);
		assert.isNull(diskfile.content_error, 'the retry read it');
		assert.isFalse(editor_state.save_pending);
	});

	test('reads once more, and writes when the file still holds what the draft started from', async () => {
		editor_state.current_content = 'mine';
		const release = disk.hold_reads();
		disk.fail_reads(1);
		disk.write(PATH, 'v1');
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		release();
		await flush_reads();
		assert.deepEqual(writes, ['mine']);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
	});

	test('refuses, saying why, when the second read fails too', async () => {
		editor_state.current_content = 'mine';
		const release = disk.hold_reads();
		disk.fail_reads(2, 'permission denied');
		disk.write(PATH, 'theirs');
		const { writes } = defer_update();

		const saving = editor_state.save_changes();
		release();
		assert.isFalse(await saving);
		assert.deepEqual(writes, []);
		assert.deepEqual(disk.reads, [PATH, PATH], 'one retry, no more');
		assert.include(editor_state.save_error, "couldn't check the file on disk");
		assert.include(editor_state.save_error, 'permission denied');
		assert.isFalse(editor_state.save_pending);
	});

	test('a read that failed before the save is retried by it too', async () => {
		editor_state.current_content = 'mine';
		disk.fail_reads(1);
		await broadcast('theirs');
		assert.isNotNull(diskfile.content_error);
		assert.isFalse(editor_state.has_conflict, 'the change never arrived');
		const { writes } = defer_update();

		assert.isFalse(await editor_state.save_changes());
		assert.deepEqual(writes, []);
		assert.isTrue(editor_state.has_conflict);
	});

	test('a file deleted on disk since is written without the retry, recreating it', async () => {
		editor_state.current_content = 'mine';
		disk.fail_reads(1);
		await broadcast('theirs');
		assert.isNotNull(diskfile.content_error);
		app.diskfiles.remove_by_path(PATH);
		assert.isTrue(diskfile.deleted_on_disk, 'kept for its draft');
		const { writes, deferred } = defer_update();
		const reads_before = disk.reads.length;

		const saving = editor_state.save_changes();
		await flush_reads();
		assert.deepEqual(writes, ['mine']);
		assert.strictEqual(disk.reads.length, reads_before, 'nothing on disk to check');
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
	});

	test('an overwrite writes without the retry', async () => {
		editor_state.current_content = 'mine';
		disk.fail_reads(1);
		await broadcast('theirs');
		const { writes, deferred } = defer_update();
		const reads_before = disk.reads.length;

		const saving = editor_state.save_changes({ overwrite: true });
		await flush_reads();
		assert.deepEqual(writes, ['mine']);
		assert.strictEqual(disk.reads.length, reads_before);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
	});
});
