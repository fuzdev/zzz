// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';

import { DiskfileEditorState } from '#lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import { Diskfile } from '#lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	answer_update,
	content_hash,
	flush_reads,
	install_fake_disk,
	type FakeDisk,
	type HeldUpdateResult
} from './diskfile_test_helpers.ts';

/**
 * A file's draft lives in `Diskfiles.drafts`, apart from the cell and the
 * editing state, and its status is derived: it's based on the hash of the
 * disk content it started from, and stale once the disk moves past it.
 */

const PATH = parse_or_throw(DiskfilePath, '/w/a.txt');
const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let disk: FakeDisk;
let diskfile: Diskfile;

/** Saves through the fake disk — the real `Diskfiles.update`, which the monkeypatch stubs. */
const use_real_update = (): void => {
	delete (app.diskfiles as { update?: unknown }).update;
};

beforeEach(async () => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
	diskfile = await disk.load(PATH, 'v1');
});

describe('a draft', () => {
	test('is based on the hash of the disk content it starts from', () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';

		const draft = app.diskfiles.drafts.get(PATH);
		assert.ok(draft);
		assert.strictEqual(draft, editor_state.draft);
		assert.strictEqual(draft.text, 'mine');
		assert.strictEqual(draft.base_hash, content_hash('v1'));
		assert.strictEqual(draft.root, app.diskfiles.to_innermost_root(PATH));
		assert.strictEqual(draft.status, 'bound');
	});

	test('goes stale when the disk moves past its base, and is based on what an overwrite wrote', async () => {
		use_real_update();
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';
		const draft = app.diskfiles.drafts.get(PATH)!;

		disk.write(PATH, 'theirs');
		await flush_reads();

		assert.strictEqual(draft.status, 'stale');
		assert.strictEqual(draft.base_hash, content_hash('v1'));
		assert.isTrue(editor_state.has_conflict);

		// overwrite, typing on while it's in flight, so the draft outlives the save
		const release = disk.hold_updates();
		const saving = editor_state.save_draft({ overwrite: true });
		editor_state.current_content = 'mine, more';
		release();
		assert.isTrue(await saving);

		assert.strictEqual(app.diskfiles.drafts.get(PATH), draft);
		assert.strictEqual(draft.text, 'mine, more');
		assert.strictEqual(draft.base_hash, content_hash('mine'));
		assert.strictEqual(draft.status, 'bound');
		assert.isFalse(editor_state.has_conflict);
	});

	test("is rebased on our own write when its read lands before the save's response", async () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		const deferred = create_deferred<HeldUpdateResult>();
		app.diskfiles.update = (_path, content) =>
			deferred.promise.then((result) => answer_update(content, result));

		editor_state.current_content = 'mine';
		const saving = editor_state.save_changes();
		editor_state.current_content = 'mine, more';
		const draft = app.diskfiles.drafts.get(PATH)!;

		// the write's change reported and read back while the response is on its way
		disk.write(PATH, 'mine');
		await flush_reads();

		assert.strictEqual(draft.base_hash, content_hash('mine'));
		assert.strictEqual(draft.status, 'bound');
		assert.isFalse(editor_state.has_conflict);

		deferred.resolve({ ok: true });
		assert.isTrue(await saving);
		assert.strictEqual(draft.base_hash, content_hash('mine'));
		assert.strictEqual(draft.status, 'bound');
	});

	test('takes the hash of seeded content once a read of the same text brings it', async () => {
		const seeded = app.diskfiles.add({
			path: parse_or_throw(DiskfilePath, '/w/seeded.txt'),
			source_dir: SOURCE_DIR,
			content: 's1'
		});
		const editor_state = app.diskfiles.get_editor_state(seeded);
		editor_state.current_content = 'mine';
		const draft = app.diskfiles.drafts.get(seeded.path)!;
		assert.isNull(draft.base_hash);
		assert.strictEqual(draft.status, 'bound');

		disk.write(seeded.path, 's1');
		await flush_reads();

		assert.strictEqual(draft.base_hash, content_hash('s1'));
		assert.strictEqual(draft.status, 'bound');
	});

	test('is deleted while its file is deleted on disk', () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';

		app.diskfiles.remove_by_path(PATH);

		assert.isTrue(diskfile.deleted_on_disk, 'kept for the draft');
		assert.strictEqual(app.diskfiles.drafts.get(PATH)?.status, 'deleted');
	});
});

describe('a draft outliving its editing state', () => {
	test('is shown by the next editing state, and is stale if the disk moved past its base', () => {
		const draft = app.diskfiles.drafts.create(PATH, 'mine', content_hash('v0'));
		assert.strictEqual(draft.status, 'stale');

		const editor_state = app.diskfiles.get_editor_state(diskfile);

		assert.strictEqual(editor_state.selected_history_entry_id, draft.id);
		assert.strictEqual(editor_state.current_content, 'mine');
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.isTrue(editor_state.has_conflict);
		assert.isTrue(editor_state.dirty);
	});

	test('is bound by the next editing state when the disk still holds its base', () => {
		const draft = app.diskfiles.drafts.create(PATH, 'mine', content_hash('v1'));

		const editor_state = app.diskfiles.get_editor_state(diskfile);

		assert.strictEqual(editor_state.current_content, 'mine');
		assert.strictEqual(draft.status, 'bound');
		assert.isFalse(editor_state.has_conflict);
		assert.isTrue(editor_state.can_save);
	});

	test('stays stale when edited from a picked entry, which the disk never held', () => {
		app.diskfiles.drafts.create(PATH, 'mine', content_hash('v0'));
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		const older = editor_state.history.add_entry('older', { created: 1 });

		editor_state.set_content_from_history(older.id);
		editor_state.current_content = 'older, edited';

		const draft = app.diskfiles.drafts.get(PATH);
		assert.ok(draft);
		assert.strictEqual(draft.text, 'older, edited');
		assert.strictEqual(draft.base_hash, content_hash('v0'));
		assert.strictEqual(draft.status, 'stale');
		assert.isTrue(editor_state.has_conflict);
	});

	test('is never written by a disposed editing state', async () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';
		const throwaway = new DiskfileEditorState({ app, diskfile });
		throwaway.dispose();

		throwaway.current_content = 'from a throwaway';

		assert.strictEqual(app.diskfiles.drafts.get(PATH)?.text, 'mine');
		assert.isFalse(await throwaway.save_changes());
	});
});

describe('the drafts store', () => {
	test('`remove` with an id leaves a newer draft', () => {
		const older = app.diskfiles.drafts.create(PATH, 'older', null);
		const newer = app.diskfiles.drafts.create(PATH, 'newer', null);

		assert.isFalse(app.diskfiles.drafts.remove(PATH, older.id));
		assert.strictEqual(app.diskfiles.drafts.get(PATH), newer);
		assert.isTrue(app.diskfiles.drafts.remove(PATH, newer.id));
		assert.isFalse(app.diskfiles.drafts.has(PATH));
	});

	test('is emptied with the files when the collection is replaced', () => {
		app.diskfiles.get_editor_state(diskfile).current_content = 'mine';
		assert.isTrue(app.diskfiles.drafts.has(PATH));

		app.diskfiles.set_json({ diskfiles: [] });

		assert.strictEqual(app.diskfiles.drafts.size, 0);
		assert.isFalse(app.diskfiles.has_unsaved_changes);
	});
});

describe('the history around a draft', () => {
	test('lists the draft among the entries by date, newest first', () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.history.add_entry('older', { created: 1 });
		editor_state.current_content = 'mine';
		editor_state.history.add_entry('newer', { created: Date.now() + 60_000 });

		assert.deepEqual(
			editor_state.content_history.map((entry) => entry.content),
			['newer', 'mine', 'v1', 'older']
		);
		assert.strictEqual(editor_state.content_history[1]!.id, editor_state.unsaved_edit_entry_id);
	});

	test('a draft set aside at the history cap stays restorable, whatever entry is shown', async () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';
		for (let i = 2; i <= editor_state.history.max_entries + 5; i++) {
			disk.write(PATH, `v${i}`);
			await flush_reads();
		}
		editor_state.set_content_from_history(editor_state.history.entries[5]!.id);

		editor_state.discard_draft();

		assert.ok(
			editor_state.history.entries.some(
				(entry) => entry.content === 'mine' && entry.is_discarded_edit
			)
		);
	});

	test('a throwaway editing state neither shows nor discards the live draft', () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';
		const stale = new Diskfile({
			app,
			json: { path: PATH, source_dir: SOURCE_DIR, content: 'old' }
		});
		const throwaway = app.diskfiles.get_editor_state(stale);
		assert.notStrictEqual(throwaway, editor_state);

		assert.strictEqual(throwaway.current_content, 'old');
		assert.isFalse(throwaway.content_was_modified_by_user);
		throwaway.discard_draft();
		throwaway.clear_unsaved_edits();

		assert.strictEqual(app.diskfiles.drafts.get(PATH)?.text, 'mine');
		assert.strictEqual(editor_state.current_content, 'mine');
	});

	test('a throwaway editing state on content equal to the live draft leaves the draft', () => {
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'mine';
		const stale = new Diskfile({
			app,
			json: { path: PATH, source_dir: SOURCE_DIR, content: 'mine' }
		});

		const throwaway = app.diskfiles.get_editor_state(stale);

		assert.isFalse(throwaway.content_was_modified_by_user);
		assert.strictEqual(app.diskfiles.drafts.get(PATH)?.text, 'mine');
		assert.strictEqual(editor_state.current_content, 'mine');
	});
});

describe('a draft met by a new editing state', () => {
	test('is dropped when the disk already holds its text', () => {
		app.diskfiles.drafts.create(PATH, 'v1', content_hash('v0'));

		const editor_state = app.diskfiles.get_editor_state(diskfile);

		assert.isFalse(app.diskfiles.drafts.has(PATH));
		assert.strictEqual(editor_state.current_content, 'v1');
		assert.isFalse(editor_state.dirty);
	});

	test('sends its base when the content was seen without a hash', async () => {
		const seeded = app.diskfiles.add({
			path: parse_or_throw(DiskfilePath, '/w/seeded.txt'),
			source_dir: SOURCE_DIR,
			content: 's1'
		});
		app.diskfiles.drafts.create(seeded.path, 'mine', content_hash('s1'));
		const sent: Array<string | null> = [];
		app.diskfiles.update = (_path, content, expected_hash) => {
			sent.push(expected_hash ?? null);
			return Promise.resolve(answer_update(content, { ok: true }));
		};

		const editor_state = app.diskfiles.get_editor_state(seeded);
		assert.isNull(editor_state.last_seen_disk_hash);
		assert.isTrue(await editor_state.save_changes());

		assert.deepEqual(sent, [content_hash('s1')]);
	});

	test('an overwrite sends the hash of the version shown, not the draft base', async () => {
		const seeded = app.diskfiles.add({
			path: parse_or_throw(DiskfilePath, '/w/seeded.txt'),
			source_dir: SOURCE_DIR,
			content: 's1'
		});
		app.diskfiles.drafts.create(seeded.path, 'mine', content_hash('s0'));
		const sent: Array<string | null> = [];
		app.diskfiles.update = (_path, content, expected_hash) => {
			sent.push(expected_hash ?? null);
			return Promise.resolve(answer_update(content, { ok: true }));
		};

		const editor_state = app.diskfiles.get_editor_state(seeded);
		assert.isNull(editor_state.last_seen_disk_hash);
		assert.isTrue(await editor_state.save_changes({ overwrite: true }));

		// the version shown came without a hash, so the overwrite is unchecked
		assert.deepEqual(sent, [null]);
	});
});
