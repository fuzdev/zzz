// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert, vi } from 'vitest';
import { flushSync } from 'svelte';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import {
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '#lib/diskfile_types.ts';
import { Diskfiles, type DiskfileChangeTracker } from '#lib/diskfiles.svelte.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import { confirm_unload_with_unsaved_changes, to_file_directories } from '#lib/diskfile_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/ws/');
const PATH_A = parse_or_throw(DiskfilePath, '/ws/a.txt');
const PATH_B = parse_or_throw(DiskfilePath, '/ws/b.txt');
const PATH_C = parse_or_throw(DiskfilePath, '/ws/c.txt');

let app: Frontend;
let disk: FakeDisk;

/**
 * The disknode the backend sends for `path` — metadata only — with
 * `contents` on the fake disk, for a read of the file to find.
 */
const create_disknode = (
	path: DiskfilePath,
	contents: string | null = 'contents'
): SerializableDisknode => {
	disk.files.set(path, contents);
	return { id: path, source_dir: SOURCE_DIR, size: 1, ctime: 1, mtime: 1 };
};

/**
 * A `filer_change`, metadata only. An `add` or `change` writes `contents`
 * to the fake disk first, and leaves a file nothing holds eagerly loaded
 * with them, as a read on its next access would (see `FakeDisk.write`).
 */
const filer_change = (type: DiskfileChangeType, path: DiskfilePath, contents?: string): void => {
	if (type === 'delete') {
		disk.files.delete(path);
		app.diskfiles.handle_change({
			change: { type, path },
			disknode: { id: path, source_dir: SOURCE_DIR, size: null, ctime: null, mtime: null }
		});
		return;
	}
	disk.write(path, contents ?? 'contents', type);
};

const count_by_path = (path: DiskfilePath): number => {
	let count = 0;
	for (const diskfile of app.diskfiles.items.by_id.values()) {
		if (diskfile.path === path) count++;
	}
	return count;
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
});

describe('upsert by path', () => {
	test('a resync of an unchanged file keeps it and its updated time', () => {
		filer_change('add', PATH_A, 'same');
		const diskfile = app.diskfiles.peek(PATH_A);
		assert.ok(diskfile);
		diskfile.updated = '2000-01-01T00:00:00.000Z' as typeof diskfile.updated;

		app.diskfiles.add_initial([disk.disknode(PATH_A)]);
		assert.strictEqual(app.diskfiles.peek(PATH_A), diskfile);
		assert.strictEqual(diskfile.updated, '2000-01-01T00:00:00.000Z', 'not bumped');
	});

	test('a change takes the size and mtime, and the updated time from the mtime', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'same')]);
		const diskfile = app.diskfiles.peek(PATH_A)!;
		assert.strictEqual(diskfile.mtime, 1);
		diskfile.updated = '2000-01-01T00:00:00.000Z' as typeof diskfile.updated;

		app.diskfiles.upsert({ ...create_disknode(PATH_A, 'same'), size: 4, mtime: 2_000 });
		assert.strictEqual(diskfile.size, 4);
		assert.strictEqual(diskfile.mtime, 2_000);
		assert.strictEqual(diskfile.updated, new Date(2_000).toISOString());

		// an unknown mtime leaves the updated time as it was
		app.diskfiles.upsert({ ...create_disknode(PATH_A, 'same'), mtime: null });
		assert.isNull(diskfile.mtime);
		assert.strictEqual(diskfile.updated, new Date(2_000).toISOString());
	});

	test('a file whose content is not loaded still shows that its bytes changed', () => {
		// a recording grows, or is finalized: its content is never loaded
		app.diskfiles.add_initial([create_disknode(PATH_A, null)]);
		const diskfile = app.diskfiles.peek(PATH_A)!;
		assert.ok(!diskfile.content_loaded);
		assert.strictEqual(diskfile.mtime, 1);

		app.diskfiles.handle_change({
			change: { type: 'change', path: PATH_A },
			disknode: { ...create_disknode(PATH_A, null), mtime: 5 }
		});
		assert.strictEqual(app.diskfiles.peek(PATH_A), diskfile);
		assert.strictEqual(diskfile.mtime, 5);
		assert.strictEqual(count_by_path(PATH_A), 1);
	});

	test('the size on disk arrives whether or not the content is loaded, and moves with changes', () => {
		app.diskfiles.add_initial([{ ...create_disknode(PATH_A, null), size: 5_000_000 }]);
		const diskfile = app.diskfiles.peek(PATH_A)!;
		assert.isNull(diskfile.content);
		assert.strictEqual(diskfile.size, 5_000_000);

		app.diskfiles.handle_change({
			change: { type: 'change', path: PATH_A },
			disknode: { ...create_disknode(PATH_A, null), size: 6_000_000 }
		});
		assert.strictEqual(diskfile.size, 6_000_000);

		app.diskfiles.add_initial([{ ...create_disknode(PATH_B, 'b'), size: null }]);
		assert.isNull(app.diskfiles.peek(PATH_B)?.size, 'unknown stays unknown');
	});

	test('a source_dir change alone still upserts', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'same')]);
		const diskfile = app.diskfiles.peek(PATH_A);
		assert.ok(diskfile);
		const other_dir = parse_or_throw(SerializableDisknode.def.source_dir, '/');
		app.diskfiles.add_initial([{ ...create_disknode(PATH_A, 'same'), source_dir: other_dir }]);
		assert.strictEqual(app.diskfiles.peek(PATH_A), diskfile, 'same diskfile');
		assert.strictEqual(diskfile.source_dir, other_dir);
	});

	test('add for an existing path updates it in place', async () => {
		const diskfile = await disk.load(PATH_A, 'one');
		assert.strictEqual(diskfile.content, 'one');

		filer_change('add', PATH_A, 'two');

		assert.strictEqual(count_by_path(PATH_A), 1);
		assert.strictEqual(app.diskfiles.peek(PATH_A), diskfile);
		// held by nothing, so its old content is dropped, to be read again
		assert.strictEqual(diskfile.content_status, 'unrequested');
		await app.diskfiles.ensure_content(diskfile);
		assert.strictEqual(diskfile.content, 'two');
	});

	test('a change drops the loaded content nothing holds, to be read on its next use', async () => {
		const diskfile = await disk.load(PATH_A, 'one');
		assert.strictEqual(diskfile.content, 'one');
		const reads_before = disk.reads.length;

		disk.files.set(PATH_A, 'two');
		app.diskfiles.handle_change({
			change: { type: 'change', path: PATH_A },
			disknode: { ...disk.disknode(PATH_A), mtime: 7 }
		});

		assert.strictEqual(app.diskfiles.peek(PATH_A), diskfile);
		assert.strictEqual(diskfile.content_status, 'unrequested');
		assert.isNull(diskfile.content);
		assert.strictEqual(diskfile.mtime, 7);
		await flush_reads();
		assert.strictEqual(disk.reads.length, reads_before, 'not read until something needs it');

		await app.diskfiles.ensure_content(diskfile);
		assert.strictEqual(diskfile.content, 'two');
	});

	test('a change to a file with an editing state reads it again, keeping the content until then', async () => {
		const diskfile = await disk.load(PATH_A, 'one');
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		disk.reads.length = 0;

		disk.files.set(PATH_A, 'two');
		app.diskfiles.handle_change({
			change: { type: 'change', path: PATH_A },
			disknode: { ...disk.disknode(PATH_A), mtime: 7 }
		});
		assert.strictEqual(diskfile.content, 'one', 'kept while the read is in flight');
		assert.strictEqual(diskfile.content_status, 'loaded');

		await flush_reads();
		assert.deepEqual(disk.reads, [PATH_A]);
		assert.strictEqual(diskfile.content, 'two');
		assert.strictEqual(editor_state.current_content, 'two', 'a clean editor follows the disk');
	});

	test('a change with the same bytes does not disturb a draft', async () => {
		const diskfile = await disk.load(PATH_A, 'one');
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		disk.reads.length = 0;
		editor_state.current_content = 'one, edited';
		const entries_before = editor_state.history.entries.length;

		// a `touch`: the metadata moves, the bytes don't
		app.diskfiles.handle_change({
			change: { type: 'change', path: PATH_A },
			disknode: { ...disk.disknode(PATH_A), mtime: 7 }
		});
		await flush_reads();

		assert.deepEqual(disk.reads, [PATH_A], 'read again, held eagerly');
		assert.strictEqual(diskfile.mtime, 7);
		assert.strictEqual(editor_state.current_content, 'one, edited');
		assert.strictEqual(editor_state.last_seen_disk_content, 'one');
		assert.strictEqual(editor_state.history.entries.length, entries_before, 'nothing recorded');
		assert.ok(!editor_state.has_conflict, 'the file on disk still has what the draft started from');
	});

	test('a tracker records every path reported while it runs', () => {
		filer_change('add', PATH_A, 'one');
		const tracker = app.diskfiles.track_changes();
		filer_change('change', PATH_A, 'two');
		// not held here, and recorded all the same
		filer_change('delete', PATH_B);
		filer_change('add', PATH_C, 'c');
		tracker.stop();
		filer_change('change', PATH_A, 'three');

		assert.deepEqual([...tracker.paths], [PATH_A, PATH_B, PATH_C]);
	});

	test('change for an unknown path adds it', async () => {
		filer_change('change', PATH_A, 'one');
		const diskfile = app.diskfiles.peek(PATH_A);
		assert.ok(diskfile);
		assert.strictEqual(diskfile.content_status, 'unrequested');
		await app.diskfiles.ensure_content(diskfile);
		assert.strictEqual(diskfile.content, 'one');
	});

	test('a delete after a duplicate add leaves no ghost', () => {
		filer_change('add', PATH_A, 'one');
		filer_change('add', PATH_A, 'two');
		filer_change('delete', PATH_A);

		assert.strictEqual(count_by_path(PATH_A), 0);
		assert.isUndefined(app.diskfiles.peek(PATH_A));
	});

	test('add_initial upserts overlapping seeds', async () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a1'), create_disknode(PATH_B, 'b1')]);
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		await app.diskfiles.ensure_content(a);
		assert.strictEqual(a.content, 'a1');

		// e.g. `project_open` files overlapping `session_load`'s
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a2'), create_disknode(PATH_C, 'c1')]);

		assert.strictEqual(app.diskfiles.items.size, 3);
		assert.strictEqual(app.diskfiles.peek(PATH_A), a);
		// a seed carries no contents: one nothing holds drops what it had
		assert.strictEqual(a.content_status, 'unrequested');
		for (const [path, content] of [
			[PATH_A, 'a2'],
			[PATH_B, 'b1'],
			[PATH_C, 'c1']
		] as const) {
			const diskfile = app.diskfiles.peek(path);
			assert.ok(diskfile);
			await app.diskfiles.ensure_content(diskfile);
			assert.strictEqual(diskfile.content, content);
		}
	});
});

describe('a change while a snapshot is in flight', () => {
	const snapshot_node = (path: DiskfilePath, mtime: number): SerializableDisknode => ({
		...disk.disknode(path),
		mtime
	});

	/** Applies `files` as the snapshot `tracker` was started for. */
	const reconcile = (files: Array<SerializableDisknode>, tracker: DiskfileChangeTracker): void => {
		tracker.stop();
		app.diskfiles.reconcile(files, [SOURCE_DIR], { changes: tracker });
	};

	test('the snapshot yields to it, whichever mtime is higher', () => {
		// an mtime can move backwards, and the two can't be ordered from here:
		// if the snapshot was the newer, another notification is still to come
		for (const snapshot_mtime of [3, 50]) {
			filer_change('add', PATH_A, 'old');
			const tracker = app.diskfiles.track_changes();
			app.diskfiles.handle_change({
				change: { type: 'change', path: PATH_A },
				disknode: { ...disk.disknode(PATH_A), mtime: 9 }
			});
			reconcile([snapshot_node(PATH_A, snapshot_mtime)], tracker);

			assert.strictEqual(app.diskfiles.peek(PATH_A)?.mtime, 9, `${snapshot_mtime}`);
			filer_change('delete', PATH_A);
		}
	});

	test('a seed that only adds yields to it too', () => {
		filer_change('add', PATH_A, 'old');
		const tracker = app.diskfiles.track_changes();
		app.diskfiles.handle_change({
			change: { type: 'change', path: PATH_A },
			disknode: { ...disk.disknode(PATH_A), mtime: 9 }
		});
		tracker.stop();
		app.diskfiles.add_initial([snapshot_node(PATH_A, 5)], tracker);

		assert.strictEqual(app.diskfiles.peek(PATH_A)?.mtime, 9);
	});

	test('a delete is not undone', () => {
		filer_change('add', PATH_A, 'old');
		const tracker = app.diskfiles.track_changes();
		filer_change('delete', PATH_A);
		reconcile([snapshot_node(PATH_A, 5)], tracker);

		assert.strictEqual(count_by_path(PATH_A), 0);
	});

	test('a file it added is not pruned for the snapshot lacking it', () => {
		const tracker = app.diskfiles.track_changes();
		filer_change('add', PATH_A, 'new');
		reconcile([], tracker);

		assert.strictEqual(count_by_path(PATH_A), 1);
	});
});

describe('delete with a tab keeps the file', () => {
	test('the diskfile, its tab, and the selection stay, flagged deleted', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;
		app.diskfiles.select(a.path, true);
		app.diskfiles.select(b.path, true);
		const tab = tabs.by_path.get(b.path);
		assert.ok(tab);
		const b_state = app.diskfiles.get_editor_state(b);
		assert.isFalse(b_state.has_unsaved_edits);

		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.strictEqual(tabs.by_path.get(b.path), tab);
		assert.strictEqual(tabs.items.size, 2);
		assert.strictEqual(tabs.selected_path, b.path);
		assert.strictEqual(app.diskfiles.selected_path, b.path);
		assert.strictEqual(app.diskfiles.find_editor_state(b.path), b_state);
		assert.include(
			app.diskfiles.listed.map((r) => r.id),
			b.path
		);
		assert.include(app.diskfiles.listed_unindexed, b);
		assert.notInclude(
			app.diskfiles.on_disk.map((r) => r.id),
			b.path
		);
	});

	test('closing its tab forgets the diskfile, its tab, and its history', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;
		app.diskfiles.select(a.path, true);
		app.diskfiles.select(b.path, true);
		const tab = tabs.by_path.get(b.path);
		assert.ok(tab);
		const { history } = app.diskfiles.get_editor_state(b);
		const { all } = app.cell_registry;
		filer_change('delete', PATH_B);
		assert.ok(all.has(b.id) && all.has(tab.id) && all.has(history.id));

		app.diskfiles.editor.close_tab(tab.id);

		assert.isUndefined(app.diskfiles.peek(PATH_B));
		assert.isUndefined(app.diskfiles.find_editor_state(b.path));
		assert.ok(!all.has(b.id));
		assert.ok(!all.has(tab.id));
		assert.ok(!all.has(history.id));
		assert.notInclude(
			app.diskfiles.listed.map((r) => r.id),
			b.path
		);
		assert.strictEqual(tabs.selected_path, a.path);
		assert.strictEqual(app.diskfiles.selected_path, a.path);
		// neither the reopen stack nor back-navigation resurrects it
		tabs.reopen_last_closed_tab();
		assert.isUndefined(tabs.by_path.get(b.path));
		assert.isNull(tabs.navigate_to_tab(tab.id));
	});

	test('a preview tab keeps it until it previews another file', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		const { tabs } = app.diskfiles.editor;
		app.diskfiles.select(a.path);
		assert.strictEqual(tabs.preview_tab?.path, a.path);

		filer_change('delete', PATH_A);
		assert.strictEqual(app.diskfiles.peek(PATH_A), a);
		assert.isTrue(a.deleted_on_disk);

		app.diskfiles.select(PATH_B);

		assert.isUndefined(app.diskfiles.peek(PATH_A));
		assert.strictEqual(tabs.items.size, 1);
		assert.strictEqual(app.diskfiles.selected_path, PATH_B);
	});

	test('the file reappearing reattaches the same diskfile and clears the flag', async () => {
		await disk.load(PATH_A, 'a');
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		const tab = app.diskfiles.editor.tabs.by_path.get(a.path);
		filer_change('delete', PATH_A);

		filer_change('add', PATH_A, 'a back');
		await flush_reads();

		assert.strictEqual(app.diskfiles.peek(PATH_A), a);
		assert.strictEqual(count_by_path(PATH_A), 1);
		assert.isFalse(a.deleted_on_disk);
		assert.strictEqual(a.content, 'a back');
		assert.strictEqual(app.diskfiles.editor.tabs.by_path.get(a.path), tab);
		assert.strictEqual(app.diskfiles.find_editor_state(a.path), editor_state);
		assert.strictEqual(editor_state.current_content, 'a back');
		assert.notInclude(app.diskfiles.listed_unindexed, a);
	});

	test('a rename leaves the old tab, flagged, and adds the new file without opening it', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		const { tabs } = app.diskfiles.editor;
		app.diskfiles.select(a.path, true);

		// a rename reaches zzz as a delete of the old path plus an add of the new
		filer_change('delete', PATH_A);
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.peek(PATH_A), a);
		assert.isTrue(a.deleted_on_disk);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(b);
		assert.isFalse(b.deleted_on_disk);
		assert.strictEqual(tabs.items.size, 1);
		assert.ok(tabs.by_path.has(PATH_A));
		assert.ok(!tabs.by_path.has(PATH_B));
		assert.strictEqual(app.diskfiles.selected_path, PATH_A);
	});

	test("saving a deleted tab's content recreates the file", async () => {
		await disk.load(PATH_A, 'a');
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		delete (app.diskfiles as { update?: unknown }).update;
		filer_change('delete', PATH_A);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isTrue(editor_state.can_save);

		assert.isTrue(await editor_state.save_changes());

		// an exclusive create — there's no disk version to compare against
		assert.deepEqual(disk.creates, [{ path: PATH_A, content: 'a' }]);
		assert.deepEqual(disk.updates, []);
		assert.strictEqual(disk.files.get(PATH_A), 'a');
		assert.isFalse(a.deleted_on_disk);
		assert.isTrue(a.uncovered, 'no project indexes it, so no add will come');
		assert.strictEqual(app.diskfiles.peek(PATH_A), a);
	});

	test('deleting an unknown path is a no-op', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		filer_change('delete', PATH_B);
		assert.strictEqual(app.diskfiles.items.size, 1);
	});
});

describe('delete without a tab or draft forgets the file', () => {
	test('disposes the diskfile and its history, and leaves other tabs alone', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;
		app.diskfiles.select(a.path, true);
		const { history } = app.diskfiles.get_editor_state(b);
		const { all } = app.cell_registry;

		filer_change('delete', PATH_B);

		assert.isUndefined(app.diskfiles.peek(PATH_B));
		assert.ok(!all.has(b.id));
		assert.ok(!all.has(history.id));
		assert.strictEqual(app.diskfiles.selected_path, a.path);
		assert.strictEqual(tabs.items.size, 1);
	});

	test('the deleted file cannot be reopened or navigated back to', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;

		app.diskfiles.select(a.path, true);
		const b_tab = tabs.open_diskfile(b.path);
		tabs.close_tab(b_tab.id);
		assert.strictEqual(tabs.closed_tab_paths.get(b_tab.id), b.path);

		filer_change('delete', PATH_B);

		assert.isUndefined(app.diskfiles.peek(PATH_B));
		tabs.reopen_last_closed_tab();
		assert.isUndefined(tabs.by_path.get(b.path));
		assert.isNull(tabs.navigate_to_tab(b_tab.id));
	});
});

describe('has_unsaved_changes and the unload guard', () => {
	const create_unload_event = () => {
		const event = new Event('beforeunload', { cancelable: true });
		return event;
	};

	test('is false with no drafts, true with one, false again once discarded', async () => {
		await disk.load(PATH_A, 'a');
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		const editor_state = app.diskfiles.get_editor_state(a);
		assert.ok(!app.diskfiles.has_unsaved_changes);

		editor_state.current_content = 'a edited';
		assert.ok(app.diskfiles.has_unsaved_changes);

		editor_state.discard_draft();
		assert.ok(!app.diskfiles.has_unsaved_changes);
	});

	test('confirm_unload_with_unsaved_changes cancels the unload only with unsaved changes', async () => {
		await disk.load(PATH_A, 'a');
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);

		const clean = create_unload_event();
		confirm_unload_with_unsaved_changes(clean, app.diskfiles);
		assert.ok(!clean.defaultPrevented);

		const no_app = create_unload_event();
		confirm_unload_with_unsaved_changes(no_app, undefined);
		assert.ok(!no_app.defaultPrevented);

		app.diskfiles.get_editor_state(a).current_content = 'a edited';
		const dirty = create_unload_event();
		confirm_unload_with_unsaved_changes(dirty, app.diskfiles);
		assert.ok(dirty.defaultPrevented);
	});
});

describe('delete with unsaved edits keeps the tab', () => {
	const setup_dirty = async () => {
		await disk.load(PATH_A, 'a');
		await disk.load(PATH_B, 'b');
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		app.diskfiles.select(a.path, true);
		app.diskfiles.select(b.path, true);
		const editor_state = app.diskfiles.get_editor_state(b);
		editor_state.current_content = 'b edited';
		assert.ok(editor_state.has_unsaved_edits);
		return { a, b, editor_state, tabs: app.diskfiles.editor.tabs };
	};

	test('the diskfile, tab, selection, and history stay, flagged deleted', async () => {
		const { b, tabs } = await setup_dirty();

		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.ok(tabs.by_path.get(b.path));
		assert.strictEqual(tabs.selected_path, b.path);
		assert.strictEqual(app.diskfiles.selected_path, b.path);
		assert.ok(app.diskfiles.find_editor_state(b.path)?.has_unsaved_edits);
		assert.notInclude(
			app.diskfiles.on_disk.map((r) => r.id),
			b.path
		);
		assert.strictEqual(app.diskfiles.on_disk.length, 1);
	});

	test('recreating the path reattaches the same diskfile and clears the flag', async () => {
		const { b, tabs, editor_state } = await setup_dirty();
		const tab = tabs.by_path.get(b.path);
		filer_change('delete', PATH_B);

		filer_change('add', PATH_B, 'b recreated');
		await flush_reads();

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.strictEqual(count_by_path(PATH_B), 1);
		assert.isFalse(b.deleted_on_disk);
		assert.strictEqual(b.content, 'b recreated');
		assert.strictEqual(tabs.by_path.get(b.path), tab);
		assert.include(
			app.diskfiles.on_disk.map((r) => r.id),
			b.path
		);
		// the unsaved edit survives the round trip
		assert.strictEqual(editor_state.current_content, 'b edited');
	});

	test('saving writes the path back', async () => {
		const { editor_state } = await setup_dirty();
		filer_change('delete', PATH_B);

		assert.isTrue(await editor_state.save_changes());

		assert.deepEqual(disk.creates, [{ path: PATH_B, content: 'b edited' }]);
		assert.strictEqual(disk.files.get(PATH_B), 'b edited');
	});

	test('closing the tab after discarding the draft forgets the diskfile ("don\'t save")', async () => {
		const { a, b, tabs, editor_state } = await setup_dirty();
		filer_change('delete', PATH_B);
		const tab = tabs.by_path.get(b.path);
		assert.ok(tab);

		editor_state.discard_draft();
		assert.strictEqual(app.diskfiles.peek(PATH_B), b, 'kept while its tab is open');
		app.diskfiles.editor.close_tab(tab.id);

		assert.isUndefined(app.diskfiles.peek(PATH_B));
		assert.isUndefined(app.diskfiles.find_editor_state(b.path));
		assert.strictEqual(app.diskfiles.selected_path, a.path);
		tabs.reopen_last_closed_tab();
		assert.isUndefined(tabs.by_path.get(b.path));
	});

	test('closing the tab with the draft kept keeps the diskfile, listed for the draft', async () => {
		const { b, tabs } = await setup_dirty();
		filer_change('delete', PATH_B);
		const tab = tabs.by_path.get(b.path);
		assert.ok(tab);

		app.diskfiles.editor.close_tab(tab.id);

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.include(
			app.diskfiles.listed.map((r) => r.id),
			b.path
		);
		assert.notInclude(
			app.diskfiles.on_disk.map((r) => r.id),
			b.path
		);
		assert.strictEqual(app.diskfiles.find_editor_state(b.path)?.current_content, 'b edited');
	});
	test('closing all tabs keeps the draft too', async () => {
		const { b, tabs } = await setup_dirty();
		filer_change('delete', PATH_B);

		tabs.close_all_tabs();

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.ok(app.diskfiles.peek(PATH_A));
		assert.isTrue(app.diskfiles.find_editor_state(b.path)?.has_unsaved_edits);
	});
	test('closing a tab of a file still on disk keeps it', async () => {
		const { a, tabs } = await setup_dirty();
		const tab = tabs.by_path.get(a.path);
		assert.ok(tab);

		tabs.close_tab(tab.id);

		assert.strictEqual(app.diskfiles.peek(PATH_A), a);
	});

	test('unsaved edits without an open tab keep a deleted file too', async () => {
		const { b, tabs } = await setup_dirty();
		const tab = tabs.by_path.get(b.path);
		assert.ok(tab);
		tabs.close_tab(tab.id);

		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
	});

	test('a draft from a file part (never in a tab) keeps a deleted or pruned file', async () => {
		// the index covers the snapshot's root, so the prune is a delete
		app.projects.add({ root: SOURCE_DIR });
		await disk.load(PATH_A, 'a');
		await disk.load(PATH_B, 'b');
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(b);
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		app.diskfiles.get_editor_state(b).current_content = 'part draft';
		assert.isFalse(app.diskfiles.editor.tabs.by_path.has(b.path));

		app.diskfiles.reconcile([create_disknode(PATH_A, 'a')], ['/ws/']);

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.strictEqual(part.diskfile, b);
		assert.strictEqual(part.content, 'part draft');
		assert.strictEqual(part.draft_status, 'deleted');

		// discarding the draft lets it go
		app.diskfiles.get_editor_state(b).discard_draft();
		assert.isUndefined(app.diskfiles.peek(PATH_B));
		assert.isUndefined(part.diskfile);
	});

	test('a file without a draft or a tab is not kept', async () => {
		await disk.load(PATH_B, 'b');
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(b);
		app.diskfiles.get_editor_state(b);

		filer_change('delete', PATH_B);

		assert.isUndefined(app.diskfiles.peek(PATH_B));
	});
	test('saving recreates the file even with nothing left to save', async () => {
		const { b, editor_state } = await setup_dirty();
		// back to the original entry: history keeps the unsaved alternate while
		// the editor matches disk
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);
		assert.isFalse(editor_state.has_changes);
		assert.ok(editor_state.has_unsaved_edits);

		filer_change('delete', PATH_B);
		assert.isTrue(b.deleted_on_disk);
		assert.isTrue(editor_state.can_save);

		assert.isTrue(await editor_state.save_changes());
		assert.deepEqual(disk.creates, [{ path: PATH_B, content: 'b' }]);
	});

	test('reusing a preview tab away from the file keeps its draft', async () => {
		await disk.load(PATH_A, 'a');
		await disk.load(PATH_B, 'b');
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;
		const preview = tabs.preview_diskfile(b.path);
		app.diskfiles.get_editor_state(b).current_content = 'b edited';

		filer_change('delete', PATH_B);
		assert.isTrue(b.deleted_on_disk);
		assert.strictEqual(tabs.preview_tab_id, preview.id);

		tabs.preview_diskfile(a.path);

		assert.strictEqual(preview.path, a.path);
		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.include(
			app.diskfiles.listed.map((r) => r.id),
			b.path
		);
	});
	test('a repeated delete keeps it flagged', async () => {
		const { b, tabs } = await setup_dirty();
		filer_change('delete', PATH_B);
		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.peek(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.ok(tabs.by_path.get(b.path));
		assert.strictEqual(count_by_path(PATH_B), 1);
	});

	test('a diskfile part shows a flagged file for its draft', async () => {
		const { b, editor_state } = await setup_dirty();
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		assert.strictEqual(part.diskfile, b);
		// the part sends the draft, marked
		assert.strictEqual(part.content, 'b edited');
		assert.strictEqual(part.draft_status, 'unsaved');

		filer_change('delete', PATH_B);

		assert.strictEqual(part.diskfile, b);
		assert.strictEqual(part.content, 'b edited');
		assert.strictEqual(part.draft_status, 'deleted');

		filer_change('add', PATH_B, 'b back');
		await flush_reads();
		assert.strictEqual(part.diskfile, b);
		// the draft is kept over the recreated file, as a conflict
		assert.strictEqual(part.content, 'b edited');
		assert.strictEqual(part.draft_status, 'conflict');
		assert.isTrue(editor_state.has_conflict);

		editor_state.discard_draft();
		assert.strictEqual(part.content, 'b back');
		assert.isNull(part.draft_status);
	});

	test('a diskfile part sends the draft, not an older entry an editor views', async () => {
		const { editor_state } = await setup_dirty();
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		const older = editor_state.history.add_entry('older', { created: 1 });

		editor_state.set_content_from_history(older.id);
		assert.strictEqual(part.content, 'b edited');

		editor_state.clear_unsaved_edits();
		editor_state.set_content_from_history(older.id);
		assert.strictEqual(part.content, 'b');
		assert.isNull(part.draft_status);
	});
});

describe('release_uncovered', () => {
	const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
	const at = (path: string): DiskfilePath => parse_or_throw(DiskfilePath, path);
	const dir = (path: string): DiskfileDirectoryPath => parse_or_throw(DiskfileDirectoryPath, path);

	/** Seeds the files at `paths` and gives `held` a tab with a draft. */
	const seed = async (paths: Array<DiskfilePath>, held: Array<DiskfilePath>): Promise<void> => {
		for (const path of paths) await disk.load(path, path);
		for (const path of held) {
			const diskfile = app.diskfiles.peek(path)!;
			app.diskfiles.select(diskfile.path, true);
			app.diskfiles.get_editor_state(diskfile).current_content = 'edited';
		}
	};

	test('releases what a narrower state no longer indexes, by why it went', async () => {
		// a registry at `/dev/` that dropped its focus of `app` (present, so
		// unfocused) and of `gone` (missing now)
		app.projects.add({
			root: DEV,
			kind: 'registry',
			entries: [
				{ key: 'app', kind: 'repo', dir: dir('/dev/app/'), state: 'present' },
				{ key: 'gone', kind: 'repo', dir: dir('/dev/gone/'), state: 'missing' }
			],
			focused: []
		});
		const paths = ['/dev/README.md', '/dev/app/a.ts', '/dev/app/b.ts', '/dev/gone/x.ts'].map(at);
		await seed(paths, [at('/dev/app/b.ts'), at('/dev/gone/x.ts')]);

		app.diskfiles.release_uncovered([dir('/dev/app/'), dir('/dev/gone/')]);

		assert.ok(app.diskfiles.peek(at('/dev/README.md')), 'outside the dropped dirs');
		assert.ok(!app.diskfiles.peek(at('/dev/app/a.ts')), 'unfocused, nothing holds it');
		const b = app.diskfiles.peek(at('/dev/app/b.ts'));
		assert.ok(b, 'unfocused, held by its draft');
		assert.isFalse(b.deleted_on_disk, 'still on disk');
		const x = app.diskfiles.peek(at('/dev/gone/x.ts'));
		assert.ok(x, 'its draft keeps it');
		assert.isTrue(x.uncovered, 'its repo missing: out of the index, not seen deleted');
		assert.isFalse(x.deleted_on_disk);
	});

	test('closing a project keeps a file with a tab or a draft, flagged uncovered, and forgets the rest', async () => {
		const WS = dir('/ws/');
		app.projects.add({ root: WS });
		const paths = [PATH_A, PATH_B, PATH_C];
		for (const path of paths) await disk.load(path, path);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		app.diskfiles.select(a.path, true);
		const tab = app.diskfiles.editor.tabs.by_path.get(a.path);
		assert.ok(tab);
		app.diskfiles.get_editor_state(b).current_content = 'b edited';

		app.projects.remove_by_root(WS);

		assert.strictEqual(app.diskfiles.peek(PATH_A), a, 'its tab keeps it');
		assert.isTrue(a.uncovered);
		assert.isFalse(a.deleted_on_disk, 'not seen deleted');
		assert.strictEqual(app.diskfiles.peek(PATH_B), b, 'its draft keeps it');
		assert.isTrue(b.uncovered);
		assert.isFalse(b.deleted_on_disk);
		assert.sameMembers(app.diskfiles.listed_unindexed, [a, b]);
		assert.notInclude(
			app.diskfiles.on_disk.map((r) => r.id),
			a.path,
			'pickers skip it'
		);
		assert.isUndefined(app.diskfiles.peek(PATH_C), 'nothing holds it');

		app.diskfiles.editor.close_tab(tab.id);
		assert.isUndefined(app.diskfiles.peek(PATH_A));
	});

	test('a root turned registry keeps its loose files and what another root covers', async () => {
		app.scoped_dirs = [dir('/dev/shared/')];
		app.projects.add({ root: DEV, kind: 'registry', entries: [], focused: [] });
		const paths = ['/dev/README.md', '/dev/scratch/y.ts', '/dev/shared/z.ts'].map(at);
		await seed(paths, []);

		// it was a plain directory, focused on its root
		app.diskfiles.release_uncovered([DEV]);

		assert.ok(app.diskfiles.peek(at('/dev/README.md')), 'a loose file of its top level');
		assert.ok(!app.diskfiles.peek(at('/dev/scratch/y.ts')), 'below it, unindexed');
		assert.ok(app.diskfiles.peek(at('/dev/shared/z.ts')), 'a scoped dir covers it');
	});
});

describe('path_relative', () => {
	const ZZZ_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/zzz/');

	test('is relative inside the zzz dir and absolute outside it', () => {
		app.zzz_dir = ZZZ_DIR;
		const inside = parse_or_throw(DiskfilePath, '/zzz/notes/a.md');
		app.diskfiles.add_initial([create_disknode(inside), create_disknode(PATH_A)]);

		assert.strictEqual(app.diskfiles.peek(inside)?.path_relative, 'notes/a.md');
		assert.strictEqual(app.diskfiles.peek(PATH_A)?.path_relative, '/ws/a.txt');
	});

	test('a file part outside the zzz dir gets the absolute path as its `path` attribute', () => {
		app.zzz_dir = ZZZ_DIR;
		app.diskfiles.add_initial([create_disknode(PATH_A)]);

		const part = app.parts.add({ type: 'diskfile', path: PATH_A });

		assert.strictEqual(part.attributes.find((a) => a.key === 'path')?.value, '/ws/a.txt');
	});
});

describe('create_file', () => {
	test('creates in the active project through `diskfile_create`, never `diskfile_update`', async () => {
		const calls: Array<[string, unknown]> = [];
		(app as any).api = {
			diskfile_create: (input: unknown) => {
				calls.push(['diskfile_create', input]);
				return Promise.resolve({ ok: true, value: null });
			},
			diskfile_update: (input: unknown) => {
				calls.push(['diskfile_update', input]);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.zzz_dir = parse_or_throw(SerializableDisknode.def.source_dir, '/zzz/');
		app.projects.add({ root: SOURCE_DIR });

		await app.diskfiles.create_file('/new.txt');

		assert.deepEqual(calls, [['diskfile_create', { path: '/ws/new.txt', content: '' }]]);
	});

	describe('in a registry project', () => {
		const DEV = parse_or_throw(SerializableDisknode.def.source_dir, '/dev/');
		const APP = parse_or_throw(SerializableDisknode.def.source_dir, '/dev/app/');
		const SITE = parse_or_throw(SerializableDisknode.def.source_dir, '/dev/site/');
		const calls: Array<unknown> = [];
		const setup_registry = () => {
			calls.length = 0;
			(app as any).api = {
				diskfile_create: (input: unknown) => {
					calls.push(input);
					return Promise.resolve({ ok: true, value: null });
				}
			};
			app.zzz_dir = parse_or_throw(SerializableDisknode.def.source_dir, '/zzz/');
			return app.projects.add({ root: DEV, kind: 'registry', focused: [APP, SITE] });
		};

		test("new files go in the last open's focus, else the root", async () => {
			const project = setup_registry();
			assert.strictEqual(app.diskfiles.new_files_dir, DEV);
			project.last_focus = SITE;
			assert.strictEqual(app.diskfiles.new_files_dir, SITE);
			await app.diskfiles.create_file('x.md');
			assert.deepEqual(calls, [{ path: '/dev/site/x.md', content: '' }]);
			// a focus the project no longer has falls back to the root
			project.focused = [APP];
			assert.strictEqual(app.diskfiles.new_files_dir, DEV);
		});

		test('a loose file at the root is created', async () => {
			setup_registry();
			await app.diskfiles.create_file('notes.md');
			assert.deepEqual(calls, [{ path: '/dev/notes.md', content: '' }]);
		});

		test('a file in an unfocused repo is refused before anything is written', async () => {
			setup_registry();
			for (const name of ['other/x.md', 'site/../other/x.md']) {
				const error = await app.diskfiles.create_file(name).then(
					() => null,
					(e: unknown) => e
				);
				assert.instanceOf(error, Error, name);
				assert.include(error.message, "isn't in a focused repo", name);
			}
			assert.deepEqual(calls, []);
			// a focused repo's is fine
			await app.diskfiles.create_file_at(parse_or_throw(DiskfilePath, '/dev/app/y.md'));
			assert.deepEqual(calls, [{ path: '/dev/app/y.md', content: '' }]);
		});

		test('a folder whose files would be refused is refused too', async () => {
			setup_registry();
			const folders: Array<unknown> = [];
			(app as any).api.directory_create = (input: unknown) => {
				folders.push(input);
				return Promise.resolve({ ok: true, value: null });
			};
			for (const name of ['other', 'other/deep/', 'scratch/']) {
				const error = await app.diskfiles.create_directory(name).then(
					() => null,
					(e: unknown) => e
				);
				assert.instanceOf(error, Error, name);
				assert.include(error.message, "isn't in a focused repo", name);
			}
			assert.deepEqual(folders, []);
			await app.diskfiles.create_directory_at(parse_or_throw(DiskfilePath, '/dev/app/sub'));
			assert.deepEqual(folders, [{ path: '/dev/app/sub' }]);
		});
	});

	test('refuses when no project is open', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			diskfile_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.zzz_dir = parse_or_throw(SerializableDisknode.def.source_dir, '/zzz/');
		assert.isNull(app.diskfiles.new_files_dir);

		const error = await app.diskfiles.create_file('new.txt').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.include(error.message, 'no project is open');
		assert.deepEqual(calls, []);
	});

	test('refuses a whitespace-only name without calling the backend', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			diskfile_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			},
			directory_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.projects.add({ root: SOURCE_DIR });

		for (const create of [
			() => app.diskfiles.create_file('   '),
			() => app.diskfiles.create_directory(' \t '),
			() => app.diskfiles.create_file('sub/ /a.txt')
		]) {
			const error = await create().then(
				() => null,
				(e: unknown) => e
			);
			assert.instanceOf(error, Error);
		}
		assert.deepEqual(calls, []);
	});

	test('trims the name', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			diskfile_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			},
			directory_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.projects.add({ root: SOURCE_DIR });

		await app.diskfiles.create_file(' new.txt\n');
		await app.diskfiles.create_directory(' sub/ ');

		assert.deepEqual(calls, [{ path: '/ws/new.txt', content: '' }, { path: '/ws/sub/' }]);
	});

	test('surfaces an existing file as "already exists"', async () => {
		(app as any).api = {
			diskfile_create: () =>
				Promise.resolve({
					ok: false,
					error: {
						code: -32004,
						message: 'failed to create file: Path already exists: /ws/taken.txt',
						data: { reason: 'already_exists' }
					}
				})
		};
		app.projects.add({ root: SOURCE_DIR });

		const error = await app.diskfiles.create_file('taken.txt').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.strictEqual(error.message, 'already exists');
	});
});

describe('delete', () => {
	test('throws the backend error when the delete fails', async () => {
		(app as any).api = {
			diskfile_delete: () =>
				Promise.resolve({
					ok: false,
					error: { code: -32003, message: 'permission denied: /ws/a.txt' }
				})
		};

		const error = await app.diskfiles.delete(PATH_A).then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.strictEqual(error.message, 'permission denied: /ws/a.txt');
	});

	test('resolves when the delete succeeds', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			diskfile_delete: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};

		await app.diskfiles.delete(PATH_A);
		assert.deepEqual(calls, [{ path: PATH_A }]);
	});
});

describe('selection on add', () => {
	test('a file seeded by a snapshot is not selected', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);

		assert.isNull(app.diskfiles.selected_path);
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0);
	});

	test('a file another tool creates is not selected, with nothing selected', () => {
		filer_change('add', PATH_A);

		assert.isNull(app.diskfiles.selected_path);
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0);
	});

	test('a file another tool creates leaves the selection and tabs alone', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.path);
		const { tabs } = app.diskfiles.editor;
		const tab = tabs.selected_tab;
		assert.ok(tab);

		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_path, a.path);
		assert.strictEqual(tabs.selected_tab, tab);
		assert.deepEqual(tabs.ordered_tabs, [tab]);
	});
});

describe('selection JSON', () => {
	test('the selected path round-trips through JSON', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		app.diskfiles.select(PATH_B);

		const json = app.diskfiles.to_json();
		assert.strictEqual(json.selected_path, PATH_B);

		const other = monkeypatch_zzz_for_tests(new Frontend());
		const restored = new Diskfiles({ app: other, json });
		assert.strictEqual(restored.selected_path, PATH_B);
		assert.strictEqual(restored.to_json().selected_path, PATH_B);
		restored.dispose();
		other.dispose();
	});

	test('no selection round-trips as null', () => {
		const json = app.diskfiles.to_json();
		assert.isNull(json.selected_path);
		const restored = new Diskfiles({ app, json });
		assert.isNull(restored.selected_path);
		restored.dispose();
	});
});

describe('reopening a closed tab', () => {
	test('selects the reopened file', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.path, true);
		app.diskfiles.select(b.path, true);
		const b_tab = editor.tabs.by_path.get(b.path);
		assert.ok(b_tab);
		editor.close_tab(b_tab.id);
		assert.strictEqual(app.diskfiles.selected_path, a.path);

		editor.reopen_last_closed_tab();

		assert.strictEqual(editor.tabs.selected_path, b.path);
		assert.strictEqual(app.diskfiles.selected_path, b.path);
	});
});

describe('back/forward navigation', () => {
	test('selects the file of the tab navigated to', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.path, true);
		const a_tab = editor.tabs.selected_tab;
		assert.ok(a_tab);
		app.diskfiles.select(b.path, true);

		assert.strictEqual(editor.navigate_to_tab(a_tab.id), a_tab.id);

		assert.strictEqual(app.diskfiles.selected_path, a.path);
	});

	test('a closed tab navigated to selects its file in a new preview', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.path, true);
		const a_tab = editor.tabs.selected_tab;
		assert.ok(a_tab);
		app.diskfiles.select(b.path, true);
		editor.close_tab(a_tab.id);

		const tab_id = editor.navigate_to_tab(a_tab.id);

		assert.ok(tab_id);
		assert.strictEqual(editor.tabs.items.by_id.get(tab_id)?.path, a.path);
		assert.strictEqual(app.diskfiles.selected_path, a.path);
	});

	test('an unknown tab leaves the selection alone', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.path, true);

		assert.isNull(app.diskfiles.editor.navigate_to_tab(create_uuid()));

		assert.strictEqual(app.diskfiles.selected_path, a.path);
	});
});

describe('DiskfilesEditor.handle_file_modified', () => {
	test("promotes the modified file's preview tab and leaves others alone", () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.peek(PATH_A);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.path, true);
		app.diskfiles.select(b.path);
		const b_tab = editor.tabs.preview_tab;
		assert.strictEqual(b_tab?.path, b.path);

		editor.handle_file_modified(a.path);
		assert.strictEqual(editor.tabs.preview_tab, b_tab, 'another file leaves the preview');

		editor.handle_file_modified(b.path);
		assert.isNull(editor.tabs.preview_tab_id);
		assert.strictEqual(editor.tabs.by_path.get(b.path), b_tab, 'the same tab, now permanent');
	});
});

describe('create_file selects the new file', () => {
	const setup = (on_create?: () => void) => {
		(app as any).api = {
			diskfile_create: () => {
				on_create?.();
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.projects.add({ root: SOURCE_DIR });
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.peek(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.path);
		return a;
	};

	test('when its `filer_change` arrives after the response', async () => {
		const a = setup();

		await app.diskfiles.create_file('b.txt');
		assert.strictEqual(app.diskfiles.selected_path, a.path, 'not there yet');

		filer_change('add', PATH_C);
		assert.strictEqual(app.diskfiles.selected_path, a.path, 'an unrelated file');

		filer_change('add', PATH_B);
		const b = app.diskfiles.peek(PATH_B);
		assert.ok(b);
		assert.strictEqual(app.diskfiles.selected_path, b.path);
		const { tabs } = app.diskfiles.editor;
		assert.strictEqual(tabs.selected_path, b.path);
		assert.notStrictEqual(tabs.preview_tab_id, tabs.selected_tab_id, 'a permanent tab');
	});

	test('when its `filer_change` arrived before the response', async () => {
		setup(() => filer_change('add', PATH_B));

		await app.diskfiles.create_file('b.txt');

		const b = app.diskfiles.peek(PATH_B);
		assert.ok(b);
		assert.strictEqual(app.diskfiles.selected_path, b.path);
		assert.strictEqual(app.diskfiles.editor.tabs.selected_path, b.path);
	});

	test('only once — a later re-add of the path by another tool does not select it', async () => {
		const a = setup(() => filer_change('add', PATH_B));
		await app.diskfiles.create_file('b.txt');
		app.diskfiles.select(a.path);

		filer_change('delete', PATH_B);
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_path, a.path);
	});

	for (const filename of ['./b.txt', 'sub/../b.txt', '/b.txt', 'sub//../b.txt']) {
		test(`a name the backend normalizes (${filename}) is selected by its normalized path`, async () => {
			setup();

			await app.diskfiles.create_file(filename);
			filer_change('add', PATH_B);

			assert.strictEqual(app.diskfiles.selected_path, app.diskfiles.peek(PATH_B)?.path);
		});
	}

	test('selecting another file drops the pending selection', async () => {
		const a = setup();
		await app.diskfiles.create_file('b.txt');

		app.diskfiles.select(a.path);
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_path, a.path);
	});

	test('a tab change through the editor drops the pending selection', async () => {
		const scenarios: Array<[string, (a_tab_id: Uuid, c_tab_id: Uuid) => void]> = [
			['open', (a_tab_id) => app.diskfiles.editor.open_tab(a_tab_id)],
			['navigate', (a_tab_id) => app.diskfiles.editor.navigate_to_tab(a_tab_id)],
			['close the selected tab', (_, c_tab_id) => app.diskfiles.editor.close_tab(c_tab_id)],
			[
				'reopen',
				(_, c_tab_id) => {
					app.diskfiles.editor.tabs.close_tab(c_tab_id);
					app.diskfiles.editor.reopen_last_closed_tab();
				}
			]
		];
		for (const [name, change_tab] of scenarios) {
			app.dispose();
			app = monkeypatch_zzz_for_tests(new Frontend());
			setup();
			const a_tab = app.diskfiles.editor.tabs.selected_tab;
			app.diskfiles.add_initial([create_disknode(PATH_C)]);
			const c = app.diskfiles.peek(PATH_C);
			assert.ok(a_tab && c);
			app.diskfiles.select(c.path, true);
			const c_tab = app.diskfiles.editor.tabs.selected_tab;
			assert.ok(c_tab);
			await app.diskfiles.create_file('b.txt');

			change_tab(a_tab.id, c_tab.id);
			const selected = app.diskfiles.selected_path;
			filer_change('add', PATH_B);

			assert.strictEqual(app.diskfiles.selected_path, selected, name);
			assert.notStrictEqual(selected, app.diskfiles.peek(PATH_B)?.path, name);
		}
	});

	test('removing its project drops the pending selection', async () => {
		const a = setup();
		await app.diskfiles.create_file('b.txt');

		app.projects.remove_by_root(SOURCE_DIR);
		assert.isTrue(a.uncovered, "the closed project's file is kept for its tab, flagged");
		filer_change('add', PATH_B);

		const b = app.diskfiles.peek(PATH_B);
		assert.ok(b);
		assert.notStrictEqual(app.diskfiles.selected_path, b.path);
	});

	test('the next create replaces the pending selection', async () => {
		setup();
		await app.diskfiles.create_file('b.txt');
		await app.diskfiles.create_file('c.txt');

		filer_change('add', PATH_B);
		const b = app.diskfiles.peek(PATH_B);
		assert.notStrictEqual(app.diskfiles.selected_path, b?.path);

		filer_change('add', PATH_C);
		assert.strictEqual(app.diskfiles.selected_path, app.diskfiles.peek(PATH_C)?.path);
	});

	test('a failed create selects nothing', async () => {
		const a = setup();
		(app as any).api = {
			diskfile_create: () =>
				Promise.resolve({ ok: false, error: { code: -32603, message: 'nope' } })
		};

		await app.diskfiles.create_file('b.txt').catch(() => {});
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_path, a.path);
	});
});

describe('create_directory', () => {
	test('creates in the active project', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			directory_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.projects.add({ root: SOURCE_DIR });

		await app.diskfiles.create_directory('sub/dir');

		assert.deepEqual(calls, [{ path: '/ws/sub/dir' }]);
	});

	test('refuses when no project is open', async () => {
		(app as any).api = {
			directory_create: () => Promise.resolve({ ok: true, value: null })
		};

		const error = await app.diskfiles.create_directory('sub').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.include(error.message, 'no project is open');
	});

	test('throws the backend error instead of swallowing it', async () => {
		(app as any).api = {
			directory_create: () =>
				Promise.resolve({
					ok: false,
					error: { code: -32003, message: 'failed to create directory: permission denied' }
				})
		};
		app.projects.add({ root: SOURCE_DIR });

		const error = await app.diskfiles.create_directory('sub').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.strictEqual(error.message, 'failed to create directory: permission denied');
	});

	test('surfaces a taken name as "already exists"', async () => {
		(app as any).api = {
			directory_create: () =>
				Promise.resolve({
					ok: false,
					error: {
						code: -32004,
						message: 'failed to create directory: Path already exists: /ws/taken',
						data: { reason: 'already_exists' }
					}
				})
		};
		app.projects.add({ root: SOURCE_DIR });

		const error = await app.diskfiles.create_directory('taken').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.strictEqual(error.message, 'already exists');
	});
});

describe('directory_paths', () => {
	const node_at = (path: string, source_dir: string = SOURCE_DIR): SerializableDisknode => ({
		...create_disknode(parse_or_throw(DiskfilePath, path)),
		source_dir: parse_or_throw(SerializableDisknode.def.source_dir, source_dir)
	});

	const dirs = (): Array<string> => [...app.diskfiles.index.directory_paths].sort();

	/** The directories a from-scratch walk of the files on disk finds. */
	const rebuilt = (): Array<string> => {
		const found: Set<string> = new Set();
		for (const diskfile of app.diskfiles.items.values.filter(
			(d) => !d.deleted_on_disk && !d.uncovered
		)) {
			for (const dir of to_file_directories(diskfile.path, diskfile.source_dir)) found.add(dir);
		}
		return [...found].sort();
	};

	test('a file adds its folders up to its root, and the last file out takes them away', () => {
		app.diskfiles.upsert(node_at('/ws/a/b/c.md'));
		assert.deepEqual(dirs(), ['/ws/', '/ws/a/', '/ws/a/b/']);
		assert.isTrue(app.diskfiles.link_index.has_directory('/ws/a/'));

		app.diskfiles.upsert(node_at('/ws/a/d.md'));
		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/a/b/c.md'));
		assert.deepEqual(dirs(), ['/ws/', '/ws/a/'], 'only the emptied folder goes');

		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/a/d.md'));
		assert.deepEqual(dirs(), [], 'its ancestors up to the root go once they empty');
		assert.isFalse(app.diskfiles.link_index.has_directory('/ws/'));
	});

	test('a rename, as a delete plus an add, moves the folders', () => {
		app.diskfiles.upsert(node_at('/ws/old/x.md'));
		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/old/x.md'));
		app.diskfiles.upsert(node_at('/ws/new/x.md'));
		assert.deepEqual(dirs(), ['/ws/', '/ws/new/']);
	});

	test('an add of an id already present keeps the file it holds counted', () => {
		const existing = app.diskfiles.upsert(node_at('/ws/a/x.md'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		app.diskfiles.add(existing.to_json());
		error.mockRestore();
		assert.strictEqual(app.diskfiles.items.by_id.get(existing.id), existing);
		assert.deepEqual(dirs(), ['/ws/', '/ws/a/']);
		assert.deepEqual(dirs(), rebuilt());
	});

	test('a re-sent file counts once', () => {
		app.diskfiles.upsert(node_at('/ws/a/x.md'));
		app.diskfiles.add_initial([node_at('/ws/a/x.md'), node_at('/ws/a/x.md')]);
		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/a/x.md'));
		assert.deepEqual(dirs(), []);
	});

	test('a file kept deleted on disk for its draft holds no folder until it returns', async () => {
		const diskfile = await disk.load('/ws/a/x.md', 'x');
		app.diskfiles.select(diskfile.path, true);
		app.diskfiles.get_editor_state(diskfile).current_content = 'edited';
		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/a/x.md'));
		assert.isTrue(diskfile.deleted_on_disk);
		assert.deepEqual(dirs(), []);

		app.diskfiles.set_deleted_on_disk(diskfile, false);
		assert.deepEqual(dirs(), ['/ws/', '/ws/a/']);
		app.diskfiles.set_deleted_on_disk(diskfile, true);
		assert.deepEqual(dirs(), []);

		app.diskfiles.upsert(node_at('/ws/a/x.md', '/ws/'));
		assert.deepEqual(dirs(), ['/ws/', '/ws/a/'], 'reappearing on disk restores them');
	});

	test('a file re-rooted by another snapshot moves to the new root', () => {
		app.diskfiles.upsert(node_at('/ws/a/x.md'));
		app.diskfiles.upsert(node_at('/ws/a/x.md', '/ws/a/'));
		assert.deepEqual(dirs(), ['/ws/a/']);
	});

	test('a resync reconciles them, and clearing the collection empties them', () => {
		app.diskfiles.add_initial([
			node_at('/ws/a/x.md'),
			node_at('/ws/b/y.md'),
			node_at('/z/q.md', '/z/')
		]);
		app.diskfiles.reconcile([node_at('/ws/b/y.md'), node_at('/ws/c/w.md')], ['/ws/']);
		assert.deepEqual(dirs(), ['/ws/', '/ws/b/', '/ws/c/', '/z/']);
		assert.deepEqual(dirs(), rebuilt());

		app.diskfiles.set_json({ diskfiles: [] });
		assert.deepEqual(dirs(), []);
		app.diskfiles.upsert(node_at('/ws/a/x.md'));
		assert.deepEqual(dirs(), ['/ws/', '/ws/a/'], 'counting restarts from nothing');
	});

	test('a long mixed sequence agrees with a from-scratch walk', () => {
		const paths = ['/ws/a.md', '/ws/a/b.md', '/ws/a/b/c.md', '/ws/a/b/d.md', '/ws/e/f.md'];
		for (let step = 0; step < 60; step++) {
			const path = parse_or_throw(DiskfilePath, paths[(step * 7) % paths.length]!);
			if (step % 3 === 2) {
				filer_change('delete', path);
			} else {
				app.diskfiles.upsert({ ...node_at(path), mtime: step });
			}
			assert.deepEqual(dirs(), rebuilt(), `step ${step}`);
		}
	});

	test('a reader follows a folder appearing and emptying', () => {
		const seen: Array<boolean> = [];
		const cleanup = $effect.root(() => {
			$effect(() => {
				seen.push(app.diskfiles.link_index.has_directory('/ws/a/'));
			});
		});
		flushSync();
		app.diskfiles.upsert(node_at('/ws/a/x.md'));
		flushSync();
		app.diskfiles.upsert(node_at('/ws/a/y.md'));
		flushSync();
		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/a/x.md'));
		filer_change('delete', parse_or_throw(DiskfilePath, '/ws/a/y.md'));
		flushSync();
		cleanup();
		assert.deepEqual(seen, [false, true, false], 'only presence changes rerun it');
	});
});
