// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, assert } from 'vitest';
import { allow_logged_error, expect_logged_error } from '@fuzdev/fuz_app/testing/logged_errors.ts';
import { DEV as ESM_DEV } from 'esm-env';

import {
	DiskfileDirectoryPath,
	DiskfilePath,
	type SerializableDisknode
} from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import {
	assert_diskfile_index_in_step,
	to_diskfile_index_mismatches
} from '#lib/diskfiles.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	flush_reads,
	install_fake_disk,
	type FakeDisk,
	seed_diskfile
} from './diskfile_test_helpers.ts';

/**
 * `Diskfiles.index` holds exactly the cells on disk — neither
 * `deleted_on_disk` nor `uncovered` — with their roots, sizes, and mtimes,
 * through every write path.
 */

const at = (path: string): DiskfilePath => parse_or_throw(DiskfilePath, path);
const dir = (path: string): DiskfileDirectoryPath => parse_or_throw(DiskfileDirectoryPath, path);
const DEV_ROOT = dir('/dev/');
const REPO = dir('/dev/r/');

let app: Frontend;
let disk: FakeDisk;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, REPO);
	app.projects.add({
		root: DEV_ROOT,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: REPO, state: 'present' }],
		focused: [REPO]
	});
});

/** Checks the invariant, and that the index holds exactly `paths`. */
const assert_index = (paths: Array<string>): void => {
	assert_diskfile_index_in_step(app.diskfiles);
	assert.sameMembers(
		Array.from(app.diskfiles.index.values(), (record) => record.id),
		paths
	);
};

const node = (path: string, mtime = 1, source_dir: string = REPO): SerializableDisknode => ({
	id: at(path),
	source_dir: dir(source_dir),
	size: mtime * 10,
	ctime: 1,
	mtime
});

const delete_change = (path: string): void => {
	app.diskfiles.handle_change({
		change: { type: 'delete', path: at(path) },
		disknode: { id: at(path), source_dir: REPO, size: null, ctime: null, mtime: null }
	});
};

test('the DEV check runs after each write', () => {
	assert.isTrue(ESM_DEV, 'tests run in DEV');
	app.diskfiles.upsert(node('/dev/r/stray.ts'));
	assert.deepEqual(to_diskfile_index_mismatches(app.diskfiles), [], 'a record needs no cell');
	seed_diskfile(app, '/dev/r/stray.ts');
	app.diskfiles.index.set(node('/dev/r/stray.ts', 2));
	assert.deepEqual(to_diskfile_index_mismatches(app.diskfiles), [
		'/dev/r/stray.ts: index has /dev/r/ 20 2, cell has /dev/r/ 10 1'
	]);
	assert.throws(() => app.diskfiles.upsert(node('/dev/r/a.ts')), /out of step/);
});

test('a write that throws surfaces its own error, not the DEV check', () => {
	app.diskfiles.reconcile([node('/dev/r/a.ts')], [REPO]);
	// a cell, so the next reconcile updates it in place
	seed_diskfile(app, '/dev/r/a.ts');
	try {
		// an mtime past what a `Datetime` holds throws mid-write, the index already moved
		app.diskfiles.reconcile([node('/dev/r/a.ts', 1e20, DEV_ROOT)], [REPO]);
	} catch (error) {
		assert(error instanceof Error);
		assert.notInclude(error.message, 'out of step');
		return;
	}
	assert.fail('the write throws');
});

test('the DEV check catches a directory count out of step with the records', () => {
	app.diskfiles.reconcile([node('/dev/r/a.ts'), node('/dev/r/sub/b.ts')], [REPO]);
	assert_index(['/dev/r/a.ts', '/dev/r/sub/b.ts']);
	const counts = app.diskfiles.index.directory_counts as Map<string, number>;
	counts.set('/dev/r/sub/', 5);
	assert.deepEqual(to_diskfile_index_mismatches(app.diskfiles), [
		'/dev/r/sub/: index counts 5 files, records hold 1'
	]);
	counts.set('/dev/r/sub/', 1);
	counts.set('/dev/r/gone/', 1);
	assert.deepEqual(to_diskfile_index_mismatches(app.diskfiles), [
		'/dev/r/gone/: index counts 1 files, records hold none'
	]);
	counts.delete('/dev/r/gone/');
	assert.deepEqual(to_diskfile_index_mismatches(app.diskfiles), []);
});

test('reconcile: adds, changes, prunes, and keeps a held file out of the index', () => {
	allow_logged_error(
		'[diskfiles] reading /dev/r/b.ts failed: failed to read file: No such file or directory',
		"the test's fake disk has no such file, so the read its cell starts fails"
	);
	const records = [node('/dev/r/a.ts'), node('/dev/r/b.ts'), node('/dev/r/sub/c.ts')];
	const before = app.diskfiles.index.membership;
	app.diskfiles.reconcile(records, [REPO]);
	assert.strictEqual(app.diskfiles.index.membership, before + 1, 'one move per snapshot');
	assert.strictEqual(app.diskfiles.index.get(at('/dev/r/a.ts')), records[0], 'kept as given');
	assert_index(['/dev/r/a.ts', '/dev/r/b.ts', '/dev/r/sub/c.ts']);

	app.diskfiles.select(at('/dev/r/b.ts'), true);
	const meta = app.diskfiles.index.meta;
	app.diskfiles.reconcile([node('/dev/r/a.ts', 2), node('/dev/r/d.ts')], [REPO]);
	assert.strictEqual(app.diskfiles.index.meta, meta + 1);
	assert.isTrue(seed_diskfile(app, at('/dev/r/b.ts'))!.deleted_on_disk, 'its tab keeps it');
	assert_index(['/dev/r/a.ts', '/dev/r/d.ts']);

	// a tracked change skips the snapshot's entry and its prune
	const tracker = app.diskfiles.track_changes();
	app.diskfiles.upsert(node('/dev/r/a.ts', 3));
	app.diskfiles.handle_change({
		change: { type: 'change', path: at('/dev/r/a.ts') },
		disknode: node('/dev/r/a.ts', 4)
	});
	tracker.stop();
	app.diskfiles.reconcile([node('/dev/r/d.ts')], [REPO], { changes: tracker });
	assert.strictEqual(app.diskfiles.index.get(at('/dev/r/a.ts'))?.mtime, 4);
	assert_index(['/dev/r/a.ts', '/dev/r/d.ts']);

	// the held file back on disk is reattached
	app.diskfiles.add_initial([node('/dev/r/b.ts', 5)]);
	assert.isFalse(seed_diskfile(app, at('/dev/r/b.ts'))!.deleted_on_disk);
	assert_index(['/dev/r/a.ts', '/dev/r/b.ts', '/dev/r/d.ts']);
});

test('upsert and filer deletes: unheld forgotten, held kept off the index', async () => {
	await disk.load('/dev/r/a.ts', 'a');
	const b = await disk.load('/dev/r/b.ts', 'b');
	assert_index(['/dev/r/a.ts', '/dev/r/b.ts']);

	disk.write('/dev/r/a.ts', 'a2');
	await flush_reads();
	assert.strictEqual(app.diskfiles.index.get(at('/dev/r/a.ts'))?.size, 2);
	assert_index(['/dev/r/a.ts', '/dev/r/b.ts']);

	// a root change moves it between filers' counts
	app.diskfiles.upsert(node('/dev/r/a.ts', 9, DEV_ROOT));
	assert.strictEqual(app.diskfiles.index.get(at('/dev/r/a.ts'))?.source_dir, DEV_ROOT);
	assert_index(['/dev/r/a.ts', '/dev/r/b.ts']);

	delete_change('/dev/r/a.ts');
	assert.isUndefined(seed_diskfile(app, at('/dev/r/a.ts')));
	assert_index(['/dev/r/b.ts']);

	app.diskfiles.select(b.path, true);
	delete_change('/dev/r/b.ts');
	assert.isTrue(b.deleted_on_disk);
	assert_index([]);

	// closing its tab forgets it
	app.diskfiles.editor.close_tab(app.diskfiles.editor.tabs.selected_tab!.id);
	assert.isUndefined(seed_diskfile(app, b.path));
	assert_index([]);
});

test('release_uncovered: a dropped repo uncovers a held file, an unfocused one keeps it', async () => {
	const held = await disk.load('/dev/r/held.ts', 'h');
	await disk.load('/dev/r/loose.ts', 'l');
	app.diskfiles.select(held.path, true);
	assert_index(['/dev/r/held.ts', '/dev/r/loose.ts']);

	// unfocused: the held file stays as it was, so in the index
	app.projects.add({
		root: DEV_ROOT,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: REPO, state: 'present' }],
		focused: []
	});
	app.diskfiles.release_uncovered([REPO]);
	assert.isFalse(held.uncovered);
	assert_index(['/dev/r/held.ts']);

	// dropped: uncovered, out of the index
	app.projects.add({ root: DEV_ROOT, kind: 'registry', entries: [], focused: [] });
	app.diskfiles.release_uncovered([REPO]);
	assert.isTrue(held.uncovered);
	assert_index([]);

	// reported again: back
	app.projects.add({
		root: DEV_ROOT,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: REPO, state: 'present' }],
		focused: [REPO]
	});
	app.diskfiles.upsert(disk.disknode('/dev/r/held.ts'));
	assert.isFalse(held.uncovered);
	assert_index(['/dev/r/held.ts']);
});

test('settle_recreated, the flag setters, a direct remove, and a decoded reset', async () => {
	allow_logged_error(
		'registry already has a different cell instance',
		'the test builds a second cell with an id already registered'
	);
	expect_logged_error('a diskfile is already at /dev/r/a.ts');
	expect_logged_error('cell not found in registry');
	const a = await disk.load('/dev/r/a.ts', 'a');
	app.diskfiles.select(a.path, true);
	delete_change('/dev/r/a.ts');
	assert_index([]);

	app.diskfiles.settle_recreated(a);
	assert.isFalse(a.deleted_on_disk);
	assert.isFalse(a.uncovered, 'indexed here, its add on the way');
	assert_index(['/dev/r/a.ts']);

	app.diskfiles.set_uncovered(a, true);
	assert_index([]);
	app.diskfiles.set_uncovered(a, false);
	assert_index(['/dev/r/a.ts']);
	app.diskfiles.set_deleted_on_disk(a, true);
	assert_index([]);
	app.diskfiles.set_deleted_on_disk(a, false);
	assert_index(['/dev/r/a.ts']);

	app.diskfiles.upsert(node('/dev/r/b.ts'));
	app.diskfiles.remove_by_path('/dev/r/b.ts');
	assert_index(['/dev/r/a.ts']);

	// a stale copy of a's json is refused, and can't drop the file that's there
	app.diskfiles.add(a.to_json());
	assert_index(['/dev/r/a.ts']);

	app.diskfiles.set_json({
		diskfiles: [{ path: at('/dev/r/c.ts'), source_dir: REPO, size: 3, mtime: 3 }]
	});
	assert_index(['/dev/r/c.ts']);
});

test('on_disk, listed, listed_count, and has_path follow the records and the held cells', () => {
	app.diskfiles.add_initial([node('/dev/r/a.ts'), node('/dev/r/b.ts')]);
	app.diskfiles.select(at('/dev/r/b.ts'), true); // a tab holds it
	app.diskfiles.remove_by_path('/dev/r/b.ts');
	assert.deepEqual(
		app.diskfiles.on_disk.map((record) => record.id),
		['/dev/r/a.ts']
	);
	assert.deepEqual(
		app.diskfiles.listed.map((record) => record.id),
		['/dev/r/a.ts', '/dev/r/b.ts']
	);
	assert.strictEqual(app.diskfiles.listed_count, 2);
	assert.ok(app.diskfiles.has_path('/dev/r/a.ts'));
	assert.ok(app.diskfiles.has_path('/dev/r/b.ts'), 'a held file is known though off disk');
	assert.ok(!app.diskfiles.has_path('/dev/r/c.ts'));
	assert.strictEqual(app.diskfiles.index.watch_count, 0, 'no reader, no watch');
});

test('to_transcript_candidate_paths looks among the folder’s files on disk', () => {
	app.diskfiles.add_initial([
		node('/dev/r/rec.webm'),
		node('/dev/r/rec.webm.base.transcript.json'),
		node('/dev/r/rec.webm.notes.txt'),
		node('/dev/r/other.webm.base.transcript.json'),
		node('/dev/r/sub/rec.webm.base.transcript.json')
	]);
	assert.deepEqual(app.diskfiles.to_transcript_candidate_paths('/dev/r/rec.webm'), [
		'/dev/r/rec.webm.base.transcript.json'
	]);
	app.diskfiles.remove_by_path('/dev/r/rec.webm.base.transcript.json');
	assert.deepEqual(app.diskfiles.to_transcript_candidate_paths('/dev/r/rec.webm'), []);
});
