// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, assert, describe } from 'vitest';
import { allow_logged_error } from '@fuzdev/fuz_app/testing/logged_errors.ts';
import { flushSync } from 'svelte';

import {
	DiskfileDirectoryPath,
	DiskfilePath,
	type SerializableDisknode
} from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import type { DiskfileEditorState } from '#lib/diskfile_editor_state.svelte.ts';
import { Part } from '#lib/part.svelte.ts';
import { to_diskfile_index_mismatches } from '#lib/diskfiles.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';
import { read_in_derived, run_in_effect } from './reactive_test_helpers.svelte.ts';

/**
 * What holds a file's cell (`Diskfiles.acquire`): tabs, parts, views, and
 * copies in flight. A hold is by path and keeps the cell's content current;
 * only a draft or a tab keeps a file the index no longer has.
 */

const at = (path: string): DiskfilePath => parse_or_throw(DiskfilePath, path);
const dir = (path: string): DiskfileDirectoryPath => parse_or_throw(DiskfileDirectoryPath, path);
const DEV = dir('/dev/');

let app: Frontend;
let disk: FakeDisk;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, DEV);
	delete (app.diskfiles as unknown as { update?: unknown }).update;
});

const microtask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

const registry = (focused: boolean): void => {
	app.projects.add({
		root: DEV,
		kind: 'registry',
		entries: [{ key: 'r', kind: 'repo', dir: dir('/dev/r/'), state: 'present' }],
		focused: focused ? [dir('/dev/r/')] : []
	});
};

test('acquire returns the cell, holds by path, and release lets go once', () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	const a = {};
	const b = {};
	assert.strictEqual(diskfiles.acquire(x.path, a), x);
	diskfiles.acquire(x.path, a);
	diskfiles.acquire(x.path, b);
	diskfiles.release(x.path, a);
	assert.isTrue(diskfiles.is_acquired(x.path), 'b still holds it');
	diskfiles.release(x.path, a);
	diskfiles.release(x.path, b);
	assert.isFalse(diskfiles.is_acquired(x.path));
	assert.isUndefined(diskfiles.acquire(at('/dev/r/none.ts'), a), 'no cell, held anyway');
	assert.isTrue(diskfiles.is_acquired(at('/dev/r/none.ts')));
});

test('a hold outlives the cell and holds the next one at the path', async () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	const release = diskfiles.hold(x.path);
	diskfiles.remove_by_path(x.path);
	assert.isUndefined(diskfiles.peek(x.path), 'a hold alone keeps no deleted file');
	const next = disk.write('/dev/r/x.ts', 'v2');
	await microtask();
	assert.strictEqual(next.content_status, 'loading', 'held, so read on arrival');
	release();
	assert.isFalse(diskfiles.is_acquired(x.path));
});

test('a tab holds its file, moves its hold when a preview is reused, and lets go on close', () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	const y = disk.write('/dev/r/y.ts', 'v1');
	diskfiles.select(x.path);
	assert.isTrue(diskfiles.is_acquired(x.path));
	diskfiles.select(y.path); // the preview tab now shows `y`
	assert.isFalse(diskfiles.is_acquired(x.path));
	assert.isTrue(diskfiles.is_acquired(y.path));
	diskfiles.editor.tabs.close_all_tabs();
	assert.isFalse(diskfiles.is_acquired(y.path));
});

test('a part holds its file, moves its hold with its path, and lets go on dispose', () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	const y = disk.write('/dev/r/y.ts', 'v1');
	const part = Part.create(app, { type: 'diskfile', path: x.path });
	assert.isTrue(diskfiles.is_acquired(x.path));
	part.path = y.path;
	assert.isFalse(diskfiles.is_acquired(x.path));
	assert.isTrue(diskfiles.is_acquired(y.path));
	part.dispose();
	assert.isFalse(diskfiles.is_acquired(y.path));
});

test('letting go and holding again in one turn, as an effect re-running does, releases nothing', async () => {
	const { diskfiles } = app;
	registry(true);
	const x = await disk.load('/dev/r/x.ts', 'v1');
	const es = diskfiles.get_editor_state(x);
	es.current_content = 'mine';
	const release = diskfiles.hold(x.path);
	registry(false);
	diskfiles.release_uncovered([dir('/dev/r/')]);
	es.current_content = 'v1'; // the draft is gone: nothing keeps it now
	release();
	const release_again = diskfiles.hold(x.path);
	await microtask();
	assert.strictEqual(diskfiles.peek(x.path), x, 'still held, so not released');
	release_again();
	await microtask();
	assert.isUndefined(diskfiles.peek(x.path), 'released once nothing holds it');
});

test('a file in an unfocused repo whose draft is saved is released when its part lets go', async () => {
	const { diskfiles } = app;
	registry(true);
	const x = await disk.load('/dev/r/x.ts', 'v1');
	const part = Part.create(app, { type: 'diskfile', path: x.path });
	const es = diskfiles.get_editor_state(x);
	es.current_content = 'mine';
	registry(false);
	diskfiles.release_uncovered([dir('/dev/r/')]);
	assert.strictEqual(diskfiles.peek(x.path), x, 'its draft keeps it');
	assert.isTrue(await es.save_changes());
	assert.strictEqual(diskfiles.peek(x.path), x, 'its part still holds it');
	part.dispose();
	await microtask();
	assert.isUndefined(diskfiles.peek(x.path), 'nothing keeps it, so it no longer lingers');
});

test('copying content holds the file while it reads', async () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	const loading = diskfiles.load_content(x);
	assert.isTrue(diskfiles.is_acquired(x.path));
	assert.strictEqual(await loading, 'v1');
	assert.isFalse(diskfiles.is_acquired(x.path));
});

test('get_by_path returns the index record, not a kept cell', () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	assert.strictEqual(diskfiles.get_by_path(x.path)?.id, x.path);
	diskfiles.select(x.path, true);
	diskfiles.remove_by_path(x.path);
	assert.strictEqual(diskfiles.peek(x.path), x, 'its tab keeps it');
	assert.isUndefined(diskfiles.get_by_path(x.path));
});

test('get_editor_state_at creates the editing state, which keeps the cell', () => {
	const { diskfiles } = app;
	const x = disk.write('/dev/r/x.ts', 'v1');
	const es = diskfiles.get_editor_state_at(x.path);
	assert.strictEqual(es?.diskfile, x);
	assert.strictEqual(diskfiles.find_editor_state(x.path), es);
	assert.isFalse(diskfiles.is_acquired(x.path), 'its hold was only for the lookup');
	assert.isUndefined(diskfiles.get_editor_state_at(at('/dev/r/none.ts')));
});

// cells on demand: a file is its index record until something needs a cell

const record = (path: string): SerializableDisknode => ({
	id: at(path),
	source_dir: DEV,
	size: 1,
	ctime: 1,
	mtime: 1
});

test('a snapshot makes records, not cells', () => {
	const { diskfiles } = app;
	diskfiles.add_initial([record('/dev/r/a.ts'), record('/dev/r/b.ts')]);
	assert.strictEqual(diskfiles.index.size, 2);
	assert.strictEqual(diskfiles.cells.size, 0);
	assert.isUndefined(diskfiles.peek(at('/dev/r/a.ts')));
	assert.isTrue(diskfiles.has_path('/dev/r/a.ts'));
});

test('acquire makes a cell from the record, and the last release drops it, keeping the record', async () => {
	const { diskfiles } = app;
	diskfiles.add_initial([record('/dev/r/a.ts')]);
	const holder = {};
	const a = diskfiles.acquire(at('/dev/r/a.ts'), holder);
	assert.ok(a);
	assert.strictEqual(a.size, 1);
	assert.strictEqual(diskfiles.peek(a.path), a);
	diskfiles.release(a.path, holder);
	assert.strictEqual(diskfiles.peek(a.path), a, 'dropped in a microtask, not at once');
	await microtask();
	assert.isUndefined(diskfiles.peek(a.path));
	assert.isTrue(diskfiles.index.has(a.path), 'its record stays');
	assert.deepEqual(to_diskfile_index_mismatches(diskfiles), []);
	const again = diskfiles.acquire(a.path, holder);
	assert.ok(again && again !== a, 'a fresh cell next time');
});

test('a clean editing state is dropped with its cell after the last release', async () => {
	const { diskfiles } = app;
	diskfiles.add_initial([record('/dev/r/a.ts')]);
	const es = diskfiles.get_editor_state_at(at('/dev/r/a.ts'));
	assert.ok(es);
	await microtask();
	assert.isUndefined(diskfiles.peek(at('/dev/r/a.ts')));
	assert.isUndefined(diskfiles.find_editor_state(at('/dev/r/a.ts')));
	assert.ok(diskfiles.get_by_path(at('/dev/r/a.ts')), 'its record stays');
});

describe('an editing state with something to keep keeps its cell after the last release', () => {
	const PATH = '/dev/r/a.ts';

	/** Loads `PATH` and holds it, returning its editing state and the release. */
	const setup = async () => {
		const a = await disk.load(PATH, 'v1');
		const release = app.diskfiles.hold(a.path);
		const es = app.diskfiles.get_editor_state(a);
		return { a, es, release };
	};

	const assert_kept = async (
		a: Diskfile,
		es: DiskfileEditorState,
		release: () => void
	): Promise<void> => {
		release();
		await microtask();
		assert.strictEqual(app.diskfiles.peek(a.path), a);
		assert.strictEqual(app.diskfiles.find_editor_state(a.path), es);
	};

	test('a draft', async () => {
		const { a, es, release } = await setup();
		es.current_content = 'mine';
		await assert_kept(a, es, release);
	});

	test('a discarded edit', async () => {
		const { a, es, release } = await setup();
		es.current_content = 'mine';
		es.discard_draft();
		await assert_kept(a, es, release);
	});

	test('a picked older entry shown', async () => {
		const { a, es, release } = await setup();
		const older = es.history.add_entry('older', { created: 1 });
		es.set_content_from_history(older.id);
		await assert_kept(a, es, release);
	});

	test('not a markdown view mode chosen, which outlives it by path', async () => {
		const { a, es, release } = await setup();
		app.diskfiles.markdown_view_modes.set(a.path, 'preview');
		release();
		await microtask();
		assert.isUndefined(app.diskfiles.find_editor_state(a.path), 'dropped');

		const next = app.diskfiles.get_editor_state_at(a.path);
		assert.ok(next);
		assert.notStrictEqual(next, es);
		assert.strictEqual(next.markdown_view_mode_choice, 'preview');
	});

	test('a fragment to reveal', async () => {
		const { a, es, release } = await setup();
		es.markdown_pending_fragment = 'heading';
		await assert_kept(a, es, release);
	});

	test('a save in flight, even with the editor typed back to the disk content', async () => {
		const { a, es, release } = await setup();
		const release_updates = disk.hold_updates();
		es.current_content = 'mine';
		const saving = es.save_changes();
		es.current_content = 'v1';
		assert.isFalse(es.dirty);
		await assert_kept(a, es, release);
		release_updates();
		assert.isTrue(await saving);
	});

	test('a save waiting on a read, even with the editor typed back to the disk content', async () => {
		const { a, es, release } = await setup();
		es.current_content = 'mine';
		const release_reads = disk.hold_reads();
		disk.write(a.path, 'v1, touched'); // reported — the save waits for its read
		const saving = es.save_changes();
		assert.isTrue(es.save_pending);
		es.current_content = 'v1';
		assert.isFalse(es.dirty);
		await assert_kept(a, es, release);
		release_reads();
		await saving;
	});

	test('a save in flight, then dropped once it lands and the file is let go again', async () => {
		const { a, es, release } = await setup();
		const release_updates = disk.hold_updates();
		es.current_content = 'mine';
		const saving = es.save_changes();
		await assert_kept(a, es, release);

		release_updates();
		assert.isTrue(await saving);
		assert.isFalse(es.can_drop, "the disk isn't known to hold it until its broadcast");
		disk.write(a.path, 'mine');
		await flush_reads();
		assert.isTrue(es.can_drop, 'clean once saved');
		assert.strictEqual(app.diskfiles.find_editor_state(a.path), es, 'until the next let-go');
		app.diskfiles.hold(a.path)();
		await microtask();
		assert.isUndefined(app.diskfiles.find_editor_state(a.path));
	});
});

test('a file arriving at a held path gets a cell and is read; any other stays a record', async () => {
	allow_logged_error(
		'[diskfiles] reading /dev/r/a.ts failed: failed to read file: No such file or directory',
		"the test's fake disk has no such file, so the read its cell starts fails"
	);
	const { diskfiles } = app;
	diskfiles.hold(at('/dev/r/a.ts'));
	diskfiles.upsert(record('/dev/r/a.ts'));
	diskfiles.upsert(record('/dev/r/b.ts'));
	assert.strictEqual(diskfiles.peek(at('/dev/r/a.ts'))?.content_status, 'loading');
	assert.isUndefined(diskfiles.peek(at('/dev/r/b.ts')));
	await flush_reads();
	assert.deepEqual(disk.reads, ['/dev/r/a.ts']);
});

test('a tab makes its file a cell, and closing it drops the cell', async () => {
	const { diskfiles } = app;
	diskfiles.add_initial([record('/dev/r/a.ts')]);
	diskfiles.select(at('/dev/r/a.ts'), true);
	const a = diskfiles.selected_file;
	assert.ok(a);
	assert.strictEqual(diskfiles.editor.tabs.selected_tab?.diskfile, a);
	diskfiles.editor.tabs.close_all_tabs();
	await microtask();
	assert.isUndefined(diskfiles.peek(a.path));
});

test('a reader of peek sees the cell an effect’s hold makes', () => {
	const { diskfiles } = app;
	diskfiles.add_initial([record('/dev/r/a.ts')]);
	const path = at('/dev/r/a.ts');
	const seen: Array<boolean> = [];
	const stop_reader = run_in_effect(() => {
		seen.push(!!diskfiles.peek(path));
	});
	const stop_holder = run_in_effect(() => diskfiles.hold(path));
	flushSync();
	assert.deepEqual(seen, [false, true]);
	stop_holder();
	stop_reader();
});

test('a part constructed in a derived makes its cell without an unsafe mutation', () => {
	allow_logged_error(
		'[diskfiles] reading /dev/r/a.ts failed: failed to read file: No such file or directory',
		"the test's fake disk has no such file, so the read its cell starts fails"
	);
	const { diskfiles } = app;
	diskfiles.add_initial([record('/dev/r/a.ts')]);
	const read = read_in_derived(() =>
		Part.create(app, { type: 'diskfile', path: at('/dev/r/a.ts') })
	);
	flushSync();
	const part = read.value;
	assert.ok(part?.type === 'diskfile' && part.diskfile);
	assert.strictEqual(diskfiles.peek(at('/dev/r/a.ts')), part.diskfile);
	read.stop();
});

test('a resync drops the records it lacks and forgets the cells nothing keeps', () => {
	const { diskfiles } = app;
	registry(true);
	diskfiles.add_initial([record('/dev/r/a.ts'), record('/dev/r/b.ts'), record('/dev/r/c.ts')]);
	const part = Part.create(app, { type: 'diskfile', path: at('/dev/r/b.ts') });
	diskfiles.select(at('/dev/r/c.ts'), true);
	diskfiles.reconcile([], [dir('/dev/r/')]);
	assert.strictEqual(diskfiles.index.size, 0);
	assert.isUndefined(diskfiles.peek(at('/dev/r/b.ts')), 'a part keeps no deleted file');
	assert.isTrue(diskfiles.peek(at('/dev/r/c.ts'))?.deleted_on_disk, 'a tab does');
	assert.deepEqual(to_diskfile_index_mismatches(diskfiles), []);
	part.dispose();
});

test('releasing an uncovered repo drops its records, cell or not', () => {
	const { diskfiles } = app;
	registry(true);
	diskfiles.add_initial([record('/dev/r/a.ts'), record('/dev/r/b.ts')]);
	diskfiles.select(at('/dev/r/b.ts'), true);
	app.projects.add({ root: DEV, kind: 'registry', entries: [], focused: [] });
	diskfiles.release_uncovered([dir('/dev/r/')]);
	assert.isFalse(diskfiles.index.has('/dev/r/a.ts'));
	assert.isTrue(diskfiles.peek(at('/dev/r/b.ts'))?.uncovered, 'its tab keeps it');
	assert.deepEqual(to_diskfile_index_mismatches(diskfiles), []);
});

test('creating a file at a kept deleted file’s path selects it before it arrives', async () => {
	const { diskfiles } = app;
	registry(true);
	diskfiles.add_initial([record('/dev/r/a.ts'), record('/dev/r/b.ts')]);
	diskfiles.select(at('/dev/r/a.ts'), true);
	diskfiles.select(at('/dev/r/b.ts'), true);
	diskfiles.remove_by_path('/dev/r/a.ts');
	assert.isTrue(diskfiles.peek(at('/dev/r/a.ts'))?.deleted_on_disk, 'its tab keeps it');
	await diskfiles.create_file_at(at('/dev/r/a.ts'), 'new');
	assert.strictEqual(diskfiles.selected_path, '/dev/r/a.ts');
});
