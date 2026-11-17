import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, assert } from 'vitest';

import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import { Part } from '#lib/part.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

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
