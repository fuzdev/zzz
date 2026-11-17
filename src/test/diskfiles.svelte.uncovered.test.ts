import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';

import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import { to_diskfile_status } from '#lib/diskfile_helpers.ts';
import { SAVE_ERROR_RECREATES } from '#lib/diskfile_editor_state.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	flush_reads,
	install_fake_disk,
	type FakeDisk,
	seed_diskfile
} from './diskfile_test_helpers.ts';

/**
 * A file kept for a draft or a tab after it left the index without being
 * seen deleted (`Diskfile.uncovered`) may still be on disk, so a save checks
 * the version it was based on, and nothing marks it deleted. A file kept
 * deleted on disk (`Diskfile.deleted_on_disk`) may be there after all, so
 * its save is an exclusive create: neither ever writes blind.
 */

const at = (path: string): DiskfilePath => parse_or_throw(DiskfilePath, path);
const dir = (path: string): DiskfileDirectoryPath => parse_or_throw(DiskfileDirectoryPath, path);
const DEV = dir('/dev/');
const WS = dir('/ws/');

let app: Frontend;
let disk: FakeDisk;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, DEV);
	// save through the fake disk
	delete (app.diskfiles as unknown as { update?: unknown }).update;
});

const add_registry_with_repo = (): void => {
	app.projects.add({
		root: DEV,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: dir('/dev/r/'), state: 'present' }],
		focused: [dir('/dev/r/')]
	});
};

/** The registry's repo stays present but is unfocused; its held files are kept unflagged. */
const unfocus_repo = (): void => {
	app.projects.add({
		root: DEV,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: dir('/dev/r/'), state: 'present' }],
		focused: []
	});
	app.diskfiles.release_uncovered([dir('/dev/r/')]);
};

/** The registry's repo leaves `repos.toml`; its directory stays on disk, under the root's scope. */
const drop_repo = (): void => {
	app.projects.add({ root: DEV, kind: 'registry', entries: [], focused: [] });
	app.diskfiles.release_uncovered([dir('/dev/r/')]);
};

test('a repo dropped from the registry keeps its tab-only file uncovered, not deleted', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	app.diskfiles.select(x.path, true);
	const es = app.diskfiles.get_editor_state(x);

	drop_repo();

	assert.strictEqual(seed_diskfile(app, x.path), x, 'its tab keeps it');
	assert.isTrue(x.uncovered);
	assert.isFalse(x.deleted_on_disk);
	assert.isFalse(es.can_save, 'nothing to write without an edit');
	assert.include(
		app.diskfiles.listed.map((r) => r.id),
		x.path
	);
	assert.include(app.diskfiles.listed_unindexed, x);
	assert.notInclude(
		app.diskfiles.on_disk.map((r) => r.id),
		x.path
	);
	assert.deepEqual(to_diskfile_status(app.diskfiles, x.path), {
		deleted: false,
		uncovered: true,
		dirty: false,
		conflict: false
	});
	assert.isFalse(app.diskfiles.open_path(x.path), 'not a file the index has');
});

test('saving an uncovered file after an external edit is refused, not an overwrite', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	app.diskfiles.select(x.path, true);
	const es = app.diskfiles.get_editor_state(x);
	const base_hash = es.last_seen_disk_hash;
	assert.ok(base_hash);

	drop_repo();
	// edited outside zzz meanwhile, unwatched
	disk.files.set('/dev/r/x.ts', 'v2 from elsewhere');
	es.current_content = 'mine';
	assert.isTrue(es.can_save);

	assert.isFalse(await es.save_changes());
	const update = disk.updates.at(-1);
	assert.ok(update);
	assert.strictEqual(
		update.expected_hash,
		base_hash,
		'the save checks the version it was based on'
	);
	assert.strictEqual(disk.files.get('/dev/r/x.ts'), 'v2 from elsewhere', 'not overwritten');
	// the refusal reads the file again, so the change lands as a conflict
	assert.isTrue(es.has_conflict);
	assert.strictEqual(es.current_content, 'mine', 'the edit is kept');
	assert.isTrue(x.uncovered);
});

test('saving an uncovered file with no external edit writes, checked', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	app.diskfiles.select(x.path, true);
	const es = app.diskfiles.get_editor_state(x);

	drop_repo();
	es.current_content = 'mine';

	assert.isTrue(await es.save_changes());
	assert.ok(disk.updates.at(-1)?.expected_hash);
	assert.strictEqual(disk.files.get('/dev/r/x.ts'), 'mine');
	assert.isTrue(x.uncovered, 'still out of the index');
});

test('a nested project closed under an open registry keeps its file uncovered, saves checked', async () => {
	app.projects.add({ root: DEV, kind: 'registry', entries: [], focused: [] });
	app.projects.add({ root: dir('/dev/foo/') });
	const x = await disk.load('/dev/foo/x.ts', 'v1');
	app.diskfiles.select(x.path, true);
	const es = app.diskfiles.get_editor_state(x);

	app.projects.remove_by_root(dir('/dev/foo/'));

	assert.isTrue(x.uncovered);
	assert.isFalse(x.deleted_on_disk);
	disk.files.set('/dev/foo/x.ts', 'v2');
	assert.isFalse(es.can_save, 'no edit, nothing forced');
	es.current_content = 'mine';
	assert.isFalse(await es.save_changes());
	assert.ok(disk.updates.at(-1)?.expected_hash);
	assert.strictEqual(disk.files.get('/dev/foo/x.ts'), 'v2');
});

test('saving an uncovered file out of scope surfaces path_not_allowed', async () => {
	app.projects.add({ root: WS });
	const a = await disk.load('/ws/a.txt', 'a');
	app.diskfiles.select(a.path, true);
	const es = app.diskfiles.get_editor_state(a);
	app.projects.remove_by_root(WS);
	assert.isTrue(a.uncovered);
	const sent: Array<string | null | undefined> = [];
	(app.diskfiles as unknown as { update: unknown }).update = (
		_path: string,
		_content: string,
		expected_hash?: string | null
	) => {
		sent.push(expected_hash);
		return Promise.resolve({
			ok: false,
			error: {
				code: -32002,
				message: 'path not allowed: /ws/a.txt',
				data: { reason: 'path_not_allowed' }
			}
		});
	};
	es.current_content = 'mine';

	assert.isFalse(await es.save_changes());
	assert.include(es.save_error ?? '', 'not allowed');
	assert.ok(sent[0], 'sent its base');
	assert.isTrue(a.uncovered);
	assert.isFalse(a.deleted_on_disk);
});

test('reopening the project reattaches the uncovered file, clearing the flag', async () => {
	app.projects.add({ root: WS });
	const a = await disk.load('/ws/a.txt', 'a');
	app.diskfiles.select(a.path, true);
	app.projects.remove_by_root(WS);
	assert.isTrue(a.uncovered);

	app.projects.add({ root: WS });
	app.diskfiles.add_initial([disk.disknode('/ws/a.txt')]);
	await flush_reads();

	assert.strictEqual(seed_diskfile(app, at('/ws/a.txt')), a);
	assert.isFalse(a.uncovered);
	assert.include(
		app.diskfiles.on_disk.map((r) => r.id),
		a.path
	);
	assert.notInclude(app.diskfiles.listed_unindexed, a);
});

test('closing the last tab of an uncovered file forgets it', async () => {
	app.projects.add({ root: WS });
	const a = await disk.load('/ws/a.txt', 'a');
	app.diskfiles.select(a.path, true);
	app.projects.remove_by_root(WS);
	assert.isTrue(a.uncovered);

	app.diskfiles.editor.tabs.close_all_tabs();

	assert.isUndefined(seed_diskfile(app, at('/ws/a.txt')));
});

test('a resync after the repo left the registry keeps the file uncovered, not deleted', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	const readme = await disk.load('/dev/README.md', 'readme');
	app.diskfiles.select(x.path, true);
	drop_repo();

	// the snapshot covers the registry root's loose files, not the dropped repo
	app.diskfiles.reconcile([disk.disknode('/dev/README.md')], [DEV]);

	assert.strictEqual(seed_diskfile(app, x.path), x);
	assert.isTrue(x.uncovered, "the snapshot doesn't look there, so it says nothing of it");
	assert.isFalse(x.deleted_on_disk);
	assert.strictEqual(seed_diskfile(app, readme.path), readme);
});

test('a resync pruning a file the index covers still flags it deleted', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	app.diskfiles.select(x.path, true);

	app.diskfiles.reconcile([], [dir('/dev/r/')]);

	assert.isTrue(x.deleted_on_disk);
	assert.isFalse(x.uncovered);
});

test('a delete reported for an uncovered file flags it deleted instead', async () => {
	app.projects.add({ root: WS });
	const a = await disk.load('/ws/a.txt', 'a');
	app.diskfiles.select(a.path, true);
	app.projects.remove_by_root(WS);

	app.diskfiles.remove_by_path('/ws/a.txt');

	assert.isTrue(a.deleted_on_disk);
	assert.isFalse(a.uncovered, 'never both');
	assert.include(app.diskfiles.listed_unindexed, a);
});

test('a tab-only file with no editing state, deleted then re-added, is read again', async () => {
	app.projects.add({ root: WS });
	const a = await disk.load('/ws/a.txt', 'old');
	// a tab with no editing state (no view rendered)
	app.diskfiles.editor.tabs.open_diskfile(a.path);
	assert.isUndefined(app.diskfiles.find_editor_state(a.path));
	disk.files.delete('/ws/a.txt');
	app.diskfiles.remove_by_path('/ws/a.txt');
	assert.strictEqual(seed_diskfile(app, at('/ws/a.txt')), a);
	const reads_before = disk.reads.length;

	disk.write('/ws/a.txt', 'new', 'add');
	await flush_reads();

	assert.isAbove(disk.reads.length, reads_before, 'read again eagerly, for its tab');
	assert.strictEqual(a.content, 'new');
});

test('a repo whose entry went missing keeps its held file uncovered, and a re-clone is not clobbered', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	app.diskfiles.select(x.path, true);
	const es = app.diskfiles.get_editor_state(x);

	// the directory goes away: its entry missing, its focus dropped
	app.projects.add({
		root: DEV,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: dir('/dev/r/'), state: 'missing' }],
		focused: []
	});
	app.diskfiles.release_uncovered([dir('/dev/r/')]);
	assert.isTrue(x.uncovered, 'out of the index, not seen deleted');
	assert.isFalse(x.deleted_on_disk);
	assert.isFalse(es.can_save, 'no forced save to recreate a stray repo dir');

	// re-cloned, unwatched
	disk.files.set('/dev/r/x.ts', 'v9 re-cloned');
	es.current_content = 'mine';
	assert.isFalse(await es.save_changes());
	assert.strictEqual(disk.files.get('/dev/r/x.ts'), 'v9 re-cloned', 'not clobbered');
	assert.isTrue(es.has_conflict);
});

describe('saving a file deleted on disk is an exclusive create', () => {
	test('a delete reported for a file still on disk (a re-prune) is not overwritten', async () => {
		add_registry_with_repo();
		const x = await disk.load('/dev/r/x.log', 'v1');
		app.diskfiles.select(x.path, true);
		const es = app.diskfiles.get_editor_state(x);
		// a re-prune drops the now-ignored path: a `delete`, the file still on disk
		app.diskfiles.handle_change({
			change: { type: 'delete', path: x.path },
			disknode: disk.disknode('/dev/r/x.log')
		});
		assert.isTrue(x.deleted_on_disk);
		disk.files.set('/dev/r/x.log', 'v2 written by the tool, unwatched now');
		assert.isTrue(es.can_save);

		assert.isFalse(await es.save_changes());
		assert.deepEqual(disk.updates, [], 'never an update');
		assert.strictEqual(disk.creates.length, 1);
		assert.strictEqual(disk.files.get('/dev/r/x.log'), 'v2 written by the tool, unwatched now');
		assert.isFalse(x.deleted_on_disk);
		assert.isTrue(x.uncovered, "it's there, but nothing indexes it");
		// read again: a clean editor moves to the disk version
		assert.strictEqual(es.current_content, 'v2 written by the tool, unwatched now');
		assert.strictEqual(es.save_error, 'not saved — the file is on disk again, shown now');
		assert.isFalse(es.can_save);
	});

	test('a file recreated unwatched after its project closed is not overwritten', async () => {
		app.projects.add({ root: WS });
		const a = await disk.load('/ws/a.txt', 'a');
		app.diskfiles.select(a.path, true);
		const es = app.diskfiles.get_editor_state(a);
		es.current_content = 'mine';
		disk.files.delete('/ws/a.txt');
		app.diskfiles.remove_by_path('/ws/a.txt');
		app.projects.remove_by_root(WS);
		assert.isTrue(a.deleted_on_disk);
		// recreated by another tool; no project watches it, so no add arrives
		disk.files.set('/ws/a.txt', 'someone else');

		assert.isFalse(await es.save_changes());
		assert.strictEqual(disk.files.get('/ws/a.txt'), 'someone else', 'not clobbered');
		assert.isTrue(a.uncovered);
		assert.isTrue(es.has_conflict, 'shown as a conflict under the draft');
		assert.isNull(es.save_error, "the conflict's notice says why");

		// overwriting is now checked against the version shown
		assert.isTrue(await es.save_changes({ overwrite: true }));
		const update = disk.updates.at(-1);
		assert.ok(update?.expected_hash, 'an update with its base');
		assert.strictEqual(disk.files.get('/ws/a.txt'), 'mine');
	});

	test('a file truly gone is recreated', async () => {
		app.projects.add({ root: WS });
		const a = await disk.load('/ws/a.txt', 'a');
		app.diskfiles.select(a.path, true);
		const es = app.diskfiles.get_editor_state(a);
		es.current_content = 'mine';
		disk.files.delete('/ws/a.txt');
		app.diskfiles.remove_by_path('/ws/a.txt');

		assert.isTrue(await es.save_changes());
		assert.deepEqual(disk.creates, [{ path: '/ws/a.txt', content: 'mine' }]);
		assert.deepEqual(disk.updates, []);
		assert.strictEqual(disk.files.get('/ws/a.txt'), 'mine');
		assert.isFalse(a.deleted_on_disk);
		assert.isFalse(a.uncovered, 'its project indexes it: its add is on the way');
		assert.isNull(es.save_error);
	});

	test('an uncovered file truly gone is flagged deleted by the refused save, then recreated', async () => {
		add_registry_with_repo();
		const x = await disk.load('/dev/r/x.ts', 'v1');
		app.diskfiles.select(x.path, true);
		const es = app.diskfiles.get_editor_state(x);
		drop_repo();
		disk.files.delete('/dev/r/x.ts');
		es.current_content = 'mine';

		assert.isFalse(await es.save_changes(), 'the update finds it gone');
		assert.strictEqual(es.save_error, SAVE_ERROR_RECREATES);
		assert.isTrue(x.deleted_on_disk);
		assert.isFalse(x.uncovered);

		assert.isTrue(await es.save_changes());
		assert.deepEqual(disk.creates, [{ path: '/dev/r/x.ts', content: 'mine' }]);
		assert.strictEqual(disk.files.get('/dev/r/x.ts'), 'mine');
		assert.isFalse(x.deleted_on_disk);
		assert.isTrue(x.uncovered, 'its repo is still out of the registry');
	});

	test('a recreated file in an unfocused repo stays unflagged, then uncovered once its entry leaves', async () => {
		add_registry_with_repo();
		const x = await disk.load('/dev/r/x.ts', 'v1');
		app.diskfiles.select(x.path, true);
		const es = app.diskfiles.get_editor_state(x);
		es.current_content = 'mine';
		disk.files.delete('/dev/r/x.ts');
		app.diskfiles.remove_by_path('/dev/r/x.ts');
		unfocus_repo();
		assert.isTrue(app.diskfiles.is_in_unfocused_repo(x.path));

		assert.isTrue(await es.save_changes());
		await flush_reads();
		assert.strictEqual(disk.files.get('/dev/r/x.ts'), 'mine');
		assert.isFalse(x.deleted_on_disk);
		assert.isFalse(x.uncovered, 'kept as an unfocused repo keeps its held files');

		drop_repo();
		assert.isTrue(x.uncovered);
	});

	test('a recreated file the index skips by rule is flagged uncovered', async () => {
		app.projects.add({ root: WS });
		const p = '/ws/node_modules/a.js';
		assert.isNotNull(app.diskfiles.to_unindexed(p));
		const a = await disk.load(p, 'v1');
		app.diskfiles.select(a.path, true);
		const es = app.diskfiles.get_editor_state(a);
		es.current_content = 'mine';
		disk.files.delete(p);
		app.diskfiles.remove_by_path(p);

		assert.isTrue(await es.save_changes());
		assert.strictEqual(disk.files.get(p), 'mine');
		assert.isFalse(a.deleted_on_disk);
		assert.isTrue(a.uncovered, 'no add will come for an ignored path');
	});
});

test('a held file in an unfocused repo found deleted by a refused save is flagged deleted, then recreated', async () => {
	add_registry_with_repo();
	const x = await disk.load('/dev/r/x.ts', 'v1');
	app.diskfiles.select(x.path, true);
	const es = app.diskfiles.get_editor_state(x);
	es.current_content = 'mine';
	unfocus_repo();
	assert.isFalse(x.uncovered);
	// no delete will arrive: nothing watches an unfocused repo
	disk.files.delete('/dev/r/x.ts');

	assert.isFalse(await es.save_changes(), 'the update finds it gone');
	assert.strictEqual(es.save_error, SAVE_ERROR_RECREATES);
	assert.isTrue(x.deleted_on_disk);

	assert.isTrue(await es.save_changes(), 'no refocus needed');
	assert.deepEqual(disk.creates, [{ path: '/dev/r/x.ts', content: 'mine' }]);
	assert.strictEqual(disk.files.get('/dev/r/x.ts'), 'mine');
	assert.isFalse(x.deleted_on_disk);
});

test('a link to an uncovered file resolves as missing', async () => {
	app.projects.add({ root: WS });
	const a = await disk.load('/ws/a.txt', 'a');
	app.diskfiles.select(a.path, true);
	assert.isTrue(app.diskfiles.link_index.has_file('/ws/a.txt'));

	app.projects.remove_by_root(WS);

	assert.isTrue(a.uncovered);
	assert.strictEqual(seed_diskfile(app, at('/ws/a.txt')), a, 'kept for its tab');
	assert.isFalse(app.diskfiles.link_index.has_file('/ws/a.txt'));
});
