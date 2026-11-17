// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';

import {
	SAVE_ERROR_CHANGED_AGAIN,
	SAVE_ERROR_DELETED_ON_DISK,
	type DiskfileEditorState
} from '#lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	content_hash,
	flush_reads,
	install_fake_disk,
	type FakeDisk
} from './diskfile_test_helpers.ts';

/**
 * A save carries the hash of the disk content it's based on, and the backend
 * writes only if the file still holds it — so a write the frontend hasn't
 * heard of yet is never replaced unseen, and shows as a conflict instead.
 */

const PATH = parse_or_throw(DiskfilePath, '/w/a.txt');
const OTHER = parse_or_throw(DiskfilePath, '/w/b.txt');
const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let diskfile: Diskfile;
let editor_state: DiskfileEditorState;
let disk: FakeDisk;

/** What each `diskfile_update` sent: its content and base. */
const sent = (): Array<[string, string | undefined]> =>
	disk.updates.map((update) => [update.content, update.expected_hash]);

beforeEach(async () => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	// the real `Diskfiles.update` (the monkeypatch stubs it), over the fake disk
	delete (app.diskfiles as { update?: unknown }).update;
	disk = install_fake_disk(app, SOURCE_DIR);
	diskfile = await disk.load(PATH, 'v1');
	editor_state = app.diskfiles.get_editor_state(diskfile);
});

describe('the base a save sends', () => {
	test('is the hash of the disk content last read', async () => {
		assert.strictEqual(diskfile.content_hash, content_hash('v1'));
		assert.strictEqual(editor_state.last_seen_disk_hash, content_hash('v1'));

		editor_state.current_content = 'mine';
		assert.isTrue(await editor_state.save_changes());

		assert.deepEqual(sent(), [['mine', content_hash('v1')]]);
		assert.strictEqual(disk.files.get(PATH), 'mine');
		// moved by our own save's response, before its broadcast's re-read
		assert.strictEqual(editor_state.last_seen_disk_hash, content_hash('mine'));
		assert.strictEqual(diskfile.content_hash, content_hash('v1'), 'the diskfile waits for a read');
	});

	test('a save queued behind another is based on what that one wrote', async () => {
		editor_state.current_content = 'a';
		const release = disk.hold_updates();
		const first = editor_state.save_changes();
		editor_state.current_content = 'ab';
		const second = editor_state.save_changes();
		release();

		assert.isTrue(await first);
		assert.isTrue(await second);
		assert.deepEqual(sent(), [
			['a', content_hash('v1')],
			['ab', content_hash('a')]
		]);
		assert.strictEqual(disk.files.get(PATH), 'ab');
	});

	test("our own save's broadcast raises no conflict and keeps the base", async () => {
		editor_state.current_content = 'mine';
		assert.isTrue(await editor_state.save_changes());
		editor_state.current_content = 'mine, more';

		// the filer reports our own save, and the re-read lands
		disk.write(PATH, 'mine');
		await flush_reads();

		assert.isFalse(editor_state.has_conflict);
		assert.strictEqual(diskfile.content_hash, content_hash('mine'));
		assert.isTrue(await editor_state.save_changes());
		assert.deepEqual(sent().at(-1), ['mine, more', content_hash('mine')]);
	});

	test('an overwrite is checked against the disk version shown', async () => {
		editor_state.current_content = 'mine';
		disk.write(PATH, 'theirs');
		await flush_reads();
		assert.isTrue(editor_state.has_conflict);

		assert.isTrue(await editor_state.save_changes({ overwrite: true }));
		assert.deepEqual(sent(), [['mine', content_hash('theirs')]]);
		assert.strictEqual(disk.files.get(PATH), 'mine');
		assert.isFalse(editor_state.has_conflict);
	});

	test('an overwrite after a failed read writes over whatever is there', async () => {
		editor_state.current_content = 'mine';
		disk.fail_reads(1, 'socket closed');
		disk.write(PATH, 'theirs');
		await flush_reads();
		assert.strictEqual(diskfile.content_error, 'socket closed');
		assert.strictEqual(diskfile.content, 'v1', 'what was shown may not be on disk');

		assert.isTrue(await editor_state.save_changes({ overwrite: true }));
		assert.deepEqual(sent(), [['mine', undefined]]);
		assert.strictEqual(disk.files.get(PATH), 'mine');
	});

	test('an overwrite is of the version shown when asked, even as a newer one is read meanwhile', async () => {
		editor_state.current_content = 'mine';
		disk.write(PATH, 'V2');
		await flush_reads();
		assert.isTrue(editor_state.has_conflict);

		// V3 reported, its read in flight, when the user overwrites V2
		const release = disk.hold_reads();
		disk.write(PATH, 'V3');
		const saving = editor_state.save_changes({ overwrite: true });
		release();

		assert.isFalse(await saving);
		assert.deepEqual(sent(), [['mine', content_hash('V2')]]);
		assert.strictEqual(disk.files.get(PATH), 'V3', 'not written over unseen');
		assert.strictEqual(diskfile.content, 'V3');
		assert.strictEqual(editor_state.current_content, 'mine', 'the draft kept');
		assert.isTrue(editor_state.has_conflict);
		assert.strictEqual(editor_state.save_error, SAVE_ERROR_CHANGED_AGAIN);
	});

	test("a refused overwrite's error clears once the disk settles on the draft, and only that error", async () => {
		editor_state.current_content = 'mine';
		disk.write(PATH, 'V2');
		await flush_reads();
		disk.files.set(PATH, 'V3');
		assert.isFalse(await editor_state.save_changes({ overwrite: true }));
		assert.strictEqual(editor_state.save_error, SAVE_ERROR_CHANGED_AGAIN);

		// another tool writes the draft's text: nothing left to overwrite
		disk.write(PATH, 'mine');
		await flush_reads();
		assert.isFalse(editor_state.has_conflict);
		assert.isNull(editor_state.save_error);

		// any other error stays when the disk settles
		editor_state.current_content = 'mine, more';
		editor_state.save_error = 'disk full';
		disk.write(PATH, 'mine, more');
		await flush_reads();
		assert.strictEqual(editor_state.save_error, 'disk full');
	});

	test('an overwrite asked for after a failed read stays unchecked though a read lands meanwhile', async () => {
		editor_state.current_content = 'mine';
		disk.fail_reads(1, 'socket closed');
		disk.write(PATH, 'V2');
		await flush_reads();
		assert.strictEqual(diskfile.content_error, 'socket closed');

		const release = disk.hold_reads();
		disk.write(PATH, 'V3');
		const saving = editor_state.save_changes({ overwrite: true });
		release();

		// forced, as asked: no version could be trusted as shown when it was
		assert.isTrue(await saving);
		assert.deepEqual(sent(), [['mine', undefined]]);
		assert.strictEqual(disk.files.get(PATH), 'mine');
	});

	test('a save after a failed read says when the file is gone', async () => {
		editor_state.current_content = 'mine';
		disk.fail_reads(1, 'socket closed');
		disk.write(PATH, 'V2');
		await flush_reads();
		disk.files.delete(PATH);

		assert.isFalse(await editor_state.save_changes());
		assert.strictEqual(editor_state.save_error, SAVE_ERROR_DELETED_ON_DISK);
		assert.deepEqual(sent(), [], 'nothing sent');
	});

	test('a recreate is an exclusive create, then read back for its base', async () => {
		editor_state.current_content = 'mine';
		disk.files.delete(PATH);
		app.diskfiles.remove_by_path(PATH);
		assert.isTrue(diskfile.deleted_on_disk);

		assert.isTrue(await editor_state.save_changes());
		assert.deepEqual(sent(), [], 'no update');
		assert.deepEqual(disk.creates, [{ path: PATH, content: 'mine' }]);
		assert.strictEqual(disk.files.get(PATH), 'mine');
		await flush_reads();
		assert.strictEqual(editor_state.last_seen_disk_hash, content_hash('mine'));

		// so the next save is checked against it
		editor_state.current_content = 'mine 2';
		assert.isTrue(await editor_state.save_changes());
		assert.deepEqual(sent(), [['mine 2', content_hash('mine')]]);
	});

	test('content that came without a read is saved unchecked, until a read brings its hash', async () => {
		const other = app.diskfiles.add({ path: OTHER, source_dir: SOURCE_DIR, content: 'seeded' });
		const other_state = app.diskfiles.get_editor_state(other);
		assert.isNull(other.content_hash);
		assert.isNull(other_state.last_seen_disk_hash);

		// a read of the same text brings the hash, and changes nothing else
		disk.write(OTHER, 'seeded');
		await flush_reads();
		assert.strictEqual(other_state.last_seen_disk_hash, content_hash('seeded'));
		assert.isFalse(other_state.has_history);

		const unread = app.diskfiles.add({
			path: parse_or_throw(DiskfilePath, '/w/c.txt'),
			source_dir: SOURCE_DIR,
			content: 'seeded'
		});
		const unread_state = app.diskfiles.get_editor_state(unread);
		unread_state.current_content = 'x';
		assert.isTrue(await unread_state.save_changes());
		assert.deepEqual(sent(), [['x', undefined]]);
	});

	test('a file not held drops its hash with its content', async () => {
		const other = await disk.load(OTHER, 'q');
		assert.strictEqual(other.content_hash, content_hash('q'));
		disk.write(OTHER, 'r');
		assert.isNull(other.content);
		assert.isNull(other.content_hash);
	});
});

describe('a write the frontend has not heard of', () => {
	/**
	 * Starts a save of `draft` and, before the backend compares, writes
	 * `theirs` to the disk without the filer reporting it — the window only
	 * the backend can see.
	 */
	const save_over_unreported_write = (
		draft: string,
		theirs: string | null | undefined
	): Promise<boolean> => {
		editor_state.current_content = draft;
		const release = disk.hold_updates();
		const saving = editor_state.save_changes();
		if (theirs === undefined) {
			disk.files.delete(PATH);
		} else {
			disk.files.set(PATH, theirs);
		}
		release();
		return saving;
	};

	test('refuses the save, reads the file again, and shows the conflict', async () => {
		const saving = save_over_unreported_write('mine', 'theirs');
		assert.isFalse(await saving);

		assert.strictEqual(disk.files.get(PATH), 'theirs', 'nothing written');
		assert.deepEqual(sent(), [['mine', content_hash('v1')]]);
		assert.strictEqual(diskfile.content, 'theirs', 'read again');
		assert.strictEqual(editor_state.current_content, 'mine', 'the draft kept');
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.isTrue(editor_state.has_conflict);
		assert.isNull(editor_state.save_error, 'the conflict notice says why');
		assert.isFalse(editor_state.save_pending);
		assert.isFalse(editor_state.saving);
		assert.strictEqual(editor_state.last_seen_disk_hash, content_hash('theirs'));
		assert.ok(
			editor_state.history.entries.some(
				(entry) => entry.is_disk_change && entry.content === 'theirs'
			)
		);

		// a plain save stays paused; an overwrite writes, over what it has seen
		assert.isFalse(await editor_state.save_changes());
		assert.strictEqual(disk.updates.length, 1);
		assert.isTrue(await editor_state.save_changes({ overwrite: true }));
		assert.strictEqual(disk.files.get(PATH), 'mine');
	});

	test('waits for the re-read before it settles', async () => {
		editor_state.current_content = 'mine';
		const release_update = disk.hold_updates();
		const saving = editor_state.save_changes();
		disk.files.set(PATH, 'theirs');
		const release_read = disk.hold_reads();
		release_update();
		await flush_reads();
		assert.isTrue(editor_state.save_pending, 'busy while the file is read again');
		assert.isFalse(editor_state.has_conflict);

		release_read();
		assert.isFalse(await saving);
		assert.isFalse(editor_state.save_pending);
		assert.isTrue(editor_state.has_conflict);
	});

	test('says so when the re-read fails, keeping the draft', async () => {
		disk.fail_reads(1, 'socket closed');
		assert.isFalse(await save_over_unreported_write('mine', 'theirs'));

		assert.strictEqual(
			editor_state.save_error,
			'not saved — the file changed on disk, and reading it again failed: socket closed'
		);
		assert.strictEqual(editor_state.current_content, 'mine');
		assert.strictEqual(diskfile.content, 'v1', 'the old content kept');
		assert.strictEqual(disk.files.get(PATH), 'theirs');
	});

	test('a file gone from disk is a change too, and said to be deleted', async () => {
		assert.isFalse(await save_over_unreported_write('mine', undefined));

		assert.isFalse(disk.files.has(PATH), 'not recreated');
		assert.strictEqual(diskfile.content_error_reason, 'path_not_found');
		assert.strictEqual(editor_state.save_error, SAVE_ERROR_DELETED_ON_DISK);
		assert.strictEqual(editor_state.current_content, 'mine');
	});

	test('says the save failed when the file read again is no longer text', async () => {
		assert.isFalse(await save_over_unreported_write('mine', null));

		assert.strictEqual(
			editor_state.save_error,
			"not saved — content not loaded — the file isn't UTF-8 text"
		);
		assert.strictEqual(disk.files.get(PATH), null, 'nothing written');
	});

	test('an overwrite of the conflict shown is refused for a newer write, which then shows', async () => {
		editor_state.current_content = 'mine';
		disk.write(PATH, 'V2');
		await flush_reads();
		assert.isTrue(editor_state.has_conflict);
		editor_state.set_showing_disk(true);

		// V3 lands before its filer event, then the user overwrites V2
		disk.files.set(PATH, 'V3');
		assert.isFalse(await editor_state.save_changes({ overwrite: true }));

		assert.strictEqual(disk.files.get(PATH), 'V3', 'nothing written');
		assert.deepEqual(sent(), [['mine', content_hash('V2')]]);
		assert.strictEqual(diskfile.content, 'V3', 'read again');
		assert.strictEqual(editor_state.current_content, 'mine', 'the draft kept');
		assert.isTrue(editor_state.has_conflict, 'a new conflict, over V3');
		assert.strictEqual(editor_state.save_error, SAVE_ERROR_CHANGED_AGAIN);
		assert.ok(
			editor_state.history.entries.some((entry) => entry.is_disk_change && entry.content === 'V3')
		);

		// overwriting the version now shown writes
		assert.isTrue(await editor_state.save_changes({ overwrite: true }));
		assert.isNull(editor_state.save_error);
		assert.deepEqual(sent().at(-1), ['mine', content_hash('V3')]);
		assert.strictEqual(disk.files.get(PATH), 'mine');
	});

	test('counts as saved when the disk now holds what was being saved', async () => {
		assert.isTrue(await save_over_unreported_write('mine', 'mine'));

		assert.strictEqual(disk.updates.length, 1, 'written by someone else, not again');
		assert.strictEqual(diskfile.content, 'mine');
		assert.isFalse(editor_state.has_conflict);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isNull(editor_state.save_error);
	});

	test('a save queued behind the refused one is not sent', async () => {
		editor_state.current_content = 'mine';
		const release = disk.hold_updates();
		const first = editor_state.save_changes();
		editor_state.current_content = 'mine, more';
		const second = editor_state.save_changes();
		disk.files.set(PATH, 'theirs');
		release();

		assert.isFalse(await first);
		assert.isFalse(await second);
		assert.strictEqual(disk.updates.length, 1);
		assert.isTrue(editor_state.has_conflict);
	});
});
